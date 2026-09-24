/**
 * Cross-process lock preventing two Cue engine loops (the desktop app and a
 * standalone `maestro-cli cue-engine` runner, or two standalone runners) from
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
 * The lock is advisory (a JSON file + PID liveness check), not an OS-level
 * file lock - `fs.flock` has no cross-platform equivalent in plain Node, and
 * an advisory lock is sufficient here because both callers (the desktop main
 * process and the standalone CLI command) are Maestro's own code and check it
 * cooperatively before starting the engine. It is NOT a substitute for a
 * real mutex against an adversarial writer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveUserDataDir } from '../../shared/userDataDir';

export type CueEngineRunnerMode = 'desktop' | 'standalone';

export interface CueEngineLockInfo {
	pid: number;
	mode: CueEngineRunnerMode;
	/** ISO timestamp the lock was acquired. */
	startedAt: string;
	/** Free-text hint for a human reading the lock file directly (hostname, etc). Best-effort, not load-bearing. */
	host?: string;
}

function lockFilePath(dataDir: string = resolveUserDataDir()): string {
	return path.join(dataDir, 'cue-engine.lock');
}

/**
 * Whether the process named in a lock is still alive. `process.kill(pid, 0)`
 * sends no signal - it only tests for permission/existence - and Node
 * documents this as working the same way on Windows and POSIX, so this needs
 * no platform branch. Any PID this process cannot see (already exited, or a
 * PID number later reused by an unrelated process that happens to still be
 * running - an inherent, small race in any PID-based lock) is treated as
 * dead/stale, which is the safe direction: a false "stale" lets a new engine
 * start and immediately re-acquire; a false "alive" would block a legitimate
 * restart forever.
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

/** Read the current lock, if any. Returns `null` for a missing, corrupt, or stale (dead-PID) lock - a stale lock is reported as absent rather than thrown, since the caller's next step is always "so can I start?". */
export function readCueEngineLock(dataDir?: string): CueEngineLockInfo | null {
	const filePath = lockFilePath(dataDir);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const info = parsed as Partial<CueEngineLockInfo> | null;
	if (!info || typeof info.pid !== 'number' || typeof info.mode !== 'string') return null;
	if (!isProcessAlive(info.pid)) return null;
	return {
		pid: info.pid,
		mode: info.mode as CueEngineRunnerMode,
		startedAt: typeof info.startedAt === 'string' ? info.startedAt : new Date(0).toISOString(),
		host: typeof info.host === 'string' ? info.host : undefined,
	};
}

export type CueEngineLockResult =
	| { acquired: true }
	| { acquired: false; heldBy: CueEngineLockInfo };

/**
 * Attempt to acquire the lock for this process. Fails (without throwing) when
 * a live engine already holds it - the caller decides what to do with that
 * (refuse to start, in every caller today). Safe to call when this exact
 * process already holds a live lock (re-acquire is a no-op success), so a
 * caller does not need to track whether it already has the lock.
 */
export function acquireCueEngineLock(
	mode: CueEngineRunnerMode,
	dataDir?: string
): CueEngineLockResult {
	const existing = readCueEngineLock(dataDir);
	if (existing && existing.pid !== process.pid) {
		return { acquired: false, heldBy: existing };
	}

	const info: CueEngineLockInfo = {
		pid: process.pid,
		mode,
		startedAt: new Date().toISOString(),
		host: safeHostname(),
	};
	const filePath = lockFilePath(dataDir);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	// Synchronous, not the atomic-write-via-rename pattern used elsewhere
	// (`atomic-json-store.ts`): acquisition happens once, at startup, before
	// the engine begins dispatching, so there is no concurrent reader/writer
	// hot path to protect against here, and a synchronous call means the
	// caller's very next line can safely assume the lock is durable on disk.
	fs.writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8');
	return { acquired: true };
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
 * lock was already stolen (should not happen in practice - see the module
 * doc - but a stale PID could theoretically be reused by another Maestro
 * process between a read and a release) must not delete a lock it no longer
 * owns.
 */
export function releaseCueEngineLock(dataDir?: string): void {
	const filePath = lockFilePath(dataDir);
	const existing = readCueEngineLock(dataDir);
	if (existing && existing.pid !== process.pid) return;
	try {
		fs.unlinkSync(filePath);
	} catch {
		// Already gone, or never existed - releasing an absent lock is a no-op.
	}
}
