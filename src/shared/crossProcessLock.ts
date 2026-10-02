/**
 * Cross-process file primitives for small JSON files that the desktop app and
 * `maestro-cli` both write (CLI discovery, CLI activity, the Cue engine lease).
 *
 * Two failure modes, two helpers:
 *
 * 1. Torn files. `fs.writeFileSync` truncates then writes, so a reader landing
 *    mid-write sees a partial document. For the activity file that is worse
 *    than a failed read: the reader's fallback is "no activities", and the
 *    reader's next write then persists that empty list, erasing every other
 *    process's entry. {@link atomicWriteFileSync} writes a UNIQUE sibling temp
 *    file and renames it over the target, so readers only ever see a whole old
 *    or whole new file. The temp name carries pid + a counter: a shared `.tmp`
 *    name would let two writers interleave inside the same temp file.
 *
 * 2. Lost updates. Two read-modify-write cycles that read the same base each
 *    drop the other's change. {@link withFileLockSync} serializes them with an
 *    `O_CREAT | O_EXCL` lock file (`'wx'`), with exponential backoff and full
 *    jitter so processes that collide at startup do not retry in lockstep.
 *
 * Everything here is synchronous on purpose: the callers are synchronous
 * (`registerCliActivity`, the quit path, `process.kill`-based probes) and the
 * critical sections are a few milliseconds of JSON.
 *
 * Main-process code that writes Maestro's OWN stores should keep using
 * `src/main/utils/atomic-json-store.ts` / `src/main/stores/deferred-writes.ts`;
 * this module exists for files shared across process boundaries, and lives in
 * `shared/` because the CLI cannot import main-process modules that pull in
 * Electron.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { probeProcess, currentProcessIdentity, type ProcessIdentity } from './processIdentity';

let tempSequence = 0;

/** Block the thread for `ms` without spinning. */
export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Delay before retry `attempt` (0-based): exponential with full jitter,
 * `random(0, min(cap, base * 2^attempt))`, floored at 1ms so a retry never
 * degenerates into a hot loop.
 */
export function backoffDelayMs(
	attempt: number,
	baseMs: number,
	capMs: number,
	random: () => number = Math.random
): number {
	const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
	return Math.max(1, Math.floor(random() * ceiling));
}

/** Errors a rename can hit transiently on Windows (AV scanners, open readers). */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 4;

function uniqueTempPath(filePath: string): string {
	return `${filePath}.${process.pid}.${++tempSequence}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/**
 * Replace `filePath` with `contents` atomically: write a unique temp sibling,
 * then rename over the target. Creates the parent directory if needed.
 * `mode` applies to the new file (e.g. `0o600` for a file holding a token).
 */
export function atomicWriteFileSync(
	filePath: string,
	contents: string,
	options: { mode?: number } = {}
): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = uniqueTempPath(filePath);
	try {
		fs.writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options.mode });
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(tmpPath, filePath);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRIES) throw err;
				sleepSync(backoffDelayMs(attempt, 10, 100));
			}
		}
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// The target is untouched; a leftover temp file is harmless.
		}
		throw err;
	}
}

/** Contents of a lock file: who holds it, and since when. */
export interface LockHolder extends ProcessIdentity {
	/** Random per-acquisition id, so release never deletes a lock it lost. */
	instanceId: string;
	acquiredAt: number;
}

export interface FileLockOptions {
	/** Give up after this long. Default 2000ms. */
	timeoutMs?: number;
	/**
	 * A lock older than this is reclaimed even when its holder cannot be proven
	 * dead. The sections these locks guard take milliseconds, so a lock this old
	 * belongs to a frozen or recycled-pid holder. Default 10000ms.
	 */
	staleMs?: number;
}

/** Thrown when {@link withFileLockSync} cannot acquire within `timeoutMs`. */
export class FileLockTimeoutError extends Error {
	constructor(
		readonly lockPath: string,
		readonly holder: LockHolder | null
	) {
		super(
			`Timed out acquiring ${lockPath}` +
				(holder
					? ` (held by pid ${holder.pid} since ${new Date(holder.acquiredAt).toISOString()})`
					: '')
		);
		this.name = 'FileLockTimeoutError';
	}
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const LOCK_BACKOFF_BASE_MS = 2;
const LOCK_BACKOFF_CAP_MS = 50;

/** Parse a lock file's holder record, or `null` if absent/unreadable/partial. */
export function readLockHolder(lockPath: string): LockHolder | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockHolder>;
		if (
			typeof parsed.pid === 'number' &&
			typeof parsed.instanceId === 'string' &&
			typeof parsed.acquiredAt === 'number'
		) {
			return parsed as LockHolder;
		}
		return null;
	} catch {
		return null;
	}
}

function fileAgeMs(filePath: string, now: number): number | null {
	try {
		return now - fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}

/** Inode of `filePath`, or `null` when it cannot be stat-ed. */
function statIno(filePath: string): number | null {
	try {
		return fs.statSync(filePath).ino;
	} catch {
		return null;
	}
}

/**
 * Remove a lock we judged stale WITHOUT clobbering a fresh one that replaced it
 * after we looked. A plain unlink has an ABA race: A and B both judge the same
 * lock stale, B unlinks and acquires, then A unlinks B's live lock. Instead we
 * rename the lock aside (atomic) and check what we actually moved; if it is not
 * the one we judged, we put it back with `link`, which fails rather than
 * overwrite a lock someone created in the meantime.
 *
 * `judged` is the holder we read, or `null` when the file was unparseable.
 *
 * An unparseable file has no instanceId to match on, and "still unparseable"
 * is not enough: a peer between its own `openSync('wx')` and `writeSync` is
 * unparseable too, so an abandoned half-written lock and a peer's brand-new one
 * look identical. `judgedIno` is the inode from the stat taken when the caller
 * judged it; a different inode means we moved a DIFFERENT file and must put it
 * back. Callers that judged an unparseable lock should always pass it.
 */
export function reclaimStaleLock(
	lockPath: string,
	judged: LockHolder | null,
	judgedIno?: number
): boolean {
	const asidePath = uniqueTempPath(`${lockPath}.stale`);
	try {
		fs.renameSync(lockPath, asidePath);
	} catch {
		return false; // Already gone (someone else reclaimed or released it).
	}
	const moved = readLockHolder(asidePath);
	const sameLock =
		judged === null
			? moved === null && (judgedIno === undefined || statIno(asidePath) === judgedIno)
			: moved?.instanceId === judged.instanceId;
	if (!sameLock) {
		try {
			fs.linkSync(asidePath, lockPath);
		} catch {
			// A third process acquired in the gap; its lock stands and the one we
			// moved is lost. That holder will still release by instanceId.
		}
	}
	try {
		fs.unlinkSync(asidePath);
	} catch {
		// ignore
	}
	return sameLock;
}

function isLockStale(lockPath: string, holder: LockHolder | null, staleMs: number): boolean {
	const now = Date.now();
	if (holder === null) {
		// Created but not yet written (the holder is between open and write), or
		// genuinely corrupt. Only its age can tell those apart.
		const age = fileAgeMs(lockPath, now);
		return age !== null && age > staleMs;
	}
	if (probeProcess(holder) === 'dead') return true;
	return now - holder.acquiredAt > staleMs;
}

function tryCreateLock(lockPath: string, holder: LockHolder): boolean {
	let fd: number;
	try {
		fd = fs.openSync(lockPath, 'wx');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw err;
	}
	try {
		fs.writeSync(fd, JSON.stringify(holder));
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

function releaseLock(lockPath: string, instanceId: string): void {
	// Only delete the lock if it is still ours: if a peer judged us stale and
	// reclaimed it, the file now belongs to that peer.
	if (readLockHolder(lockPath)?.instanceId !== instanceId) return;
	try {
		fs.unlinkSync(lockPath);
	} catch {
		// ignore - already gone
	}
}

/**
 * Run `fn` while holding an exclusive cross-process lock at `lockPath`.
 *
 * The lock is reclaimed from a holder that is proven dead (ESRCH or a recycled
 * pid) or that has held it longer than `staleMs`. Throws
 * {@link FileLockTimeoutError} if the lock cannot be taken within `timeoutMs`;
 * callers decide whether to degrade (write unlocked, which is still torn-proof
 * thanks to the atomic rename) or fail.
 *
 * Not re-entrant: calling it again for the same path from inside `fn` waits
 * for itself until the timeout.
 */
export function withFileLockSync<T>(
	lockPath: string,
	fn: () => T,
	options: FileLockOptions = {}
): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const holder: LockHolder = {
		...currentProcessIdentity(),
		instanceId: crypto.randomUUID(),
		acquiredAt: Date.now(),
	};
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	const deadline = Date.now() + timeoutMs;
	let lastHolder: LockHolder | null = null;
	for (let attempt = 0; ; attempt++) {
		holder.acquiredAt = Date.now();
		if (tryCreateLock(lockPath, holder)) break;

		lastHolder = readLockHolder(lockPath);
		// Pin WHICH file we judged, so an unparseable lock cannot be confused with
		// a peer's brand-new one created in the gap before the rename.
		const judgedIno = lastHolder === null ? (statIno(lockPath) ?? undefined) : undefined;
		const reclaimed =
			isLockStale(lockPath, lastHolder, staleMs) &&
			reclaimStaleLock(lockPath, lastHolder, judgedIno);
		if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, lastHolder);
		// After a reclaim the path is free, so retry without waiting.
		if (!reclaimed) {
			const delay = backoffDelayMs(attempt, LOCK_BACKOFF_BASE_MS, LOCK_BACKOFF_CAP_MS);
			sleepSync(Math.min(delay, deadline - Date.now()));
		}
	}

	try {
		return fn();
	} finally {
		releaseLock(lockPath, holder.instanceId);
	}
}
