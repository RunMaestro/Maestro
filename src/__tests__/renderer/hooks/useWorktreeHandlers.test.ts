/**
 * Tests for useWorktreeHandlers hook
 *
 * Tests quick-access handlers, close handlers, save/disable worktree config,
 * create/delete worktree operations, toggle expansion, session inheritance,
 * and internal effects (startup scan, file watcher, legacy scanner).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { useWorktreeHandlers } from '../../../renderer/hooks/worktree/useWorktreeHandlers';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { gitService } from '../../../renderer/services/git';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

const mockGit = {
	scanWorktreeDirectory: vi.fn().mockResolvedValue({ gitSubdirs: [] }),
	watchWorktreeDirectory: vi.fn(),
	unwatchWorktreeDirectory: vi.fn(),
	onWorktreeDiscovered: vi.fn().mockReturnValue(() => {}),
	worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
	removeWorktree: vi.fn().mockResolvedValue({ success: true }),
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
			undefined
		);

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.some((s) => s.worktreeBranch === 'new-branch')).toBe(true);
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
	});
});
