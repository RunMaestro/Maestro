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

function readLease(lockPath: string): CueEngineLeaseRecord | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<CueEngineLeaseRecord>;
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
	 * is unparseable; returns `'wait'` while it may still be a peer mid-create.
	 */
	function holderVerdict(holder: CueEngineLeaseRecord | null): 'stale' | 'live' | 'wait' {
		if (holder === null) {
			let ageMs: number | null = null;
			try {
				ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
			} catch {
				return 'wait'; // Vanished between our create and stat; just retry.
			}
			return ageMs > PARTIAL_LEASE_GRACE_MS ? 'stale' : 'wait';
		}
		if (options.ownsDataDirectory?.()) return 'stale';
		if (isCurrentProcess(holder)) return 'stale';
		const liveness = probeProcess(holder);
		if (liveness === 'dead') return 'stale';
		if (liveness === 'alive' && holder.startToken === undefined) {
			// Pid exists but we cannot prove it is the same process: fall back to
			// the lease clock. A running engine renews every heartbeat.
			return Date.now() - holder.heartbeatAt > leaseTtlMs ? 'stale' : 'live';
		}
		return 'live';
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
			const verdict = holderVerdict(holder);
			if (verdict === 'live' && holder) {
				return {
					ok: false,
					holder,
					reason: `Cue engine lease is held by another Maestro process (${describeHolder(holder)})`,
				};
			}
			const reclaimed = verdict === 'stale' && reclaimStaleLock(lockPath, holder);
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
		if (onDisk === null && !fs.existsSync(lockPath)) {
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
		if (onDisk?.instanceId !== held.instanceId) {
			held = null;
			return false;
		}
		const refreshed = { ...held, heartbeatAt: Date.now() };
		// Rename-over keeps the path occupied throughout, so no peer's O_EXCL
		// create can slip in between.
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
