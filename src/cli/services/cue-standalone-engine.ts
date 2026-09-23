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
import type { SshRemoteSettingsStore } from '../../main/utils/ssh-remote-resolver';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { TemplateContext } from '../../shared/templateVariables';
import type { CueRunResult } from '../../shared/cue/contracts';
import { readSessions, readSshRemotes, getAgentCustomPath, readAgentConfig } from './storage';

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
	]).then(([, executor, shell, cli, notify, authDetector]) => ({
		executeCuePrompt: executor.executeCuePrompt,
		stopCueRun: executor.stopCueRun,
		executeCueShell: shell.executeCueShell,
		stopCueShellRun: shell.stopCueShellRun,
		executeCueCli: cli.executeCueCli,
		stopCueCliRun: cli.stopCueCliRun,
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

/**
 * Build the `onCueRun` dependency: dispatches a fired subscription to the
 * right executor (prompt / shell / cli / notify), exactly as
 * `src/main/index.ts`'s inline closure does, minus the three narrowings
 * documented above.
 */
function buildOnCueRun(onLog: StandaloneCueLog): CueEngineDeps['onCueRun'] {
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
	}) => {
		const { executeCuePrompt, executeCueShell, executeCueCli, executeCueNotify } =
			await loadExecutors();
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
			// Point 1 (module doc): an explicit override if the user set one,
			// else leave it to spawn()'s own PATH search.
			customPath: getAgentCustomPath(storedSession.toolType),
			customArgs: storedSession.customArgs,
			customEnvVars: storedSession.customEnvVars,
			customModel: storedSession.customModel,
			customEffort: storedSession.customEffort,
			enableMaestroP: storedSession.enableMaestroP,
			maestroPMode: storedSession.maestroPMode,
			maestroPPath: storedSession.maestroPPath,
			onLog,
			sshStore: sshStoreAdapter(),
			agentConfigValues: readAgentConfig(storedSession.toolType),
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
}

/** Build the full `CueEngineDeps` for a standalone runner. Exported separately from the engine construction so a caller (tests, `inspect`) can build deps without booting a real engine loop. */
export function buildStandaloneCueEngineDeps(
	options: StandaloneCueEngineOptions = {}
): CueEngineDeps {
	const onLog = options.onLog ?? consoleCueLog;
	return {
		getSessions: () => readSessions(),
		onCueRun: buildOnCueRun(onLog),
		onStopCueRun: (runId) => {
			if (!settledExecutors) return false; // see settledExecutors' doc comment
			const { stopCueRun, stopCueShellRun, stopCueCliRun } = settledExecutors;
			return stopCueRun(runId) || stopCueShellRun(runId) || stopCueCliRun(runId);
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
