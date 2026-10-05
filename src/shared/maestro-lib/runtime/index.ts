/**
 * `createMaestroRuntime()`: the object that owns writes to a Maestro data
 * directory when no desktop does.
 *
 * It composes the paths, the data-dir lock, store I/O, the agent repository, the
 * process registry, and the event bus, and implements the agent, group, tab, and
 * settings parts of `MaestroClient` in process (`./client`). Wrappers hold it: the
 * TUI directly, `maestro-cli host` behind the bridge (Phase 7), Electron main
 * behind a setting (Phase 9). It has no network in it.
 *
 * lib-D2: the runtime owns writes, process lifetime, and events. It does not own
 * completion policy, stream interpretation, or outcomes; those stay with the
 * callers that consume its events.
 *
 * Design: `Plans/maestro-tui-runtime.md`, sections 2 and 3 (the start rule).
 */

import * as fs from 'fs/promises';

import { createAgentRepository } from '../agents/repository';
import type { RepositoryLoadFailure } from '../agents/repository';
import type { RuleContext, TabDefaults } from '../agents/rules';
import { createEventBus } from '../client/event-bus';
import type { HostInfo, MaestroClient } from '../client/types';
import { logger } from '../host';
import type { BinaryDetectionResult } from '../launch/path-prober';
import { assertUserDataDirExists, type UserDataDirOptions } from '../paths/userDataDir';
import { resolveMaestroPaths, type MaestroPaths } from '../paths/resolve';
import { readAgentConfigsStore } from '../store/read-stores';
import { createRuntimeClient, type RuntimePhase } from './client';
import {
	acquireDataDirLock,
	type DataDirLockDeps,
	type DataDirRefusal,
	type RuntimeLockInfo,
	type RuntimeLockMode,
} from './data-dir-lock';
import { createProcessRegistry } from './processes';
import { createRuntimeAutoRun, type RuntimeAutoRun } from './autorun';
import { createProviderLister } from './providers';
import { watchSettingsFile, type WatchDirectory } from './settings-watch';
import { createRuntimeTurns, type RuntimeTurnDeps, type RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[MaestroRuntime]';

/** Test seams: the lock's clock, pid, and probes, plus the rest of the runtime's outside world. */
export type RuntimeDeps = DataDirLockDeps & {
	/** Ids, clock, and randomness for new records. */
	rules: Partial<RuleContext>;
	/** Why a local working directory cannot be used, or null. */
	checkCwd(cwd: string): string | null;
	/** The settings a new tab starts from. */
	readTabDefaults(): Promise<TabDefaults>;
	/** Is this provider binary, or the custom path set for it, runnable? */
	probeBinary(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	/** Watches the settings directory. */
	watchDirectory: WatchDirectory;
	/** The seams of the turn service: the provider launch and the probes a turn makes. */
	turns: Partial<RuntimeTurnDeps>;
};

export interface MaestroRuntimeOptions {
	/** The user data dir the caller resolved (`resolveUserDataDir`, `--data-dir`, `--dev`). Never read from the environment here. */
	dataDir: string;
	/** Where agent configs live in a dev run. Default: the production directory `dataDir` maps to. */
	productionDataDir?: string;
	/** Who hosts, written into the lock: `tui` (Phase 5), `host` (Phase 7), `desktop` (Phase 9). */
	mode: RuntimeLockMode;
	/** Create `dataDir` when it does not exist. Default false: a guessed directory must not become an empty database. */
	createDataDir?: boolean;
	/** Host on a `customSyncPath` anyway (a pid lock cannot see another machine). Default false. */
	allowSyncedDataDir?: boolean;
	/** Quarantine a corrupt sessions or groups file and start from defaults. Default false: refuse. */
	quarantineCorruptStores?: boolean;
	/** What the runtime needs to run turns: the SQLite loader, the CLI script, the bundled prompts. */
	turns?: RuntimeTurnOptions;
	deps?: Partial<RuntimeDeps>;
}

export type RuntimeRefusal =
	| DataDirRefusal
	| { reason: 'data-dir-missing'; tried: string[]; message: string }
	| { reason: 'synced-data-dir'; syncDir: string; message: string }
	| RepositoryLoadFailure;

export type RuntimeStart =
	| { ok: true; runtime: MaestroRuntime }
	| { ok: false; refusal: RuntimeRefusal };

export interface MaestroRuntime extends MaestroClient {
	readonly paths: MaestroPaths;
	/** What this process wrote into `maestro-runtime.lock`. */
	readonly lock: RuntimeLockInfo;
	/**
	 * The Auto Runs in flight, for a host that reports them (`host status`, the refusal to stop with
	 * work in flight) and replays them to a client that connects mid-run.
	 */
	readonly runs: Pick<RuntimeAutoRun, 'activeRuns' | 'latestState'>;
}

/** What the status bar prints after `host: `. */
function hostLabel(mode: RuntimeLockMode, pid: number): string {
	switch (mode) {
		case 'tui':
			return 'this TUI';
		case 'host':
			return `this host (pid ${pid})`;
		case 'desktop':
			return `this desktop (pid ${pid})`;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The refusal for a directory that is not there (or not a directory), with the message the CLI gives. */
function missingDataDir(userDataDir: string, env: UserDataDirOptions['env']): RuntimeRefusal {
	let message = `Maestro data directory not found at ${userDataDir}.`;
	try {
		assertUserDataDirExists(userDataDir, { env });
	} catch (error) {
		message = errorText(error);
	}
	return { reason: 'data-dir-missing', tried: [userDataDir], message };
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return false;
		throw error;
	}
}

/**
 * Start a runtime on `options.dataDir`, or say why not. The first failing step
 * refuses and nothing is written before the lock is held (the start rule, section
 * 3 of the design).
 */
export async function createMaestroRuntime(options: MaestroRuntimeOptions): Promise<RuntimeStart> {
	const deps = options.deps ?? {};
	const env = { MAESTRO_USER_DATA: options.dataDir };
	const paths = resolveMaestroPaths({
		env,
		...(options.productionDataDir ? { productionDataPath: options.productionDataDir } : {}),
	});

	// B: the directory is there. Creating one is the caller's explicit choice.
	try {
		if (!(await isDirectory(paths.userDataDir))) {
			if (!options.createDataDir) {
				return { ok: false, refusal: missingDataDir(paths.userDataDir, env) };
			}
			await fs.mkdir(paths.userDataDir, { recursive: true });
		}
	} catch (error) {
		return {
			ok: false,
			refusal: {
				reason: 'data-dir-missing',
				tried: [paths.userDataDir],
				message: `Cannot use ${paths.userDataDir}: ${errorText(error)}`,
			},
		};
	}

	// C: a synced directory is shared with machines this lock cannot see (risk R3).
	if (paths.syncDirSource === 'customSyncPath' && !options.allowSyncedDataDir) {
		return {
			ok: false,
			refusal: {
				reason: 'synced-data-dir',
				syncDir: paths.syncDir,
				message: `Settings and agents sync through ${paths.syncDir}. A lock on this machine cannot see another one writing there, so it is not hosted headless.`,
			},
		};
	}

	// D, E, F: a live desktop or host, then the lock, then a second look for a desktop.
	const locked = acquireDataDirLock(paths, options.mode, deps);
	if (!locked.ok) return { ok: false, refusal: locked.refusal };
	const lock = locked.lock;

	const bus = createEventBus(LOG_CONTEXT);
	const registry = createProcessRegistry();
	let phase: RuntimePhase = 'open';
	let fencedText = 'Another Maestro took over this data directory.';
	/** Filled in once the runtime is up; the fence and the shutdown both close them. */
	const running: { stopHeartbeat?: () => void; settingsWatcher?: { close(): void } } = {};

	/** Lost the directory: no more writes, stop what the runtime started, tell the listeners (RT11). */
	const fenceRuntime = (reason: string): void => {
		if (phase !== 'open') return;
		phase = 'fenced';
		fencedText = reason;
		repository.fence(reason);
		running.stopHeartbeat?.();
		running.settingsWatcher?.close();
		autoRun.stopAll().catch((error) => {
			logger.warn(
				`Stopping Auto Runs after losing the data directory failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		});
		registry.stopAll().catch((error) => {
			logger.warn(
				`Stopping processes after losing the data directory failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		});
		bus.emit({ type: 'host.lost', reason });
	};

	/** Is this process still the data directory's writer? Losing it fences the whole runtime. */
	const fence = () => {
		const verdict = lock.verify();
		if (!verdict.ok) fenceRuntime(verdict.reason);
		return verdict;
	};

	const repository = createAgentRepository({
		paths,
		bus,
		processes: registry,
		fence,
		quarantineCorruptStores: options.quarantineCorruptStores,
		context: deps.rules,
		readTabDefaults: deps.readTabDefaults,
		checkCwd: deps.checkCwd,
	});

	try {
		if (paths.syncDir !== paths.userDataDir) await fs.mkdir(paths.syncDir, { recursive: true });
		const loaded = await repository.load();
		if (!loaded.ok) {
			lock.release();
			return { ok: false, refusal: loaded.failure };
		}
	} catch (error) {
		lock.release();
		return {
			ok: false,
			refusal: {
				reason: 'lock-failed',
				file: lock.file,
				detail: errorText(error),
				message: `Could not start on ${paths.userDataDir}: ${errorText(error)}`,
			},
		};
	}

	running.stopHeartbeat = lock.startHeartbeat(fenceRuntime);
	running.settingsWatcher = watchSettingsFile({
		file: paths.settingsFile,
		onChange: (keys) => bus.emit({ type: 'settings.changed', keys }),
		watch: deps.watchDirectory,
	});

	const listProviders = createProviderLister({
		readCustomPaths: () => {
			const configs = readAgentConfigsStore(paths.agentConfigsFile);
			const out: Record<string, string | undefined> = {};
			if (configs.status !== 'ok') return out;
			for (const [id, config] of Object.entries(configs.data.configs ?? {})) {
				const customPath = (config as { customPath?: unknown }).customPath;
				if (typeof customPath === 'string') out[id] = customPath;
			}
			return out;
		},
		probe: deps.probeBinary,
		now: deps.now,
	});

	// The run releases what it held back (queued chat messages) when it ends, and the turn service
	// asks whether a run holds an agent: each needs the other, so the run reaches `turns`, declared
	// below, only when a run ends.
	const autoRun = createRuntimeAutoRun({
		paths,
		repository,
		bus,
		registry,
		fence,
		options: options.turns,
		deps: { probeBinary: deps.probeBinary, ...deps.turns },
		onRunEnded: (agentId) => turns.drain(agentId),
	});
	const turns = createRuntimeTurns({
		paths,
		repository,
		bus,
		registry,
		fence,
		rules: deps.rules,
		autoRunHolds: (agentId) => autoRun.holds(agentId),
		options: options.turns,
		deps: { probeBinary: deps.probeBinary, ...deps.turns },
	});

	// NF-7: a crash or a plain exit must not leave a held lock or an orphan it could have stopped.
	const onExit = (): void => {
		registry.terminateAllNow();
		lock.release();
	};
	process.once('exit', onExit);

	let shutdownDone: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		shutdownDone ??= (async () => {
			phase = 'closed';
			running.stopHeartbeat?.();
			running.settingsWatcher?.close();
			try {
				// Nothing new starts; the turns that run are stopped and finish recording themselves
				// (their records are repository commands), and only then is the write queue drained.
				turns.dispose();
				// Runs first: stopping one records how it ended (History, stats) while the lock is still held.
				await autoRun.stopAll();
				await registry.stopAll();
				await repository.drain();
			} finally {
				process.off('exit', onExit);
				lock.release();
			}
		})();
		return shutdownDone;
	};

	const host: HostInfo = {
		kind: 'in-process',
		startedAt: Date.parse(lock.info.startedAt),
		label: hostLabel(options.mode, lock.info.pid),
	};

	const client = createRuntimeClient({
		paths,
		repository,
		bus,
		host,
		phase: () => phase,
		fencedReason: () => fencedText,
		shutdown,
		listProviders,
		turns: turns.api,
		autoRun: autoRun.api,
	});

	return {
		ok: true,
		runtime: {
			...client,
			paths,
			lock: lock.info,
			runs: { activeRuns: autoRun.activeRuns, latestState: autoRun.latestState },
		},
	};
}
