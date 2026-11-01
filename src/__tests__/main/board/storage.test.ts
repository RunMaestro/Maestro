/**
 * @file storage.test.ts
 * @description Tests for injected central Board storage: migration, revisioned CRUD,
 * transactional rollback, quarantine, DAG and historical state preservation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { BOARD_CONFIG_PATH } from '../../../shared/maestro-paths';
import {
	loadBoards,
	saveBoards,
	listBoards,
	getBoard,
	createBoard,
	renameBoard,
	deleteBoard,
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
	enqueueBoardWrite,
	BoardStorageError,
} from '../../../main/board/board-storage';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade, configureBoardStorage } from '../../../main/board/board-storage';
import { BoardWorkspaceStorageError } from '../../../main/board/board-workspace-storage';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

let projectRoot: string;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;

beforeEach(() => {
	projectRoot = fs.mkdtempSync(
		path.resolve('.maestro/board-global-workers-20261031/storage-test-')
	);
	db = openBoardDb(path.join(projectRoot, 'board.sqlite'));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
});

afterEach(() => {
	configureBoardStorage(null);
	db.close();
	vi.restoreAllMocks();
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
	return {
		title: `Card ${overrides.id}`,
		body: '',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo' as CardStatus,
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		...overrides,
	};
}

function board(cards: BoardCard[], overrides: Partial<Board> = {}): Board {
	return { id: 'b1', name: 'Test board', cards, ...overrides };
}

function writeRawYaml(content: string): void {
	fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, BOARD_CONFIG_PATH), content, 'utf-8');
}

/** One fixture import per test; input bytes and canonical source identity are explicit. */
function importBytes(content: string) {
	writeRawYaml(content);
	const plan = planBoardMigration({
		source: { location: { kind: 'local' }, path: fs.realpathSync(projectRoot) },
		repository: null,
		boardBytes: Buffer.from(content),
		profileBytes: null,
		workers: [],
	});
	return { plan, result: applyBoardMigration(db, plan) };
}

function seedBoards(root: string, boards: Board[]): void {
	expect(root).toBe(projectRoot);
	expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 0 });
	importBytes(yaml.dump({ boards }));
	for (const value of boards) Object.assign(value, getBoard(root, value.id)!);
}

function reopen(): void {
	configureBoardStorage(null);
	db.close();
	db = openBoardDb(path.join(projectRoot, 'board.sqlite'));
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
}

describe('createBoard', () => {
	it('creates an empty board with a minted id and trimmed name, persisted to disk', () => {
		const created = createBoard(projectRoot, '  Backend rework  ');
		expect(created.name).toBe('Backend rework');
		expect(created.id).toBeTruthy();
		expect(created.cards).toEqual([]);

		// It round-trips through the central workspace, without an import.
		const reloaded = getBoard(projectRoot, created.id);
		expect(reloaded).not.toBeNull();
		expect(reloaded?.name).toBe('Backend rework');
	});

	it('rejects a blank name', () => {
		expect(() => createBoard(projectRoot, '   ')).toThrow(/name is required/);
	});

	it('appends alongside existing boards without disturbing them', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })], { id: 'existing', name: 'Existing' })]);
		const created = createBoard(projectRoot, 'Second');
		const all = listBoards(projectRoot);
		expect(all.map((b) => b.id).sort()).toEqual(['existing', created.id].sort());
	});
});

describe('central bootstrap and revision boundaries', () => {
	it('rolls back source registration and workspace revision if collection creation fails', () => {
		db.exec(
			"CREATE TEMP TRIGGER fail_collection BEFORE INSERT ON collections BEGIN SELECT RAISE(ABORT, 'bootstrap failure'); END"
		);
		expect(() => createBoard(projectRoot, 'First')).toThrow('bootstrap failure');
		expect(db.prepare('SELECT * FROM board_sources').all()).toEqual([]);
		expect(db.prepare('SELECT revision, default_start_mode FROM workspace').get()).toEqual({
			revision: 0,
			default_start_mode: 'approval',
		});
		expect(db.prepare('SELECT * FROM collections').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual([]);
		db.exec('DROP TRIGGER fail_collection');
		const created = createBoard(projectRoot, 'Retry');
		expect(created.storage).toMatchObject({ expectedRevision: 0, cardRevisions: {} });
		const updated = addCard(projectRoot, created.id, card({ id: 'draft' }));
		expect(updated.cards[0].executionScope).toBeUndefined();
		expect(updated.cards[0].repositoryId).toBeUndefined();
		expect(db.prepare('SELECT * FROM repositories').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);
	});

	it.each([[], ['one', 'two']])(
		'rejects missing or ambiguous explicit bootstrap source %j',
		(...keys) => {
			configureBoardStorage(new BoardStorageFacade(db, () => keys));
			expect(() => createBoard(projectRoot, 'Unresolved')).toThrow(BoardStorageError);
			expect(db.prepare('SELECT * FROM board_sources').all()).toEqual([]);
			expect(db.prepare('SELECT * FROM collections').all()).toEqual([]);
		}
	);

	it('upgrades schema 3 without changing imported payloads, runs or ledger', () => {
		seedBoards(projectRoot, [
			board([card({ id: 'a', runs: [{ attempt: 1, startedAt: 'then', outcome: 'done' }] })]),
		]);
		const before = loadBoards(projectRoot);
		const ledger = db.prepare('SELECT * FROM migrations').all();
		const runs = db.prepare('SELECT * FROM runs').all();
		db.exec(
			'DROP TABLE board_source_locations; DROP TABLE board_sources; ALTER TABLE runs DROP COLUMN lifecycle_json; PRAGMA user_version = 3'
		);
		reopen();
		expect(db.pragma('user_version', { simple: true })).toBe(6);
		expect(loadBoards(projectRoot)).toEqual(before);
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual(ledger);
		expect(db.prepare('SELECT * FROM runs').all()).toEqual(runs);
		expect(db.prepare('SELECT * FROM board_sources').all()).toEqual([]);
	});

	it('rejects a stale card revision after another edit without reverting its metadata', () => {
		const created = createBoard(projectRoot, 'New');
		addCard(projectRoot, created.id, card({ id: 'a' }));
		const stale = getBoard(projectRoot, created.id)!.cards[0];
		updateCard(projectRoot, created.id, { ...stale, title: 'Current' });
		expect(() => updateCard(projectRoot, created.id, { ...stale, title: 'Stale' })).toThrow(
			/read revision/
		);
		expect(getBoard(projectRoot, created.id)!.cards[0].title).toBe('Current');
	});

	it.each([{ heldByUser: false }, { runs: [] }])(
		'rejects protected field replacement %j independently',
		(patch) => {
			seedBoards(projectRoot, [
				board([
					card({
						id: 'a',
						heldByUser: true,
						runs: [{ attempt: 1, startedAt: 'then', outcome: 'done' }],
					}),
				]),
			]);
			const before = loadBoards(projectRoot);
			expect(() => updateCard(projectRoot, 'b1', { ...before[0].cards[0], ...patch })).toThrow(
				BoardStorageError
			);
			expect(loadBoards(projectRoot)).toEqual(before);
		}
	);
});

describe('createBoard options', () => {
	it('persists maxInProgress and autoDecompose when provided', () => {
		const created = createBoard(projectRoot, 'Capped', { maxInProgress: 3, autoDecompose: true });
		const reloaded = getBoard(projectRoot, created.id);
		expect(reloaded?.maxInProgress).toBe(3);
		expect(reloaded?.autoDecompose).toBe(true);
	});

	it('omits both fields when not provided', () => {
		const created = createBoard(projectRoot, 'Plain');
		expect(created.maxInProgress).toBeUndefined();
		expect(created.autoDecompose).toBeUndefined();
	});

	it('rejects a non-positive maxInProgress', () => {
		expect(() => createBoard(projectRoot, 'Bad', { maxInProgress: 0 })).toThrow(/positive integer/);
		expect(() => listBoards(projectRoot)).toThrow(BoardStorageError);
	});
});

describe('renameBoard', () => {
	it('renames in place and leaves the cards untouched', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })])]);
		const renamed = renameBoard(projectRoot, 'b1', '  New name  ');
		expect(renamed.name).toBe('New name');
		const reloaded = getBoard(projectRoot, 'b1');
		expect(reloaded?.name).toBe('New name');
		expect(reloaded?.cards.map((c) => c.id)).toEqual(['a']);
	});

	it('rejects a blank name and an unknown board', () => {
		seedBoards(projectRoot, [board([])]);
		expect(() => renameBoard(projectRoot, 'b1', '   ')).toThrow(/name is required/);
		expect(() => renameBoard(projectRoot, 'nope', 'X')).toThrow(/not found/);
		expect(getBoard(projectRoot, 'b1')?.name).toBe('Test board');
	});

	it('does not disturb sibling boards', () => {
		seedBoards(projectRoot, [
			board([], { id: 'b1', name: 'One' }),
			board([], { id: 'b2', name: 'Two' }),
		]);
		renameBoard(projectRoot, 'b1', 'Renamed');
		expect(Object.fromEntries(listBoards(projectRoot).map((b) => [b.id, b.name]))).toEqual({
			b1: 'Renamed',
			b2: 'Two',
		});
	});
});

describe('canceled Board execution ownership', () => {
	it.each([false, true])(
		'rejects stale lifecycle results without clearing a newer run, resetHistory=%s',
		(resetHistory) => {
			seedBoards(projectRoot, [
				board([
					card({
						id: 'a',
						status: 'running',
						heldByUser: true,
						runs: [{ attempt: 2, startedAt: 'current', workerAgentId: 'worker' }],
					}),
				]),
			]);
			const before = loadBoards(projectRoot);
			const rows = db.prepare('SELECT * FROM runs').all();
			const late = structuredClone(before[0]);
			late.cards[0].status = 'done';
			late.cards[0].runs = resetHistory
				? []
				: [{ attempt: 1, startedAt: 'obsolete', outcome: 'done' }];
			expect(() => saveBoards(projectRoot, [late])).toThrow(/fenced runtime/);
			expect(loadBoards(projectRoot)).toEqual(before);
			expect(db.prepare('SELECT * FROM runs').all()).toEqual(rows);
			expect(db.pragma('foreign_key_check')).toEqual([]);
		}
	);
});

describe('deleteBoard', () => {
	it('deletes a board whose cards are all done and returns the remainder', () => {
		seedBoards(projectRoot, [
			board([card({ id: 'a', status: 'done' })], { id: 'b1', name: 'Finished' }),
			board([], { id: 'b2', name: 'Keep' }),
		]);
		const remaining = deleteBoard(projectRoot, 'b1');
		expect(remaining.map((b) => b.id)).toEqual(['b2']);
		expect(() => getBoard(projectRoot, 'b1')).toThrow(BoardStorageError);
	});

	it('deletes an empty board without --force', () => {
		seedBoards(projectRoot, [board([])]);
		expect(deleteBoard(projectRoot, 'b1')).toEqual([]);
	});

	it('refuses without force when any card is not done, leaving the file intact', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' }), card({ id: 'b' })])]);
		expect(() => deleteBoard(projectRoot, 'b1')).toThrow(/not done/);
		expect(getBoard(projectRoot, 'b1')?.cards).toHaveLength(2);
	});

	it.each([false, true])('refuses deleting a running board even with force=%s', (force) => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'running' })])]);
		const before = loadBoards(projectRoot);
		expect(() => deleteBoard(projectRoot, 'b1', { force })).toThrow(/running/i);
		expect(loadBoards(projectRoot)).toEqual(before);
	});

	it('refuses deleting a running card before changing dependency edges', () => {
		seedBoards(projectRoot, [
			board([card({ id: 'a', status: 'running' }), card({ id: 'b', parents: ['a'] })]),
		]);
		const before = loadBoards(projectRoot);
		expect(() => deleteCard(projectRoot, 'b1', 'a')).toThrow(/running/i);
		expect(loadBoards(projectRoot)).toEqual(before);
	});

	it('refuses moving a running card around deletion guards', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'running' })])]);
		expect(() => updateCardStatus(projectRoot, 'b1', 'a', 'todo')).toThrow(/running/i);
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('running');
	});

	it('deletes unfinished cards with force', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'blocked' })])]);
		expect(deleteBoard(projectRoot, 'b1', { force: true })).toEqual([]);
		expect(listBoards(projectRoot)).toEqual([]);
	});

	it('throws for an unknown board', () => {
		expect(() => deleteBoard(projectRoot, 'ghost')).toThrow(BoardStorageError);
	});
});

describe('board-storage round-trip', () => {
	it('rejects reading an unregistered source', () => {
		expect(() => loadBoards(projectRoot)).toThrow(BoardStorageError);
	});

	it('saves and reloads boards unchanged', () => {
		const boards = [
			board(
				[
					card({ id: 'a', status: 'done' }),
					card({ id: 'b', status: 'done' }),
					card({ id: 'c', parents: ['a', 'b'] }),
				],
				{ maxInProgress: 2 }
			),
		];
		seedBoards(projectRoot, boards);
		const legacy = fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH));
		saveBoards(projectRoot, boards);
		reopen();
		expect(fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH))).toEqual(legacy);
		expect(loadBoards(projectRoot)).toEqual(boards);
	});

	it('round-trips the optional autoDecompose flag (Phase 5)', () => {
		const boards = [board([card({ id: 'a' })], { autoDecompose: true })];
		seedBoards(projectRoot, boards);
		const reloaded = loadBoards(projectRoot);
		expect(reloaded[0].autoDecompose).toBe(true);
	});

	it('omits autoDecompose when off (default) so the file stays clean', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(loadBoards(projectRoot)[0].autoDecompose).toBeUndefined();
	});

	it('round-trips every CardRun outcome, including `reclaimed`', () => {
		// `reclaimed` is the newest member of the union; if the validator did not
		// know it, the outcome would be silently dropped on load and a reclaimed
		// run would read back as an unexplained failure.
		seedBoards(projectRoot, [
			board([
				card({
					id: 'a',
					runs: [
						{ attempt: 1, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'reclaimed' },
						{ attempt: 2, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'error' },
						{ attempt: 3, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'blocked' },
						{ attempt: 4, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'done' },
					],
				}),
			]),
		]);
		expect(loadBoards(projectRoot)[0].cards[0].runs?.map((r) => r.outcome)).toEqual([
			'reclaimed',
			'error',
			'blocked',
			'done',
		]);
	});

	it('getBoard returns a board and rejects missing legacy identity', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(getBoard(projectRoot, 'b1')?.id).toBe('b1');
		expect(() => getBoard(projectRoot, 'nope')).toThrow(BoardStorageError);
	});

	it('listBoards is an alias for loadBoards', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(listBoards(projectRoot)).toEqual(loadBoards(projectRoot));
	});
});

describe('board-storage cycle rejection', () => {
	it('rejects saving a board with a cyclic parent graph', () => {
		const cyclic = board([card({ id: 'a', parents: ['b'] }), card({ id: 'b', parents: ['a'] })]);
		seedBoards(projectRoot, [board([])]);
		cyclic.storage = getBoard(projectRoot, 'b1')!.storage;
		const before = loadBoards(projectRoot);
		expect(() => saveBoards(projectRoot, [cyclic])).toThrow(/cyclic/i);
		// Nothing should have been written.
		expect(loadBoards(projectRoot)).toEqual(before);
	});

	it('rejects an addCard that would introduce a cycle', () => {
		// a depends on b; adding b that depends on a closes the loop.
		seedBoards(projectRoot, [board([card({ id: 'a', parents: ['b'] })])]);
		expect(() => addCard(projectRoot, 'b1', card({ id: 'b', parents: ['a'] }))).toThrow(/cyclic/i);
	});
});

describe('board-storage malformed handling', () => {
	it('quarantines malformed cards with their valid siblings without losing source bytes', () => {
		const raw = yaml.dump({
			boards: [
				{
					id: 'b1',
					name: 'Board',
					cards: [
						{
							id: 'good',
							title: 'Valid',
							body: '',
							assigneeProfileId: 'p1',
							parents: [],
							status: 'todo',
							createdAt: '2026-07-10T00:00:00.000Z',
							updatedAt: '2026-07-10T00:00:00.000Z',
						},
						{ id: 'no-title', assigneeProfileId: 'p1', status: 'todo' }, // missing title
						{ id: 'bad-status', title: 'X', assigneeProfileId: 'p1', status: 'nonsense' },
						'not-an-object',
					],
				},
			],
		});
		const imported = importBytes(raw);

		const boards = loadBoards(projectRoot);
		expect(boards).toEqual([]);
		expect(imported.result.mapping.boards[0].collectionKey).toBeNull();
		expect(imported.plan.boards[0].cards.map((c) => c.legacyId)).toEqual([
			'good',
			'no-title',
			'bad-status',
			null,
		]);
		expect(Buffer.from(imported.plan.snapshot.boardBase64!, 'base64').toString()).toBe(raw);
	});

	it('quarantines a board missing its id/name envelope', () => {
		const raw = yaml.dump({ boards: [{ name: 'No id', cards: [] }] });
		importBytes(raw);
		expect(loadBoards(projectRoot)).toEqual([]);
	});

	it('throws (fails closed) on unparseable YAML instead of reading as empty', () => {
		expect(() => importBytes(':\n\t- broken: [unbalanced')).toThrow();
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 0 });
	});

	it('quarantines both duplicate board ids instead of selecting a winner', () => {
		const raw = yaml.dump({
			boards: [
				{ id: 'dup', name: 'First', cards: [] },
				{ id: 'dup', name: 'Second', cards: [] },
			],
		});
		const imported = importBytes(raw);
		const boards = loadBoards(projectRoot);
		expect(boards).toEqual([]);
		expect(imported.result.mapping.boards.map((b) => b.collectionKey)).toEqual([null, null]);
		expect(imported.plan.boards.map((b) => (b.raw as Board).name)).toEqual(['First', 'Second']);
	});
});

describe('board-storage fail-closed imports and identities', () => {
	const CORRUPT = ':\n\t- broken: [unbalanced';
	it('rejects missing source identity instead of silently reading an empty workspace', () => {
		expect(() => loadBoards(projectRoot)).toThrow(BoardStorageError);
	});
	it('accepts empty input and an absent boards key as empty migration plans', () => {
		const { plan } = importBytes('');
		expect(plan.boards).toEqual([]);
		expect(loadBoards(projectRoot)).toEqual([]);
		const other = planBoardMigration({
			source: { location: { kind: 'local' }, path: projectRoot },
			repository: null,
			boardBytes: Buffer.from('somethingElse: true\n'),
			profileBytes: null,
			workers: [],
		});
		expect(other.boards).toEqual([]);
	});
	it('rejects corrupt input without creating a ledger or collection', () => {
		expect(() => importBytes(CORRUPT)).toThrow();
		for (const table of ['migrations', 'collections', 'cards'])
			expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
	});
	it('rejects a non-list boards value at the import boundary', () => {
		expect(() => importBytes('boards: not-a-list\n')).toThrow(/Invalid legacy/);
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 0 });
	});
	it('does not truncate corrupt legacy bytes when a mutation is attempted', () => {
		expect(() => importBytes(CORRUPT)).toThrow();
		expect(() => addCard(projectRoot, 'b1', card({ id: 'x' }))).toThrow(BoardStorageError);
		expect(fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH), 'utf8')).toBe(CORRUPT);
	});
	it('rejects missing identity on mutations while explicit bootstrap leaves corrupt legacy bytes intact', () => {
		writeRawYaml(CORRUPT);
		expect(() => updateCard(projectRoot, 'b1', card({ id: 'a' }))).toThrow(BoardStorageError);
		expect(() => updateCardStatus(projectRoot, 'b1', 'a', 'done')).toThrow(BoardStorageError);
		expect(() => deleteCard(projectRoot, 'b1', 'a')).toThrow(BoardStorageError);
		expect(() => getBoard(projectRoot, 'b1')).toThrow(BoardStorageError);
		expect(() => listBoards(projectRoot)).toThrow(BoardStorageError);
		const created = createBoard(projectRoot, 'New');
		expect(getBoard(projectRoot, created.id)!.cards).toEqual([]);
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 0 });
		expect(fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH), 'utf8')).toBe(CORRUPT);
	});
});

describe('board-storage atomic + serialized writes', () => {
	it('persists centrally without creating YAML or temp files on bootstrap', () => {
		const created = createBoard(projectRoot, 'New');
		addCard(projectRoot, created.id, card({ id: 'a' }));
		reopen();
		expect(getBoard(projectRoot, created.id)!.cards[0].id).toBe('a');
		expect(fs.existsSync(path.join(projectRoot, BOARD_CONFIG_PATH))).toBe(false);
		expect(fs.existsSync(path.join(projectRoot, `${BOARD_CONFIG_PATH}.tmp`))).toBe(false);
	});

	it('rolls back collection, card and revision writes after a SQLite write failure', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' })], { name: 'Original' })]);
		const before = loadBoards(projectRoot);
		const revision = db.prepare('SELECT revision FROM workspace').get();
		const legacy = fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH));
		const changed = structuredClone(before[0]);
		changed.name = 'Replacement';
		changed.cards[0].title = 'Changed before failure';
		changed.cards.push(card({ id: 'b' }));
		db.exec(
			"CREATE TEMP TRIGGER fail_card BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'simulated SQLite failure'); END"
		);
		expect(() => saveBoards(projectRoot, [changed])).toThrow(/simulated SQLite failure/);
		expect(loadBoards(projectRoot)).toEqual(before);
		expect(db.prepare('SELECT revision FROM workspace').get()).toEqual(revision);
		db.exec('DROP TRIGGER fail_card');
		reopen();
		expect(loadBoards(projectRoot)).toEqual(before);
		expect(fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH))).toEqual(legacy);
	});

	it('applies two racing enqueued saves in call order', async () => {
		seedBoards(projectRoot, [board([])]);
		const order: string[] = [];

		// The first job yields before writing; without serialization the second
		// would land first and then be clobbered by the first job's stale write.
		const first = enqueueBoardWrite(projectRoot, async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push('first');
			addCard(projectRoot, 'b1', card({ id: 'first' }));
		});
		const second = enqueueBoardWrite(projectRoot, async () => {
			order.push('second');
			addCard(projectRoot, 'b1', card({ id: 'second' }));
		});
		await Promise.all([first, second]);

		expect(order).toEqual(['first', 'second']);
		// Both writes survive: neither read-modify-write cycle saw stale state.
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['first', 'second']);
	});

	it('does not let a rejected job poison the ones queued behind it', async () => {
		seedBoards(projectRoot, [board([])]);
		const failed = enqueueBoardWrite(projectRoot, () => {
			throw new Error('boom');
		});
		await expect(failed).rejects.toThrow(/boom/);

		await enqueueBoardWrite(projectRoot, () => addCard(projectRoot, 'b1', card({ id: 'after' })));
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['after']);
	});
});

describe('board-storage card mutations', () => {
	it.each(['ready', 'running'] as const)(
		'rejects a new card with dispatcher-owned %s status',
		(status) => {
			seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
			expect(() => addCard(projectRoot, 'b1', card({ id: 'new', status }))).toThrow(
				'dispatcher-owned status'
			);
			expect(getBoard(projectRoot, 'b1')?.cards.map((c) => c.id)).toEqual(['a']);
		}
	);
	it('permits author-owned review status without changing persisted running validation', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		expect(
			addCard(projectRoot, 'b1', card({ id: 'review', status: 'review' })).cards.at(-1)?.status
		).toBe('review');
	});
	it('addCard appends and persists a card', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		const updated = addCard(projectRoot, 'b1', card({ id: 'b', parents: ['a'] }));
		expect(updated.cards.map((c) => c.id)).toEqual(['a', 'b']);
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('addCard rejects a duplicate card id', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		expect(() => addCard(projectRoot, 'b1', card({ id: 'a' }))).toThrow(/already exists/i);
	});

	it('addCard throws for an unknown board', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		expect(() => addCard(projectRoot, 'ghost', card({ id: 'z' }))).toThrow(/not found/i);
	});

	it('updateCardStatus changes status and stamps updatedAt', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		const updated = updateCardStatus(projectRoot, 'b1', 'a', 'blocked');
		const a = updated.cards.find((c) => c.id === 'a')!;
		expect(a.status).toBe('blocked');
		expect(a.updatedAt).not.toBe('2026-07-10T00:00:00.000Z');
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('blocked');
	});

	it('updateCardStatus throws for a missing card', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		expect(() => updateCardStatus(projectRoot, 'b1', 'ghost', 'done')).toThrow(/not found/i);
	});

	it.each(['ready', 'running'] as const)(
		'updateCardStatus rejects the dispatcher-derived status "%s"',
		(derived) => {
			seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
			expect(() => updateCardStatus(projectRoot, 'b1', 'a', derived)).toThrow(
				/set by the dispatcher/i
			);
			// Rejected before any write: the card keeps its previous status.
			expect(loadBoards(projectRoot)[0].cards[0].status).toBe('done');
		}
	);

	it.each(['triage', 'todo', 'review', 'blocked', 'done'] as const)(
		'updateCardStatus still accepts the author-owned status "%s"',
		(manual) => {
			seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
			expect(updateCardStatus(projectRoot, 'b1', 'a', manual).cards[0].status).toBe(manual);
		}
	);

	// Status movement cannot release Stop/resume holds or grant dispatch approval.
	it('updateCardStatus preserves a user hold until explicit resume', () => {
		seedBoards(projectRoot, [board([card({ id: 'held', status: 'todo', heldByUser: true })])]);
		const updated = updateCardStatus(projectRoot, 'b1', 'held', 'todo');
		expect(updated.cards[0].heldByUser).toBe(true);
		expect(loadBoards(projectRoot)[0].cards[0].heldByUser).toBe(true);
	});

	// Regression: the `CardStatus` parameter type is erased at runtime, and this
	// sits behind an IPC boundary. An off-enum string was written through, and
	// the load-side validator then dropped the card entirely - a silent delete
	// of the user's work with no error surfaced to the caller.
	it.each(['teleported', '', 'DONE', 'done ', '__proto__'])(
		'updateCardStatus rejects the off-enum status "%s" without destroying the card',
		(bogus) => {
			seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
			expect(() =>
				updateCardStatus(projectRoot, 'b1', 'a', bogus as unknown as CardStatus)
			).toThrow(/not a valid card status/i);
			// The card must still be on the board, with its previous status intact.
			const cards = loadBoards(projectRoot)[0].cards;
			expect(cards.map((c) => c.id)).toContain('a');
			expect(cards.find((c) => c.id === 'a')?.status).toBe('done');
		}
	);

	it('retains omitted run history and an active user hold during metadata edits', () => {
		const runs = [{ attempt: 1, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'done' as const }];
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'todo', runs, heldByUser: true })])]);
		updateCard(projectRoot, 'b1', {
			...getBoard(projectRoot, 'b1')!.cards[0],
			runs: undefined,
			heldByUser: undefined,
			title: 'Edited',
		});
		expect(loadBoards(projectRoot)[0].cards[0]).toMatchObject({
			title: 'Edited',
			runs,
			heldByUser: true,
		});
	});
	it('rejects clearing a hold and historical runs through metadata CRUD', () => {
		seedBoards(projectRoot, [
			board([
				card({
					id: 'a',
					status: 'todo',
					heldByUser: true,
					runs: [{ attempt: 1, startedAt: '2026-07-10T00:00:00.000Z', outcome: 'done' }],
				}),
			]),
		]);
		const before = loadBoards(projectRoot);
		expect(() =>
			updateCard(projectRoot, 'b1', { ...before[0].cards[0], heldByUser: false, runs: [] })
		).toThrow(BoardStorageError);
		expect(loadBoards(projectRoot)).toEqual(before);
	});
	it.each(['ready', 'running'] as const)(
		'rejects introducing dispatcher-owned %s through card edits',
		(status) => {
			seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
			expect(() =>
				updateCard(projectRoot, 'b1', { ...getBoard(projectRoot, 'b1')!.cards[0], status })
			).toThrow(/set by the dispatcher/);
			expect(loadBoards(projectRoot)[0].cards[0].status).toBe('done');
		}
	);
	it.each(['todo', 'ready', 'running', 'done', 'blocked'] as const)(
		'rejects a stale %s metadata draft after another status transition',
		(status) => {
			const storedStatus = status === 'running' ? 'done' : 'running';
			seedBoards(projectRoot, [board([card({ id: 'a', status: storedStatus, title: 'Current' })])]);
			expect(() =>
				updateCard(projectRoot, 'b1', {
					...getBoard(projectRoot, 'b1')!.cards[0],
					status,
					title: 'Stale',
				})
			).toThrow();
			expect(loadBoards(projectRoot)[0].cards[0]).toMatchObject({
				status: storedStatus,
				title: 'Current',
			});
		}
	);

	it('rejects task changes while its current instructions are executing', () => {
		seedBoards(projectRoot, [
			board([card({ id: 'a', status: 'running', title: 'Executing task' })]),
		]);
		const before = loadBoards(projectRoot);
		expect(() =>
			updateCard(projectRoot, 'b1', {
				...getBoard(projectRoot, 'b1')!.cards[0],
				title: 'Replacement task',
			})
		).toThrow(/running cards cannot be edited/);
		expect(loadBoards(projectRoot)).toEqual(before);
	});

	it('updateCard replaces fields in place and preserves createdAt', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		const updated = updateCard(projectRoot, 'b1', {
			...getBoard(projectRoot, 'b1')!.cards[0],
			title: 'Renamed',
			body: 'new body',
		});
		const a = updated.cards.find((c) => c.id === 'a')!;
		expect(a.title).toBe('Renamed');
		expect(a.body).toBe('new body');
		expect(a.createdAt).toBe('2026-07-10T00:00:00.000Z');
	});

	it('deleteCard removes only the matching card', () => {
		seedBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
		addCard(projectRoot, 'b1', card({ id: 'b' }));
		const updated = deleteCard(projectRoot, 'b1', 'a');
		expect(updated.cards.map((c) => c.id)).toEqual(['b']);
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['b']);
	});
});

describe('deleteCard referential integrity', () => {
	it('splices the deleted id out of every other card`s parents', () => {
		seedBoards(projectRoot, [
			board([
				card({ id: 'a', status: 'done' }),
				card({ id: 'b', parents: ['a'] }),
				card({ id: 'c', parents: ['a'] }),
			]),
		]);
		deleteCard(projectRoot, 'b1', 'a');
		const cards = loadBoards(projectRoot)[0].cards;
		// No child is left pointing at a card that no longer exists - a dangling
		// parent id reads as a permanent blocker and wedges the child forever.
		expect(cards.find((c) => c.id === 'b')!.parents).toEqual([]);
		expect(cards.find((c) => c.id === 'c')!.parents).toEqual([]);
	});

	it('reattaches the deleted card`s parents to its children (grandparent adoption)', () => {
		// A -> B -> C. Deleting the middle card must not let C run before A.
		seedBoards(projectRoot, [
			board([
				card({ id: 'a' }),
				card({ id: 'b', parents: ['a'] }),
				card({ id: 'c', parents: ['b'] }),
			]),
		]);
		deleteCard(projectRoot, 'b1', 'b');
		const cards = loadBoards(projectRoot)[0].cards;
		expect(cards.map((c) => c.id)).toEqual(['a', 'c']);
		expect(cards.find((c) => c.id === 'c')!.parents).toEqual(['a']);
	});

	it('does not duplicate a parent the child already had', () => {
		seedBoards(projectRoot, [
			board([
				card({ id: 'a' }),
				card({ id: 'b', parents: ['a'] }),
				card({ id: 'c', parents: ['a', 'b'] }),
			]),
		]);
		deleteCard(projectRoot, 'b1', 'b');
		expect(loadBoards(projectRoot)[0].cards.find((c) => c.id === 'c')!.parents).toEqual(['a']);
	});

	it('never makes a card its own parent, and keeps the graph acyclic', () => {
		// Deleting `b` would hand `c` a parent list containing `c` itself if the
		// self-edge were not filtered - and saveBoards would then reject the write.
		seedBoards(projectRoot, [
			board([
				card({ id: 'c' }),
				card({ id: 'b', parents: ['c'] }),
				card({ id: 'd', parents: ['b'] }),
			]),
		]);
		deleteCard(projectRoot, 'b1', 'b');
		const cards = loadBoards(projectRoot)[0].cards;
		expect(cards.find((c) => c.id === 'd')!.parents).toEqual(['c']);
		expect(cards.find((c) => c.id === 'c')!.parents).toEqual([]);
	});

	it('leaves unrelated cards untouched and is a no-op for an unknown id', () => {
		seedBoards(projectRoot, [board([card({ id: 'a' }), card({ id: 'b', parents: ['a'] })])]);
		const before = loadBoards(projectRoot);
		deleteCard(projectRoot, 'b1', 'ghost');
		expect(loadBoards(projectRoot)).toEqual(before);
	});
});

describe('central storage fixture', () => {
	it('shares revisioned CRUD across sources without changing YAML or referenced runs', () => {
		const dbPath = path.join(projectRoot, 'board.sqlite');
		let db = openBoardDb(dbPath);
		const inputs = ['a', 'b'].map((name) => {
			const project = path.join(projectRoot, name);
			fs.mkdirSync(path.join(project, '.maestro'), { recursive: true });
			const bytes = Buffer.from(
				JSON.stringify({
					boards: [
						{
							id: 'board',
							name,
							cards: [
								card({
									id: 'same',
									heldByUser: true,
									runs: [{ attempt: 1, startedAt: 'then', outcome: 'done' }],
								}),
							],
						},
					],
				})
			);
			const file = path.join(project, '.maestro', 'board.yaml');
			fs.writeFileSync(file, bytes);
			const plan = planBoardMigration({
				source: { location: { kind: 'local' }, path: project },
				repository: { id: name, workingDirectory: project, validated: true },
				boardBytes: bytes,
				profileBytes: null,
				workers: [],
			});
			applyBoardMigration(db, plan);
			return { project, file, bytes, plan };
		});
		try {
			configureBoardStorage(new BoardStorageFacade(db));
			const [a, b] = inputs;
			const old = getBoard(a.project, 'board')!;
			const stale = structuredClone(old);
			const runs = db.prepare('SELECT * FROM runs ORDER BY run_id').all();
			renameBoard(a.project, 'board', 'Edited');
			stale.name = 'Stale';
			expect(() => saveBoards(a.project, [stale])).toThrow(BoardWorkspaceStorageError);
			const edit = getBoard(a.project, 'board')!.cards[0];
			edit.title = 'Updated';
			updateCard(a.project, 'board', edit);
			addCard(a.project, 'board', card({ id: 'child', parents: ['same'] }));
			expect(getBoard(a.project, 'board')!.cards).toHaveLength(2);
			expect(getBoard(b.project, 'board')!.name).toBe('b');
			expect(getBoard(a.project, 'board')!.cards[0].heldByUser).toBe(true);
			expect(db.prepare('SELECT * FROM runs ORDER BY run_id').all()).toEqual(runs);
			expect(db.pragma('foreign_key_check')).toEqual([]);
			for (const item of inputs) expect(fs.readFileSync(item.file)).toEqual(item.bytes);
			configureBoardStorage(null);
			db.close();
			db = openBoardDb(dbPath);
			configureBoardStorage(new BoardStorageFacade(db));
			expect(getBoard(a.project, 'board')!.cards[0].title).toBe('Updated');
			expect(applyBoardMigration(db, a.plan).status).toBe('already-imported');
		} finally {
			configureBoardStorage(null);
			db.close();
		}
	});
});
