/**
 * Tests for useSessionRestoration hook (Phase 2E)
 *
 * Tests session restoration, migration logic, corruption recovery,
 * git info background fetching, and the session/group loading effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock gitService before any imports that use it
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn().mockResolvedValue(true),
		getBranches: vi.fn().mockResolvedValue(['main', 'feature-1']),
		getTags: vi.fn().mockResolvedValue(['v1.0', 'v2.0']),
	},
}));

// Mock generateId to produce deterministic IDs
let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

// Mock AUTO_RUN_FOLDER_NAME
vi.mock('../../../renderer/components/Wizard', () => ({
	AUTO_RUN_FOLDER_NAME: '.maestro-autorun',
}));

import { useSessionRestoration } from '../../../renderer/hooks/session/useSessionRestoration';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { gitService } from '../../../renderer/services/git';
import type { Session } from '../../../renderer/types';

// Cast to access mock methods
const mockGitService = gitService as {
	isRepo: ReturnType<typeof vi.fn>;
	getBranches: ReturnType<typeof vi.fn>;
	getTags: ReturnType<typeof vi.fn>;
};

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/projects/myapp',
		fullPath: '/projects/myapp',
		projectRoot: '/projects/myapp',
		toolType: 'claude-code' as any,
		groupId: 'group-1',
		inputMode: 'ai' as any,
		state: 'idle' as any,
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: null,
				state: 'busy' as const,
				logs: [],
				starred: false,
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
			},
		],
		activeTabId: 'tab-1',
		aiLogs: [],
		shellLogs: [{ id: 'log-1', timestamp: Date.now(), source: 'system' as const, text: 'hello' }],
		workLog: [],
		contextUsage: 0,
		aiPid: 123,
		terminalPid: 456,
		port: 3000,
		isLive: true,
		liveUrl: 'http://localhost:3000',
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		autoRunFolderPath: '/projects/myapp/.maestro-autorun',
		fileTreeAutoRefreshInterval: 180,
		executionQueue: [],
		activeTimeMs: 5000,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		busySource: 'user',
		thinkingStartTime: Date.now(),
		currentCycleTokens: 100,
		currentCycleBytes: 2000,
		statusMessage: 'Thinking...',
		agentError: { message: 'stale error' } as any,
		agentErrorPaused: true,
		...overrides,
	} as any;
}

// Mock IPC
const mockGetAll = vi.fn();
const mockGroupsGetAll = vi.fn();
const mockGroupChatList = vi.fn();
const mockAgentsGet = vi.fn();

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	idCounter = 0;

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
	} as any);

	useGroupChatStore.setState({
		groupChats: [],
	} as any);

	// Setup IPC mocks
	if (!(window as any).maestro) {
		(window as any).maestro = {};
	}
	(window as any).maestro.sessions = { getAll: mockGetAll };
	(window as any).maestro.groups = { getAll: mockGroupsGetAll };
	(window as any).maestro.groupChat = { list: mockGroupChatList };
	(window as any).maestro.agents = {
		get: mockAgentsGet.mockResolvedValue({ id: 'claude-code', name: 'Claude Code' }),
	};

	mockGetAll.mockResolvedValue([]);
	mockGroupsGetAll.mockResolvedValue([]);
	mockGroupChatList.mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// restoreSession — Migration logic
// ============================================================================

describe('restoreSession — Migration logic', () => {
	it('sets projectRoot to cwd when missing', async () => {
		const session = createMockSession({ projectRoot: undefined, cwd: '/my/path' });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.projectRoot).toBe('/my/path');
	});

	it('sets autoRunFolderPath when missing', async () => {
		const session = createMockSession({
			autoRunFolderPath: undefined,
			projectRoot: '/projects/myapp',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.autoRunFolderPath).toBe('/projects/myapp/.maestro-autorun');
	});

	it('sets fileTreeAutoRefreshInterval to 180 when missing', async () => {
		const session = createMockSession({ fileTreeAutoRefreshInterval: undefined as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.fileTreeAutoRefreshInterval).toBe(180);
	});

	it('migrates toolType terminal to claude-code', async () => {
		const session = createMockSession({ toolType: 'terminal' as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.toolType).toBe('claude-code');
	});

	it('adds warning log when migrating from terminal toolType', async () => {
		const session = createMockSession({ toolType: 'terminal' as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const activeTab = restored!.aiTabs.find((t) => t.id === restored!.activeTabId);
		const warningLog = activeTab?.logs.find((l) =>
			l.text.includes('Session migrated to use Claude Code agent')
		);
		expect(warningLog).toBeDefined();
		expect(warningLog?.source).toBe('system');
	});
});

// ============================================================================
// restoreSession — Corruption recovery
// ============================================================================

describe('restoreSession — Corruption recovery', () => {
	it('creates default tab when aiTabs is empty', async () => {
		const session = createMockSession({ aiTabs: [], activeTabId: null });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.aiTabs).toHaveLength(1);
		expect(restored!.aiTabs[0].id).toBe('mock-id-1');
		expect(restored!.activeTabId).toBe('mock-id-1');
		expect(restored!.state).toBe('error');
	});

	it('includes corruption warning log in recovered tab', async () => {
		const session = createMockSession({ aiTabs: [], activeTabId: null });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const log = restored!.aiTabs[0].logs[0];
		expect(log.text).toContain('corrupted');
		expect(log.source).toBe('system');
	});

	it('creates default tab when aiTabs is undefined', async () => {
		const session = createMockSession({ aiTabs: undefined as any, activeTabId: null });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.aiTabs).toHaveLength(1);
		expect(restored!.state).toBe('error');
	});

	it('sets up unifiedTabOrder for recovered session', async () => {
		const session = createMockSession({ aiTabs: [], activeTabId: null });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.unifiedTabOrder).toEqual([{ type: 'ai', id: 'mock-id-1' }]);
		expect(restored!.filePreviewTabs).toEqual([]);
		expect(restored!.activeFileTabId).toBeNull();
	});

	it('clears orphaned activeFileTabId when inputMode is terminal', async () => {
		const session = createMockSession({
			inputMode: 'terminal',
			activeFileTabId: 'orphaned-file-tab',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.activeFileTabId).toBeNull();
	});

	it('preserves activeFileTabId when inputMode is ai', async () => {
		const session = createMockSession({
			inputMode: 'ai',
			activeFileTabId: 'valid-file-tab',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.activeFileTabId).toBe('valid-file-tab');
	});
});

// ============================================================================
// restoreSession — Runtime state reset
// ============================================================================

describe('restoreSession — Runtime state reset', () => {
	it('resets aiPid to 0 (lazy spawn)', async () => {
		const session = createMockSession({ aiPid: 999 });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.aiPid).toBe(0);
	});

	it('resets terminalPid to 0', async () => {
		const session = createMockSession({ terminalPid: 456 });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.terminalPid).toBe(0);
	});

	it('sets state to idle', async () => {
		const session = createMockSession({ state: 'busy' as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.state).toBe('idle');
	});

	it('clears runtime-only busy state fields', async () => {
		const session = createMockSession({
			busySource: 'user',
			thinkingStartTime: 12345,
			currentCycleTokens: 100,
			currentCycleBytes: 2000,
			statusMessage: 'Working...',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.busySource).toBeUndefined();
		expect(restored!.thinkingStartTime).toBeUndefined();
		expect(restored!.currentCycleTokens).toBeUndefined();
		expect(restored!.currentCycleBytes).toBeUndefined();
		expect(restored!.statusMessage).toBeUndefined();
	});

	it('clears agent error state', async () => {
		const session = createMockSession({
			agentError: { message: 'old error' } as any,
			agentErrorPaused: true,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.agentError).toBeUndefined();
		expect(restored!.agentErrorPaused).toBe(false);
	});

	it('resets isLive and liveUrl', async () => {
		const session = createMockSession({ isLive: true, liveUrl: 'http://localhost:3000' });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.isLive).toBe(false);
		expect(restored!.liveUrl).toBeUndefined();
	});

	it('resets all tab states to idle', async () => {
		const session = createMockSession({
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: null,
					state: 'busy' as const,
					thinkingStartTime: 999,
					logs: [],
					starred: false,
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
				},
				{
					id: 'tab-2',
					agentSessionId: null,
					name: null,
					state: 'error' as const,
					thinkingStartTime: 888,
					logs: [],
					starred: false,
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
				},
			],
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.aiTabs[0].state).toBe('idle');
		expect(restored!.aiTabs[0].thinkingStartTime).toBeUndefined();
		expect(restored!.aiTabs[1].state).toBe('idle');
		expect(restored!.aiTabs[1].thinkingStartTime).toBeUndefined();
	});

	it('preserves shellLogs', async () => {
		const shellLogs = [
			{ id: 'log-1', timestamp: Date.now(), source: 'system' as const, text: 'cmd output' },
		];
		const session = createMockSession({ shellLogs });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.shellLogs).toEqual(shellLogs);
	});

	it('clears deprecated aiLogs', async () => {
		const session = createMockSession({
			aiLogs: [{ id: 'x', timestamp: 1, source: 'system' as const, text: 'old' }] as any,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.aiLogs).toEqual([]);
	});

	it('preserves activeTimeMs with fallback to 0', async () => {
		const session = createMockSession({ activeTimeMs: undefined as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.activeTimeMs).toBe(0);
	});

	it('preserves executionQueue with fallback to []', async () => {
		const session = createMockSession({ executionQueue: undefined as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.executionQueue).toEqual([]);
	});

	it('preserves filePreviewTabs with fallback to []', async () => {
		const session = createMockSession({ filePreviewTabs: undefined as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.filePreviewTabs).toEqual([]);
	});

	it('builds unifiedTabOrder from aiTabs only when terminalTabs is missing', async () => {
		const session = createMockSession({ unifiedTabOrder: undefined as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// When unifiedTabOrder is undefined and terminalTabs is missing,
		// restoration builds order from AI tabs only — no default terminal tab is created.
		expect(restored!.unifiedTabOrder).toEqual([{ type: 'ai', id: 'tab-1' }]);
		expect(restored!.terminalTabs).toHaveLength(0);
	});

	it('resets closedTabHistory to empty', async () => {
		const session = createMockSession({ closedTabHistory: [{ type: 'ai', id: 'old' }] as any });
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.closedTabHistory).toEqual([]);
	});
});

// ============================================================================
// restoreSession — Git info for local sessions
// ============================================================================

describe('restoreSession — Git info (local sessions)', () => {
	it('fetches git info synchronously for local sessions', async () => {
		const session = createMockSession({
			sshRemoteId: undefined,
			sessionSshRemoteConfig: undefined,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(mockGitService.isRepo).toHaveBeenCalledWith('/projects/myapp', undefined);
		expect(mockGitService.getBranches).toHaveBeenCalledWith('/projects/myapp', undefined);
		expect(mockGitService.getTags).toHaveBeenCalledWith('/projects/myapp', undefined);
		expect(restored!.isGitRepo).toBe(true);
		expect(restored!.gitBranches).toEqual(['main', 'feature-1']);
		expect(restored!.gitTags).toEqual(['v1.0', 'v2.0']);
		expect(restored!.gitRefsCacheTime).toBeGreaterThan(0);
	});

	it('does not fetch branches/tags when not a git repo', async () => {
		mockGitService.isRepo.mockResolvedValueOnce(false);
		const session = createMockSession({
			sshRemoteId: undefined,
			sessionSshRemoteConfig: undefined,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(mockGitService.getBranches).not.toHaveBeenCalled();
		expect(mockGitService.getTags).not.toHaveBeenCalled();
		expect(restored!.isGitRepo).toBe(false);
	});

	it('uses persisted git info for remote SSH sessions (no sync fetch)', async () => {
		const session = createMockSession({
			sshRemoteId: 'remote-1',
			isGitRepo: true,
			gitBranches: ['main'],
			gitTags: ['v1.0'],
			gitRefsCacheTime: 12345,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// Should NOT call gitService for remote sessions during restore
		expect(mockGitService.isRepo).not.toHaveBeenCalled();
		expect(restored!.isGitRepo).toBe(true);
		expect(restored!.gitBranches).toEqual(['main']);
	});

	it('uses sessionSshRemoteConfig.remoteId as fallback SSH ID', async () => {
		const session = createMockSession({
			sshRemoteId: undefined,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' } as any,
			isGitRepo: false,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// Remote session - should NOT call gitService sync
		expect(mockGitService.isRepo).not.toHaveBeenCalled();
		expect(restored!.isGitRepo).toBe(false);
	});
});

// ============================================================================
// restoreSession — Error handling
// ============================================================================

describe('restoreSession — Error handling', () => {
	it('returns error session when agent not found', async () => {
		mockAgentsGet.mockResolvedValueOnce(null);
		const session = createMockSession();
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.state).toBe('error');
		expect(restored!.aiPid).toBe(-1);
		expect(restored!.isLive).toBe(false);
	});

	it('returns error session on unexpected exception', async () => {
		mockAgentsGet.mockRejectedValueOnce(new Error('IPC failure'));
		const session = createMockSession();
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.state).toBe('error');
		expect(restored!.aiPid).toBe(-1);
	});
});

// ============================================================================
// fetchGitInfoInBackground
// ============================================================================

describe('fetchGitInfoInBackground', () => {
	it('fetches git info and updates session in store', async () => {
		const { result } = renderHook(() => useSessionRestoration());

		// Wait for mount effect to finish, then set up sessions
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', isGitRepo: false })],
		} as any);
		mockGitService.isRepo.mockClear();
		mockGitService.getBranches.mockClear();
		mockGitService.getTags.mockClear();

		await act(async () => {
			await result.current.fetchGitInfoInBackground('s1', '/remote/path', 'ssh-1');
		});

		expect(mockGitService.isRepo).toHaveBeenCalledWith('/remote/path', 'ssh-1');
		expect(mockGitService.getBranches).toHaveBeenCalledWith('/remote/path', 'ssh-1');
		expect(mockGitService.getTags).toHaveBeenCalledWith('/remote/path', 'ssh-1');

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 's1');
		expect(updated?.isGitRepo).toBe(true);
		expect(updated?.gitBranches).toEqual(['main', 'feature-1']);
		expect(updated?.gitTags).toEqual(['v1.0', 'v2.0']);
		expect(updated?.sshConnectionFailed).toBe(false);
	});

	it('marks sshConnectionFailed on error', async () => {
		const { result } = renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1' })],
		} as any);
		mockGitService.isRepo.mockRejectedValueOnce(new Error('SSH timeout'));

		await act(async () => {
			await result.current.fetchGitInfoInBackground('s1', '/remote/path', 'ssh-1');
		});

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 's1');
		expect(updated?.sshConnectionFailed).toBe(true);
	});

	it('skips branches/tags when not a git repo', async () => {
		const { result } = renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1' })],
		} as any);
		mockGitService.isRepo.mockResolvedValueOnce(false);
		mockGitService.getBranches.mockClear();
		mockGitService.getTags.mockClear();

		await act(async () => {
			await result.current.fetchGitInfoInBackground('s1', '/remote/path', 'ssh-1');
		});

		expect(mockGitService.getBranches).not.toHaveBeenCalled();
		expect(mockGitService.getTags).not.toHaveBeenCalled();

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 's1');
		expect(updated?.isGitRepo).toBe(false);
	});
});

// ============================================================================
// initialLoadComplete proxy
// ============================================================================

describe('initialLoadComplete proxy', () => {
	it('returns a ref-like object with .current', () => {
		const { result } = renderHook(() => useSessionRestoration());
		expect(result.current.initialLoadComplete).toBeDefined();
		expect(typeof result.current.initialLoadComplete.current).toBe('boolean');
	});

	it('syncs .current setter to store', () => {
		const { result } = renderHook(() => useSessionRestoration());

		act(() => {
			result.current.initialLoadComplete.current = true;
		});

		expect(useSessionStore.getState().initialLoadComplete).toBe(true);
	});

	it('reads from store on .current getter', () => {
		const { result } = renderHook(() => useSessionRestoration());

		// Set via store directly
		useSessionStore.setState({ initialLoadComplete: true } as any);

		expect(result.current.initialLoadComplete.current).toBe(true);
	});
});

// ============================================================================
// Session & Group loading effect
// ============================================================================

describe('Session & Group loading effect', () => {
	it('loads sessions from IPC on mount', async () => {
		const session = createMockSession({ id: 'loaded-1' });
		mockGetAll.mockResolvedValueOnce([session]);

		renderHook(() => useSessionRestoration());

		// Wait for async effect
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(mockGetAll).toHaveBeenCalled();
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe('loaded-1');
	});

	it('loads groups from IPC on mount', async () => {
		mockGetAll.mockResolvedValueOnce([]);
		mockGroupsGetAll.mockResolvedValueOnce([{ id: 'g1', name: 'Group 1' }]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(mockGroupsGetAll).toHaveBeenCalled();
		const groups = useSessionStore.getState().groups;
		expect(groups).toHaveLength(1);
	});

	it('loads group chats from IPC on mount', async () => {
		mockGetAll.mockResolvedValueOnce([]);
		mockGroupsGetAll.mockResolvedValueOnce([]);
		mockGroupChatList.mockResolvedValueOnce([{ id: 'gc1', name: 'Chat 1' }]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(mockGroupChatList).toHaveBeenCalled();
		const groupChats = useGroupChatStore.getState().groupChats;
		expect(groupChats).toHaveLength(1);
	});

	it('sets sessionsLoaded to true after loading', async () => {
		mockGetAll.mockResolvedValueOnce([]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().sessionsLoaded).toBe(true);
	});

	it('sets initialLoadComplete to true after loading', async () => {
		mockGetAll.mockResolvedValueOnce([]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().initialLoadComplete).toBe(true);
	});

	it('sets activeSessionId to first session when current is invalid', async () => {
		useSessionStore.setState({ activeSessionId: 'nonexistent' } as any);
		const session = createMockSession({ id: 'real-1' });
		mockGetAll.mockResolvedValueOnce([session]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().activeSessionId).toBe('real-1');
	});

	it('keeps activeSessionId when it matches a loaded session', async () => {
		useSessionStore.setState({ activeSessionId: 'loaded-1' } as any);
		const session = createMockSession({ id: 'loaded-1' });
		mockGetAll.mockResolvedValueOnce([session]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().activeSessionId).toBe('loaded-1');
	});

	it('handles IPC failure gracefully (sets empty arrays)', async () => {
		mockGetAll.mockRejectedValueOnce(new Error('IPC dead'));

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().sessions).toEqual([]);
		expect(useSessionStore.getState().groups).toEqual([]);
		expect(useSessionStore.getState().sessionsLoaded).toBe(true);
		expect(useSessionStore.getState().initialLoadComplete).toBe(true);
	});

	it('handles group chat load failure gracefully', async () => {
		mockGetAll.mockResolvedValueOnce([]);
		mockGroupsGetAll.mockResolvedValueOnce([]);
		mockGroupChatList.mockRejectedValueOnce(new Error('GC fail'));

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useGroupChatStore.getState().groupChats).toEqual([]);
		expect(useSessionStore.getState().sessionsLoaded).toBe(true);
	});

	it('restores session with terminal tabs correctly', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: 'Dev Server',
					shellType: 'zsh',
					pid: 0,
					cwd: '/projects/app',
					createdAt: Date.now(),
					state: 'idle' as const,
				},
			],
			activeTerminalTabId: 'tt-1',
			unifiedTabOrder: [
				{ type: 'ai' as const, id: 'tab-1' },
				{ type: 'terminal' as const, id: 'tt-1' },
			],
		});
		mockGetAll.mockResolvedValueOnce([session]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toHaveLength(1);
		expect(sessions[0].terminalTabs).toHaveLength(1);
		expect(sessions[0].terminalTabs[0].id).toBe('tt-1');
		expect(sessions[0].terminalTabs[0].name).toBe('Dev Server');
		expect(sessions[0].activeTerminalTabId).toBe('tt-1');
	});

	it('fires fetchGitInfoInBackground for SSH sessions after load', async () => {
		const sshSession = createMockSession({
			id: 'ssh-1',
			sshRemoteId: 'remote-1',
			cwd: '/remote/dir',
		});
		mockGetAll.mockResolvedValueOnce([sshSession]);

		// Reset so we can verify the background call
		mockGitService.isRepo.mockResolvedValue(true);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 100));
		});

		// gitService.isRepo called once for background fetch (not during sync restore for remote)
		// The first call is the background fetch
		const isRepoCalls = mockGitService.isRepo.mock.calls;
		const backgroundCall = isRepoCalls.find((c: any[]) => c[1] === 'remote-1');
		expect(backgroundCall).toBeDefined();
	});

	it('runs loading effect only once per hook instance (ref guard)', async () => {
		mockGetAll.mockResolvedValue([]);

		const { rerender } = renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		// Re-render (not unmount+remount) should not re-run the loading effect
		rerender();

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		// getAll should only have been called once
		expect(mockGetAll).toHaveBeenCalledTimes(1);
	});

	it('sets empty sessions array when no saved sessions exist', async () => {
		mockGetAll.mockResolvedValueOnce([]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('sets empty sessions array when getAll returns null', async () => {
		mockGetAll.mockResolvedValueOnce(null);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('restores multiple sessions via Promise.all', async () => {
		const s1 = createMockSession({ id: 's1', cwd: '/a' });
		const s2 = createMockSession({ id: 's2', cwd: '/b' });
		mockGetAll.mockResolvedValueOnce([s1, s2]);

		renderHook(() => useSessionRestoration());

		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toHaveLength(2);
		expect(sessions[0].id).toBe('s1');
		expect(sessions[1].id).toBe('s2');
		// Both should have state reset
		expect(sessions[0].state).toBe('idle');
		expect(sessions[1].state).toBe('idle');
	});
});

// ============================================================================
// restoreSession — Terminal tab persistence
// ============================================================================

describe('restoreSession — Terminal tab persistence', () => {
	it('preserves terminal tab metadata (name, shellType, cwd, createdAt) across restart', async () => {
		const createdAt = 1700000000000;
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: 'My Dev Server',
					shellType: 'zsh',
					pid: 12345,
					cwd: '/projects/myapp',
					createdAt,
					state: 'idle' as const,
				},
			],
			activeTerminalTabId: 'tt-1',
			unifiedTabOrder: [
				{ type: 'ai' as const, id: 'tab-1' },
				{ type: 'terminal' as const, id: 'tt-1' },
			],
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const termTab = restored!.terminalTabs.find((t) => t.id === 'tt-1');
		expect(termTab).toBeDefined();
		expect(termTab!.name).toBe('My Dev Server');
		expect(termTab!.shellType).toBe('zsh');
		expect(termTab!.cwd).toBe('/projects/myapp');
		expect(termTab!.createdAt).toBe(createdAt);
	});

	it('resets terminal tab runtime state (pid, state, exitCode) on restore', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: null,
					shellType: 'bash',
					pid: 9999,
					cwd: '/home/user',
					createdAt: Date.now(),
					state: 'busy' as const,
					exitCode: 1,
				},
			],
			activeTerminalTabId: 'tt-1',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const termTab = restored!.terminalTabs[0];
		expect(termTab.pid).toBe(0);
		expect(termTab.state).toBe('idle');
		expect(termTab.exitCode).toBeUndefined();
	});

	it('preserves activeTerminalTabId across restart', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-active',
					name: 'Active Tab',
					shellType: 'zsh',
					pid: 100,
					cwd: '/home/user',
					createdAt: Date.now(),
					state: 'idle' as const,
				},
			],
			activeTerminalTabId: 'tt-active',
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.activeTerminalTabId).toBe('tt-active');
	});

	it('sets activeTerminalTabId to null when undefined', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: null,
					shellType: 'zsh',
					pid: 0,
					cwd: '/home/user',
					createdAt: Date.now(),
					state: 'idle' as const,
				},
			],
			activeTerminalTabId: undefined,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.activeTerminalTabId).toBeNull();
	});

	it('does NOT create a default terminal tab when terminalTabs is empty', async () => {
		const session = createMockSession({
			terminalTabs: [],
			activeTerminalTabId: null,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// Terminal tabs are created on demand, not by restoration
		expect(restored!.terminalTabs).toHaveLength(0);
		expect(restored!.activeTerminalTabId).toBeNull();
	});

	it('does NOT create a default terminal tab when terminalTabs is missing (migration)', async () => {
		const session = createMockSession({
			terminalTabs: undefined as any,
			activeTerminalTabId: null,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// Migration only ensures the array exists — it does not add a default tab
		expect(restored!.terminalTabs).toHaveLength(0);
		expect(restored!.activeTerminalTabId).toBeNull();
	});

	it('preserves existing unifiedTabOrder without adding a terminal ref when migrating empty terminalTabs', async () => {
		const session = createMockSession({
			terminalTabs: [],
			activeTerminalTabId: null,
			unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		// No terminal ref should be added since no terminal tab was created
		const termRef = restored!.unifiedTabOrder.find((r) => r.type === 'terminal');
		expect(termRef).toBeUndefined();
		// AI tab should still be present
		const aiRef = restored!.unifiedTabOrder.find((r) => r.type === 'ai');
		expect(aiRef).toBeDefined();
	});

	it('resets exited terminal tab state on restore', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: null,
					shellType: 'zsh',
					pid: 200,
					cwd: '/home/user',
					createdAt: Date.now(),
					state: 'exited' as const,
					exitCode: 1,
				},
			],
			activeTerminalTabId: null,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const termTab = restored!.terminalTabs[0];
		expect(termTab.state).toBe('idle');
		expect(termTab.exitCode).toBeUndefined();
		expect(termTab.pid).toBe(0);
	});

	it('preserves multiple terminal tabs with all metadata intact', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: 'Backend',
					shellType: 'zsh',
					pid: 100,
					cwd: '/projects/backend',
					createdAt: 1000000,
					state: 'idle' as const,
				},
				{
					id: 'tt-2',
					name: 'Frontend',
					shellType: 'bash',
					pid: 200,
					cwd: '/projects/frontend',
					createdAt: 2000000,
					state: 'exited' as const,
					exitCode: 1,
				},
			],
			activeTerminalTabId: 'tt-1',
			unifiedTabOrder: [
				{ type: 'ai' as const, id: 'tab-1' },
				{ type: 'terminal' as const, id: 'tt-1' },
				{ type: 'terminal' as const, id: 'tt-2' },
			],
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		expect(restored!.terminalTabs).toHaveLength(2);

		const tab1 = restored!.terminalTabs.find((t) => t.id === 'tt-1');
		expect(tab1!.name).toBe('Backend');
		expect(tab1!.cwd).toBe('/projects/backend');
		expect(tab1!.pid).toBe(0); // Runtime state reset

		const tab2 = restored!.terminalTabs.find((t) => t.id === 'tt-2');
		expect(tab2!.name).toBe('Frontend');
		expect(tab2!.state).toBe('idle'); // Runtime state reset
		expect(tab2!.exitCode).toBeUndefined(); // Runtime state reset
	});

	it('preserves scrollTop and searchQuery on terminal tabs', async () => {
		const session = createMockSession({
			terminalTabs: [
				{
					id: 'tt-1',
					name: null,
					shellType: 'zsh',
					pid: 0,
					cwd: '/home/user',
					createdAt: Date.now(),
					state: 'idle' as const,
					scrollTop: 2000,
					searchQuery: 'webpack',
				},
			],
			activeTerminalTabId: null,
		});
		const { result } = renderHook(() => useSessionRestoration());

		let restored: Session;
		await act(async () => {
			restored = await result.current.restoreSession(session);
		});

		const termTab = restored!.terminalTabs[0];
		expect(termTab.scrollTop).toBe(2000);
		expect(termTab.searchQuery).toBe('webpack');
	});
});
