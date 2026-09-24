/**
 * Process identity that survives PID reuse.
 *
 * Several files are shared between the desktop app and `maestro-cli` and name
 * the process that owns them by pid (the CLI discovery file, the CLI activity
 * file, the Cue engine lease, the short-lived file locks). A bare
 * `process.kill(pid, 0)` only proves that SOME process has that pid right now.
 * Once the owner crashes without cleaning up, the OS hands the number to an
 * unrelated process and the stale record reads as alive forever: an agent stays
 * "busy with CLI", or a lock is never reclaimed.
 *
 * The fix is to record a second value that is fixed for the life of a process
 * and differs between two processes that share a pid: its start time. Readers
 * compare the recorded token against the live process's token; a mismatch
 * proves the pid was recycled.
 *
 * - Linux: field 22 of `/proc/<pid>/stat` (start time in clock ticks since
 *   boot). A plain file read, cheap enough for hot paths.
 * - macOS: `ps -o lstart=` with `TZ=UTC` and `LC_ALL=C`, so the string does not
 *   change when the user's timezone or locale does. One short spawn, cached
 *   briefly per pid.
 * - Windows: no cheap source exists (only PowerShell/WMI, far too slow for a
 *   liveness probe), so the token is absent and verification falls back to
 *   pid existence. Callers that need more on Windows pair this with a lease
 *   (see `cue-engine-lock.ts`).
 *
 * A record written without a token (older builds, Windows) is verified by pid
 * existence alone, exactly as before, so nothing already on disk changes
 * meaning.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';

/** A pid plus the start-time token that pins it to one specific process. */
export interface ProcessIdentity {
	pid: number;
	/** Opaque, platform-specific start-time token. Absent when unavailable. */
	startToken?: string;
}

/**
 * What a liveness probe could establish about a recorded process.
 *
 * - `alive`: the pid exists and (when a token was recorded and readable) it is
 *   the same process.
 * - `dead`: proven gone - ESRCH, or the pid now belongs to a different process.
 *   The only verdict that may be used to erase or reclaim a record.
 * - `unknown`: the probe failed for an unexplained reason. Callers must not
 *   mutate shared state on this verdict.
 */
export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

/** How long a foreign pid's token is reused before it is read again. */
const FOREIGN_TOKEN_CACHE_MS = 2_000;

const foreignTokenCache = new Map<number, { token: string | null; readAt: number }>();
let ownToken: string | null | undefined;

function readLinuxStartToken(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
		// The command name (field 2) is parenthesized and may itself contain
		// spaces or parens, so split only after the LAST ')'. What follows starts
		// at field 3 (state); start time is field 22, i.e. index 19 here.
		const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const startTime = afterComm[19];
		return startTime && /^\d+$/.test(startTime) ? startTime : null;
	} catch {
		return null;
	}
}

function readDarwinStartToken(pid: number): string | null {
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf-8',
			timeout: 1_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
		}).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

/**
 * Read the start-time token for `pid`, or `null` when this platform has no
 * cheap source or the process could not be inspected.
 */
export function readProcessStartToken(pid: number): string | null {
	if (!isValidPid(pid)) return null;
	if (process.platform === 'linux') return readLinuxStartToken(pid);
	if (process.platform === 'darwin') return readDarwinStartToken(pid);
	return null;
}

function cachedForeignToken(pid: number): string | null {
	const now = Date.now();
	const cached = foreignTokenCache.get(pid);
	if (cached && now - cached.readAt < FOREIGN_TOKEN_CACHE_MS) return cached.token;
	const token = readProcessStartToken(pid);
	foreignTokenCache.set(pid, { token, readAt: now });
	return token;
}

function isValidPid(pid: unknown): pid is number {
	// kill(0) and kill(-n) address process GROUPS, and always succeed for the
	// caller's own group, so a zero or negative pid in a record must never be
	// probed: it would read as alive forever.
	return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/** The identity of the calling process, computed once. */
export function currentProcessIdentity(): ProcessIdentity {
	if (ownToken === undefined) ownToken = readProcessStartToken(process.pid);
	return ownToken === null ? { pid: process.pid } : { pid: process.pid, startToken: ownToken };
}

/** Whether `identity` names the calling process. */
export function isCurrentProcess(identity: ProcessIdentity): boolean {
	if (identity.pid !== process.pid) return false;
	const own = currentProcessIdentity().startToken;
	return identity.startToken === undefined || own === undefined || identity.startToken === own;
}

/**
 * Probe whether the process a record names is still running.
 *
 * `process.kill(pid, 0)` sends no signal; it only reports whether the caller
 * could. EPERM means the pid EXISTS but belongs to another user or sits outside
 * this caller's signal permission (the normal answer for a sandboxed read-only
 * monitor), so it counts as existing. ESRCH is the only code that proves the
 * process is gone. Anything else is `unknown`.
 */
export function probeProcess(identity: ProcessIdentity): ProcessLiveness {
	if (!isValidPid(identity.pid)) return 'dead';
	if (isCurrentProcess(identity)) return 'alive';
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ESRCH') return 'dead';
		if (code !== 'EPERM') return 'unknown';
	}
	if (identity.startToken === undefined) return 'alive';
	const liveToken = cachedForeignToken(identity.pid);
	// A token we cannot read (process exited between the two probes, or ps is
	// unavailable) cannot disprove identity, so fall back to the pid verdict.
	if (liveToken === null) return 'alive';
	return liveToken === identity.startToken ? 'alive' : 'dead';
}

/** Test hook: forget cached tokens so a test can change what the probes see. */
export function resetProcessIdentityCacheForTests(): void {
	foreignTokenCache.clear();
	ownToken = undefined;
}
