import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorktreeHandlers } from '../../renderer/hooks/worktree/useWorktreeHandlers';
import { getModalActions, useModalStore } from '../../renderer/stores/modalStore';
import { notifyToast } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { gitService } from '../../renderer/services/git';
import type { Session } from '../../renderer/types';

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

vi.mock('../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/stores/notificationStore')>(
		'../../renderer/stores/notificationStore'
	);
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;

vi.mock('../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `integration-worktree-${++idCounter}`),
}));

type WorktreeDiscovery = {
	sessionId: string;
	worktree: { path: string; branch: string | null; name: string };
};

let discoveredListener: ((data: WorktreeDiscovery) => Promise<void>) | null = null;
let watcherCleanup: ReturnType<typeof vi.fn>;

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'parent-1',
		name: 'Parent Agent',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo/app',
		fullPath: '/repo/app',
		projectRoot: '/repo/app',
		createdAt: 1000,
		groupId: 'group-a',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		messageQueue: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: null,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function child(overrides: Partial<Session> = {}): Session {
	return session({
		id: 'child-1',
		name: 'feature-one',
		cwd: '/repo/worktrees/feature-one',
		fullPath: '/repo/worktrees/feature-one',
		projectRoot: '/repo/worktrees/feature-one',
		parentSessionId: 'parent-1',
		worktreeBranch: 'feature-one',
		...overrides,
	});
}

function resetStores(
	initialSessions: Session[] = [],
	activeSessionId = initialSessions[0]?.id ?? ''
) {
	useSessionStore.setState({
		sessions: initialSessions,
		activeSessionId,
		groups: [],
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});
	useModalStore.setState({ modals: new Map() });
	useSettingsStore.setState({
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
	});
}

function resetGitBridge() {
	const git = window.maestro.git as any;
	git.scanWorktreeDirectory = vi.fn().mockResolvedValue({ gitSubdirs: [] });
	git.watchWorktreeDirectory = vi.fn().mockResolvedValue({ success: true });
	git.unwatchWorktreeDirectory = vi.fn();
	git.worktreeSetup = vi.fn().mockResolvedValue({ success: true });
	git.removeWorktree = vi.fn().mockResolvedValue({ success: true });
	git.onWorktreeDiscovered = vi.fn((listener: (data: WorktreeDiscovery) => Promise<void>) => {
		discoveredListener = listener;
		return watcherCleanup;
	});
}

function allSessions() {
	return useSessionStore.getState().sessions;
}

describe('useWorktreeHandlers integration', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllTimers();
		vi.clearAllMocks();
		idCounter = 0;
		discoveredListener = null;
		watcherCleanup = vi.fn();
		resetStores();
		resetGitBridge();
		vi.mocked(gitService.getBranches).mockReset().mockResolvedValue(['main', 'feature-one']);
		vi.mocked(gitService.getTags).mockReset().mockResolvedValue(['v1.0.0']);
	});

	afterEach(() => {
		if (vi.isFakeTimers()) {
			vi.runOnlyPendingTimers();
		}
		cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetStores();
	});

	it('coordinates modal actions, config scans, duplicate filtering, and disable cleanup through real stores', async () => {
		const parent = session({ worktreeConfig: undefined, worktreesExpanded: undefined });
		const existingByBranch = child({
			id: 'existing-branch',
			worktreeBranch: 'already-open',
			cwd: '/repo/worktrees/already-open',
		});
		const existingByPath = child({
			id: 'existing-path',
			parentSessionId: 'other-parent',
			worktreeBranch: 'path-branch',
			cwd: '/repo/worktrees/path-duplicate/',
			projectRoot: '/repo/worktrees/path-duplicate/',
		});
		resetStores([parent, existingByBranch, existingByPath], parent.id);
		vi.mocked(window.maestro.git.scanWorktreeDirectory).mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/repo/worktrees/main', branch: 'main', name: 'main' },
				{ path: '/repo/worktrees/already-open', branch: 'already-open', name: 'already-open' },
				{
					path: '/repo/worktrees/path-duplicate',
					branch: 'new-name-same-path',
					name: 'path-duplicate',
				},
				{ path: '/repo/worktrees/feature-one', branch: 'feature-one', name: 'feature-one' },
				{ path: '/repo/worktrees/detached', branch: null, name: 'detached' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => result.current.handleOpenWorktreeConfig());
		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
		act(() => result.current.handleCloseWorktreeConfigModal());
		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(false);

		act(() => result.current.handleQuickCreateWorktree(parent));
		expect(useModalStore.getState().getData('createWorktree')?.session).toBe(parent);
		act(() => result.current.handleDeleteWorktreeSession(existingByBranch));
		expect(useModalStore.getState().getData('deleteWorktree')?.session).toBe(existingByBranch);
		act(() => result.current.handleToggleWorktreeExpanded(parent.id));
		expect(allSessions().find((item) => item.id === parent.id)?.worktreesExpanded).toBe(false);
		act(() => result.current.handleOpenWorktreeConfigSession(parent));
		expect(useSessionStore.getState().activeSessionId).toBe(parent.id);

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/repo/worktrees',
				watchEnabled: true,
			});
		});

		expect(window.maestro.git.scanWorktreeDirectory).toHaveBeenCalledWith(
			'/repo/worktrees',
			undefined
		);
		expect(gitService.getBranches).toHaveBeenCalledWith('/repo/worktrees/feature-one', undefined);
		expect(gitService.getTags).toHaveBeenCalledWith('/repo/worktrees/detached', undefined);
		expect(allSessions().filter((item) => item.parentSessionId === parent.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ worktreeBranch: 'already-open' }),
				expect.objectContaining({ worktreeBranch: 'feature-one' }),
				expect.objectContaining({ name: 'detached' }),
			])
		);
		expect(allSessions().some((item) => item.worktreeBranch === 'main')).toBe(false);
		expect(
			allSessions().filter((item) => item.cwd === '/repo/worktrees/path-duplicate')
		).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Worktrees Discovered',
				message: 'Found 2 worktree sub-agents',
			})
		);

		act(() => result.current.handleDisableWorktreeConfig());
		expect(allSessions()).toHaveLength(2);
		expect(allSessions().find((item) => item.id === parent.id)).toEqual(
			expect.objectContaining({
				id: parent.id,
				worktreeConfig: undefined,
				worktreeParentPath: undefined,
			})
		);
		expect(allSessions().find((item) => item.id === existingByPath.id)).toBe(existingByPath);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Worktrees Disabled',
				message: 'Worktree configuration cleared for this agent. Removed 3 worktree sub-agents.',
			})
		);
	});

	it('handles missing active sessions, scan failures, and configured worktree create failures', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const parent = session({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-configured' } as any,
		});
		resetStores([parent], 'missing-active');

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/repo/missing',
				watchEnabled: true,
			});
		});
		act(() => result.current.handleDisableWorktreeConfig());
		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-missing', '/repo/missing');
		});

		expect(window.maestro.git.scanWorktreeDirectory).not.toHaveBeenCalled();
		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Error',
				message: 'No worktree directory configured',
			})
		);
		expect(allSessions()).toEqual([parent]);

		resetStores([parent], parent.id);
		vi.mocked(window.maestro.git.scanWorktreeDirectory).mockRejectedValueOnce(
			new Error('scan failed')
		);
		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/repo/failing-scan',
				watchEnabled: false,
			});
		});
		expect(allSessions().find((item) => item.id === parent.id)?.worktreeConfig).toEqual({
			basePath: '/repo/failing-scan',
			watchEnabled: false,
		});

		vi.useFakeTimers();
		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValueOnce({
			success: false,
			error: 'setup failed',
		});
		await expect(
			act(async () => {
				await result.current.handleCreateWorktreeFromConfig('feature-fails', '/repo/worktrees');
			})
		).rejects.toThrow('setup failed');
		expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
			'/repo/app',
			'/repo/worktrees/feature-fails',
			'feature-fails',
			'ssh-configured'
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Failed to Create Worktree',
				message: 'setup failed',
			})
		);
	});

	it('creates configured worktrees and suppresses watcher duplicates for the pending path', async () => {
		vi.useFakeTimers();
		const parent = session({
			worktreeConfig: { basePath: '/repo/worktrees', watchEnabled: true },
			sshRemoteId: 'ssh-runtime',
		});
		resetStores([parent], parent.id);
		vi.mocked(gitService.getBranches).mockResolvedValueOnce(['feature-config']);
		vi.mocked(gitService.getTags).mockResolvedValueOnce(['v2.0.0']);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-config', '/repo/worktrees');
		});
		await act(async () => {
			await discoveredListener?.({
				sessionId: parent.id,
				worktree: {
					path: '/repo/worktrees/feature-config',
					branch: 'feature-config',
					name: 'feature-config',
				},
			});
		});

		expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
			'/repo/app',
			'/repo/worktrees/feature-config',
			'feature-config',
			'ssh-runtime'
		);
		expect(gitService.getBranches).toHaveBeenCalledWith(
			'/repo/worktrees/feature-config',
			'ssh-runtime'
		);
		expect(
			allSessions().filter((item) => item.cwd === '/repo/worktrees/feature-config')
		).toHaveLength(1);
		expect(allSessions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: parent.id, worktreesExpanded: true }),
				expect.objectContaining({
					parentSessionId: parent.id,
					cwd: '/repo/worktrees/feature-config',
					worktreeBranch: 'feature-config',
					gitBranches: ['feature-config'],
					gitTags: ['v2.0.0'],
				}),
			])
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Worktree Created',
				message: 'feature-config',
			})
		);
	});

	it('creates modal worktrees, closes modals, and confirms delete paths', async () => {
		vi.useFakeTimers();
		const parent = session({ worktreeConfig: undefined });
		const localChild = child({ id: 'local-child', cwd: '/repo/worktrees/local-child' });
		const diskChild = child({
			id: 'disk-child',
			cwd: '/repo/worktrees/disk-child',
			worktreeBranch: 'disk-child',
		});
		resetStores([parent, localChild, diskChild], parent.id);
		vi.mocked(gitService.getBranches).mockResolvedValueOnce(['modal-feature']);
		vi.mocked(gitService.getTags).mockResolvedValueOnce(['modal-tag']);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => result.current.handleQuickCreateWorktree(parent));
		await act(async () => {
			await result.current.handleCreateWorktree('modal-feature');
		});
		act(() => result.current.handleCloseCreateWorktreeModal());

		expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
			'/repo/app',
			'/repo/worktrees/modal-feature',
			'modal-feature',
			undefined,
			undefined
		);
		expect(allSessions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: parent.id,
					worktreesExpanded: true,
					worktreeConfig: { basePath: '/repo/worktrees', watchEnabled: true },
				}),
				expect.objectContaining({
					parentSessionId: parent.id,
					cwd: '/repo/worktrees/modal-feature',
					worktreeBranch: 'modal-feature',
					gitBranches: ['modal-feature'],
					gitTags: ['modal-tag'],
				}),
			])
		);
		expect(useModalStore.getState().isOpen('createWorktree')).toBe(false);
		expect(useModalStore.getState().getData('createWorktree')?.session).toBeUndefined();

		act(() => result.current.handleDeleteWorktreeSession(localChild));
		act(() => result.current.handleConfirmDeleteWorktree());
		expect(allSessions().some((item) => item.id === localChild.id)).toBe(false);

		act(() => result.current.handleDeleteWorktreeSession(diskChild));
		await act(async () => {
			await result.current.handleConfirmAndDeleteWorktreeOnDisk();
		});
		expect(window.maestro.git.removeWorktree).toHaveBeenCalledWith(
			'/repo/worktrees/disk-child',
			true
		);
		expect(allSessions().some((item) => item.id === diskChild.id)).toBe(false);
		act(() => result.current.handleCloseDeleteWorktreeModal());
		expect(useModalStore.getState().isOpen('deleteWorktree')).toBe(false);
		expect(useModalStore.getState().getData('deleteWorktree')?.session).toBeUndefined();
	});

	it('surfaces disk delete failures without mutating sessions', async () => {
		const diskChild = child({ id: 'disk-child', cwd: '/repo/custom/disk-child' });
		resetStores([diskChild], diskChild.id);
		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('ignored-without-modal-session');
		});
		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();

		act(() => result.current.handleDeleteWorktreeSession(diskChild));
		vi.mocked(window.maestro.git.removeWorktree).mockResolvedValueOnce({
			success: false,
			error: 'remove failed',
		});
		await expect(
			act(async () => {
				await result.current.handleConfirmAndDeleteWorktreeOnDisk();
			})
		).rejects.toThrow('remove failed');
		expect(allSessions().some((item) => item.id === diskChild.id)).toBe(true);
	});

	it('restores configured worktrees on startup and continues after a scan error', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const parent = session({
			id: 'startup-parent',
			worktreeConfig: { basePath: '/repo/startup', watchEnabled: false },
		});
		const failingParent = session({
			id: 'failing-parent',
			cwd: '/repo/failing',
			worktreeConfig: { basePath: '/repo/failing-worktrees', watchEnabled: false },
			sshRemoteId: 'ssh-runtime',
		});
		const existing = child({
			id: 'startup-existing',
			parentSessionId: parent.id,
			worktreeBranch: 'existing',
			cwd: '/repo/startup/existing/',
		});
		resetStores([parent, failingParent, existing], parent.id);
		useSessionStore.setState({ sessionsLoaded: true });
		vi.mocked(window.maestro.git.scanWorktreeDirectory).mockImplementation(async (basePath) => {
			if (basePath === '/repo/failing-worktrees') throw new Error('startup failed');
			return {
				gitSubdirs: [
					{ path: '/repo/startup/main', branch: 'main', name: 'main' },
					{ path: '/repo/startup/existing', branch: 'existing', name: 'existing' },
					{ path: '/repo/startup/new-one', branch: 'new-one', name: 'new-one' },
					{ path: '/repo/startup/detached', branch: null, name: 'detached' },
				],
			};
		});

		await act(async () => {
			renderHook(() => useWorktreeHandlers());
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(550);
		});

		expect(window.maestro.git.scanWorktreeDirectory).toHaveBeenCalledWith(
			'/repo/startup',
			undefined
		);
		expect(window.maestro.git.scanWorktreeDirectory).toHaveBeenCalledWith(
			'/repo/failing-worktrees',
			'ssh-runtime'
		);
		expect(allSessions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'startup-existing' }),
				expect.objectContaining({ parentSessionId: 'startup-parent', worktreeBranch: 'new-one' }),
				expect.objectContaining({ parentSessionId: 'startup-parent', name: 'detached' }),
			])
		);
		expect(allSessions().filter((item) => item.cwd === '/repo/startup/existing')).toHaveLength(0);
	});

	it('watches configured directories, discovers non-duplicate worktrees, and cleans up watchers', async () => {
		const parent = session({
			worktreeConfig: { basePath: '/repo/watch', watchEnabled: true },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-watch' } as any,
		});
		const duplicate = child({
			id: 'duplicate-watch',
			cwd: '/repo/watch/duplicate',
			worktreeBranch: 'duplicate',
		});
		resetStores([parent, duplicate], parent.id);
		vi.mocked(gitService.getBranches).mockRejectedValueOnce(new Error('refs unavailable'));

		const { unmount } = renderHook(() => useWorktreeHandlers());
		expect(window.maestro.git.watchWorktreeDirectory).toHaveBeenCalledWith(
			parent.id,
			'/repo/watch'
		);
		expect(discoveredListener).toEqual(expect.any(Function));

		await act(async () => {
			await discoveredListener?.({
				sessionId: parent.id,
				worktree: { path: '/repo/watch/main', branch: 'main', name: 'main' },
			});
			await discoveredListener?.({
				sessionId: 'missing-parent',
				worktree: { path: '/repo/watch/missing', branch: 'missing', name: 'missing' },
			});
			await discoveredListener?.({
				sessionId: parent.id,
				worktree: { path: '/repo/watch/duplicate', branch: 'duplicate', name: 'duplicate' },
			});
			await discoveredListener?.({
				sessionId: parent.id,
				worktree: { path: '/repo/watch/new-watch', branch: 'new-watch', name: 'new-watch' },
			});
		});

		expect(gitService.getBranches).toHaveBeenCalledWith('/repo/watch/new-watch', 'ssh-watch');
		expect(allSessions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'duplicate-watch' }),
				expect.objectContaining({
					parentSessionId: parent.id,
					cwd: '/repo/watch/new-watch',
					worktreeBranch: 'new-watch',
				}),
			])
		);
		expect(allSessions().filter((item) => item.cwd === '/repo/watch/main')).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'New Worktree Discovered',
				message: 'new-watch',
			})
		);

		unmount();
		expect(watcherCleanup).toHaveBeenCalled();
		expect(window.maestro.git.unwatchWorktreeDirectory).toHaveBeenCalledWith(parent.id);
	});

	it('runs the legacy scanner on mount and focus while respecting removed and existing worktree paths', async () => {
		const legacyParent = session({
			id: 'legacy-parent',
			worktreeParentPath: '/legacy/worktrees',
			worktreeConfig: undefined,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'legacy-ssh' } as any,
		});
		const existing = child({
			id: 'legacy-existing',
			parentSessionId: undefined,
			worktreeParentPath: '/legacy/worktrees',
			cwd: '/legacy/worktrees/existing',
			projectRoot: '/legacy/worktrees/existing',
		});
		resetStores([legacyParent, existing], legacyParent.id);
		useSessionStore.setState({
			removedWorktreePaths: new Set(['/legacy/worktrees/removed']),
		});
		vi.mocked(window.maestro.git.scanWorktreeDirectory)
			.mockResolvedValueOnce({
				gitSubdirs: [
					{ path: '/legacy/worktrees/removed', branch: 'removed', name: 'removed' },
					{ path: '/legacy/worktrees/existing', branch: 'existing', name: 'existing' },
					{ path: '/legacy/worktrees/new-legacy', branch: 'new-legacy', name: 'new-legacy' },
				],
			})
			.mockResolvedValueOnce({
				gitSubdirs: [{ path: '/legacy/worktrees/focus-new', branch: null, name: 'focus-new' }],
			});

		renderHook(() => useWorktreeHandlers());

		await waitFor(() =>
			expect(allSessions()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						worktreeParentPath: '/legacy/worktrees',
						cwd: '/legacy/worktrees/new-legacy',
						name: 'new-legacy (new-legacy)',
					}),
				])
			)
		);

		document.dispatchEvent(new Event('visibilitychange'));
		await waitFor(() =>
			expect(allSessions()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						worktreeParentPath: '/legacy/worktrees',
						cwd: '/legacy/worktrees/focus-new',
						name: 'focus-new',
					}),
				])
			)
		);

		expect(window.maestro.git.scanWorktreeDirectory).toHaveBeenCalledWith(
			'/legacy/worktrees',
			'legacy-ssh'
		);
		expect(allSessions().some((item) => item.cwd === '/legacy/worktrees/removed')).toBe(false);
		expect(allSessions().filter((item) => item.cwd === '/legacy/worktrees/existing')).toHaveLength(
			1
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'New Worktree Discovered',
				message: 'new-legacy (new-legacy)',
			})
		);
	});
});
