import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { openBoardDb } from '../../../main/board/board-db';
import {
	boardIsolationChildEnv,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../main/board/board-isolation';
import { BoardStorageFacade, configureBoardCaptureHost } from '../../../main/board/board-storage';
import {
	BOARD_SOURCE_PROJECT_PREFIX,
	type Board,
	type BoardCard,
} from '../../../shared/board/types';

let dir: string;
let contract: BoardIsolation;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;
let bundleDir: string;
let bundle: string;

beforeAll(() => {
	contract = requireBoardIsolation();
	readBoardIsolationRegistries(contract);
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(contract.db + suffix)) throw new Error('Board test database must be fresh');
	}
	fs.mkdirSync(path.dirname(contract.db), { recursive: true });
	// Keep external package resolution inside this checkout, as with the claim-process fixture.
	bundleDir = fs.mkdtempSync(path.join(contract.root, 'global-build-'));
	bundle = path.join(bundleDir, 'initialize.cjs');
	buildSync({
		entryPoints: ['src/__tests__/main/board/fixtures/board-global-store-process.ts'],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		packages: 'external',
		logLevel: 'silent',
	});
});
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(contract.root, 'global-store-'));
	db = openBoardDb(contract.db);
	facade = new BoardStorageFacade(db);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
});

const projectRef = (board: Board) => BOARD_SOURCE_PROJECT_PREFIX + board.storage!.sourceKey;
const draft = (id = 'first'): BoardCard => ({
	id,
	title: 'Global task',
	body: '',
	parents: [],
	status: 'todo',
	createdAt: '',
	updatedAt: '',
});
function capture(board: Board, card = draft()) {
	return facade.capture({
		projectRoot: projectRef(board),
		boardId: board.id,
		expectedRevision: board.storage!.expectedRevision!,
		card,
	});
}
const totalChanges = () => db.prepare('SELECT total_changes() AS n').get();

describe('root-free global Board persistence in real SQLite', () => {
	it('keeps reads pure on an empty workspace and initializes only through the explicit writer', async () => {
		const before = totalChanges();
		expect(facade.query()).toEqual({ revision: 0, sources: [], collections: [] });
		expect(await facade.queryAsync()).toEqual(facade.query());
		expect(totalChanges()).toEqual(before);
		expect(() => db.transaction(() => facade.ensureGlobalBoard())()).toThrow('own transaction');
		expect(totalChanges()).toEqual(before);

		const board = facade.ensureGlobalBoard();
		expect(board.cards).toEqual([]);
		expect(board.storage).toMatchObject({ expectedRevision: 0, cardRevisions: {} });
		expect(facade.captureContext(board).defaultStartMode).toBe('approval');
		expect(facade.query().sources).toEqual([
			{ sourceKey: board.storage!.sourceKey, projectRef: { sourceKey: board.storage!.sourceKey } },
		]);
		for (const table of ['migrations', 'repositories', 'board_source_locations', 'profiles'])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		const initialized = totalChanges();
		expect(facade.ensureGlobalBoard()).toEqual(board);
		expect(await facade.queryAsync()).toEqual(facade.query());
		expect(totalChanges()).toEqual(initialized);
	});

	it('captures the first card with no agent, project, profile, repository or CWD and reopens with its fences', async () => {
		const empty = facade.ensureGlobalBoard();
		const saved = capture(empty);
		expect(saved.cards[0]).toMatchObject({
			id: 'first',
			storageRevision: 0,
			capturePolicy: { effectiveStartMode: 'approval', dispatchApproval: 'required' },
		});
		expect(saved.cards[0].workingDirectory).toBeUndefined();
		expect(saved.cards[0].repositoryId).toBeUndefined();
		expect((await facade.queryAsync()).collections[0].readiness!.first).toEqual(
			expect.arrayContaining(['repository-unresolved', 'missing-scope', 'approval-required'])
		);
		expect(() => capture(empty, draft('stale'))).toThrow(
			expect.objectContaining({ code: 'stale-revision' })
		);
		db.close();
		db = openBoardDb(contract.db);
		facade = new BoardStorageFacade(db);
		expect(facade.ensureGlobalBoard()).toEqual(saved);
		expect(facade.read(projectRef(saved), saved.id)).toEqual(saved);
		const before = totalChanges();
		expect((await facade.queryAsync()).collections[0].board).toEqual(saved);
		expect(totalChanges()).toEqual(before);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM reservations').all()).toEqual([]);
	});

	it('preserves explicit future start policy on repeated initialization without granting old cards', () => {
		const saved = capture(facade.ensureGlobalBoard());
		const updated = facade.setStartPolicy(
			projectRef(saved),
			saved.id,
			saved.storage!.expectedRevision!,
			'direct',
			true
		);
		const before = totalChanges();
		expect(facade.ensureGlobalBoard()).toEqual(updated);
		expect(totalChanges()).toEqual(before);
		expect(updated.cards[0].capturePolicy!.dispatchApproval).toBe('required');
	});

	it('retains source, card revision and approval protection for root-free capture', () => {
		const saved = capture(facade.ensureGlobalBoard());
		const original = structuredClone(saved);
		expect(() => capture(saved, { ...saved.cards[0], storageRevision: 99 })).toThrow(
			expect.objectContaining({ code: 'stale-revision' })
		);
		expect(() => capture(saved, { ...saved.cards[0], startModeOverride: 'direct' })).toThrow(
			expect.objectContaining({ code: 'invalid-input' })
		);
		expect(() =>
			capture(saved, {
				...saved.cards[0],
				capturePolicy: { ...saved.cards[0].capturePolicy!, dispatchApproval: 'granted' },
			})
		).toThrow(expect.objectContaining({ code: 'protected-field' }));
		expect(() => facade.save(BOARD_SOURCE_PROJECT_PREFIX + 'f'.repeat(64), [saved])).toThrow();
		expect(facade.ensureGlobalBoard()).toEqual(original);
	});

	it('rolls back bootstrap on failure and does not adopt a colliding foreign collection', () => {
		const board = facade.ensureGlobalBoard();
		const key = board.storage!;
		db.prepare('DELETE FROM collections').run();
		db.prepare('DELETE FROM board_sources').run();
		db.exec(`CREATE TRIGGER fail_global_insert BEFORE INSERT ON collections
			BEGIN SELECT RAISE(ABORT, 'bootstrap-failure'); END`);
		expect(() => facade.ensureGlobalBoard()).toThrow('bootstrap-failure');
		expect(db.prepare('SELECT * FROM board_sources').all()).toEqual([]);
		db.exec('DROP TRIGGER fail_global_insert');
		facade.workspace.createCollection({
			sourceKey: 'f'.repeat(64),
			collectionKey: key.collectionKey,
			legacyBoardId: board.id,
			expectedRevision: null,
			set: { name: 'Foreign' },
		});
		const before = totalChanges();
		expect(() => facade.ensureGlobalBoard()).toThrow(
			expect.objectContaining({ code: 'identity-mismatch' })
		);
		expect(totalChanges()).toEqual(before);
	});

	it('does not recreate an archived global collection', () => {
		const board = facade.ensureGlobalBoard();
		db.prepare('INSERT INTO collection_archives VALUES (?)').run(board.storage!.collectionKey);
		const before = totalChanges();
		expect(() => facade.ensureGlobalBoard()).toThrow(
			expect.objectContaining({ code: 'identity-mismatch' })
		);
		expect(totalChanges()).toEqual(before);
	});

	it('keeps equal legacy Board and card IDs in their owning sources without rekeying', () => {
		const legacy = facade.project(
			facade.workspace.createCollection({
				sourceKey: 'f'.repeat(64),
				collectionKey: 'legacy',
				legacyBoardId: 'maestro-global',
				expectedRevision: null,
				set: { name: 'Legacy' },
			})
		);
		const original = capture(legacy);
		const global = capture(facade.ensureGlobalBoard());
		expect(global.id).toBe(original.id);
		expect(global.cards[0].id).toBe(original.cards[0].id);
		expect(global.storage!.sourceKey).not.toBe(original.storage!.sourceKey);
		expect(global.storage!.collectionKey).not.toBe(original.storage!.collectionKey);
		expect(facade.read(projectRef(original), original.id)).toEqual(original);
		expect(facade.query().collections).toHaveLength(2);
	});

	it('initializes concurrently in separate processes to one stable source and collection', async () => {
		const children = [0, 1].map(() =>
			fork(bundle, [], {
				execPath: process.execPath,
				cwd: contract.worktree,
				env: boardIsolationChildEnv(contract),
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			})
		);
		try {
			const ready = children.map(async (child) => {
				const waiting = once(child, 'message');
				child.send({ file: contract.db, contract });
				const [message] = await waiting;
				expect(message).toMatchObject({ ready: true });
			});
			await Promise.all(ready);
			const results = children.map((child) => once(child, 'message'));
			const exited = children.map((child) => once(child, 'exit'));
			children.forEach((child) => child.send({ start: true }));
			const replies = (await Promise.all(results)).map(([reply]) => reply);
			expect(replies[0]).toMatchObject({ board: facade.ensureGlobalBoard() });
			expect(replies[1].board).toEqual(replies[0].board);
			for (const exit of await Promise.all(exited)) expect(exit).toEqual([0, null]);
			expect(db.prepare('SELECT * FROM board_sources').all()).toHaveLength(1);
			expect(db.prepare('SELECT * FROM collections').all()).toHaveLength(1);
			expect(facade.query().revision).toBe(1);
		} finally {
			children.forEach((child) => {
				if (child.exitCode === null) child.kill();
			});
		}
	});
});
