/**
 * Standalone Cue engine wiring - boots a `CueEngine` (`src/main/cue/cue-engine.ts`)
 * outside Electron, for unattended operation when the desktop app is closed
 * (a headless server, a CI runner, a machine the user leaves on overnight).
 *
 * `CueEngine` itself takes its dependencies through `CueEngineDeps` and has no
 * Electron import of its own - see the class's own module doc. This file is
 * the standalone counterpart to the inline wiring `src/main/index.ts` builds
 * for the desktop app, sourcing the SAME on-disk data (`maestro-sessions.json`,
 * `.maestro/cue.yaml` per project, the shared `cue.db` - all resolved through
 * `resolveUserDataDir()` in `src/shared/userDataDir.ts`, the same path the
 * desktop app uses) via `maestro-cli`'s existing storage helpers rather than Electron
 * APIs.
 *
 * Deliberately narrower than the desktop wiring, in three documented ways:
 *
 * 1. **No `AgentDetector` probe.** The desktop wiring runs `agentDetector
 *    .getAgent(toolType)` to pre-resolve a binary's full path (working
 *    around bad shims / non-PATH installs). `AgentDetector` composes with
 *    `capabilitySnapshots`, which is backed by an `electron-store` instance
 *    whose `ensureInitialized()` throws outside the desktop app's own Electron
 *    boot sequence (`src/main/stores/instances.ts`). Standing that up here
 *    would mean either duplicating a chunk of the desktop's Electron
 *    bootstrap or half-initializing it - both worse than the gap. Resolution
 *    instead prefers an explicit per-agent override
 *    (`getAgentCustomPath()`, read straight from the settings JSON file) and
 *    otherwise leaves the bare command name for `spawn()`'s own PATH search,
 *    which is correct for the common case (the agent CLI installed normally).
 * 2. **`action: notify` degrades to a log line**, not a toast. Desktop toasts
 *    need a `BrowserWindow`; a headless runner has none, and passing
 *    `mainWindow: null` to `executeCueNotify` already exercises the SAME
 *    degrade path the desktop code hits whenever the window is closed or
 *    destroyed mid-run (`cue-notify-executor.ts`) - this is that path, not a
 *    new one.
 * 3. **Auth-expiry detection logs a warning but does not flip the Settings ->
 *    Agents pill.** `reportCueAuthFailure` (`cue-auth-detector.ts`) calls
 *    `capabilitySnapshots.markAuthRequired()` unconditionally - the same
 *    electron-store dependency as point 1. There is no Settings UI here to
 *    flip a pill in, by definition. `detectCueAuthFailure` (the pure
 *    classification half, no store dependency) is reused directly instead,
 *    logged clearly enough for `maestro-cli cue engine status` to surface
 *    later (see that command).
 */

// Only TYPE imports from the main-process Cue graph at the top level. Every
// VALUE import below is dynamic (see `loadExecutors()`), because this module
// is reachable from `src/cli/commands/cue-engine.ts`, which `src/cli/index.ts`
// imports unconditionally for EVERY `maestro-cli` invocation - not just `cue
// engine` subcommands. A static top-level `import { executeCuePrompt } from
// '../../main/cue/cue-executor'` pulls in `cue-spawn-builder.ts` ->
// `resolveClaudeSpawnMode.ts` -> `claude-usage-startup.ts`, which imports
// `electron-store` at ITS OWN top level - so merely running `maestro-cli
// list-agents` would fail to load `electron-store`/`electron` on any host
// that doesn't happen to have them resolvable (confirmed empirically: this
// broke a real docker-based smoke test of an UNRELATED command). Dynamic
// imports defer that whole graph to the moment a subscription actually fires.
import type { CueEngine, CueEngineDeps } from '../../main/cue/cue-engine';
import type { SshRemoteSettingsStore } from '../../main/utils/ssh-remote-resolver';
// The one static VALUE import from that graph, and safe: the router takes
// every executor through its deps and imports them as types only, so it
// pulls in nothing beyond `os` and agent metadata.
import {
	executeCueRunAction,
	type CueRunActionDeps,
	type CueRunSessionRecord,
} from '../../main/cue/cue-run-router';
import type { CueRunResult } from '../../shared/cue/contracts';
import type { CueExternalNotification } from '../../main/cue/cue-notify-webhook';
import { formatJsonLogLine } from '../../shared/jsonLogLine';
import {
	readSessions,
	readSshRemotes,
	getAgentCustomPath,
	readAgentConfig,
	readSettings,
} from './storage';

/** Lazily import every executor module once, cached for the process lifetime - see the module doc above for why these are dynamic rather than top-level imports. */
let executorsPromise: ReturnType<typeof loadExecutorsUncached> | undefined;
function loadExecutorsUncached() {
	return Promise.all([
		// The desktop registers every provider's output parser once at boot
		// (`src/main/ipc/bootstrap`). Nothing does that here, and without it
		// `getOutputParser()` answers null for every agent: a prompt run's
		// stdout is stored as raw stream-json, and its provider session id,
		// usage, and error classification are all silently lost.
		import('../../shared/maestro-lib/parsers').then((parsers) => parsers.initializeOutputParsers()),
		import('../../main/cue/cue-executor'),
		import('../../main/cue/cue-shell-executor'),
		import('../../main/cue/cue-cli-executor'),
		import('../../main/cue/cue-notify-executor'),
		import('../../main/cue/cue-auth-detector'),
		// Every executor registers its children here; the drain counts and
		// kills through it (see CueEngineDeps.countLiveCueProcesses).
		import('../../main/cue/cue-process-lifecycle'),
	]).then(([, executor, shell, cli, notify, authDetector, lifecycle]) => ({
		countLiveCueProcesses: () => lifecycle.getActiveProcessMap().size,
		killAllCueProcessesNow: lifecycle.stopAllProcesses,
		executeCuePrompt: executor.executeCuePrompt,
		stopCueRun: executor.stopCueRun,
		executeCueShell: shell.executeCueShell,
		executeCueCli: cli.executeCueCli,
		executeCueNotify: notify.executeCueNotify,
		detectCueAuthFailure: authDetector.detectCueAuthFailure,
	}));
}
/**
 * Synchronous mirror of `loadExecutors()`'s resolved value, for
 * `onStopCueRun` (`CueEngineDeps` requires a synchronous `boolean`, not a
 * `Promise<boolean>` - the run manager calls it from a synchronous stop
 * path). Stays `undefined` until the FIRST `loadExecutors()` call (triggered
 * by an actual run dispatch in `buildOnCueRun`, never eagerly at module
 * scope - see the module doc's whole point) settles. A stop request that
 * races a not-yet-settled load has nothing to stop anyway: `onStopCueRun` is
 * only meaningful for a run already in flight, and dispatching that run is
 * what triggers the load in the first place, well before a human or a
 * script can issue a stop for it.
 */
let settledExecutors: Awaited<ReturnType<typeof loadExecutorsUncached>> | undefined;
function loadExecutors() {
	if (!executorsPromise) {
		executorsPromise = loadExecutorsUncached().then((mods) => {
			settledExecutors = mods;
			return mods;
		});
	}
	return executorsPromise;
}

/** Minimal structured logger - every onLog caller in the engine and its executors speaks this shape. */
export type StandaloneCueLog = (level: string, message: string, data?: unknown) => void;

/** Default: write to stdout/stderr by log level, prefixed like the desktop's `logger.cue()` output so a human tailing the process can read it the same way. */
export function consoleCueLog(level: string, message: string): void {
	const line = `[Cue] ${message}`;
	if (level === 'error') {
		console.error(line);
	} else if (level === 'warn') {
		console.warn(line);
	} else {
		console.log(line);
	}
}

/**
 * `--log-format json`: one JSON object per line on stderr, through the same
 * `formatJsonLogLine()` the main-process logger uses in its JSON mode, so the
 * engine's lines and the shared modules' lines carry the same fields. Run
 * identifiers (`runId`, `subscriptionName`, `pipelineId`, `sessionId`) are
 * lifted out of the engine's structured payload; the payload itself is never
 * copied (see `jsonLogLine.ts`).
 */
export function jsonCueLog(level: string, message: string, data?: unknown): void {
	process.stderr.write(`${formatJsonLogLine({ level, message, context: 'Cue', data })}\n`);
}

/** `consoleCueLog`'s text, every level on stderr: for `start --json`, whose stdout is the result. */
export function stderrCueLog(_level: string, message: string): void {
	console.error(`[Cue] ${message}`);
}

/**
 * The engine log sink for a `--log-format` value. JSON lines always go to
 * stderr; text lines keep the info-on-stdout split a human at a terminal
 * expects, unless `stderrOnly` (the command printed `--json`, so stdout is a
 * contract and a log line there would break the parse).
 */
export function cueLogForFormat(
	format: CueLogFormat | undefined,
	options: { stderrOnly?: boolean } = {}
): StandaloneCueLog {
	if (format === 'json') return jsonCueLog;
	return options.stderrOnly ? stderrCueLog : consoleCueLog;
}

export type CueLogFormat = 'text' | 'json';

function sshStoreAdapter(): SshRemoteSettingsStore {
	return { getSshRemotes: () => readSshRemotes() };
}

/**
 * Build the `onCueRun` dependency: dispatches a fired subscription through the
 * same router the desktop uses (`cue-run-router.ts`), minus the three
 * narrowings documented above. Executors arrive from `loadExecutors()` so the
 * router itself never imports them as values.
 */
/** Hand a notification to `--notify-webhook`'s sink; never lets it fail a run. */
function forward(
	sink: ((notification: CueExternalNotification) => void) | undefined,
	notification: CueExternalNotification
): void {
	if (!sink) return;
	try {
		sink(notification);
	} catch {
		// Best effort by contract (see cue-notify-webhook.ts).
	}
}

function buildOnCueRun(
	onLog: StandaloneCueLog,
	onExternalNotification?: (notification: CueExternalNotification) => void
): CueEngineDeps['onCueRun'] {
	return async (params) => {
		const executors = await loadExecutors();
		const deps: CueRunActionDeps = {
			executeCuePrompt: executors.executeCuePrompt,
			executeCueShell: executors.executeCueShell,
			executeCueCli: executors.executeCueCli,
			stopCueRun: executors.stopCueRun,
			findSession: (sessionId) =>
				readSessions().find((s) => s.id === sessionId) as CueRunSessionRecord | undefined,
			// Point 1 (module doc): an explicit override if the user set one,
			// else leave it to spawn()'s own PATH search.
			resolveAgentPath: (toolType) => getAgentCustomPath(toolType),
			sshStore: sshStoreAdapter(),
			getAgentConfigValues: (toolType) => readAgentConfig(toolType),
			onLog,
			getConductorProfile: () =>
				(readSettings() as { conductorProfile?: string }).conductorProfile || undefined,
			// No window in a headless runner - executeCueNotify already
			// degrades gracefully for this (see module doc, point 2).
			onNotify: async (notifyParams) => {
				const result = await executors.executeCueNotify({ ...notifyParams, mainWindow: null });
				// The toast the desktop would show, for --notify-webhook.
				forward(onExternalNotification, {
					type: 'cue.notify',
					agent: {
						id: notifyParams.agentId,
						name: notifyParams.session.name,
						toolType: notifyParams.session.toolType,
					},
					subscription: notifyParams.subscription.name,
					pipeline: notifyParams.subscription.pipeline_name ?? null,
					runId: notifyParams.runId,
					title: notifyParams.title,
					message: notifyParams.message,
					sticky: notifyParams.sticky === true,
				});
				return result;
			},
			reportAuthFailure: (result, toolType) =>
				reportStandaloneAuthFailure(result, toolType, onLog, onExternalNotification),
		};
		return executeCueRunAction(deps, params);
	};
}

/** Point 3 (module doc): classify-and-log only, no capability-snapshot state write. */
async function reportStandaloneAuthFailure(
	result: CueRunResult,
	toolType: string,
	onLog: StandaloneCueLog,
	onExternalNotification?: (notification: CueExternalNotification) => void
): Promise<void> {
	let message: string | null = null;
	try {
		const { detectCueAuthFailure } = await loadExecutors();
		message = detectCueAuthFailure(result, toolType as never);
	} catch {
		return;
	}
	if (!message) return;
	// `message` is the error bank's fixed classification, never run output.
	forward(onExternalNotification, {
		type: 'agent.auth_expired',
		agent: { id: result.sessionId, name: result.sessionName, toolType },
		subscription: result.subscriptionName,
		pipeline: result.pipelineName ?? null,
		runId: result.runId,
		title: `${result.sessionName}: login expired`,
		message,
		sticky: true,
	});
	onLog(
		'error',
		`"${result.subscriptionName}" failed on expired ${toolType} credentials: ${message}. Re-authenticate this agent (e.g. its CLI's own login command) and the next run will pick up fresh credentials.`
	);
}

export interface StandaloneCueEngineOptions {
	onLog?: StandaloneCueLog;
	/** See `CueEngineDeps.onLockLost`. */
	onLockLost?: () => void;
	/** See `CueEngineDeps.onDrainPhase`. */
	onDrainPhase?: CueEngineDeps['onDrainPhase'];
	/**
	 * Told every `action: notify` run and every run that failed on an expired
	 * agent login (`--notify-webhook`). Must not throw or block; it is called
	 * inline with the run.
	 */
	onExternalNotification?: (notification: CueExternalNotification) => void;
}

/** Build the full `CueEngineDeps` for a standalone runner. Exported separately from the engine construction so a caller (tests, `inspect`) can build deps without booting a real engine loop. */
export function buildStandaloneCueEngineDeps(
	options: StandaloneCueEngineOptions = {}
): CueEngineDeps {
	const onLog = options.onLog ?? consoleCueLog;
	return {
		getSessions: () => readSessions(),
		onCueRun: buildOnCueRun(onLog, options.onExternalNotification),
		onStopCueRun: (runId) => {
			if (!settledExecutors) return false; // see settledExecutors' doc comment
			// One registry holds every Cue spawn (agent, shell, maestro-cli), so
			// stopCueRun reaches all three.
			return settledExecutors.stopCueRun(runId);
		},
		onLog,
		runnerMode: 'standalone',
		...(options.onLockLost ? { onLockLost: options.onLockLost } : {}),
		...(options.onDrainPhase ? { onDrainPhase: options.onDrainPhase } : {}),
		// The drain's process accounting. Before the first run fires the
		// executors are not loaded, so there is nothing alive to count or kill.
		countLiveCueProcesses: () => settledExecutors?.countLiveCueProcesses() ?? 0,
		killAllCueProcessesNow: () => settledExecutors?.killAllCueProcessesNow(),
	};
}

/**
 * Construct a standalone `CueEngine`. Callers still own `.start()` /
 * `.stop()` - kept separate from `buildStandaloneCueEngineDeps` so `inspect`
 * can build one without starting the dispatch loop (querying `getStatus()`
 * on a never-started engine is deliberately safe - see `cue-engine.ts`).
 */
export async function createStandaloneCueEngine(
	options: StandaloneCueEngineOptions = {}
): Promise<CueEngine> {
	// Dynamic import: `cue-engine.ts` pulls in a wide main-process module
	// graph (SusFactor, the GitHub poller, etc.) that a CLI command invoked
	// for something else entirely (`cue schedule`, `cue list`) should not pay
	// the load cost for. Every `cue-engine` subcommand is the one place that
	// cost is worth paying.
	const { CueEngine: CueEngineCtor } = await import('../../main/cue/cue-engine');
	return new CueEngineCtor(buildStandaloneCueEngineDeps(options));
}
