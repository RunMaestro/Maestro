/**
 * Cross-process lock preventing two Cue engine loops (the desktop app and a
 * standalone `maestro-cli cue engine` runner, or two standalone runners) from
 * dispatching the SAME subscriptions at once.
 *
 * Both runners read the SAME on-disk state for a given data directory -
 * `.maestro/cue.yaml` per project, and one shared `cue.db` (see
 * `resolveUserDataDir()` in `src/shared/userDataDir.ts`). Without coordination, a
 * user who leaves the desktop app open AND starts the standalone engine (for
 * unattended operation when the desktop app is closed) would get every
 * trigger firing TWICE - two agent processes spawned per `time.heartbeat`
 * tick, a GitHub PR poller finding and dispatching the same PR from two
 * independent poll loops, etc. `CueRunManager`'s `max_concurrent` guard and
 * `activeRootKeys` self-overlap check (see CLAUDE-CUE.md) only serialize runs
 * WITHIN one engine instance; they have no visibility into a second process.
 *
 * This is deliberately a SINGLE global lock per data directory, not a
 * per-project one: `cue.db` is one shared database (see `initCueDb()`),
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

import { resolveUserDataDir } from '../../shared/userDataDir';
import {
	CUE_ENGINE_LOCK_SPEC,
	createProcessLock,
	type ProcessLock,
	type ProcessLockDeps,
} from '../../shared/maestro-lib/runtime/lock';

export type CueEngineRunnerMode = 'desktop' | 'standalone';

/** How often the owning engine refreshes the lock's heartbeat. */
export const CUE_ENGINE_LOCK_HEARTBEAT_MS = CUE_ENGINE_LOCK_SPEC.heartbeatMs;
/** A lock whose heartbeat is older than this is stale even if its PID is alive (six missed beats). */
export const CUE_ENGINE_LOCK_STALE_MS = CUE_ENGINE_LOCK_SPEC.staleMs;

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

/**
 * Whether the process named in a lock is still alive. `process.kill(pid, 0)`
 * sends no signal - it only tests for permission/existence - and Node
 * documents this as working the same way on Windows and POSIX. Any error counts
 * as "not alive", so this lock's behavior is unchanged by the shared primitive.
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

/** Built per call: `MAESTRO_USER_DATA` and the clock are read when the call is made, not when the module loads. */
function engineLock(dataDir: string = resolveUserDataDir()): ProcessLock<CueEngineRunnerMode> {
	const deps: Partial<ProcessLockDeps> = { pid: process.pid, isPidAlive: isProcessAlive };
	return createProcessLock<CueEngineRunnerMode>(dataDir, CUE_ENGINE_LOCK_SPEC, deps);
}

/** Read the current lock, if any. Returns `null` for a missing, corrupt, or stale lock - a stale lock is reported as absent rather than thrown, since the caller's next step is always "so can I start?". */
export function readCueEngineLock(dataDir?: string): CueEngineLockInfo | null {
	return engineLock(dataDir).holder();
}

export type CueEngineLockResult =
	| { acquired: true }
	| { acquired: false; heldBy: CueEngineLockInfo };

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
	return engineLock(dataDir).acquire(mode);
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
	return engineLock(dataDir).touch(mode);
}

/**
 * Release the lock, but ONLY if this process still holds it. A caller whose
 * lock was taken over must not delete a lock it no longer owns.
 */
export function releaseCueEngineLock(dataDir?: string): void {
	engineLock(dataDir).release();
}
