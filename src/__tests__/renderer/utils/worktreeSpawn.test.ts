/**
 * Tests for spawnWorktreeAgentAndDispatch — focused on the dedup-mark robustness
 * that keeps sibling watchers from adopting a Maestro-spawned worktree under the
 * wrong parent (PR #946).
 *
 * The helper marks the worktree path as recently-created so the chokidar watcher
 * in useWorktreeHandlers skips it. The race window is the slow stretch between
 * `git worktree add` finishing and the owning session being committed to the
 * store (getBranches / buildWorktreeSession). These tests pin that the RESOLVED
 * path stays marked across that window — including the case where the branch was
 * already attached elsewhere and the path is reassigned to `existingPath`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn().mockResolvedValue(['main']),
		getTags: vi.fn().mockResolvedValue([]),
	},
}));

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

import { spawnWorktreeAgentAndDispatch } from '../../../renderer/utils/worktreeSpawn';
import {
	isRecentlyCreatedWorktreePath,
	clearRecentlyCreatedWorktreePath,
} from '../../../renderer/utils/worktreeDedup';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { BatchRunConfig } from '../../../renderer/types';

const mockGit = {
	worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
};

const parentSession = {
	id: 'parent-1',
	name: 'Parent',
	cwd: '/repos/repo-a',
	fullPath: '/repos/repo-a',
	projectRoot: '/repos/repo-a',
	toolType: 'claude-code' as const,
	groupId: 'group-1',
	inputMode: 'ai' as const,
	state: 'idle',
	worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: true },
	aiTabs: [],
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	executionQueue: [],
	closedTabHistory: [],
	filePreviewTabs: [],
	unifiedTabOrder: [],
	unifiedClosedTabHistory: [],
} as any;

function makeConfig(): BatchRunConfig {
	return {
		documents: [],
		prompt: 'do the thing',
		worktreeTarget: {
			mode: 'create-new',
			newBranchName: 'feat-autorun',
			baseBranch: 'main',
			createPROnCompletion: false,
		},
	} as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	idCounter = 0;
	mockGit.worktreeSetup.mockResolvedValue({ success: true });
	useSessionStore.setState({
		sessions: [parentSession],
		activeSessionId: 'parent-1',
		sessionsLoaded: true,
	} as any);
	useSettingsStore.setState({
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
	} as any);
	if (!(window.maestro as any).git) (window.maestro as any).git = {};
	Object.assign((window.maestro as any).git, mockGit);
});

afterEach(() => {
	// Clear any marks left behind so tests don't leak state into each other.
	clearRecentlyCreatedWorktreePath('/shared/worktrees/feat-autorun');
	clearRecentlyCreatedWorktreePath('/repos/other-checkout/feat-autorun');
});

describe('spawnWorktreeAgentAndDispatch dedup-mark robustness', () => {
	it('leaves the created worktree path marked after the spawn completes', async () => {
		await spawnWorktreeAgentAndDispatch(parentSession, makeConfig());

		// The mark must still be live once the helper returns: the chokidar
		// discovery for the new directory fires asynchronously and must find it.
		expect(isRecentlyCreatedWorktreePath('/shared/worktrees/feat-autorun')).toBe(true);
	});

	it('marks the RESOLVED existing path (not just the requested path) when the branch was already attached elsewhere', async () => {
		// Regression: previously the requested-path mark was cleared and the path
		// reassigned to existingPath WITHOUT re-marking, leaving the real worktree
		// path unprotected so a sibling watcher could adopt it.
		mockGit.worktreeSetup.mockResolvedValue({
			success: true,
			alreadyExisted: true,
			existingPath: '/repos/other-checkout/feat-autorun',
		});

		await spawnWorktreeAgentAndDispatch(parentSession, makeConfig());

		expect(isRecentlyCreatedWorktreePath('/repos/other-checkout/feat-autorun')).toBe(true);
	});

	it('does not leave the path marked when worktree creation fails', async () => {
		mockGit.worktreeSetup.mockResolvedValue({ success: false, error: 'boom' });

		const result = await spawnWorktreeAgentAndDispatch(parentSession, makeConfig());

		expect(result).toBeNull();
		expect(isRecentlyCreatedWorktreePath('/shared/worktrees/feat-autorun')).toBe(false);
	});
});
