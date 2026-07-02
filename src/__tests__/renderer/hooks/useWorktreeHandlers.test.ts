/**
 * Tests for useWorktreeHandlers hook
 *
 * Tests quick-access handlers, close handlers, save/disable worktree config,
 * create/delete worktree operations, toggle expansion, session inheritance,
 * and internal effects (startup scan, file watcher, legacy scanner).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock gitService before any imports that use it
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn().mockResolvedValue(['main', 'feature-1']),
		getTags: vi.fn().mockResolvedValue(['v1.0']),
	},
}));

// Mock notifyToast
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

// Mock generateId to produce deterministic IDs for testing
let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

// Mock sentry so the repo-root resolver tests can assert unexpected errors are
// reported (silent swallowing would re-introduce the wrong-parent bug with no
// production signal).
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { useWorktreeHandlers } from '../../../renderer/hooks/worktree/useWorktreeHandlers';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { gitService } from '../../../renderer/services/git';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { captureException } from '../../../renderer/utils/sentry';
import {
	markWorktreePathAsRecentlyCreated,
	clearRecentlyCreatedWorktreePath,
} from '../../../renderer/utils/worktreeDedup';
import type { Session } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

const mockGit = {
	scanWorktreeDirectory: vi.fn().mockResolvedValue({ gitSubdirs: [] }),
	watchWorktreeDirectory: vi.fn().mockResolvedValue({ success: true }),
	unwatchWorktreeDirectory: vi.fn(),
	onWorktreeDiscovered: vi.fn().mockReturnValue(() => {}),
	onWorktreeRemoved: vi.fn().mockReturnValue(() => {}),
	worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
	removeWorktree: vi.fn().mockResolvedValue({ success: true }),
	// Default: not a git repo. Tests that exercise the repoRoot filter override
	// this per-test to return matching/mismatching repoRoots.
	worktreeInfo: vi.fn().mockResolvedValue({ success: true, exists: false, isWorktree: false }),
};

const mockParentSession = {
	id: 'parent-1',
	name: 'Parent Agent',
	cwd: '/projects/myapp',
	fullPath: '/projects/myapp',
	projectRoot: '/projects/myapp',
	toolType: 'claude-code' as const,
	groupId: 'group-1',
	inputMode: 'ai' as const,
	state: 'idle',
	worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
	worktreesExpanded: false,
	customPath: '/usr/local/bin/claude',
	customArgs: ['--arg1'],
	customEnvVars: { KEY: 'val' },
	customModel: 'claude-3',
	customContextWindow: 200000,
	nudgeMessage: 'hello',
	autoRunFolderPath: '/auto',
	sessionSshRemoteConfig: undefined,
	sshRemoteId: undefined,
	aiTabs: [],
	activeTabId: null,
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	aiPid: 0,
	terminalPid: 0,
	port: 3000,
	isLive: false,
	changedFiles: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	executionQueue: [],
	activeTimeMs: 0,
	closedTabHistory: [],
	filePreviewTabs: [],
	activeFileTabId: null,
	unifiedTabOrder: [],
	unifiedClosedTabHistory: [],
} as any;

function createChildSession(overrides: Partial<Session> = {}): any {
	return {
		id: `child-${Math.random().toString(36).slice(2, 8)}`,
		name: 'Child Worktree',
		cwd: '/projects/worktrees/feature-1',
		fullPath: '/projects/worktrees/feature-1',
		projectRoot: '/projects/worktrees/feature-1',
		toolType: 'claude-code' as const,
		groupId: 'group-1',
		inputMode: 'ai' as const,
		state: 'idle',
		parentSessionId: 'parent-1',
		worktreeBranch: 'feature-1',
		aiTabs: [],
		activeTabId: null,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as any;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	idCounter = 0;
	useModalStore.setState({ modals: new Map() });
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		removedWorktreePaths: new Set(),
	} as any);
	useSettingsStore.setState({
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
	} as any);

	// Ensure window.maestro.git has our mocks
	if (!(window.maestro as any).git) {
		(window.maestro as any).git = {};
	}
	Object.assign((window.maestro as any).git, mockGit);
});

afterEach(() => {
	vi.useRealTimers();
	cleanup();
});

// ============================================================================
// Quick-access handlers
// ============================================================================

describe('Quick-access handlers', () => {
	it('handleOpenWorktreeConfig opens worktreeConfig modal', () => {
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleOpenWorktreeConfig();
		});

		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
	});

	it('handleQuickCreateWorktree sets createWorktree session in modalStore', () => {
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleQuickCreateWorktree(mockParentSession);
		});

		expect(useModalStore.getState().isOpen('createWorktree')).toBe(true);
		const data = useModalStore.getState().getData('createWorktree');
		expect(data?.session).toBe(mockParentSession);
	});

	it('handleOpenWorktreeConfigSession sets activeSessionId and opens worktreeConfig modal', () => {
		useSessionStore.setState({ sessions: [mockParentSession], activeSessionId: '' } as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleOpenWorktreeConfigSession(mockParentSession);
		});

		expect(useSessionStore.getState().activeSessionId).toBe('parent-1');
		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
	});

	it('handleDeleteWorktreeSession sets deleteWorktree session in modalStore', () => {
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleDeleteWorktreeSession(mockParentSession);
		});

		expect(useModalStore.getState().isOpen('deleteWorktree')).toBe(true);
		const data = useModalStore.getState().getData('deleteWorktree');
		expect(data?.session).toBe(mockParentSession);
	});

	it('handleToggleWorktreeExpanded toggles worktreesExpanded on session (both directions)', () => {
		// Default worktreesExpanded is undefined, which means expanded (true).
		// The toggle uses !(s.worktreesExpanded ?? true), so first toggle collapses.
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreesExpanded: undefined }],
			activeSessionId: 'parent-1',
		} as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		// Toggle from default (expanded) to collapsed
		act(() => {
			result.current.handleToggleWorktreeExpanded('parent-1');
		});

		let session = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(session?.worktreesExpanded).toBe(false);

		// Toggle from collapsed back to expanded
		act(() => {
			result.current.handleToggleWorktreeExpanded('parent-1');
		});

		session = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(session?.worktreesExpanded).toBe(true);
	});
});

// ============================================================================
// Close handlers
// ============================================================================

describe('Close handlers', () => {
	it('handleCloseWorktreeConfigModal closes worktreeConfig modal', () => {
		// Open the modal first
		getModalActions().setWorktreeConfigModalOpen(true);
		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleCloseWorktreeConfigModal();
		});

		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(false);
	});

	it('handleCloseCreateWorktreeModal closes modal and clears session', () => {
		// Open with session data
		getModalActions().setCreateWorktreeSession(mockParentSession);
		expect(useModalStore.getState().isOpen('createWorktree')).toBe(true);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleCloseCreateWorktreeModal();
		});

		expect(useModalStore.getState().isOpen('createWorktree')).toBe(false);
		expect(useModalStore.getState().getData('createWorktree')).toBeUndefined();
	});

	it('handleCloseDeleteWorktreeModal closes modal and clears session', () => {
		// Open with session data
		getModalActions().setDeleteWorktreeSession(mockParentSession);
		expect(useModalStore.getState().isOpen('deleteWorktree')).toBe(true);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleCloseDeleteWorktreeModal();
		});

		expect(useModalStore.getState().isOpen('deleteWorktree')).toBe(false);
		expect(useModalStore.getState().getData('deleteWorktree')).toBeUndefined();
	});
});

// ============================================================================
// handleSaveWorktreeConfig
// ============================================================================

describe('handleSaveWorktreeConfig', () => {
	it('saves config to the active session in sessionStore', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const session = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(session?.worktreeConfig).toEqual({
			basePath: '/projects/worktrees',
			watchEnabled: true,
		});
	});

	it('scans worktrees and creates new sub-agent sessions for discovered subdirs', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feature-1', branch: 'feature-1', name: 'feature-1' },
				{ path: '/projects/worktrees/feature-2', branch: 'feature-2', name: 'feature-2' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const sessions = useSessionStore.getState().sessions;
		// Parent + 2 new worktree sessions
		expect(sessions.length).toBe(3);
		expect(sessions.some((s) => s.worktreeBranch === 'feature-1')).toBe(true);
		expect(sessions.some((s) => s.worktreeBranch === 'feature-2')).toBe(true);
	});

	it('skips main/master/HEAD branches', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/main', branch: 'main', name: 'main' },
				{ path: '/projects/worktrees/master', branch: 'master', name: 'master' },
				{ path: '/projects/worktrees/HEAD', branch: 'HEAD', name: 'HEAD' },
				{ path: '/projects/worktrees/feature-x', branch: 'feature-x', name: 'feature-x' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const sessions = useSessionStore.getState().sessions;
		// Only parent + feature-x
		expect(sessions.length).toBe(2);
		expect(sessions.some((s) => s.worktreeBranch === 'feature-x')).toBe(true);
		expect(sessions.some((s) => s.worktreeBranch === 'main')).toBe(false);
	});

	it('skips existing sessions by path or parentSessionId+branch', async () => {
		const existingChild = createChildSession({
			id: 'existing-child',
			cwd: '/projects/worktrees/feature-1',
			worktreeBranch: 'feature-1',
			parentSessionId: 'parent-1',
		});

		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }, existingChild],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feature-1', branch: 'feature-1', name: 'feature-1' },
				{ path: '/projects/worktrees/feature-2', branch: 'feature-2', name: 'feature-2' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const sessions = useSessionStore.getState().sessions;
		// Parent + existing child + feature-2 only (feature-1 skipped)
		expect(sessions.length).toBe(3);
		const worktreeSessions = sessions.filter((s) => s.parentSessionId === 'parent-1');
		expect(worktreeSessions.length).toBe(2);
		expect(worktreeSessions.some((s) => s.worktreeBranch === 'feature-2')).toBe(true);
	});

	it('shows success toast with discovered count', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feat-a', branch: 'feat-a', name: 'feat-a' },
				{ path: '/projects/worktrees/feat-b', branch: 'feat-b', name: 'feat-b' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Worktrees Discovered',
				message: expect.stringContaining('2'),
			})
		);
	});

	it('does nothing when no activeSession', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'nonexistent',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
	});

	it('filters out scanned subdirs whose repoRoot does not match the parent repo', async () => {
		// Same repo-identity guard as scanWorktreeConfigs, applied at the moment
		// the user saves the worktree config. Without this, pointing the agent
		// at a basePath that contains worktrees from another repo would attach
		// them on the spot, before any later rescan could clean up.
		useSessionStore.setState({
			sessions: [
				{
					...mockParentSession,
					cwd: '/repos/repo-a',
					worktreeConfig: undefined,
				},
			],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.worktreeInfo.mockResolvedValueOnce({
			success: true,
			exists: true,
			isWorktree: false,
			repoRoot: '/repos/repo-a',
		});

		mockGit.scanWorktreeDirectory.mockResolvedValue({
			gitSubdirs: [
				{
					path: '/shared/worktrees/feat-mine',
					branch: 'feat-mine',
					name: 'feat-mine',
					repoRoot: '/repos/repo-a',
				},
				{
					path: '/shared/worktrees/feat-other',
					branch: 'feat-other',
					name: 'feat-other',
					repoRoot: '/repos/repo-b',
				},
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/shared/worktrees',
				watchEnabled: false,
			});
		});

		const sessions = useSessionStore.getState().sessions;
		const children = sessions.filter((s) => s.parentSessionId === 'parent-1');
		expect(children.map((s) => s.worktreeBranch)).toEqual(['feat-mine']);
	});
});

// ============================================================================
// handleDisableWorktreeConfig
// ============================================================================

describe('handleDisableWorktreeConfig', () => {
	it('removes all child sessions filtered by parentSessionId', () => {
		const child1 = createChildSession({ id: 'child-1', parentSessionId: 'parent-1' });
		const child2 = createChildSession({ id: 'child-2', parentSessionId: 'parent-1' });
		const unrelatedChild = createChildSession({ id: 'child-3', parentSessionId: 'other-parent' });

		useSessionStore.setState({
			sessions: [mockParentSession, child1, child2, unrelatedChild],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleDisableWorktreeConfig();
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.length).toBe(2); // parent + unrelated child
		expect(sessions.some((s) => s.id === 'parent-1')).toBe(true);
		expect(sessions.some((s) => s.id === 'child-3')).toBe(true);
	});

	it('clears worktreeConfig and worktreeParentPath on parent', () => {
		useSessionStore.setState({
			sessions: [
				{
					...mockParentSession,
					worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
					worktreeParentPath: '/legacy/path',
				},
			],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleDisableWorktreeConfig();
		});

		const parent = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(parent?.worktreeConfig).toBeUndefined();
		expect(parent?.worktreeParentPath).toBeUndefined();
	});

	it('shows toast with removed count', () => {
		const child1 = createChildSession({ id: 'child-1', parentSessionId: 'parent-1' });
		const child2 = createChildSession({ id: 'child-2', parentSessionId: 'parent-1' });

		useSessionStore.setState({
			sessions: [mockParentSession, child1, child2],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleDisableWorktreeConfig();
		});

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Worktrees Disabled',
				message: expect.stringContaining('Removed 2 worktree sub-agents'),
			})
		);
	});
});

// ============================================================================
// handleCreateWorktreeFromConfig
// ============================================================================

describe('handleCreateWorktreeFromConfig', () => {
	it('calls worktreeSetup IPC, creates session, and expands parent', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		expect(mockGit.worktreeSetup).toHaveBeenCalledWith(
			'/projects/myapp',
			'/projects/worktrees/feature-new',
			'feature-new',
			undefined
		);

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.length).toBe(2);
		const newSession = sessions.find((s) => s.worktreeBranch === 'feature-new');
		expect(newSession).toBeDefined();
		expect(newSession?.cwd).toBe('/projects/worktrees/feature-new');
		expect(newSession?.parentSessionId).toBe('parent-1');

		// Parent should be expanded
		const parent = sessions.find((s) => s.id === 'parent-1');
		expect(parent?.worktreesExpanded).toBe(true);
	});

	it('auto-focuses the new worktree session after creation', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		const sessions = useSessionStore.getState().sessions;
		const newSession = sessions.find((s) => s.worktreeBranch === 'feature-new');
		expect(newSession).toBeDefined();
		expect(useSessionStore.getState().activeSessionId).toBe(newSession!.id);
	});

	it('shows error toast on IPC failure and re-throws error', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.worktreeSetup.mockResolvedValueOnce({ success: false, error: 'branch exists' });

		const { result } = renderHook(() => useWorktreeHandlers());

		await expect(
			act(async () => {
				await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
			})
		).rejects.toThrow('branch exists');

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Failed to Create Worktree',
				message: 'branch exists',
			})
		);
	});

	it('marks path in recently-created set to prevent duplicate file watcher entries', async () => {
		vi.useFakeTimers();

		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		// The recently created path should be tracked (we verify indirectly via the
		// success of the operation - the path is stored in a ref). The setTimeout
		// to clear it should be set at 10000ms.
		expect(mockGit.worktreeSetup).toHaveBeenCalled();

		// Advance time past the cleanup timeout
		vi.advanceTimersByTime(10001);
	});

	it('shows error toast when no active session or basePath', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'nonexistent',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Error',
				message: 'No worktree directory configured',
			})
		);
	});

	it('opens existing worktree path when branch is already attached elsewhere', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.worktreeSetup.mockResolvedValueOnce({
			success: true,
			created: false,
			alreadyExisted: true,
			existingPath: '/projects/other/feature-new',
			currentBranch: 'feature-new',
			requestedBranch: 'feature-new',
			branchMismatch: false,
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		const sessions = useSessionStore.getState().sessions;
		const created = sessions.find((s) => s.worktreeBranch === 'feature-new');
		expect(created).toBeDefined();
		// Session must point at the resolved existing path, not the requested one
		expect(created?.cwd).toBe('/projects/other/feature-new');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'info',
				title: 'Worktree Already Existed',
			})
		);
	});

	it('focuses existing session and skips duplicate when branch is already open in Maestro', async () => {
		const existingChild = createChildSession({
			id: 'child-existing',
			cwd: '/projects/other/feature-new',
			worktreeBranch: 'feature-new',
		});

		useSessionStore.setState({
			sessions: [mockParentSession, existingChild],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.worktreeSetup.mockResolvedValueOnce({
			success: true,
			created: false,
			alreadyExisted: true,
			existingPath: '/projects/other/feature-new',
			currentBranch: 'feature-new',
			requestedBranch: 'feature-new',
			branchMismatch: false,
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		// No new session was added — count stays at 2
		expect(useSessionStore.getState().sessions.length).toBe(2);
		expect(useSessionStore.getState().activeSessionId).toBe('child-existing');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'info',
				title: 'Worktree Already Open',
			})
		);
	});

	it('focuses existing session via projectRoot match even when cwd has drifted into a subdir', async () => {
		// Child session has navigated into a subdirectory of the worktree.
		// The recovery flow must still detect the open session via projectRoot,
		// not cwd, otherwise it builds a duplicate session for the same worktree.
		const existingChild = createChildSession({
			id: 'child-drifted',
			cwd: '/projects/other/feature-new/src/components',
			projectRoot: '/projects/other/feature-new',
			worktreeBranch: 'feature-new',
		});

		useSessionStore.setState({
			sessions: [mockParentSession, existingChild],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.worktreeSetup.mockResolvedValueOnce({
			success: true,
			created: false,
			alreadyExisted: true,
			existingPath: '/projects/other/feature-new',
			currentBranch: 'feature-new',
			requestedBranch: 'feature-new',
			branchMismatch: false,
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
		});

		expect(useSessionStore.getState().sessions.length).toBe(2);
		expect(useSessionStore.getState().activeSessionId).toBe('child-drifted');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'info',
				title: 'Worktree Already Open',
			})
		);
	});
});

// ============================================================================
// handleCreateWorktree
// ============================================================================

describe('handleCreateWorktree', () => {
	it('reads session from modalStore data, creates worktree', async () => {
		// Set up the createWorktree session in modal store
		getModalActions().setCreateWorktreeSession(mockParentSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('new-branch');
		});

		expect(mockGit.worktreeSetup).toHaveBeenCalledWith(
			'/projects/myapp',
			'/projects/worktrees/new-branch',
			'new-branch',
			undefined,
			undefined
		);

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.some((s) => s.worktreeBranch === 'new-branch')).toBe(true);
	});

	it('auto-focuses the new worktree session after creation', async () => {
		getModalActions().setCreateWorktreeSession(mockParentSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('new-branch');
		});

		const sessions = useSessionStore.getState().sessions;
		const newSession = sessions.find((s) => s.worktreeBranch === 'new-branch');
		expect(newSession).toBeDefined();
		expect(useSessionStore.getState().activeSessionId).toBe(newSession!.id);
	});

	it('uses default basePath (parent cwd + /worktrees) when no worktreeConfig', async () => {
		const sessionNoConfig = {
			...mockParentSession,
			worktreeConfig: undefined,
			cwd: '/projects/myapp',
		};
		getModalActions().setCreateWorktreeSession(sessionNoConfig);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('new-branch');
		});

		// Default basePath: /projects/myapp -> /projects + /worktrees = /projects/worktrees
		expect(mockGit.worktreeSetup).toHaveBeenCalledWith(
			'/projects/myapp',
			'/projects/worktrees/new-branch',
			'new-branch',
			undefined,
			undefined
		);
	});

	it('forwards baseBranch as the 5th arg to worktreeSetup (regression: dropped baseBranch wasted Auto Runs)', async () => {
		// Regression for the bug where the user selected a base branch in the
		// UI but the new worktree silently came off the main repo's HEAD
		// instead. The fix: baseBranch must be forwarded all the way to the
		// IPC layer; the IPC handler then becomes the single point that
		// decides whether to honor it (depending on whether the named branch
		// already exists). Don't drop it on the floor in the renderer.
		getModalActions().setCreateWorktreeSession(mockParentSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('feature-from-rc', 'rc');
		});

		expect(mockGit.worktreeSetup).toHaveBeenCalledWith(
			'/projects/myapp',
			'/projects/worktrees/feature-from-rc',
			'feature-from-rc',
			undefined,
			'rc'
		);
	});

	it('forwards undefined baseBranch when caller omits it (legacy callers must not break)', async () => {
		// Pre-feature callers that only pass branchName should still work and
		// the IPC handler will fall back to the main repo's current HEAD.
		getModalActions().setCreateWorktreeSession(mockParentSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('feature-x');
		});

		expect(mockGit.worktreeSetup).toHaveBeenCalledWith(
			'/projects/myapp',
			'/projects/worktrees/feature-x',
			'feature-x',
			undefined,
			undefined
		);
	});

	it('saves worktreeConfig if not already set', async () => {
		const sessionNoConfig = {
			...mockParentSession,
			id: 'parent-no-config',
			worktreeConfig: undefined,
			cwd: '/projects/myapp',
		};

		// Put the session in the session store so setSessions can find it
		useSessionStore.setState({
			sessions: [sessionNoConfig],
			activeSessionId: 'parent-no-config',
		} as any);

		getModalActions().setCreateWorktreeSession(sessionNoConfig);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('new-branch');
		});

		const parent = useSessionStore.getState().sessions.find((s) => s.id === 'parent-no-config');
		expect(parent?.worktreeConfig).toEqual({
			basePath: '/projects/worktrees',
			watchEnabled: true,
		});
	});

	it('does nothing when no createWorktreeSession in modalStore', async () => {
		// Don't set any session in modal store
		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('new-branch');
		});

		expect(mockGit.worktreeSetup).not.toHaveBeenCalled();
	});
});

// ============================================================================
// handleConfirmDeleteWorktree
// ============================================================================

describe('handleConfirmDeleteWorktree', () => {
	it('removes session from state', () => {
		const childSession = createChildSession({ id: 'child-to-delete' });
		useSessionStore.setState({
			sessions: [mockParentSession, childSession],
			activeSessionId: 'parent-1',
		} as any);

		getModalActions().setDeleteWorktreeSession(childSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleConfirmDeleteWorktree();
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.length).toBe(1);
		expect(sessions[0].id).toBe('parent-1');
	});

	it('does nothing when no deleteWorktreeSession', () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleConfirmDeleteWorktree();
		});

		expect(useSessionStore.getState().sessions.length).toBe(1);
	});
});

// ============================================================================
// handleConfirmAndDeleteWorktreeOnDisk
// ============================================================================

describe('handleConfirmAndDeleteWorktreeOnDisk', () => {
	it('calls removeWorktree IPC and removes session on success', async () => {
		const childSession = createChildSession({
			id: 'child-to-delete-disk',
			cwd: '/projects/worktrees/feature-1',
		});
		useSessionStore.setState({
			sessions: [mockParentSession, childSession],
			activeSessionId: 'parent-1',
		} as any);

		getModalActions().setDeleteWorktreeSession(childSession);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleConfirmAndDeleteWorktreeOnDisk();
		});

		expect(mockGit.removeWorktree).toHaveBeenCalledWith('/projects/worktrees/feature-1', true);

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.length).toBe(1);
		expect(sessions[0].id).toBe('parent-1');
	});

	it('throws error on IPC failure', async () => {
		const childSession = createChildSession({ id: 'child-fail', cwd: '/path' });
		useSessionStore.setState({
			sessions: [mockParentSession, childSession],
			activeSessionId: 'parent-1',
		} as any);

		getModalActions().setDeleteWorktreeSession(childSession);
		mockGit.removeWorktree.mockResolvedValueOnce({ success: false, error: 'permission denied' });

		const { result } = renderHook(() => useWorktreeHandlers());

		await expect(
			act(async () => {
				await result.current.handleConfirmAndDeleteWorktreeOnDisk();
			})
		).rejects.toThrow('permission denied');

		// Session should NOT be removed since deletion failed
		expect(useSessionStore.getState().sessions.length).toBe(2);
	});

	it('does nothing when no deleteWorktreeSession', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleConfirmAndDeleteWorktreeOnDisk();
		});

		expect(mockGit.removeWorktree).not.toHaveBeenCalled();
	});
});

// ============================================================================
// handleToggleWorktreeExpanded
// ============================================================================

describe('handleToggleWorktreeExpanded', () => {
	it('toggles from default expanded (undefined, treated as true) to collapsed', () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreesExpanded: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleToggleWorktreeExpanded('parent-1');
		});

		const session = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(session?.worktreesExpanded).toBe(false);
	});

	it('toggles from explicitly false to true', () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreesExpanded: false }],
			activeSessionId: 'parent-1',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleToggleWorktreeExpanded('parent-1');
		});

		const session = useSessionStore.getState().sessions.find((s) => s.id === 'parent-1');
		expect(session?.worktreesExpanded).toBe(true);
	});
});

// ============================================================================
// Session inheritance via buildWorktreeSession (tested through handler behavior)
// ============================================================================

describe('Session inheritance via buildWorktreeSession', () => {
	it('created session inherits toolType, groupId, customPath, customArgs from parent', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feature-1', branch: 'feature-1', name: 'feature-1' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const child = useSessionStore.getState().sessions.find((s) => s.worktreeBranch === 'feature-1');
		expect(child).toBeDefined();
		expect(child?.toolType).toBe('claude-code');
		expect(child?.groupId).toBe('group-1');
		expect(child?.customPath).toBe('/usr/local/bin/claude');
		expect(child?.customArgs).toEqual(['--arg1']);
		expect(child?.customEnvVars).toEqual({ KEY: 'val' });
		expect(child?.customModel).toBe('claude-3');
	});

	it('created session gets correct worktreeBranch and parentSessionId', async () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feature-x', branch: 'feature-x', name: 'feature-x' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const child = useSessionStore.getState().sessions.find((s) => s.worktreeBranch === 'feature-x');
		expect(child?.parentSessionId).toBe('parent-1');
		expect(child?.worktreeBranch).toBe('feature-x');
		expect(child?.cwd).toBe('/projects/worktrees/feature-x');
		expect(child?.fullPath).toBe('/projects/worktrees/feature-x');
	});

	it('SSH config is inherited from parent', async () => {
		const sshParent = {
			...mockParentSession,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'ssh-remote-1',
				host: 'dev.example.com',
			},
		};

		useSessionStore.setState({
			sessions: [sshParent],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/feature-ssh', branch: 'feature-ssh', name: 'feature-ssh' },
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const child = useSessionStore
			.getState()
			.sessions.find((s) => s.worktreeBranch === 'feature-ssh');
		expect(child?.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'ssh-remote-1',
			host: 'dev.example.com',
		});
	});
});

// ============================================================================
// Effects
// ============================================================================

describe('Effects', () => {
	describe('Startup scan effect', () => {
		it('runs when sessionsLoaded becomes true', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/projects/worktrees/feat-startup',
						branch: 'feat-startup',
						name: 'feat-startup',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Startup scan has 500ms delay
			await act(async () => {
				vi.advanceTimersByTime(501);
				// Flush pending promises
				await vi.runAllTimersAsync();
			});

			expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledWith('/projects/worktrees', undefined);
		});

		it('creates sessions for discovered worktrees', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/projects/worktrees/startup-1', branch: 'startup-1', name: 'startup-1' },
					{ path: '/projects/worktrees/startup-2', branch: 'startup-2', name: 'startup-2' },
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			const worktreeSessions = sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(worktreeSessions.length).toBe(2);
		});

		it('skips existing sessions on startup scan', async () => {
			vi.useFakeTimers();

			const existingChild = createChildSession({
				id: 'existing-startup',
				cwd: '/projects/worktrees/existing-branch',
				worktreeBranch: 'existing-branch',
				parentSessionId: 'parent-1',
			});

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/projects/worktrees/existing-branch',
						branch: 'existing-branch',
						name: 'existing-branch',
					},
					{ path: '/projects/worktrees/new-branch', branch: 'new-branch', name: 'new-branch' },
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, existingChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			const worktreeSessions = sessions.filter((s) => s.parentSessionId === 'parent-1');
			// Only the existing child + the new one
			expect(worktreeSessions.length).toBe(2);
			expect(worktreeSessions.some((s) => s.id === 'existing-startup')).toBe(true);
			expect(worktreeSessions.some((s) => s.worktreeBranch === 'new-branch')).toBe(true);
		});
		it('removes stale child sessions whose worktree no longer exists on disk', async () => {
			vi.useFakeTimers();

			const staleChild = createChildSession({
				id: 'stale-child',
				cwd: '/projects/worktrees/deleted-branch',
				worktreeBranch: 'deleted-branch',
				parentSessionId: 'parent-1',
			});

			const validChild = createChildSession({
				id: 'valid-child',
				cwd: '/projects/worktrees/valid-branch',
				worktreeBranch: 'valid-branch',
				parentSessionId: 'parent-1',
			});

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/projects/worktrees/valid-branch',
						branch: 'valid-branch',
						name: 'valid-branch',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, staleChild, validChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.id === 'stale-child')).toBe(false);
			expect(sessions.some((s) => s.id === 'valid-child')).toBe(true);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'info', title: 'Worktree Removed' })
			);
		});

		it('preserves child sessions whose cwd is a nested path under basePath', async () => {
			// Regression for #931: worktrees from slash-named branches live at
			// <basePath>/<group>/<branch> (e.g. /projects/worktrees/fix/foo). The
			// main process now recurses one level so gitSubdirs includes those
			// paths; this test pins that the renderer's stale-detection treats
			// nested entries the same as flat ones (no spurious removal).
			vi.useFakeTimers();

			const flatChild = createChildSession({
				id: 'flat-child',
				cwd: '/projects/worktrees/feature-flat',
				worktreeBranch: 'feature-flat',
				parentSessionId: 'parent-1',
			});
			const nestedChild = createChildSession({
				id: 'nested-child',
				cwd: '/projects/worktrees/fix/worktree-removal',
				worktreeBranch: 'fix/worktree-removal',
				parentSessionId: 'parent-1',
			});

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/projects/worktrees/feature-flat',
						branch: 'feature-flat',
						name: 'feature-flat',
					},
					{
						path: '/projects/worktrees/fix/worktree-removal',
						branch: 'fix/worktree-removal',
						name: 'worktree-removal',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, flatChild, nestedChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			(notifyToast as any).mockClear();
			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.id === 'flat-child')).toBe(true);
			expect(sessions.some((s) => s.id === 'nested-child')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('does NOT remove child sessions when scan reports scanFailed', async () => {
			vi.useFakeTimers();

			const child = createChildSession({
				id: 'child-on-disk',
				cwd: '/projects/worktrees/feature-branch',
				worktreeBranch: 'feature-branch',
				parentSessionId: 'parent-1',
			});

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [],
				scanFailed: true,
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, child],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			(notifyToast as any).mockClear();
			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.id === 'child-on-disk')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('does NOT remove all child sessions when scan returns zero subdirs (suspicious empty)', async () => {
			vi.useFakeTimers();

			const childA = createChildSession({
				id: 'child-a',
				cwd: '/projects/worktrees/feature-a',
				worktreeBranch: 'feature-a',
				parentSessionId: 'parent-1',
			});
			const childB = createChildSession({
				id: 'child-b',
				cwd: '/projects/worktrees/feature-b',
				worktreeBranch: 'feature-b',
				parentSessionId: 'parent-1',
			});

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			// Scan succeeded but found nothing — most commonly because of a symlinked
			// basePath or transient filesystem hiccup. Should NOT bulk-remove sessions.
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, childA, childB],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			(notifyToast as any).mockClear();
			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.id === 'child-a')).toBe(true);
			expect(sessions.some((s) => s.id === 'child-b')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('exposes refreshWorktreeState that can be called manually', async () => {
			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/projects/worktrees/manual-branch',
						branch: 'manual-branch',
						name: 'manual-branch',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			const { result } = renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await result.current.refreshWorktreeState();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.worktreeBranch === 'manual-branch')).toBe(true);
		});
	});

	describe('File watcher effect', () => {
		it('starts watchers for sessions with watchEnabled', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledWith(
				'parent-1',
				'/projects/worktrees'
			);
			expect(mockGit.onWorktreeDiscovered).toHaveBeenCalled();
		});

		it('cleans up watchers on unmount', () => {
			const cleanupFn = vi.fn();
			mockGit.onWorktreeDiscovered.mockReturnValue(cleanupFn);

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			const { unmount } = renderHook(() => useWorktreeHandlers());

			unmount();

			expect(cleanupFn).toHaveBeenCalled();
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledWith('parent-1');
		});

		it('does NOT restart watcher when unrelated sessions are added or removed', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Watcher started once on mount
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledTimes(0);

			// Add an unrelated session (no worktreeConfig)
			act(() => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					{
						...createChildSession({ id: 'unrelated-agent', parentSessionId: undefined }),
						worktreeConfig: undefined,
					},
				]);
			});

			// Watcher should NOT have been torn down and restarted
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledTimes(0);
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);
		});

		it('does NOT restart watcher when worktree child sessions are added', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledTimes(0);

			// Add a worktree child session (has parentSessionId but no worktreeConfig)
			act(() => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					createChildSession({
						id: 'new-child',
						parentSessionId: 'parent-1',
						worktreeBranch: 'feature-2',
						cwd: '/projects/worktrees/feature-2',
					}),
				]);
			});

			// Watcher should NOT have been torn down and restarted
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledTimes(0);
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);
		});

		it('DOES restart watcher when worktreeConfig changes on a parent session', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);

			// Change the basePath on the parent session
			act(() => {
				useSessionStore
					.getState()
					.setSessions((prev) =>
						prev.map((s) =>
							s.id === 'parent-1'
								? { ...s, worktreeConfig: { basePath: '/new/worktrees', watchEnabled: true } }
								: s
						)
					);
			});

			// Watcher should have been torn down and restarted with new path
			expect(mockGit.unwatchWorktreeDirectory).toHaveBeenCalledWith('parent-1');
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(2);
			expect(mockGit.watchWorktreeDirectory).toHaveBeenLastCalledWith('parent-1', '/new/worktrees');
		});

		it('DOES restart watcher when a new parent session gets worktreeConfig', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(1);

			// Add a second parent session with its own worktreeConfig
			act(() => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					{
						...mockParentSession,
						id: 'parent-2',
						name: 'Second Parent',
						cwd: '/projects/other-app',
						worktreeConfig: { basePath: '/projects/other-worktrees', watchEnabled: true },
					},
				]);
			});

			// Watcher effect should re-run and start watchers for both parents
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledTimes(3); // 1 initial + 2 on re-run
			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledWith(
				'parent-2',
				'/projects/other-worktrees'
			);
		});

		it('logs error when watcher IPC call fails', async () => {
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			mockGit.watchWorktreeDirectory.mockResolvedValueOnce({
				success: false,
				error: 'Directory not found',
			});

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Let the promise settle
			await act(async () => {
				await new Promise((r) => setTimeout(r, 0));
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[WorktreeWatcher]'),
				undefined,
				expect.stringContaining('Directory not found')
			);

			consoleSpy.mockRestore();
		});
	});

	describe('Visibility-change rescan', () => {
		it('rescans worktree directories when app regains focus', async () => {
			vi.useFakeTimers();

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/projects/worktrees/cli-branch', branch: 'cli-branch', name: 'cli-branch' },
				],
			});

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Run startup scan timer
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Reset mock to track visibility-change calls separately
			mockGit.scanWorktreeDirectory.mockClear();
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/projects/worktrees/cli-branch', branch: 'cli-branch', name: 'cli-branch' },
					{
						path: '/projects/worktrees/new-cli-branch',
						branch: 'new-cli-branch',
						name: 'new-cli-branch',
					},
				],
			});

			// Simulate app regaining focus
			await act(async () => {
				Object.defineProperty(document, 'hidden', { value: false, writable: true });
				document.dispatchEvent(new Event('visibilitychange'));
				await vi.runAllTimersAsync();
			});

			// Should have rescanned
			expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledWith('/projects/worktrees', undefined);

			// New worktree session should have been created
			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.worktreeBranch === 'new-cli-branch')).toBe(true);
		});

		it('does NOT rescan when app is hidden', () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			mockGit.scanWorktreeDirectory.mockClear();

			// Simulate app going to background
			Object.defineProperty(document, 'hidden', { value: true, writable: true });
			document.dispatchEvent(new Event('visibilitychange'));

			expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
		});

		it('cleans up visibility listener on unmount', () => {
			const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			const { unmount } = renderHook(() => useWorktreeHandlers());

			unmount();

			expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

			removeListenerSpy.mockRestore();
		});
	});

	describe('Worktree removal detection', () => {
		it('removes child session when worktree:removed event fires', () => {
			let removalCallback: ((data: any) => void) | undefined;
			mockGit.onWorktreeRemoved.mockImplementation((cb: any) => {
				removalCallback = cb;
				return () => {};
			});

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			const child = createChildSession({
				id: 'child-to-remove',
				cwd: '/projects/worktrees/feature-1',
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature-1',
			});

			useSessionStore.setState({
				sessions: [parentWithWatch, child],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Simulate worktree removal from CLI
			act(() => {
				removalCallback!({
					sessionId: 'parent-1',
					worktreePath: '/projects/worktrees/feature-1',
				});
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.find((s) => s.id === 'child-to-remove')).toBeUndefined();
			expect(sessions.find((s) => s.id === 'parent-1')).toBeDefined();
		});

		it('does not remove sessions when path does not match any child', () => {
			let removalCallback: ((data: any) => void) | undefined;
			mockGit.onWorktreeRemoved.mockImplementation((cb: any) => {
				removalCallback = cb;
				return () => {};
			});

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			const child = createChildSession({
				id: 'child-stays',
				cwd: '/projects/worktrees/feature-1',
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature-1',
			});

			useSessionStore.setState({
				sessions: [parentWithWatch, child],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Fire removal for a path that doesn't match any child
			act(() => {
				removalCallback!({
					sessionId: 'parent-1',
					worktreePath: '/projects/worktrees/nonexistent',
				});
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(2);
		});

		it('cleans up removal listener on unmount', () => {
			const cleanupFn = vi.fn();
			mockGit.onWorktreeRemoved.mockReturnValue(cleanupFn);

			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			const { unmount } = renderHook(() => useWorktreeHandlers());
			unmount();

			expect(cleanupFn).toHaveBeenCalled();
		});
	});

	describe('Repo-identity filter (parent ↔ subdir.repoRoot match)', () => {
		// Regression for the "worktrees re-added under a wrong agent" bug. After
		// the worktree-wipe bug (PR #931 missing), the renderer would happily
		// attach every worktree found under basePath to whichever parent agent's
		// scan iterated first — even when those worktrees belonged to a different
		// repo entirely.

		it('filters out scanned subdirs whose repoRoot does not match the parent repo', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// Parent's main repo
			mockGit.worktreeInfo.mockResolvedValueOnce({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repos/repo-a',
			});

			// Two subdirs in the basePath: one belongs to repo-a, the other to repo-b
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-mine',
						branch: 'feat-mine',
						name: 'feat-mine',
						repoRoot: '/repos/repo-a',
					},
					{
						path: '/shared/worktrees/feat-other',
						branch: 'feat-other',
						name: 'feat-other',
						repoRoot: '/repos/repo-b',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			const children = sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(children.map((s) => s.worktreeBranch).sort()).toEqual(['feat-mine']);
		});

		it('detaches a child whose cwd is a worktree of a different repo (self-heals wrong-agent attachment)', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// Wrong-agent child: was attached to repo-a's parent, but its cwd is
			// actually a worktree of repo-b.
			const wrongAgentChild = createChildSession({
				id: 'wrong-agent-child',
				cwd: '/shared/worktrees/feat-other',
				worktreeBranch: 'feat-other',
				parentSessionId: 'parent-1',
			});
			const correctChild = createChildSession({
				id: 'correct-child',
				cwd: '/shared/worktrees/feat-mine',
				worktreeBranch: 'feat-mine',
				parentSessionId: 'parent-1',
			});

			mockGit.worktreeInfo.mockResolvedValueOnce({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repos/repo-a',
			});

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-mine',
						branch: 'feat-mine',
						name: 'feat-mine',
						repoRoot: '/repos/repo-a',
					},
					{
						path: '/shared/worktrees/feat-other',
						branch: 'feat-other',
						name: 'feat-other',
						repoRoot: '/repos/repo-b',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig, wrongAgentChild, correctChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			(notifyToast as any).mockClear();
			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.some((s) => s.id === 'wrong-agent-child')).toBe(false);
			expect(sessions.some((s) => s.id === 'correct-child')).toBe(true);
			// Wrong-agent detachments must NOT fire the misleading "Worktree Removed"
			// toast — the worktree still exists on disk. Use "Worktree Re-assigned"
			// (or no toast) so the user isn't told the worktree was deleted.
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Re-assigned', message: 'feat-other' })
			);
		});

		it('attaches wrong-agent child to the correct parent in the same scan pass', async () => {
			// Regression for the "queued stale children block same-pass reattachment"
			// edge case: parent-a flags a misattached child for detachment, then
			// parent-b's iteration must NOT skip that path because of the
			// (about-to-be-removed) wrong-agent session still in the store.
			vi.useFakeTimers();

			const parentA = {
				...mockParentSession,
				id: 'parent-a',
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};
			const parentB = {
				...mockParentSession,
				id: 'parent-b',
				cwd: '/repos/repo-b',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// Wrong-agent child: cwd is a worktree of repo-b but it's attached to parent-a
			const wrongAgentChild = createChildSession({
				id: 'wrong-agent-child',
				cwd: '/shared/worktrees/feat-b',
				worktreeBranch: 'feat-b',
				parentSessionId: 'parent-a',
			});

			// First call (parent-a) → repo-a; second call (parent-b) → repo-b
			mockGit.worktreeInfo
				.mockResolvedValueOnce({
					success: true,
					exists: true,
					isWorktree: false,
					repoRoot: '/repos/repo-a',
				})
				.mockResolvedValueOnce({
					success: true,
					exists: true,
					isWorktree: false,
					repoRoot: '/repos/repo-b',
				});

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-b',
						branch: 'feat-b',
						name: 'feat-b',
						repoRoot: '/repos/repo-b',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentA, parentB, wrongAgentChild],
				activeSessionId: 'parent-a',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			// Old child gone, new child created under the correct parent in the same pass
			expect(sessions.some((s) => s.id === 'wrong-agent-child')).toBe(false);
			const childrenB = sessions.filter((s) => s.parentSessionId === 'parent-b');
			expect(childrenB).toHaveLength(1);
			expect(childrenB[0].worktreeBranch).toBe('feat-b');
			expect(childrenB[0].cwd).toBe('/shared/worktrees/feat-b');
		});

		it('two parents sharing a basePath each receive only their own repo worktrees', async () => {
			vi.useFakeTimers();

			const parentA = {
				...mockParentSession,
				id: 'parent-a',
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};
			const parentB = {
				...mockParentSession,
				id: 'parent-b',
				cwd: '/repos/repo-b',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// First call (parent-a's scan) → resolve parent-a's repoRoot
			// Second call (parent-b's scan) → resolve parent-b's repoRoot
			mockGit.worktreeInfo
				.mockResolvedValueOnce({
					success: true,
					exists: true,
					isWorktree: false,
					repoRoot: '/repos/repo-a',
				})
				.mockResolvedValueOnce({
					success: true,
					exists: true,
					isWorktree: false,
					repoRoot: '/repos/repo-b',
				});

			// Both parents see the same scan result (same basePath)
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-a',
						branch: 'feat-a',
						name: 'feat-a',
						repoRoot: '/repos/repo-a',
					},
					{
						path: '/shared/worktrees/feat-b',
						branch: 'feat-b',
						name: 'feat-b',
						repoRoot: '/repos/repo-b',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentA, parentB],
				activeSessionId: 'parent-a',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			const childrenA = sessions.filter((s) => s.parentSessionId === 'parent-a');
			const childrenB = sessions.filter((s) => s.parentSessionId === 'parent-b');
			expect(childrenA.map((s) => s.worktreeBranch)).toEqual(['feat-a']);
			expect(childrenB.map((s) => s.worktreeBranch)).toEqual(['feat-b']);
		});

		it('two SAME-repo parents each get their own child for the same worktree (rescan matches per-parent chokidar fan-out)', async () => {
			vi.useFakeTimers();

			// Both parents live in the same repo and share a basePath. On a restart /
			// visibility rescan the single shared worktree must fan out to BOTH parents,
			// mirroring the per-parent chokidar discovery. A global cwd dedup would let
			// whichever parent iterates first claim it and silently drop the other's
			// child.
			const parentA = {
				...mockParentSession,
				id: 'parent-a',
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};
			const parentB = {
				...mockParentSession,
				id: 'parent-b',
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// Both parents resolve to the same repo root.
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repos/repo-a',
			});

			// One worktree, belonging to the shared repo.
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-shared',
						branch: 'feat-shared',
						name: 'feat-shared',
						repoRoot: '/repos/repo-a',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentA, parentB],
				activeSessionId: 'parent-a',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const sessions = useSessionStore.getState().sessions;
			const childrenA = sessions.filter((s) => s.parentSessionId === 'parent-a');
			const childrenB = sessions.filter((s) => s.parentSessionId === 'parent-b');
			expect(childrenA.map((s) => s.worktreeBranch)).toEqual(['feat-shared']);
			expect(childrenB.map((s) => s.worktreeBranch)).toEqual(['feat-shared']);
		});

		it('falls back to legacy behavior when the parent repoRoot cannot be resolved', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				cwd: '/repos/not-a-git-repo',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// worktreeInfo says the parent path isn't a git repo
			mockGit.worktreeInfo.mockResolvedValueOnce({
				success: true,
				exists: false,
				isWorktree: false,
			});

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat',
						branch: 'feat',
						name: 'feat',
						repoRoot: '/repos/repo-a',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Fall-back path: when we can't determine the parent's repo, don't filter.
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(children).toHaveLength(1);
			expect(children[0].worktreeBranch).toBe('feat');
		});

		it('falls back to legacy behavior when subdir.repoRoot is null', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			mockGit.worktreeInfo.mockResolvedValueOnce({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repos/repo-a',
			});

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat',
						branch: 'feat',
						name: 'feat',
						repoRoot: null,
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(children).toHaveLength(1);
		});

		it('chokidar onWorktreeDiscovered rejects a worktree from a different repo', async () => {
			let discoveryCallback: ((data: any) => Promise<void>) | undefined;
			mockGit.onWorktreeDiscovered.mockImplementation((cb: any) => {
				discoveryCallback = cb;
				return () => {};
			});

			const parentWithWatch = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// First worktreeInfo call: the discovered worktree path → repo-b
			// Second worktreeInfo call: the parent's cwd → repo-a
			// (Renderer fires both in parallel via Promise.all, so order doesn't
			// matter — we just need both to resolve to non-matching repos.)
			mockGit.worktreeInfo.mockImplementation(async (path: string) => {
				if (path === '/shared/worktrees/feat-other') {
					return {
						success: true,
						exists: true,
						isWorktree: true,
						repoRoot: '/repos/repo-b',
					};
				}
				if (path === '/repos/repo-a') {
					return {
						success: true,
						exists: true,
						isWorktree: false,
						repoRoot: '/repos/repo-a',
					};
				}
				return { success: true, exists: false, isWorktree: false };
			});

			await act(async () => {
				await discoveryCallback!({
					sessionId: 'parent-1',
					worktree: {
						path: '/shared/worktrees/feat-other',
						name: 'feat-other',
						branch: 'feat-other',
					},
				});
			});

			const sessions = useSessionStore.getState().sessions;
			const children = sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(children).toHaveLength(0);
		});

		it('chokidar onWorktreeDiscovered accepts a worktree from the matching repo', async () => {
			let discoveryCallback: ((data: any) => Promise<void>) | undefined;
			mockGit.onWorktreeDiscovered.mockImplementation((cb: any) => {
				discoveryCallback = cb;
				return () => {};
			});

			const parentWithWatch = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			mockGit.worktreeInfo.mockImplementation(async (path: string) => {
				if (path === '/shared/worktrees/feat-mine') {
					return {
						success: true,
						exists: true,
						isWorktree: true,
						repoRoot: '/repos/repo-a',
					};
				}
				if (path === '/repos/repo-a') {
					return {
						success: true,
						exists: true,
						isWorktree: false,
						repoRoot: '/repos/repo-a',
					};
				}
				return { success: true, exists: false, isWorktree: false };
			});

			await act(async () => {
				await discoveryCallback!({
					sessionId: 'parent-1',
					worktree: {
						path: '/shared/worktrees/feat-mine',
						name: 'feat-mine',
						branch: 'feat-mine',
					},
				});
			});

			const sessions = useSessionStore.getState().sessions;
			const children = sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(children).toHaveLength(1);
			expect(children[0].worktreeBranch).toBe('feat-mine');
		});

		it('reports unexpected worktreeInfo errors to Sentry from resolveRepoRoot (does not silently swallow)', async () => {
			vi.useFakeTimers();
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			const parentWithConfig = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};

			// Simulate an unexpected IPC failure (e.g. main-process handler regressed
			// or threw). Without the error-reporting fix, this would silently disable
			// the repo-root guard with no production signal.
			const unexpectedErr = new Error('IPC handler crashed');
			mockGit.worktreeInfo.mockRejectedValueOnce(unexpectedErr);

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat',
						branch: 'feat',
						name: 'feat',
						repoRoot: '/repos/repo-a',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parentWithConfig],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			(captureException as any).mockClear();
			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(captureException).toHaveBeenCalledWith(
				unexpectedErr,
				expect.objectContaining({
					extra: expect.objectContaining({ source: 'resolveRepoRoot' }),
				})
			);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('resolveRepoRoot failed'),
				undefined,
				expect.stringContaining('IPC handler crashed')
			);

			consoleSpy.mockRestore();
		});

		it('reports unexpected worktreeInfo errors from the chokidar discovery handler', async () => {
			let discoveryCallback: ((data: any) => Promise<void>) | undefined;
			mockGit.onWorktreeDiscovered.mockImplementation((cb: any) => {
				discoveryCallback = cb;
				return () => {};
			});

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			const parentWithWatch = {
				...mockParentSession,
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			// Parent lookup succeeds; discovered-path lookup throws.
			const unexpectedErr = new Error('renderer IPC bridge dropped');
			mockGit.worktreeInfo.mockImplementation(async (path: string) => {
				if (path === '/repos/repo-a') {
					return {
						success: true,
						exists: true,
						isWorktree: false,
						repoRoot: '/repos/repo-a',
					};
				}
				throw unexpectedErr;
			});

			(captureException as any).mockClear();

			await act(async () => {
				await discoveryCallback!({
					sessionId: 'parent-1',
					worktree: {
						path: '/shared/worktrees/feat',
						name: 'feat',
						branch: 'feat',
					},
				});
			});

			expect(captureException).toHaveBeenCalledWith(
				unexpectedErr,
				expect.objectContaining({
					extra: expect.objectContaining({ source: 'onWorktreeDiscovered' }),
				})
			);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('worktreeInfo failed'),
				undefined,
				expect.stringContaining('renderer IPC bridge dropped')
			);

			consoleSpy.mockRestore();
		});
	});
});

// ============================================================================
// Worktree attribution across same-repo agents (PR #946)
// ============================================================================
//
// Background: an Auto Run launched from web-desktop with auto-worktree enabled
// created the worktree on disk, but the resulting child session ended up under a
// *different* agent in the same working folder than the one the launch targeted.
//
// chokidar in the main process runs ONE watcher per watching agent and fires
// `worktree:discovered` carrying that watcher's sessionId
// (src/main/ipc/handlers/git.ts). The intended behavior:
//   - Maestro-spawned worktrees (web Auto Run, Create Worktree) attach to the
//     launching agent. spawnWorktreeAgentAndDispatch marks the resolved path as
//     recently-created so every watcher skips it (the spawn already built the
//     child under the launcher).
//   - Externally-created worktrees (`git worktree add` from a shell) fan out:
//     EVERY same-repo agent watching the basePath gets its own child, because
//     dedup in onWorktreeDiscovered is scoped per-parent, not globally by cwd.
describe('Worktree attribution across same-repo agents (PR #946)', () => {
	let discoveryCallback: ((data: any) => Promise<void>) | undefined;

	beforeEach(() => {
		discoveryCallback = undefined;
		mockGit.onWorktreeDiscovered.mockImplementation((cb: any) => {
			discoveryCallback = cb;
			return () => {};
		});
		// Same-repo for both the parent cwd lookup (resolveRepoRoot) and the
		// discovered path, so the repo-identity guard in onWorktreeDiscovered lets
		// the discovery through. Individual tests override as needed.
		mockGit.worktreeInfo.mockImplementation(async () => ({
			success: true,
			exists: true,
			isWorktree: true,
			repoRoot: '/repos/repo-a',
		}));
	});

	function watcherAgent(id: string) {
		return {
			...mockParentSession,
			id,
			name: `Agent ${id}`,
			cwd: '/repos/repo-a',
			worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: true },
		};
	}

	const DISCOVERED = {
		path: '/shared/worktrees/feat-autorun',
		name: 'feat-autorun',
		branch: 'feat-autorun',
	};

	it('Maestro-spawned worktree (dedup mark active) is skipped by sibling watchers; the launcher already owns it', async () => {
		useSessionStore.setState({
			sessions: [watcherAgent('sibling-B')],
			activeSessionId: 'sibling-B',
			sessionsLoaded: false,
		} as any);

		renderHook(() => useWorktreeHandlers());

		// spawnWorktreeAgentAndDispatch marks the resolved path before/while it
		// creates the worktree and builds the child under the launching agent. Any
		// watcher that fires for that path must skip it.
		markWorktreePathAsRecentlyCreated(DISCOVERED.path);

		await act(async () => {
			await discoveryCallback!({ sessionId: 'sibling-B', worktree: DISCOVERED });
		});

		const children = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === 'sibling-B');
		expect(children).toHaveLength(0);

		clearRecentlyCreatedWorktreePath(DISCOVERED.path);
	});

	it('external worktree fans out: a second same-repo agent gets its OWN child even when another agent already owns one', async () => {
		const agentA = {
			...watcherAgent('agent-A'),
			worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
		};
		// agent-A already has a child for the worktree (e.g. its own watcher fired
		// first, or it spawned it). agent-B's watcher fires next.
		const childUnderA = createChildSession({
			id: 'child-under-A',
			cwd: DISCOVERED.path,
			projectRoot: DISCOVERED.path,
			parentSessionId: 'agent-A',
			worktreeBranch: DISCOVERED.branch,
		});

		useSessionStore.setState({
			sessions: [agentA, watcherAgent('agent-B'), childUnderA],
			activeSessionId: 'agent-A',
			sessionsLoaded: false,
		} as any);

		renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await discoveryCallback!({ sessionId: 'agent-B', worktree: DISCOVERED });
		});

		const sessions = useSessionStore.getState().sessions;
		// agent-A keeps its child; agent-B gains its own. Both agents in the cwd now
		// see the worktree.
		expect(sessions.some((s) => s.id === 'child-under-A')).toBe(true);
		const underB = sessions.filter((s) => s.parentSessionId === 'agent-B');
		expect(underB).toHaveLength(1);
		expect(underB[0].worktreeBranch).toBe(DISCOVERED.branch);
	});

	it('each same-repo watcher independently adopts a newly discovered external worktree', async () => {
		useSessionStore.setState({
			sessions: [watcherAgent('agent-A'), watcherAgent('agent-B')],
			activeSessionId: 'agent-A',
			sessionsLoaded: false,
		} as any);

		renderHook(() => useWorktreeHandlers());

		// Each agent's own watcher fires its own discovery event.
		await act(async () => {
			await discoveryCallback!({ sessionId: 'agent-A', worktree: DISCOVERED });
			await discoveryCallback!({ sessionId: 'agent-B', worktree: DISCOVERED });
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.filter((s) => s.parentSessionId === 'agent-A')).toHaveLength(1);
		expect(sessions.filter((s) => s.parentSessionId === 'agent-B')).toHaveLength(1);
	});

	it('a watcher does not create a second child for a worktree it already owns (per-parent idempotency)', async () => {
		useSessionStore.setState({
			sessions: [watcherAgent('agent-A')],
			activeSessionId: 'agent-A',
			sessionsLoaded: false,
		} as any);

		renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await discoveryCallback!({ sessionId: 'agent-A', worktree: DISCOVERED });
		});
		await act(async () => {
			await discoveryCallback!({ sessionId: 'agent-A', worktree: DISCOVERED });
		});

		const underA = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === 'agent-A');
		expect(underA).toHaveLength(1);
	});

	it('does not attach a worktree from a different repo even when a sibling watches the same basePath', async () => {
		// Repo-identity guard still applies per-parent: agent-A is in repo-a, the
		// discovered worktree belongs to repo-b → no child for agent-A.
		mockGit.worktreeInfo.mockImplementation(async (path: string) => {
			if (path === DISCOVERED.path) {
				return { success: true, exists: true, isWorktree: true, repoRoot: '/repos/repo-b' };
			}
			return { success: true, exists: true, isWorktree: false, repoRoot: '/repos/repo-a' };
		});

		useSessionStore.setState({
			sessions: [watcherAgent('agent-A')],
			activeSessionId: 'agent-A',
			sessionsLoaded: false,
		} as any);

		renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await discoveryCallback!({ sessionId: 'agent-A', worktree: DISCOVERED });
		});

		const underA = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === 'agent-A');
		expect(underA).toHaveLength(0);
	});
});
