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

function getWorktreeDiscoveredCallback() {
	expect(mockGit.onWorktreeDiscovered).toHaveBeenCalled();
	return mockGit.onWorktreeDiscovered.mock.calls.at(-1)?.[0] as (data: {
		sessionId: string;
		worktree: { path: string; branch: string | null; name: string };
	}) => Promise<void>;
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
		const unrelated = createChildSession({
			id: 'unrelated-toggle',
			parentSessionId: 'other-parent',
			worktreesExpanded: false,
		});
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreesExpanded: undefined }, unrelated],
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
		expect(useSessionStore.getState().sessions.find((s) => s.id === 'unrelated-toggle')).toEqual(
			unrelated
		);
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

	it('skips discovered worktrees whose normalized path already exists under another parent', async () => {
		const existingByPath = createChildSession({
			id: 'existing-by-path',
			cwd: '/projects/worktrees/path-only/',
			parentSessionId: 'other-parent',
			worktreeBranch: 'older-branch',
		});

		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }, existingByPath],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{
					path: '/projects/worktrees/path-only',
					branch: 'feature-path',
					name: 'feature-path',
				},
			],
		});

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		expect(
			useSessionStore.getState().sessions.some((s) => s.worktreeBranch === 'feature-path')
		).toBe(false);
	});

	it('creates sessions even when branch/tag metadata lookup fails', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				{ path: '/projects/worktrees/no-git-info', branch: 'no-git-info', name: 'no-git-info' },
			],
		});
		vi.mocked(gitService.getBranches).mockRejectedValueOnce(new Error('git unavailable'));

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const child = useSessionStore
			.getState()
			.sessions.find((s) => s.worktreeBranch === 'no-git-info');
		expect(child).toBeDefined();
		expect(child?.gitBranches).toBeUndefined();
		expect(child?.gitTags).toBeUndefined();
	});

	it('uses the discovered directory name when branch metadata is missing', async () => {
		useSessionStore.setState({
			sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
			activeSessionId: 'parent-1',
		} as any);

		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [{ path: '/projects/worktrees/detached', branch: null, name: 'detached' }],
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
			.sessions.find((s) => s.cwd === '/projects/worktrees/detached');
		expect(child).toEqual(expect.objectContaining({ name: 'detached' }));
		expect(child?.worktreeBranch).toBeUndefined();
	});

	it('logs scan failures after saving the worktree config', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			useSessionStore.setState({
				sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
				activeSessionId: 'parent-1',
			} as any);
			mockGit.scanWorktreeDirectory.mockRejectedValueOnce(new Error('scan failed'));

			const { result } = renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await result.current.handleSaveWorktreeConfig({
					basePath: '/projects/worktrees',
					watchEnabled: true,
				});
			});

			expect(useSessionStore.getState().sessions[0].worktreeConfig).toEqual({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
			expect(consoleError).toHaveBeenCalledWith('Failed to scan for worktrees:', expect.any(Error));
		} finally {
			consoleError.mockRestore();
		}
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

	it('uses a singular sub-agent message when one child is removed', () => {
		const child = createChildSession({ id: 'only-child', parentSessionId: 'parent-1' });

		useSessionStore.setState({
			sessions: [mockParentSession, child],
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
				message: expect.stringContaining('Removed 1 worktree sub-agent.'),
			})
		);
	});

	it('does nothing when disabling worktrees without an active session', () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'missing-parent',
		} as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleDisableWorktreeConfig();
		});

		expect(useSessionStore.getState().sessions).toEqual([mockParentSession]);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

// ============================================================================
// handleCreateWorktreeFromConfig
// ============================================================================

describe('handleCreateWorktreeFromConfig', () => {
	it('calls worktreeSetup IPC, creates session, and expands parent', async () => {
		const unrelated = createChildSession({ id: 'unrelated-create-from-config' });
		useSessionStore.setState({
			sessions: [mockParentSession, unrelated],
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
		expect(sessions.length).toBe(3);
		const newSession = sessions.find((s) => s.worktreeBranch === 'feature-new');
		expect(newSession).toBeDefined();
		expect(newSession?.cwd).toBe('/projects/worktrees/feature-new');
		expect(newSession?.parentSessionId).toBe('parent-1');
		expect(sessions.find((s) => s.id === 'unrelated-create-from-config')).toEqual(unrelated);

		// Parent should be expanded
		const parent = sessions.find((s) => s.id === 'parent-1');
		expect(parent?.worktreesExpanded).toBe(true);
	});

	it('shows error toast on IPC failure and re-throws error', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
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

			expect(consoleError).toHaveBeenCalledWith(
				'[WorktreeConfig] Failed to create worktree:',
				expect.any(Error)
			);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Failed to Create Worktree',
					message: 'branch exists',
				})
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('uses the default create error when IPC failure has no message', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			useSessionStore.setState({
				sessions: [mockParentSession],
				activeSessionId: 'parent-1',
			} as any);

			mockGit.worktreeSetup.mockResolvedValueOnce({ success: false });

			const { result } = renderHook(() => useWorktreeHandlers());

			await expect(
				act(async () => {
					await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
				})
			).rejects.toThrow('Failed to create worktree');

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Failed to Create Worktree',
					message: 'Failed to create worktree',
				})
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('shows thrown non-Error failures in the create toast', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			useSessionStore.setState({
				sessions: [mockParentSession],
				activeSessionId: 'parent-1',
			} as any);

			mockGit.worktreeSetup.mockRejectedValueOnce('offline');

			const { result } = renderHook(() => useWorktreeHandlers());

			await expect(
				act(async () => {
					await result.current.handleCreateWorktreeFromConfig('feature-new', '/projects/worktrees');
				})
			).rejects.toBe('offline');

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Failed to Create Worktree',
					message: 'offline',
				})
			);
		} finally {
			consoleError.mockRestore();
		}
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
		const unrelated = createChildSession({ id: 'unrelated-create' });
		useSessionStore.setState({
			sessions: [mockParentSession, unrelated],
			activeSessionId: 'parent-1',
		} as any);
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
		expect(sessions.find((s) => s.id === 'parent-1')?.worktreeConfig).toEqual(
			mockParentSession.worktreeConfig
		);
		expect(sessions.find((s) => s.id === 'unrelated-create')).toEqual(unrelated);
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

	it('cleans manual-create tracking and rethrows when modal worktree creation fails', async () => {
		getModalActions().setCreateWorktreeSession(mockParentSession);
		mockGit.worktreeSetup.mockResolvedValueOnce({ success: false, error: 'branch exists' });

		const { result } = renderHook(() => useWorktreeHandlers());

		await expect(
			act(async () => {
				await result.current.handleCreateWorktree('new-branch');
			})
		).rejects.toThrow('branch exists');

		expect(useSessionStore.getState().sessions.some((s) => s.worktreeBranch === 'new-branch')).toBe(
			false
		);
	});

	it('uses the default modal create error when IPC failure has no message', async () => {
		getModalActions().setCreateWorktreeSession(mockParentSession);
		mockGit.worktreeSetup.mockResolvedValueOnce({ success: false });

		const { result } = renderHook(() => useWorktreeHandlers());

		await expect(
			act(async () => {
				await result.current.handleCreateWorktree('new-branch');
			})
		).rejects.toThrow('Failed to create worktree');

		expect(useSessionStore.getState().sessions.some((s) => s.worktreeBranch === 'new-branch')).toBe(
			false
		);
	});

	it('keeps unrelated sessions and allows watcher discovery after manual-create tracking expires', async () => {
		vi.useFakeTimers();
		const unrelated = createChildSession({
			id: 'unrelated-session',
			cwd: '/elsewhere/feature',
			parentSessionId: 'other-parent',
		});
		const parentWithoutConfig = {
			...mockParentSession,
			id: 'parent-without-config',
			worktreeConfig: undefined,
		};
		useSessionStore.setState({
			sessions: [unrelated, parentWithoutConfig],
			activeSessionId: 'parent-without-config',
		} as any);
		getModalActions().setCreateWorktreeSession(parentWithoutConfig);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleCreateWorktree('tracked-branch');
		});
		act(() => {
			vi.advanceTimersByTime(10001);
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.some((s) => s.id === 'unrelated-session')).toBe(true);
		expect(sessions.find((s) => s.id === 'parent-without-config')?.worktreeConfig).toEqual({
			basePath: '/projects/worktrees',
			watchEnabled: true,
		});
		expect(sessions.some((s) => s.worktreeBranch === 'tracked-branch')).toBe(true);

		act(() => {
			useSessionStore
				.getState()
				.setSessions((prev) => prev.filter((s) => s.worktreeBranch !== 'tracked-branch'));
		});
		const onDiscovered = getWorktreeDiscoveredCallback();

		await act(async () => {
			await onDiscovered({
				sessionId: 'parent-without-config',
				worktree: {
					path: '/projects/worktrees/tracked-branch',
					branch: 'tracked-branch',
					name: 'tracked-branch',
				},
			});
		});

		expect(
			useSessionStore.getState().sessions.filter((s) => s.worktreeBranch === 'tracked-branch')
		).toHaveLength(1);
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

	it('uses the default delete error when IPC failure has no message', async () => {
		const childSession = createChildSession({ id: 'child-fail-default', cwd: '/path' });
		useSessionStore.setState({
			sessions: [mockParentSession, childSession],
			activeSessionId: 'parent-1',
		} as any);

		getModalActions().setDeleteWorktreeSession(childSession);
		mockGit.removeWorktree.mockResolvedValueOnce({ success: false });

		const { result } = renderHook(() => useWorktreeHandlers());

		await expect(
			act(async () => {
				await result.current.handleConfirmAndDeleteWorktreeOnDisk();
			})
		).rejects.toThrow('Failed to remove worktree');

		expect(useSessionStore.getState().sessions).toHaveLength(2);
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

		it('uses discovered names for startup worktrees without branch metadata', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/projects/worktrees/detached-startup', branch: null, name: 'detached-startup' },
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

			const child = useSessionStore
				.getState()
				.sessions.find((s) => s.cwd === '/projects/worktrees/detached-startup');
			expect(child).toEqual(expect.objectContaining({ name: 'detached-startup' }));
			expect(child?.worktreeBranch).toBeUndefined();
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

		it('does not scan on startup when no parent session has a worktree config', async () => {
			vi.useFakeTimers();

			useSessionStore.setState({
				sessions: [{ ...mockParentSession, worktreeConfig: undefined }],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
		});

		it('skips skippable and duplicate paths during startup scan', async () => {
			vi.useFakeTimers();

			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/projects/worktrees/main', branch: 'main', name: 'main' },
					{ path: '/projects/worktrees/duplicate', branch: 'feature-one', name: 'duplicate' },
					{ path: '/projects/worktrees/duplicate/', branch: 'feature-two', name: 'duplicate-copy' },
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

			const worktreeSessions = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === 'parent-1');
			expect(worktreeSessions).toHaveLength(1);
			expect(worktreeSessions[0].worktreeBranch).toBe('feature-one');
		});

		it('logs startup scan errors and continues without adding sessions', async () => {
			vi.useFakeTimers();
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const parentWithConfig = {
					...mockParentSession,
					worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
				};
				mockGit.scanWorktreeDirectory.mockRejectedValueOnce(new Error('startup scan failed'));

				useSessionStore.setState({
					sessions: [parentWithConfig],
					activeSessionId: 'parent-1',
					sessionsLoaded: true,
				} as any);

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await vi.runAllTimersAsync();
				});

				expect(consoleError).toHaveBeenCalledWith(
					'[WorktreeStartup] Error scanning /projects/worktrees:',
					expect.any(Error)
				);
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			} finally {
				consoleError.mockRestore();
			}
		});

		it('does not add startup scan sessions whose path appears before the final duplicate check', async () => {
			vi.useFakeTimers();
			const parentWithConfig = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};
			const racedPath = '/projects/worktrees/startup-race';

			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [{ path: racedPath, branch: 'startup-race', name: 'startup-race' }],
			});
			vi.mocked(gitService.getBranches).mockImplementationOnce(async () => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					createChildSession({
						id: 'startup-race-existing',
						cwd: racedPath,
						projectRoot: racedPath,
						parentSessionId: 'parent-1',
						worktreeBranch: 'startup-race',
					}),
				]);
				return ['startup-race'];
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

			const matchingSessions = useSessionStore
				.getState()
				.sessions.filter((s) => s.cwd === racedPath);
			expect(matchingSessions).toHaveLength(1);
			expect(matchingSessions[0].id).toBe('startup-race-existing');
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

		it('creates and announces a session when a watched worktree is discovered', async () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-remote-1' },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: '/projects/worktrees/feature-watch',
						branch: 'feature-watch',
						name: 'feature-watch',
					},
				});
			});

			expect(gitService.getBranches).toHaveBeenCalledWith(
				'/projects/worktrees/feature-watch',
				'ssh-remote-1'
			);
			expect(gitService.getTags).toHaveBeenCalledWith(
				'/projects/worktrees/feature-watch',
				'ssh-remote-1'
			);

			const sessions = useSessionStore.getState().sessions;
			const child = sessions.find((s) => s.worktreeBranch === 'feature-watch');
			expect(child).toEqual(
				expect.objectContaining({
					parentSessionId: 'parent-1',
					cwd: '/projects/worktrees/feature-watch',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-remote-1' },
				})
			);
			expect(sessions.find((s) => s.id === 'parent-1')?.worktreesExpanded).toBe(true);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'New Worktree Discovered',
					message: 'feature-watch',
				})
			);
		});

		it('ignores watched worktrees that are skippable or have no parent session', async () => {
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
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: { path: '/projects/worktrees/main', branch: 'main', name: 'main' },
				});
				await onDiscovered({
					sessionId: 'missing-parent',
					worktree: {
						path: '/projects/worktrees/feature-orphan',
						branch: 'feature-orphan',
						name: 'feature-orphan',
					},
				});
			});

			expect(useSessionStore.getState().sessions).toHaveLength(1);
			expect(gitService.getBranches).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('ignores watched worktrees that already have a matching path or branch', async () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};
			const existingChild = createChildSession({
				id: 'existing-watch',
				cwd: '/projects/worktrees/feature-watch',
				worktreeBranch: 'feature-watch',
				parentSessionId: 'parent-1',
			});

			useSessionStore.setState({
				sessions: [parentWithWatch, existingChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: '/projects/worktrees/feature-watch/',
						branch: 'feature-watch',
						name: 'feature-watch',
					},
				});
			});

			expect(useSessionStore.getState().sessions).toHaveLength(2);
			expect(gitService.getBranches).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('ignores watched worktrees with the same parent branch on a different path', async () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};
			const existingChild = createChildSession({
				id: 'existing-watch-branch',
				cwd: '/projects/worktrees/old-path',
				worktreeBranch: 'feature-watch',
				parentSessionId: 'parent-1',
			});

			useSessionStore.setState({
				sessions: [parentWithWatch, existingChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: '/projects/worktrees/new-path',
						branch: 'feature-watch',
						name: 'feature-watch',
					},
				});
			});

			expect(useSessionStore.getState().sessions).toHaveLength(2);
			expect(gitService.getBranches).not.toHaveBeenCalled();
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('uses watched worktree names when branch metadata is missing', async () => {
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
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: '/projects/worktrees/detached-watch',
						branch: null,
						name: 'detached-watch',
					},
				});
			});

			const child = useSessionStore
				.getState()
				.sessions.find((s) => s.cwd === '/projects/worktrees/detached-watch');
			expect(child).toEqual(expect.objectContaining({ name: 'detached-watch' }));
			expect(child?.worktreeBranch).toBeUndefined();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'New Worktree Discovered',
					message: 'detached-watch',
				})
			);
		});

		it('ignores watched worktrees that were just manually created', async () => {
			vi.useFakeTimers();
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			const { result } = renderHook(() => useWorktreeHandlers());
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await result.current.handleCreateWorktreeFromConfig(
					'feature-manual',
					'/projects/worktrees'
				);
			});
			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: '/projects/worktrees/feature-manual',
						branch: 'feature-manual',
						name: 'feature-manual',
					},
				});
			});

			expect(
				useSessionStore.getState().sessions.filter((s) => s.worktreeBranch === 'feature-manual')
			).toHaveLength(1);
			act(() => {
				vi.advanceTimersByTime(10001);
			});
		});

		it('does not add watched worktrees whose path appears before the final duplicate check', async () => {
			const parentWithWatch = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
			};
			const racedPath = '/projects/worktrees/watcher-race';

			useSessionStore.setState({
				sessions: [parentWithWatch],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);
			vi.mocked(gitService.getBranches).mockImplementationOnce(async () => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					createChildSession({
						id: 'watcher-race-existing',
						cwd: racedPath,
						projectRoot: racedPath,
						parentSessionId: 'parent-1',
						worktreeBranch: 'watcher-race',
					}),
				]);
				return ['watcher-race'];
			});

			renderHook(() => useWorktreeHandlers());
			const onDiscovered = getWorktreeDiscoveredCallback();

			await act(async () => {
				await onDiscovered({
					sessionId: 'parent-1',
					worktree: {
						path: racedPath,
						branch: 'watcher-race',
						name: 'watcher-race',
					},
				});
			});

			const matchingSessions = useSessionStore
				.getState()
				.sessions.filter((s) => s.cwd === racedPath);
			expect(matchingSessions).toHaveLength(1);
			expect(matchingSessions[0].id).toBe('watcher-race-existing');
		});
	});

	describe('Legacy scanner effect', () => {
		it('adds new legacy worktree sessions while skipping removed, existing, and duplicate paths', async () => {
			const existingChild = createChildSession({
				id: 'existing-legacy',
				cwd: '/legacy/worktrees/existing',
				projectRoot: '/legacy/worktrees/existing',
			});
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};

			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				gitSubdirs: [
					{ path: '/legacy/worktrees/removed', branch: 'removed', name: 'removed' },
					{ path: '/legacy/worktrees/existing', branch: 'existing', name: 'existing' },
					{ path: '/legacy/worktrees/new', branch: 'new-branch', name: 'new' },
					{ path: '/legacy/worktrees/new', branch: 'new-branch-copy', name: 'new-copy' },
				],
			});

			useSessionStore.setState({
				sessions: [legacyParent, existingChild],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
				removedWorktreePaths: new Set(['/legacy/worktrees/removed']),
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.filter((s) => s.parentSessionId === 'parent-1')).toHaveLength(1);
			expect(sessions.some((s) => s.cwd === '/legacy/worktrees/removed')).toBe(false);
			expect(sessions.filter((s) => s.cwd === '/legacy/worktrees/new')).toHaveLength(1);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'New Worktree Discovered',
					message: 'new (new-branch)',
				})
			);
		});

		it('skips legacy duplicates by projectRoot and names branchless worktrees plainly', async () => {
			const sessionWithoutProjectRoot = createChildSession({
				id: 'legacy-without-project-root',
				cwd: '/legacy/worktrees/without-project-root',
				projectRoot: undefined,
				parentSessionId: 'other-parent',
			});
			const existingByProjectRoot = createChildSession({
				id: 'existing-legacy-project-root',
				cwd: '/legacy/worktrees/other-cwd',
				projectRoot: '/legacy/worktrees/existing-root',
				parentSessionId: 'other-parent',
			});
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};

			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				gitSubdirs: [
					{
						path: '/legacy/worktrees/existing-root',
						branch: 'existing-root',
						name: 'existing-root',
					},
					{ path: '/legacy/worktrees/detached-legacy', branch: null, name: 'detached-legacy' },
				],
			});

			useSessionStore.setState({
				sessions: [legacyParent, sessionWithoutProjectRoot, existingByProjectRoot],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(
				useSessionStore
					.getState()
					.sessions.filter((s) => s.cwd === '/legacy/worktrees/existing-root')
			).toHaveLength(0);
			const branchless = useSessionStore
				.getState()
				.sessions.find((s) => s.cwd === '/legacy/worktrees/detached-legacy');
			expect(branchless).toEqual(expect.objectContaining({ name: 'detached-legacy' }));
			expect(branchless?.worktreeBranch).toBeUndefined();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'New Worktree Discovered',
					message: 'detached-legacy',
				})
			);
		});

		it('rescans legacy worktrees when the document becomes visible', async () => {
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};
			mockGit.scanWorktreeDirectory.mockResolvedValue({ gitSubdirs: [] });
			const hiddenDescriptor =
				Object.getOwnPropertyDescriptor(document, 'hidden') ??
				Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');

			try {
				useSessionStore.setState({
					sessions: [legacyParent],
					activeSessionId: 'parent-1',
					sessionsLoaded: false,
				} as any);

				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: false,
				});

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await Promise.resolve();
					document.dispatchEvent(new Event('visibilitychange'));
					await Promise.resolve();
				});

				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledTimes(2);
				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledWith('/legacy/worktrees', undefined);
			} finally {
				if (hiddenDescriptor) {
					Object.defineProperty(document, 'hidden', hiddenDescriptor);
				}
			}
		});

		it('does not rescan legacy worktrees while the document remains hidden', async () => {
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};
			mockGit.scanWorktreeDirectory.mockResolvedValue({ gitSubdirs: [] });
			const hiddenDescriptor =
				Object.getOwnPropertyDescriptor(document, 'hidden') ??
				Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');

			try {
				useSessionStore.setState({
					sessions: [legacyParent],
					activeSessionId: 'parent-1',
					sessionsLoaded: false,
				} as any);

				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: true,
				});

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await Promise.resolve();
					document.dispatchEvent(new Event('visibilitychange'));
					await Promise.resolve();
				});

				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledTimes(1);
			} finally {
				if (hiddenDescriptor) {
					Object.defineProperty(document, 'hidden', hiddenDescriptor);
				}
			}
		});

		it('does not start an overlapping legacy scan while one is already running', async () => {
			let resolveScan: ((value: { gitSubdirs: [] }) => void) | undefined;
			mockGit.scanWorktreeDirectory.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveScan = resolve;
				})
			);
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};
			const hiddenDescriptor =
				Object.getOwnPropertyDescriptor(document, 'hidden') ??
				Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');

			try {
				useSessionStore.setState({
					sessions: [legacyParent],
					activeSessionId: 'parent-1',
					sessionsLoaded: false,
				} as any);

				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: false,
				});

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await Promise.resolve();
					document.dispatchEvent(new Event('visibilitychange'));
					await Promise.resolve();
				});

				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledTimes(1);

				await act(async () => {
					resolveScan?.({ gitSubdirs: [] });
					await Promise.resolve();
				});
			} finally {
				if (hiddenDescriptor) {
					Object.defineProperty(document, 'hidden', hiddenDescriptor);
				}
			}
		});

		it('returns from a visible-triggered legacy scan when legacy parents were removed', async () => {
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};
			const hiddenDescriptor =
				Object.getOwnPropertyDescriptor(document, 'hidden') ??
				Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
			const originalAddEventListener = document.addEventListener.bind(document);
			let visibilityHandler: EventListener | undefined;
			const addEventListenerSpy = vi
				.spyOn(document, 'addEventListener')
				.mockImplementation((type, listener, options) => {
					if (type === 'visibilitychange') {
						visibilityHandler = listener as EventListener;
					}
					originalAddEventListener(type, listener, options);
				});

			try {
				mockGit.scanWorktreeDirectory.mockResolvedValue({ gitSubdirs: [] });
				useSessionStore.setState({
					sessions: [legacyParent],
					activeSessionId: 'parent-1',
					sessionsLoaded: false,
				} as any);
				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: false,
				});

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await Promise.resolve();
					await Promise.resolve();
				});
				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledTimes(1);

				act(() => {
					useSessionStore.setState({
						sessions: [{ ...legacyParent, worktreeParentPath: undefined }],
					} as any);
				});

				await act(async () => {
					visibilityHandler?.(new Event('visibilitychange'));
					await Promise.resolve();
				});

				expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledTimes(1);
			} finally {
				addEventListenerSpy.mockRestore();
				if (hiddenDescriptor) {
					Object.defineProperty(document, 'hidden', hiddenDescriptor);
				}
			}
		});

		it('does not add legacy scan sessions whose path appears before the final duplicate check', async () => {
			const legacyParent = {
				...mockParentSession,
				worktreeConfig: undefined,
				worktreeParentPath: '/legacy/worktrees',
			};
			const racedPath = '/legacy/worktrees/legacy-race';

			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				gitSubdirs: [{ path: racedPath, branch: 'legacy-race', name: 'legacy-race' }],
			});
			vi.mocked(gitService.getBranches).mockImplementationOnce(async () => {
				useSessionStore.getState().setSessions((prev) => [
					...prev,
					createChildSession({
						id: 'legacy-race-existing',
						cwd: racedPath,
						projectRoot: racedPath,
						parentSessionId: 'parent-1',
						worktreeBranch: 'legacy-race',
					}),
				]);
				return ['legacy-race'];
			});

			useSessionStore.setState({
				sessions: [legacyParent],
				activeSessionId: 'parent-1',
				sessionsLoaded: false,
			} as any);

			renderHook(() => useWorktreeHandlers());

			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			const matchingSessions = useSessionStore
				.getState()
				.sessions.filter((s) => s.cwd === racedPath);
			expect(matchingSessions).toHaveLength(1);
			expect(matchingSessions[0].id).toBe('legacy-race-existing');
		});

		it('logs legacy scan errors and clears the in-flight scan state', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const legacyParent = {
					...mockParentSession,
					worktreeConfig: undefined,
					worktreeParentPath: '/legacy/worktrees',
				};
				mockGit.scanWorktreeDirectory.mockRejectedValueOnce(new Error('legacy scan failed'));

				useSessionStore.setState({
					sessions: [legacyParent],
					activeSessionId: 'parent-1',
					sessionsLoaded: false,
				} as any);

				renderHook(() => useWorktreeHandlers());

				await act(async () => {
					await Promise.resolve();
					await Promise.resolve();
				});

				expect(consoleError).toHaveBeenCalledWith(
					'[WorktreeScanner] Error scanning /legacy/worktrees:',
					expect.any(Error)
				);
			} finally {
				consoleError.mockRestore();
			}
		});
	});
});
