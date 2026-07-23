/**
 * @file storage.test.ts
 * @description Tests for the Board YAML storage: round-trip persistence, cycle
 * rejection on save, malformed-card skipping, and card-level mutations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
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

const renameFailure = vi.hoisted(() => ({ active: false }));

// Partial `fs` mock so the crash-safety test can fail the rename step only.
// vi.spyOn cannot patch an ESM namespace export, and the whole point of the
// atomic write is what happens when the process dies between temp-write and
// rename, so this is the only way to exercise it.
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		default: actual,
		renameSync: (from: fs.PathLike, to: fs.PathLike) => {
			if (renameFailure.active) throw new Error('simulated crash before rename');
			return actual.renameSync(from, to);
		},
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

let projectRoot: string;

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-board-'));
});

afterEach(() => {
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

describe('createBoard', () => {
	it('creates an empty board with a minted id and trimmed name, persisted to disk', () => {
		const created = createBoard(projectRoot, '  Backend rework  ');
		expect(created.name).toBe('Backend rework');
		expect(created.id).toBeTruthy();
		expect(created.cards).toEqual([]);

		// It round-trips through the YAML store.
		const reloaded = getBoard(projectRoot, created.id);
		expect(reloaded).not.toBeNull();
		expect(reloaded?.name).toBe('Backend rework');
	});

	it('rejects a blank name', () => {
		expect(() => createBoard(projectRoot, '   ')).toThrow(/name is required/);
	});

	it('appends alongside existing boards without disturbing them', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })], { id: 'existing', name: 'Existing' })]);
		const created = createBoard(projectRoot, 'Second');
		const all = listBoards(projectRoot);
		expect(all.map((b) => b.id).sort()).toEqual(['existing', created.id].sort());
	});
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
		expect(listBoards(projectRoot)).toHaveLength(0);
	});
});

describe('renameBoard', () => {
	it('renames in place and leaves the cards untouched', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })])]);
		const renamed = renameBoard(projectRoot, 'b1', '  New name  ');
		expect(renamed.name).toBe('New name');
		const reloaded = getBoard(projectRoot, 'b1');
		expect(reloaded?.name).toBe('New name');
		expect(reloaded?.cards.map((c) => c.id)).toEqual(['a']);
	});

	it('rejects a blank name and an unknown board', () => {
		saveBoards(projectRoot, [board([])]);
		expect(() => renameBoard(projectRoot, 'b1', '   ')).toThrow(/name is required/);
		expect(() => renameBoard(projectRoot, 'nope', 'X')).toThrow(/not found/);
		expect(getBoard(projectRoot, 'b1')?.name).toBe('Test board');
	});

	it('does not disturb sibling boards', () => {
		saveBoards(projectRoot, [
			board([], { id: 'b1', name: 'One' }),
			board([], { id: 'b2', name: 'Two' }),
		]);
		renameBoard(projectRoot, 'b1', 'Renamed');
		expect(listBoards(projectRoot).map((b) => b.name)).toEqual(['Renamed', 'Two']);
	});
});

describe('deleteBoard', () => {
	it('deletes a board whose cards are all done and returns the remainder', () => {
		saveBoards(projectRoot, [
			board([card({ id: 'a', status: 'done' })], { id: 'b1', name: 'Finished' }),
			board([], { id: 'b2', name: 'Keep' }),
		]);
		const remaining = deleteBoard(projectRoot, 'b1');
		expect(remaining.map((b) => b.id)).toEqual(['b2']);
		expect(getBoard(projectRoot, 'b1')).toBeNull();
	});

	it('deletes an empty board without --force', () => {
		saveBoards(projectRoot, [board([])]);
		expect(deleteBoard(projectRoot, 'b1')).toEqual([]);
	});

	it('refuses without force when any card is not done, leaving the file intact', () => {
		saveBoards(projectRoot, [board([card({ id: 'a', status: 'done' }), card({ id: 'b' })])]);
		expect(() => deleteBoard(projectRoot, 'b1')).toThrow(/not done/);
		expect(getBoard(projectRoot, 'b1')?.cards).toHaveLength(2);
	});

	it('deletes unfinished cards with force', () => {
		saveBoards(projectRoot, [board([card({ id: 'a', status: 'running' })])]);
		expect(deleteBoard(projectRoot, 'b1', { force: true })).toEqual([]);
		expect(listBoards(projectRoot)).toEqual([]);
	});

	it('throws for an unknown board', () => {
		expect(() => deleteBoard(projectRoot, 'ghost')).toThrow(/not found/);
	});
});

describe('board-storage round-trip', () => {
	it('returns an empty list when no file exists', () => {
		expect(loadBoards(projectRoot)).toEqual([]);
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
		const filePath = saveBoards(projectRoot, boards);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(loadBoards(projectRoot)).toEqual(boards);
	});

	it('round-trips the optional autoDecompose flag (Phase 5)', () => {
		const boards = [board([card({ id: 'a' })], { autoDecompose: true })];
		saveBoards(projectRoot, boards);
		const reloaded = loadBoards(projectRoot);
		expect(reloaded[0].autoDecompose).toBe(true);
	});

	it('omits autoDecompose when off (default) so the file stays clean', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(loadBoards(projectRoot)[0].autoDecompose).toBeUndefined();
	});

	it('round-trips every CardRun outcome, including `reclaimed`', () => {
		// `reclaimed` is the newest member of the union; if the validator did not
		// know it, the outcome would be silently dropped on load and a reclaimed
		// run would read back as an unexplained failure.
		saveBoards(projectRoot, [
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

	it('getBoard returns a single board by id or null', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(getBoard(projectRoot, 'b1')?.id).toBe('b1');
		expect(getBoard(projectRoot, 'nope')).toBeNull();
	});

	it('listBoards is an alias for loadBoards', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(listBoards(projectRoot)).toEqual(loadBoards(projectRoot));
	});
});

describe('board-storage cycle rejection', () => {
	it('rejects saving a board with a cyclic parent graph', () => {
		const cyclic = board([card({ id: 'a', parents: ['b'] }), card({ id: 'b', parents: ['a'] })]);
		expect(() => saveBoards(projectRoot, [cyclic])).toThrow(/cyclic/i);
		// Nothing should have been written.
		expect(fs.existsSync(path.join(projectRoot, BOARD_CONFIG_PATH))).toBe(false);
	});

	it('rejects an addCard that would introduce a cycle', () => {
		// a depends on b; adding b that depends on a closes the loop.
		saveBoards(projectRoot, [board([card({ id: 'a', parents: ['b'] })])]);
		expect(() => addCard(projectRoot, 'b1', card({ id: 'b', parents: ['a'] }))).toThrow(/cyclic/i);
	});
});

describe('board-storage malformed handling', () => {
	it('skips malformed cards but keeps valid ones', () => {
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
		writeRawYaml(raw);

		const boards = loadBoards(projectRoot);
		expect(boards).toHaveLength(1);
		expect(boards[0].cards.map((c) => c.id)).toEqual(['good']);
	});

	it('drops a board missing its id/name envelope', () => {
		const raw = yaml.dump({ boards: [{ name: 'No id', cards: [] }] });
		writeRawYaml(raw);
		expect(loadBoards(projectRoot)).toEqual([]);
	});

	it('throws (fails closed) on unparseable YAML instead of reading as empty', () => {
		writeRawYaml(':\n\t- broken: [unbalanced');
		expect(() => loadBoards(projectRoot)).toThrow(BoardStorageError);
	});

	it('drops duplicate board ids, keeping the first', () => {
		const raw = yaml.dump({
			boards: [
				{ id: 'dup', name: 'First', cards: [] },
				{ id: 'dup', name: 'Second', cards: [] },
			],
		});
		writeRawYaml(raw);
		const boards = loadBoards(projectRoot);
		expect(boards).toHaveLength(1);
		expect(boards[0].name).toBe('First');
	});
});

describe('board-storage fail-closed loads', () => {
	const CORRUPT = ':\n\t- broken: [unbalanced';

	it('still returns [] when the file is simply missing', () => {
		expect(loadBoards(projectRoot)).toEqual([]);
	});

	it('treats an empty file and an absent `boards:` key as "no boards yet"', () => {
		writeRawYaml('');
		expect(loadBoards(projectRoot)).toEqual([]);
		writeRawYaml('somethingElse: true\n');
		expect(loadBoards(projectRoot)).toEqual([]);
	});

	it('throws a typed BoardStorageError naming the file on corrupt YAML', () => {
		writeRawYaml(CORRUPT);
		try {
			loadBoards(projectRoot);
			throw new Error('expected loadBoards to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(BoardStorageError);
			expect((err as BoardStorageError).filePath).toBe(path.join(projectRoot, BOARD_CONFIG_PATH));
		}
	});

	it('throws when `boards:` is present but is not a list', () => {
		writeRawYaml('boards: not-a-list\n');
		expect(() => loadBoards(projectRoot)).toThrow(BoardStorageError);
	});

	it('does NOT truncate the corrupt file when a mutation is attempted', () => {
		writeRawYaml(CORRUPT);
		const filePath = path.join(projectRoot, BOARD_CONFIG_PATH);

		// This is the data-loss bug: load used to return [], so the save that
		// followed wrote an empty board list over the user's whole board.
		expect(() => addCard(projectRoot, 'b1', card({ id: 'x' }))).toThrow(BoardStorageError);
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(CORRUPT);
	});

	it('propagates from every mutation path without writing', () => {
		writeRawYaml(CORRUPT);
		const filePath = path.join(projectRoot, BOARD_CONFIG_PATH);

		expect(() => createBoard(projectRoot, 'New')).toThrow(BoardStorageError);
		expect(() => updateCard(projectRoot, 'b1', card({ id: 'a' }))).toThrow(BoardStorageError);
		expect(() => updateCardStatus(projectRoot, 'b1', 'a', 'done')).toThrow(BoardStorageError);
		expect(() => deleteCard(projectRoot, 'b1', 'a')).toThrow(BoardStorageError);
		expect(() => getBoard(projectRoot, 'b1')).toThrow(BoardStorageError);
		expect(() => listBoards(projectRoot)).toThrow(BoardStorageError);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(CORRUPT);
	});
});

describe('board-storage atomic + serialized writes', () => {
	it('writes via a temp file that is renamed away, leaving no .tmp behind', () => {
		const filePath = saveBoards(projectRoot, [board([card({ id: 'a' })])]);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it('leaves the previous file fully intact when the write fails mid-way', () => {
		saveBoards(projectRoot, [board([card({ id: 'a' })], { name: 'Original' })]);
		const filePath = path.join(projectRoot, BOARD_CONFIG_PATH);
		const before = fs.readFileSync(filePath, 'utf-8');

		// Simulate a crash between "temp file written" and "rename over target".
		renameFailure.active = true;
		expect(() =>
			saveBoards(projectRoot, [board([card({ id: 'b' })], { name: 'Replacement' })])
		).toThrow(/simulated crash/);
		renameFailure.active = false;

		// The old content survived byte-for-byte - never truncated, never partial.
		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		expect(loadBoards(projectRoot)[0].name).toBe('Original');
		// And the aborted temp file was cleaned up.
		expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it('applies two racing enqueued saves in call order', async () => {
		saveBoards(projectRoot, [board([])]);
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
		saveBoards(projectRoot, [board([])]);
		const failed = enqueueBoardWrite(projectRoot, () => {
			throw new Error('boom');
		});
		await expect(failed).rejects.toThrow(/boom/);

		await enqueueBoardWrite(projectRoot, () => addCard(projectRoot, 'b1', card({ id: 'after' })));
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['after']);
	});
});

describe('board-storage card mutations', () => {
	beforeEach(() => {
		saveBoards(projectRoot, [board([card({ id: 'a', status: 'done' })])]);
	});

	it('addCard appends and persists a card', () => {
		const updated = addCard(projectRoot, 'b1', card({ id: 'b', parents: ['a'] }));
		expect(updated.cards.map((c) => c.id)).toEqual(['a', 'b']);
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('addCard rejects a duplicate card id', () => {
		expect(() => addCard(projectRoot, 'b1', card({ id: 'a' }))).toThrow(/already exists/i);
	});

	it('addCard throws for an unknown board', () => {
		expect(() => addCard(projectRoot, 'ghost', card({ id: 'z' }))).toThrow(/not found/i);
	});

	it('updateCardStatus changes status and stamps updatedAt', () => {
		const updated = updateCardStatus(projectRoot, 'b1', 'a', 'blocked');
		const a = updated.cards.find((c) => c.id === 'a')!;
		expect(a.status).toBe('blocked');
		expect(a.updatedAt).not.toBe('2026-07-10T00:00:00.000Z');
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('blocked');
	});

	it('updateCardStatus throws for a missing card', () => {
		expect(() => updateCardStatus(projectRoot, 'b1', 'ghost', 'done')).toThrow(/not found/i);
	});

	it.each(['ready', 'running'] as const)(
		'updateCardStatus rejects the dispatcher-derived status "%s"',
		(derived) => {
			expect(() => updateCardStatus(projectRoot, 'b1', 'a', derived)).toThrow(
				/set by the dispatcher/i
			);
			// Rejected before any write: the card keeps its previous status.
			expect(loadBoards(projectRoot)[0].cards[0].status).toBe('done');
		}
	);

	it.each(['triage', 'todo', 'blocked', 'done'] as const)(
		'updateCardStatus still accepts the author-owned status "%s"',
		(manual) => {
			expect(updateCardStatus(projectRoot, 'b1', 'a', manual).cards[0].status).toBe(manual);
		}
	);

	it('updateCard replaces fields in place and preserves createdAt', () => {
		const updated = updateCard(
			projectRoot,
			'b1',
			card({ id: 'a', title: 'Renamed', status: 'done', body: 'new body' })
		);
		const a = updated.cards.find((c) => c.id === 'a')!;
		expect(a.title).toBe('Renamed');
		expect(a.body).toBe('new body');
		expect(a.createdAt).toBe('2026-07-10T00:00:00.000Z');
	});

	it('deleteCard removes only the matching card', () => {
		addCard(projectRoot, 'b1', card({ id: 'b' }));
		const updated = deleteCard(projectRoot, 'b1', 'a');
		expect(updated.cards.map((c) => c.id)).toEqual(['b']);
		expect(loadBoards(projectRoot)[0].cards.map((c) => c.id)).toEqual(['b']);
	});
});

describe('deleteCard referential integrity', () => {
	it('splices the deleted id out of every other card`s parents', () => {
		saveBoards(projectRoot, [
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
		saveBoards(projectRoot, [
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
		saveBoards(projectRoot, [
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
		saveBoards(projectRoot, [
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
		saveBoards(projectRoot, [board([card({ id: 'a' }), card({ id: 'b', parents: ['a'] })])]);
		const before = fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH), 'utf-8');
		deleteCard(projectRoot, 'b1', 'ghost');
		expect(fs.readFileSync(path.join(projectRoot, BOARD_CONFIG_PATH), 'utf-8')).toBe(before);
	});
});
