import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson';
import { openBoardDb } from '../../../main/board/board-db';
import {
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../main/board/board-isolation';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import {
	exportBoardSourceCleanup,
	previewBoardSourceCleanup,
	restoreBoardSource,
	suppressBoardSource,
} from '../../../main/board/board-source-cleanup';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { compareSqliteSnapshots, snapshotSqlite } from '../../helpers/sqliteSnapshot';

const fixture = createBoardIsolationFixture();
let contract: BoardIsolation;
let db: ReturnType<typeof openBoardDb>;
let storage: BoardStorageFacade;
let scratch: string;
let ownsDatabase = false;

beforeAll(() => {
	fixture.install();
	contract = requireBoardIsolation();
	readBoardIsolationRegistries(contract);
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(contract.db + suffix)) throw new Error('Board test database must be fresh');
	}
	fs.mkdirSync(path.dirname(contract.db), { recursive: true });
});
afterAll(async () => {
	await fixture.cleanup();
});
beforeEach(() => {
	ownsDatabase = false;
	scratch = '';
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(contract.db + suffix)) throw new Error('Board test database must be fresh');
	}
	scratch = fs.mkdtempSync(path.join(contract.root, 'preservation-'));
	db = openBoardDb(contract.db);
	ownsDatabase = true;
	storage = new BoardStorageFacade(db);
});
afterEach(() => {
	if (ownsDatabase) {
		db.close();
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
	}
	if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe('isolated Board preservation contract', () => {
	it('reopens an initialized empty workspace without creating another collection or card', () => {
		const initial = storage.ensureGlobalBoard();
		expect(initial.cards).toEqual([]);
		db.close();
		db = openBoardDb(contract.db);
		storage = new BoardStorageFacade(db);
		expect(storage.ensureGlobalBoard()).toEqual(initial);
		expect(storage.query().collections).toHaveLength(1);
		expect(db.prepare('SELECT * FROM cards').all()).toEqual([]);
	});

	it.each(['unchanged', 'source', 'worker', 'lifecycle', 'hold'])(
		'preserves identity and history through suppression, reopen and restore after unrelated %s writes',
		(change) => {
			const legacyCard = {
				id: 'unknown-card',
				title: 'Retain',
				body: '',
				status: 'todo',
				parents: ['missing-parent'],
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				runs: [
					{
						attempt: 1,
						runId: 'unknown-run',
						startedAt: '2026-01-01T00:00:00.000Z',
						endedAt: '2026-01-01T00:00:00.000Z',
						outcome: 'done',
						future: 'retain',
					},
				],
				future: { unknown: 'retain' },
			};
			const boardBytes = Buffer.from(
				JSON.stringify({ boards: [{ id: 'unknown-board', name: 'Legacy', cards: [legacyCard] }] })
			);
			const plan = planBoardMigration({
				source: { location: { kind: 'local' }, path: scratch },
				repository: null,
				boardBytes,
				profileBytes: null,
				workers: [],
			});
			const imported = applyBoardMigration(db, plan);
			expect(imported.status).toBe('imported');
			const otherPlan = planBoardMigration({
				source: { location: { kind: 'local' }, path: fixture.sources.two },
				repository: null,
				boardBytes,
				profileBytes: null,
				workers: [],
			});
			applyBoardMigration(db, otherPlan);
			const otherCollection = otherPlan.boards[0].collectionKey!;
			const mutateUnrelated = (phase: string) => {
				if (change === 'unchanged') return;
				db.transaction(() => {
					if (change === 'source') {
						db.prepare('UPDATE collections SET revision = revision + 1 WHERE source_key = ?').run(
							otherPlan.sourceKey
						);
					} else if (change === 'worker') {
						db.prepare(
							'INSERT INTO workers (agent_id, enabled, paused, payload_json) VALUES (?, 1, 0, ?) ON CONFLICT (agent_id) DO UPDATE SET payload_json = excluded.payload_json'
						).run('unrelated-worker', JSON.stringify({ phase }));
					} else if (change === 'hold') {
						db.prepare(
							'INSERT INTO migration_worker_holds VALUES (?, ?) ON CONFLICT (worker_agent_id) DO UPDATE SET claims_json = excluded.claims_json'
						).run('unrelated-worker', canonicalJson([{ sourceKey: otherPlan.sourceKey, phase }]));
					} else {
						db.prepare('UPDATE runs SET lifecycle_json = ? WHERE collection_key = ?').run(
							JSON.stringify({ phase }),
							otherCollection
						);
					}
					db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
				}).immediate();
			};
			const before = previewBoardSourceCleanup(db, plan.sourceKey);
			expect(before.collections[0].legacy_board_id).toBe('unknown-board');
			expect(JSON.parse(before.cards[0].payload_json)).toMatchObject(legacyCard);
			const backup = path.join(scratch, 'backup.json');
			const exported = exportBoardSourceCleanup(db, plan.sourceKey, backup);
			mutateUnrelated('before suppression');
			const receipt = suppressBoardSource(db, plan.sourceKey, backup, exported.sha256);
			mutateUnrelated('after suppression');
			expect(() => applyBoardMigration(db, plan)).toThrow('suppressed');
			db.close();
			db = openBoardDb(contract.db);
			storage = new BoardStorageFacade(db);
			expect(previewBoardSourceCleanup(db, plan.sourceKey).suppressed).toBe(true);
			expect(() => applyBoardMigration(db, plan)).toThrow('suppressed');
			const otherBeforeRestore = previewBoardSourceCleanup(db, otherPlan.sourceKey);
			restoreBoardSource(db, receipt, backup);
			const restored = previewBoardSourceCleanup(db, plan.sourceKey);
			expect(restored.collections).toEqual(before.collections);
			expect(restored.cards).toEqual(before.cards);
			expect(restored.runs).toEqual(before.runs);
			expect(restored.migration).toEqual(before.migration);
			expect(previewBoardSourceCleanup(db, otherPlan.sourceKey)).toEqual({
				...otherBeforeRestore,
				revision: restored.revision,
			});
			expect(() => restoreBoardSource(db, receipt, backup)).toThrow('Board restore conflict');
			expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		}
	);

	describe('source-scoped cleanup fences', () => {
		let sourceKey: string;
		let collectionKey: string;
		let backup: string;
		let sha256: string;
		beforeEach(() => {
			const plan = planBoardMigration({
				source: { location: { kind: 'local' }, path: scratch },
				repository: null,
				boardBytes: Buffer.from(
					JSON.stringify({
						boards: [
							{ id: 'b', name: 'Fence', cards: [] },
							{ id: 'archived', name: 'Archived', cards: [] },
						],
					})
				),
				profileBytes: null,
				workers: [],
			});
			applyBoardMigration(db, plan);
			sourceKey = plan.sourceKey;
			collectionKey = plan.boards[0].collectionKey!;
			db.prepare('INSERT INTO collection_archives VALUES (?)').run(plan.boards[1].collectionKey!);
			db.prepare('INSERT INTO cards VALUES (?, ?, ?, 0)').run(
				collectionKey,
				'c',
				canonicalJson({ id: 'c', status: 'todo', intakeHold: false })
			);
			db.prepare(
				'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json, outcome_json) VALUES (?, ?, ?, 1, ?, ?)'
			).run('run', collectionKey, 'c', '{}', '{}');
			backup = path.join(scratch, 'fence-backup.json');
			sha256 = exportBoardSourceCleanup(db, sourceKey, backup).sha256;
		});

		it.each(
			[
				'migration',
				'location',
				'collection',
				'card',
				'intake hold',
				'history',
				'profile',
				'blocker',
				'archive',
				'card archive',
				'worker hold',
				'reservation',
				'suppression',
			].flatMap((change) => ['suppress', 'restore'].map((phase) => ({ change, phase })))
		)('refuses $change mutations before $phase without any cleanup writes', ({ change, phase }) => {
			const receipt =
				phase === 'restore' ? suppressBoardSource(db, sourceKey, backup, sha256) : null;
			const changes: Record<string, () => unknown> = {
				migration: () =>
					db
						.prepare('UPDATE migrations SET committed_at = committed_at + 1 WHERE source_key = ?')
						.run(sourceKey),
				location: () =>
					db
						.prepare('UPDATE board_source_locations SET payload_json = ? WHERE source_key = ?')
						.run('{}', sourceKey),
				collection: () =>
					db
						.prepare('UPDATE collections SET revision = revision + 1 WHERE collection_key = ?')
						.run(collectionKey),
				card: () =>
					db
						.prepare('UPDATE cards SET revision = revision + 1 WHERE collection_key = ?')
						.run(collectionKey),
				'intake hold': () =>
					db
						.prepare('UPDATE cards SET payload_json = ? WHERE collection_key = ?')
						.run('{"id":"c","status":"todo","intakeHold":true}', collectionKey),
				history: () =>
					db
						.prepare('UPDATE runs SET lifecycle_json = ? WHERE run_id = ?')
						.run('{"resultCommitted":true}', 'run'),
				profile: () =>
					db
						.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?)')
						.run(`legacy:${sourceKey}`, 'role', '{}', sourceKey),
				blocker: () =>
					db
						.prepare('UPDATE migration_blockers SET payload_json = ? WHERE source_key = ?')
						.run('["uncertain-run"]', sourceKey),
				archive: () =>
					phase === 'restore'
						? db
								.prepare('DELETE FROM collection_archives WHERE collection_key = ?')
								.run(collectionKey)
						: db.prepare('INSERT INTO collection_archives VALUES (?)').run(collectionKey),
				'card archive': () =>
					db.prepare('INSERT INTO card_archives VALUES (?, ?)').run(collectionKey, 'c'),
				'worker hold': () =>
					db
						.prepare('INSERT INTO migration_worker_holds VALUES (?, ?)')
						.run('worker', canonicalJson([{ sourceKey, raw: { endedAt: null } }])),
				reservation: () => {
					db.prepare('INSERT INTO workers VALUES (?, 1, 0, ?)').run('worker', '{}');
					db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, 1, 1, ?)').run(
						'worker',
						collectionKey,
						'c',
						'run',
						'uncertain'
					);
				},
				suppression: () =>
					phase === 'restore'
						? db
								.prepare(
									'UPDATE board_source_suppressions SET receipt_json = ? WHERE source_key = ?'
								)
								.run('{}', sourceKey)
						: db
								.prepare('INSERT INTO board_source_suppressions (source_key) VALUES (?)')
								.run(sourceKey),
			};
			changes[change]();
			const mutated = snapshotSqlite(db);
			expect(() =>
				phase === 'restore'
					? restoreBoardSource(db, receipt!, backup)
					: suppressBoardSource(db, sourceKey, backup, sha256)
			).toThrow(/source changed|restore conflict/);
			expect(compareSqliteSnapshots(mutated, snapshotSqlite(db))).toEqual([]);
		});

		it.each(['running card', 'unfinished run', 'worker hold'])(
			'refuses a backed-up %s without changing source or reservation state',
			(active) => {
				if (active === 'running card') {
					db.prepare('UPDATE cards SET payload_json = ? WHERE collection_key = ?').run(
						canonicalJson({ id: 'c', status: 'running' }),
						collectionKey
					);
				} else if (active === 'unfinished run') {
					db.prepare('UPDATE runs SET outcome_json = NULL WHERE run_id = ?').run('run');
				} else {
					db.prepare('INSERT INTO migration_worker_holds VALUES (?, ?)').run(
						'worker',
						canonicalJson([{ sourceKey, raw: { endedAt: null } }])
					);
				}
				const activeBackup = path.join(scratch, 'active-backup.json');
				const exported = exportBoardSourceCleanup(db, sourceKey, activeBackup);
				const before = snapshotSqlite(db);
				expect(() => suppressBoardSource(db, sourceKey, activeBackup, exported.sha256)).toThrow(
					'active or uncertain runs'
				);
				expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
			}
		);

		it('binds receipts to one suppression and backup, and refuses nested cleanup', () => {
			expect(() =>
				db.transaction(() => suppressBoardSource(db, sourceKey, backup, sha256))()
			).toThrow('own transaction');
			const receipt = suppressBoardSource(db, sourceKey, backup, sha256);
			expect(() => db.transaction(() => restoreBoardSource(db, receipt, backup))()).toThrow(
				'own transaction'
			);
			for (const foreign of [
				{ ...receipt, revision: receipt.revision + 1 },
				{ ...receipt, sourceKey: 'f'.repeat(64) },
				{ ...receipt, archivedCollections: [] },
				{ ...receipt, backupSha256: '0'.repeat(64) },
			]) {
				const before = snapshotSqlite(db);
				expect(() => restoreBoardSource(db, foreign, backup)).toThrow();
				expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
			}
			restoreBoardSource(db, receipt, backup);
			const next = suppressBoardSource(db, sourceKey, backup, sha256);
			expect(() => restoreBoardSource(db, receipt, backup)).toThrow('restore conflict');
			restoreBoardSource(db, next, backup);
			expect(previewBoardSourceCleanup(db, sourceKey).archives).toEqual(
				JSON.parse(fs.readFileSync(backup, 'utf8')).archives
			);
			expect(() => restoreBoardSource(db, next, backup)).toThrow('restore conflict');
		});

		it('retains the conservative restore fence for pre-upgrade receipts and snapshots', () => {
			const legacy = JSON.parse(fs.readFileSync(backup, 'utf8'));
			delete legacy.holds;
			const bytes = canonicalJson(legacy);
			fs.writeFileSync(backup, bytes);
			sha256 = createHash('sha256').update(bytes).digest('hex');
			const receipt = suppressBoardSource(db, sourceKey, backup, sha256);
			db.exec(
				'ALTER TABLE board_source_suppressions DROP COLUMN receipt_json; PRAGMA user_version = 7'
			);
			db.close();
			db = openBoardDb(contract.db);
			const rows = db.prepare('SELECT * FROM board_source_suppressions').all();
			expect(rows).toEqual([{ source_key: sourceKey, receipt_json: null }]);
			restoreBoardSource(db, receipt, backup);
			const next = suppressBoardSource(db, sourceKey, backup, sha256);
			db.prepare('UPDATE board_source_suppressions SET receipt_json = NULL').run();
			db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
			expect(() => restoreBoardSource(db, next, backup)).toThrow('restore conflict');
		});
	});

	it.each([
		['empty ledger', '[]', false],
		['malformed JSON', '{', true],
		['non-array ledger', '{}', true],
		['unknown reason', '["future-reason"]', true],
		['structural blocker', '[{"reasons":["missing-parent"]}]', true],
		['uncertain run', '[{"reasons":["uncertain-run"]}]', true],
	])('handles %s during source suppression', (_label, ledger, blocked) => {
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: scratch },
			repository: null,
			boardBytes: Buffer.from(JSON.stringify({ boards: [] })),
			profileBytes: null,
			workers: [],
		});
		applyBoardMigration(db, plan);
		db.prepare('UPDATE migration_blockers SET payload_json = ? WHERE source_key = ?').run(
			ledger,
			plan.sourceKey
		);
		const backup = path.join(scratch, 'ledger-backup.json');
		const exported = exportBoardSourceCleanup(db, plan.sourceKey, backup);
		const suppress = () => suppressBoardSource(db, plan.sourceKey, backup, exported.sha256);
		if (blocked) {
			expect(suppress).toThrow('migration blockers');
			expect(previewBoardSourceCleanup(db, plan.sourceKey).suppressed).toBe(false);
		} else {
			suppress();
			expect(previewBoardSourceCleanup(db, plan.sourceKey).suppressed).toBe(true);
		}
	});

	it.each(['BOARD_DB_PATH', 'BOARD_AGENT_REGISTRY', 'BOARD_SOURCE_REGISTRY'])(
		'refuses a production-path %s before opening storage',
		(variable) => {
			const productionPath = path.join(
				contract.worktree,
				'production-profile',
				variable === 'BOARD_DB_PATH' ? 'board.sqlite' : 'agents.json'
			);
			expect(() =>
				requireBoardIsolation({
					env: { ...process.env, [variable]: productionPath },
					expected: contract,
				})
			).toThrow();
			expect(fs.existsSync(productionPath)).toBe(false);
			expect(fs.existsSync(contract.db)).toBe(true);
		}
	);
});
