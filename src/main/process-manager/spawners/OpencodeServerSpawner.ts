// src/main/process-manager/spawners/OpencodeServerSpawner.ts

/**
 * Spawns a local, interactive OpenCode "process" backed by the shared
 * `opencode serve` server via `@opencode-ai/sdk`, instead of a one-shot
 * `opencode run` child process.
 *
 * Why: the server exposes a live SSE event stream (including `permission.updated`),
 * which is the foundation for bubbling permission requests up to the user. This
 * spawner does the transport swap while preserving the existing pipeline: it
 * registers a `ManagedProcess` (with no OS child), then translates the SDK's SSE
 * events back into the CLI's JSONL lines and feeds them through the very same
 * `StdoutHandler`/`ExitHandler` the CLI path uses. Everything downstream (parser,
 * usage, tool-execution, session-id, renderer, peek, wizard) is reused verbatim.
 *
 * Scope (see task decisions): local + interactive + text prompts only. SSH-remote,
 * headless automation edge cases, and image prompts remain on the CLI path via the
 * caller's routing and the `fallbackToCli` safety net.
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { opencodeServerManager } from '../../opencode-server/OpencodeServerManager';
import { OpencodeEventTranslator } from '../../opencode-server/event-translator';
import type { Event, OpencodeClient } from '@opencode-ai/sdk';

/** Parsed agent invocation bits we need from the CLI-style args. */
interface OpencodeInvocation {
	/** Existing opencode session id to resume, if any. */
	resumeId?: string;
	/** `{ providerID, modelID }` when `--model provider/model` was supplied. */
	model?: { providerID: string; modelID: string };
	/** Agent name from `--agent <name>` (e.g. `plan` for read-only mode). */
	agent?: string;
}

/** Per-spawn termination guard: emits exit exactly once via ExitHandler. */
interface Lifecycle {
	finish: (code: number) => void;
	isFinished: () => boolean;
}

/**
 * Extract resume id / model / agent from the CLI args the caller already built
 * (via the agent definition's `resumeArgs`/`modelArgs`/`readOnlyArgs`). Parsing
 * here keeps the SDK migration contained to the main process - no IPC/renderer
 * contract changes.
 */
function parseInvocation(config: ProcessConfig): OpencodeInvocation {
	const { args } = config;
	const out: OpencodeInvocation = {};

	const valueAfter = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		if (i !== -1 && i + 1 < args.length) return args[i + 1];
		const eq = args.find((a) => a.startsWith(`${flag}=`));
		return eq ? eq.slice(flag.length + 1) : undefined;
	};

	out.resumeId = config.agentSessionId || valueAfter('--session');

	const model = valueAfter('--model');
	if (model) {
		const slash = model.indexOf('/');
		out.model =
			slash > 0
				? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
				: { providerID: model, modelID: model };
	}

	out.agent = valueAfter('--agent');
	return out;
}

export class OpencodeServerSpawner {
	private stdoutHandler: StdoutHandler;
	private exitHandler: ExitHandler;

	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter,
		bufferManager: DataBufferManager,
		/** Fallback used when the server can't start / session can't be created,
		 *  so local OpenCode never regresses to "broken". Provided by ProcessManager
		 *  (its ChildProcessSpawner.spawn). */
		private fallbackToCli: (config: ProcessConfig) => SpawnResult
	) {
		this.stdoutHandler = new StdoutHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager,
		});
		this.exitHandler = new ExitHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager,
		});
	}

	/**
	 * Register the managed process synchronously and kick off async SDK work.
	 * Mirrors ChildProcessSpawner: returns immediately; events flow later.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const { sessionId, toolType, cwd, command, args, prompt } = config;

		const outputParser = createOutputParser(toolType) || undefined;

		// SSE aborter for the kill path, plus a one-shot exit guard.
		const streamAbort = new AbortController();
		let finished = false;
		const managedProcess: ManagedProcess = {
			sessionId,
			toolType,
			cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			isStreamJsonMode: true,
			jsonBuffer: '',
			startTime: Date.now(),
			outputParser,
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command,
			args,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			// Wire kill/interrupt into the SDK session + SSE stream.
			sdkController: {
				interrupt: () => {
					// Abort the in-flight turn but keep the session/stream alive; the
					// resulting session.idle drives the normal exit path.
					this.abortActiveSession(managedProcess);
				},
				kill: () => {
					// Hard stop: abort the turn and tear down the SSE subscription. The
					// stream ending triggers finish() -> exit, matching child-process
					// kill timing (ProcessManager deletes the map entry right after).
					this.abortActiveSession(managedProcess);
					streamAbort.abort();
				},
			},
		};
		const lifecycle: Lifecycle = {
			isFinished: () => finished,
			finish: (code: number) => {
				if (finished) return;
				finished = true;
				void this.exitHandler.handleExit(sessionId, code, managedProcess).catch((err) => {
					logger.error('[OpencodeServerSpawner] handleExit threw', 'OpencodeServer', {
						sessionId,
						error: String(err),
					});
				});
			},
		};

		this.processes.set(sessionId, managedProcess);

		if (!prompt) {
			logger.warn(
				'[OpencodeServerSpawner] Spawn with no prompt; nothing to run',
				'OpencodeServer',
				{
					sessionId,
				}
			);
			lifecycle.finish(0);
			return { pid: -1, success: true };
		}

		// run() owns its own error handling (CLI fallback for setup failures,
		// agent-error for streaming failures). This catch is a last-resort net.
		void this.run(config, managedProcess, streamAbort, lifecycle).catch((err) => {
			void captureException(err);
			if (!lifecycle.isFinished()) {
				this.emitAgentError(managedProcess, err);
				lifecycle.finish(1);
			}
		});

		return { pid: -1, success: true };
	}

	/**
	 * Emit an agent-error for this process, at most once. Sets `errorEmitted` so
	 * ExitHandler's exit-based error detection doesn't then emit a duplicate
	 * generic "exited with code 1" error on the finish(1) path.
	 */
	private emitAgentError(managedProcess: ManagedProcess, err: unknown): void {
		if (managedProcess.errorEmitted) return;
		managedProcess.errorEmitted = true;
		this.emitter.emit('agent-error', managedProcess.sessionId, {
			type: 'agent_crashed',
			message: `OpenCode server error: ${err instanceof Error ? err.message : String(err)}`,
			recoverable: true,
			agentId: managedProcess.toolType,
			sessionId: managedProcess.sessionId,
			timestamp: Date.now(),
		});
	}

	private abortActiveSession(managedProcess: ManagedProcess): void {
		const client = managedProcess.opencodeClient;
		const ocSessionId = managedProcess.opencodeSessionId;
		if (!client || !ocSessionId) return;
		try {
			void client.session
				.abort({ path: { id: ocSessionId }, query: { directory: managedProcess.cwd } })
				.catch(() => {
					/* best effort */
				});
		} catch {
			/* best effort */
		}
	}

	private async run(
		config: ProcessConfig,
		managedProcess: ManagedProcess,
		streamAbort: AbortController,
		lifecycle: Lifecycle
	): Promise<void> {
		const { sessionId, cwd, command, prompt } = config;
		const invocation = parseInvocation(config);

		// ── Setup phase ──────────────────────────────────────────────────────
		// Failures here (server won't start, session can't be created, can't
		// subscribe) happen before any output has streamed, so we can safely
		// degrade to the CLI path and OpenCode still works. No pump exists yet,
		// so there's no risk of the SDK and CLI paths both writing this session.
		let client: OpencodeClient;
		let ocSessionId: string;
		let subscription: { stream: unknown };

		// Bail if the spawn was interrupted/killed during an await below. Without
		// this, stale setup work could fire a prompt on an abandoned session or
		// delete a map slot that a respawn now owns. Emit exit so the renderer
		// doesn't hang (the map entry may already be gone via ProcessManager.kill).
		const cancelled = (): boolean => streamAbort.signal.aborted || lifecycle.isFinished();

		try {
			({ client } = await opencodeServerManager.ensureServer({
				binaryPath: command,
				customEnvVars: config.customEnvVars,
				shellEnvVars: config.shellEnvVars,
				extraPathDirs: config.extraPathDirs,
				cwd,
			}));
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			managedProcess.opencodeClient = client;

			// Resume an existing session or create a new one.
			let resolvedId = invocation.resumeId;
			if (!resolvedId) {
				const created = await client.session.create({ query: { directory: cwd } });
				resolvedId = created.data?.id;
				if (!resolvedId) {
					throw new Error('OpenCode session.create returned no session id');
				}
			}
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			ocSessionId = resolvedId;
			managedProcess.opencodeSessionId = ocSessionId;

			// Subscribe to the shared server's event stream BEFORE firing the prompt
			// so no early part events are missed. The stream is multiplexed across
			// all sessions; the translator filters down to ours.
			subscription = await client.event.subscribe({ signal: streamAbort.signal });
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
		} catch (setupErr) {
			// A kill mid-setup surfaces as an aborted subscribe/create rejection -
			// that's a clean stop, not a transport failure, so don't fall back to CLI.
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			logger.warn(
				'[OpencodeServerSpawner] SDK setup failed; falling back to CLI',
				'OpencodeServer',
				{ sessionId, error: String(setupErr) }
			);
			// Only reclaim the slot if it's still ours - a concurrent respawn for the
			// same sessionId must not be clobbered by our fallback.
			if (this.processes.get(sessionId) === managedProcess) {
				this.processes.delete(sessionId);
				try {
					this.fallbackToCli(config);
					return;
				} catch (fallbackErr) {
					void captureException(fallbackErr);
				}
			}
			this.emitAgentError(managedProcess, setupErr);
			lifecycle.finish(1);
			return;
		}

		// ── Streaming phase ──────────────────────────────────────────────────
		// From here the process is committed to the SDK path (no CLI fallback):
		// falling back now would double-drive the session.
		const translator = new OpencodeEventTranslator(ocSessionId);

		const pump = (async () => {
			try {
				for await (const event of subscription.stream as AsyncIterable<Event>) {
					if (lifecycle.isFinished()) break;
					const { lines, idle, errored } = translator.handle(event);
					for (const line of lines) {
						this.stdoutHandler.handleData(sessionId, line + '\n');
					}
					if (idle || errored) {
						// A session error ends the turn with a non-zero code so exit-based
						// consumers (stats/query-complete) see the failure; the error text
						// itself was already surfaced via the emitted error line.
						lifecycle.finish(errored ? 1 : 0);
						break;
					}
				}
				// Stream ended (server closed or aborted) without an explicit idle.
				lifecycle.finish(0);
			} catch (err) {
				// Aborted subscriptions surface as errors; treat abort as a clean stop.
				const aborted = streamAbort.signal.aborted;
				if (!aborted) {
					logger.warn('[OpencodeServerSpawner] Event stream error', 'OpencodeServer', {
						sessionId,
						error: String(err),
					});
				}
				lifecycle.finish(aborted ? 0 : 1);
			}
		})();

		// Fire the prompt (async: events stream live via the subscription above).
		try {
			await client.session.promptAsync({
				path: { id: ocSessionId },
				query: { directory: cwd },
				body: {
					parts: [{ type: 'text', text: prompt as string }],
					...(invocation.model ? { model: invocation.model } : {}),
					...(invocation.agent ? { agent: invocation.agent } : {}),
				},
			});
		} catch (promptErr) {
			// Surface the failure and stop the pump; the session errored, not the
			// whole transport, so no CLI fallback (that would re-run the prompt).
			logger.warn('[OpencodeServerSpawner] promptAsync failed', 'OpencodeServer', {
				sessionId,
				error: String(promptErr),
			});
			this.emitAgentError(managedProcess, promptErr);
			// Finish non-zero before aborting so the failure exit code wins over the
			// pump's abort-driven finish(0) (finish is idempotent, first call sticks).
			lifecycle.finish(1);
			streamAbort.abort();
		}

		await pump;
	}
}
