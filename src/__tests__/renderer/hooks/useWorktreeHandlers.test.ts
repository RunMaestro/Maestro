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
import * as worktreeSessionUtils from '../../../renderer/utils/worktreeSession';

// ============================================================================
// Test Helpers
// ============================================================================

const mockGit = {
	scanWorktreeDirectory: vi.fn().mockResolvedValue({ gitSubdirs: [] }),
	listWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
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

function createChildSession(overrides?: Partial<Session>): any;
function createChildSession(
	parent: Pick<Session, 'id' | 'sessionSshRemoteConfig'>,
	overrides: Partial<Session>
): any;
function createChildSession(
	parentOrOverrides: Partial<Session> = {},
	childOverrides?: Partial<Session>
): any {
	const overrides = childOverrides ?? parentOrOverrides;
	const parent = childOverrides ? parentOrOverrides : undefined;
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
		...(parent
			? { parentSessionId: parent.id, sessionSshRemoteConfig: parent.sessionSshRemoteConfig }
			: {}),
		...overrides,
	} as any;
}

type RegistryEntry = NonNullable<
	Awaited<ReturnType<typeof window.maestro.git.listWorktrees>>['worktrees']
>[number];

// Commit hashes do not participate in reconciliation; keep valid defaults out of each scenario.
function registryEntry(
	path: string,
	branch: string | null,
	overrides: Partial<RegistryEntry> = {}
): RegistryEntry {
	return { path, branch, head: 'abc', isBare: false, ...overrides };
}

async function runConfiguredScan(
	mode: string,
	parent: Session,
	children: Session[] = []
): Promise<void> {
	useSessionStore.setState({
		sessions: [parent, ...children],
		activeSessionId: parent.id,
		sessionsLoaded: mode === 'startup',
	});
	const { result } = renderHook(() => useWorktreeHandlers());
	await act(async () => {
		if (mode === 'save') await result.current.handleSaveWorktreeConfig(parent.worktreeConfig!);
		if (mode === 'refresh') await result.current.refreshWorktreeState();
		if (mode === 'visibility') {
			Object.defineProperty(document, 'hidden', { value: false, writable: true });
			document.dispatchEvent(new Event('visibilitychange'));
		}
		await vi.runAllTimersAsync();
	});
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

	it('handleOpenWorktreeConfigSession pins the target without moving the selection', () => {
		useSessionStore.setState({
			sessions: [mockParentSession, { ...mockParentSession, id: 'other-1', name: 'Other' }],
			activeSessionId: 'other-1',
		} as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleOpenWorktreeConfigSession(mockParentSession);
		});

		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
		// The agent to configure travels in the payload...
		expect(useModalStore.getState().getData('worktreeConfig')?.session?.id).toBe('parent-1');
		// ...and the user's selection is left exactly where they left it.
		expect(useSessionStore.getState().activeSessionId).toBe('other-1');
	});

	it('handleOpenWorktreeConfig (no target) pins nothing and follows the active agent', () => {
		useSessionStore.setState({
			sessions: [mockParentSession],
			activeSessionId: 'parent-1',
		} as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		act(() => {
			result.current.handleOpenWorktreeConfig();
		});

		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
		expect(useModalStore.getState().getData('worktreeConfig')?.session).toBeUndefined();
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

	// The whole point of dropping the force-activation: Save has to follow the
	// agent the dialog was opened FOR, not whichever one happens to be selected.
	// Without this, removing the activation would silently write the config onto
	// the wrong agent.
	it('saves to the pinned agent rather than the active one', async () => {
		useSessionStore.setState({
			sessions: [
				{ ...mockParentSession, worktreeConfig: undefined },
				{ ...mockParentSession, id: 'other-1', name: 'Other', worktreeConfig: undefined },
			],
			activeSessionId: 'other-1',
		} as any);
		useModalStore.getState().openModal('worktreeConfig', { session: mockParentSession } as any);

		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/projects/worktrees',
				watchEnabled: true,
			});
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions.find((s) => s.id === 'parent-1')?.worktreeConfig).toEqual({
			basePath: '/projects/worktrees',
			watchEnabled: true,
		});
		// The selected agent is untouched.
		expect(sessions.find((s) => s.id === 'other-1')?.worktreeConfig).toBeUndefined();
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

		// No new session was added - count stays at 2
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

		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/projects/myapp',
			resolvedBasePath: '/projects/worktrees',
			worktrees: [
				{ path: '/projects/myapp', branch: 'main', head: 'abc', isBare: false },
				{
					path: '/projects/worktrees/feature-ssh',
					branch: 'feature-ssh',
					head: 'abc',
					isBare: false,
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

		const child = useSessionStore
			.getState()
			.sessions.find((s) => s.worktreeBranch === 'feature-ssh');
		expect(child?.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'ssh-remote-1',
			host: 'dev.example.com',
		});
	});

	it('retains an aliased detached SSH child when saving its worktree configuration', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '~/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const child = createChildSession(parent, {
			id: 'existing-aliased-detached',
			cwd: '~/worktrees/review',
			projectRoot: '~/worktrees/review',
			worktreeBranch: null,
			aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/home/dev/worktrees',
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry('/home/dev/worktrees/review', null),
				registryEntry('/home/dev/worktrees/feature', 'feature'),
			],
		});
		useSessionStore.setState({ sessions: [parent, child], activeSessionId: parent.id } as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '~/worktrees',
				watchEnabled: false,
			});
		});

		const children = useSessionStore
			.getState()
			.sessions.filter((session) => session.parentSessionId === parent.id);
		expect(mockGit.listWorktrees).toHaveBeenCalledWith('/remote/repo', 'ssh-1', '~/worktrees', [
			child.cwd,
		]);
		expect(children).toHaveLength(2);
		expect(children.find((session) => session.id === child.id)?.aiTabs).toEqual(child.aiTabs);
		expect(children.filter((session) => session.cwd.endsWith('/review'))).toHaveLength(1);
		expect(children.some((session) => session.cwd === '/home/dev/worktrees/feature')).toBe(true);
	});

	it('preserves a detached SSH chat when changing to an equivalent worktree base alias', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/alias/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const child = createChildSession(parent, {
			id: 'existing-detached-before-config-edit',
			cwd: '/alias/worktrees/review',
			projectRoot: '/alias/worktrees/review',
			worktreeBranch: null,
			aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			resolvedSessionPaths: { '/alias/worktrees/review': '/physical/worktrees/review' },
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry('/physical/worktrees/review', null),
			],
		});
		useSessionStore.setState({ sessions: [parent, child], activeSessionId: parent.id } as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/physical/worktrees',
				watchEnabled: false,
			});
		});

		expect(mockGit.listWorktrees).toHaveBeenCalledWith(
			'/remote/repo',
			'ssh-1',
			'/physical/worktrees',
			[child.cwd]
		);
		const children = useSessionStore
			.getState()
			.sessions.filter((session) => session.parentSessionId === parent.id);
		expect(children).toEqual([child]);
		expect(notifyToast).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed' })
		);
	});

	it('replaces a confirmed missing SSH child on the same branch when saving its configuration', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/old/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const stale = createChildSession(parent, {
			id: 'missing-before-config-save',
			cwd: '/old/worktrees/obsolete',
			worktreeBranch: 'recreated',
		});
		const healthy = createChildSession(parent, {
			id: 'healthy-before-config-save',
			cwd: '/old/worktrees/live',
			worktreeBranch: null,
			aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			resolvedSessionPaths: {
				[stale.cwd]: '/physical/worktrees/obsolete',
				[healthy.cwd]: '/physical/worktrees/live',
			},
			missingSessionPaths: [stale.cwd],
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry('/physical/worktrees/live', null),
				registryEntry('/physical/worktrees/recreated', 'recreated'),
			],
		});
		useSessionStore.setState({
			sessions: [parent, stale, healthy],
			activeSessionId: parent.id,
		} as any);
		const { result } = renderHook(() => useWorktreeHandlers());

		await act(async () => {
			await result.current.handleSaveWorktreeConfig({
				basePath: '/physical/worktrees',
				watchEnabled: false,
			});
		});

		const children = useSessionStore
			.getState()
			.sessions.filter((session) => session.parentSessionId === parent.id);
		expect(children).toHaveLength(2);
		expect(children).toContain(healthy);
		expect(children).not.toContain(stale);
		expect(children.find((session) => session.cwd === '/physical/worktrees/recreated')).toEqual(
			expect.objectContaining({ worktreeBranch: 'recreated' })
		);
		expect(healthy.aiTabs).toEqual([{ id: 'existing-chat', agentSessionId: 'codex-session' }]);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'recreated' })
		);
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

		it('uses the SSH git registry to discover multiple detached worktrees', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/remote/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/remote/worktrees/feature', 'feature'),
					registryEntry('/remote/worktrees/review', null),
					registryEntry('/remote/worktrees/review-2', null),
					registryEntry('/tmp/outside', 'outside'),
				],
			});
			const existingDetached = createChildSession(parent, {
				id: 'existing-detached',
				cwd: '/remote/worktrees/review',
				worktreeBranch: null,
			});
			useSessionStore.setState({
				sessions: [parent, existingDetached],
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockGit.listWorktrees).toHaveBeenCalledWith(
				'/remote/repo',
				'ssh-1',
				'/remote/worktrees',
				[existingDetached.cwd]
			);
			expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children.map((s) => s.cwd).sort()).toEqual([
				'/remote/worktrees/feature',
				'/remote/worktrees/review',
				'/remote/worktrees/review-2',
			]);
			expect(children.find((s) => s.cwd.endsWith('/review'))?.worktreeBranch).toBeNull();
		});

		it('preserves an SSH child when the git listing fails', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'existing-ssh-child',
				cwd: '/remote/worktrees/feature',
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }],
			});
			mockGit.listWorktrees.mockRejectedValueOnce(new Error('SSH disconnected'));
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toContain(child);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it.each([
			{ basePath: '~/worktrees', resolvedBasePath: '/home/dev/worktrees' },
			{
				basePath: '/remote/worktrees/../worktrees',
				resolvedBasePath: '/remote/worktrees',
			},
			{ basePath: '/alias/worktrees', resolvedBasePath: '/physical/worktrees' },
			{ basePath: '/alias//worktrees/', resolvedBasePath: '/physical/worktrees' },
			{ basePath: '/alias/worktrees/', resolvedBasePath: '/physical//worktrees/' },
		])(
			'preserves detached SSH children under the $basePath alias',
			async ({ basePath, resolvedBasePath }) => {
				vi.useFakeTimers();
				const parent = {
					...mockParentSession,
					cwd: '/remote/repo',
					worktreeConfig: { basePath, watchEnabled: false },
					sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				};
				const child = createChildSession(parent, {
					id: 'existing-aliased-detached',
					cwd: `${basePath}/review`,
					projectRoot: `${basePath}/review`,
					worktreeBranch: null,
					aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
				});
				mockGit.listWorktrees.mockResolvedValueOnce({
					resolvedCwd: '/remote/repo',
					resolvedBasePath,
					...(basePath.includes('/../')
						? { resolvedSessionPaths: { [child.cwd]: `${resolvedBasePath}/review` } }
						: {}),
					worktrees: [
						registryEntry('/remote/repo', 'main'),
						registryEntry(`${resolvedBasePath}/review`, null),
						registryEntry(`${resolvedBasePath}/review-2`, null),
						registryEntry(`${resolvedBasePath}/feature`, 'feature'),
					],
				});
				useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

				renderHook(() => useWorktreeHandlers());
				await act(async () => {
					await vi.runAllTimersAsync();
				});

				expect(mockGit.listWorktrees).toHaveBeenCalledWith('/remote/repo', 'ssh-1', basePath, [
					child.cwd,
				]);
				const children = useSessionStore
					.getState()
					.sessions.filter((session) => session.parentSessionId === parent.id);
				expect(children).toHaveLength(3);
				expect(children.find((session) => session.id === child.id)?.aiTabs).toEqual(child.aiTabs);
				expect(children.filter((session) => session.cwd.endsWith('/review'))).toHaveLength(1);
				expect(children.some((session) => session.cwd === `${resolvedBasePath}/review-2`)).toBe(
					true
				);
				expect(notifyToast).not.toHaveBeenCalledWith(
					expect.objectContaining({ title: 'Worktree Removed' })
				);
			}
		);

		it('excludes an aliased SSH parent from discovery inside the configured base', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/alias/worktrees/parent',
				projectRoot: '/alias/worktrees/parent',
				worktreeConfig: { basePath: '/alias/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/physical/worktrees/parent',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/physical/worktrees/parent', 'parent-feature'),
					registryEntry('/physical/worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(1);
			expect(children[0].cwd).toBe('/physical/worktrees/review');
			expect(mockGit.listWorktrees).toHaveBeenCalledWith(
				'/alias/worktrees/parent',
				'ssh-1',
				'/alias/worktrees',
				[]
			);
		});

		it('keeps home-relative SSH alias comparisons case-sensitive', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '~/Worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'different-case-detached',
				cwd: '~/worktrees/review',
				projectRoot: '~/worktrees/review',
				worktreeBranch: null,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/Worktrees',
				resolvedSessionPaths: { '~/worktrees/review': '/physical/worktrees/review' },
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/Worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(1);
			expect(children[0].cwd).toBe('/physical/Worktrees/review');
			expect(children[0].id).not.toBe(child.id);
		});

		it('preserves a detached SSH chat stored under an earlier equivalent base alias', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'existing-detached-old-alias',
				cwd: '/alias/worktrees/review',
				projectRoot: '/alias/worktrees/review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				resolvedSessionPaths: { '/alias/worktrees/review': '/physical/worktrees/review' },
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(mockGit.listWorktrees).toHaveBeenCalledWith(
				'/remote/repo',
				'ssh-1',
				'/physical/worktrees',
				[child.cwd]
			);
			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('preserves an SSH chat when its earlier base alias cannot be resolved safely', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'existing-detached-unresolved-alias',
				cwd: '/alias/worktrees/review',
				projectRoot: '/alias/worktrees/review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [registryEntry('/remote/repo', 'main')],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it.each(['recreated', null])(
			'reconciles mixed healthy and missing SSH aliases while discovering a replacement on branch %s',
			async (branch) => {
				vi.useFakeTimers();
				const parent = {
					...mockParentSession,
					cwd: '/remote/repo',
					worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
					sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				};
				const stale = createChildSession(parent, {
					id: 'missing-old-alias',
					cwd: '/old/worktrees/obsolete',
					worktreeBranch: branch,
				});
				const healthy = createChildSession(parent, {
					id: 'healthy-old-alias',
					cwd: '/older/worktrees/live',
					worktreeBranch: null,
					aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
				});
				mockGit.listWorktrees.mockResolvedValueOnce({
					resolvedCwd: '/remote/repo',
					resolvedBasePath: '/physical/worktrees',
					resolvedSessionPaths: {
						[stale.cwd]: '/physical/worktrees/obsolete',
						[healthy.cwd]: '/physical/worktrees/live',
					},
					missingSessionPaths: [stale.cwd],
					worktrees: [
						registryEntry('/remote/repo', 'main'),
						registryEntry('/physical/worktrees/live', null),
						{ path: '/physical/worktrees/recreated', branch, head: 'ghi', isBare: false },
					],
				});
				useSessionStore.setState({
					sessions: [parent, stale, healthy],
					sessionsLoaded: true,
				} as any);
				renderHook(() => useWorktreeHandlers());
				await act(async () => {
					await vi.runAllTimersAsync();
				});

				const children = useSessionStore
					.getState()
					.sessions.filter((session) => session.parentSessionId === parent.id);
				expect(children).toHaveLength(2);
				expect(children).toContain(healthy);
				expect(children).not.toContain(stale);
				const replacement = children.find(
					(session) => session.cwd === '/physical/worktrees/recreated'
				);
				expect(replacement).toBeDefined();
				expect(replacement?.worktreeBranch ?? null).toBe(branch);
				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({ title: 'Worktree Removed' })
				);
			}
		);

		it('removes a confirmed missing old SSH alias after a parent-only registry listing', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'missing-old-alias',
				cwd: '/old/worktrees/feature',
				worktreeBranch: 'feature',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				resolvedSessionPaths: { [child.cwd]: '/physical/worktrees/feature' },
				missingSessionPaths: [child.cwd],
				worktrees: [registryEntry('/remote/repo', 'main')],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent]);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'feature' })
			);
		});

		it('discovers a same-branch SSH replacement for a stale child under the current base in one scan', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const stale = createChildSession(parent, {
				id: 'missing-current-prefix-child',
				cwd: '/physical/worktrees/obsolete',
				worktreeBranch: 'recreated',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/recreated', 'recreated'),
				],
			});
			useSessionStore.setState({ sessions: [parent, stale], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(1);
			expect(children[0].cwd).toBe('/physical/worktrees/recreated');
			expect(children[0].id).not.toBe(stale.id);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'recreated' })
			);
		});

		it('preserves a missing SSH alias chat when its physical candidate remains registered', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'missing-alias-live-physical-child',
				cwd: '/old/worktrees/review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				resolvedSessionPaths: { [child.cwd]: '/physical/worktrees/review' },
				missingSessionPaths: [child.cwd],
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('preserves an unresolved vanished SSH alias even when a similarly named physical worktree is live', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'vanished-ancestor-alias',
				cwd: '/vanished/worktrees/review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(child);
			expect(children.some((s) => s.cwd === '/physical/worktrees/review')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it.each([
			{ description: 'a nonarray missing list', missingSessionPaths: '/physical/worktrees/review' },
			{ description: 'a null missing list', missingSessionPaths: null },
			{ description: 'a nonstring missing entry', missingSessionPaths: [17] },
			{ description: 'an unknown missing path', missingSessionPaths: ['/another/parent/review'] },
			{
				description: 'a missing path without a physical mapping',
				missingSessionPaths: ['/physical/worktrees/review'],
			},
			{
				description: 'a missing path with a relative mapping',
				missingSessionPaths: ['/physical/worktrees/review'],
				resolvedSessionPaths: { '/physical/worktrees/review': 'review' },
			},
			{
				description: 'a missing path with a nonstring mapping',
				missingSessionPaths: ['/physical/worktrees/review'],
				resolvedSessionPaths: { '/physical/worktrees/review': 17 },
			},
			{
				description: 'a missing path with ambiguous multiline mapping',
				missingSessionPaths: ['/physical/worktrees/review'],
				resolvedSessionPaths: {
					'/physical/worktrees/review': '/physical/worktrees/review\nchatter',
				},
			},
			{
				description: 'a missing path with a NUL mapping',
				missingSessionPaths: ['/physical/worktrees/review'],
				resolvedSessionPaths: { '/physical/worktrees/review': '/physical/worktrees/review\0' },
			},
		])('preserves SSH chats when missing-path metadata contains $description', async (metadata) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'malformed-missing-metadata-child',
				cwd: '/physical/worktrees/review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				...metadata,
				worktrees: [registryEntry('/remote/repo', 'main')],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('distinguishes literal POSIX backslashes from directory separators in SSH child paths', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'literal-backslash-child',
				cwd: '/old/worktrees/review\\one',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				resolvedSessionPaths: { [child.cwd]: '/physical/worktrees/review\\one' },
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/review\\one', null),
					registryEntry('/physical/worktrees/review/one', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(2);
			expect(children).toContain(child);
			expect(children.some((session) => session.cwd === '/physical/worktrees/review/one')).toBe(
				true
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('keeps literal POSIX backslashes distinct for children discovered under a runtime-only SSH parent', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sshRemoteId: 'ssh-1',
				sessionSshRemoteConfig: undefined,
			};
			const child = createChildSession({
				id: 'runtime-ssh-existing-separator-child',
				cwd: '/physical/worktrees/review/one',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry(child.cwd, null),
					registryEntry('/physical/worktrees/review\\one', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(2);
			expect(children).toContain(child);
			expect(children.some((session) => session.cwd === '/physical/worktrees/review\\one')).toBe(
				true
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('does not include another SSH base whose name differs by a literal POSIX backslash', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/work\\trees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'literal-backslash-base-child',
				cwd: '/physical/work\\trees/review',
				worktreeBranch: null,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/work\\trees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry(child.cwd, null),
					registryEntry('/physical/work/trees/outside', 'outside'),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('preserves literal POSIX backslashes when rebasing a current SSH home alias', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '~/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'current-alias-literal-backslash-child',
				cwd: '~/worktrees/review\\one',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/home/dev/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/home/dev/worktrees/review\\one', null),
					registryEntry('/home/dev/worktrees/review/one', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toHaveLength(2);
			expect(children).toContain(child);
			expect(children.some((session) => session.cwd === '/home/dev/worktrees/review/one')).toBe(
				true
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it('preserves SSH chats when a dot-segment child lacks physical resolution metadata', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'dot-segment-child-without-resolution',
				cwd: '/physical/worktrees/nested/../review',
				worktreeBranch: null,
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/review', null),
				],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(child);
			expect(children.some((s) => s.cwd === '/physical/worktrees/review')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it.each([
			{ basePath: '/', childPath: '/review', siblingPath: null },
			{
				basePath: '/physical//worktrees/',
				childPath: '/physical/worktrees/review',
				siblingPath: '/physical/worktrees-other/outside',
			},
		])(
			'keeps SSH prefix comparisons valid for $basePath',
			async ({ basePath, childPath, siblingPath }) => {
				vi.useFakeTimers();
				const parent = {
					...mockParentSession,
					cwd: '/remote/repo',
					worktreeConfig: { basePath, watchEnabled: false },
					sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				};
				const child = createChildSession(parent, {
					id: 'normalized-prefix-child',
					cwd: childPath,
					worktreeBranch: null,
				});
				mockGit.listWorktrees.mockResolvedValueOnce({
					resolvedCwd: '/remote/repo',
					resolvedBasePath: basePath === '/' ? '/' : '/physical/worktrees',
					worktrees: [
						registryEntry('/remote/repo', 'main'),
						registryEntry(childPath, null),
						registryEntry(`${childPath}-2`, null),
						...(siblingPath
							? [{ path: siblingPath, branch: 'outside', head: 'jkl', isBare: false }]
							: []),
					],
				});
				useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
				renderHook(() => useWorktreeHandlers());
				await act(async () => {
					await vi.runAllTimersAsync();
				});

				const children = useSessionStore
					.getState()
					.sessions.filter((session) => session.parentSessionId === parent.id);
				expect(children.map((session) => session.cwd).sort()).toEqual([
					childPath,
					`${childPath}-2`,
				]);
				expect(children).toContain(child);
			}
		);

		it.each([
			{},
			{ resolvedCwd: '/remote/repo' },
			{ resolvedBasePath: '/remote/worktrees' },
			{ resolvedCwd: '/remote/repo', resolvedBasePath: '' },
		])('preserves SSH children when resolved path metadata is incomplete: %j', async (metadata) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'existing-ssh-child',
				cwd: '/remote/worktrees/feature',
				projectRoot: '/remote/worktrees/feature',
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				...metadata,
				worktrees: [registryEntry('/remote/repo', 'main')],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		});

		it.each([
			{
				description: 'a parent-only registry',
				outsideWorktrees: [],
			},
			{
				description: 'a registry with only unrelated worktrees outside the base',
				outsideWorktrees: [{ path: '/tmp/outside', branch: 'outside', head: 'def', isBare: false }],
			},
		])('removes the final SSH child after $description', async ({ outsideWorktrees }) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/alias/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'removed-ssh-child',
				cwd: '/alias/worktrees/feature',
				projectRoot: '/alias/worktrees/feature',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [registryEntry('/remote/repo', 'main'), ...outsideWorktrees],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toEqual([parent]);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'feature-1' })
			);
		});

		it('preserves an SSH child when the git listing is unexpectedly empty', async () => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'existing-ssh-child',
				cwd: '/remote/worktrees/feature',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({ worktrees: [] });
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(useSessionStore.getState().sessions).toContain(child);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
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

			// Scan succeeded but found nothing - most commonly because of a symlinked
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

		it('rescan skips a path still marked recently-created by spawnWorktreeAgentAndDispatch', async () => {
			vi.useFakeTimers();

			const parent = {
				...mockParentSession,
				id: 'parent-a',
				cwd: '/repos/repo-a',
				worktreeConfig: { basePath: '/shared/worktrees', watchEnabled: false },
			};
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repos/repo-a',
			});
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{
						path: '/shared/worktrees/feat-live',
						branch: 'feat-live',
						name: 'feat-live',
						repoRoot: '/repos/repo-a',
					},
				],
			});

			useSessionStore.setState({
				sessions: [parent],
				activeSessionId: 'parent-a',
				sessionsLoaded: true,
			} as any);

			// The launcher marked this path while it builds the owning child. A rescan
			// landing in that window must NOT create a (sibling) child for it.
			markWorktreePathAsRecentlyCreated('/shared/worktrees/feat-live');

			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === 'parent-a');
			expect(children).toHaveLength(0);

			clearRecentlyCreatedWorktreePath('/shared/worktrees/feat-live');
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
				'/projects/worktrees',
				undefined
			);
			expect(mockGit.onWorktreeDiscovered).toHaveBeenCalled();
		});

		it('passes the SSH remote ID when starting a worktree watcher', () => {
			const parentWithWatch = {
				...mockParentSession,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			useSessionStore.setState({ sessions: [parentWithWatch], sessionsLoaded: false } as any);

			renderHook(() => useWorktreeHandlers());

			expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledWith(
				'parent-1',
				'/projects/worktrees',
				'ssh-1'
			);
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
			expect(mockGit.watchWorktreeDirectory).toHaveBeenLastCalledWith(
				'parent-1',
				'/new/worktrees',
				undefined
			);
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
				'/projects/other-worktrees',
				undefined
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
		// scan iterated first - even when those worktrees belonged to a different
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
			// toast - the worktree still exists on disk. Use "Worktree Re-assigned"
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
			// matter - we just need both to resolve to non-matching repos.)
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

	describe('Non-owning renderer (isLifecycleOwner: false)', () => {
		const parentWithWatch = () => ({
			...mockParentSession,
			worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
		});

		// Covers both non-owners: a secondary Electron window and a web-desktop
		// browser client. App derives the flag from `isMainWindow` as well as the
		// runtime, so a second window is as much a non-owner as a browser tab.
		it('does not start worktree watchers or subscribe to discovery', () => {
			useSessionStore.setState({
				sessions: [parentWithWatch()],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers({ isLifecycleOwner: false }));

			expect(mockGit.watchWorktreeDirectory).not.toHaveBeenCalled();
			expect(mockGit.onWorktreeDiscovered).not.toHaveBeenCalled();
			expect(mockGit.onWorktreeRemoved).not.toHaveBeenCalled();
		});

		it('does not unwatch on unmount, so a closing browser tab cannot stop the desktop watcher', () => {
			useSessionStore.setState({
				sessions: [parentWithWatch()],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			const { unmount } = renderHook(() => useWorktreeHandlers({ isLifecycleOwner: false }));
			unmount();

			expect(mockGit.unwatchWorktreeDirectory).not.toHaveBeenCalled();
		});

		it('does not run the startup scan', async () => {
			vi.useFakeTimers();

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
				sessions: [parentWithWatch()],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers({ isLifecycleOwner: false }));

			await act(async () => {
				vi.advanceTimersByTime(501);
				await vi.runAllTimersAsync();
			});

			expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
			// No rival child agent was minted for the discovered worktree.
			expect(useSessionStore.getState().sessions).toHaveLength(1);
		});

		it('does not run the legacy worktreeParentPath scanner', async () => {
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [{ path: '/projects/worktrees/legacy', branch: 'legacy', name: 'legacy' }],
			});

			useSessionStore.setState({
				sessions: [{ ...mockParentSession, worktreeParentPath: '/projects/worktrees' }],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			renderHook(() => useWorktreeHandlers({ isLifecycleOwner: false }));

			await act(async () => {
				await Promise.resolve();
			});

			expect(mockGit.scanWorktreeDirectory).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions).toHaveLength(1);
		});

		it('still exposes the user-initiated handlers', () => {
			useSessionStore.setState({
				sessions: [parentWithWatch()],
				activeSessionId: 'parent-1',
				sessionsLoaded: true,
			} as any);

			const { result } = renderHook(() => useWorktreeHandlers({ isLifecycleOwner: false }));

			// A web-desktop user must still be able to create and remove worktrees.
			expect(typeof result.current.handleCreateWorktree).toBe('function');
			expect(typeof result.current.handleConfirmDeleteWorktree).toBe('function');
		});
	});
});

describe('SSH registry retention outside the configured base', () => {
	it.each(['startup', 'save', 'refresh', 'visibility'])(
		'retains registered outside SSH children during %s while discovering only inside worktrees',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/alias/current/repo',
				worktreeConfig: { basePath: '/alias/current', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const oldAlias = createChildSession(parent, {
				id: 'outside-old-alias-child',
				cwd: '/old-alias/child',
				worktreeBranch: 'outside-feature',
				aiTabs: [{ id: 'outside-chat', agentSessionId: 'codex-session' }] as any,
			});
			const missingAlias = createChildSession(parent, {
				id: 'outside-missing-alias-child',
				cwd: '/removed-alias/detached',
				worktreeBranch: null,
				aiTabs: [{ id: 'missing-alias-chat', agentSessionId: 'detached-session' }] as any,
			});
			const physicalDetached = createChildSession(parent, {
				id: 'outside-physical-detached-child',
				cwd: '/physical/old/detached',
				worktreeBranch: null,
			});
			const currentAlias = createChildSession(parent, {
				id: 'outside-current-prefix-child',
				cwd: '/alias/current/group/child',
				worktreeBranch: 'current-alias-feature',
			});
			const retained = [oldAlias, missingAlias, physicalDetached, currentAlias];
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/physical/new/repo',
				resolvedBasePath: '/physical/new',
				resolvedSessionPaths: {
					[oldAlias.cwd]: '/physical/old/child',
					[missingAlias.cwd]: '/physical/old/missing-candidate',
					[physicalDetached.cwd]: physicalDetached.cwd,
					[currentAlias.cwd]: '/physical/old/current-child',
				},
				missingSessionPaths: [missingAlias.cwd],
				worktrees: [
					registryEntry('/physical/new/repo', 'main'),
					registryEntry('/physical/old/child', 'outside-feature'),
					registryEntry('/physical/old/missing-candidate', null),
					registryEntry(physicalDetached.cwd, null),
					registryEntry('/physical/old/current-child', 'current-alias-feature'),
					registryEntry('/physical/new/inside', 'inside'),
					registryEntry('/physical/old/unowned', 'unowned'),
					{ path: '/physical/new/bare', branch: 'bare', head: '', isBare: true },
					{ path: '/physical/new/malformed', branch: 17, head: 'vwx', isBare: false },
				],
			});
			await runConfiguredScan(mode, parent, retained);

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			for (const child of retained) expect(children).toContain(child);
			expect(children.find((session) => session.id === oldAlias.id)?.aiTabs).toEqual(
				oldAlias.aiTabs
			);
			expect(children.find((session) => session.id === missingAlias.id)?.aiTabs).toEqual(
				missingAlias.aiTabs
			);
			expect(
				children.filter((session) => !retained.includes(session)).map((session) => session.cwd)
			).toEqual(['/physical/new/inside']);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it.each(['startup', 'save'])(
		'discovers an inside SSH branch during %s despite a retained outside child storing that old branch',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/new', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const retained = createChildSession(parent, {
				id: 'outside-child-with-old-branch',
				cwd: '/old-alias/child',
				worktreeBranch: 'shared',
				aiTabs: [{ id: 'retained-chat', agentSessionId: 'codex-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/new',
				resolvedSessionPaths: { [retained.cwd]: '/physical/old/child' },
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/old/child', 'changed'),
					registryEntry('/physical/new/new-child', 'shared'),
				],
			});
			await runConfiguredScan(mode, parent, [retained]);

			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(retained);
			expect(children.find((session) => session.cwd === '/physical/new/new-child')).toEqual(
				expect.objectContaining({ worktreeBranch: 'shared' })
			);
			expect(children).toHaveLength(2);
			expect(children.find((session) => session.id === retained.id)?.aiTabs).toEqual(
				retained.aiTabs
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it.each([
		{ description: 'the parent registry path', candidatePath: '/remote/repo', isBare: false },
		{ description: 'a bare registry path', candidatePath: '/physical/old/bare', isBare: true },
	])('removes a missing alias mapped to $description', async ({ candidatePath, isBare }) => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/new', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const child = createChildSession(parent, {
			id: 'missing-alias-excluded-registry-path',
			cwd: '/old-alias/removed',
			worktreeBranch: 'removed',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/new',
			resolvedSessionPaths: { [child.cwd]: candidatePath },
			missingSessionPaths: [child.cwd],
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				...(isBare ? [{ path: candidatePath, branch: null, head: '', isBare }] : []),
			],
		});
		useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});

		expect(useSessionStore.getState().sessions).toEqual([parent]);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'removed' })
		);
	});

	it('preserves an outside alias with a malformed matching registry record while removing an unrelated missing child', async () => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/new', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const uncertain = createChildSession(parent, {
			id: 'outside-alias-malformed-record',
			cwd: '/old-alias/uncertain',
		});
		const missing = createChildSession(parent, {
			id: 'outside-alias-confirmed-missing',
			cwd: '/old-alias/missing',
			worktreeBranch: 'missing',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/new',
			resolvedSessionPaths: {
				[uncertain.cwd]: '/physical/old/uncertain',
				[missing.cwd]: '/physical/old/missing',
			},
			missingSessionPaths: [uncertain.cwd, missing.cwd],
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				{ path: '/physical/old/uncertain', branch: 17, head: 'def', isBare: false },
				registryEntry('/physical/old/unrelated', 'unrelated'),
			],
		});
		useSessionStore.setState({
			sessions: [parent, uncertain, missing],
			sessionsLoaded: true,
		} as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});

		expect(useSessionStore.getState().sessions).toEqual([parent, uncertain]);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'missing' })
		);
		expect(notifyToast).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: uncertain.worktreeBranch })
		);
	});
});

describe('SSH registry physical aliases, prunable entries, and scan races', () => {
	it.each(
		['startup', 'save', 'refresh', 'visibility'].flatMap((mode) =>
			['resolved', 'legacy'].map((metadata) => ({ mode, metadata }))
		)
	)(
		'reconciles raw and physical SSH registry aliases during $mode with $metadata metadata without replacing saved chats',
		async ({ mode, metadata }) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/home/alice/repo',
				worktreeConfig: { basePath: '/home/alice/wt', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const physicalChild = createChildSession(parent, {
				id: 'physical-registry-alias-child',
				cwd: '/data/home/alice/wt/feature',
				aiTabs: [{ id: 'physical-alias-chat', agentSessionId: 'saved-session' }] as any,
			});
			const rawChild = createChildSession(parent, {
				id: 'raw-registry-alias-child',
				cwd: '/home/alice/wt/raw-saved',
				aiTabs: [{ id: 'raw-alias-chat', agentSessionId: 'other-saved-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/data/home/alice/repo',
				resolvedBasePath: '/data/home/alice/wt',
				resolvedSessionPaths: {
					[physicalChild.cwd]: physicalChild.cwd,
					[rawChild.cwd]: '/data/home/alice/wt/raw-saved',
				},
				worktrees: [
					registryEntry('/home/alice/repo', 'main', { resolvedPath: '/data/home/alice/repo' }),
					{
						path: '/home/alice/wt/feature',
						...(metadata === 'resolved' ? { resolvedPath: physicalChild.cwd } : {}),
						branch: 'feature',
						head: 'def',
						isBare: false,
					},
					{
						path: rawChild.cwd,
						...(metadata === 'resolved' ? { resolvedPath: '/data/home/alice/wt/raw-saved' } : {}),
						branch: 'raw-saved',
						head: 'ghi',
						isBare: false,
					},
					{
						path: '/home/alice/wt/discovered-raw',
						...(metadata === 'resolved'
							? { resolvedPath: '/data/home/alice/wt/discovered-raw' }
							: {}),
						branch: 'discovered-raw',
						head: 'jkl',
						isBare: false,
					},
					registryEntry('/data/home/alice/wt/discovered-physical', 'discovered-physical', {
						resolvedPath: '/data/home/alice/wt/discovered-physical',
					}),
					registryEntry('/home/alice/wt/linked-outside', 'outside', {
						resolvedPath: '/other/worktrees/linked-outside',
					}),
				],
			});
			await runConfiguredScan(mode, parent, [physicalChild, rawChild]);
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(physicalChild);
			expect(children).toContain(rawChild);
			expect(children.find((session) => session.id === physicalChild.id)?.aiTabs).toBe(
				physicalChild.aiTabs
			);
			expect(children.find((session) => session.id === rawChild.id)?.aiTabs).toBe(rawChild.aiTabs);
			expect(
				children
					.filter((session) => session !== physicalChild && session !== rawChild)
					.map((session) => session.cwd)
					.sort()
			).toEqual(['/data/home/alice/wt/discovered-physical', '/data/home/alice/wt/discovered-raw']);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it.each(['startup', 'save', 'refresh', 'visibility'])(
		'retains registered prunable SSH chats during %s and skips unowned prunable discovery',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/data/home/alice/repo',
				worktreeConfig: { basePath: '/data/home/alice/wt', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const missingLeaf = createChildSession(parent, {
				id: 'registered-prunable-missing-leaf',
				cwd: '/data/home/alice/wt/offline-leaf',
				aiTabs: [{ id: 'offline-leaf-chat', agentSessionId: 'offline-session' }] as any,
			});
			const emptyMount = createChildSession(parent, {
				id: 'registered-prunable-empty-mount',
				cwd: '/data/home/alice/wt/empty-mount',
				aiTabs: [{ id: 'empty-mount-chat', agentSessionId: 'mounted-session' }] as any,
			});
			const unregistered = createChildSession(parent, {
				id: 'unregistered-prunable-control',
				cwd: '/data/home/alice/wt/truly-removed',
				worktreeBranch: 'truly-removed',
			});
			const vanishedBeforePrune = createChildSession(parent, {
				id: 'registered-missing-before-prunable',
				cwd: '/data/home/alice/wt/vanished-before-prune',
				aiTabs: [{ id: 'vanished-chat', agentSessionId: 'vanished-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: parent.cwd,
				resolvedBasePath: parent.worktreeConfig.basePath,
				resolvedSessionPaths: {
					[missingLeaf.cwd]: missingLeaf.cwd,
					[emptyMount.cwd]: emptyMount.cwd,
					[unregistered.cwd]: unregistered.cwd,
					[vanishedBeforePrune.cwd]: vanishedBeforePrune.cwd,
				},
				missingSessionPaths: [missingLeaf.cwd, unregistered.cwd, vanishedBeforePrune.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry(missingLeaf.cwd, 'offline-leaf', { isPrunable: true }),
					registryEntry(emptyMount.cwd, 'empty-mount', {
						resolvedPath: emptyMount.cwd,
						isPrunable: true,
					}),
					registryEntry('/data/home/alice/wt/unowned-offline', 'unowned-offline', {
						isPrunable: true,
					}),
					registryEntry('/data/home/alice/wt/healthy', 'healthy'),
					registryEntry(vanishedBeforePrune.cwd, 'vanished-before-prune', {
						resolvedPath: vanishedBeforePrune.cwd,
						pathMissing: true,
					}),
					registryEntry('/data/home/alice/wt/unowned-missing', 'unowned-missing', {
						resolvedPath: '/data/home/alice/wt/unowned-missing',
						pathMissing: true,
					}),
				],
			});
			await runConfiguredScan(mode, parent, [
				missingLeaf,
				emptyMount,
				vanishedBeforePrune,
				unregistered,
			]);
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(missingLeaf);
			expect(children).toContain(emptyMount);
			expect(children).toContain(vanishedBeforePrune);
			expect(children).not.toContain(unregistered);
			expect(children.find((session) => session.id === missingLeaf.id)?.aiTabs).toBe(
				missingLeaf.aiTabs
			);
			expect(children.find((session) => session.id === emptyMount.id)?.aiTabs).toBe(
				emptyMount.aiTabs
			);
			expect(children.find((session) => session.id === vanishedBeforePrune.id)?.aiTabs).toBe(
				vanishedBeforePrune.aiTabs
			);
			expect(
				children
					.filter(
						(session) =>
							session !== missingLeaf && session !== emptyMount && session !== vanishedBeforePrune
					)
					.map((session) => session.cwd)
			).toEqual(['/data/home/alice/wt/healthy']);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'truly-removed' })
			);
		}
	);

	it.each(
		['save', 'refresh'].flatMap((mode) =>
			['matching raw path', 'unmatched raw alias'].map((identity) => ({ mode, identity }))
		)
	)(
		'preserves SSH chats during $mode beside an unresolved registry entry with $identity',
		async ({ mode, identity }) => {
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const rawChild = createChildSession(parent, {
				id: 'unresolved-registry-raw-child',
				cwd: '/mounted/alias/uncertain',
				aiTabs: [{ id: 'raw-unresolved-chat', agentSessionId: 'raw-saved-session' }] as any,
			});
			const physicalChild = createChildSession(parent, {
				id: 'unresolved-registry-physical-child',
				cwd: '/physical/old/uncertain',
				aiTabs: [{ id: 'physical-unresolved-chat', agentSessionId: 'physical-session' }] as any,
			});
			const missingCandidate = createChildSession(parent, {
				id: 'unresolved-registry-missing-candidate',
				cwd: '/physical/wt/missing-candidate',
			});
			const retained = [rawChild, physicalChild, missingCandidate];
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/physical/wt',
				resolvedSessionPaths: {
					[rawChild.cwd]: physicalChild.cwd,
					[physicalChild.cwd]: physicalChild.cwd,
					[missingCandidate.cwd]: missingCandidate.cwd,
				},
				missingSessionPaths: [missingCandidate.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry(
						identity === 'matching raw path' ? rawChild.cwd : '/unmatched-registry/uncertain',
						'uncertain',
						{ pathUnresolved: true }
					),
					registryEntry('/physical/wt/healthy', 'healthy', {
						resolvedPath: '/physical/wt/healthy',
					}),
				],
			});
			useSessionStore.setState({
				sessions: [parent, ...retained],
				activeSessionId: parent.id,
				sessionsLoaded: false,
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				if (mode === 'save') await result.current.handleSaveWorktreeConfig(parent.worktreeConfig);
				else await result.current.refreshWorktreeState();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			for (const child of retained) expect(children).toContain(child);
			expect(children.find((session) => session.id === rawChild.id)?.aiTabs).toBe(rawChild.aiTabs);
			expect(children.find((session) => session.id === physicalChild.id)?.aiTabs).toBe(
				physicalChild.aiTabs
			);
			expect(
				children.filter((session) => !retained.includes(session)).map((session) => session.cwd)
			).toEqual(['/physical/wt/healthy']);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it.each([
		{ branch: 17 },
		{ isBare: 'false' },
		{ isPrunable: 'true' },
		{ pathMissing: 1 },
		{ pathUnresolved: 'false' },
	])(
		'preserves a physically saved SSH chat beside malformed aliased registry metadata: %j',
		async (malformed) => {
			const parent = {
				...mockParentSession,
				cwd: '/home/alice/repo',
				worktreeConfig: { basePath: '/home/alice/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const affected = createChildSession(parent, {
				id: 'malformed-aliased-registry-chat',
				cwd: '/data/home/alice/wt/feature',
				aiTabs: [{ id: 'malformed-alias-chat', agentSessionId: 'saved-chat-session' }] as any,
			});
			const missing = createChildSession(parent, {
				id: 'malformed-alias-missing-control',
				cwd: '/data/home/alice/wt/oldchild',
				worktreeBranch: 'oldchild',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/data/home/alice/repo',
				resolvedBasePath: '/data/home/alice/wt',
				resolvedSessionPaths: { [affected.cwd]: affected.cwd, [missing.cwd]: missing.cwd },
				missingSessionPaths: [missing.cwd],
				worktrees: [
					registryEntry('/data/home/alice/repo', 'main'),
					{
						path: '/home/alice/wt/feature',
						resolvedPath: affected.cwd,
						branch: 'feature',
						head: 'def',
						isBare: false,
						...malformed,
					},
					registryEntry('/data/home/alice/wt/healthy', 'healthy'),
				],
			});
			useSessionStore.setState({ sessions: [parent, affected, missing] } as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await result.current.refreshWorktreeState();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(affected);
			expect(children.find((session) => session.id === affected.id)?.aiTabs).toBe(affected.aiTabs);
			expect(children).not.toContain(missing);
			expect(
				children.filter((session) => session !== affected).map((session) => session.cwd)
			).toEqual(['/data/home/alice/wt/healthy']);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'oldchild' })
			);
			expect(
				vi.mocked(notifyToast).mock.calls.filter(([toast]) => toast.title === 'Worktree Removed')
			).toHaveLength(1);
		}
	);

	it.each([17, 'relative/feature', '/data/feature\nchatter'])(
		'preserves unproven SSH chats beside invalid registry resolvedPath %j',
		async (resolvedPath) => {
			const parent = {
				...mockParentSession,
				cwd: '/home/alice/repo',
				worktreeConfig: { basePath: '/home/alice/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const unproven = createChildSession(parent, {
				id: 'invalid-registry-physical-identity-chat',
				cwd: '/physical/old/unproven',
				aiTabs: [{ id: 'unproven-chat', agentSessionId: 'saved-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/data/home/alice/repo',
				resolvedBasePath: '/data/home/alice/wt',
				resolvedSessionPaths: { [unproven.cwd]: unproven.cwd },
				missingSessionPaths: [unproven.cwd],
				worktrees: [
					registryEntry('/data/home/alice/repo', 'main'),
					{
						path: '/home/alice/wt/feature',
						resolvedPath,
						branch: 'feature',
						head: 'def',
						isBare: false,
					},
					registryEntry('/data/home/alice/wt/healthy', 'healthy'),
				],
			});
			useSessionStore.setState({ sessions: [parent, unproven] } as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await result.current.refreshWorktreeState();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(unproven);
			expect(children.find((session) => session.id === unproven.id)?.aiTabs).toBe(unproven.aiTabs);
			expect(
				children.filter((session) => session !== unproven).map((session) => session.cwd)
			).toEqual(['/data/home/alice/wt/healthy']);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it('preserves a fresh SSH child added while the registry snapshot is pending', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const missing = createChildSession(parent, {
			id: 'snapshot-missing-control',
			cwd: '/remote/wt/oldchild',
			worktreeBranch: 'oldchild',
		});
		const fresh = createChildSession(parent, {
			id: 'created-during-registry-request',
			cwd: '/new-alias/wt/fresh',
			worktreeBranch: 'fresh',
			aiTabs: [{ id: 'fresh-chat', agentSessionId: 'fresh-session' }] as any,
		});
		let resolveListing!: (value: unknown) => void;
		mockGit.listWorktrees.mockImplementationOnce(
			() => new Promise((resolve) => (resolveListing = resolve))
		);
		useSessionStore.setState({ sessions: [parent, missing], sessionsLoaded: false } as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		let scan!: Promise<void>;
		await act(async () => {
			scan = result.current.refreshWorktreeState();
		});
		expect(mockGit.listWorktrees).toHaveBeenCalledWith(parent.cwd, 'ssh-1', '/remote/wt', [
			missing.cwd,
		]);
		await act(async () => {
			useSessionStore.getState().setSessions((sessions) => [...sessions, fresh]);
			resolveListing({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: { [missing.cwd]: missing.cwd },
				missingSessionPaths: [missing.cwd],
				worktrees: [registryEntry(parent.cwd, 'main')],
			});
			await scan;
		});
		expect(useSessionStore.getState().sessions).toContain(fresh);
		expect(useSessionStore.getState().sessions).not.toContain(missing);
		expect(notifyToast).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'fresh' })
		);
	});

	it.each(['cwd', 'parent', 'SSH host'])(
		'preserves a queued SSH removal candidate whose %s changes while discovery awaits git info',
		async (changedField) => {
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const otherParent = { ...parent, id: 'other-parent', worktreeConfig: undefined };
			const missing = createChildSession(parent, {
				id: 'addition-await-missing-control',
				cwd: '/remote/wt/oldchild',
				worktreeBranch: 'oldchild',
			});
			const candidate = createChildSession({
				id: 'retargeted-removal-candidate',
				cwd: '/remote/wt/retargeted',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				aiTabs: [{ id: 'retargeted-chat', agentSessionId: 'saved-session' }] as any,
			});
			const fresh = createChildSession(parent, {
				id: 'created-during-git-info',
				cwd: '/new-alias/wt/fresh',
				worktreeBranch: 'fresh',
				aiTabs: [{ id: 'fresh-chat', agentSessionId: 'fresh-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: {
					[missing.cwd]: missing.cwd,
					[candidate.cwd]: candidate.cwd,
				},
				missingSessionPaths: [missing.cwd, candidate.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry('/remote/wt/discovered', 'discovered'),
				],
			});
			let resolveBranches!: (value: string[]) => void;
			vi.mocked(gitService.getBranches).mockImplementationOnce(
				() => new Promise((resolve) => (resolveBranches = resolve))
			);
			useSessionStore.setState({
				sessions: [parent, otherParent, missing, candidate],
				sessionsLoaded: false,
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			let scan!: Promise<void>;
			await act(async () => {
				scan = result.current.refreshWorktreeState();
			});
			expect(gitService.getBranches).toHaveBeenCalledWith('/remote/wt/discovered', 'ssh-1');
			const retargeted = {
				...candidate,
				...(changedField === 'cwd' ? { cwd: '/new-alias/wt/moved' } : {}),
				...(changedField === 'parent' ? { parentSessionId: otherParent.id } : {}),
				...(changedField === 'SSH host'
					? { sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' } }
					: {}),
			};
			await act(async () => {
				useSessionStore
					.getState()
					.setSessions((sessions) => [
						...sessions.map((session) => (session.id === candidate.id ? retargeted : session)),
						fresh,
					]);
				resolveBranches(['main', 'discovered']);
				await scan;
			});
			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toContain(fresh);
			expect(sessions).toContain(retargeted);
			expect(sessions.find((session) => session.id === candidate.id)?.aiTabs).toBe(
				candidate.aiTabs
			);
			expect(sessions).not.toContain(missing);
			expect(sessions.some((session) => session.cwd === '/remote/wt/discovered')).toBe(true);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'oldchild' })
			);
			expect(
				vi.mocked(notifyToast).mock.calls.filter(([toast]) => toast.title === 'Worktree Removed')
			).toHaveLength(1);
		}
	);
});

describe('SSH reconciliation snapshot guards', () => {
	it('preserves a retargeted SSH child during configuration save while its missing-path map is pending', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const candidate = createChildSession(parent, {
			id: 'save-retargeted-candidate',
			cwd: '/remote/wt/old-target',
			worktreeBranch: 'retargeted',
			aiTabs: [{ id: 'save-retargeted-chat', agentSessionId: 'saved-session' }] as any,
		});
		const missing = createChildSession(parent, {
			id: 'save-missing-control',
			cwd: '/remote/wt/oldchild',
			worktreeBranch: 'oldchild',
		});
		let resolveListing!: (value: unknown) => void;
		mockGit.listWorktrees.mockImplementationOnce(
			() => new Promise((resolve) => (resolveListing = resolve))
		);
		useSessionStore.setState({
			sessions: [parent, candidate, missing],
			activeSessionId: parent.id,
		} as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		let save!: Promise<void>;
		await act(async () => {
			save = result.current.handleSaveWorktreeConfig(parent.worktreeConfig);
		});
		expect(mockGit.listWorktrees).toHaveBeenCalledWith(parent.cwd, 'ssh-1', '/remote/wt', [
			candidate.cwd,
			missing.cwd,
		]);
		const retargeted = { ...candidate, cwd: '/new-alias/wt/new-target' };
		await act(async () => {
			useSessionStore
				.getState()
				.setSessions((sessions) =>
					sessions.map((session) => (session.id === candidate.id ? retargeted : session))
				);
			resolveListing({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: { [candidate.cwd]: candidate.cwd, [missing.cwd]: missing.cwd },
				missingSessionPaths: [candidate.cwd, missing.cwd],
				worktrees: [registryEntry(parent.cwd, 'main')],
			});
			await save;
		});
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toContain(retargeted);
		expect(sessions.find((session) => session.id === candidate.id)?.aiTabs).toBe(candidate.aiTabs);
		expect(sessions).not.toContain(missing);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'oldchild' })
		);
		expect(
			vi.mocked(notifyToast).mock.calls.filter(([toast]) => toast.title === 'Worktree Removed')
		).toHaveLength(1);
	});

	it.each(
		['save', 'refresh'].flatMap((mode) =>
			['cwd', 'base path', 'SSH host'].map((changedField) => ({ mode, changedField }))
		)
	)(
		'discards an in-flight $mode reconciliation plan when the parent $changedField changes',
		async ({ mode, changedField }) => {
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				id: 'parent-retargeted-saved-child',
				cwd: '/remote/wt/oldchild',
				aiTabs: [{ id: 'parent-retargeted-chat', agentSessionId: 'saved-session' }] as any,
			});
			const listing = {
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: { [child.cwd]: child.cwd },
				missingSessionPaths: [child.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry('/remote/wt/discovered', 'discovered'),
				],
			};
			let resolveListing!: (value: unknown) => void;
			let resolveBranches!: (value: string[]) => void;
			if (mode === 'save') {
				mockGit.listWorktrees.mockImplementationOnce(
					() => new Promise((resolve) => (resolveListing = resolve))
				);
			} else {
				mockGit.listWorktrees.mockResolvedValueOnce(listing);
				vi.mocked(gitService.getBranches).mockImplementationOnce(
					() => new Promise((resolve) => (resolveBranches = resolve))
				);
			}
			useSessionStore.setState({
				sessions: [parent, child],
				activeSessionId: parent.id,
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			let scan!: Promise<void>;
			await act(async () => {
				scan =
					mode === 'save'
						? result.current.handleSaveWorktreeConfig(parent.worktreeConfig)
						: result.current.refreshWorktreeState();
			});
			if (mode === 'save') expect(mockGit.listWorktrees).toHaveBeenCalledTimes(1);
			else expect(gitService.getBranches).toHaveBeenCalledWith('/remote/wt/discovered', 'ssh-1');
			const retargetedParent = {
				...parent,
				...(changedField === 'cwd' ? { cwd: '/remote/new-repo' } : {}),
				...(changedField === 'base path'
					? { worktreeConfig: { basePath: '/remote/new-wt', watchEnabled: false } }
					: {}),
				...(changedField === 'SSH host'
					? { sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' } }
					: {}),
			};
			await act(async () => {
				useSessionStore
					.getState()
					.setSessions((sessions) =>
						sessions.map((session) => (session.id === parent.id ? retargetedParent : session))
					);
				if (mode === 'save') resolveListing(listing);
				else resolveBranches(['main', 'discovered']);
				await scan;
			});
			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toContain(child);
			expect(sessions.find((session) => session.id === child.id)?.aiTabs).toBe(child.aiTabs);
			expect(sessions.filter((session) => session.parentSessionId === parent.id)).toEqual([child]);
			expect(sessions.find((session) => session.id === parent.id)).toBe(retargetedParent);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktrees Discovered' })
			);
		}
	);
});

describe('Worktree failure isolation', () => {
	it.each([{ repoRoot: 123 }, { name: 123 }])(
		'isolates malformed local directory metadata while cleaning up healthy siblings: %j',
		async (metadata) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};
			const affected = createChildSession({
				id: 'bad-local-metadata-child',
				cwd: '/projects/worktrees/broken',
			});
			const stale = createChildSession({
				id: 'valid-local-stale-child',
				cwd: '/projects/worktrees/stale',
			});
			mockGit.worktreeInfo.mockResolvedValueOnce({
				success: true,
				exists: true,
				isWorktree: false,
				repoRoot: '/repo',
			});
			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				gitSubdirs: [
					{ path: affected.cwd, branch: 'broken', name: 'broken', repoRoot: '/repo', ...metadata },
					{ path: '/projects/worktrees/new', branch: 'new', name: 'new', repoRoot: '/repo' },
				],
			});
			useSessionStore.setState({
				sessions: [parent, affected, stale],
				sessionsLoaded: true,
			} as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(affected);
			expect(children).not.toContain(stale);
			expect(children.some((s) => s.cwd === '/projects/worktrees/new')).toBe(true);
		}
	);

	it.each([
		{ mode: 'startup', remote: false },
		{ mode: 'save', remote: false },
		{ mode: 'startup', remote: true },
		{ mode: 'save', remote: true },
		{ mode: 'watcher', remote: false },
		{ mode: 'legacy', remote: false },
	])(
		'retains an exact-path healthy chat during $mode discovery with unknown identities (SSH=$remote)',
		async ({ mode, remote }) => {
			vi.useFakeTimers();
			let callback: any;
			mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
				callback = cb;
				return () => {};
			});
			const parent = {
				...mockParentSession,
				cwd: '/repo',
				worktreeConfig: { basePath: '/trees', watchEnabled: mode === 'watcher' },
				sessionSshRemoteConfig: remote ? { enabled: true, remoteId: 'ssh-1' } : undefined,
			};
			const healthy = createChildSession(parent, {
				id: 'exact-healthy-chat',
				cwd: '/trees/healthy',
				worktreeBranch: 'healthy',
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			const uncertain = createChildSession(parent, {
				id: 'unknown-directory-chat',
				cwd: '/trees/uncertain',
				worktreeBranch: 'uncertain',
			});
			const known = [
				{ path: '/trees/healthy', name: 'healthy', branch: 'healthy' },
				{ path: '/trees/new', name: 'new', branch: 'new' },
			];
			if (remote) {
				mockGit.listWorktrees.mockResolvedValueOnce({
					resolvedCwd: '/repo',
					resolvedBasePath: '/trees',
					worktrees: [
						registryEntry('/repo', 'main'),
						null,
						...known.map((entry) => ({ ...entry, head: 'def', isBare: false })),
					],
				});
			} else {
				mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
					gitSubdirs: mode === 'watcher' || mode === 'legacy' ? [null] : [null, ...known],
				});
			}
			useSessionStore.setState({
				sessions: [parent, healthy, uncertain],
				activeSessionId: parent.id,
				sessionsLoaded: mode === 'startup',
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				if (mode === 'save') await result.current.handleSaveWorktreeConfig(parent.worktreeConfig);
				if (mode === 'watcher' || mode === 'legacy') await result.current.refreshWorktreeState();
				await vi.runAllTimersAsync();
			});
			if (mode === 'watcher')
				await act(async () => {
					for (const worktree of known) await callback({ sessionId: parent.id, worktree });
				});
			if (mode === 'legacy')
				await act(async () => {
					mockGit.scanWorktreeDirectory.mockResolvedValueOnce({ gitSubdirs: known });
					useSessionStore
						.getState()
						.updateSession(parent.id, { worktreeConfig: undefined, worktreeParentPath: '/trees' });
					await vi.runAllTimersAsync();
				});
			const children = useSessionStore
				.getState()
				.sessions.filter((session) =>
					mode === 'legacy' ? session.id !== parent.id : session.parentSessionId === parent.id
				);
			expect(children.filter((session) => session.cwd === '/trees/healthy')).toEqual([healthy]);
			expect(children).toContain(uncertain);
			expect(children.some((session) => session.cwd === '/trees/new')).toBe(true);
		}
	);

	it.each(['constructor', 'toString', '__proto__'])(
		'isolates an unresolved relative SSH alias named %s without inheriting dictionary properties',
		async (cwd) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const unresolved = createChildSession(parent, {
				id: 'dictionary-key-child',
				cwd,
				worktreeBranch: 'healthy',
			});
			const stale = createChildSession(parent, {
				id: 'dictionary-case-stale-child',
				cwd: '/physical/worktrees/stale',
			});
			mockGit.listWorktrees.mockResolvedValueOnce({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/healthy', 'healthy'),
				],
			});
			useSessionStore.setState({
				sessions: [parent, unresolved, stale],
				sessionsLoaded: true,
			} as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(unresolved);
			expect(children).not.toContain(stale);
			expect(children.some((s) => s.cwd === '/physical/worktrees/healthy')).toBe(true);
		}
	);

	it.each([
		['/alias/worktrees/unreachable'],
		['/alias/worktrees/unreachable', '/physical/worktrees/unreachable'],
	])(
		'preserves a physical local child outside the configured alias during partial probe failure: %j',
		async (...paths) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				worktreeConfig: { basePath: '/alias/worktrees', watchEnabled: false },
			};
			const uncertain = createChildSession({
				id: 'physical-child-under-local-alias',
				cwd: '/physical/worktrees/unreachable/review',
				worktreeBranch: 'healthy',
			});
			const stale = createChildSession({
				id: 'known-stale-local-alias-child',
				cwd: '/alias/worktrees/stale',
			});
			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				unresolvedPaths: paths,
				gitSubdirs: [{ path: '/alias/worktrees/healthy', branch: 'healthy', name: 'healthy' }],
			});
			useSessionStore.setState({
				sessions: [parent, uncertain, stale],
				sessionsLoaded: true,
			} as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(uncertain);
			expect(children).not.toContain(stale);
			expect(children.some((s) => s.cwd === '/alias/worktrees/healthy')).toBe(true);
		}
	);

	it('preserves uncertain local children while discovering healthy entries after a null scanner record', async () => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
		};
		const uncertain = createChildSession({
			id: 'uncertain-null-record-child',
			cwd: '/projects/worktrees/uncertain',
			worktreeBranch: 'healthy',
		});
		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			gitSubdirs: [
				null,
				{ path: '/projects/worktrees/healthy', branch: 'healthy', name: 'healthy' },
			],
		});
		useSessionStore.setState({ sessions: [parent, uncertain], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		expect(useSessionStore.getState().sessions).toContain(uncertain);
		expect(
			useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/healthy')
		).toBe(true);
	});

	it('does not let a previously unresolved child block a same-branch watcher discovery', async () => {
		vi.useFakeTimers();
		let callback: any;
		mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
			callback = cb;
			return () => {};
		});
		const parent = {
			...mockParentSession,
			worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: true },
		};
		const unresolved = createChildSession({
			id: 'unresolved-before-watch',
			cwd: '/projects/worktrees/failed',
			worktreeBranch: 'healthy',
		});
		mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
			unresolvedPaths: [unresolved.cwd],
			gitSubdirs: [],
		});
		useSessionStore.setState({ sessions: [parent, unresolved], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		await act(async () => {
			await callback({
				sessionId: parent.id,
				worktree: { path: '/projects/worktrees/healthy', name: 'healthy', branch: 'healthy' },
			});
		});
		expect(useSessionStore.getState().sessions).toContain(unresolved);
		expect(
			useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/healthy')
		).toBe(true);
	});

	it.each(['legacy', 'watcher'])(
		'ignores a malformed stored child cwd during healthy %s discovery',
		async (mode) => {
			vi.useFakeTimers();
			let callback: any;
			mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
				callback = cb;
				return () => {};
			});
			const parent = {
				...mockParentSession,
				worktreeConfig:
					mode === 'legacy' ? undefined : { basePath: '/projects/worktrees', watchEnabled: true },
				worktreeParentPath: mode === 'legacy' ? '/projects/worktrees' : undefined,
			};
			const malformed = createChildSession({
				id: 'bad-stored-child',
				cwd: null as any,
				projectRoot: null as any,
			});
			if (mode === 'legacy')
				mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
					gitSubdirs: [{ path: '/projects/worktrees/healthy', branch: 'healthy', name: 'healthy' }],
				});
			useSessionStore.setState({ sessions: [parent, malformed], sessionsLoaded: false } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				if (mode === 'watcher')
					await callback({
						sessionId: parent.id,
						worktree: { path: '/projects/worktrees/healthy', branch: 'healthy', name: 'healthy' },
					});
				await vi.runAllTimersAsync();
			});
			expect(useSessionStore.getState().sessions).toContain(malformed);
			expect(
				useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/healthy')
			).toBe(true);
		}
	);

	it.each([
		{ path: null, branch: 'broken', head: 'def', isBare: false },
		{ path: 'relative/broken', branch: 'broken', head: 'def', isBare: false },
		{ path: '/physical/worktrees/broken', branch: 17, head: 'def', isBare: false },
	])('continues healthy SSH discovery beside a malformed registry record: %j', async (record) => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const affected = createChildSession(parent, {
			id: 'malformed-registry-record-child',
			cwd: '/physical/worktrees/broken',
			worktreeBranch: 'healthy',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				record,
				registryEntry('/physical/worktrees/healthy', 'healthy'),
			],
		});
		useSessionStore.setState({ sessions: [parent, affected], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const children = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === parent.id);
		expect(children).toContain(affected);
		expect(children.some((s) => s.cwd === '/physical/worktrees/healthy')).toBe(true);
	});

	it('preserves a malformed child cwd without blocking healthy SSH discovery', async () => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const affected = createChildSession(parent, {
			id: 'malformed-cwd-child',
			cwd: null as any,
			worktreeBranch: 'healthy',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry('/physical/worktrees/healthy', 'healthy'),
			],
		});
		useSessionStore.setState({ sessions: [parent, affected], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const children = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === parent.id);
		expect(children).toContain(affected);
		expect(children.some((s) => s.cwd === '/physical/worktrees/healthy')).toBe(true);
	});

	it('skips one malformed identifiable registry entry while reconciling healthy SSH children', async () => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const affected = createChildSession(parent, {
			id: 'malformed-registry-child',
			cwd: '/physical/worktrees/broken\npath',
		});
		const stale = createChildSession(parent, {
			id: 'healthy-registry-stale-child',
			cwd: '/physical/worktrees/stale',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry(affected.cwd, 'broken'),
				registryEntry('/physical/worktrees/healthy', 'healthy'),
			],
		});
		useSessionStore.setState({ sessions: [parent, affected, stale], sessionsLoaded: true } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const children = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === parent.id);
		expect(children).toContain(affected);
		expect(children).not.toContain(stale);
		expect(children.some((s) => s.cwd === '/physical/worktrees/healthy')).toBe(true);
	});

	it.each(['startup', 'save', 'refresh', 'visibility'])(
		'continues %s reconciliation while preserving an unresolved SSH child',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const unresolved = createChildSession(parent, {
				id: 'unresolved-child',
				cwd: '/unreachable/worktrees/review',
				worktreeBranch: 'recreated',
				aiTabs: [{ id: 'existing-chat', agentSessionId: 'codex-session' }] as any,
			});
			const missing = createChildSession(parent, {
				id: 'confirmed-missing-child',
				cwd: '/old/worktrees/obsolete',
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/remote/repo',
				resolvedBasePath: '/physical/worktrees',
				unresolvedSessionPaths: [unresolved.cwd],
				resolvedSessionPaths: { [missing.cwd]: '/physical/worktrees/obsolete' },
				missingSessionPaths: [missing.cwd],
				worktrees: [
					registryEntry('/remote/repo', 'main'),
					registryEntry('/physical/worktrees/recreated', 'recreated'),
				],
			});
			await runConfiguredScan(mode, parent, [unresolved, missing]);

			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(unresolved);
			expect(children).not.toContain(missing);
			expect(children.some((s) => s.cwd === '/physical/worktrees/recreated')).toBe(true);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'recreated' })
			);
		}
	);

	it.each([
		{ resolvedSessionPaths: { '/old/worktrees/review': 'relative' } },
		{ resolvedSessionPaths: { '/old/worktrees/review': 17 } },
		{ resolvedSessionPaths: { '/old/worktrees/review': '/physical/worktrees/review\nchatter' } },
		{ missingSessionPaths: ['/old/worktrees/review'] },
		{},
	])('isolates malformed or incomplete per-child SSH metadata: %j', async (metadata) => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const unresolved = createChildSession(parent, {
			id: 'bad-child-metadata',
			cwd: '/old/worktrees/review',
			worktreeBranch: 'new',
		});
		const stale = createChildSession(parent, {
			id: 'safe-to-remove',
			cwd: '/physical/worktrees/stale',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			...metadata,
			worktrees: [
				registryEntry('/remote/repo', 'main'),
				registryEntry('/physical/worktrees/new', 'new'),
			],
		});
		useSessionStore.setState({
			sessions: [parent, unresolved, stale],
			sessionsLoaded: true,
		} as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		const children = useSessionStore
			.getState()
			.sessions.filter((s) => s.parentSessionId === parent.id);
		expect(children).toContain(unresolved);
		expect(children).not.toContain(stale);
		expect(children.some((s) => s.cwd === '/physical/worktrees/new')).toBe(true);
	});

	it('preserves only the unresolved SSH child after a parent-only registry listing', async () => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/physical/worktrees', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const unresolved = createChildSession(parent, {
			id: 'inaccessible-child',
			cwd: '/old/worktrees/review',
		});
		const stale = createChildSession(parent, {
			id: 'stale-child',
			cwd: '/physical/worktrees/stale',
		});
		mockGit.listWorktrees.mockResolvedValueOnce({
			resolvedCwd: '/remote/repo',
			resolvedBasePath: '/physical/worktrees',
			unresolvedSessionPaths: [unresolved.cwd],
			worktrees: [registryEntry('/remote/repo', 'main')],
		});
		useSessionStore.setState({
			sessions: [parent, unresolved, stale],
			sessionsLoaded: true,
		} as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		expect(useSessionStore.getState().sessions).toEqual([parent, unresolved]);
	});

	it.each(['/projects/worktrees/failed', '/projects/worktrees/failed/nested'])(
		'preserves a failed local probe child at %s while reconciling healthy local directories',
		async (failedPath) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				worktreeConfig: { basePath: '/projects/worktrees', watchEnabled: false },
			};
			const unresolved = createChildSession({
				id: 'local-unresolved-child',
				cwd: failedPath,
				worktreeBranch: 'new',
			});
			const stale = createChildSession({
				id: 'local-stale-child',
				cwd: '/projects/worktrees/stale',
			});
			mockGit.scanWorktreeDirectory.mockResolvedValueOnce({
				unresolvedPaths: ['/projects/worktrees/failed'],
				gitSubdirs: [
					{ path: '/projects/worktrees/new', branch: 'new', name: 'new', repoRoot: null },
				],
			});
			useSessionStore.setState({
				sessions: [parent, unresolved, stale],
				sessionsLoaded: true,
			} as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((s) => s.parentSessionId === parent.id);
			expect(children).toContain(unresolved);
			expect(children).not.toContain(stale);
			expect(children.some((s) => s.cwd === '/projects/worktrees/new')).toBe(true);
		}
	);

	it.each(['startup', 'save', 'legacy'])(
		'continues %s discovery after one child session construction throws',
		async (mode) => {
			vi.useFakeTimers();
			const original = worktreeSessionUtils.buildWorktreeSession;
			const spy = vi
				.spyOn(worktreeSessionUtils, 'buildWorktreeSession')
				.mockImplementation((params) => {
					if (params.path.endsWith('/broken')) throw new Error('one child could not be built');
					return original(params);
				});
			try {
				const parent = {
					...mockParentSession,
					worktreeConfig:
						mode === 'legacy'
							? undefined
							: { basePath: '/projects/worktrees', watchEnabled: false },
					worktreeParentPath: mode === 'legacy' ? '/projects/worktrees' : undefined,
				};
				mockGit.scanWorktreeDirectory.mockResolvedValue({
					gitSubdirs: [
						{ path: '/projects/worktrees/broken', branch: 'broken', name: 'broken' },
						{ path: '/projects/worktrees/healthy', branch: 'healthy', name: 'healthy' },
					],
				});
				useSessionStore.setState({
					sessions: [parent],
					activeSessionId: parent.id,
					sessionsLoaded: mode === 'startup',
				} as any);
				const { result } = renderHook(() => useWorktreeHandlers());
				await act(async () => {
					if (mode === 'save')
						await result.current.handleSaveWorktreeConfig(parent.worktreeConfig!);
					await vi.runAllTimersAsync();
				});
				expect(
					useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/healthy')
				).toBe(true);
				expect(
					useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/broken')
				).toBe(false);
			} finally {
				spy.mockRestore();
			}
		}
	);

	it('contains a failed watcher discovery without rejecting its event or blocking the next event', async () => {
		let callback: any;
		mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
			callback = cb;
			return () => {};
		});
		const original = worktreeSessionUtils.buildWorktreeSession;
		const spy = vi
			.spyOn(worktreeSessionUtils, 'buildWorktreeSession')
			.mockImplementation((params) => {
				if (params.path.endsWith('/broken')) throw new Error('watcher child could not be built');
				return original(params);
			});
		try {
			useSessionStore.setState({ sessions: [mockParentSession] } as any);
			renderHook(() => useWorktreeHandlers());
			let results: PromiseSettledResult<unknown>[] = [];
			await act(async () => {
				results = await Promise.allSettled(
					['broken', 'healthy'].map((name) =>
						callback({
							sessionId: mockParentSession.id,
							worktree: { path: `/projects/worktrees/${name}`, branch: name, name },
						})
					)
				);
			});
			expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
			expect(
				useSessionStore.getState().sessions.some((s) => s.cwd === '/projects/worktrees/healthy')
			).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('Multi-parent scan arguments and SSH host identity', () => {
	it.each(['cwd', 'base path', 'SSH host'])(
		'discards stale SSH arguments for a later parent whose %s changes while the first parent is scanned',
		async (changedField) => {
			const firstParent = {
				...mockParentSession,
				id: 'first-parent',
				cwd: '/remote/first/repo',
				worktreeConfig: { basePath: '/remote/first/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const laterParent = {
				...firstParent,
				id: 'later-parent',
				cwd: '/remote/later/repo',
				worktreeConfig: { basePath: '/remote/later/wt', watchEnabled: false },
			};
			const fresh = createChildSession({
				id: 'retargeted-later-parent-chat',
				parentSessionId: laterParent.id,
				cwd: '/remote/new-wt/fresh',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: changedField === 'SSH host' ? 'ssh-2' : 'ssh-1',
				},
				aiTabs: [{ id: 'later-parent-chat', agentSessionId: 'new-parent-session' }] as any,
			});
			let resolveFirst!: (value: unknown) => void;
			const firstListing = new Promise((resolve) => (resolveFirst = resolve));
			mockGit.listWorktrees.mockImplementation((cwd) =>
				cwd === firstParent.cwd
					? firstListing
					: Promise.resolve({
							resolvedCwd: laterParent.cwd,
							resolvedBasePath: laterParent.worktreeConfig.basePath,
							resolvedSessionPaths: { [fresh.cwd]: fresh.cwd },
							missingSessionPaths: [fresh.cwd],
							worktrees: [
								registryEntry(laterParent.cwd, 'main'),
								registryEntry('/remote/later/wt/obsolete-discovery', 'obsolete-discovery'),
							],
						})
			);
			useSessionStore.setState({ sessions: [firstParent, laterParent] } as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			let scan!: Promise<void>;
			await act(async () => {
				scan = result.current.refreshWorktreeState();
			});
			expect(mockGit.listWorktrees).toHaveBeenCalledWith(
				firstParent.cwd,
				'ssh-1',
				firstParent.worktreeConfig.basePath,
				[]
			);
			const retargetedParent = {
				...laterParent,
				...(changedField === 'cwd' ? { cwd: '/remote/new-repo' } : {}),
				...(changedField === 'base path'
					? { worktreeConfig: { basePath: '/remote/new-wt', watchEnabled: false } }
					: {}),
				...(changedField === 'SSH host'
					? { sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' } }
					: {}),
			};
			await act(async () => {
				useSessionStore.getState().setSessions([firstParent, retargetedParent, fresh]);
				resolveFirst({
					resolvedCwd: firstParent.cwd,
					resolvedBasePath: firstParent.worktreeConfig.basePath,
					worktrees: [registryEntry(firstParent.cwd, 'main')],
				});
				await scan;
			});
			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toContain(fresh);
			expect(sessions.find((session) => session.id === fresh.id)?.aiTabs).toBe(fresh.aiTabs);
			expect(sessions.filter((session) => session.parentSessionId === laterParent.id)).toEqual([
				fresh,
			]);
			expect(sessions.find((session) => session.id === laterParent.id)).toBe(retargetedParent);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it('discards stale local base arguments for a later parent retargeted during the first scan', async () => {
		const firstParent = {
			...mockParentSession,
			id: 'first-local-parent',
			cwd: '/local/first/repo',
			worktreeConfig: { basePath: '/local/first/wt', watchEnabled: false },
		};
		const laterParent = {
			...firstParent,
			id: 'later-local-parent',
			cwd: '/local/later/repo',
			worktreeConfig: { basePath: '/local/later/wt', watchEnabled: false },
		};
		const fresh = createChildSession({
			id: 'retargeted-later-local-chat',
			parentSessionId: laterParent.id,
			cwd: '/local/new-wt/fresh',
			aiTabs: [{ id: 'later-local-chat', agentSessionId: 'local-saved-session' }] as any,
		});
		let resolveFirst!: (value: unknown) => void;
		const firstScan = new Promise((resolve) => (resolveFirst = resolve));
		mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		mockGit.scanWorktreeDirectory.mockImplementation((basePath) =>
			basePath === firstParent.worktreeConfig.basePath
				? firstScan
				: Promise.resolve({
						gitSubdirs: [
							{
								path: '/local/later/wt/obsolete-discovery',
								branch: 'obsolete-discovery',
								name: 'obsolete-discovery',
								repoRoot: null,
							},
						],
					})
		);
		useSessionStore.setState({ sessions: [firstParent, laterParent] } as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		let scan!: Promise<void>;
		await act(async () => {
			scan = result.current.refreshWorktreeState();
		});
		expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledWith(
			firstParent.worktreeConfig.basePath,
			undefined
		);
		const retargetedParent = {
			...laterParent,
			worktreeConfig: { basePath: '/local/new-wt', watchEnabled: false },
		};
		await act(async () => {
			useSessionStore.getState().setSessions([firstParent, retargetedParent, fresh]);
			resolveFirst({ gitSubdirs: [] });
			await scan;
		});
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toContain(fresh);
		expect(sessions.find((session) => session.id === fresh.id)?.aiTabs).toBe(fresh.aiTabs);
		expect(sessions.filter((session) => session.parentSessionId === laterParent.id)).toEqual([
			fresh,
		]);
		expect(sessions.find((session) => session.id === laterParent.id)).toBe(retargetedParent);
		expect(notifyToast).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed' })
		);
	});

	it.each(
		['startup', 'save', 'refresh'].flatMap((mode) =>
			['different path', 'same path'].map((pathRelationship) => ({ mode, pathRelationship }))
		)
	)(
		'retains SSH1 chats and discovers distinct SSH2 worktrees at a $pathRelationship during $mode after parent host changes',
		async ({ mode, pathRelationship }) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
			};
			const oldHostChild = createChildSession({
				id: 'old-host-saved-chat',
				cwd: pathRelationship === 'same path' ? '/remote/wt/shared' : '/remote/wt/old-host',
				worktreeBranch: 'old-host',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				aiTabs: [{ id: 'old-host-chat', agentSessionId: 'ssh1-saved-session' }] as any,
			});
			const inheritedMissing = createChildSession(parent, {
				id: 'current-host-inherited-missing-control',
				cwd: '/remote/wt/inherited-missing',
				worktreeBranch: 'inherited-missing',
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: {
					[oldHostChild.cwd]: oldHostChild.cwd,
					[inheritedMissing.cwd]: inheritedMissing.cwd,
				},
				missingSessionPaths: [oldHostChild.cwd, inheritedMissing.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry('/remote/wt/shared', 'new-host'),
				],
			});
			await runConfiguredScan(mode, parent, [oldHostChild, inheritedMissing]);
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(oldHostChild);
			expect(children.find((session) => session.id === oldHostChild.id)?.aiTabs).toBe(
				oldHostChild.aiTabs
			);
			expect(children).not.toContain(inheritedMissing);
			const discovered = children.filter((session) => session.id !== oldHostChild.id);
			expect(discovered).toHaveLength(1);
			expect(discovered[0]).toEqual(
				expect.objectContaining({
					cwd: '/remote/wt/shared',
					worktreeBranch: 'new-host',
					sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
				})
			);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'inherited-missing' })
			);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'old-host' })
			);
		}
	);
});

describe('Configured SSH target precedence over the previous spawn', () => {
	it.each(['save', 'refresh'])(
		'uses the configured SSH2 target during %s when the parent last spawned on SSH1',
		async (mode) => {
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
				sshRemoteId: 'ssh-1',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
			};
			const oldHostChild = createChildSession({
				id: 'previous-spawn-host-chat',
				cwd: '/remote/wt/old-host',
				worktreeBranch: 'old-host',
				sshRemoteId: 'ssh-1',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				aiTabs: [{ id: 'previous-host-chat', agentSessionId: 'ssh1-session' }] as any,
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: { [oldHostChild.cwd]: oldHostChild.cwd },
				missingSessionPaths: [oldHostChild.cwd],
				worktrees: [
					registryEntry(parent.cwd, 'main'),
					registryEntry('/remote/wt/new-host', 'new-host'),
				],
			});
			useSessionStore.setState({
				sessions: [parent, oldHostChild],
				activeSessionId: parent.id,
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				if (mode === 'save') await result.current.handleSaveWorktreeConfig(parent.worktreeConfig);
				else await result.current.refreshWorktreeState();
			});
			expect(mockGit.listWorktrees).toHaveBeenCalledWith(parent.cwd, 'ssh-2', '/remote/wt', [
				oldHostChild.cwd,
			]);
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(oldHostChild);
			expect(children.find((session) => session.id === oldHostChild.id)?.aiTabs).toBe(
				oldHostChild.aiTabs
			);
			expect(children.filter((session) => session.id !== oldHostChild.id)).toEqual([
				expect.objectContaining({
					cwd: '/remote/wt/new-host',
					sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
				}),
			]);
			expect(gitService.getBranches).toHaveBeenCalledWith('/remote/wt/new-host', 'ssh-2');
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed' })
			);
		}
	);

	it('rejects a later parent stale SSH configuration despite its unchanged last-spawn remote', async () => {
		const firstParent = {
			...mockParentSession,
			id: 'cached-first-parent',
			cwd: '/remote/first/repo',
			worktreeConfig: { basePath: '/remote/first/wt', watchEnabled: false },
			sshRemoteId: 'ssh-1',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const laterParent = {
			...firstParent,
			id: 'cached-later-parent',
			cwd: '/remote/later/repo',
			worktreeConfig: { basePath: '/remote/later/wt', watchEnabled: false },
		};
		let resolveFirst!: (value: unknown) => void;
		const firstListing = new Promise((resolve) => (resolveFirst = resolve));
		mockGit.listWorktrees.mockImplementation((cwd) =>
			cwd === firstParent.cwd
				? firstListing
				: Promise.resolve({
						resolvedCwd: laterParent.cwd,
						resolvedBasePath: laterParent.worktreeConfig.basePath,
						worktrees: [
							registryEntry(laterParent.cwd, 'main'),
							registryEntry('/remote/later/wt/stale-discovery', 'stale-discovery'),
						],
					})
		);
		useSessionStore.setState({ sessions: [firstParent, laterParent] } as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		let scan!: Promise<void>;
		await act(async () => {
			scan = result.current.refreshWorktreeState();
		});
		const retargetedParent = {
			...laterParent,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
		};
		await act(async () => {
			useSessionStore.getState().setSessions([firstParent, retargetedParent]);
			resolveFirst({
				resolvedCwd: firstParent.cwd,
				resolvedBasePath: firstParent.worktreeConfig.basePath,
				worktrees: [registryEntry(firstParent.cwd, 'main')],
			});
			await scan;
		});
		expect(mockGit.listWorktrees).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions).toEqual([firstParent, retargetedParent]);
		expect(gitService.getBranches).not.toHaveBeenCalled();
	});

	it('scans locally for a disabled parent and discovers a local same-path chat beside its SSH1 child', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/local/repo',
			worktreeConfig: { basePath: '/local/wt', watchEnabled: false },
			sshRemoteId: 'ssh-1',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-1' },
		};
		const oldHostChild = createChildSession({
			id: 'disabled-parent-independent-ssh-chat',
			cwd: '/local/wt/shared',
			worktreeBranch: 'ssh-host',
			sshRemoteId: 'ssh-1',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			aiTabs: [{ id: 'independent-ssh-chat', agentSessionId: 'ssh1-session' }] as any,
		});
		mockGit.scanWorktreeDirectory.mockResolvedValue({
			gitSubdirs: [{ path: '/local/wt/shared', branch: 'local', name: 'local', repoRoot: null }],
		});
		mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		mockGit.listWorktrees.mockResolvedValue({
			resolvedCwd: parent.cwd,
			resolvedBasePath: '/local/wt',
			resolvedSessionPaths: { [oldHostChild.cwd]: oldHostChild.cwd },
			missingSessionPaths: [oldHostChild.cwd],
			worktrees: [registryEntry(parent.cwd, 'main')],
		});
		useSessionStore.setState({ sessions: [parent, oldHostChild] } as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await result.current.refreshWorktreeState();
		});
		expect(mockGit.scanWorktreeDirectory).toHaveBeenCalledWith('/local/wt', undefined);
		expect(mockGit.listWorktrees).not.toHaveBeenCalled();
		const children = useSessionStore
			.getState()
			.sessions.filter((session) => session.parentSessionId === parent.id);
		expect(children).toContain(oldHostChild);
		expect(children.find((session) => session.id === oldHostChild.id)?.aiTabs).toBe(
			oldHostChild.aiTabs
		);
		expect(children.filter((session) => session.id !== oldHostChild.id)).toEqual([
			expect.objectContaining({
				cwd: '/local/wt/shared',
				worktreeBranch: 'local',
				sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
			}),
		]);
		expect(gitService.getBranches).toHaveBeenCalledWith('/local/wt/shared', undefined);
	});

	it('treats an explicitly disabled child as local despite its previous SSH1 spawn and enabled parent', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/remote/repo',
			worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const localChild = createChildSession({
			id: 'explicitly-local-saved-chat',
			cwd: '/remote/wt/shared',
			worktreeBranch: 'local',
			sshRemoteId: 'ssh-1',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-1' },
			aiTabs: [{ id: 'explicitly-local-chat', agentSessionId: 'local-session' }] as any,
		});
		mockGit.listWorktrees.mockResolvedValue({
			resolvedCwd: parent.cwd,
			resolvedBasePath: '/remote/wt',
			resolvedSessionPaths: { [localChild.cwd]: localChild.cwd },
			missingSessionPaths: [localChild.cwd],
			worktrees: [
				registryEntry(parent.cwd, 'main'),
				registryEntry('/remote/wt/shared', 'ssh-host'),
			],
		});
		useSessionStore.setState({ sessions: [parent, localChild] } as any);
		const { result } = renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await result.current.refreshWorktreeState();
		});
		const children = useSessionStore
			.getState()
			.sessions.filter((session) => session.parentSessionId === parent.id);
		expect(children).toContain(localChild);
		expect(children.find((session) => session.id === localChild.id)?.aiTabs).toBe(
			localChild.aiTabs
		);
		expect(children.filter((session) => session.id !== localChild.id)).toEqual([
			expect.objectContaining({
				cwd: '/remote/wt/shared',
				worktreeBranch: 'ssh-host',
				sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
			}),
		]);
		expect(gitService.getBranches).toHaveBeenCalledWith('/remote/wt/shared', 'ssh-1');
	});
});

describe('Local child identity and watcher targets', () => {
	it.each(['missing', 'unregistered', 'same path'])(
		'preserves a configless local chat under an SSH2 parent when its registry reports %s',
		async (registryStatus) => {
			const parent = {
				...mockParentSession,
				cwd: '/remote/repo',
				worktreeConfig: { basePath: '/remote/wt', watchEnabled: false },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
			};
			const localChild = createChildSession({
				id: 'configless-local-chat',
				cwd: '/remote/wt/local-chat',
				worktreeBranch: 'local-chat',
				sessionSshRemoteConfig: undefined,
				sshRemoteId: undefined,
				aiTabs: [{ id: 'configless-chat', agentSessionId: 'local-session' }] as any,
			});
			const remotePath = registryStatus === 'same path' ? localChild.cwd : '/remote/wt/healthy';
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: parent.cwd,
				resolvedBasePath: '/remote/wt',
				resolvedSessionPaths: { [localChild.cwd]: localChild.cwd },
				...(registryStatus === 'missing' ? { missingSessionPaths: [localChild.cwd] } : {}),
				worktrees: [registryEntry(parent.cwd, 'main'), registryEntry(remotePath, 'ssh2-chat')],
			});
			useSessionStore.setState({ sessions: [parent, localChild] } as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await result.current.refreshWorktreeState();
			});
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(localChild);
			expect(children.find((session) => session.id === localChild.id)?.aiTabs).toBe(
				localChild.aiTabs
			);
			expect(children.filter((session) => session.id !== localChild.id)).toEqual([
				expect.objectContaining({
					cwd: remotePath,
					worktreeBranch: 'ssh2-chat',
					sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
				}),
			]);
			expect(notifyToast).not.toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Removed', message: 'local-chat' })
			);
		}
	);

	it('removes only the local chat when a local watcher path also belongs to an older SSH1 chat', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/local/repo',
			worktreeConfig: { basePath: '/local/wt', watchEnabled: true },
			sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-1' },
		};
		const sshChild = createChildSession({
			id: 'older-ssh1-watcher-chat',
			cwd: '/local/wt/shared',
			worktreeBranch: 'ssh1-chat',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			aiTabs: [{ id: 'ssh1-chat', agentSessionId: 'ssh1-session' }] as any,
		});
		const localChild = createChildSession(parent, {
			id: 'local-watcher-chat',
			cwd: sshChild.cwd,
			worktreeBranch: 'local-chat',
		});
		let callback: any;
		mockGit.onWorktreeRemoved.mockImplementationOnce((cb) => {
			callback = cb;
			return () => {};
		});
		useSessionStore.setState({ sessions: [parent, sshChild, localChild] } as any);
		renderHook(() => useWorktreeHandlers());
		await act(async () => {
			await callback({ sessionId: parent.id, worktreePath: localChild.cwd });
		});
		expect(useSessionStore.getState().sessions).toContain(sshChild);
		expect(useSessionStore.getState().sessions).not.toContain(localChild);
		expect(
			useSessionStore.getState().sessions.find((session) => session.id === sshChild.id)?.aiTabs
		).toBe(sshChild.aiTabs);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Worktree Removed', message: 'local-chat' })
		);
	});

	it.each(['before discovery', 'during git info'])(
		'discovers a local watcher chat beside an SSH1 chat inserted %s at the same path',
		async (insertAt) => {
			const parent = {
				...mockParentSession,
				cwd: '/local/repo',
				worktreeConfig: { basePath: '/local/wt', watchEnabled: true },
				sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-1' },
			};
			const sshChild = createChildSession({
				id: 'ssh1-chat-beside-local-discovery',
				cwd: '/local/wt/shared',
				worktreeBranch: 'shared',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
				aiTabs: [{ id: 'ssh1-shared-chat', agentSessionId: 'ssh1-session' }] as any,
			});
			let callback: any;
			mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
				callback = cb;
				return () => {};
			});
			mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: false, isWorktree: false });
			let resolveBranches!: (value: string[]) => void;
			if (insertAt === 'during git info') {
				vi.mocked(gitService.getBranches).mockImplementationOnce(
					() => new Promise((resolve) => (resolveBranches = resolve))
				);
			}
			useSessionStore.setState({
				sessions: insertAt === 'before discovery' ? [parent, sshChild] : [parent],
			} as any);
			renderHook(() => useWorktreeHandlers());
			let discovery!: Promise<void>;
			await act(async () => {
				discovery = callback({
					sessionId: parent.id,
					worktree: { path: sshChild.cwd, branch: 'shared', name: 'shared' },
				});
				if (insertAt === 'before discovery') await discovery;
			});
			if (insertAt === 'during git info') {
				expect(gitService.getBranches).toHaveBeenCalledWith(sshChild.cwd, undefined);
				await act(async () => {
					useSessionStore.getState().setSessions((sessions) => [...sessions, sshChild]);
					resolveBranches(['main', 'shared']);
					await discovery;
				});
			}
			const children = useSessionStore
				.getState()
				.sessions.filter((session) => session.parentSessionId === parent.id);
			expect(children).toContain(sshChild);
			expect(children.find((session) => session.id === sshChild.id)?.aiTabs).toBe(sshChild.aiTabs);
			expect(children.filter((session) => session.id !== sshChild.id)).toEqual([
				expect.objectContaining({
					cwd: sshChild.cwd,
					sessionSshRemoteConfig: parent.sessionSshRemoteConfig,
				}),
			]);
		}
	);

	it('starts a local watcher after the parent disables SSH without changing its base path', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/shared/repo',
			worktreeConfig: { basePath: '/shared/wt', watchEnabled: true },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
		};
		useSessionStore.setState({ sessions: [parent] } as any);
		const { rerender } = renderHook(() => useWorktreeHandlers());
		await act(async () => {
			useSessionStore.getState().updateSession(parent.id, {
				sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-2' },
			});
			rerender();
		});
		expect(mockGit.watchWorktreeDirectory).toHaveBeenCalledWith(parent.id, '/shared/wt', undefined);
	});

	it('discards local watcher discovery when its parent switches to SSH2 while git info is pending', async () => {
		const parent = {
			...mockParentSession,
			cwd: '/local/repo',
			worktreeConfig: { basePath: '/local/wt', watchEnabled: true },
			sessionSshRemoteConfig: { enabled: false, remoteId: 'ssh-1' },
		};
		let callback: any;
		mockGit.onWorktreeDiscovered.mockImplementationOnce((cb) => {
			callback = cb;
			return () => {};
		});
		mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		let resolveBranches!: (value: string[]) => void;
		vi.mocked(gitService.getBranches).mockImplementationOnce(
			() => new Promise((resolve) => (resolveBranches = resolve))
		);
		useSessionStore.setState({ sessions: [parent] } as any);
		renderHook(() => useWorktreeHandlers());
		let discovery!: Promise<void>;
		await act(async () => {
			discovery = callback({
				sessionId: parent.id,
				worktree: { path: '/local/wt/new-chat', branch: 'new-chat', name: 'new-chat' },
			});
		});
		expect(gitService.getBranches).toHaveBeenCalledWith('/local/wt/new-chat', undefined);
		const retargetedParent = {
			...parent,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-2' },
		};
		await act(async () => {
			useSessionStore.getState().setSessions([retargetedParent]);
			resolveBranches(['main', 'new-chat']);
			await discovery;
		});
		expect(useSessionStore.getState().sessions).toEqual([retargetedParent]);
		expect(useSessionStore.getState().sessions[0].worktreesExpanded).toBe(false);
		expect(notifyToast).not.toHaveBeenCalledWith(
			expect.objectContaining({ title: 'New Worktree Discovered' })
		);
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

describe('Per-parent discovery with SSH reconciliation', () => {
	it.each(['startup', 'refresh', 'visibility'])(
		'deduplicates a concurrent SSH alias child at %s commit time without a creation mark',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				cwd: '/repo',
				worktreeConfig: { basePath: '~/trees', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			};
			const child = createChildSession(parent, {
				cwd: '~/trees/review',
				projectRoot: '~/trees/review',
				worktreeBranch: 'review',
			});
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/repo',
				resolvedBasePath: '/physical/trees',
				worktrees: [
					registryEntry('/repo', 'main'),
					registryEntry('/physical/trees/review', 'review'),
				],
			});
			const originalBuild = worktreeSessionUtils.buildWorktreeSession;
			const buildSpy = vi
				.spyOn(worktreeSessionUtils, 'buildWorktreeSession')
				.mockImplementationOnce((options) => {
					useSessionStore.getState().setSessions((prev) => [...prev, child]);
					return originalBuild(options);
				});
			try {
				await runConfiguredScan(mode, parent);
				expect(
					useSessionStore.getState().sessions.filter((s) => s.parentSessionId === parent.id)
				).toEqual([child]);
			} finally {
				buildSpy.mockRestore();
			}
		}
	);

	it.each(['watcher', 'legacy'])(
		'retains an unresolved local child by its exact project root during %s discovery',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				worktreeConfig: { basePath: '/trees', watchEnabled: true },
			};
			const child = createChildSession(parent, {
				cwd: '/elsewhere',
				projectRoot: '/trees/healthy',
				worktreeBranch: 'healthy',
			});
			let onDiscovered!: (data: any) => Promise<void>;
			mockGit.onWorktreeDiscovered.mockImplementationOnce((callback) => {
				onDiscovered = callback;
				return () => {};
			});
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				unresolvedPaths: ['/trees/broken'],
				gitSubdirs: [],
			});
			useSessionStore.setState({ sessions: [parent, child], sessionsLoaded: true } as any);
			renderHook(() => useWorktreeHandlers());
			await act(async () => {
				await vi.runAllTimersAsync();
			});
			const worktree = { path: '/trees/healthy', name: 'healthy', branch: 'healthy' };
			await act(async () => {
				if (mode === 'watcher') {
					await onDiscovered({ sessionId: parent.id, worktree });
				} else {
					mockGit.scanWorktreeDirectory.mockResolvedValue({ gitSubdirs: [worktree] });
					useSessionStore.getState().updateSession(parent.id, {
						worktreeParentPath: '/trees',
						worktreeConfig: undefined,
					});
				}
				await vi.runAllTimersAsync();
			});
			expect(
				useSessionStore.getState().sessions.filter((s) => s.parentSessionId === parent.id)
			).toEqual([child]);
		}
	);

	it.each(
		['startup', 'save', 'refresh', 'visibility'].flatMap((mode) =>
			['configured', 'registry', 'during construction'].map((mark) => ({ mode, mark }))
		)
	)('honors SSH creation marks during $mode via $mark paths', async ({ mode, mark }) => {
		vi.useFakeTimers();
		const parent = {
			...mockParentSession,
			cwd: '/repo',
			worktreeConfig: { basePath: '~/trees', watchEnabled: mode === 'visibility' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
		};
		const configuredPath = '~/trees/review';
		const registryPath = '/alias/trees/review';
		const physicalPath = '/physical/trees/review';
		mockGit.listWorktrees.mockResolvedValue({
			resolvedCwd: '/repo',
			resolvedBasePath: '/physical/trees',
			worktrees: [
				registryEntry('/repo', 'main'),
				registryEntry(registryPath, 'review', { resolvedPath: physicalPath }),
			],
		});
		const originalBuild = worktreeSessionUtils.buildWorktreeSession;
		const buildSpy = vi.spyOn(worktreeSessionUtils, 'buildWorktreeSession');
		if (mark === 'during construction') {
			buildSpy.mockImplementationOnce((options) => {
				markWorktreePathAsRecentlyCreated(configuredPath);
				return originalBuild(options);
			});
		} else {
			markWorktreePathAsRecentlyCreated(mark === 'registry' ? registryPath : configuredPath);
		}
		try {
			await runConfiguredScan(mode, parent);
			expect(
				useSessionStore.getState().sessions.filter((s) => s.parentSessionId === parent.id)
			).toHaveLength(0);
		} finally {
			buildSpy.mockRestore();
			clearRecentlyCreatedWorktreePath(configuredPath);
			clearRecentlyCreatedWorktreePath(registryPath);
		}
	});

	it.each(['startup', 'save', 'refresh', 'visibility'])(
		'reuses a local project root during %s even when an unrelated error protects a drifted cwd',
		async (mode) => {
			vi.useFakeTimers();
			const parent = {
				...mockParentSession,
				worktreeConfig: { basePath: '/trees', watchEnabled: mode === 'visibility' },
			};
			const child = createChildSession(parent, {
				cwd: '/elsewhere',
				projectRoot: '/trees/healthy',
				worktreeBranch: 'healthy',
			});
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				unresolvedPaths: ['/trees/broken'],
				gitSubdirs: [
					{ path: '/trees/healthy', name: 'healthy', branch: 'healthy', repoRoot: null },
				],
			});
			await runConfiguredScan(mode, parent, [child]);
			expect(useSessionStore.getState().sessions).toEqual([parent, child]);
		}
	);

	it.each(
		['startup', 'save', 'refresh', 'visibility'].flatMap((mode) =>
			[false, true].flatMap((remote) =>
				[false, true].map((existing) => ({ mode, remote, existing }))
			)
		)
	)(
		'keeps one child per parent during $mode (remote=$remote, existing=$existing)',
		async ({ mode, remote, existing }) => {
			vi.useFakeTimers();
			const parentA = {
				...mockParentSession,
				id: 'owner-a',
				cwd: '/repo',
				worktreeConfig: { basePath: '/trees', watchEnabled: mode === 'visibility' },
				sessionSshRemoteConfig: remote ? { enabled: true, remoteId: 'ssh-1' } : undefined,
			};
			const parentB = { ...parentA, id: 'owner-b' };
			const child = createChildSession(parentA, {
				id: 'saved-owner-a-child',
				cwd: '/trees/shared',
				projectRoot: '/trees/shared',
				worktreeBranch: 'feature',
				aiTabs: [{ id: 'saved-chat', agentSessionId: 'saved-session' }] as any,
			});
			mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: true, repoRoot: '/repo' });
			mockGit.listWorktrees.mockResolvedValue({
				resolvedCwd: '/repo',
				resolvedBasePath: '/trees',
				worktrees: [registryEntry('/repo', 'main'), registryEntry('/trees/shared', 'feature')],
			});
			mockGit.scanWorktreeDirectory.mockResolvedValue({
				gitSubdirs: [
					{ path: '/trees/shared', name: 'shared', branch: 'feature', repoRoot: '/repo' },
				],
			});
			useSessionStore.setState({
				sessions: [parentA, parentB, ...(existing ? [child] : [])],
				activeSessionId: parentA.id,
				sessionsLoaded: mode === 'startup',
			} as any);
			const { result } = renderHook(() => useWorktreeHandlers());
			await act(async () => {
				if (mode === 'save') {
					await result.current.handleSaveWorktreeConfig(parentA.worktreeConfig);
					useSessionStore.getState().setActiveSessionId(parentB.id);
					await result.current.handleSaveWorktreeConfig(parentB.worktreeConfig);
				}
				if (mode === 'refresh') await result.current.refreshWorktreeState();
				if (mode === 'visibility') {
					Object.defineProperty(document, 'hidden', { value: false, writable: true });
					document.dispatchEvent(new Event('visibilitychange'));
				}
				await vi.runAllTimersAsync();
			});
			// Check the selected entry point before a refresh could mask its failure.
			expect(
				useSessionStore.getState().sessions.filter((s) => s.parentSessionId === parentA.id)
			).toHaveLength(1);
			expect(
				useSessionStore.getState().sessions.filter((s) => s.parentSessionId === parentB.id)
			).toHaveLength(1);
			await act(async () => {
				await result.current.refreshWorktreeState();
			});
			const sessions = useSessionStore.getState().sessions;
			const childrenA = sessions.filter((s) => s.parentSessionId === parentA.id);
			const childrenB = sessions.filter((s) => s.parentSessionId === parentB.id);
			expect(childrenA).toHaveLength(1);
			expect(childrenB).toHaveLength(1);
			expect(childrenA[0].cwd).toBe('/trees/shared');
			expect(childrenB[0].cwd).toBe('/trees/shared');
			expect(childrenA[0].id).not.toBe(childrenB[0].id);
			if (existing) expect(childrenA[0]).toBe(child);
		}
	);

	it.each([false, true])(
		'handles concurrent watcher events without losing ownership (same parent=%s)',
		async (sameParent) => {
			const parentA = { ...mockParentSession, id: 'owner-a', cwd: '/repo' };
			const parentB = { ...parentA, id: 'owner-b' };
			let onDiscovered!: (data: any) => Promise<void>;
			mockGit.onWorktreeDiscovered.mockImplementationOnce((callback) => {
				onDiscovered = callback;
				return () => {};
			});
			mockGit.worktreeInfo.mockResolvedValue({ success: true, exists: true, repoRoot: '/repo' });
			useSessionStore.setState({ sessions: [parentA, parentB], sessionsLoaded: false } as any);
			renderHook(() => useWorktreeHandlers());
			const worktree = { path: '/projects/worktrees/shared', name: 'shared', branch: 'feature' };
			await act(async () => {
				await Promise.all([
					onDiscovered({ sessionId: parentA.id, worktree }),
					onDiscovered({ sessionId: sameParent ? parentA.id : parentB.id, worktree }),
				]);
			});
			const sessions = useSessionStore.getState().sessions;
			expect(sessions.filter((s) => s.parentSessionId === parentA.id)).toHaveLength(1);
			expect(sessions.filter((s) => s.parentSessionId === parentB.id)).toHaveLength(
				sameParent ? 0 : 1
			);
		}
	);
});
