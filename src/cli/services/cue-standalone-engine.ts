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

import * as os from 'os';
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
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { TemplateContext } from '../../shared/templateVariables';
import type { CueRunResult } from '../../shared/cue/contracts';
import {
	cueAutoMarker,
	cueRunIsAutoRouted,
	cueTurnLaunch,
	resolveCueTurnSettings,
} from '../../shared/cue/turn-settings';
import { describeTurnSettings, type ResolvedTurnSettings } from '../../shared/autorunTurnSettings';
import { resolveCliAutoTurn } from './auto-turn';
import {
	readSessions,
	readSshRemotes,
	getAgentCustomPath,
	readAgentConfig,
	readHarnessTierDefaults,
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
		// A Cue run of an agent with a Run on target looks its source up through
		// stores the desktop wires at boot. Nothing does that here, and an
		// unwired lookup throws rather than run the agent on its provider's
		// model (see `./run-on`).
		import('./run-on').then((runOn) => runOn.configureCliRunOn()),
		import('../../main/cue/cue-autorun-executor'),
		import('../../main/cue/cue-agent-binary'),
	]).then(([, executor, shell, cli, notify, authDetector, , autoRun, agentBinary]) => ({
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

/**
 * Build the `onCueRun` dependency: dispatches a fired subscription to the
 * right executor (autorun / prompt / shell / cli / notify), exactly as
 * `src/main/index.ts`'s inline closure does, minus the three narrowings
 * documented above.
 */
function buildOnCueRun(
	onLog: StandaloneCueLog,
	runAutoRun: StandaloneCueAutoRun | undefined,
	autoRunStops: Map<string, AbortController>
): CueEngineDeps['onCueRun'] {
	return async ({
		runId,
		sessionId,
		prompt,
		subscriptionName,
		event,
		timeoutMs,
		action,
		command,
		notify,
		autoRun,
		turnSettings,
	}) => {
		const {
			executeCuePrompt,
			executeCueShell,
			executeCueCli,
			executeCueNotify,
			executeCueAutoRun,
			resolveCueAgentBinary,
		} = await loadExecutors();
		const sessions = readSessions();
		const storedSession = sessions.find((s) => s.id === sessionId);
		if (!storedSession) {
			throw new Error(`Cue target session not found: ${sessionId}`);
		}

		const projectRoot =
			storedSession.projectRoot || storedSession.cwd || storedSession.fullPath || os.homedir();
		const templateContext: TemplateContext = {
			session: {
				id: storedSession.id,
				name: storedSession.name,
				toolType: storedSession.toolType,
				cwd: projectRoot,
				projectRoot,
				fullPath: storedSession.fullPath,
				autoRunFolderPath: storedSession.autoRunFolderPath,
			},
		};
		const sessionInfo = {
			id: storedSession.id,
			name: storedSession.name,
			toolType: storedSession.toolType,
			cwd: projectRoot,
			projectRoot,
			autoRunFolderPath: storedSession.autoRunFolderPath,
		};

		// Handled first, as on the desktop: an Auto Run spawns nothing here, and
		// falling through would send its document list to the agent as a prompt.
		if (action === 'autorun') {
			const documents = autoRun?.documents ?? [];
			// Why this run cannot start at all, or undefined. An empty document list
			// is a queued run restored from a row that predates the stored payload.
			const refusal =
				documents.length === 0
					? 'no documents on the run - the captured Auto Run payload did not survive the queue'
					: runAutoRun
						? undefined
						: AUTO_RUN_NEEDS_HOST;
			const stop = new AbortController();
			autoRunStops.set(runId, stop);
			try {
				let ended: Promise<StandaloneCueAutoRunEnd> | undefined;
				const launched = await executeCueAutoRun({
					runId,
					session: sessionInfo,
					subscription: {
						name: subscriptionName,
						event: event.type,
						enabled: true,
						prompt,
						action,
						auto_run: autoRun,
						agent_id: storedSession.id,
					},
					event,
					autoRun: autoRun ?? { documents },
					// The launcher contract is to answer, never to reject.
					launch: async (params) => {
						if (refusal || !runAutoRun) return { success: false, error: refusal };
						try {
							const answer = await runAutoRun(params, stop.signal);
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
				onLog('error', `[CUE] Auto Run "${subscriptionName}" failed: ${end.reason}`);
				return {
					...launched,
					...timing,
					status: 'failed',
					stdout: '',
					stderr: `Auto Run failed: ${end.reason}`,
					exitCode: 1,
				};
			} finally {
				autoRunStops.delete(runId);
			}
		}

		if (action === 'notify') {
			const message = notify?.message?.trim() || prompt;
			return executeCueNotify({
				runId,
				session: sessionInfo,
				subscription: {
					name: subscriptionName,
					event: event.type,
					enabled: true,
					prompt,
					action,
					notify,
				},
				event,
				agentId: storedSession.id,
				message,
				sticky: notify?.sticky === true,
				title: storedSession.name || getAgentDisplayName(storedSession.toolType),
				// No window in a headless runner - executeCueNotify already
				// degrades gracefully for this (see module doc, point 2).
				mainWindow: null,
				onLog,
			});
		}

		if (action === 'command') {
			if (!command) {
				throw new Error(
					`Cue subscription "${subscriptionName}" has action='command' but no command payload`
				);
			}
			const subscription = {
				name: subscriptionName,
				event: event.type,
				enabled: true,
				prompt,
				action,
				command,
			};
			return command.mode === 'shell'
				? executeCueShell({
						runId,
						session: sessionInfo,
						subscription,
						event,
						shellCommand: command.shell,
						projectRoot,
						templateContext,
						timeoutMs,
						onLog,
						sshRemoteConfig: storedSession.sessionSshRemoteConfig,
						sshStore: sshStoreAdapter(),
					})
				: executeCueCli({
						runId,
						session: sessionInfo,
						subscription,
						event,
						cli: command.cli,
						templateContext,
						timeoutMs,
						onLog,
					});
		}

		// Same rule as the desktop host (src/main/index.ts): the subscription's
		// tier / model / effort outranks the agent's own config for this run only,
		// and one the provider cannot honor falls back to the agent's value with a
		// warning, so a headless run never lands on a different model than asked.
		// A tier launches on its target (the agent's own, then the harness
		// default), and a target that cannot be used fails the run by name.
		const turn = resolveCueTurnSettings(
			storedSession.toolType,
			turnSettings,
			storedSession.customModel,
			storedSession.customEffort,
			{
				tierTargets: storedSession.tierTargets,
				runOn: storedSession.runOn,
				harnessDefaults: readHarnessTierDefaults(),
			}
		);
		const logCueTurn = (resolvedTurn: ResolvedTurnSettings) => {
			const turnNote = describeTurnSettings(resolvedTurn);
			if (!turnNote) return;
			onLog(
				resolvedTurn.warnings.length > 0 ? 'warn' : 'cue',
				`[CUE] "${subscriptionName}" model: ${turnNote}`
			);
		};
		// A subscription on the Auto model (`model: auto`) is routed once its
		// prompt is known, by the hook below (the desktop host does the same).
		// The router is the desktop app's: with none to ask, the run launches on
		// `turn`, the agent's default.
		const routed = cueRunIsAutoRouted(turnSettings);
		if (!routed) logCueTurn(turn);

		// The agent's own binary first, then the provider's (module doc, point 1).
		const customPath = await resolveCueAgentBinary({
			sessionCustomPath: storedSession.customPath,
			providerCustomPath: getAgentCustomPath(storedSession.toolType),
			sshEnabled: storedSession.sessionSshRemoteConfig?.enabled === true,
			// No detector here: past the two custom paths it is spawn()'s own PATH search.
			getDetectedPath: async () => undefined,
			onWarn: (message) => onLog('warn', `[CUE] "${subscriptionName}": ${message}`),
		});

		// The same Maestro system prompt a `maestro-cli send` turn on this agent carries.
		const appendSystemPrompt = await prepareMaestroSystemPromptCli(storedSession);

		const result = await executeCuePrompt({
			runId,
			session: sessionInfo,
			subscription: { name: subscriptionName, event: event.type, enabled: true, prompt },
			event,
			promptPath: prompt,
			toolType: storedSession.toolType,
			projectRoot,
			templateContext,
			timeoutMs,
			sshRemoteConfig: storedSession.sessionSshRemoteConfig,
			customPath,
			customArgs: storedSession.customArgs,
			customEnvVars: storedSession.customEnvVars,
			gatewayUrl: storedSession.gatewayUrl,
			...cueTurnLaunch(turn, storedSession.runOn),
			...(routed
				? {
						resolveLateTurn: async (routedPrompt: string) => {
							const autoTurn = await resolveCliAutoTurn({
								agent: storedSession,
								prompt: routedPrompt,
								agentEffort: storedSession.customEffort,
								marker: cueAutoMarker(turnSettings),
							});
							logCueTurn(autoTurn);
							return cueTurnLaunch(autoTurn, storedSession.runOn);
						},
					}
				: {}),
			enableMaestroP: storedSession.enableMaestroP,
			maestroPMode: storedSession.maestroPMode,
			maestroPPath: storedSession.maestroPPath,
			onLog,
			sshStore: sshStoreAdapter(),
			agentConfigValues: readAgentConfig(storedSession.toolType),
			appendSystemPrompt,
		});

		await reportStandaloneAuthFailure(result, storedSession.toolType, onLog);
		return result;
	};
}

/** Point 3 (module doc): classify-and-log only, no capability-snapshot state write. */
async function reportStandaloneAuthFailure(
	result: CueRunResult,
	toolType: string,
	onLog: StandaloneCueLog
): Promise<void> {
	let message: string | null = null;
	try {
		const { detectCueAuthFailure } = await loadExecutors();
		message = detectCueAuthFailure(result, toolType as never);
	} catch {
		return;
	}
	if (!message) return;
	onLog(
		'error',
		`"${result.subscriptionName}" failed on expired ${toolType} credentials: ${message}. Re-authenticate this agent (e.g. its CLI's own login command) and the next run will pick up fresh credentials.`
	);
}

export interface StandaloneCueEngineOptions {
	onLog?: StandaloneCueLog;
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
		getSessions: () => readSessions(),
		onCueRun: buildOnCueRun(onLog, options.runAutoRun, autoRunStops),
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
