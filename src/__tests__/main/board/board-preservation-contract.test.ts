import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

	it('preserves unknown identity, dependency and history through suppression, reopen and restore while refusing replay', () => {
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
		const before = previewBoardSourceCleanup(db, plan.sourceKey);
		expect(before.collections[0].legacy_board_id).toBe('unknown-board');
		expect(JSON.parse(before.cards[0].payload_json)).toMatchObject(legacyCard);
		const backup = path.join(scratch, 'backup.json');
		const exported = exportBoardSourceCleanup(db, plan.sourceKey, backup);
		const receipt = suppressBoardSource(db, plan.sourceKey, backup, exported.sha256);
		expect(() => applyBoardMigration(db, plan)).toThrow('suppressed');
		db.close();
		db = openBoardDb(contract.db);
		storage = new BoardStorageFacade(db);
		expect(previewBoardSourceCleanup(db, plan.sourceKey).suppressed).toBe(true);
		expect(() => applyBoardMigration(db, plan)).toThrow('suppressed');
		restoreBoardSource(db, receipt, backup);
		const restored = previewBoardSourceCleanup(db, plan.sourceKey);
		expect(restored.collections).toEqual(before.collections);
		expect(restored.cards).toEqual(before.cards);
		expect(restored.runs).toEqual(before.runs);
		expect(restored.migration).toEqual(before.migration);
		expect(applyBoardMigration(db, plan).status).toBe('already-imported');
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
