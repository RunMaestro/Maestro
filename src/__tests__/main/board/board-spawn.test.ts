/**
 * @file board-spawn.test.ts
 * @description Board Phase 4: the spawn path's worktree handling. The Cue
 * executor and the git provisioning helper are faked, so these tests are about
 * WHERE the card runs, not about git:
 *   - a plain card still runs in the shared project root;
 *   - a worktree card provisions first and runs with the checkout as its cwd;
 *   - the resolved path/branch come back on the spawn result;
 *   - an SSH-remote agent refuses the card (block marker) instead of quietly
 *     running in the project root.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCuePrompt = vi.fn();
const ensureCardWorktree = vi.fn();

vi.mock('../../../main/cue/cue-executor', () => ({
	executeCuePrompt: (...args: unknown[]) => executeCuePrompt(...args),
	stopCueRun: vi.fn(),
}));
vi.mock('../../../main/board/board-worktree', async () => {
	const actual = await vi.importActual<typeof import('../../../main/board/board-worktree')>(
		'../../../main/board/board-worktree'
	);
	return {
		...actual,
		ensureCardWorktree: (...args: unknown[]) => ensureCardWorktree(...args),
	};
});
vi.mock('../../../main/profiles/profile-storage', () => ({ listProfiles: () => [] }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), cue: vi.fn() },
}));

import { spawnBoardCard, type BoardSpawnContext } from '../../../main/board/board-spawn';
import { WORKTREE_SSH_UNSUPPORTED } from '../../../main/board/board-worktree';
import type { BoardCard } from '../../../shared/board/types';

const PROJECT_ROOT = '/repos/project';
const WORKTREE_PATH = '/repos/worktrees/board/b1/c1';
const WORKTREE_BRANCH = 'board/b1/c1';

function card(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: 'c1',
		title: 'Do the thing',
		body: 'details',
		assigneeAgentId: 'agent-1',
		parents: [],
		status: 'running',
		createdAt: '2026-07-21T00:00:00.000Z',
		updatedAt: '2026-07-21T00:00:00.000Z',
		...overrides,
	};
}

function context(session: Record<string, unknown> = {}): BoardSpawnContext {
	return {
		getStoredSessions: () => [
			{ id: 'agent-1', name: 'Worker', toolType: 'claude-code', ...session },
		],
		getAgentConfig: () => ({}),
		getSshStore: () => ({}),
		nowMs: () => 1,
	};
}

/** The cwd the executor was actually handed (`projectRoot` IS the spawn cwd). */
function spawnedCwd(): string {
	return executeCuePrompt.mock.calls[0][0].projectRoot;
}

beforeEach(() => {
	executeCuePrompt.mockReset();
	executeCuePrompt.mockResolvedValue({ stdout: 'ok', exitCode: 0 });
	ensureCardWorktree.mockReset();
	ensureCardWorktree.mockResolvedValue({
		ok: true,
		path: WORKTREE_PATH,
		branch: WORKTREE_BRANCH,
	});
});

describe('spawnBoardCard worktree isolation', () => {
	it('runs a plain card in the shared project root and provisions nothing', async () => {
		const result = await spawnBoardCard(
			PROJECT_ROOT,
			{ card: card(), overrides: {}, agentId: 'agent-1' },
			context()
		);

		expect(ensureCardWorktree).not.toHaveBeenCalled();
		expect(spawnedCwd()).toBe(PROJECT_ROOT);
		expect(result).toEqual({ output: 'ok', exitCode: 0 });
	});

	it('provisions the worktree and spawns with the checkout as cwd', async () => {
		const worktree = { path: WORKTREE_PATH, branch: WORKTREE_BRANCH };
		const result = await spawnBoardCard(
			PROJECT_ROOT,
			{ card: card({ worktree }), overrides: {}, agentId: 'agent-1' },
			context()
		);

		expect(ensureCardWorktree).toHaveBeenCalledWith(PROJECT_ROOT, worktree);
		expect(spawnedCwd()).toBe(WORKTREE_PATH);
		// The session still names the board's project; only the cwd moves.
		expect(executeCuePrompt.mock.calls[0][0].session.cwd).toBe(WORKTREE_PATH);
		expect(result).toEqual({
			output: 'ok',
			exitCode: 0,
			worktreePath: WORKTREE_PATH,
			worktreeBranch: WORKTREE_BRANCH,
		});
	});

	it('blocks (never spawns) when provisioning fails', async () => {
		ensureCardWorktree.mockResolvedValue({ ok: false, reason: 'branch is checked out elsewhere' });

		const result = await spawnBoardCard(
			PROJECT_ROOT,
			{
				card: card({ worktree: { path: WORKTREE_PATH, branch: WORKTREE_BRANCH } }),
				overrides: {},
				agentId: 'agent-1',
			},
			context()
		);

		expect(executeCuePrompt).not.toHaveBeenCalled();
		expect(result.output).toContain('maestro:card-block');
		expect(result.output).toContain('branch is checked out elsewhere');
	});

	it('refuses a worktree card on an SSH remote instead of running in the project root', async () => {
		const result = await spawnBoardCard(
			PROJECT_ROOT,
			{
				card: card({ worktree: { path: WORKTREE_PATH, branch: WORKTREE_BRANCH } }),
				overrides: {},
				agentId: 'agent-1',
			},
			context({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
		);

		expect(ensureCardWorktree).not.toHaveBeenCalled();
		expect(executeCuePrompt).not.toHaveBeenCalled();
		expect(result.output).toBe(`<!-- maestro:card-block: ${WORKTREE_SSH_UNSUPPORTED} -->`);
	});

	it('still runs a plain card on an SSH remote (isolation is what is unsupported)', async () => {
		await spawnBoardCard(
			PROJECT_ROOT,
			{ card: card(), overrides: {}, agentId: 'agent-1' },
			context({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
		);

		expect(spawnedCwd()).toBe(PROJECT_ROOT);
	});
});
