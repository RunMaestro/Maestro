/**
 * Cue Executor - orchestrates background agent process execution when Cue
 * triggers fire.
 *
 * Thin orchestrator that composes three single-responsibility modules:
 * - CueTemplateContextBuilder: builds templateContext.cue from event payload
 * - CueSpawnBuilder: constructs a SpawnSpec from session/agent/SSH config
 * - CueProcessLifecycle: spawns the process, captures output, enforces timeout
 */

import * as path from 'path';
import { getWakaTimeManager } from '../wakatime-instance';
import type { CueEvent, CueRunResult, CueRunStatus, CueSubscription } from './cue-types';
import type { SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import type { CueTurnLaunch } from '../../shared/cue/turn-settings';
import { prependNewSessionMessage } from '../../shared/newSessionMessage';
import { buildCueTemplateContext } from './cue-template-context-builder';
import { buildSpawnSpec } from './cue-spawn-builder';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import {
	runProcess,
	stopProcess,
	stopAllProcesses,
	getActiveProcessMap,
	getActiveProcessOutput,
	getProcessList,
} from './cue-process-lifecycle';
import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import { isLaunchCancelled, stoppedBeforeLaunchResult } from './cue-launch-cancel';
import { logger } from '../utils/logger';
import {
	pluginToolRunIdentity,
	removePluginRunProofFile,
} from '../plugins/plugin-tool-run-identity';
// Re-export types that external consumers use
export type { CueProcessInfo } from './cue-process-lifecycle';
export type { SpawnSpec } from './cue-spawn-builder';

/**
 * One finished agent run, handed to `CueExecutionConfig.onRunTranscript`. It
 * carries what the run was asked and what the agent printed, and nothing the
 * observer could use to change the run.
 */
export interface CueRunTranscript {
	agentId: string;
	toolType: string;
	/** The prompt after variable substitution, as it was sent. */
	prompt: string;
	/** The agent's stdout byte for byte. `CueRunResult.stdout` is the cleaned text. */
	rawStdout: string;
	/** The agent's own directory (the remote path, for a run over SSH). */
	cwd: string;
	/** When the run started, in epoch milliseconds. */
	startTime: number;
	exitCode: number | null;
	durationMs: number;
	status: CueRunStatus;
	providerSessionId: string | null;
	/** The SSH remote the run executed on, when it ran on one. */
	sshRemoteId?: string;
}

/** Configuration for executing a Cue-triggered prompt */
export interface CueExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	promptPath: string;
	toolType: string;
	projectRoot: string;
	templateContext: TemplateContext;
	timeoutMs: number;
	sshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** The agent's Local Models gateway URL, applied by the launch plan. */
	gatewayUrl?: string;
	/**
	 * The agent's stored Run on target, as data (`prepareAgentRunOn` validates
	 * it). One that names a source replaces `customModel` and the gateway.
	 */
	runOn?: unknown;
	/**
	 * Set when the run's tier names a target that cannot be used
	 * (`ResolvedTurnSettings.refusal`). The run fails with this message and no
	 * process is started: it never runs on the agent's own model in its place.
	 */
	launchRefusal?: string;
	/** Secret names this agent needs; resolved into this run's env only (see `buildAgentLaunchPlan`). */
	requiredSecrets?: string[];
	customModel?: string;
	customEffort?: string;
	/**
	 * Set for a run whose model, effort and place depend on its prompt: a
	 * subscription on the Auto model, which the model router reads the prompt
	 * for. Called once, with the prompt after variable substitution, and what it
	 * answers replaces `customModel`, `customEffort`, `runOn` and
	 * `launchRefusal` above (which hold what the run launches with when the
	 * router gives no decision). It must not reject on a routing: no decision is
	 * an answer. A `launchRefusal` it answers fails the run before any process
	 * starts, like one set at dispatch.
	 */
	resolveLateTurn?: (prompt: string) => Promise<CueTurnLaunch>;
	/** Legacy Adaptive Mode opt-in (maestro-p TUI). Off/absent means pure API. */
	enableMaestroP?: boolean;
	/** Refinement of the opt-in. Absent defaults to `dynamic` (legacy behavior). */
	maestroPMode?: 'interactive' | 'dynamic';
	/** Per-session maestro-p script override. Empty falls back to the bundled script. */
	maestroPPath?: string;
	onLog: (level: string, message: string) => void;
	/** Optional SSH settings store for SSH remote execution */
	sshStore?: SshRemoteSettingsStore;
	/** Optional agent-level config values (from agent config store) */
	agentConfigValues?: Record<string, unknown>;
	/** Inherit only the server-mode env allowlist (see `filterServerProcessEnv`). */
	isServerMode?: boolean;
	/** Aborted when the run is stopped: a launch not yet spawned returns `stopped` (see cue-launch-cancel.ts). */
	signal?: AbortSignal;
	/**
	 * Called once with the run's raw transcript after an agent process has run
	 * and the result is built. It has no way to change the result, the cleaned
	 * stdout or the timing, and a throw from it is swallowed. Not called when no
	 * process was started (an empty prompt, a spec that could not be built).
	 * Must return quickly: the run's caller waits for it.
	 */
	onRunTranscript?: (run: CueRunTranscript) => void;
	/**
	 * The Maestro system prompt for the target agent (built in main from the
	 * stored session). Delivered by `applySystemPromptDelivery`: the native flag
	 * for agents that support it, embedded into the prompt otherwise.
	 */
	appendSystemPrompt?: string;
}

/**
 * Build the per-run WakaTime heartbeat callback for a Cue run.
 *
 * Returns a no-op when WakaTime is not initialized (startup ordering, tests),
 * so callers never have to null-check. Heartbeats are fire-and-forget and
 * swallow their own errors: telemetry must not be able to fail a Cue run.
 */
function buildCueWakaTimeHeartbeat(
	heartbeatSessionId: string,
	projectDir: string | undefined,
	isRemote: boolean
): (() => void) | undefined {
	const manager = getWakaTimeManager();
	if (!manager) return undefined;

	const projectName = projectDir ? path.basename(projectDir) : heartbeatSessionId;
	return () => {
		void manager
			.sendHeartbeat(heartbeatSessionId, projectName, projectDir, {
				// A Cue run is unattended by definition, which is what WakaTime's
				// "ai coding" category means here.
				source: 'auto',
				isRemote,
				origin: 'cue',
			})
			.catch(() => {
				/* never let a heartbeat failure surface in a Cue run */
			});
	};
}

/**
 * Execute a Cue-triggered prompt by spawning an agent process.
 *
 * Orchestrates: template context → variable substitution → spawn spec → process.
 */
export async function executeCuePrompt(config: CueExecutionConfig): Promise<CueRunResult> {
	const { runId, session, subscription, event, promptPath, templateContext, timeoutMs, onLog } =
		config;

	const startedAt = new Date().toISOString();
	// Sleep-aware: a run that spans a lid close must not report the sleep as
	// agent work time (durationMs feeds the Conductor time credit).
	const runSpan = beginSleepAwareSpan();

	// Helper to build a failed result
	const failedResult = (message: string): CueRunResult => ({
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		pipelineName: subscription.pipeline_name,
		event,
		status: 'failed',
		stdout: '',
		stderr: message,
		exitCode: null,
		durationMs: sleepAwareElapsedMs(runSpan),
		startedAt,
		endedAt: new Date().toISOString(),
	});

	// A tier target that cannot be used: refused before anything else, so the
	// run's record names it.
	if (config.launchRefusal) {
		onLog('error', config.launchRefusal);
		return failedResult(config.launchRefusal);
	}

	// 1. Validate prompt content
	const trimmedPrompt = promptPath?.trim();
	if (!trimmedPrompt) {
		const message = `Cue subscription "${subscription.name}" has no prompt content (prompt_file may have failed to load at config time)`;
		onLog('error', message);
		return failedResult(message);
	}

	// 2. Build template context and substitute variables
	templateContext.cue = buildCueTemplateContext(event, subscription, runId);
	const substitutedPrompt = substituteTemplateVariables(trimmedPrompt, templateContext);

	// Surface the "prompt was X, resolved to empty" case loudly. The most
	// common cause is a downstream prompt like just `{{CUE_SOURCE_OUTPUT}}`
	// where the upstream run produced no parseable stdout (for example Claude
	// outputting stream-json with no `result` or `text` events). The spawn
	// still proceeds - `forceBatchMode` on the Cue spawn builder keeps the
	// agent in batch mode so it doesn't fall into interactive TUI and die with
	// "stdin is not a terminal" - but the log line is what tells the user to
	// look at their upstream prompt rather than at the downstream agent.
	if (!substitutedPrompt.trim()) {
		onLog(
			'warn',
			`[CUE] "${subscription.name}" prompt resolved to empty after template substitution - check the upstream agent's output and your prompt_file references (e.g. {{CUE_SOURCE_OUTPUT}})`
		);
	}

	// Every Cue run spawns a fresh provider session (no `--resume`), so prefix
	// the agent's New Session Message onto each one, as Auto Run does per task.
	// Applied after the empty check above: that warning is about the
	// subscription's own prompt, which a standing prefix must not mask.
	const finalPrompt = prependNewSessionMessage(substitutedPrompt, session.newSessionMessage);

	// 3. Settings that depend on the prompt (a subscription on the Auto model)
	// are decided now that there is one. A tier target that cannot be used
	// fails the run by name, exactly as the refusal checked at the top does.
	// The router reads the subscription's own prompt, not the standing prefix:
	// the prefix is the same on every run and says nothing about this one.
	let launchConfig = config;
	if (config.resolveLateTurn) {
		const late = await config.resolveLateTurn(substitutedPrompt);
		if (late.launchRefusal) {
			onLog('error', late.launchRefusal);
			return failedResult(late.launchRefusal);
		}
		launchConfig = { ...config, ...late };
	}

	// 4. Build spawn spec (agent args, SSH wrapping, etc.)
	const buildResult = await buildSpawnSpec(launchConfig, finalPrompt);
	// Stopped while the spec was being built (SSH resolution, spawn-mode probe).
	if (isLaunchCancelled(config.signal)) {
		return stoppedBeforeLaunchResult({
			runId,
			sessionId: session.id,
			sessionName: session.name,
			subscriptionName: subscription.name,
			pipelineName: subscription.pipeline_name,
			event,
			startedAt,
		});
	}
	if (!buildResult.ok) {
		onLog('error', buildResult.message);
		return failedResult(buildResult.message);
	}

	const { spec } = buildResult;

	// Log SSH remote usage
	if (spec.sshRemoteUsed) {
		onLog('cue', `[CUE] Using SSH remote: ${spec.sshRemoteUsed.name || spec.sshRemoteUsed.host}`);
	}

	// 5. Execute the process
	onLog(
		'cue',
		`[CUE] Executing run ${runId}: "${subscription.name}" → ${spec.command} (${event.type})`
	);

	const sshActuallyUsed = !!spec.sshRemoteUsed;

	// Cue spawns agents directly, so the ProcessManager's WakaTime listener
	// never sees this run. Beat off the output stream instead. The run gets its
	// own debounce bucket rather than sharing the desktop chat's, so a Cue run
	// and a chat session in the same project both register.
	const wakaHeartbeat = buildCueWakaTimeHeartbeat(
		`cue:${session.id}:${runId}`,
		session.projectRoot || session.cwd,
		sshActuallyUsed
	);

	// Capture the existing raw stream only when the optional recorder listens.
	let rawStdout = '';
	let processResult;
	try {
		processResult = await runProcess(runId, spec, {
			toolType: config.toolType,
			timeoutMs,
			sshRemoteEnabled: sshActuallyUsed,
			sshStdinScript: sshActuallyUsed ? spec.sshStdinScript : undefined,
			stdinPrompt: spec.stdinPrompt,
			onLog,
			onActivity: wakaHeartbeat,
			signal: config.signal,
			...(config.onRunTranscript
				? {
						onRawStdout: (raw: string) => {
							rawStdout = raw;
						},
					}
				: {}),
		});
	} finally {
		if (spec.pluginRunToken) pluginToolRunIdentity.revoke(spec.pluginRunToken);
		if (spec.pluginRunProofFile) {
			try {
				removePluginRunProofFile(spec.pluginRunProofFile);
			} catch (error) {
				logger.warn('Could not remove plugin run proof file', '[PluginRunIdentity]', {
					error: String(error),
				});
			}
		}
	}

	// 6. Assemble final result. `processResult.stdout` is already clean text and
	// `providerSessionId`/`usage` already extracted - both parsed once, live,
	// by `cue-process-lifecycle.ts`'s stream capture as stdout arrived, rather
	// than re-parsed here from the finished buffer.
	const result: CueRunResult = {
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		pipelineName: subscription.pipeline_name,
		event,
		status: processResult.status,
		stdout: processResult.stdout,
		stderr: processResult.stderr,
		exitCode: processResult.exitCode,
		durationMs: sleepAwareElapsedMs(runSpan),
		startedAt,
		endedAt: new Date().toISOString(),
		providerSessionId: processResult.providerSessionId,
		usage: processResult.usage ?? undefined,
	};

	// After the result is built, so nothing the observer does is in its timing.
	if (config.onRunTranscript) {
		try {
			config.onRunTranscript({
				agentId: session.id,
				toolType: config.toolType,
				prompt: substitutedPrompt,
				rawStdout,
				cwd: config.projectRoot,
				startTime: Date.parse(startedAt),
				exitCode: processResult.exitCode,
				durationMs: result.durationMs,
				status: processResult.status,
				providerSessionId: processResult.providerSessionId,
				...(sshActuallyUsed && config.sshRemoteConfig?.remoteId
					? { sshRemoteId: config.sshRemoteConfig.remoteId }
					: {}),
			});
		} catch {
			// An observer of a run must not be able to fail it.
		}
	}

	return result;
}

/**
 * Stop a running Cue process by runId.
 * Delegates to the process lifecycle module.
 */
export function stopCueRun(runId: string): boolean {
	return stopProcess(runId);
}

/**
 * Stop all active Cue processes. Called during application shutdown to prevent
 * orphaned processes surviving after the main Electron process exits.
 */
export function stopAllCueRuns(): void {
	stopAllProcesses();
}

/**
 * Get the map of currently active processes (for testing/monitoring).
 * Delegates to the process lifecycle module.
 */
export function getActiveProcesses(): ReturnType<typeof getActiveProcessMap> {
	return getActiveProcessMap();
}

/**
 * Get serializable info about active Cue processes (for Process Monitor).
 * Delegates to the process lifecycle module.
 */
export function getCueProcessList(): import('./cue-process-lifecycle').CueProcessInfo[] {
	return getProcessList();
}

/**
 * Snapshot the in-flight stdout/stderr buffers for a still-running Cue run.
 * Returns null when the run is not currently active. Used by the dashboard's
 * expand-active-run-row UI to surface live progress without spawning a
 * dedicated stream channel.
 */
export function getCueRunLiveOutput(runId: string): { stdout: string; stderr: string } | null {
	return getActiveProcessOutput(runId);
}
