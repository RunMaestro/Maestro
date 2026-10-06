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
 *
 * Ownership is a per-process random TOKEN, not the PID. Two containers that
 * share a data directory both run their engine as PID 1 under tini, so a PID
 * comparison would let each one believe the other's lock is its own. The
 * token is minted once per process and never leaves it except through the
 * lock file, so "the token matches" is the only proof that THIS process wrote
 * the lock. PID liveness still matters for a lock in our own PID namespace,
 * but a PID from a different namespace (another container) means nothing to
 * `kill(pid, 0)` here, so such a lock is judged by its heartbeat alone. On
 * Linux the lock records the PID namespace inode to tell the two apart.
 *
 * Taking over a stale lock must be atomic, not just creating one. The naive
 * "unlink the stale file, then create with `wx`" lets two engines that both
 * read the same stale lock each remove what the other just created, so both
 * believe they hold it (the crash-then-restart case for two containers on one
 * volume). Re-reading after the create does not fix that: the first engine can
 * see its own token before the second one's unlink lands. So the module keeps
 * one rule:
 *
 * - Creating a lock where none exists is one atomic step: the content goes to
 *   a per-process temp file that is then hard-linked into place (`link` fails
 *   with `EEXIST` when a lock is already there).
 * - Every other change to an EXISTING lock (a stale takeover, the owner's
 *   heartbeat or re-acquire rewrite, a release) happens only while holding the
 *   CLAIM for that lock's exact generation. The generation is a hash of the
 *   file's bytes; the claim is an atomic `mkdir` of
 *   `cue-engine.lock.claim-<generation>.<level>`. Under the claim the holder
 *   re-reads the file and proceeds only if the bytes are still the ones it
 *   judged. Two processes can only hold claims on two different generations,
 *   and the file can only be one of them, so judging, removing and replacing a
 *   lock is serialized.
 *
 * The lock file is never written in place, so a reader cannot catch a half
 * written lock and judge it "corrupt, therefore stale": creation uses the
 * link above and a rewrite goes to the temp file and is renamed over the lock.
 * Where the filesystem refuses hard links, creation falls back to `wx`.
 *
 * On Windows a rename, link, remove or `mkdir` can be refused for a moment
 * because another process has the path open (a racing engine reading the
 * lock, a pending delete, an antivirus scan). Those refusals are treated as
 * "busy": back off and retry, never throw and never report the lock as taken.
 * The same error codes off Windows keep their usual, permanent meaning.
 *
 * A claim is held for a few filesystem calls. If its holder is killed inside
 * that window the directory is left behind; once it is older than
 * {@link CUE_ENGINE_LOCK_HEARTBEAT_MS} the next process claims the next LEVEL
 * of the same generation instead of removing it, because removing a stale
 * mutex is exactly the race this exists to prevent, while only one process
 * can win each `mkdir`. A process suspended inside its claim for longer than
 * that is the same suspended-owner case the heartbeat already covers: it learns
 * it lost the lock at its next `touchCueEngineLock`.
 *
 * All of this relies on `mkdir`, `link` and `rename` being atomic, which holds
 * on local filesystems, including one volume shared between containers on the
 * same host. Network filesystems (NFS, SMB) are out of scope.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { resolveUserDataDir } from '../../shared/userDataDir';
import { isWindows } from '../../shared/platformDetection';

export type CueEngineRunnerMode = 'desktop' | 'standalone';

/** How often the owning engine refreshes the lock's heartbeat. */
export const CUE_ENGINE_LOCK_HEARTBEAT_MS = 30_000;
/** A lock whose heartbeat is older than this is stale even if its PID is alive (six missed beats). */
export const CUE_ENGINE_LOCK_STALE_MS = 180_000;
/** Two boot-time readings closer than this are the same boot: `os.uptime()` is coarse and drifts slightly. */
const BOOT_TIME_TOLERANCE_MS = 60_000;
/** A claim directory older than this belongs to a holder that died inside it (see the module doc). */
const CLAIM_STALE_MS = CUE_ENGINE_LOCK_HEARTBEAT_MS;
/** How many orphaned claims on one generation can be stepped past before giving up. */
const MAX_CLAIM_LEVELS = 4;
/** Pause before re-reading when another process holds the claim we need. */
const CLAIM_BUSY_BACKOFF_MS = 25;
/** Read-judge-act rounds before an acquire or touch settles on what it last saw. */
const MAX_LOCK_ATTEMPTS = 6;
/** `link` errors meaning the filesystem cannot hard-link, as opposed to "a lock is already there". */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP']);
/** Codes Windows reports while another process has the file or directory open (see {@link isTransientSharingError}). */
const WINDOWS_SHARING_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Identity of THIS process as a lock owner. Minted once; never derived from the PID (see the module doc). */
const processToken = crypto.randomUUID();

/**
 * Inode of this process's PID namespace, or `undefined` off Linux or when
 * `/proc` cannot be read. Two processes see the same inode exactly when they
 * share a PID namespace, i.e. when a PID one of them names means the same
 * process to the other.
 */
const currentPidNsInode: number | undefined = readPidNsInode();

function readPidNsInode(): number | undefined {
	if (process.platform !== 'linux') return undefined;
	try {
		return fs.statSync('/proc/self/ns/pid').ino;
	} catch {
		return undefined;
	}
}

export interface CueEngineLockInfo {
	pid: number;
	/** Random per-process owner identity. Absent on lock files written before tokens existed. */
	token?: string;
	/** PID namespace inode of the owner (Linux only). Absent elsewhere and on older lock files. */
	pidNsInode?: number;
	mode: CueEngineRunnerMode;
	/** ISO timestamp the lock was acquired. */
	startedAt: string;
	/** ISO timestamp of the owner's last heartbeat. Older lock files lack it; `startedAt` stands in. */
	heartbeatAt?: string;
	/** Epoch ms the system booted, as seen by the owner. Absent on older lock files. */
	bootTime?: number;
	/** Free-text hint for a human reading the lock file directly (hostname, etc). Best-effort, not load-bearing. */
	host?: string;
	/**
	 * Loopback port of the owner's status server (`--status-port`), so
	 * `cue engine status` can say where to ask. Absent when the owner runs none.
	 */
	statusPort?: number;
}

function lockFilePath(dataDir: string = resolveUserDataDir()): string {
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
 * Whether the lock was written from a different PID namespace than ours, so
 * its PID cannot be tested or signaled from here. A lock that does not record
 * a namespace (older files, non-Linux owners) is treated as same-namespace,
 * which is the rule every lock followed before namespaces were recorded.
 */
export function isCueEngineLockInForeignPidNamespace(info: CueEngineLockInfo): boolean {
	return info.pidNsInode !== undefined && info.pidNsInode !== currentPidNsInode;
}

/**
 * Whether THIS process wrote the lock. A tokened lock is ours exactly when the
 * token matches. A lock from before tokens existed keeps the old rule: ours
 * only if the PID matches and it is not from a foreign PID namespace.
 */
export function isCueEngineLockOwnedByThisProcess(info: CueEngineLockInfo): boolean {
	if (info.token !== undefined) return info.token === processToken;
	return info.pid === process.pid && !isCueEngineLockInForeignPidNamespace(info);
}

function isHeartbeatFresh(info: CueEngineLockInfo): boolean {
	const beat = Date.parse(info.heartbeatAt ?? info.startedAt);
	if (!Number.isFinite(beat)) return false;
	return Date.now() - beat <= CUE_ENGINE_LOCK_STALE_MS;
}

/**
 * Whether a lock still belongs to a running engine: its PID is alive, it was
 * written during THIS boot, and its heartbeat is recent. The last two are what
 * catch a reused PID (see the module doc).
 *
 * A lock from a foreign PID namespace skips the PID and boot-time checks:
 * `kill(pid, 0)` would probe an unrelated process in OUR namespace, and the
 * owner may sit on another host whose boot time says nothing about this one.
 * Its heartbeat is the only evidence available, so it is live while fresh.
 */
function isLockLive(info: CueEngineLockInfo): boolean {
	if (isCueEngineLockInForeignPidNamespace(info)) return isHeartbeatFresh(info);
	if (!isProcessAlive(info.pid)) return false;
	if (
		typeof info.bootTime === 'number' &&
		Math.abs(info.bootTime - currentBootTime()) > BOOT_TIME_TOLERANCE_MS
	) {
		return false;
	}
	return isHeartbeatFresh(info);
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
		token: typeof info.token === 'string' ? info.token : undefined,
		pidNsInode: typeof info.pidNsInode === 'number' ? info.pidNsInode : undefined,
		mode: info.mode as CueEngineRunnerMode,
		startedAt: typeof info.startedAt === 'string' ? info.startedAt : new Date(0).toISOString(),
		heartbeatAt: typeof info.heartbeatAt === 'string' ? info.heartbeatAt : undefined,
		bootTime: typeof info.bootTime === 'number' ? info.bootTime : undefined,
		host: typeof info.host === 'string' ? info.host : undefined,
		statusPort: typeof info.statusPort === 'number' ? info.statusPort : undefined,
	};
}

/** One read of the lock file: its generation (hash of the bytes) and, when it parses, its contents. */
interface LockSnapshot {
	generation: string;
	info: CueEngineLockInfo | null;
}

/** The lock file as it is on disk, live or not. `null` when it cannot be read (normally: missing). */
function readLockSnapshot(dataDir?: string): LockSnapshot | null {
	let raw: string;
	try {
		raw = fs.readFileSync(lockFilePath(dataDir), 'utf-8');
	} catch {
		return null;
	}
	return {
		generation: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
		info: parseLock(raw),
	};
}

/** Read the current lock, if any. Returns `null` for a missing, corrupt, or stale lock - a stale lock is reported as absent rather than thrown, since the caller's next step is always "so can I start?". */
export function readCueEngineLock(dataDir?: string): CueEngineLockInfo | null {
	const info = readLockSnapshot(dataDir)?.info ?? null;
	return info && isLockLive(info) ? info : null;
}

/** Named points between reading, claiming and writing, for tests that force an interleaving. */
export type CueEngineLockTestHookPoint =
	| 'acquireAfterJudgedStale'
	| 'afterClaim'
	| 'touchAfterRead'
	| 'releaseAfterRead';

let testHook: ((point: CueEngineLockTestHookPoint) => void) | undefined;

/**
 * Test-only seam: run `hook` at each named point so a test can let another
 * process act in the middle of an acquire, touch or release. Pass `undefined`
 * to clear it. Never set outside tests.
 */
export function __setCueEngineLockTestHook(
	hook: ((point: CueEngineLockTestHookPoint) => void) | undefined
): void {
	testHook = hook;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Whether an fs error is Windows refusing the call because another process has
 * the path open right now: a racing engine or `cue engine status` reading the
 * lock (a rename cannot replace a file with an open handle), a just-removed
 * entry another handle still pins, or an antivirus scan of a file we just
 * wrote. These clear in milliseconds, so every caller treats them as "busy,
 * back off and retry" - never as a failure to throw and never as success.
 * Off Windows the same codes mean something permanent (a real permission
 * problem, a filesystem without hard links) and keep their old handling.
 */
function isTransientSharingError(err: unknown): boolean {
	return isWindows() && WINDOWS_SHARING_CODES.has(errorCode(err) ?? '');
}

function serializeLock(info: CueEngineLockInfo): string {
	return JSON.stringify(info, null, 2);
}

/** This process's scratch file; the lock's content is written here first so the lock itself is never partial. */
function tempFilePath(dataDir?: string): string {
	return `${lockFilePath(dataDir)}.tmp-${processToken}`;
}

function claimPrefix(generation: string, dataDir?: string): string {
	return `${lockFilePath(dataDir)}.claim-${generation}.`;
}

type CreateOutcome = 'created' | 'exists' | 'sharing';

/**
 * Create the lock only if none exists, with its full content in one step.
 * `'exists'` when a lock is already there; `'sharing'` when Windows refused
 * because another process has the path open (retry after a back-off).
 */
function createLockExclusive(info: CueEngineLockInfo, dataDir?: string): CreateOutcome {
	const target = lockFilePath(dataDir);
	const tmp = tempFilePath(dataDir);
	const body = serializeLock(info);
	try {
		fs.writeFileSync(tmp, body, 'utf-8');
		try {
			fs.linkSync(tmp, target);
			return 'created';
		} catch (err) {
			if (errorCode(err) === 'EEXIST') return 'exists';
			// Checked first: on Windows EPERM from `link` is a sharing refusal,
			// not a filesystem that cannot hard-link.
			if (isTransientSharingError(err)) return 'sharing';
			if (!LINK_UNSUPPORTED_CODES.has(errorCode(err) ?? '')) throw err;
			try {
				fs.writeFileSync(target, body, { encoding: 'utf-8', flag: 'wx' });
				return 'created';
			} catch (wxErr) {
				if (errorCode(wxErr) === 'EEXIST') return 'exists';
				throw wxErr;
			}
		}
	} catch (err) {
		if (isTransientSharingError(err)) return 'sharing';
		throw err;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Nothing to clean up.
		}
	}
}

/** Replace an existing lock's content atomically. Only called while holding its claim. */
function replaceLock(info: CueEngineLockInfo, dataDir?: string): void {
	const tmp = tempFilePath(dataDir);
	fs.writeFileSync(tmp, serializeLock(info), 'utf-8');
	try {
		fs.renameSync(tmp, lockFilePath(dataDir));
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Nothing to clean up.
		}
		throw err;
	}
}

/** Remove the lock file; already gone is fine. Only called while holding its claim. */
function removeLockFile(dataDir?: string): void {
	try {
		fs.unlinkSync(lockFilePath(dataDir));
	} catch (err) {
		if (errorCode(err) !== 'ENOENT') throw err;
	}
}

/**
 * Take the claim on one lock generation. Returns the claim directory, or
 * `null` when another live process holds it. An orphaned claim (older than
 * {@link CLAIM_STALE_MS}) is stepped past to the next level, never removed.
 */
function takeClaim(generation: string, dataDir?: string): string | null {
	const prefix = claimPrefix(generation, dataDir);
	for (let level = 0; level < MAX_CLAIM_LEVELS; level++) {
		const dir = `${prefix}${level}`;
		try {
			fs.mkdirSync(dir);
			return dir;
		} catch (err) {
			if (errorCode(err) !== 'EEXIST') throw err;
		}
		let age: number;
		try {
			age = Date.now() - fs.statSync(dir).mtimeMs;
		} catch {
			// Its holder just finished, which means the file has moved on.
			return null;
		}
		if (age <= CLAIM_STALE_MS) return null;
	}
	return null;
}

function dropClaim(dir: string): void {
	try {
		fs.rmdirSync(dir);
	} catch {
		// Already removed by a takeover that cleaned up this generation.
	}
}

type ClaimOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; reason: 'busy' | 'changed' | 'sharing' };

/**
 * Run `action` while holding the claim on `generation`, and only if the lock
 * file still has exactly that generation. `'busy'`: another process holds the
 * claim. `'changed'`: the file moved on since it was judged. `'sharing'`:
 * Windows refused a step because another process had the path open; nothing
 * was decided, so the caller backs off and retries.
 */
function withGenerationClaim<T>(
	generation: string,
	action: () => T,
	dataDir?: string
): ClaimOutcome<T> {
	let claim: string | null;
	try {
		claim = takeClaim(generation, dataDir);
	} catch (err) {
		if (isTransientSharingError(err)) return { ok: false, reason: 'sharing' };
		throw err;
	}
	if (!claim) return { ok: false, reason: 'busy' };
	try {
		testHook?.('afterClaim');
		if (readLockSnapshot(dataDir)?.generation !== generation) {
			return { ok: false, reason: 'changed' };
		}
		return { ok: true, value: action() };
	} catch (err) {
		if (isTransientSharingError(err)) return { ok: false, reason: 'sharing' };
		throw err;
	} finally {
		dropClaim(claim);
	}
}

/**
 * After a takeover the old generation can never come back, so every claim on
 * it (ours, and any orphan we stepped past) is dead. Also sweep scratch files
 * and claims that outlived {@link CUE_ENGINE_LOCK_STALE_MS}: their owners
 * crashed. Best effort; leftovers are harmless.
 */
function cleanUpAfterTakeover(oldGeneration: string, dataDir?: string): void {
	const lockPath = lockFilePath(dataDir);
	const dir = path.dirname(lockPath);
	const base = path.basename(lockPath);
	const oldPrefix = path.basename(claimPrefix(oldGeneration, dataDir));
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.startsWith(`${base}.`)) continue;
		const full = path.join(dir, name);
		try {
			if (name.startsWith(oldPrefix)) {
				fs.rmdirSync(full);
				continue;
			}
			const isClaim = name.startsWith(`${base}.claim-`);
			const isTemp = name.startsWith(`${base}.tmp-`);
			if (!isClaim && !isTemp) continue;
			if (Date.now() - fs.statSync(full).mtimeMs <= CUE_ENGINE_LOCK_STALE_MS) continue;
			if (isClaim) fs.rmdirSync(full);
			else fs.unlinkSync(full);
		} catch {
			// Removed concurrently, or not ours to judge.
		}
	}
}

export type CueEngineLockResult =
	| { acquired: true }
	| { acquired: false; heldBy: CueEngineLockInfo };

/** This process's status server port, stamped on every lock it writes. See {@link setCueEngineLockStatusPort}. */
let ownStatusPort: number | undefined;

/**
 * Record the status server port this process listens on, so every lock it
 * acquires or refreshes carries it. Set before the engine starts; `undefined`
 * clears it. Only the standalone runner sets it.
 */
export function setCueEngineLockStatusPort(port: number | undefined): void {
	ownStatusPort = port;
}

function buildLockInfo(mode: CueEngineRunnerMode, startedAt?: string): CueEngineLockInfo {
	const now = new Date().toISOString();
	return {
		pid: process.pid,
		token: processToken,
		...(currentPidNsInode !== undefined ? { pidNsInode: currentPidNsInode } : {}),
		mode,
		startedAt: startedAt ?? now,
		heartbeatAt: now,
		bootTime: currentBootTime(),
		host: safeHostname(),
		...(ownStatusPort !== undefined ? { statusPort: ownStatusPort } : {}),
	};
}

/**
 * Attempt to acquire the lock for this process. Fails (without throwing) when
 * a live engine already holds it - the caller decides what to do with that
 * (refuse to start, in every caller today). Safe to call when this exact
 * process already holds a live lock (re-acquire is a no-op success). "This
 * exact process" means the token matches, not the PID.
 *
 * With no lock on disk, creation is one atomic step, so two engines starting
 * at the same instant cannot both write one. A stale or corrupt lock is only
 * replaced while holding the claim on its generation (see the module doc), so
 * of N engines racing to take over the same stale lock exactly one succeeds;
 * the rest re-read and report the winner.
 */
export function acquireCueEngineLock(
	mode: CueEngineRunnerMode,
	dataDir?: string
): CueEngineLockResult {
	const dir = path.dirname(lockFilePath(dataDir));
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
		const current = readLockSnapshot(dataDir);
		if (!current) {
			const created = createLockExclusive(buildLockInfo(mode), dataDir);
			if (created === 'created') return { acquired: true };
			if (created === 'sharing') sleepSync(CLAIM_BUSY_BACKOFF_MS);
			// Otherwise created by someone else between our read and write - re-read.
			continue;
		}
		const info = current.info;
		if (info && isLockLive(info)) {
			if (!isCueEngineLockOwnedByThisProcess(info)) return { acquired: false, heldBy: info };
			const rewrite = withGenerationClaim(
				current.generation,
				() => replaceLock(buildLockInfo(mode), dataDir),
				dataDir
			);
			if (rewrite.ok) return { acquired: true };
			if (rewrite.reason !== 'changed') sleepSync(CLAIM_BUSY_BACKOFF_MS);
			continue;
		}
		// Stale or corrupt. Replace it only under its generation's claim.
		testHook?.('acquireAfterJudgedStale');
		const takeover = withGenerationClaim(
			current.generation,
			() => {
				removeLockFile(dataDir);
				return createLockExclusive(buildLockInfo(mode), dataDir);
			},
			dataDir
		);
		if (takeover.ok) {
			if (takeover.value === 'created') {
				cleanUpAfterTakeover(current.generation, dataDir);
				return { acquired: true };
			}
			// 'exists': a creator on the no-lock path got in after our remove,
			// so it won. 'sharing': the old lock is gone but Windows refused the
			// create for a moment; re-read and try again.
			if (takeover.value === 'sharing') sleepSync(CLAIM_BUSY_BACKOFF_MS);
			continue;
		}
		if (takeover.reason !== 'changed') sleepSync(CLAIM_BUSY_BACKOFF_MS);
	}
	const holder = readLockSnapshot(dataDir)?.info ?? null;
	if (holder && isLockLive(holder) && isCueEngineLockOwnedByThisProcess(holder)) {
		// Ours and live; another process was only inspecting it.
		return { acquired: true };
	}
	return { acquired: false, heldBy: holder ?? buildLockInfo(mode) };
}

export type CueEngineLockTouchResult = 'held' | 'lost';

/**
 * Refresh this process's heartbeat on the lock. Reports `'lost'` when another
 * live engine now owns it - possible when this process was suspended long
 * enough for its lock to go stale and be taken over - so the caller stops
 * dispatching rather than double-firing beside the new owner.
 *
 * A missing lock (deleted by hand) is recreated, but only through the same
 * atomic create a fresh acquire uses, so it can never overwrite a lock another
 * engine created in the meantime. Rewriting an existing lock happens under its
 * generation's claim for the same reason. When another process holds that
 * claim it is judging our lock: if our heartbeat is still fresh this beat is
 * skipped, and if it has gone stale the takeover is real and this reports
 * `'lost'`.
 */
export function touchCueEngineLock(
	mode: CueEngineRunnerMode,
	dataDir?: string
): CueEngineLockTouchResult {
	for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
		const current = readLockSnapshot(dataDir);
		testHook?.('touchAfterRead');
		if (!current) {
			let created: CreateOutcome;
			try {
				created = createLockExclusive(buildLockInfo(mode), dataDir);
			} catch {
				// A failed write only ages the heartbeat; the next beat retries.
				return 'held';
			}
			if (created === 'created') return 'held';
			if (created === 'sharing') sleepSync(CLAIM_BUSY_BACKOFF_MS);
			continue;
		}
		const info = current.info;
		const ours = info !== null && isCueEngineLockOwnedByThisProcess(info);
		if (info && !ours && isLockLive(info)) return 'lost';
		const startedAt = ours ? info.startedAt : undefined;
		let rewrite: ClaimOutcome<void>;
		try {
			rewrite = withGenerationClaim(
				current.generation,
				() => replaceLock(buildLockInfo(mode, startedAt), dataDir),
				dataDir
			);
		} catch {
			// A failed write only ages the heartbeat; the next beat retries.
			return 'held';
		}
		if (rewrite.ok) return 'held';
		if (rewrite.reason === 'sharing') {
			// Nobody else decided anything; a reader had the file open.
			sleepSync(CLAIM_BUSY_BACKOFF_MS);
		} else if (rewrite.reason === 'busy') {
			if (ours) return isLockLive(info) ? 'held' : 'lost';
			sleepSync(CLAIM_BUSY_BACKOFF_MS);
		}
	}
	const final = readLockSnapshot(dataDir)?.info ?? null;
	return final && !isCueEngineLockOwnedByThisProcess(final) && isLockLive(final) ? 'lost' : 'held';
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
 * lock was taken over must not delete a lock it no longer owns, so the remove
 * happens under the claim on the generation judged here: a lock replaced in
 * between is a different generation and is left alone.
 */
export function releaseCueEngineLock(dataDir?: string): void {
	const current = readLockSnapshot(dataDir);
	// Already gone, or never existed - releasing an absent lock is a no-op.
	if (!current) return;
	testHook?.('releaseAfterRead');
	const info = current.info;
	if (info && !isCueEngineLockOwnedByThisProcess(info) && isLockLive(info)) return;
	try {
		withGenerationClaim(current.generation, () => removeLockFile(dataDir), dataDir);
	} catch {
		// Best effort: an unremovable lock goes stale and is taken over.
	}
}
