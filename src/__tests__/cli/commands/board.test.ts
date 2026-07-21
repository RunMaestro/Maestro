/**
 * @file board.test.ts
 * @description Integration tests for `maestro-cli board` (Phase 5). Exercises
 * the storage-driven commands (list / show / add-card / set-status) end-to-end
 * against a real temp project root so the `.maestro/board.yaml` round-trip is
 * asserted on disk. Only the agent lookup (`storage`) is mocked; the board
 * storage module runs unmodified. `board tick`'s spawn path is covered by the
 * dispatcher/decompose unit tests, not re-driven here.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockGetSessionById = vi.fn();
const mockResolveAgentId = vi.fn();
const mockReadSessions = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: (id: string) => mockGetSessionById(id),
	resolveAgentId: (partial: string) => mockResolveAgentId(partial),
	readSessions: () => mockReadSessions(),
}));

import {
	boardList,
	boardCreate,
	boardRename,
	boardDelete,
	boardShow,
	boardAddCard,
	boardUpdateCard,
	boardRemoveCard,
	boardSetStatus,
	boardWatch,
} from '../../../cli/commands/board';
import { createBoard, addCard, loadBoards } from '../../../main/board/board-storage';
import type { BoardCard } from '../../../shared/board/types';

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: `Card ${id}`,
		body: '',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo',
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		...overrides,
	};
}

describe('maestro-cli board', () => {
	let projectRoot = '';
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'));
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		mockResolveAgentId.mockReturnValue('agent-1');
		mockGetSessionById.mockReturnValue({
			id: 'agent-1',
			name: 'Alpha',
			toolType: 'claude-code',
			projectRoot,
			cwd: projectRoot,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('board create then board list round-trips through .maestro/board.yaml', async () => {
		await boardCreate('Bootstrapped', { agent: 'Alpha', json: true });
		const created = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(created.name).toBe('Bootstrapped');
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'board.yaml'))).toBe(true);

		logSpy.mockClear();
		await boardList({ agent: 'Alpha', json: true });
		const listed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(listed).toHaveLength(1);
		expect(listed[0].id).toBe(created.id);
	});

	it('board create maps --max-in-progress and --auto-decompose onto the board', async () => {
		await boardCreate('Capped', {
			agent: 'Alpha',
			maxInProgress: '3',
			autoDecompose: true,
			json: true,
		});
		const board = loadBoards(projectRoot)[0];
		expect(board.maxInProgress).toBe(3);
		expect(board.autoDecompose).toBe(true);
	});

	it('board create rejects a non-positive --max-in-progress', async () => {
		await boardCreate('Bad', { agent: 'Alpha', maxInProgress: '0', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)).toHaveLength(0);
	});

	it('board create requires a name', async () => {
		await boardCreate('   ', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)).toHaveLength(0);
	});

	it('board list --json prints all boards in the project', async () => {
		createBoard(projectRoot, 'My Board');
		await boardList({ agent: 'Alpha', json: true });
		const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
		const parsed = JSON.parse(output);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe('My Board');
	});

	it('board rename renames a board by id prefix', async () => {
		const b = createBoard(projectRoot, 'Old name');
		addCard(projectRoot, b.id, card('c1'));
		await boardRename(b.id.slice(0, 8), 'New name', { agent: 'Alpha', json: true });
		const reloaded = loadBoards(projectRoot)[0];
		expect(reloaded.name).toBe('New name');
		expect(reloaded.cards).toHaveLength(1);
	});

	it('board rename rejects a blank name', async () => {
		const b = createBoard(projectRoot, 'Keep me');
		await boardRename(b.id, '   ', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].name).toBe('Keep me');
	});

	it('board delete removes a board whose cards are all done', async () => {
		const b = createBoard(projectRoot, 'Finished');
		addCard(projectRoot, b.id, card('c1', { status: 'done' }));
		await boardDelete(b.id, { agent: 'Alpha', json: true });
		expect(loadBoards(projectRoot)).toHaveLength(0);
	});

	it('board delete refuses unfinished cards without --force', async () => {
		const b = createBoard(projectRoot, 'Busy');
		addCard(projectRoot, b.id, card('c1', { status: 'running' }));
		await boardDelete(b.id, { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)).toHaveLength(1);
	});

	it('board delete --force removes a board with unfinished cards', async () => {
		const b = createBoard(projectRoot, 'Busy');
		addCard(projectRoot, b.id, card('c1', { status: 'running' }));
		await boardDelete(b.id, { agent: 'Alpha', force: true, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(loadBoards(projectRoot)).toHaveLength(0);
	});

	it('board show --json prints the board and its cards', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { title: 'First' }));
		await boardShow(b.id, { agent: 'Alpha', json: true });
		const parsed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(parsed.cards).toHaveLength(1);
		expect(parsed.cards[0].title).toBe('First');
	});

	it('board add-card appends a card via the storage layer', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'New card',
			assignee: 'profile-x',
			body: 'do it',
			parents: '',
			json: true,
		});
		const boards = loadBoards(projectRoot);
		expect(boards[0].cards).toHaveLength(1);
		expect(boards[0].cards[0].title).toBe('New card');
		expect(boards[0].cards[0].assigneeProfileId).toBe('profile-x');
		expect(boards[0].cards[0].status).toBe('todo');
	});

	it('board add-card --worktree records an advisory worktree ref', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Isolated',
			assignee: 'p1',
			worktree: true,
			json: true,
		});
		const created = loadBoards(projectRoot)[0].cards[0];
		expect(created.worktree?.path).toContain(path.join('.maestro', 'worktrees'));
	});

	it('board add-card --priority stores high/low and drops the default', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Urgent',
			assignee: 'p1',
			priority: 'high',
			json: true,
		});
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Ordinary',
			assignee: 'p1',
			priority: 'normal',
			json: true,
		});
		const cards = loadBoards(projectRoot)[0].cards;
		expect(cards.find((c) => c.title === 'Urgent')?.priority).toBe('high');
		expect(cards.find((c) => c.title === 'Ordinary')?.priority).toBeUndefined();
	});

	it('board add-card rejects an invalid --priority', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Typo',
			assignee: 'p1',
			priority: 'urgent',
			json: true,
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(0);
	});

	it('board add-card wires comma-separated parents', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('a'));
		addCard(projectRoot, b.id, card('b'));
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Child',
			assignee: 'p1',
			parents: 'a, b',
			json: true,
		});
		const child = loadBoards(projectRoot)[0].cards.find((c) => c.title === 'Child')!;
		expect(child.parents).toEqual(['a', 'b']);
	});

	it('board update-card edits only the fields it was given', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { title: 'Before', body: 'keep me', priority: 'low' }));
		await boardUpdateCard('c1', { agent: 'Alpha', title: 'After', json: true });
		const updated = loadBoards(projectRoot)[0].cards[0];
		expect(updated.title).toBe('After');
		expect(updated.body).toBe('keep me');
		expect(updated.priority).toBe('low');
		expect(updated.assigneeProfileId).toBe('p1');
	});

	it('board update-card rewrites assignee, parents and priority', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('a'));
		addCard(projectRoot, b.id, card('c1', { parents: ['a'] }));
		await boardUpdateCard('c1', {
			agent: 'Alpha',
			assignee: '',
			assigneeAgent: 'agent-9',
			parents: '',
			priority: 'high',
			worktree: true,
			json: true,
		});
		const updated = loadBoards(projectRoot)[0].cards.find((c) => c.id === 'c1')!;
		expect(updated.assigneeProfileId).toBeUndefined();
		expect(updated.assigneeAgentId).toBe('agent-9');
		expect(updated.parents).toEqual([]);
		expect(updated.priority).toBe('high');
		expect(updated.worktree?.branch).toBe('board/c1');
	});

	it('board update-card --priority normal clears an explicit priority', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { priority: 'high' }));
		await boardUpdateCard('c1', { agent: 'Alpha', priority: 'normal', json: true });
		expect(loadBoards(projectRoot)[0].cards[0].priority).toBeUndefined();
	});

	it('board update-card refuses a running card', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { status: 'running', title: 'Live' }));
		await boardUpdateCard('c1', { agent: 'Alpha', title: 'Nope', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].title).toBe('Live');
	});

	it('board update-card refuses to strip the last assignee', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardUpdateCard('c1', { agent: 'Alpha', assignee: '', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].assigneeProfileId).toBe('p1');
	});

	it('board update-card refuses a parents edit that would close a cycle', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('a'));
		addCard(projectRoot, b.id, card('c1', { parents: ['a'] }));
		await boardUpdateCard('a', { agent: 'Alpha', parents: 'c1', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards.find((c) => c.id === 'a')?.parents).toEqual([]);
	});

	it('board update-card requires at least one field', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardUpdateCard('c1', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('board remove-card deletes a card and re-parents its children', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('a'));
		addCard(projectRoot, b.id, card('mid', { parents: ['a'] }));
		addCard(projectRoot, b.id, card('leaf', { parents: ['mid'] }));
		await boardRemoveCard('mid', { agent: 'Alpha', json: true });
		const cards = loadBoards(projectRoot)[0].cards;
		expect(cards.map((c) => c.id)).toEqual(['a', 'leaf']);
		expect(cards.find((c) => c.id === 'leaf')?.parents).toEqual(['a']);
	});

	it('board remove-card refuses a running card without --force', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { status: 'running' }));
		await boardRemoveCard('c1', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(1);
	});

	it('board remove-card --force removes a running card', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { status: 'running' }));
		await boardRemoveCard('c1', { agent: 'Alpha', force: true, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(0);
	});

	it('board set-status moves a card and auto-resolves its board', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardSetStatus('c1', 'done', { agent: 'Alpha', json: true });
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('done');
	});

	it('board set-status rejects an invalid status', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardSetStatus('c1', 'bogus', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('todo');
	});

	// `board watch` is a loop, so every test here drives exactly one iteration and
	// then stops it: SIGINT both sets the stop flag and wakes the interval sleep,
	// so no fake timers (and no 30-second test) are needed.
	describe('board watch', () => {
		beforeEach(() => {
			mockReadSessions.mockReturnValue([]);
		});

		it('ticks once, prints a one-line summary, and stops on SIGINT', async () => {
			const b = createBoard(projectRoot, 'Watched');
			// The card names a profile that does not exist, so the iteration resolves
			// deterministically (promote -> unresolvable -> blocked) without spawning.
			addCard(projectRoot, b.id, card('c1'));

			const watching = boardWatch({ agent: 'Alpha', interval: '5', json: true });
			await vi.waitFor(() => {
				expect(logSpy.mock.calls.some((c) => String(c[0]).includes('watch-tick'))).toBe(true);
			});
			process.emit('SIGINT');
			await watching;

			const tick = JSON.parse(
				logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('watch-tick'))!
			);
			expect(tick.boards[0].promoted).toBe(1);
			expect(tick.boards[0].blocked).toBe(1);
			expect(loadBoards(projectRoot)[0].cards[0].status).toBe('blocked');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('exits non-zero when the board file fails to load (fail-closed)', async () => {
			fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
			fs.writeFileSync(path.join(projectRoot, '.maestro', 'board.yaml'), 'boards: [', 'utf-8');
			await boardWatch({ agent: 'Alpha', interval: '5', json: true });
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an --interval below the minimum, and a non-numeric one', async () => {
			await boardWatch({ agent: 'Alpha', interval: '1', json: true });
			await boardWatch({ agent: 'Alpha', interval: 'soon', json: true });
			expect(exitSpy).toHaveBeenCalledTimes(2);
		});
	});

	it('exits non-zero when the agent cannot be resolved', async () => {
		mockGetSessionById.mockReturnValue(undefined);
		await boardList({ agent: 'ghost', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
