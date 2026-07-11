/**
 * @file cross-agent-router.ts
 * @description Main-process dispatch for cross-agent `@mention` requests
 * (Phase 03).
 *
 * When the user sends `@target ...` from a source agent, the renderer forwards
 * the (Phase-02-windowed) source transcript plus the user's prompt here. We
 * serialize that into a single consultation prompt, spawn an ephemeral batch
 * process for the target agent, buffer its stream-json output, and - once it
 * exits - parse the output to text and stream it back through `onChunk`.
 *
 * Design notes (why it looks like Group Chat):
 * - Spawning + SSH + maestro-p handling is delegated to
 *   {@link spawnGroupChatAgent}, the codebase's one consolidated agent-spawn
 *   helper. We deliberately DO NOT duplicate that SSH/token-mode logic.
 * - Output parsing reuses {@link extractTextFromStreamJson}, the same helper
 *   Group Chat's exit listener uses.
 * - We spawn a FRESH ephemeral PROCESS (process id `cross-agent-<requestId>`)
 *   rather than injecting into the target agent's live/main tab. That keeps the
 *   consultation off the user's own conversation with the target and lets
 *   multiple `@` requests run concurrently.
 * - Continuity WITHOUT pollution: the answer is persisted to a dedicated consult
 *   tab on the target (one per source-tab -> target pairing, owned by the
 *   renderer). When that pairing has been consulted before, the renderer forwards
 *   the target's captured provider session id as `resumeAgentSessionId`, so the
 *   consult resumes (the target remembers prior consults from that source tab)
 *   while the forwarded transcript still supplies the source's latest context.
 *   We capture the target's provider session id off its output stream (the
 *   `session-id` event) and hand it back on the terminal chunk.
 * - Non-blocking by contract: `startCrossAgentRequest` returns once the spawn is
 *   initiated; the response arrives later via `onChunk`.
 */

import type { ProcessManager } from '../process-manager';
import type { AgentDetector } from '../agents';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { AgentSshRemoteConfig, ToolType } from '../../shared/types';
import type {
	CrossAgentRequest,
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../shared/crossAgentTypes';
import { spawnGroupChatAgent } from '../group-chat/spawnGroupChatAgent';
import { extractTextFromStreamJson } from '../group-chat/output-parser';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[CrossAgentRouter]';

/** Session-id prefix for the ephemeral processes cross-agent dispatch spawns. */
export const CROSS_AGENT_SESSION_PREFIX = 'cross-agent-';

/**
 * How long a consulted agent may go SILENT before we give up on it. Reset on
 * every `data` event, so an agent that keeps streaming (long tool runs, a
 * subagent fan-out, extended thinking) is never killed mid-answer. Guards
 * against a hung target leaking the data/exit listeners we attach to the shared
 * ProcessManager.
 *
 * This was previously a single wall-clock budget armed at spawn, which killed
 * healthy consults that simply took longer than the budget to finish - the
 * failure mode that motivated the split.
 */
const CROSS_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Absolute ceiling on a single consult, regardless of how chatty it is. A target
 * stuck in a tool loop can emit output forever and never satisfy the idle timer,
 * so the idle budget alone cannot bound the run.
 */
const CROSS_AGENT_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * The subset of a target agent's stored session config the router needs to
 * spawn a consultation. Resolved by the caller from the main-process session
 * store (see the `cross-agent` IPC handler).
 */
export interface CrossAgentTargetSession {
	id: string;
	name: string;
	toolType: ToolType;
	cwd: string;
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

export interface StartCrossAgentRequestOptions {
	/** Concrete process manager (needed for both spawn and the data/exit events). */
	processManager: ProcessManager;
	/** Resolves an agent id to its executable config. */
	agentDetector: AgentDetector;
	/** SSH settings store; required only when the target opted into SSH. */
	sshStore: SshRemoteSettingsStore | null;
	/** Resolve the target agent's stored config from its session id. */
	getTargetSession: (sessionId: string) => CrossAgentTargetSession | null;
	/** Per-agent custom env vars (mirrors group chat's getCustomEnvVarsCallback). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Per-agent config values (context window, model, effort, ...). */
	getAgentConfig?: (toolType: string) => Record<string, unknown> | undefined;
	/** Called with each response chunk; `done: true` marks completion/failure. */
	onChunk: (chunk: CrossAgentResponseChunk) => void;
}

/** Header prepended to every forwarded transcript. */
const CONSULT_HEADER =
	'You are being consulted by another agent in Maestro. Below is the conversation transcript so far, followed by a question.';

/**
 * Read-access grant appended to the header when the source agent forwards its
 * working directory. The consult runs in the TARGET agent's own cwd, so this is
 * the only pointer it has to the user's project. It is a one-shot consultation
 * (no interactive approval loop), so we grant read but not write - describe
 * changes instead of applying them.
 *
 * This is advisory text ONLY; the enforcement is `readOnlyMode: true` on the
 * spawn below (`--permission-mode plan` for Claude Code, `--sandbox read-only`
 * for Codex, ...). Both must stay in agreement: consults used to spawn
 * read-write while saying this, and targets took the write path anyway.
 */
function cwdGrant(sourceCwd: string): string {
	return (
		`The user is working in the directory \`${sourceCwd}\`. ` +
		'You have permission to READ files under that directory to inform your answer. ' +
		'Do NOT modify or create files: this is a one-shot consultation, so if changes are ' +
		'needed, describe them in your reply and let the user apply them.'
	);
}

/** Prefix for the relayed user question, appended after the transcript. */
const QUESTION_PREFIX = '**Question from the user (relayed via the source agent):**';

/** Human-readable role label for a transcript entry's source. */
function roleLabel(source: string): string {
	switch (source) {
		case 'user':
			return '**User:**';
		case 'ai':
			return '**Assistant:**';
		case 'system':
			return '**System:**';
		default:
			// tool / thinking / stdout / stderr / error - only surfaced when they
			// carry visible text (see serializeTranscript), labelled generically.
			return '**Note:**';
	}
}

/**
 * Serialize a windowed transcript into a single human-readable block.
 * Entries with no visible text are dropped; tool/thinking entries only survive
 * if they carry visible text.
 */
export function serializeTranscript(transcript: CrossAgentTranscriptEntry[]): string {
	const parts: string[] = [];
	for (const entry of transcript) {
		const text = entry.text?.trim();
		if (!text) continue;
		parts.push(`${roleLabel(entry.source)} ${text}`);
	}
	return parts.join('\n');
}

/**
 * Build the full outgoing prompt: header + serialized transcript + the relayed
 * user question. Exported for unit testing.
 */
export function buildCrossAgentPrompt(request: CrossAgentRequest): string {
	const transcriptBlock = serializeTranscript(request.transcript);
	const header = request.sourceCwd
		? `${CONSULT_HEADER}\n\n${cwdGrant(request.sourceCwd)}`
		: CONSULT_HEADER;
	const sections = [header];
	if (transcriptBlock) {
		sections.push(transcriptBlock);
	}
	sections.push(`${QUESTION_PREFIX}\n${request.userPrompt}`);
	return sections.join('\n\n');
}

/**
 * Dispatch a cross-agent request to the target agent without blocking the
 * caller. Response text is streamed back via `opts.onChunk`; the promise
 * resolves once the spawn has been initiated (or an error chunk emitted).
 *
 * MUST honor SSH: if the target opted into SSH but the config can't be
 * resolved, we surface an error chunk instead of silently running locally
 * (enforced in CLAUDE.md).
 */
export async function startCrossAgentRequest(
	request: CrossAgentRequest,
	opts: StartCrossAgentRequestOptions
): Promise<void> {
	const { processManager, agentDetector, sshStore, getTargetSession, onChunk } = opts;

	const target = getTargetSession(request.targetSessionId);

	// Base fields shared by every chunk we emit for this request. targetToolType
	// / name fall back to the raw id when the session can't be resolved.
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
		onChunk(baseChunk({ chunk: '', done: true, error: message }));
	};

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

	const agent = await agentDetector.getAgent(target.toolType);
	if (!agent || !agent.available) {
		emitError(`${getAgentDisplayName(target.toolType)} is not available.`);
		return;
	}

	const fullPrompt = buildCrossAgentPrompt(request);
	const command = agent.path || agent.command;
	// Honor a per-session context-window override the same way model/effort/args
	// are honored: getContextWindowValue (inside spawnGroupChatAgent) reads
	// `agentConfigValues.contextWindow`, so fold the session value in here on a
	// COPY rather than mutating the shared agent-config object.
	const baseAgentConfig = opts.getAgentConfig?.(target.toolType) ?? {};
	const agentConfigValues =
		typeof target.customContextWindow === 'number' && target.customContextWindow > 0
			? { ...baseAgentConfig, contextWindow: target.customContextWindow }
			: baseAgentConfig;

	// Build args exactly like Group Chat: base args -> batch/json/cwd args ->
	// custom-config overrides. Read-only (readOnlyMode: true), matching the Group
	// Chat moderator: a consult answers a question, it does not edit the user's
	// project. The moderator proves this path doesn't stall a batch `--print` run
	// on an approval prompt.
	//
	// Continuity: when the source tab has consulted this target before, the
	// renderer forwards the target's captured provider session id here. Passing it
	// as `agentSessionId` makes buildAgentArgs append the agent's resume flag
	// (`--resume <id>` etc.), so the target keeps memory of prior consults from the
	// same source tab. Absent on the first mention (fresh session), exactly like a
	// Group Chat participant's first turn.
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: [...agent.args],
		prompt: fullPrompt,
		cwd: target.cwd,
		readOnlyMode: true,
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

	// Buffer the target's stream-json output; parse + emit once it exits. Each
	// 'data' event carries a delta (the ProcessManager clears its buffer after
	// every flush), so we append. handleExit flushes the final delta BEFORE
	// emitting 'exit', so by the time onExit fires our buffer is complete.
	let buffer = '';
	let settled = false;
	// The target's own provider session id, captured from its output stream (the
	// same `session-id` event the desktop/group-chat listeners consume). Forwarded
	// on the terminal chunk so the renderer stores it on the consult tab and
	// resumes it on the next mention from this source tab.
	let capturedAgentSessionId: string | undefined = request.resumeAgentSessionId;
	// Held on a const object so `cleanup` can close over the (later-assigned)
	// handles without `let`s that trip prefer-const. `idle` is rearmed on every
	// data event; `hard` is armed once and never reset.
	const timer: {
		idle?: ReturnType<typeof setTimeout>;
		hard?: ReturnType<typeof setTimeout>;
	} = {};

	const onData = (sid: string, data: string): void => {
		if (sid !== sessionId) return;
		buffer += data;
		// Output means the target is alive and working: restart its silence budget.
		armIdleTimer();
	};

	const onSessionId = (sid: string, agentSessionId: string): void => {
		if (sid === sessionId && agentSessionId) capturedAgentSessionId = agentSessionId;
	};

	const cleanup = (): void => {
		processManager.off('data', onData);
		processManager.off('exit', onExit);
		processManager.off('session-id', onSessionId);
		if (timer.idle) clearTimeout(timer.idle);
		if (timer.hard) clearTimeout(timer.hard);
	};

	const onExit = (sid: string, code: number): void => {
		if (sid !== sessionId || settled) return;
		settled = true;
		cleanup();
		try {
			const text = extractTextFromStreamJson(buffer, target.toolType).trim();
			// Only forward a captured provider session id on a SUCCESSFUL consult, so
			// the renderer never persists (and later resumes) a session id from a run
			// that auth/usage/CLI-errored - matching Group Chat's recovery, which
			// clears the id on failure to force a fresh session next time.
			const continuity =
				code === 0 && capturedAgentSessionId
					? { targetAgentSessionId: capturedAgentSessionId }
					: {};
			if (code !== 0) {
				// Non-zero exit is a failed consult (auth/usage/CLI error), even if the
				// process printed something. Keep any text so the user still sees what
				// the agent said, but stamp the error so it renders as a failure rather
				// than a success-styled answer.
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
	};

	/**
	 * Terminal path shared by both timers: kill the process, then flush whatever
	 * the target managed to say before we pulled the plug. Emitting the partial
	 * keeps a long consult's real work visible instead of replacing it with a bare
	 * warning. We deliberately do NOT forward `targetAgentSessionId` - matching the
	 * non-zero-exit policy, a killed run starts fresh next time rather than
	 * resuming a session we interrupted mid-turn.
	 */
	const settleWithTimeout = (message: string): void => {
		if (settled) return;
		settled = true;
		cleanup();
		try {
			processManager.kill(sessionId);
		} catch {
			// Process may already be gone - nothing to kill.
		}
		let partial = '';
		try {
			partial = extractTextFromStreamJson(buffer, target.toolType).trim();
		} catch {
			// A stream truncated mid-object may not parse; the error still lands.
		}
		logger.warn(`${LOG_CONTEXT} ${message}`, LOG_CONTEXT, {
			requestId: request.requestId,
			targetSessionId: request.targetSessionId,
			partialChars: partial.length,
		});
		onChunk(baseChunk({ chunk: partial, done: true, error: message }));
	};

	/** (Re)start the silence budget. Called on spawn and on every data event. */
	const armIdleTimer = (): void => {
		if (settled) return;
		if (timer.idle) clearTimeout(timer.idle);
		timer.idle = setTimeout(() => {
			settleWithTimeout(
				`${target.name} went silent for ${CROSS_AGENT_IDLE_TIMEOUT_MS / 60000} minutes and was stopped.`
			);
		}, CROSS_AGENT_IDLE_TIMEOUT_MS);
	};

	processManager.on('data', onData);
	processManager.on('exit', onExit);
	processManager.on('session-id', onSessionId);

	// Safety net: never leave the listeners attached forever. The idle timer covers
	// a wedged target; the hard ceiling covers one that chatters without finishing.
	timer.hard = setTimeout(() => {
		settleWithTimeout(
			`${target.name} exceeded the ${CROSS_AGENT_MAX_DURATION_MS / 60000}-minute limit for a single consult and was stopped.`
		);
	}, CROSS_AGENT_MAX_DURATION_MS);
	armIdleTimer();

	try {
		const spawnResult = await spawnGroupChatAgent({
			sessionId,
			agentId: target.toolType,
			agent,
			command,
			args: configResolution.args,
			cwd: target.cwd,
			prompt: fullPrompt,
			customEnvVars:
				configResolution.effectiveCustomEnvVars ?? opts.getCustomEnvVars?.(target.toolType),
			agentConfigValues,
			sshRemoteConfig: target.sshRemoteConfig,
			sshStore,
			tokenMode: getClaudeTokenMode(target, {
				sshEnabled: !!target.sshRemoteConfig?.enabled,
			}),
			maestroPPath: target.maestroPPath,
			processManager,
			readOnlyMode: true,
			// Background/orchestrated caller: maestro-p otherwise applies its own 300s
			// idle default and kills a still-working consult long before our budget.
			maxWaitSeconds: Math.ceil(CROSS_AGENT_IDLE_TIMEOUT_MS / 1000),
			debugLabel: `cross-agent:${target.name}`,
		});
		// The spawners CATCH their own failures and return `{ pid: -1, success: false }`
		// rather than throwing (see ChildProcessSpawner). Such a process emits no
		// 'exit' event, so without this check the only listener that ever fires is the
		// timeout - the user waits the full budget for a process that never existed.
		if (!spawnResult.success) {
			if (!settled) {
				settled = true;
				cleanup();
				emitError(`${target.name} could not be started.`);
			}
			return;
		}
		logger.info(`${LOG_CONTEXT} Dispatched to ${target.name}`, LOG_CONTEXT, {
			requestId: request.requestId,
			targetToolType: target.toolType,
			transcriptEntries: request.transcript.length,
		});
	} catch (err) {
		// Spawn failed - tear down listeners and surface a single error chunk.
		if (!settled) {
			settled = true;
			cleanup();
			captureException(err, {
				operation: 'crossAgent:spawn',
				requestId: request.requestId,
				targetSessionId: request.targetSessionId,
			});
			emitError(err instanceof Error ? err.message : String(err));
		}
	}
}
