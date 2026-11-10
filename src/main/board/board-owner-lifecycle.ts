/** Runtime owner rows are fencing generations, not a second user-managed lock.
 * A verified native Cue host may hand over an idle legacy generation while the
 * Cue lock's own generation claim excludes another host. Unknown is never dead. */
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { foldPathCase } from '../utils/real-path-containment';
import { boardDbPath } from './board-db';
import { validateBoardCard } from '../../shared/board/types';
import { isBoardEnabled } from './board-feature';
import { withOwnedCueEngineLock } from '../cue/cue-engine-lock';
import { CUE_ENGINE_LOCK_SPEC } from '../../shared/maestro-lib/runtime/lock';
import type { BoardRuntimeLock } from './board-runtime';

/** Native proof is read from the real configured Cue lock, never caller fields.
 * The SQLite connection must belong to that configured data directory/contract. */
export function withBoardOwnerLease<T>(
	db: Database.Database,
	lock: BoardRuntimeLock,
	operation: () => T
): { ok: true; value: T } | { ok: false } {
	if (!isBoardEnabled() || !lock.verify().ok) return { ok: false };

	if (!path.isAbsolute(db.name)) return { ok: false };
	try {
		if (foldPathCase(realpathSync(db.name)) !== foldPathCase(realpathSync(boardDbPath())))
			return { ok: false };
	} catch (error) {
		if (
			['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
				(error as NodeJS.ErrnoException).code ?? ''
			)
		)
			return { ok: false };
		throw error;
	}
	const result = withOwnedCueEngineLock((held) => {
		const info = lock.info;
		if (
			!isBoardEnabled() ||
			!lock.verify().ok ||
			info.pid !== held.pid ||
			info.mode !== held.mode ||
			info.token !== held.token ||
			info.platform !== process.platform ||
			info.pidNsInode !== held.pidNsInode ||
			!Number.isFinite(info.bootTime) ||
			Math.abs(info.bootTime! - held.bootTime!) > CUE_ENGINE_LOCK_SPEC.bootToleranceMs
		)
			return { matched: false } as const;
		return { matched: true, value: operation() } as const;
	});
	if (!result.ok || !result.value.matched) return { ok: false };
	return { ok: true, value: result.value.value };
}

/** Only the known token-less legacy format is eligible. Existing modern unknown
 * owners still need their ordinary proven-dead/reconciliation path. Capacity and
 * imported uncertainty veto the handover even if an old PID is absent. */
export function isIdleLegacyBoardOwner(
	db: Database.Database,
	old: { process_identity: string; epoch: number; heartbeat: number },
	lock: BoardRuntimeLock
): boolean {
	if (old.process_identity.length > 512) return false;
	let identity: { pid: number; bootTime: number; startedAt: string };
	try {
		identity = JSON.parse(old.process_identity);
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
	if (
		!identity ||
		typeof identity !== 'object' ||
		Array.isArray(identity) ||
		Object.keys(identity).sort().join(',') !== 'bootTime,pid,startedAt' ||
		!Number.isSafeInteger(identity.pid) ||
		identity.pid <= 0 ||
		identity.pid === process.pid ||
		typeof identity.startedAt !== 'string' ||
		!Number.isFinite(Date.parse(identity.startedAt)) ||
		new Date(identity.startedAt).toISOString() !== identity.startedAt ||
		!Number.isFinite(identity.bootTime) ||
		Math.abs(identity.bootTime - lock.info.bootTime!) > CUE_ENGINE_LOCK_SPEC.bootToleranceMs ||
		identity.bootTime > Date.parse(identity.startedAt) ||
		Date.parse(identity.startedAt) >= Date.parse(lock.info.startedAt) ||
		!Number.isSafeInteger(old.epoch) ||
		old.epoch < 1 ||
		!Number.isSafeInteger(old.epoch + 1) ||
		!Number.isSafeInteger(old.heartbeat) ||
		old.heartbeat < Date.parse(identity.startedAt) ||
		old.heartbeat > Date.now()
	)
		return false;
	// Present/unknown PID is a veto, never proof authorizing this handover.
	try {
		process.kill(identity.pid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
	for (const table of ['runs', 'reservations', 'migration_worker_holds'])
		if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
	for (const row of db.prepare('SELECT payload_json FROM cards').iterate() as Iterable<{
		payload_json: string;
	}>) {
		const card = JSON.parse(row.payload_json);
		if (
			!validateBoardCard(card) ||
			!card ||
			typeof card !== 'object' ||
			card.status === 'running' ||
			card.migration?.intent === 'reconciliation-required' ||
			(card.runs !== undefined &&
				(!Array.isArray(card.runs) ||
					card.runs.some((run: { endedAt?: string } | null) => !run?.endedAt)))
		)
			return false;
	}
	return true;
}
