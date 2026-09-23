/**
 * Cross-process lock preventing two Cue engine loops (the desktop app and a
 * standalone `maestro-cli cue engine` runner, or two standalone runners) from
 * dispatching the SAME subscriptions at once.
 *
 * Both runners read the SAME on-disk state for a given data directory -
 * `.maestro/cue.yaml` per project, and one shared `cue.db` (see
 * `cue-data-dir.ts` / `resolveMaestroUserDataDir()`). Without coordination, a
 * user who leaves the desktop app open AND starts the standalone engine (for
 * unattended operation when the desktop app is closed) would get every
 * trigger firing TWICE - two agent processes spawned per `time.heartbeat`
 * tick, a GitHub PR poller finding and dispatching the same PR from two
 * independent poll loops, etc. `CueRunManager`'s `max_concurrent` guard and
 * `activeRootKeys` self-overlap check (see CLAUDE-CUE.md) only serialize runs
 * WITHIN one engine instance; they have no visibility into a second process.
 *
 * This is deliberately a SINGLE global lock per data directory, not a
 * per-project one: `cue.db` is one shared database (see `cue-data-dir.ts`),
 * and the event queue / history / telemetry outbox tables it holds have no
 * per-project isolation either, so two engines writing to it concurrently
 * would race on it independently of which projects each happens to own.
 *
 * The lock is advisory (a JSON file), not an OS-level file lock - `fs.flock`
 * has no cross-platform equivalent in plain Node, and an advisory lock is
 * sufficient here because both callers (the desktop main process and the
 * standalone CLI command) are Maestro's own code and check it cooperatively
 * before starting the engine. It is NOT a substitute for a real mutex against
 * an adversarial writer.
 *
 * A live PID alone is not proof of ownership. PIDs are reused - after a
 * reboot, and routinely inside a container, where every restart hands out the
 * same small numbers again - so a lock left by a SIGKILLed engine can name an
 * unrelated process that happens to be alive. Trusting that would block every
 * restart and, worse, let `cue engine stop` SIGTERM a stranger. A lock
 * therefore also records the system boot time and a heartbeat the owner
 * refreshes (`touchCueEngineLock`, every {@link CUE_ENGINE_LOCK_HEARTBEAT_MS}):
 * a lock from an earlier boot, or one whose heartbeat has been quiet for
 * {@link CUE_ENGINE_LOCK_STALE_MS}, is stale whatever its PID says.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMaestroUserDataDir } from '../../shared/maestroUserDataDir';

export type CueEngineRunnerMode = 'desktop' | 'standalone';

/** How often the owning engine refreshes the lock's heartbeat. */
export const CUE_ENGINE_LOCK_HEARTBEAT_MS = 30_000;
/** A lock whose heartbeat is older than this is stale even if its PID is alive (six missed beats). */
export const CUE_ENGINE_LOCK_STALE_MS = 180_000;
/** Two boot-time readings closer than this are the same boot: `os.uptime()` is coarse and drifts slightly. */
const BOOT_TIME_TOLERANCE_MS = 60_000;

export interface CueEngineLockInfo {
	pid: number;
	mode: CueEngineRunnerMode;
	/** ISO timestamp the lock was acquired. */
	startedAt: string;
	/** ISO timestamp of the owner's last heartbeat. Older lock files lack it; `startedAt` stands in. */
	heartbeatAt?: string;
	/** Epoch ms the system booted, as seen by the owner. Absent on older lock files. */
	bootTime?: number;
	/** Free-text hint for a human reading the lock file directly (hostname, etc). Best-effort, not load-bearing. */
	host?: string;
}

function lockFilePath(dataDir: string = resolveMaestroUserDataDir()): string {
	return path.join(dataDir, 'cue-engine.lock');
}

function currentBootTime(): number {
	return Date.now() - os.uptime() * 1000;
}

/**
 * Whether the process named in a lock is still alive. `process.kill(pid, 0)`
 * sends no signal - it only tests for permission/existence - and Node
 * documents this as working the same way on Windows and POSIX.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a lock still belongs to a running engine: its PID is alive, it was
 * written during THIS boot, and its heartbeat is recent. The last two are what
 * catch a reused PID (see the module doc).
 */
function isLockLive(info: CueEngineLockInfo): boolean {
	if (!isProcessAlive(info.pid)) return false;
	if (
		typeof info.bootTime === 'number' &&
		Math.abs(info.bootTime - currentBootTime()) > BOOT_TIME_TOLERANCE_MS
	) {
		return false;
	}
	const beat = Date.parse(info.heartbeatAt ?? info.startedAt);
	if (!Number.isFinite(beat)) return false;
	return Date.now() - beat <= CUE_ENGINE_LOCK_STALE_MS;
}

function parseLock(raw: string): CueEngineLockInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const info = parsed as Partial<CueEngineLockInfo> | null;
	if (!info || typeof info.pid !== 'number' || typeof info.mode !== 'string') return null;
	return {
		pid: info.pid,
		mode: info.mode as CueEngineRunnerMode,
		startedAt: typeof info.startedAt === 'string' ? info.startedAt : new Date(0).toISOString(),
		heartbeatAt: typeof info.heartbeatAt === 'string' ? info.heartbeatAt : undefined,
		bootTime: typeof info.bootTime === 'number' ? info.bootTime : undefined,
		host: typeof info.host === 'string' ? info.host : undefined,
	};
}

/** The lock file's contents, live or not. `null` when missing or corrupt. */
function readRawLock(dataDir?: string): CueEngineLockInfo | null {
	try {
		return parseLock(fs.readFileSync(lockFilePath(dataDir), 'utf-8'));
	} catch {
		return null;
	}
}

/** Read the current lock, if any. Returns `null` for a missing, corrupt, or stale lock - a stale lock is reported as absent rather than thrown, since the caller's next step is always "so can I start?". */
export function readCueEngineLock(dataDir?: string): CueEngineLockInfo | null {
	const info = readRawLock(dataDir);
	return info && isLockLive(info) ? info : null;
}

export type CueEngineLockResult =
	| { acquired: true }
	| { acquired: false; heldBy: CueEngineLockInfo };

function buildLockInfo(mode: CueEngineRunnerMode, startedAt?: string): CueEngineLockInfo {
	const now = new Date().toISOString();
	return {
		pid: process.pid,
		mode,
		startedAt: startedAt ?? now,
		heartbeatAt: now,
		bootTime: currentBootTime(),
		host: safeHostname(),
	};
}

/**
 * Attempt to acquire the lock for this process. Fails (without throwing) when
 * a live engine already holds it - the caller decides what to do with that
 * (refuse to start, in every caller today). Safe to call when this exact
 * process already holds a live lock (re-acquire is a no-op success).
 *
 * Creation is atomic (`wx`), so two engines starting at the same instant
 * cannot both see "no lock" and both write one. A stale lock is removed and
 * creation retried; whoever loses the `wx` race re-reads and sees the winner.
 */
export function acquireCueEngineLock(
	mode: CueEngineRunnerMode,
	dataDir?: string
): CueEngineLockResult {
	const filePath = lockFilePath(dataDir);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	for (let attempt = 0; attempt < 3; attempt++) {
		const existing = readRawLock(dataDir);
		if (existing && isLockLive(existing)) {
			if (existing.pid !== process.pid) return { acquired: false, heldBy: existing };
			fs.writeFileSync(filePath, JSON.stringify(buildLockInfo(mode), null, 2), 'utf-8');
			return { acquired: true };
		}
		if (fs.existsSync(filePath)) {
			// Stale or corrupt. A concurrent starter may remove it first; the
			// `wx` create below is what decides who wins.
			try {
				fs.unlinkSync(filePath);
			} catch {
				// Already removed.
			}
		}
		try {
			fs.writeFileSync(filePath, JSON.stringify(buildLockInfo(mode), null, 2), {
				encoding: 'utf-8',
				flag: 'wx',
			});
			return { acquired: true };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			// Created by someone else between our read and write - loop and re-read.
		}
	}
	const holder = readRawLock(dataDir);
	return { acquired: false, heldBy: holder ?? buildLockInfo(mode) };
}

export type CueEngineLockTouchResult = 'held' | 'lost';

/**
 * Refresh this process's heartbeat on the lock. Reports `'lost'` when another
 * live engine now owns it - possible when this process was suspended long
 * enough for its lock to go stale and be taken over - so the caller stops
 * dispatching rather than double-firing beside the new owner. A missing lock
 * (deleted by hand) is simply rewritten.
 */
export function touchCueEngineLock(
	mode: CueEngineRunnerMode,
	dataDir?: string
): CueEngineLockTouchResult {
	const existing = readRawLock(dataDir);
	if (existing && existing.pid !== process.pid && isLockLive(existing)) return 'lost';
	const startedAt = existing?.pid === process.pid ? existing.startedAt : undefined;
	try {
		fs.writeFileSync(
			lockFilePath(dataDir),
			JSON.stringify(buildLockInfo(mode, startedAt), null, 2),
			'utf-8'
		);
	} catch {
		// A failed write only ages the heartbeat; the next beat retries.
	}
	return 'held';
}

/** Best-effort hostname for the lock's human-readable hint. Never throws. */
function safeHostname(): string | undefined {
	try {
		return os.hostname();
	} catch {
		return undefined;
	}
}

/**
 * Release the lock, but ONLY if this process still holds it. A caller whose
 * lock was taken over must not delete a lock it no longer owns.
 */
export function releaseCueEngineLock(dataDir?: string): void {
	const existing = readRawLock(dataDir);
	if (existing && existing.pid !== process.pid && isLockLive(existing)) return;
	try {
		fs.unlinkSync(lockFilePath(dataDir));
	} catch {
		// Already gone, or never existed - releasing an absent lock is a no-op.
	}
}
