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

import { boardList, boardShow, boardAddCard, boardSetStatus } from '../../../cli/commands/board';
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

	it('board list --json prints all boards in the project', async () => {
		createBoard(projectRoot, 'My Board');
		await boardList({ agent: 'Alpha', json: true });
		const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
		const parsed = JSON.parse(output);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe('My Board');
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

	it('exits non-zero when the agent cannot be resolved', async () => {
		mockGetSessionById.mockReturnValue(undefined);
		await boardList({ agent: 'ghost', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
