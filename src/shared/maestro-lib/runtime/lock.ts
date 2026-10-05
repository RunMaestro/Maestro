/**
 * A cross-process advisory lock in a JSON file, with the three guards that make
 * a left-behind lock safe to reclaim: the owner's boot time, a heartbeat, and an
 * atomic (`wx`) create.
 *
 * Lifted out of `src/main/cue/cue-engine-lock.ts` so the Cue engine lock and the
 * data-dir lock (`data-dir-lock.ts`) share one implementation. The file name,
 * timings, pid probe, and clock are parameters; the behavior is the Cue lock's.
 *
 * A live PID alone is not proof of ownership. PIDs are reused: after a reboot,
 * and routinely inside a container, where every restart hands out the same small
 * numbers again. A lock left by a SIGKILLed owner can then name an unrelated live
 * process, which would block every restart (and, for a caller that signals the
 * holder, hit a stranger). So a lock also records the system boot time and a
 * heartbeat the owner refreshes: a lock from an earlier boot, or one whose
 * heartbeat has been quiet for `staleMs`, is stale whatever its PID says.
 *
 * Every call is synchronous. The Cue engine calls them from `start()` and
 * `stop()`, which are. The lock is advisory: it protects against Maestro's own
 * processes, not against an adversarial writer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isPidAlive } from '../client/discovery';

export interface ProcessLockSpec {
	/** File name inside the directory: `cue-engine.lock`, `maestro-runtime.lock`. */
	fileName: string;
	/** How often the owner refreshes the heartbeat. */
	heartbeatMs: number;
	/** A heartbeat older than this is stale even with a live pid (six missed beats). */
	staleMs: number;
	/** Two boot-time readings closer than this are one boot: `os.uptime()` is coarse. */
	bootToleranceMs: number;
}

export interface ProcessLockDeps {
	pid: number;
	/** Epoch ms. */
	now(): number;
	/** Epoch ms the system booted. */
	bootTime(): number;
	/** The probe is per lock: see the data-dir lock and the Cue lock for why they differ. */
	isPidAlive(pid: number): boolean;
	hostname(): string | undefined;
}

export interface ProcessLockInfo<M extends string = string> {
	pid: number;
	mode: M;
	/** ISO time the lock was acquired. */
	startedAt: string;
	/** ISO time of the owner's last beat. Older files lack it; `startedAt` stands in. */
	heartbeatAt?: string;
	/** Epoch ms the owner's system booted. Absent on older lock files. */
	bootTime?: number;
	/** A hint for a person reading the file. Never trusted. */
	host?: string;
}

export type ProcessLockStaleReason = 'process gone' | 'earlier boot' | 'heartbeat quiet';

export type ProcessLockState<M extends string = string> =
	| { state: 'none' }
	| { state: 'unreadable' }
	| { state: 'live'; info: ProcessLockInfo<M> }
	| { state: 'stale'; info: ProcessLockInfo<M>; reason: ProcessLockStaleReason };

export type ProcessLockAcquireResult<M extends string = string> =
	| { acquired: true }
	| { acquired: false; heldBy: ProcessLockInfo<M> };

export type ProcessLockTouchResult = 'held' | 'lost';

export interface ProcessLock<M extends string = string> {
	readonly file: string;
	/** The full answer, with the reason a lock is stale. The doctor reads this. */
	inspect(): ProcessLockState<M>;
	/** The live holder, or null for a missing, corrupt, or stale lock. */
	holder(): ProcessLockInfo<M> | null;
	/**
	 * Take the lock. Refuses, without throwing, while another live process holds
	 * it. Re-acquiring a lock this process already holds is a no-op success.
	 * Creation is atomic (`wx`): two starters at the same instant cannot both see
	 * "no lock" and both write one.
	 */
	acquire(mode: M): ProcessLockAcquireResult<M>;
	/**
	 * Refresh this process's heartbeat. Answers `lost` when another live process
	 * now owns the lock (this one was suspended past the stale window and was
	 * taken over), so the caller stops rather than acting beside the new owner. A
	 * missing file (deleted by hand) is rewritten.
	 */
	touch(mode: M): ProcessLockTouchResult;
	/** Release, but only if this process still holds it. */
	release(): void;
}

/**
 * The Cue engine lock's parameters. Here rather than in `src/main/cue` so the
 * doctor, which cannot import from main, reads the same numbers the engine uses.
 */
export const CUE_ENGINE_LOCK_SPEC: ProcessLockSpec = {
	fileName: 'cue-engine.lock',
	heartbeatMs: 30_000,
	staleMs: 180_000,
	bootToleranceMs: 60_000,
};

export const defaultProcessLockDeps: ProcessLockDeps = {
	pid: process.pid,
	now: () => Date.now(),
	bootTime: () => Date.now() - os.uptime() * 1000,
	isPidAlive,
	hostname: () => {
		try {
			return os.hostname();
		} catch {
			return undefined;
		}
	},
};

/** Parse lock file contents. Null for anything without a numeric `pid` and a string `mode`. */
export function parseProcessLock<M extends string = string>(
	raw: string
): ProcessLockInfo<M> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const info = parsed as Partial<ProcessLockInfo<M>> | null;
	if (!info || typeof info.pid !== 'number' || typeof info.mode !== 'string') return null;
	return {
		pid: info.pid,
		mode: info.mode,
		startedAt: typeof info.startedAt === 'string' ? info.startedAt : new Date(0).toISOString(),
		heartbeatAt: typeof info.heartbeatAt === 'string' ? info.heartbeatAt : undefined,
		bootTime: typeof info.bootTime === 'number' ? info.bootTime : undefined,
		host: typeof info.host === 'string' ? info.host : undefined,
	};
}

/**
 * Whether a parsed lock still belongs to a running owner. The checks run in
 * order, which is what gives a stale lock its reason: the pid, then the boot
 * (catches a reused pid), then the heartbeat.
 */
export function classifyProcessLock<M extends string>(
	info: ProcessLockInfo<M>,
	spec: Pick<ProcessLockSpec, 'staleMs' | 'bootToleranceMs'>,
	deps: Pick<ProcessLockDeps, 'now' | 'bootTime' | 'isPidAlive'>
): ProcessLockState<M> {
	const stale = (reason: ProcessLockStaleReason): ProcessLockState<M> => ({
		state: 'stale',
		info,
		reason,
	});
	if (!Number.isFinite(info.pid) || info.pid <= 0 || !deps.isPidAlive(info.pid)) {
		return stale('process gone');
	}
	if (
		typeof info.bootTime === 'number' &&
		Math.abs(info.bootTime - deps.bootTime()) > spec.bootToleranceMs
	) {
		return stale('earlier boot');
	}
	const beat = Date.parse(info.heartbeatAt ?? info.startedAt);
	if (!Number.isFinite(beat) || deps.now() - beat > spec.staleMs) return stale('heartbeat quiet');
	return { state: 'live', info };
}

/**
 * Classify lock file contents the caller read itself. The doctor reads through
 * an injected filesystem, so it cannot hand the primitive a directory; it hands
 * it the text instead and gets the same answer `inspect()` would.
 */
export function inspectProcessLockContent<M extends string = string>(
	raw: string,
	spec: Pick<ProcessLockSpec, 'staleMs' | 'bootToleranceMs'>,
	deps: Pick<ProcessLockDeps, 'now' | 'bootTime' | 'isPidAlive'>
): ProcessLockState<M> {
	const info = parseProcessLock<M>(raw);
	return info ? classifyProcessLock(info, spec, deps) : { state: 'unreadable' };
}

export function createProcessLock<M extends string = string>(
	dir: string,
	spec: ProcessLockSpec,
	overrides: Partial<ProcessLockDeps> = {}
): ProcessLock<M> {
	const deps: ProcessLockDeps = { ...defaultProcessLockDeps, ...overrides };
	const file = path.join(dir, spec.fileName);

	function inspect(): ProcessLockState<M> {
		let raw: string;
		try {
			raw = fs.readFileSync(file, 'utf-8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'unreadable' };
		}
		return inspectProcessLockContent<M>(raw, spec, deps);
	}

	/** The file's contents, live or not. Null when missing or corrupt. */
	function readRaw(): ProcessLockInfo<M> | null {
		try {
			return parseProcessLock<M>(fs.readFileSync(file, 'utf-8'));
		} catch {
			return null;
		}
	}

	function isLive(info: ProcessLockInfo<M>): boolean {
		return classifyProcessLock(info, spec, deps).state === 'live';
	}

	function buildInfo(mode: M, startedAt?: string): ProcessLockInfo<M> {
		const now = new Date(deps.now()).toISOString();
		return {
			pid: deps.pid,
			mode,
			startedAt: startedAt ?? now,
			heartbeatAt: now,
			bootTime: deps.bootTime(),
			host: deps.hostname(),
		};
	}

	return {
		file,
		inspect,

		holder() {
			const info = readRaw();
			return info && isLive(info) ? info : null;
		},

		acquire(mode) {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			for (let attempt = 0; attempt < 3; attempt++) {
				const existing = readRaw();
				if (existing && isLive(existing)) {
					if (existing.pid !== deps.pid) return { acquired: false, heldBy: existing };
					fs.writeFileSync(file, JSON.stringify(buildInfo(mode), null, 2), 'utf-8');
					return { acquired: true };
				}
				if (fs.existsSync(file)) {
					// Stale or corrupt. A concurrent starter may remove it first; the
					// `wx` create below is what decides who wins.
					try {
						fs.unlinkSync(file);
					} catch {
						// Already removed.
					}
				}
				try {
					fs.writeFileSync(file, JSON.stringify(buildInfo(mode), null, 2), {
						encoding: 'utf-8',
						flag: 'wx',
					});
					return { acquired: true };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
					// Created by someone else between our read and write: loop and re-read.
				}
			}
			return { acquired: false, heldBy: readRaw() ?? buildInfo(mode) };
		},

		touch(mode) {
			const existing = readRaw();
			if (existing && existing.pid !== deps.pid && isLive(existing)) return 'lost';
			const startedAt = existing?.pid === deps.pid ? existing.startedAt : undefined;
			try {
				fs.writeFileSync(file, JSON.stringify(buildInfo(mode, startedAt), null, 2), 'utf-8');
			} catch {
				// A failed write only ages the heartbeat; the next beat retries.
			}
			return 'held';
		},

		release() {
			const existing = readRaw();
			if (existing && existing.pid !== deps.pid && isLive(existing)) return;
			try {
				fs.unlinkSync(file);
			} catch {
				// Already gone, or never existed: releasing an absent lock is a no-op.
			}
		},
	};
}

/**
 * Beat the lock every `spec.heartbeatMs` on an unref'd timer, so the beat never
 * keeps a process alive. Calls `onLost` once when `touch()` answers `lost`, then
 * stops. Returns the stop function.
 */
export function startLockHeartbeat<M extends string>(
	lock: Pick<ProcessLock<M>, 'touch'>,
	mode: M,
	spec: Pick<ProcessLockSpec, 'heartbeatMs'>,
	onLost: () => void
): () => void {
	const timer = setInterval(() => {
		if (lock.touch(mode) === 'lost') {
			clearInterval(timer);
			onLost();
		}
	}, spec.heartbeatMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
