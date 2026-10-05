/**
 * @file consult.ts
 * @description The cross-agent consult as a library service (`createConsultService`).
 *
 * A consult is one read-only turn on another agent, run in the background and answered
 * once: the user typed `@target ...` in a source agent, or an agent ran `maestro-cli ask`.
 * The service builds the consultation prompt, launches an ephemeral process for the target
 * (process id `cross-agent-<requestId>`, never the target's own tab), supervises it, and
 * reports exactly one terminal chunk through `onChunk`.
 *
 * What it does NOT own is the process. A consult waits for its own end rather than riding a
 * global listener, so the host hands the service a {@link ConsultRunner}: the desktop's is a
 * `ProcessManager` subscription, a headless runtime's is the run layer. That is the whole
 * difference between hosts, which is what lets `maestro-cli ask` stop crossing from main to
 * the renderer and back on a host that has no renderer.
 *
 * Design notes (why it looks like Group Chat):
 * - The launch (`GroupChatSpawn`) is the one a group chat turn uses, so SSH, Claude token
 *   mode and Windows shell handling live in one place per host.
 * - The target is read-only unless the user opted into writable consults
 *   (`crossAgentMentionsWritable`), and a writable consult asks for FULL access rather than
 *   merely "not read-only" (see the `permissionMode` note below).
 * - Continuity without pollution: the answer is persisted to a dedicated hidden consult tab
 *   on the target, one per (source, source tab). When it was consulted before, the caller
 *   forwards that tab's captured provider session id as `resumeAgentSessionId`, so the target
 *   remembers earlier consults while the forwarded transcript supplies the latest context.
 * - Non-blocking by contract: `start` resolves once the spawn is under way; the answer arrives
 *   later through `onChunk`.
 */

import { getAgentDisplayName } from '../../agentMetadata';
import { getClaudeTokenMode } from '../../claudeTokenMode';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../crossAgentTypes';
import { CROSS_AGENT_SESSION_PREFIX } from '../../crossAgentTypes';
import type { AgentSshRemoteConfig, ToolType } from '../../types';
import { createIdleWatchdog, type IdleWatchdog } from '../control/idle-watchdog';
import type { GroupChatSpawn } from '../groupchat/types';
import { captureException, logger } from '../host';
import { applyAgentConfigOverrides, buildAgentArgs } from '../launch/agent-args';
import type { SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import type { AgentConfig } from '../providers/definitions';
import { buildCrossAgentPrompt } from './consult-prompt';

const LOG_CONTEXT = '[CrossAgentConsult]';

/**
 * How long a consulted agent may go SILENT before we give up on it. Reset on every liveness
 * signal the runner reports, so an agent that keeps working (long tool runs, a subagent
 * fan-out, extended thinking) is never killed mid-answer. Guards against a hung target
 * leaking the listeners a runner attaches.
 *
 * This was previously a single wall-clock budget armed at spawn, which killed healthy
 * consults that simply took longer than the budget to finish.
 */
export const CROSS_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Absolute ceiling on a single consult, regardless of how chatty it is. A target stuck in a
 * tool loop can emit output forever and never satisfy the idle timer, so the idle budget
 * alone cannot bound the run.
 */
export const CROSS_AGENT_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * The subset of a target agent's stored session config a consult needs to spawn. Resolved by
 * the caller from its own session store.
 */
export interface CrossAgentTargetSession {
	id: string;
	name: string;
	toolType: ToolType;
	cwd: string;
	/**
	 * Per-agent binary override. Honored ahead of detection, exactly like the tab spawn and the
	 * Group Chat moderator: a consult that ignores it runs a DIFFERENT binary than the tab does
	 * (detection probes known install dirs before PATH, so a stale nvm stub wins over the codex
	 * the user picked).
	 */
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	/** Per-session reasoning/effort override (threaded through like model/args). */
	customEffort?: string;
	/** Per-session context-window override (folded into agentConfigValues.contextWindow). */
	customContextWindow?: number;
	/** Claude token-source opt-in (Claude Code targets only). */
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	sshRemoteConfig?: AgentSshRemoteConfig | null;
}

/** How a runner reports a running consult. Nothing is reported after `stop`. */
export interface ConsultObserver {
	/** Proof of life: output, thinking, a tool call, a usage report. Restarts the silence budget. */
	onActivity(): void;
	/** The target's own provider session id, as its output stream announced it. */
	onSessionId(agentSessionId: string): void;
	/** The process ended. Reported at most once. */
	onEnd(end: ConsultEnd): void;
}

/** A finished process. The text is read lazily so a parser that throws lands in the service's handling. */
export interface ConsultEnd {
	exitCode: number | null;
	readText(): string;
}

/**
 * Starts and stops the one process a consult is made of. The runner attaches its listeners
 * BEFORE it spawns (no event is missed) and owns their release: a start that fails or throws
 * detaches by itself, so the service never has to guess what a failed start left behind.
 */
export interface ConsultRunner {
	/** Start the process. `success: false` is a refusal: nothing runs and no end will be reported. */
	start(
		spawn: GroupChatSpawn,
		observer: ConsultObserver
	): Promise<{ success: boolean; pid?: number; error?: string }>;
	/**
	 * Kill the process, detach, and answer whatever it had said so far (best effort, `''` when
	 * unreadable). Idempotent, and safe for an id whose process does not exist yet.
	 */
	stop(processId: string): string;
}

export interface ConsultStartOptions {
	runner: ConsultRunner;
	/** Resolves a provider to the agent definition a spawn needs, or null when it is not installed. */
	resolveAgent(providerId: string): Promise<AgentConfig | null>;
	/** SSH settings store; required only when the target opted into SSH. */
	sshStore: SshRemoteSettingsStore | null;
	/** Resolve the target agent's stored config from its session id. */
	getTargetSession: (sessionId: string) => CrossAgentTargetSession | null;
	/** Per-agent custom env vars (mirrors group chat's getCustomEnvVarsCallback). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Per-agent config values (context window, model, effort, ...). */
	getAgentConfig?: (toolType: string) => Record<string, unknown> | undefined;
	/**
	 * When true, the user opted into read/write cross-agent mentions
	 * (`crossAgentMentionsWritable`), so the consult spawns with write access.
	 * Defaults to false: consults are read-only.
	 */
	writable?: boolean;
	/** Called with each response chunk; `done: true` marks completion/failure. */
	onChunk: (chunk: CrossAgentResponseChunk) => void;
}

/**
 * A consult that has been started and has not yet emitted its terminal chunk.
 *
 * Stop is an AGENT-level action, and a `@mention` fans the agent's turn out across several
 * processes: its own tab plus one ephemeral `cross-agent-*` process per consulted target.
 * Interrupting only the tab leaves those consults running, streaming an answer into a
 * conversation the user already stopped, so the registry is what gives Stop a handle on them.
 *
 * Keyed by `requestId`, but cancellation is addressed by SOURCE agent: a caller's in-flight map
 * is only populated once its send resolves, so a Stop pressed in that window would miss a
 * request already being spawned. The service holds the authoritative list.
 */
interface ActiveConsult {
	/** The agent the mention was typed in - what Stop is addressed to. */
	sourceSessionId: string;
	/** Terminate this consult and emit its terminal chunk. Idempotent. */
	cancel: () => void;
}

export function createConsultService() {
	const activeConsults = new Map<string, ActiveConsult>();

	/**
	 * Stop every consult the given source agent still has in flight.
	 *
	 * Each cancelled consult settles exactly like a timeout does - the process is killed and
	 * whatever the target already said is flushed as the terminal chunk - except that it is
	 * stamped `canceled` rather than `error`, so the source agent's bubble reports that the user
	 * stopped it instead of blaming the target for failing to answer.
	 *
	 * @returns How many consults were cancelled.
	 */
	function cancelForSource(sourceSessionId: string): number {
		// Snapshot first: `cancel()` deletes from the map it is iterating.
		const doomed = [...activeConsults.values()].filter(
			(c) => c.sourceSessionId === sourceSessionId
		);
		for (const consult of doomed) consult.cancel();
		return doomed.length;
	}

	/**
	 * Dispatch a cross-agent request to the target agent without blocking the caller. Response
	 * text is reported through `opts.onChunk`; the promise resolves once the spawn has been
	 * initiated (or an error chunk emitted).
	 *
	 * MUST honor SSH: if the target opted into SSH but the config can't be resolved, we surface
	 * an error chunk instead of silently running locally.
	 */
	async function start(request: CrossAgentRequest, opts: ConsultStartOptions): Promise<void> {
		const { runner, sshStore, getTargetSession, onChunk } = opts;
		const writable = opts.writable ?? false;

		const target = getTargetSession(request.targetSessionId);

		// Base fields shared by every chunk we emit for this request. targetToolType / name fall
		// back to the raw id when the session can't be resolved.
		const baseChunk = (overrides: Partial<CrossAgentResponseChunk>): CrossAgentResponseChunk => ({
			requestId: request.requestId,
			sourceSessionId: request.sourceSessionId,
			sourceTabId: request.sourceTabId,
			targetSessionId: request.targetSessionId,
			targetTabId: request.targetTabId,
			targetAgentName: target?.name ?? request.targetSessionId,
			targetToolType: (target?.toolType ?? 'claude-code') as ToolType,
			chunk: '',
			done: false,
			...overrides,
		});

		const emitError = (message: string): void => {
			logger.warn(`${LOG_CONTEXT} ${message}`, LOG_CONTEXT, {
				requestId: request.requestId,
				targetSessionId: request.targetSessionId,
			});
			activeConsults.delete(request.requestId);
			onChunk(baseChunk({ chunk: '', done: true, error: message }));
		};

		/**
		 * Stop can land before the process exists: resolving the target agent's binary is async,
		 * and the spawn itself is awaited. Register a cancel that only raises this flag now (it is
		 * swapped for the real terminal path once the supervision is armed), and re-check it around
		 * the spawn so a consult cancelled in that window is never left running.
		 */
		let cancelRequested = false;
		const registration: ActiveConsult = {
			sourceSessionId: request.sourceSessionId,
			cancel: () => {
				cancelRequested = true;
			},
		};
		activeConsults.set(request.requestId, registration);

		if (!target) {
			emitError(`Target agent not found for session ${request.targetSessionId}`);
			return;
		}

		// SSH awareness: fail loudly rather than leak the prompt to the local machine.
		if (target.sshRemoteConfig?.enabled && !sshStore) {
			emitError(
				`${target.name} is configured to run over SSH, but the SSH remote could not be resolved.`
			);
			return;
		}

		const agent = await opts.resolveAgent(target.toolType);
		if (!agent || !agent.available) {
			emitError(`${getAgentDisplayName(target.toolType)} is not available.`);
			return;
		}

		const fullPrompt = buildCrossAgentPrompt(request, writable);
		const command = target.customPath || agent.path || agent.command;
		// Honor a per-session context-window override the same way model/effort/args are honored:
		// the launch reads `agentConfigValues.contextWindow`, so fold the session value in here on
		// a COPY rather than mutating the shared agent-config object.
		const baseAgentConfig = opts.getAgentConfig?.(target.toolType) ?? {};
		const agentConfigValues =
			typeof target.customContextWindow === 'number' && target.customContextWindow > 0
				? { ...baseAgentConfig, contextWindow: target.customContextWindow }
				: baseAgentConfig;

		// Build args exactly like Group Chat: base args -> batch/json/cwd args -> custom-config
		// overrides. Read-only (readOnlyMode: true), matching the Group Chat moderator: a consult
		// answers a question, it does not edit the user's project.
		//
		// Continuity: when the source tab has consulted this target before, the caller forwards the
		// target's captured provider session id here. Passing it as `agentSessionId` makes
		// buildAgentArgs append the agent's resume flag (`--resume <id>` etc.), so the target keeps
		// memory of prior consults from the same source tab. Absent on the first mention (fresh
		// session), exactly like a Group Chat participant's first turn.
		const baseArgs = buildAgentArgs(agent, {
			baseArgs: [...agent.args],
			prompt: fullPrompt,
			cwd: target.cwd,
			// A DELEGATION must ask for full access, never merely "not read-only".
			//
			// `readOnlyMode: false` selects `buildAgentArgs`' STANDARD branch, which emits no
			// permission flags at all and leaves the agent on its interactive default. There is no
			// approver in a `--print` run, so the first write tool call blocks forever: no output, no
			// exit, no child process, and nothing on screen until the 10-minute idle watchdog kills it
			// and throws the work away. That is strictly worse than read-only, which at least declines
			// promptly - and the prompt has meanwhile TOLD the agent it "may apply changes directly",
			// so it is guaranteed to try.
			//
			// `permissionMode` is therefore stated explicitly at both ends, keeping the args in
			// agreement with the cwdGrant text.
			permissionMode: writable ? 'full' : 'readonly',
			agentSessionId: request.resumeAgentSessionId,
		});
		const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
			agentConfigValues,
			sessionCustomModel: target.customModel,
			sessionCustomEffort: target.customEffort,
			sessionCustomArgs: target.customArgs,
			sessionCustomEnvVars: target.customEnvVars,
		});

		const sessionId = `${CROSS_AGENT_SESSION_PREFIX}${request.requestId}`;

		let settled = false;
		// The target's own provider session id, captured from its output stream. Forwarded on the
		// terminal chunk so the caller stores it on the consult tab and resumes it on the next
		// mention from this source tab.
		let capturedAgentSessionId: string | undefined = request.resumeAgentSessionId;
		// Assigned once the consult is actually under way (see below). Held on a const object so
		// `release` can close over it without a `let` that trips prefer-const.
		const watch: { dog?: IdleWatchdog } = {};

		const release = (): void => {
			activeConsults.delete(request.requestId);
			watch.dog?.disarm();
		};

		const observer: ConsultObserver = {
			onActivity: () => {
				if (!settled) watch.dog?.touch();
			},
			onSessionId: (agentSessionId) => {
				if (agentSessionId) capturedAgentSessionId = agentSessionId;
			},
			onEnd: ({ exitCode, readText }) => {
				if (settled) return;
				settled = true;
				release();
				const code = exitCode ?? -1;
				try {
					const text = readText().trim();
					// Only forward a captured provider session id on a SUCCESSFUL consult, so the
					// caller never persists (and later resumes) a session id from a run that
					// auth/usage/CLI-errored - matching Group Chat's recovery, which clears the id on
					// failure to force a fresh session next time.
					const continuity =
						code === 0 && capturedAgentSessionId
							? { targetAgentSessionId: capturedAgentSessionId }
							: {};
					if (code !== 0) {
						// Non-zero exit is a failed consult (auth/usage/CLI error), even if the process
						// printed something. Keep any text so the user still sees what the agent said,
						// but stamp the error so it renders as a failure rather than a success-styled
						// answer.
						onChunk(
							baseChunk({
								chunk: text,
								done: true,
								error: text
									? `${target.name} exited with code ${code}.`
									: `${target.name} produced no visible output (exit code ${code}).`,
							})
						);
					} else if (text) {
						onChunk(baseChunk({ chunk: text, done: true, ...continuity }));
					} else {
						onChunk(
							baseChunk({
								chunk: '',
								done: true,
								error: `${target.name} produced no visible output (exit code ${code}).`,
							})
						);
					}
				} catch (err) {
					captureException(err, {
						operation: 'crossAgent:parseResponse',
						requestId: request.requestId,
						targetSessionId: request.targetSessionId,
					});
					onChunk(
						baseChunk({
							chunk: '',
							done: true,
							error: err instanceof Error ? err.message : String(err),
						})
					);
				}
			},
		};

		/**
		 * Terminal path shared by both timers and by Stop: kill the process, then flush whatever the
		 * target managed to say before we pulled the plug. Emitting the partial keeps a long
		 * consult's real work visible instead of replacing it with a bare warning. We deliberately do
		 * NOT forward `targetAgentSessionId` - matching the non-zero-exit policy, a killed run starts
		 * fresh next time rather than resuming a session we interrupted mid-turn.
		 *
		 * `canceled` splits the two callers apart at the chunk level: a timeout is a failure of the
		 * target, while Stop is the user's own decision and must not be reported as the target
		 * failing to answer.
		 */
		const settleTerminated = (message: string, canceled = false): void => {
			if (settled) return;
			settled = true;
			release();
			let partial = '';
			try {
				partial = runner.stop(sessionId).trim();
			} catch {
				// A stream truncated mid-object may not parse, and the process may already be gone;
				// the error still lands.
			}
			logger.warn(`${LOG_CONTEXT} ${message}`, LOG_CONTEXT, {
				requestId: request.requestId,
				targetSessionId: request.targetSessionId,
				partialChars: partial.length,
			});
			onChunk(
				canceled
					? baseChunk({ chunk: partial, done: true, canceled: true })
					: baseChunk({ chunk: partial, done: true, error: message })
			);
		};

		// Safety net: never leave the process attached forever. The idle budget covers a wedged
		// target; the hard ceiling covers one that chatters without finishing.
		watch.dog = createIdleWatchdog({
			idleMs: CROSS_AGENT_IDLE_TIMEOUT_MS,
			maxMs: CROSS_AGENT_MAX_DURATION_MS,
			onIdle: () =>
				settleTerminated(
					`${target.name} went silent for ${CROSS_AGENT_IDLE_TIMEOUT_MS / 60000} minutes and was stopped.`
				),
			onMax: () =>
				settleTerminated(
					`${target.name} exceeded the ${CROSS_AGENT_MAX_DURATION_MS / 60000}-minute limit for a single consult and was stopped.`
				),
		});

		// The real Stop path, now that there is something to tear down. A cancel that arrived while
		// the target's binary was being resolved is settled here instead of spawning a process only
		// to kill it a moment later.
		registration.cancel = () => settleTerminated(`${target.name} was stopped by the user.`, true);
		if (cancelRequested) {
			registration.cancel();
			return;
		}

		try {
			const spawnResult = await runner.start(
				{
					processId: sessionId,
					providerId: target.toolType,
					agent,
					command,
					args: configResolution.args,
					cwd: target.cwd,
					prompt: fullPrompt,
					customEnvVars:
						configResolution.effectiveCustomEnvVars ?? opts.getCustomEnvVars?.(target.toolType),
					agentConfigValues,
					sshRemoteConfig: target.sshRemoteConfig,
					tokenMode: getClaudeTokenMode(target, {
						sshEnabled: !!target.sshRemoteConfig?.enabled,
					}),
					maestroPPath: target.maestroPPath,
					readOnlyMode: !writable,
					// Background/orchestrated caller: maestro-p otherwise applies its own 300s idle
					// default and kills a still-working consult long before our budget.
					maxWaitSeconds: Math.ceil(CROSS_AGENT_IDLE_TIMEOUT_MS / 1000),
					debugLabel: `cross-agent:${target.name}`,
				},
				observer
			);
			// The spawners CATCH their own failures and return `{ pid: -1, success: false }` rather
			// than throwing. Such a process emits no end, so without this check the only thing that
			// ever fires is the timeout - the user waits the full budget for a process that never
			// existed.
			if (!spawnResult.success) {
				if (!settled) {
					settled = true;
					release();
					emitError(`${target.name} could not be started.`);
				}
				return;
			}
			// Stop can land between `registration.cancel` going live and the spawn resolving.
			// `settleTerminated` already stopped a process id that did not exist yet, so the one we
			// just created has to be stopped here or it survives the Stop that was meant to end it.
			if (settled) {
				try {
					runner.stop(sessionId);
				} catch {
					// Already gone - nothing to stop.
				}
				return;
			}
			logger.info(`${LOG_CONTEXT} Dispatched to ${target.name}`, LOG_CONTEXT, {
				requestId: request.requestId,
				targetToolType: target.toolType,
				transcriptEntries: request.transcript.length,
			});
		} catch (err) {
			// Spawn failed - tear down the supervision and surface a single error chunk.
			if (!settled) {
				settled = true;
				release();
				captureException(err, {
					operation: 'crossAgent:spawn',
					requestId: request.requestId,
					targetSessionId: request.targetSessionId,
				});
				emitError(err instanceof Error ? err.message : String(err));
			}
		}
	}

	return { start, cancelForSource, activeCount: () => activeConsults.size };
}

export type ConsultService = ReturnType<typeof createConsultService>;
