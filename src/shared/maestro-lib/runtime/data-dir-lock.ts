/**
 * The lock that makes one process the only writer of a Maestro data directory.
 *
 * `<userData>/maestro-runtime.lock`, beside `cli-server.json` and
 * `cue-engine.lock`. It is in userData rather than the sync directory because a
 * pid means nothing on another machine: a synced data directory is refused by
 * the runtime instead.
 *
 * Built on the same primitive as the Cue engine lock (`./lock`), with the same
 * timings. Two things sit on top of it:
 *
 *   - `cli-server.json` is the desktop's own claim on a directory. A desktop
 *     publishes it only once its window and bridge are up, seconds after its
 *     stores load, so the lock alone cannot see an older desktop that never
 *     takes it. The file is therefore checked before the lock is taken, again
 *     once it is held (closing the window between the two), on every beat, and
 *     before every write (`verify`).
 *   - The pid probe is the discovery one, where EPERM means "alive". For a lock
 *     that guards two writers, refusing is the safe mistake; boot time and
 *     heartbeat still catch a reused pid.
 *
 * Design: `Plans/maestro-tui-runtime.md` sections 3 and 4.
 */

import type { HostInfo } from '../client/types';
import { parseCliServerInfo, type CliServerInfo } from '../client/discovery';
import type { MaestroPaths } from '../paths/resolve';
import * as fs from 'fs';
import {
	createProcessLock,
	defaultProcessLockDeps,
	startLockHeartbeat,
	type ProcessLock,
	type ProcessLockDeps,
	type ProcessLockInfo,
	type ProcessLockSpec,
} from './lock';

/**
 * Who holds the directory. `desktop` is the desktop app. `tui` is a TUI hosting
 * in process, which serves nothing, so others open read-only. `host` is a
 * detached `maestro-cli host`, which serves the bridge, so others attach.
 */
export type RuntimeLockMode = 'desktop' | 'tui' | 'host';

export type RuntimeLockInfo = ProcessLockInfo<RuntimeLockMode>;

export const RUNTIME_LOCK_FILE_NAME = 'maestro-runtime.lock';

/** The Cue lock's timings: a 30 s beat, stale after six missed beats, a minute of boot-time slack. */
export const RUNTIME_LOCK_SPEC: ProcessLockSpec = {
	fileName: RUNTIME_LOCK_FILE_NAME,
	heartbeatMs: 30_000,
	staleMs: 180_000,
	bootToleranceMs: 60_000,
};

/** The refusals that come from the lock itself; the runtime adds its own (`runtime/index.ts`). */
export type DataDirRefusal =
	/** A desktop or a detached host serves this directory. `attachable` is false until it publishes `cli-server.json`. */
	| { reason: 'host-running'; host: HostInfo; attachable: boolean; message: string }
	/** Another runtime that serves nothing (a TUI hosting in process) holds the lock. Open read-only. */
	| { reason: 'held'; holder: RuntimeLockInfo; message: string }
	| { reason: 'lock-failed'; file: string; detail: string; message: string };

export type DataDirLockDeps = ProcessLockDeps & {
	/** The discovery file's text, or undefined when there is none. Injected so a test needs no file. */
	readDiscovery?(file: string): string | undefined;
};

export type DataDirVerdict = { ok: true } | { ok: false; reason: string };

export interface DataDirLock {
	readonly file: string;
	readonly mode: RuntimeLockMode;
	/** What this process wrote into the lock. */
	readonly info: RuntimeLockInfo;
	/**
	 * Is it still safe to write? The lock must still name this pid, and
	 * `cli-server.json` must name no other live host. Call before every write.
	 */
	verify(): DataDirVerdict;
	/**
	 * Beat on a timer. Calls `onLost` once, with the reason, when the lock is
	 * taken over or a desktop appears, then stops. Returns the stop function.
	 */
	startHeartbeat(onLost: (reason: string) => void): () => void;
	release(): void;
}

export type DataDirLockResult =
	| { ok: true; lock: DataDirLock }
	| { ok: false; refusal: DataDirRefusal };

const TAKEN_OVER = 'Another Maestro took over this data directory.';

function describeHolder(holder: RuntimeLockInfo): string {
	const since = holder.startedAt ? `, since ${holder.startedAt}` : '';
	const host = holder.host ? ` on ${holder.host}` : '';
	return `${holder.mode} pid ${holder.pid}${since}${host}`;
}

function readDiscoveryFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf-8');
	} catch {
		return undefined;
	}
}

/**
 * The host `cli-server.json` names, when it is live: it parses, its pid answers,
 * and it was written after this boot began. The last check stops a file left by a
 * desktop that crashed in an earlier boot, whose pid now belongs to a stranger,
 * from blocking every start. This process's own pid is never a rival: a detached
 * host publishes the file itself.
 */
export function readLiveCliServer(
	paths: Pick<MaestroPaths, 'cliServerFile'>,
	deps: DataDirLockDeps = defaultProcessLockDeps
): CliServerInfo | null {
	const raw = (deps.readDiscovery ?? readDiscoveryFile)(paths.cliServerFile);
	const info = raw === undefined ? null : parseCliServerInfo(raw);
	if (!info || info.pid === deps.pid) return null;
	if (!deps.isPidAlive(info.pid)) return null;
	if (info.startedAt < deps.bootTime() - RUNTIME_LOCK_SPEC.bootToleranceMs) return null;
	return info;
}

function hostRunning(
	info: CliServerInfo,
	holder: RuntimeLockInfo | null,
	attachable: boolean
): DataDirRefusal {
	const headless = holder?.mode === 'host' && holder.pid === info.pid;
	const kind = headless ? 'headless' : 'desktop';
	const label = `${kind} pid ${info.pid}`;
	return {
		reason: 'host-running',
		attachable,
		host: {
			kind,
			pid: info.pid,
			startedAt: info.startedAt,
			label,
			...(info.version ? { version: info.version } : {}),
		},
		message: attachable
			? `Maestro (${label}) is serving this data directory. Attach to it instead of hosting a second writer.`
			: `Maestro (${label}) is starting on this data directory. Wait for it, then attach.`,
	};
}

/** A holder that names a desktop or a detached host, for a refusal when `cli-server.json` is not up yet. */
function holderAsHost(holder: RuntimeLockInfo): DataDirRefusal {
	const kind = holder.mode === 'host' ? 'headless' : 'desktop';
	const label = `${kind} pid ${holder.pid}`;
	return {
		reason: 'host-running',
		attachable: false,
		host: { kind, pid: holder.pid, startedAt: Date.parse(holder.startedAt), label },
		message: `Maestro (${describeHolder(holder)}) holds this data directory and is not serving yet. Wait for it, then attach.`,
	};
}

/**
 * Take the data directory for `mode`, or say who has it (steps D, E, and F of
 * the start rule). No store file is written before this returns `ok`.
 */
export function acquireDataDirLock(
	paths: Pick<MaestroPaths, 'userDataDir' | 'cliServerFile'>,
	mode: RuntimeLockMode,
	overrides: Partial<DataDirLockDeps> = {}
): DataDirLockResult {
	const deps: DataDirLockDeps = { ...defaultProcessLockDeps, ...overrides };
	const lock: ProcessLock<RuntimeLockMode> = createProcessLock<RuntimeLockMode>(
		paths.userDataDir,
		RUNTIME_LOCK_SPEC,
		deps
	);

	// D: a live desktop (or host) has published its claim.
	const live = readLiveCliServer(paths, deps);
	if (live) return { ok: false, refusal: hostRunning(live, lock.holder(), true) };

	// E: the lock itself.
	let acquired;
	try {
		acquired = lock.acquire(mode);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			refusal: {
				reason: 'lock-failed',
				file: lock.file,
				detail,
				message: `Could not take ${lock.file}: ${detail}`,
			},
		};
	}
	if (!acquired.acquired) {
		const holder = acquired.heldBy;
		if (holder.mode === 'tui') {
			return {
				ok: false,
				refusal: {
					reason: 'held',
					holder,
					message: `Another Maestro TUI (${describeHolder(holder)}) holds this data directory. Opening read-only.`,
				},
			};
		}
		return { ok: false, refusal: holderAsHost(holder) };
	}

	// F: a desktop or host may have published between D and E.
	const rival = readLiveCliServer(paths, deps);
	if (rival) {
		lock.release();
		return { ok: false, refusal: hostRunning(rival, null, true) };
	}

	const info = lock.holder() ?? {
		pid: deps.pid,
		mode,
		startedAt: new Date(deps.now()).toISOString(),
	};

	const verify = (): DataDirVerdict => {
		const holder = lock.holder();
		if (!holder || holder.pid !== deps.pid) return { ok: false, reason: TAKEN_OVER };
		const other = readLiveCliServer(paths, deps);
		if (other) {
			return {
				ok: false,
				reason: `Maestro (pid ${other.pid}) started serving this data directory.`,
			};
		}
		return { ok: true };
	};

	return {
		ok: true,
		lock: {
			file: lock.file,
			mode,
			info,
			verify,
			startHeartbeat(onLost) {
				let reason = TAKEN_OVER;
				const facade = {
					touch: (beatMode: RuntimeLockMode) => {
						if (lock.touch(beatMode) === 'lost') {
							reason = TAKEN_OVER;
							return 'lost' as const;
						}
						const other = readLiveCliServer(paths, deps);
						if (other) {
							reason = `Maestro (pid ${other.pid}) started serving this data directory.`;
							return 'lost' as const;
						}
						return 'held' as const;
					},
				};
				return startLockHeartbeat(facade, mode, RUNTIME_LOCK_SPEC, () => onLost(reason));
			},
			release: () => lock.release(),
		},
	};
}
