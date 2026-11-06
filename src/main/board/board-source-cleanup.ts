/** Explicit, source-scoped legacy cleanup. No discovery or production data is touched here. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonicalJson';
import { assertAdmittedBoardConnection } from './board-db';
import {
	assertBoardIsolationPath,
	isBoardIsolationRequested,
	requireBoardIsolation,
} from './board-isolation';
import { hasUnresolvedMigrationBlockers } from './board-migration';

interface SourceSnapshot {
	sourceKey: string;
	/** Informational workspace position, excluded from source-state equality. */
	revision: number;
	migration: Record<string, unknown>;
	location: unknown;
	collections: Array<{
		collection_key: string;
		legacy_board_id: string;
		payload_json: string;
		revision: number;
	}>;
	cards: Array<{ collection_key: string; id: string; payload_json: string; revision: number }>;
	runs: unknown[];
	reservations: unknown[];
	holds: Array<{ worker_agent_id: string; claims: unknown[] }>;
	archives: unknown[];
	cardArchives: unknown[];
	profiles: unknown[];
	blocker: unknown;
	suppressed: boolean;
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Requires the full source hash, never a name, path, prefix or global board ID. */
export function previewBoardSourceCleanup(
	db: Database.Database,
	sourceKey: string
): SourceSnapshot {
	if (isBoardIsolationRequested()) assertAdmittedBoardConnection(db);
	if (!/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error('Exact legacy source key required');
	const migration = db
		.prepare(
			'SELECT hashes_json, hex(snapshot) AS snapshot_hex, mapping_json, committed_at FROM migrations WHERE source_key = ?'
		)
		.get(sourceKey) as Record<string, unknown> | undefined;
	if (!migration) throw new Error('Legacy source not found');
	const collections = db
		.prepare(
			'SELECT collection_key, legacy_board_id, payload_json, revision FROM collections WHERE source_key = ? ORDER BY collection_key'
		)
		.all(sourceKey) as SourceSnapshot['collections'];
	const bySource = 'SELECT collection_key FROM collections WHERE source_key = ?';
	const cards = db
		.prepare(
			`SELECT collection_key, id, payload_json, revision FROM cards WHERE collection_key IN (${bySource}) ORDER BY collection_key, id`
		)
		.all(sourceKey) as SourceSnapshot['cards'];
	const all = (sql: string) => db.prepare(sql).all(sourceKey);
	// One worker can carry uncertain claims from several sources. Only this
	// source's claims belong in its backup, not the worker's unrelated claims.
	const holds = (
		db
			.prepare(
				'SELECT worker_agent_id, claims_json FROM migration_worker_holds ORDER BY worker_agent_id'
			)
			.all() as Array<{ worker_agent_id: string; claims_json: string }>
	).flatMap((row) => {
		const claims: unknown = JSON.parse(row.claims_json);
		if (!Array.isArray(claims)) throw new Error('Invalid migration worker holds');
		const scoped = claims.filter((claim) => claim?.sourceKey === sourceKey);
		return scoped.length ? [{ worker_agent_id: row.worker_agent_id, claims: scoped }] : [];
	});
	return {
		sourceKey,
		revision: (
			db.prepare('SELECT revision FROM workspace WHERE id = 1').get() as { revision: number }
		).revision,
		migration,
		location:
			db
				.prepare('SELECT payload_json FROM board_source_locations WHERE source_key = ?')
				.get(sourceKey) ?? null,
		collections,
		cards,
		runs: all(`SELECT * FROM runs WHERE collection_key IN (${bySource}) ORDER BY run_id`),
		reservations: all(
			`SELECT * FROM reservations WHERE collection_key IN (${bySource}) ORDER BY run_id`
		),
		holds,
		archives: all(
			`SELECT * FROM collection_archives WHERE collection_key IN (${bySource}) ORDER BY collection_key`
		),
		cardArchives: all(
			`SELECT * FROM card_archives WHERE collection_key IN (${bySource}) ORDER BY collection_key, card_id`
		),
		profiles: all('SELECT * FROM profiles WHERE source_key = ? ORDER BY profile_namespace, id'),
		blocker:
			db
				.prepare('SELECT payload_json FROM migration_blockers WHERE source_key = ?')
				.get(sourceKey) ?? null,
		suppressed: !!db
			.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key = ?')
			.get(sourceKey),
	};
}

/** Creates a durable exclusive export; existing destinations are never overwritten. */
export function exportBoardSourceCleanup(
	db: Database.Database,
	sourceKey: string,
	destination: string
): { sha256: string; snapshot: SourceSnapshot } {
	if (!path.isAbsolute(destination)) throw new Error('Absolute backup path required');
	if (isBoardIsolationRequested()) assertBoardIsolationPath(requireBoardIsolation(), destination);
	if (isBoardIsolationRequested()) assertAdmittedBoardConnection(db);
	const snapshot = db.transaction(() => previewBoardSourceCleanup(db, sourceKey)).deferred();
	const data = canonicalJson(snapshot);
	const fd = fs.openSync(destination, 'wx', 0o600);
	try {
		fs.writeFileSync(fd, data, 'utf8');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (fs.readFileSync(destination, 'utf8') !== data)
		throw new Error('Board backup verification failed');
	return { sha256: digest(data), snapshot };
}

export interface BoardSourceCleanupReceipt {
	sourceKey: string;
	backupSha256: string;
	archivedCollections: string[];
	revision: number;
}

/** Atomic suppression and hiding; no source, card, history or worker data is deleted. */
export function suppressBoardSource(
	db: Database.Database,
	sourceKey: string,
	backupPath: string,
	backupSha256: string
): BoardSourceCleanupReceipt {
	if (!path.isAbsolute(backupPath)) throw new Error('Absolute backup path required');
	if (isBoardIsolationRequested()) assertBoardIsolationPath(requireBoardIsolation(), backupPath);
	if (isBoardIsolationRequested()) assertAdmittedBoardConnection(db);
	const backup = fs.readFileSync(backupPath, 'utf8');
	if (digest(backup) !== backupSha256) throw new Error('Board backup hash mismatch');
	if (db.inTransaction) throw new Error('Board cleanup requires its own transaction');
	return db
		.transaction(() => {
			const current = previewBoardSourceCleanup(db, sourceKey);
			const original = JSON.parse(backup) as SourceSnapshot;
			if (
				canonicalJson({ ...current, revision: undefined }) !==
				canonicalJson({ ...original, holds: original.holds ?? [], revision: undefined })
			)
				throw new Error('Board source changed since backup');
			if (current.suppressed) throw new Error('Board source is already suppressed');
			if (
				current.reservations.length ||
				current.holds.length ||
				current.runs.some((run) => (run as { outcome_json: unknown }).outcome_json === null) ||
				current.cards.some((card) => JSON.parse(card.payload_json).status === 'running')
			) {
				throw new Error('Cannot suppress a source with active or uncertain runs');
			}
			// A migration blocker can represent an unfinished run not materialized as a card.
			if (current.blocker) {
				let blockers: unknown;
				try {
					blockers = JSON.parse((current.blocker as { payload_json: string }).payload_json);
				} catch {
					throw new Error('Resolve migration blockers before suppression');
				}
				if (hasUnresolvedMigrationBlockers(blockers))
					throw new Error('Resolve migration blockers before suppression');
			}
			const archived = new Set(
				(current.archives as Array<{ collection_key: string }>).map((row) => row.collection_key)
			);
			const added = current.collections
				.map((row) => row.collection_key)
				.filter((key) => !archived.has(key));
			const receipt = {
				sourceKey,
				backupSha256,
				archivedCollections: added,
				revision: current.revision + 1,
			};
			// Bind restore to this particular suppression, independently of later
			// workspace writes. Older receipts cannot undo a subsequent suppression.
			db.prepare(
				'INSERT INTO board_source_suppressions (source_key, receipt_json) VALUES (?, ?)'
			).run(sourceKey, canonicalJson(receipt));
			const archive = db.prepare('INSERT INTO collection_archives (collection_key) VALUES (?)');
			for (const key of added) archive.run(key);
			db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
			return receipt;
		})
		.immediate();
}

/** Undo only this receipt's archives and tombstone, before any later source edit. */
export function restoreBoardSource(
	db: Database.Database,
	receipt: BoardSourceCleanupReceipt,
	backupPath: string
): void {
	if (!path.isAbsolute(backupPath)) throw new Error('Absolute backup path required');
	if (isBoardIsolationRequested()) assertBoardIsolationPath(requireBoardIsolation(), backupPath);
	if (isBoardIsolationRequested()) assertAdmittedBoardConnection(db);
	const backup = fs.readFileSync(backupPath, 'utf8');
	if (digest(backup) !== receipt.backupSha256) throw new Error('Board backup hash mismatch');
	if (db.inTransaction) throw new Error('Board restore requires its own transaction');
	db.transaction(() => {
		const original = JSON.parse(backup) as SourceSnapshot;
		const current = previewBoardSourceCleanup(db, receipt.sourceKey);
		const suppression = db
			.prepare('SELECT receipt_json FROM board_source_suppressions WHERE source_key = ?')
			.get(receipt.sourceKey) as { receipt_json: string | null } | undefined;
		const expected = original.collections
			.map((row) => row.collection_key)
			.filter(
				(key) =>
					!(original.archives as Array<{ collection_key: string }>).some(
						(row) => row.collection_key === key
					)
			);
		if (
			original.sourceKey !== receipt.sourceKey ||
			original.suppressed ||
			!suppression ||
			// Pre-upgrade suppressions have no persisted receipt. Preserve their
			// original conservative fence rather than infer a new restore authority.
			(suppression.receipt_json === null
				? receipt.revision !== original.revision + 1 || current.revision !== receipt.revision
				: suppression.receipt_json !== canonicalJson(receipt)) ||
			!current.suppressed ||
			canonicalJson(expected) !== canonicalJson(receipt.archivedCollections) ||
			canonicalJson(current.archives) !==
				canonicalJson(
					[
						...(original.archives as Array<{ collection_key: string }>),
						...expected.map((collection_key) => ({ collection_key })),
					].sort((a, b) => a.collection_key.localeCompare(b.collection_key))
				)
		)
			throw new Error('Board restore conflict');
		const restored = {
			...current,
			revision: undefined,
			suppressed: false,
			archives: original.archives,
		};
		if (
			canonicalJson(restored) !==
			canonicalJson({ ...original, holds: original.holds ?? [], revision: undefined })
		)
			throw new Error('Board source changed since cleanup');
		const remove = db.prepare('DELETE FROM collection_archives WHERE collection_key = ?');
		for (const key of expected) {
			if (remove.run(key).changes !== 1) throw new Error('Board restore archive conflict');
		}
		db.prepare('DELETE FROM board_source_suppressions WHERE source_key = ?').run(receipt.sourceKey);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
	}).immediate();
}
