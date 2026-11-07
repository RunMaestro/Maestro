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
 *    instead runs the first two rungs of the desktop's own precedence
 *    (`resolveCueAgentBinary`): the agent's own custom path, then the
 *    provider-level one (`getAgentCustomPath()`, read straight from the
 *    settings JSON file). Past those it leaves the bare command name for
 *    `spawn()`'s own PATH search, which is correct for the common case (the
 *    agent CLI installed normally).
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
 *
 * And one thing the engine cannot do alone: **`action: autorun` needs a
 * runtime.** An Auto Run is driven by whoever hosts the agents, so the host
 * hands one in (`StandaloneCueEngineOptions.runAutoRun`; `maestro-cli host`
 * binds it to its in-process runtime in `host-cue.ts`). Without it the run
 * fails with a reason that says so. It is never sent as a prompt.
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
import type { CueAutoRunLaunchParams } from '../../main/cue/cue-autorun-executor';
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
import { resolveCliAutoTurn } from './auto-turn';
import type { CueExternalNotification } from '../../main/cue/cue-notify-webhook';
import { formatJsonLogLine } from '../../shared/jsonLogLine';
import {
	readLiveSessions,
	readSessions,
	readSshRemotes,
	getAgentCustomPath,
	readAgentConfig,
	readHarnessTierDefaults,
	readSettings,
} from './storage';
import { prepareMaestroSystemPromptCli } from './system-prompt';

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
		Promise.all([
			import('../../main/cue/cue-process-lifecycle'),
			import('./run-on').then((runOn) => runOn.configureCliRunOn()),
		]).then(([lifecycle]) => lifecycle),
		import('../../main/cue/cue-autorun-executor'),
		import('../../main/cue/cue-agent-binary'),
	]).then(([, executor, shell, cli, notify, authDetector, lifecycle, autoRun, agentBinary]) => ({
		countLiveCueProcesses: () => lifecycle.getActiveProcessMap().size,
		killAllCueProcessesNow: lifecycle.stopAllProcesses,
		executeCuePrompt: executor.executeCuePrompt,
		stopCueRun: executor.stopCueRun,
		getActiveProcesses: executor.getActiveProcesses,
		executeCueAutoRun: autoRun.executeCueAutoRun,
		resolveCueAgentBinary: agentBinary.resolveCueAgentBinary,
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

/** How an Auto Run a Cue subscription launched ended. */
export type StandaloneCueAutoRunEnd = { ok: true } | { ok: false; reason: string };

/**
 * Runs one `action: autorun` launch in whatever hosts the agents. Answers once
 * the launch is accepted or refused; `ended` settles when the run is over, so
 * the Cue run records how the Auto Run went and not only that it began.
 * `signal` aborts when the Cue run is stopped: the Auto Run is stopped with it.
 */
export type StandaloneCueAutoRun = (
	params: CueAutoRunLaunchParams,
	signal: AbortSignal
) => Promise<
	{ started: false; error: string } | { started: true; ended: Promise<StandaloneCueAutoRunEnd> }
>;

/** Why an `action: autorun` run fails in an engine nobody gave a runtime to. */
export const AUTO_RUN_NEEDS_HOST =
	'Auto Run actions need `maestro-cli host`: this Cue engine has no runtime to run an Auto Run in. ' +
	'Stop it and run `maestro-cli host start`, or use the desktop app.';

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type LoadedExecutors = Awaited<ReturnType<typeof loadExecutorsUncached>>;

/**
 * The router's `onAutoRun` for a standalone runner: hand the launch to the
 * host's runtime (`runAutoRun`), then keep the Cue run open until the Auto Run
 * itself ends, so the run records how it went. The router has already refused
 * a run with no documents; without a runtime the launch is refused with
 * {@link AUTO_RUN_NEEDS_HOST}.
 */
function buildOnAutoRun(
	executors: LoadedExecutors,
	onLog: StandaloneCueLog,
	runAutoRun: StandaloneCueAutoRun | undefined,
	autoRunStops: Map<string, AbortController>
): NonNullable<CueRunActionDeps['onAutoRun']> {
	return async (params) => {
		const documents = params.autoRun?.documents ?? [];
		const stop = new AbortController();
		autoRunStops.set(params.runId, stop);
		try {
			let ended: Promise<StandaloneCueAutoRunEnd> | undefined;
			const launched = await executors.executeCueAutoRun({
				...params,
				autoRun: params.autoRun ?? { documents },
				// The launcher contract is to answer, never to reject.
				launch: async (launchParams) => {
					if (!runAutoRun) return { success: false, error: AUTO_RUN_NEEDS_HOST };
					try {
						const answer = await runAutoRun(launchParams, stop.signal);
						if (!answer.started) return { success: false, error: answer.error };
						ended = answer.ended;
						return { success: true };
					} catch (error) {
						return { success: false, error: errorText(error) };
					}
				},
				onLog,
			});
			if (launched.status !== 'completed' || !ended) return launched;

			// The launch record becomes the run's own: it ends when the Auto Run does.
			let end: StandaloneCueAutoRunEnd;
			try {
				end = await ended;
			} catch (error) {
				end = { ok: false, reason: errorText(error) };
			}
			const endedAt = new Date().toISOString();
			const timing = {
				endedAt,
				durationMs: Date.parse(endedAt) - Date.parse(launched.startedAt),
			};
			if (end.ok) {
				return { ...launched, ...timing, stdout: `Auto Run finished: ${documents.join(', ')}` };
			}
			onLog('error', `[CUE] Auto Run "${params.subscription.name}" failed: ${end.reason}`);
			return {
				...launched,
				...timing,
				status: 'failed',
				stdout: '',
				stderr: `Auto Run failed: ${end.reason}`,
				exitCode: 1,
			};
		} finally {
			autoRunStops.delete(params.runId);
		}
	};
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
	onExternalNotification: ((notification: CueExternalNotification) => void) | undefined,
	runAutoRun: StandaloneCueAutoRun | undefined,
	autoRunStops: Map<string, AbortController>
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
			// Point 1 (module doc): the agent's own binary first, then the
			// provider's, else spawn()'s own PATH search.
			resolveAgentBinary: ({ session }) =>
				executors.resolveCueAgentBinary({
					sessionCustomPath: session.customPath,
					providerCustomPath: getAgentCustomPath(session.toolType),
					sshEnabled: session.sessionSshRemoteConfig?.enabled === true,
					// No detector here: past the two custom paths it is spawn()'s own PATH search.
					getDetectedPath: async () => undefined,
					onWarn: (message) => onLog('warn', `[CUE] "${params.subscriptionName}": ${message}`),
				}),
			// The same Maestro system prompt a `maestro-cli send` turn on this agent carries.
			getAppendSystemPrompt: async (sessionId) => {
				const session = readSessions().find((s) => s.id === sessionId);
				return session ? prepareMaestroSystemPromptCli(session) : undefined;
			},
			onAutoRun: buildOnAutoRun(executors, onLog, runAutoRun, autoRunStops),
			sshStore: sshStoreAdapter(),
			getAgentConfigValues: (toolType) => readAgentConfig(toolType),
			onLog,
			getHarnessTierDefaults: readHarnessTierDefaults,
			resolveAutoTurn: (options) =>
				resolveCliAutoTurn({ ...options, agentEffort: options.agent.customEffort }),
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
	/** How an `action: autorun` subscription runs. Absent means it cannot: the run fails and says why. */
	runAutoRun?: StandaloneCueAutoRun;
}

/** Build the full `CueEngineDeps` for a standalone runner. Exported separately from the engine construction so a caller (tests, `inspect`) can build deps without booting a real engine loop. */
export function buildStandaloneCueEngineDeps(
	options: StandaloneCueEngineOptions = {}
): CueEngineDeps {
	const onLog = options.onLog ?? consoleCueLog;
	// An Auto Run a subscription launched has no Cue child process to signal:
	// stopping it is aborting the signal its runner was handed.
	const autoRunStops = new Map<string, AbortController>();
	return {
		getSessions: () => readLiveSessions(),
		onCueRun: buildOnCueRun(
			onLog,
			options.onExternalNotification,
			options.runAutoRun,
			autoRunStops
		),
		onStopCueRun: (runId) => {
			const autoRunStop = autoRunStops.get(runId);
			if (autoRunStop) {
				autoRunStop.abort();
				return true;
			}
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

/** A stopped child is given SIGTERM and then, after the stop ladder's grace period, SIGKILL. This outlasts both. */
const CUE_PROCESS_EXIT_WAIT_MS = 10_000;

/**
 * Wait until every Cue child process (agent, shell, maestro-cli) has exited.
 *
 * Stopping a run only signals its child and records the run as stopped; the
 * child may still be on its way out. A process that exits before it is gone
 * leaves it reparented and running, so a host that stops its runs waits here
 * before it lets go of the data directory. Resolves with the number still
 * alive after `timeoutMs`, which is 0 unless a child ignored SIGKILL's wait.
 * (`maestro-cli cue engine start` does not need it: its drain counts the same
 * registry through `countLiveCueProcesses`.)
 */
export async function waitForStandaloneCueProcesses(
	timeoutMs: number = CUE_PROCESS_EXIT_WAIT_MS
): Promise<number> {
	// Nothing was ever dispatched, so nothing was ever spawned.
	if (!settledExecutors) return 0;
	const children = [...settledExecutors.getActiveProcesses().values()].map((entry) => entry.child);
	const alive = (child: (typeof children)[number]): boolean =>
		child.exitCode === null && child.signalCode === null;
	const waiting = children.filter(alive);
	if (waiting.length === 0) return 0;

	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(
			waiting.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())))
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	return waiting.filter(alive).length;
}
