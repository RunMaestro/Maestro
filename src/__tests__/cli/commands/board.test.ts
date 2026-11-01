import { BOARD_SOURCE_PROJECT_PREFIX } from '../../../shared/board/types';
import { BoardRuntime } from '../../../main/board/board-runtime';
import { configureBoardRuntimeHost } from '../../../main/board/board-runtime-host';
import {
	registerBoardWorker,
	setBoardWorkerAccess,
} from '../../../main/board/board-workspace-storage';
import { autoDecomposeBoard } from '../../../main/board/board-decompose';
import { decomposeBoardCard, createBoardRunService } from '../../../main/board/board-spawn';
/**
 * @file board.test.ts
 * @description Integration tests for `maestro-cli board` (Phase 5). Exercises
 * the storage-driven commands (list / show / add-card / set-status) end-to-end
 * against a real temp project root so the `.maestro/board.yaml` round-trip is
 * asserted on disk. Only the agent lookup (`storage`) is mocked; the board
 * storage module runs unmodified. Tick/watch use the real host entry and fenced
 * runtime. Worktree tests inject only the native Cue process boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { substituteTemplateVariables } from '../../../shared/templateVariables';

const mockGetSessionById = vi.fn();
const mockResolveAgentId = vi.fn();
const mockReadSessions = vi.fn();
const mockReadSettingValue = vi.fn(() => ({ board: true, maestroCue: true }));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: (id: string) => mockGetSessionById(id),
	resolveAgentId: (partial: string) => mockResolveAgentId(partial),
	readSessions: () => mockReadSessions(),
	readSettingValue: () => mockReadSettingValue(),
}));

// Only the host's native Cue process is faked; CLI never calls a spawner.
const mockSpawnAgent = vi.fn();
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: async (session: any) =>
		substituteTemplateVariables('Write only within {{AGENT_PATH}}\n{{ADDITIONAL_DIRECTORIES}}', {
			session,
		}),
}));

vi.mock('../../../main/cue/cue-executor', () => ({
	executeCuePrompt: async (config: any) => {
		if (config.beforeLaunch && !config.beforeLaunch())
			return { stdout: '', exitCode: null, executionStarted: false };
		config.onStarted?.(202);
		const result = await mockSpawnAgent(
			config.toolType,
			config.projectRoot,
			config.promptPath,
			undefined,
			{
				appendSystemPrompt: config.appendSystemPrompt,
				additionalDirectories: config.session.additionalDirectories,
			}
		);
		return {
			stdout: result.response,
			exitCode: result.success ? 0 : 1,
			executionStarted: true,
			terminationConfirmed: true,
		};
	},
	stopCueRun: vi.fn(),
}));
vi.mock('../../../main/utils/maestro-system-prompt', () => ({
	buildMaestroSystemPromptForSession: async (session: any) =>
		substituteTemplateVariables('Write only within {{AGENT_PATH}}\n{{ADDITIONAL_DIRECTORIES}}', {
			session,
		}),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), cue: vi.fn() },
}));

// X1 task 8: `set-status done` fires the PR-on-done flow. The gh/git plumbing is
// stubbed at its lowest shared seam so the real `board-pr` gate, stamping and
// write-queue wiring all run for real (and no test ever touches a remote).
const mockCreatePullRequest = vi.fn();
vi.mock('../../../main/utils/pr-creator', () => ({
	createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: async (action: (connection: unknown) => Promise<unknown>) =>
		action({
			sendCommand: (message: Record<string, unknown>) =>
				answerBoardCommand(message, executeBoardCommand),
		}),
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
	boardTick,
	boardWatch,
} from '../../../cli/commands/board';
import {
	createBoard,
	addCard,
	loadBoards,
	saveBoards,
	updateCard,
	deleteCard,
} from '../../../main/board/board-storage';
import { upsertProfile } from '../../../main/profiles/profile-storage';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import {
	BoardStorageFacade,
	configureBoardStorage,
	configureBoardCaptureHost,
} from '../../../main/board/board-storage';
import { answerBoardCommand } from '../../../shared/board/commands';
import { executeBoardCommand } from '../../../main/board/board-command-host';
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

/** Seed historical/runtime data in the fixture DB, never through caller CRUD authority. */
function seedCard(
	db: ReturnType<typeof openBoardDb>,
	projectRoot: string,
	boardId: string,
	value: BoardCard
): void {
	const { runs, ...editable } = value;
	addCard(projectRoot, boardId, {
		...editable,
		status: value.status === 'running' ? 'todo' : value.status,
	});
	const board = loadBoards(projectRoot).find((entry) => entry.id === boardId)!;
	db.prepare('UPDATE cards SET payload_json = ? WHERE collection_key = ? AND id = ?').run(
		JSON.stringify(value),
		board.storage!.collectionKey,
		value.id
	);
	for (const run of runs ?? [])
		db.prepare(
			'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json, outcome_json) VALUES (?, ?, ?, ?, ?, ?)'
		).run(
			`${board.storage!.collectionKey}:${value.id}:${run.attempt}`,
			board.storage!.collectionKey,
			value.id,
			run.attempt,
			'{}',
			JSON.stringify(run)
		);
}

describe('maestro-cli board', () => {
	let projectRoot = '';
	let db: ReturnType<typeof openBoardDb>;
	let namespace: string;
	let facade: BoardStorageFacade;
	let logSpy: MockInstance;
	let exitSpy: MockInstance;
	let runTasks: Promise<unknown>[];

	beforeEach(() => {
		vi.clearAllMocks();
		runTasks = [];
		projectRoot = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/cli-'));
		db = openBoardDb(path.join(projectRoot, 'board.sqlite'));
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: projectRoot },
			boardBytes: Buffer.from('{"boards":[]}'),
			workers: [],
			repository: { id: 'repo', workingDirectory: projectRoot, validated: true },
			profileBytes: Buffer.from(
				'{"profiles":[{"id":"p1","name":"Role"},{"id":"p2","name":"Role 2"}]}'
			),
		});
		applyBoardMigration(db, plan);
		namespace = plan.profileNamespace;
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		configureBoardCaptureHost(() => ({
			agents: [{ id: 'agent-1' }, { id: 'agent-9' }, { id: 'agent-2-0123456789abcdef' }],
			groups: [],
		}));
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
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

	afterEach(async () => {
		await Promise.allSettled(runTasks);
		vi.restoreAllMocks();
		configureBoardRuntimeHost(() => null);
		configureBoardStorage(null);
		db.close();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('routes SSH agent list, rename and tick by explicit source identity and permits closed-source mutations without local paths', async () => {
		const remoteRoot = '/remote-only/Repo';
		const plan = planBoardMigration({
			source: { location: { kind: 'ssh', remoteId: 'remote-one' }, path: remoteRoot },
			repository: {
				id: 'remote-repository',
				workingDirectory: remoteRoot,
				validated: true,
				location: { kind: 'ssh', remoteId: 'remote-one' },
			},
			boardBytes: Buffer.from(
				JSON.stringify({ boards: [{ id: 'remote-board', name: 'Remote board', cards: [] }] })
			),
			profileBytes: null,
			workers: [],
		});
		applyBoardMigration(db, plan);
		mockGetSessionById.mockReturnValue({
			id: 'agent-1',
			name: 'Remote worker',
			projectRoot: remoteRoot,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-one' },
		});
		await boardList({ agent: 'Alpha', json: true });
		expect(JSON.parse(logSpy.mock.calls.at(-1)![0])).toMatchObject([{ id: 'remote-board' }]);
		await boardRename('remote-board', 'Renamed remote board', { agent: 'Alpha', json: true });
		expect(facade.query({ sourceKey: plan.sourceKey }).collections[0].board.name).toBe(
			'Renamed remote board'
		);
		await boardTick({ agent: 'Alpha', json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		await boardRename('remote-board', 'Closed source edit', { source: plan.sourceKey, json: true });
		expect(facade.query({ sourceKey: plan.sourceKey }).collections[0].board.name).toBe(
			'Closed source edit'
		);
		expect(mockSpawnAgent).not.toHaveBeenCalled();
		mockGetSessionById.mockReturnValue({
			id: 'agent-1',
			projectRoot: remoteRoot,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'other-remote' },
		});
		await boardList({ agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('board create then board list round-trips through host SQLite', async () => {
		await boardCreate('Bootstrapped', { agent: 'Alpha', json: true });
		const created = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(created.name).toBe('Bootstrapped');
		expect(fs.existsSync(path.join(projectRoot, '.maestro', 'board.yaml'))).toBe(false);
		expect(db.prepare('SELECT * FROM collections').all()).toHaveLength(1);

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
		seedCard(db, projectRoot, b.id, card('c1', { status: 'running' }));
		await boardDelete(b.id, { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)).toHaveLength(1);
	});

	it('board delete --force removes a board with unfinished cards', async () => {
		const b = createBoard(projectRoot, 'Busy');
		saveBoards(
			projectRoot,
			loadBoards(projectRoot).map((entry) =>
				entry.id === b.id
					? { ...entry, cards: [...entry.cards, card('c1', { status: 'blocked' })] }
					: entry
			)
		);
		await boardDelete(b.id, { agent: 'Alpha', force: true, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(loadBoards(projectRoot)).toHaveLength(0);
	});

	it('board delete --force preserves a board with running cards', async () => {
		const b = createBoard(projectRoot, 'Busy');
		seedCard(db, projectRoot, b.id, card('c1', { status: 'running' }));
		await boardDelete(b.id, { agent: 'Alpha', force: true, json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('running');
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
			profileNamespace: namespace,
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

	it('board add-card --worktree records the conventional worktree ref', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Isolated',
			assignee: 'p1',
			profileNamespace: namespace,
			worktree: true,
			workingDirectory: projectRoot,
			repository: 'repo',
			json: true,
		});
		const created = loadBoards(projectRoot)[0].cards[0];
		// Branch `board/<boardId>/<cardId>` (full ids), checked out BESIDE the
		// project (a worktree nested inside the repo is refused by git provisioning).
		expect(created.worktree?.branch).toBe(`board/${b.id}/${created.id}`);
		expect(created.worktree?.path).toContain(path.join('worktrees', 'board'));
		expect(created.worktree?.path.startsWith(projectRoot + path.sep)).toBe(false);
	});

	it('board add-card --priority stores high/low and drops the default', async () => {
		const b = createBoard(projectRoot, 'B');
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Urgent',
			assignee: 'p1',
			profileNamespace: namespace,
			priority: 'high',
			json: true,
		});
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Ordinary',
			assignee: 'p1',
			profileNamespace: namespace,
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
			profileNamespace: namespace,
			priority: 'urgent',
			json: true,
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(0);
	});

	// X1 task 7: `--assignee-agent` used to be stored verbatim, so a typo or a
	// prefix only surfaced at dispatch as `blocked (Agent "<id>" not found.)`.
	describe('--assignee-agent write-time validation (X1)', () => {
		const FULL_ID = 'agent-2-0123456789abcdef';

		/** Route the shared agent-lookup mocks: `Alpha` and a unique prefix resolve. */
		function routeAgentLookup(): void {
			mockResolveAgentId.mockImplementation((partial: string) => {
				if (partial === 'Alpha') return 'agent-1';
				if (FULL_ID.startsWith(partial)) return FULL_ID;
				throw new Error(`Agent not found: ${partial}`);
			});
			mockGetSessionById.mockImplementation((id: string) => {
				if (id === 'agent-1') {
					return {
						id: 'agent-1',
						name: 'Alpha',
						toolType: 'claude-code',
						projectRoot,
						cwd: projectRoot,
					};
				}
				if (id === FULL_ID) {
					return {
						id: FULL_ID,
						name: 'Beta',
						toolType: 'claude-code',
						projectRoot,
						cwd: projectRoot,
					};
				}
				return undefined;
			});
		}

		it('board add-card rejects a nonexistent --assignee-agent and writes nothing', async () => {
			routeAgentLookup();
			const b = createBoard(projectRoot, 'B');
			await boardAddCard(b.id, {
				agent: 'Alpha',
				title: 'Pinned to a ghost',
				assigneeAgent: 'no-such-agent',
				json: true,
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(loadBoards(projectRoot)[0].cards).toHaveLength(0);
		});

		it('board add-card resolves a unique --assignee-agent prefix to the full id', async () => {
			routeAgentLookup();
			const b = createBoard(projectRoot, 'B');
			await boardAddCard(b.id, {
				agent: 'Alpha',
				title: 'Pinned',
				assigneeAgent: 'agent-2',
				json: true,
			});
			expect(exitSpy).not.toHaveBeenCalled();
			expect(loadBoards(projectRoot)[0].cards[0].assigneeAgentId).toBe(FULL_ID);
		});

		it('board update-card resolves --assignee-agent and rejects an unknown one', async () => {
			routeAgentLookup();
			const b = createBoard(projectRoot, 'B');
			addCard(projectRoot, b.id, card('c1'));

			await boardUpdateCard('c1', { agent: 'Alpha', assigneeAgent: 'agent-2', json: true });
			expect(exitSpy).not.toHaveBeenCalled();
			expect(loadBoards(projectRoot)[0].cards[0].assigneeAgentId).toBe(FULL_ID);

			await boardUpdateCard('c1', { agent: 'Alpha', assigneeAgent: 'nope', json: true });
			expect(exitSpy).toHaveBeenCalledWith(1);
			// The rejected edit left the earlier resolved pin in place.
			expect(loadBoards(projectRoot)[0].cards[0].assigneeAgentId).toBe(FULL_ID);
		});
	});

	it.each(['work', 'test', 'documentation'] as const)(
		'captures a separate %s task through the shared host',
		async (kind) => {
			const board = createBoard(projectRoot, 'Kinds');
			await boardAddCard(board.id, { agent: 'Alpha', title: kind, kind, json: true });
			expect(exitSpy).not.toHaveBeenCalled();
			expect(loadBoards(projectRoot)[0].cards[0].kind).toBe(kind);
		}
	);
	it('routes an exact review-source request through the CLI transport and host Git verification', async () => {
		const git = (...args: string[]) =>
			execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
		git('init', '--quiet');
		fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'board.sqlite*\n');
		git('add', '.gitignore');
		git(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.test',
			'commit',
			'--quiet',
			'-m',
			'fixture'
		);
		const artifact = {
			worktreePath: projectRoot,
			branch: git('symbolic-ref', '--short', 'HEAD').trim(),
			commit: git('rev-parse', 'HEAD').trim(),
		};
		const board = createBoard(projectRoot, 'Reviews');
		const run = {
			attempt: 1,
			startedAt: 'start',
			endedAt: 'end',
			outcome: 'done' as const,
			summary: 'reported tests passed',
			artifact,
		};
		seedCard(
			db,
			projectRoot,
			board.id,
			card('work', { status: 'done', runs: [run], repositoryId: 'repo' })
		);
		const stored = loadBoards(projectRoot)[0];
		db.prepare(
			'UPDATE runs SET specification_json=?, outcome_json=? WHERE collection_key=? AND card_id=?'
		).run(
			JSON.stringify({
				key: { sourceKey: stored.storage!.sourceKey },
				card: { repositoryId: 'repo' },
			}),
			JSON.stringify({ cardOutcome: { run } }),
			stored.storage!.collectionKey,
			'work'
		);
		await boardAddCard(board.id, {
			agent: 'Alpha',
			title: 'Review source',
			reviewOf: 'work',
			reviewAttempt: '1',
			repository: 'repo',
			json: true,
		});
		expect(exitSpy).not.toHaveBeenCalled();
		const review = loadBoards(projectRoot)[0].cards.find(
			(entry) => entry.title === 'Review source'
		)!;
		expect(review).toMatchObject({
			kind: 'review',
			parents: ['work'],
			reviewHandoff: { cardId: 'work', attempt: 1, artifact },
		});
	});
	it('board add-card wires comma-separated parents', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('a'));
		addCard(projectRoot, b.id, card('b'));
		await boardAddCard(b.id, {
			agent: 'Alpha',
			title: 'Child',
			assignee: 'p1',
			profileNamespace: namespace,
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
		// `--assignee-agent` is resolved at write time now, so the pinned agent has
		// to exist for the edit to land.
		mockResolveAgentId.mockImplementation((partial: string) =>
			partial === 'Alpha' ? 'agent-1' : partial
		);
		mockGetSessionById.mockImplementation((id: string) => ({
			id,
			name: id === 'agent-1' ? 'Alpha' : id,
			toolType: 'claude-code',
			projectRoot,
			cwd: projectRoot,
		}));
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
			workingDirectory: projectRoot,
			repository: 'repo',
			json: true,
		});
		const updated = loadBoards(projectRoot)[0].cards.find((c) => c.id === 'c1')!;
		expect(updated.assigneeProfileId).toBeUndefined();
		expect(updated.assigneeAgentId).toBe('agent-9');
		expect(updated.parents).toEqual([]);
		expect(updated.priority).toBe('high');
		expect(updated.worktree?.branch).toBe(`board/${b.id}/c1`);
	});

	it('board update-card --priority normal clears an explicit priority', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1', { priority: 'high' }));
		await boardUpdateCard('c1', { agent: 'Alpha', priority: 'normal', json: true });
		expect(loadBoards(projectRoot)[0].cards[0].priority).toBeUndefined();
	});

	it('board update-card refuses a running card', async () => {
		const b = createBoard(projectRoot, 'B');
		seedCard(db, projectRoot, b.id, card('c1', { status: 'running', title: 'Live' }));
		await boardUpdateCard('c1', { agent: 'Alpha', title: 'Nope', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].title).toBe('Live');
	});

	it('board update-card permits removing the last assignee as a non-executable draft', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardUpdateCard('c1', { agent: 'Alpha', assignee: '', json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(loadBoards(projectRoot)[0].cards[0].assigneeProfileId).toBeUndefined();
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
		seedCard(db, projectRoot, b.id, card('c1', { status: 'running' }));
		await boardRemoveCard('c1', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(1);
	});

	it('board remove-card --force still refuses a running card', async () => {
		const b = createBoard(projectRoot, 'B');
		seedCard(db, projectRoot, b.id, card('c1', { status: 'running' }));
		await boardRemoveCard('c1', { agent: 'Alpha', force: true, json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards).toHaveLength(1);
	});

	it('board set-status moves a card and auto-resolves its board', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardSetStatus('c1', 'done', { agent: 'Alpha', json: true });
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('done');
	});

	it('keeps concurrent edits and refuses unfenced decomposition completion', async () => {
		const session = {
			...mockGetSessionById(),
			additionalDirectories: [{ path: '/reference', read: true, write: false }],
		};
		mockGetSessionById.mockReturnValue(session);

		const b = createBoard(projectRoot, 'B', { autoDecompose: true });
		addCard(
			projectRoot,
			b.id,
			card('triage', { status: 'triage', assigneeProfileId: undefined, assigneeAgentId: 'agent-1' })
		);
		addCard(projectRoot, b.id, card('existing', { status: 'blocked' }));
		mockReadSessions.mockReturnValue([mockGetSessionById()]);
		let decomposing = true;
		mockSpawnAgent.mockImplementation(async () => {
			if (decomposing) {
				decomposing = false;
				addCard(projectRoot, b.id, card('new-during-llm', { status: 'blocked' }));
				updateCard(projectRoot, b.id, {
					...loadBoards(projectRoot)[0].cards.find((c) => c.id === 'existing')!,
					title: 'Edited during LLM',
				});
				return {
					success: true,
					response: JSON.stringify([
						{ title: 'Child one', body: 'First' },
						{ title: 'Child two', body: 'Second' },
					]),
				};
			}
			return { success: true, response: '<!-- maestro:card-complete -->' };
		});
		await expect(
			autoDecomposeBoard(loadBoards(projectRoot)[0], {
				spawn: (prompt, triage) =>
					decomposeBoardCard(projectRoot, triage, prompt, {
						getStoredSessions: () => mockReadSessions(),
						getAgentConfig: () => ({}),
						getSshStore: () => ({}),
						nowMs: () => 1,
					}),
				reload: () => loadBoards(projectRoot)[0],
				save: (board) => saveBoards(projectRoot, [board]),
				now: () => new Date().toISOString(),
			})
		).rejects.toThrow('Run lifecycle requires the fenced runtime');
		expect(mockSpawnAgent.mock.calls[0][4]).toMatchObject({
			appendSystemPrompt: expect.stringContaining(`Write only within ${projectRoot}`),
			additionalDirectories: session.additionalDirectories,
		});

		const current = loadBoards(projectRoot)[0];
		expect(current.cards.find((c) => c.id === 'new-during-llm')?.status).toBe('blocked');
		expect(current.cards.find((c) => c.id === 'existing')?.title).toBe('Edited during LLM');
		expect(current.cards.find((c) => c.id === 'triage')?.status).toBe('triage');
		expect(current.cards.some((c) => c.title === 'Child one')).toBe(false);
	});
	it('does not resurrect a triage card deleted during the decomposition await', async () => {
		const b = createBoard(projectRoot, 'B', { autoDecompose: true });
		addCard(
			projectRoot,
			b.id,
			card('triage', { status: 'triage', assigneeProfileId: undefined, assigneeAgentId: 'agent-1' })
		);
		mockReadSessions.mockReturnValue([mockGetSessionById()]);
		mockSpawnAgent.mockImplementation(async () => {
			deleteCard(projectRoot, b.id, 'triage');
			return {
				success: true,
				response: JSON.stringify([{ title: 'Discarded child', body: 'Work' }]),
			};
		});
		await autoDecomposeBoard(loadBoards(projectRoot)[0], {
			spawn: (prompt, triage) =>
				decomposeBoardCard(projectRoot, triage, prompt, {
					getStoredSessions: () => mockReadSessions(),
					getAgentConfig: () => ({}),
					getSshStore: () => ({}),
					nowMs: () => 1,
				}),
			reload: () => loadBoards(projectRoot)[0],
			save: (board) => saveBoards(projectRoot, [board]),
			now: () => new Date().toISOString(),
		});
		expect(loadBoards(projectRoot)[0].cards).toEqual([]);
		expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
	});

	it('board set-status rejects an invalid status', async () => {
		const b = createBoard(projectRoot, 'B');
		addCard(projectRoot, b.id, card('c1'));
		await boardSetStatus('c1', 'bogus', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(loadBoards(projectRoot)[0].cards[0].status).toBe('todo');
	});

	// X1 task 8: `board set-status <id> done` used to move the card and exit, so a
	// headless board never opened the PR the desktop path opens on the very same
	// transition. The flow is AWAITED here - the process exits when the command
	// returns, and fire-and-forget would kill the push mid-flight.
	describe('PR-on-done parity (X1)', () => {
		/** A card that satisfies every gate condition once it lands in `done`. */
		function prReadyCard(overrides: Partial<BoardCard> = {}): BoardCard {
			return card('c1', {
				status: 'blocked',
				prOnDone: {},
				worktree: { path: '/tmp/wt/c1', branch: 'board/b/c1' },
				runs: [
					{
						attempt: 1,
						startedAt: '2026-08-04T00:00:00.000Z',
						endedAt: '2026-08-04T00:01:00.000Z',
						outcome: 'done',
						summary: 'did the thing',
						worktreePath: '/tmp/wt/c1',
						worktreeBranch: 'board/b/c1',
					},
				],
				...overrides,
			});
		}

		it('opens the PR, awaits it, and stamps the url on the run', async () => {
			const b = createBoard(projectRoot, 'B');
			seedCard(db, projectRoot, b.id, prReadyCard());
			let resolved = false;
			mockCreatePullRequest.mockImplementation(async () => {
				await new Promise((r) => setTimeout(r, 5));
				resolved = true;
				return { success: true, prUrl: 'https://github.com/o/r/pull/7', targetBranch: 'rc' };
			});

			await boardSetStatus('c1', 'done', { agent: 'Alpha', json: true });

			// Awaited, not fire-and-forget: the creator finished before we returned.
			expect(resolved).toBe(true);
			expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
			// The Board source may name another repository or be an opaque source
			// reference. The existing PR helper resolves the default base in this
			// run's worktree when no main checkout is supplied.
			expect(mockCreatePullRequest.mock.calls[0][0]).toMatchObject({ worktreePath: '/tmp/wt/c1' });
			expect(mockCreatePullRequest.mock.calls[0][0]).not.toHaveProperty('mainRepoCwd');
			const stored = loadBoards(projectRoot)[0].cards[0];
			expect(stored.status).toBe('done');
			expect(stored.runs?.[0].prUrl).toBe('https://github.com/o/r/pull/7');
			const payload = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
			expect(payload.prUrl).toBe('https://github.com/o/r/pull/7');
		});

		it('persists prError and leaves the card done when the PR fails', async () => {
			const b = createBoard(projectRoot, 'B');
			seedCard(db, projectRoot, b.id, prReadyCard());
			mockCreatePullRequest.mockResolvedValue({
				success: false,
				error: 'branch has no commits ahead of rc',
			});

			await boardSetStatus('c1', 'done', { agent: 'Alpha', json: true });

			const stored = loadBoards(projectRoot)[0].cards[0];
			expect(stored.status).toBe('done');
			expect(stored.runs?.[0].prError).toBe('branch has no commits ahead of rc');
			expect(stored.runs?.[0].prUrl).toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
			const payload = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
			expect(payload.prError).toBe('branch has no commits ahead of rc');
		});

		it('attempts nothing for a card that never opted in', async () => {
			const b = createBoard(projectRoot, 'B');
			seedCard(db, projectRoot, b.id, prReadyCard({ prOnDone: undefined }));

			await boardSetStatus('c1', 'done', { agent: 'Alpha', json: true });

			expect(mockCreatePullRequest).not.toHaveBeenCalled();
			const payload = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
			expect(payload).not.toHaveProperty('prUrl');
			expect(payload).not.toHaveProperty('prError');
		});

		it('attempts nothing for a move into a status other than done', async () => {
			const b = createBoard(projectRoot, 'B');
			seedCard(db, projectRoot, b.id, prReadyCard());
			await boardSetStatus('c1', 'blocked', { agent: 'Alpha', json: true });
			expect(mockCreatePullRequest).not.toHaveBeenCalled();
		});

		it('add-card --pr-on-done persists the target branch, and the bare flag does not', async () => {
			const b = createBoard(projectRoot, 'B');
			await boardAddCard(b.id, {
				agent: 'Alpha',
				title: 'Targeted',
				assignee: 'p1',
				profileNamespace: namespace,
				worktree: true,
				workingDirectory: projectRoot,
				repository: 'repo',
				prOnDone: 'rc',
				json: true,
			});
			await boardAddCard(b.id, {
				agent: 'Alpha',
				title: 'Default base',
				assignee: 'p1',
				profileNamespace: namespace,
				worktree: true,
				workingDirectory: projectRoot,
				repository: 'repo',
				prOnDone: true,
				json: true,
			});
			const cards = loadBoards(projectRoot)[0].cards;
			expect(cards.find((c) => c.title === 'Targeted')?.prOnDone?.targetBranch).toBe('rc');
			const bare = cards.find((c) => c.title === 'Default base');
			expect(bare?.prOnDone).toBeDefined();
			expect(bare?.prOnDone?.targetBranch).toBeUndefined();
		});

		it('update-card sets and then clears prOnDone', async () => {
			const b = createBoard(projectRoot, 'B');
			addCard(projectRoot, b.id, card('c1'));

			await boardUpdateCard('c1', { agent: 'Alpha', prOnDone: 'main', json: true });
			expect(loadBoards(projectRoot)[0].cards[0].prOnDone?.targetBranch).toBe('main');

			await boardUpdateCard('c1', { agent: 'Alpha', prOnDone: false, json: true });
			expect(loadBoards(projectRoot)[0].cards[0].prOnDone).toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	function installOwner(root: string) {
		const row = db
			.prepare('SELECT payload_json FROM repositories WHERE id=?')
			.get(root === projectRoot ? 'repo' : 'native-repo') as { payload_json: string };
		const record = JSON.parse(row.payload_json);
		const nativeService = createBoardRunService({
			getStoredSessions: () => mockReadSessions(),
			getAgentConfig: () => ({}),
			getSshStore: () => ({}),
			nowMs: () => 1,
		});
		const owner = new BoardRuntime(
			facade,
			{
				info: { pid: 101, mode: 'desktop', startedAt: new Date(1).toISOString(), bootTime: 1 },
				verify: () => ({ ok: true }),
			},
			() => ({
				registryRevision: 1,
				dispatchEnabled: true,
				agentStates: Object.fromEntries(
					mockReadSessions().map((agent: any) => [
						agent.id,
						{
							live: true,
							busy: false,
							location: agent.sessionSshRemoteConfig?.enabled
								? { kind: 'ssh', remoteId: 'r1' }
								: { kind: 'local' },
						},
					])
				),
				repository: {
					id: record.id,
					workingDirectory: root,
					record,
					identity: 'fixture-git',
					location: mockGetSessionById()?.sessionSshRemoteConfig?.enabled
						? { kind: 'ssh', remoteId: 'r1' }
						: { kind: 'local' },
				},
			}),
			{
				...nativeService,
				spawn: (spec, hooks) => {
					const task = nativeService.spawn(spec, hooks);
					runTasks.push(task);
					return task;
				},
			},
			() => 'unknown'
		);
		expect(owner.acquire()).toMatchObject({ ok: true });
		configureBoardRuntimeHost(() => owner);
	}

	// `board watch` is a loop, so every test here drives exactly one iteration and
	// then stops it: SIGINT both sets the stop flag and wakes the interval sleep,
	// so no fake timers (and no 30-second test) are needed.
	describe('board watch', () => {
		beforeEach(() => {
			mockReadSessions.mockReturnValue([]);
			installOwner(projectRoot);
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
			expect(tick.boards[0].accepted).toBe(0);
			expect(tick.boards[0].results).toMatchObject([{ ok: false, reason: 'no-workers' }]);
			expect(loadBoards(projectRoot)[0].cards[0].status).toBe('todo');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('exits non-zero when the central board schema is unavailable (fail-closed)', async () => {
			fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
			db.exec('DROP TABLE collections');
			await boardWatch({ agent: 'Alpha', interval: '5', json: true });
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an --interval below the minimum, and a non-numeric one', async () => {
			await boardWatch({ agent: 'Alpha', interval: '1', json: true });
			await boardWatch({ agent: 'Alpha', interval: 'soon', json: true });
			expect(exitSpy).toHaveBeenCalledTimes(2);
		});
	});

	// Phase 4: `board tick` provisions a card's isolated worktree before spawning
	// and hands the agent that checkout as its cwd. Driven against a REAL git repo
	// (only the agent process is faked) so the provisioning is genuinely exercised.
	describe('board tick worktree isolation', () => {
		let repoRoot = '';

		/** git-init a repo with one commit inside the per-test temp dir. */
		function initRepo(): string {
			const root = path.join(projectRoot, 'repo');
			fs.mkdirSync(root);
			const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
			run(['init', '-b', 'main']);
			run(['config', 'user.email', 'test@example.com']);
			run(['config', 'user.name', 'Test']);
			fs.writeFileSync(path.join(root, 'README.md'), '# repo\n');
			run(['add', '.']);
			run(['commit', '-m', 'init']);
			return root;
		}

		beforeEach(() => {
			repoRoot = initRepo();
			const migration = planBoardMigration({
				source: { location: { kind: 'local' }, path: repoRoot },
				boardBytes: Buffer.from('{"boards":[]}'),
				workers: [],
				repository: { id: 'native-repo', workingDirectory: repoRoot, validated: true },
				profileBytes: Buffer.from('{"profiles":[{"id":"p1","name":"Builder"}]}'),
			});
			applyBoardMigration(db, migration);
			configureBoardCaptureHost(() => ({
				agents: mockReadSessions().map((agent: any) => ({ id: agent.id })),
				groups: [],
			}));
			registerBoardWorker(db, 'agent-1');
			setBoardWorkerAccess(
				db,
				'agent-1',
				[{ namespace: migration.profileNamespace, profileId: 'p1' }],
				['native-repo']
			);

			const session = {
				id: 'agent-1',
				name: 'Alpha',
				toolType: 'claude-code',
				projectRoot: repoRoot,
				cwd: repoRoot,
				boardWorker: true,
				additionalDirectories: [
					{ path: '/reference', read: true, write: false },
					{ path: '/dropbox', read: false, write: true },
				],
			};
			mockGetSessionById.mockReturnValue(session);
			mockReadSessions.mockReturnValue([session]);
			mockSpawnAgent.mockResolvedValue({
				success: true,
				response: '<!-- maestro:card-complete | did it -->',
			});
			installOwner(repoRoot);
		});

		/** Create a board with one ready card pinned to the agent, optionally isolated. */
		function seedBoard(worktree?: { path: string; branch: string }) {
			const board = createBoard(repoRoot, 'Tick board');
			const { assigneeProfileId: _role, ...pinned } = card('c1', {
				status: 'todo',
				assigneeAgentId: 'agent-1',
			});
			facade.capture(
				{
					projectRoot: repoRoot,
					boardId: board.id,
					expectedRevision: board.storage!.expectedRevision!,
					card: {
						...pinned,
						executionScope: { kind: 'agent', agentId: 'agent-1' },
						repositoryId: 'native-repo',
						workingDirectory: repoRoot,
						startModeOverride: 'direct',
						...(worktree ? { worktree } : {}),
					},
				},
				true
			);
			return board;
		}

		it('creates the worktree and spawns the agent inside it', async () => {
			const branch = 'board/tick/c1';
			const worktreePath = path.join(projectRoot, 'worktrees', branch);
			seedBoard({ path: worktreePath, branch });

			await boardTick({ agent: 'Alpha', json: true });
			await vi.waitFor(() =>
				expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
			);

			expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
			// spawnAgent(toolType, cwd, prompt, ...) - the cwd is the checkout.
			expect(mockSpawnAgent.mock.calls[0][1]).toBe(worktreePath);
			const options = mockSpawnAgent.mock.calls[0][4];
			expect(options.appendSystemPrompt).toContain(`Write only within ${worktreePath}`);
			expect(options.appendSystemPrompt).toContain('Read only');
			expect(options.appendSystemPrompt).toContain('Write only');
			expect(options.additionalDirectories).toEqual(mockGetSessionById().additionalDirectories);
			expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);

			const stored = loadBoards(repoRoot)[0].cards[0];
			expect(stored.status).toBe('done');
			expect(stored.runs?.[0]).toMatchObject({ worktreePath, worktreeBranch: branch });
		});

		it('spawns in the project root when the card is not isolated', async () => {
			seedBoard();

			await boardTick({ agent: 'Alpha', json: true });

			expect(mockSpawnAgent.mock.calls[0][1]).toBe(repoRoot);
			expect(loadBoards(repoRoot)[0].cards[0].runs?.[0].worktreePath).toBeUndefined();
		});

		it('dispatches a role-only card to a pool worker known only by cwd (desktop parity)', async () => {
			// A stored worker record may carry cwd but no projectRoot; the desktop
			// pool wiring falls back (projectRoot || cwd || fullPath), so the CLI
			// must not drop such a worker or role-only cards sit ready forever.
			upsertProfile(repoRoot, { id: 'p1', name: 'Builder' });
			const worker = {
				id: 'agent-2',
				name: 'Worker',
				toolType: 'claude-code',
				projectRoot: '',
				cwd: repoRoot,
				boardWorker: true,
			};
			mockReadSessions.mockReturnValue([worker]);
			mockGetSessionById.mockImplementation((id: string) =>
				id === 'agent-2'
					? worker
					: {
							id: 'agent-1',
							name: 'Alpha',
							toolType: 'claude-code',
							projectRoot: repoRoot,
							cwd: repoRoot,
						}
			);
			const board = createBoard(repoRoot, 'Pool board');
			registerBoardWorker(db, 'agent-2');
			const roleNamespace = facade
				.captureCatalog()
				.profiles.find((p) => p.profile.id === 'p1' && p.namespace !== namespace)!.namespace;
			setBoardWorkerAccess(
				db,
				'agent-2',
				[{ namespace: roleNamespace, profileId: 'p1' }],
				['native-repo']
			);
			facade.capture(
				{
					projectRoot: repoRoot,
					boardId: board.id,
					expectedRevision: board.storage!.expectedRevision!,
					card: {
						...card('c1', { status: 'todo' }),
						role: { namespace: roleNamespace, profileId: 'p1' },
						executionScope: { kind: 'agent', agentId: 'agent-2' },
						repositoryId: 'native-repo',
						workingDirectory: repoRoot,
						startModeOverride: 'direct',
					},
				},
				true
			);

			await boardTick({ agent: 'Alpha', json: true });
			await vi.waitFor(() =>
				expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
			);

			expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
			const stored = loadBoards(repoRoot).find((b) => b.id === board.id)?.cards[0];
			expect(stored?.status).toBe('done');
			expect(stored?.runs?.[0].workerAgentId).toBe('agent-2');
		});

		it('blocks an isolated card on an SSH remote instead of running in the project root', async () => {
			const session = {
				id: 'agent-1',
				name: 'Alpha',
				toolType: 'claude-code',
				projectRoot: repoRoot,
				cwd: repoRoot,
				boardWorker: true,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			};
			mockGetSessionById.mockReturnValue(session);
			mockReadSessions.mockReturnValue([session]);
			const branch = 'board/tick/ssh';
			seedBoard({ path: path.join(projectRoot, 'worktrees', branch), branch });

			// Explicitly retain the fixture's selected central source while toggling the
			// worker transport: this case exercises the final SSH worktree guard.
			await boardTick({
				agent: 'Alpha',
				projectRoot: BOARD_SOURCE_PROJECT_PREFIX + facade.sourceKeys(repoRoot)[0],
				json: true,
			});
			await vi.waitFor(() =>
				expect(db.prepare('SELECT * FROM reservations').all()).toHaveLength(0)
			);

			expect(mockSpawnAgent).not.toHaveBeenCalled();
			const stored = loadBoards(repoRoot)[0].cards[0];
			expect(stored.status).toBe('blocked');
			expect(stored.runs?.[0].summary).toMatch(/SSH remotes/i);
		});
	});

	it('exits non-zero when the agent cannot be resolved', async () => {
		mockGetSessionById.mockReturnValue(undefined);
		await boardList({ agent: 'ghost', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

describe('dispatch Encore gates', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('gate exit');
		});
	});
	afterEach(() => vi.restoreAllMocks());
	it.each(['board', 'maestroCue'] as const)(
		'refuses tick and watch while %s is off before looking up an agent',
		async (flag) => {
			mockReadSettingValue.mockReturnValueOnce({ board: true, maestroCue: true, [flag]: false });
			await expect(boardTick({ agent: 'missing', json: true })).rejects.toThrow();
			mockReadSettingValue.mockReturnValueOnce({ board: true, maestroCue: true, [flag]: false });
			await expect(boardWatch({ agent: 'missing', json: true })).rejects.toThrow();
			expect(mockSpawnAgent).not.toHaveBeenCalled();
		}
	);
});
