/**
 * Cross-process lease that keeps ONE Cue engine per data directory.
 *
 * Every Cue engine that opens a given `cue.db` fires every subscription in that
 * directory's agents. Production launches are serialized by Electron's
 * single-instance lock, but nothing stopped two processes sharing a data
 * directory otherwise: two `npm run dev` windows (no single-instance lock in
 * dev), or `dev:prod-data` next to a running production app. Each ran its own
 * engine, so every trigger dispatched twice, and each engine's heartbeat kept
 * `cue_heartbeat.last_seen` fresh for the other, hiding real sleep gaps from
 * the reconciler.
 *
 * The lease is a small JSON file next to `cue.db`:
 * `{ pid, startToken, instanceId, acquiredAt, heartbeatAt, version }`.
 *
 * - **Acquire** creates it with `O_CREAT | O_EXCL`. A file that exists but is
 *   not yet parseable is a peer mid-create (a concurrent start), so we back off
 *   with jitter and look again rather than treat it as stale.
 * - **Reclaim** only from a holder that cannot be running an engine: its
 *   process is proven dead (ESRCH, or the pid was recycled - see
 *   `processIdentity.ts`), it is this same process (a leftover from an earlier
 *   engine cycle), or this process holds Electron's single-instance lock for the
 *   data directory, which rules out any other app instance on it. Only where
 *   the holder's identity cannot be verified (no start token, i.e. Windows) does
 *   an expired `heartbeatAt` count as death. A live, verified holder is never
 *   reclaimed on age alone, so a laptop waking from a long sleep does not lose
 *   its lease to a process that started a moment earlier.
 * - **Renew** rides the engine's 30s heartbeat tick and refreshes
 *   `heartbeatAt`. If the file no longer names us, a peer reclaimed it and is
 *   now the engine, so renew reports the loss and the engine stops.
 * - **Release** removes the file only while it still names us.
 *
 * ## Known limits
 *
 * `renew()` and `release()` are check-then-write: they read the file, confirm it
 * still names us, then write or unlink. A reclaim renames the file ASIDE rather
 * than replacing it in place, so the path is briefly free and a peer's O_EXCL
 * create can land between our read and our write. Reaching that window needs a
 * holder that was reclaimed while we still believed we held the lease, and a
 * VERIFIED live holder can no longer be reclaimed at all (see `holderVerdict`),
 * so in practice it is limited to the Windows path, where no start token exists
 * and an expired `heartbeatAt` is the only evidence of death. The cost if it
 * happens is one duplicated heartbeat window, not two permanent engines: the
 * loser's next renew reads a record naming someone else and stops.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import {
	atomicWriteFileSync,
	backoffDelayMs,
	reclaimStaleLock,
	sleepSync,
} from '../../shared/crossProcessLock';
import {
	currentProcessIdentity,
	isCurrentProcess,
	probeProcess,
	type ProcessIdentity,
} from '../../shared/processIdentity';

export interface CueEngineLeaseRecord extends ProcessIdentity {
	instanceId: string;
	acquiredAt: number;
	heartbeatAt: number;
	/** App version of the holder, for diagnostics. */
	version?: string;
}

export type CueEngineLeaseResult =
	| { ok: true }
	| { ok: false; holder: CueEngineLeaseRecord | null; reason: string };

export interface CueEngineLease {
	/** Take the lease, or report who holds it. Idempotent while held. */
	acquire(): CueEngineLeaseResult;
	/**
	 * Refresh `heartbeatAt`. Returns `false` when the lease has been lost to a
	 * peer (the caller must stop its engine). Throws on unexpected I/O errors.
	 */
	renew(): boolean;
	/** Drop the lease if we still hold it. Never throws. */
	release(): void;
}

export interface CueEngineLeaseOptions {
	/** Absolute path of the lease file, normally `<userData>/cue-engine.lock`. */
	lockPath: string;
	version?: string;
	/**
	 * True when this process holds Electron's single-instance lock for the data
	 * directory (`app.hasSingleInstanceLock()`). No other app instance can then
	 * be using the directory, so any existing lease is stale by construction.
	 */
	ownsDataDirectory?: () => boolean;
	/** Heartbeat age past which an UNVERIFIABLE holder counts as dead. */
	leaseTtlMs?: number;
	/** How long to wait out a peer that is mid-create. */
	acquireTimeoutMs?: number;
}

/**
 * Three missed heartbeats (`HEARTBEAT_INTERVAL_MS` is 30s). Not imported from
 * `cue-heartbeat.ts` so this module stays free of the database dependency.
 */
export const CUE_ENGINE_LEASE_TTL_MS = 90_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 1_500;
/** An unparseable lease younger than this is a peer between open and write. */
const PARTIAL_LEASE_GRACE_MS = 5_000;

/**
 * `null` means no usable record: the file is absent, or it exists and is not yet
 * parseable (a peer between its create and its write).
 *
 * Any other I/O failure THROWS. An EBUSY from a Windows scanner, an EPERM, an
 * EMFILE: none of them say anything about who holds the lease, and reporting
 * them as "somebody else does" is enough to switch Cue off with no peer in
 * sight.
 */
function readLease(lockPath: string): CueEngineLeaseRecord | null {
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<CueEngineLeaseRecord>;
		if (
			typeof parsed.pid === 'number' &&
			typeof parsed.instanceId === 'string' &&
			typeof parsed.acquiredAt === 'number' &&
			typeof parsed.heartbeatAt === 'number'
		) {
			return parsed as CueEngineLeaseRecord;
		}
		return null;
	} catch {
		return null;
	}
}

function tryCreate(lockPath: string, record: CueEngineLeaseRecord): boolean {
	let fd: number;
	try {
		fd = fs.openSync(lockPath, 'wx');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw err;
	}
	try {
		fs.writeSync(fd, JSON.stringify(record));
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

function describeHolder(holder: CueEngineLeaseRecord): string {
	const version = holder.version ? ` v${holder.version}` : '';
	return `pid ${holder.pid}${version}, last heartbeat ${new Date(holder.heartbeatAt).toISOString()}`;
}

export function createCueEngineLease(options: CueEngineLeaseOptions): CueEngineLease {
	const { lockPath, version } = options;
	const leaseTtlMs = options.leaseTtlMs ?? CUE_ENGINE_LEASE_TTL_MS;
	const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
	let held: CueEngineLeaseRecord | null = null;

	/**
	 * Whether `holder` cannot be running an engine. `null` = the file exists but
	 * is unparseable; `'wait'` while it may still be a peer mid-create.
	 *
	 * `ino` is carried out with the verdict rather than stashed beside it: the
	 * reclaim needs to know WHICH file was judged, and a value the caller has to
	 * remember to read separately is one refactor away from going stale.
	 */
	function holderVerdict(holder: CueEngineLeaseRecord | null): {
		verdict: 'stale' | 'live' | 'wait';
		ino?: number;
	} {
		if (holder === null) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(lockPath);
			} catch {
				return { verdict: 'wait' }; // Vanished between create and stat; retry.
			}
			const expired = Date.now() - stat.mtimeMs > PARTIAL_LEASE_GRACE_MS;
			return { verdict: expired ? 'stale' : 'wait', ino: stat.ino };
		}
		if (isCurrentProcess(holder)) return { verdict: 'stale' };
		const liveness = probeProcess(holder);
		if (liveness === 'dead') return { verdict: 'stale' };

		// A holder we can PROVE is running is never reclaimed, not even while we
		// hold the single-instance lock. Dev skips that lock entirely
		// (`setupDeepLinkHandling`, src/main/deep-links.ts), so under
		// `dev:prod-data` production holds it while dev holds the lease, and
		// letting the lock win there would judge a live dev engine stale and run
		// both. That is one of the two cases this lease exists to prevent.
		if (liveness === 'alive' && holder.startToken !== undefined) return { verdict: 'live' };

		// Unverifiable: no start token (Windows, older records) or an inconclusive
		// probe. Owning the data directory rules out any other app instance, which
		// is the strongest evidence available here.
		if (options.ownsDataDirectory?.()) return { verdict: 'stale' };
		// An inconclusive probe may never reclaim; only a clock can.
		if (liveness === 'unknown') return { verdict: 'live' };
		// Pid exists but we cannot prove it is the same process: fall back to the
		// lease clock. A running engine renews every heartbeat.
		const expired = Date.now() - holder.heartbeatAt > leaseTtlMs;
		return { verdict: expired ? 'stale' : 'live' };
	}

	function acquire(): CueEngineLeaseResult {
		if (held && readLease(lockPath)?.instanceId === held.instanceId) return { ok: true };
		held = null;

		const now = Date.now();
		const record: CueEngineLeaseRecord = {
			...currentProcessIdentity(),
			instanceId: crypto.randomUUID(),
			acquiredAt: now,
			heartbeatAt: now,
			...(version ? { version } : {}),
		};
		const deadline = now + acquireTimeoutMs;
		let holder: CueEngineLeaseRecord | null = null;
		for (let attempt = 0; ; attempt++) {
			if (tryCreate(lockPath, record)) {
				held = record;
				return { ok: true };
			}
			holder = readLease(lockPath);
			const { verdict, ino } = holderVerdict(holder);
			if (verdict === 'live' && holder) {
				return {
					ok: false,
					holder,
					reason: `Cue engine lease is held by another Maestro process (${describeHolder(holder)})`,
				};
			}
			const reclaimed = verdict === 'stale' && reclaimStaleLock(lockPath, holder, ino);
			if (Date.now() >= deadline) {
				return {
					ok: false,
					holder,
					reason: 'Timed out acquiring the Cue engine lease (another process is starting Cue)',
				};
			}
			if (!reclaimed) sleepSync(Math.min(backoffDelayMs(attempt, 10, 200), deadline - Date.now()));
		}
	}

	function renew(): boolean {
		if (!held) return false;
		const onDisk = readLease(lockPath);
		if (onDisk === null) {
			if (!fs.existsSync(lockPath)) {
				// Deleted out from under us (user cleanup). Re-take it only if nobody
				// else got there first.
				const refreshed = { ...held, heartbeatAt: Date.now() };
				if (tryCreate(lockPath, refreshed)) {
					held = refreshed;
					return true;
				}
				held = null;
				return false;
			}
			// Present but unparseable: a peer between its create and its write, or a
			// torn file. That proves nothing about who holds the lease, so keep
			// `held` and write nothing over it. The next tick reads a settled file,
			// and if a peer really did take over we stop then.
			throw new Error(`Cue engine lease at ${lockPath} is present but unreadable`);
		}
		// Only a PARSED record naming someone else means the lease is lost.
		if (onDisk.instanceId !== held.instanceId) {
			held = null;
			return false;
		}
		const refreshed = { ...held, heartbeatAt: Date.now() };
		// Check-then-write: the read above and this write are not one atomic step.
		// A reclaim renames the file ASIDE, so the path is briefly free and a
		// peer's O_EXCL create can land in the gap, leaving us to overwrite a lease
		// that is now theirs. A verified live holder can no longer be reclaimed
		// (see `holderVerdict`), so in practice the window needs an UNVERIFIABLE
		// holder, which means the Windows TTL path. See Known limits at the top.
		atomicWriteFileSync(lockPath, JSON.stringify(refreshed));
		held = refreshed;
		return true;
	}

	function release(): void {
		const mine = held;
		held = null;
		if (!mine) return;
		try {
			if (readLease(lockPath)?.instanceId !== mine.instanceId) return;
			fs.unlinkSync(lockPath);
		} catch {
			// Best effort: a leftover lease is reclaimed by the next start.
		}
	}

	return { acquire, renew, release };
}
