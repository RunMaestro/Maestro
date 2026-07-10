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
	addCard,
	updateCard,
	updateCardStatus,
	deleteCard,
} from '../../../main/board/board-storage';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';

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

	it('returns an empty list on unparseable YAML', () => {
		writeRawYaml(':\n\t- broken: [unbalanced');
		expect(loadBoards(projectRoot)).toEqual([]);
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
