/**
 * Tests for useSessionLifecycle hook (Phase 2H)
 *
 * Tests session operation callbacks and session-level effects:
 *   - handleSaveEditAgent: persist agent config changes
 *   - handleRenameTab: rename tab with multi-agent persistence
 *   - performDeleteSession: multi-step session deletion with cleanup
 *   - showConfirmation: modal coordination helper
 *   - toggleTabStar / toggleTabUnread / toggleUnreadFilter: tab state toggles
 *   - Groups persistence effect
 *   - Navigation history tracking effect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const mockPushNavigation = vi.fn();

import {
	useSessionLifecycle,
	type SessionLifecycleDeps,
} from '../../../renderer/hooks/session/useSessionLifecycle';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Session, AITab } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle' as const,
		hasUnread: false,
		isAtBottom: true,
		...overrides,
	} as AITab;
}

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
		aiTabs: [createMockAITab()],
		activeTabId: 'tab-1',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
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
	} as Session;
}

// ============================================================================
// Default deps
// ============================================================================

const mockFlushSessionPersistence = vi.fn();
const mockSetRemovedWorktreePaths = vi.fn();

function createDeps(overrides: Partial<SessionLifecycleDeps> = {}): SessionLifecycleDeps {
	return {
		flushSessionPersistence: mockFlushSessionPersistence,
		setRemovedWorktreePaths: mockSetRemovedWorktreePaths,
		pushNavigation: mockPushNavigation,
		...overrides,
	};
}

// ============================================================================
// Setup & Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();

	// Reset stores
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		groups: [],
	});

	useModalStore.setState({ modals: new Map() });

	useUIStore.setState({
		showUnreadOnly: false,
		preFilterActiveTabId: null,
	});

	// Mock window.maestro APIs
	(window as any).maestro = {
		process: {
			kill: vi.fn().mockResolvedValue(undefined),
		},
		stats: {
			recordSessionClosed: vi.fn(),
		},
		playbooks: {
			deleteAll: vi.fn().mockResolvedValue(undefined),
		},
		shell: {
			trashItem: vi.fn().mockResolvedValue(undefined),
		},
		logger: {
			log: vi.fn(),
		},
		claude: {
			updateSessionName: vi.fn().mockResolvedValue(undefined),
			updateSessionStarred: vi.fn().mockResolvedValue(undefined),
		},
		agentSessions: {
			setSessionName: vi.fn().mockResolvedValue(undefined),
			setSessionStarred: vi.fn().mockResolvedValue(undefined),
		},
		history: {
			updateSessionName: vi.fn().mockResolvedValue(undefined),
		},
		groups: {
			setAll: vi.fn(),
		},
	};
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('useSessionLifecycle', () => {
	// ======================================================================
	// handleSaveEditAgent
	// ======================================================================

	describe('handleSaveEditAgent', () => {
		it('updates session with all agent configuration fields', () => {
			const session = createMockSession({ id: 'session-1', name: 'Old Name' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent(
					'session-1',
					'New Name',
					undefined, // toolType unchanged
					'nudge msg',
					'/custom/path',
					'--arg1',
					{ MY_VAR: 'value' },
					'gpt-4',
					8000,
					{ enabled: true, remoteId: 'remote-1', workingDirOverride: '/remote' }
				);
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.name).toBe('New Name');
			expect(updated.nudgeMessage).toBe('nudge msg');
			expect(updated.customPath).toBe('/custom/path');
			expect(updated.customArgs).toBe('--arg1');
			expect(updated.customEnvVars).toEqual({ MY_VAR: 'value' });
			expect(updated.customModel).toBe('gpt-4');
			expect(updated.customContextWindow).toBe(8000);
			expect(updated.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote',
			});
		});

		it('only modifies the targeted session', () => {
			const session1 = createMockSession({ id: 'session-1', name: 'Session 1' });
			const session2 = createMockSession({ id: 'session-2', name: 'Session 2' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent('session-2', 'Updated Session 2');
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].name).toBe('Session 1');
			expect(sessions[1].name).toBe('Updated Session 2');
		});

		it('sets optional fields to undefined when not provided', () => {
			const session = createMockSession({
				id: 'session-1',
				nudgeMessage: 'old nudge',
				customPath: '/old/path',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent('session-1', 'Name Only');
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.name).toBe('Name Only');
			expect(updated.nudgeMessage).toBeUndefined();
			expect(updated.customPath).toBeUndefined();
		});

		it('resets tabs and provider-specific config when toolType changes', () => {
			const tab = createMockAITab({ id: 'old-tab', agentSessionId: 'old-session' });
			const session = createMockSession({
				id: 'session-1',
				name: 'My Agent',
				toolType: 'claude-code' as any,
				aiTabs: [tab],
				activeTabId: 'old-tab',
				customPath: '/old/claude/path',
				customArgs: '--old-args',
				customEnvVars: { OLD_KEY: 'old' },
				customModel: 'sonnet',
				customContextWindow: 200000,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent(
					'session-1',
					'My Agent',
					'opencode' as any, // Change provider
				);
			});

			const updated = useSessionStore.getState().sessions[0];
			// Provider changed
			expect(updated.toolType).toBe('opencode');
			// Tabs reset to a single fresh tab
			expect(updated.aiTabs).toHaveLength(1);
			expect(updated.aiTabs[0].agentSessionId).toBeNull();
			expect(updated.aiTabs[0].logs).toEqual([]);
			expect(updated.activeTabId).toBe(updated.aiTabs[0].id);
			expect(updated.activeTabId).not.toBe('old-tab');
			// Provider-specific config cleared
			expect(updated.customPath).toBeUndefined();
			expect(updated.customArgs).toBeUndefined();
			expect(updated.customEnvVars).toBeUndefined();
			expect(updated.customModel).toBeUndefined();
			expect(updated.customContextWindow).toBeUndefined();
			// File preview tabs reset
			expect(updated.filePreviewTabs).toEqual([]);
			expect(updated.activeFileTabId).toBeNull();
			// Unified tab order reset to single entry
			expect(updated.unifiedTabOrder).toHaveLength(1);
			expect(updated.unifiedTabOrder[0]).toEqual({ type: 'ai', id: updated.aiTabs[0].id });
			// Runtime state reset
			expect(updated.state).toBe('idle');
			expect(updated.aiPid).toBe(0);
			// Existing AI process killed
			expect((window as any).maestro.process.kill).toHaveBeenCalledWith('session-1-ai');
		});

		it('does not reset tabs when toolType is same as current', () => {
			const tab = createMockAITab({ id: 'my-tab', agentSessionId: 'my-session' });
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code' as any,
				aiTabs: [tab],
				activeTabId: 'my-tab',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent(
					'session-1',
					'Same Provider',
					'claude-code' as any, // Same provider
				);
			});

			const updated = useSessionStore.getState().sessions[0];
			// Tabs should NOT be reset
			expect(updated.aiTabs).toHaveLength(1);
			expect(updated.aiTabs[0].id).toBe('my-tab');
			expect(updated.activeTabId).toBe('my-tab');
			// Process should NOT be killed
			expect((window as any).maestro.process.kill).not.toHaveBeenCalled();
		});

		it('preserves session identity fields when changing provider', () => {
			const session = createMockSession({
				id: 'session-1',
				name: 'My Agent',
				toolType: 'claude-code' as any,
				projectRoot: '/projects/myapp',
				cwd: '/projects/myapp',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent(
					'session-1',
					'My Agent',
					'codex' as any,
				);
			});

			const updated = useSessionStore.getState().sessions[0];
			// Identity fields preserved
			expect(updated.id).toBe('session-1');
			expect(updated.name).toBe('My Agent');
			expect(updated.projectRoot).toBe('/projects/myapp');
			expect(updated.cwd).toBe('/projects/myapp');
			// Provider changed
			expect(updated.toolType).toBe('codex');
		});
	});

	// ======================================================================
	// handleRenameTab
	// ======================================================================

	describe('handleRenameTab', () => {
		it('renames tab and persists to claude session storage', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-123', name: 'Old' });
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: 'Old' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('New Tab Name');
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.name).toBe('New Tab Name');
			expect(updated.isGeneratingName).toBe(false);
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/projects/myapp',
				'agent-123',
				'New Tab Name'
			);
			expect(window.maestro.history.updateSessionName).toHaveBeenCalledWith(
				'agent-123',
				'New Tab Name'
			);
		});

		it('persists to agentSessions for non-claude agents', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-456' });
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Codex Tab');
			});

			expect(window.maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
				'codex',
				'/projects/myapp',
				'agent-456',
				'Codex Tab'
			);
			expect(window.maestro.claude.updateSessionName).not.toHaveBeenCalled();
		});

		it('logs rename with context via logger', () => {
			const tab = createMockAITab({ id: 'tab-1', name: 'Old Name', agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: 'Old Name' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('New Name');
			});

			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'info',
				expect.stringContaining('Old Name'),
				'TabNaming',
				expect.objectContaining({
					tabId: 'tab-1',
					sessionId: 'session-1',
					oldName: 'Old Name',
					newName: 'New Name',
				})
			);
		});

		it('logs skip-persistence message when tab has no agentSessionId', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: null });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Named');
			});

			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'info',
				expect.stringContaining('skipping persistence'),
				'TabNaming',
				expect.objectContaining({ tabId: 'tab-1' })
			);
			expect(window.maestro.claude.updateSessionName).not.toHaveBeenCalled();
		});

		it('sets name to null when empty string is provided', () => {
			const tab = createMockAITab({ id: 'tab-1', name: 'Some Name', agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: 'Some Name' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('');
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.name).toBeNull();
		});

		it('returns early if no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Test');
			});

			expect(window.maestro.logger.log).not.toHaveBeenCalled();
		});

		it('returns early if no renameTabId', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			// Don't set renameTab modal data

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Test');
			});

			expect(window.maestro.logger.log).not.toHaveBeenCalled();
		});
	});

	// ======================================================================
	// performDeleteSession
	// ======================================================================

	describe('performDeleteSession', () => {
		it('records session closure in stats before cleanup', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(window.maestro.stats.recordSessionClosed).toHaveBeenCalledWith(
				'session-1',
				expect.any(Number)
			);
		});

		it('kills both AI and terminal processes', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(window.maestro.process.kill).toHaveBeenCalledWith('session-1-ai');
			expect(window.maestro.process.kill).toHaveBeenCalledWith('session-1-terminal');
		});

		it('deletes all associated playbooks', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(window.maestro.playbooks.deleteAll).toHaveBeenCalledWith('session-1');
		});

		it('removes session from store and activates next session', async () => {
			const session1 = createMockSession({ id: 'session-1' });
			const session2 = createMockSession({ id: 'session-2' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session1, false);
			});

			const state = useSessionStore.getState();
			expect(state.sessions).toHaveLength(1);
			expect(state.sessions[0].id).toBe('session-2');
			expect(state.activeSessionId).toBe('session-2');
		});

		it('clears activeSessionId when last session is deleted', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			const state = useSessionStore.getState();
			expect(state.sessions).toHaveLength(0);
			expect(state.activeSessionId).toBe('');
		});

		it('flushes session persistence immediately via setTimeout', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(mockFlushSessionPersistence).not.toHaveBeenCalled();

			act(() => {
				vi.runAllTimers();
			});

			expect(mockFlushSessionPersistence).toHaveBeenCalledOnce();
		});

		it('tracks worktree path to prevent re-discovery', async () => {
			const session = createMockSession({
				id: 'session-1',
				cwd: '/worktrees/my-branch',
				worktreeParentPath: '/repo/.git/worktrees',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(mockSetRemovedWorktreePaths).toHaveBeenCalled();
			// Verify the setter is called with a function that adds the cwd
			const setterFn = mockSetRemovedWorktreePaths.mock.calls[0][0];
			const result2 = setterFn(new Set());
			expect(result2.has('/worktrees/my-branch')).toBe(true);
		});

		it('does not track worktree path when session is not a worktree', async () => {
			const session = createMockSession({ id: 'session-1', cwd: '/normal/path' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(mockSetRemovedWorktreePaths).not.toHaveBeenCalled();
		});

		it('trashes working directory when eraseWorkingDirectory is true', async () => {
			const session = createMockSession({ id: 'session-1', cwd: '/projects/myapp' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, true);
			});

			expect(window.maestro.shell.trashItem).toHaveBeenCalledWith('/projects/myapp');
		});

		it('does not trash working directory when eraseWorkingDirectory is false', async () => {
			const session = createMockSession({ id: 'session-1', cwd: '/projects/myapp' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			expect(window.maestro.shell.trashItem).not.toHaveBeenCalled();
		});

		it('continues cleanup even if process kill fails', async () => {
			(window.maestro.process.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Process not found')
			);
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			// Should still have removed the session
			expect(useSessionStore.getState().sessions).toHaveLength(0);
			expect(window.maestro.playbooks.deleteAll).toHaveBeenCalled();
		});

		it('shows error toast if trashItem fails', async () => {
			(window.maestro.shell.trashItem as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Permission denied')
			);
			const session = createMockSession({ id: 'session-1', cwd: '/projects/myapp' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, true);
			});

			// Session should still be removed even though trash failed
			expect(useSessionStore.getState().sessions).toHaveLength(0);
		});
	});

	// ======================================================================
	// showConfirmation
	// ======================================================================

	describe('showConfirmation', () => {
		it('opens confirm modal with message and callback', () => {
			const { result } = renderHook(() => useSessionLifecycle(createDeps()));
			const onConfirm = vi.fn();

			act(() => {
				result.current.showConfirmation('Delete session?', onConfirm);
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
			const data = useModalStore.getState().getData('confirm');
			expect(data?.message).toBe('Delete session?');
			expect(data?.onConfirm).toBe(onConfirm);
		});
	});

	// ======================================================================
	// toggleTabStar
	// ======================================================================

	describe('toggleTabStar', () => {
		it('toggles starred from false to true and persists for claude-code', () => {
			const tab = createMockAITab({ id: 'tab-1', starred: false, agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.starred).toBe(true);
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/projects/myapp',
				'ag-1',
				true
			);
		});

		it('toggles starred from true to false', () => {
			const tab = createMockAITab({ id: 'tab-1', starred: true, agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.starred).toBe(false);
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/projects/myapp',
				'ag-1',
				false
			);
		});

		it('persists via agentSessions for non-claude agents', () => {
			const tab = createMockAITab({ id: 'tab-1', starred: false, agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
				'codex',
				'/projects/myapp',
				'ag-1',
				true
			);
			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
		});

		it('skips persistence when tab has no agentSessionId', () => {
			const tab = createMockAITab({ id: 'tab-1', starred: false, agentSessionId: null });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.starred).toBe(true);
			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
			expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		});

		it('returns early if no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
		});

		it('returns early if no active tab', () => {
			const session = createMockSession({ id: 'session-1', aiTabs: [], activeTabId: '' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
		});
	});

	// ======================================================================
	// toggleTabUnread
	// ======================================================================

	describe('toggleTabUnread', () => {
		it('toggles hasUnread from false to true', () => {
			const tab = createMockAITab({ id: 'tab-1', hasUnread: false });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabUnread();
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.hasUnread).toBe(true);
		});

		it('toggles hasUnread from true to false', () => {
			const tab = createMockAITab({ id: 'tab-1', hasUnread: true });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabUnread();
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.hasUnread).toBe(false);
		});

		it('returns early if no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			const sessionsBefore = useSessionStore.getState().sessions;

			act(() => {
				result.current.toggleTabUnread();
			});

			expect(useSessionStore.getState().sessions).toEqual(sessionsBefore);
		});

		it('only affects the targeted tab, leaves others unchanged', () => {
			const tab1 = createMockAITab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockAITab({ id: 'tab-2', hasUnread: true });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabUnread();
			});

			const tabs = useSessionStore.getState().sessions[0].aiTabs;
			expect(tabs[0].hasUnread).toBe(true); // toggled
			expect(tabs[1].hasUnread).toBe(true); // unchanged
		});
	});

	// ======================================================================
	// toggleUnreadFilter
	// ======================================================================

	describe('toggleUnreadFilter', () => {
		it('saves active tab and enables filter when entering filter mode', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useUIStore.setState({ showUnreadOnly: false, preFilterActiveTabId: null });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			expect(useUIStore.getState().showUnreadOnly).toBe(true);
			expect(useUIStore.getState().preFilterActiveTabId).toBe('tab-1');
		});

		it('restores previous active tab when exiting filter mode', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2', // currently on tab-2
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useUIStore.setState({ showUnreadOnly: true, preFilterActiveTabId: 'tab-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			expect(useUIStore.getState().showUnreadOnly).toBe(false);
			expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
			// Should restore to tab-1 (the pre-filter tab)
			expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-1');
		});

		it('does not restore tab if pre-filter tab no longer exists', () => {
			const tab2 = createMockAITab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab2], // tab-1 no longer exists
				activeTabId: 'tab-2',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useUIStore.setState({ showUnreadOnly: true, preFilterActiveTabId: 'tab-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			expect(useUIStore.getState().showUnreadOnly).toBe(false);
			// activeTabId should remain tab-2 (not restored to missing tab-1)
			expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-2');
		});

		it('handles toggling when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			useUIStore.setState({ showUnreadOnly: false, preFilterActiveTabId: null });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			// Should still toggle the filter even without a session
			expect(useUIStore.getState().showUnreadOnly).toBe(true);
		});
	});

	// ======================================================================
	// Effects: Groups persistence
	// ======================================================================

	describe('groups persistence effect', () => {
		it('persists groups when initialLoadComplete is true', () => {
			const groups = [{ id: 'g1', name: 'Group 1', emoji: '', collapsed: false }];
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
				groups,
				initialLoadComplete: true,
			});

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(window.maestro.groups.setAll).toHaveBeenCalledWith(groups);
		});

		it('does not persist groups before initialLoadComplete', () => {
			const groups = [{ id: 'g1', name: 'Group 1', emoji: '', collapsed: false }];
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
				groups,
				initialLoadComplete: false,
			});

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(window.maestro.groups.setAll).not.toHaveBeenCalled();
		});

		it('re-persists when groups change', () => {
			const groups1 = [{ id: 'g1', name: 'Group 1', emoji: '', collapsed: false }];
			useSessionStore.setState({
				sessions: [],
				activeSessionId: '',
				groups: groups1,
				initialLoadComplete: true,
			});

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(window.maestro.groups.setAll).toHaveBeenCalledWith(groups1);

			const groups2 = [
				{ id: 'g1', name: 'Group 1', emoji: '', collapsed: false },
				{ id: 'g2', name: 'Group 2', emoji: '', collapsed: false },
			];

			act(() => {
				useSessionStore.setState({ groups: groups2 });
			});

			expect(window.maestro.groups.setAll).toHaveBeenCalledWith(groups2);
		});
	});

	// ======================================================================
	// Effects: Navigation history tracking
	// ======================================================================

	describe('navigation history tracking effect', () => {
		it('pushes navigation entry when active session exists', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(mockPushNavigation).toHaveBeenCalledWith({
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('does not include tabId when session is in terminal mode', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal' as any,
				aiTabs: [],
				activeTabId: '',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(mockPushNavigation).toHaveBeenCalledWith({
				sessionId: 'session-1',
				tabId: undefined,
			});
		});

		it('does not push navigation when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(mockPushNavigation).not.toHaveBeenCalled();
		});

		it('pushes new entry when active tab changes', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai' as any,
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { rerender } = renderHook(() => useSessionLifecycle(createDeps()));

			mockPushNavigation.mockClear();

			act(() => {
				useSessionStore
					.getState()
					.setSessions((prev) =>
						prev.map((s) => (s.id === 'session-1' ? { ...s, activeTabId: 'tab-2' } : s))
					);
			});

			rerender();

			expect(mockPushNavigation).toHaveBeenCalledWith({
				sessionId: 'session-1',
				tabId: 'tab-2',
			});
		});
	});

	// ======================================================================
	// Return value stability
	// ======================================================================

	describe('return value', () => {
		it('returns all expected callbacks', () => {
			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			expect(result.current.handleSaveEditAgent).toBeTypeOf('function');
			expect(result.current.handleRenameTab).toBeTypeOf('function');
			expect(result.current.performDeleteSession).toBeTypeOf('function');
			expect(result.current.showConfirmation).toBeTypeOf('function');
			expect(result.current.toggleTabStar).toBeTypeOf('function');
			expect(result.current.toggleTabUnread).toBeTypeOf('function');
			expect(result.current.toggleUnreadFilter).toBeTypeOf('function');
		});
	});

	// ======================================================================
	// handleSaveEditAgent edge cases
	// ======================================================================

	describe('handleSaveEditAgent edge cases', () => {
		it('does not modify sessions when sessionId does not match any session', () => {
			const session = createMockSession({ id: 'session-1', name: 'Original' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent('non-existent-id', 'New Name');
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(1);
			expect(sessions[0].name).toBe('Original');
		});

		it('updates session name to empty string when provided', () => {
			const session = createMockSession({ id: 'session-1', name: 'Old Name' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleSaveEditAgent('session-1', '');
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.name).toBe('');
		});
	});

	// ======================================================================
	// handleRenameTab edge cases
	// ======================================================================

	describe('handleRenameTab edge cases', () => {
		it('still updates session when renameTabId does not match any tab in aiTabs', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'ag-1', name: 'Tab 1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			// Set renameTabId to a tab that doesn't exist in the session
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-999', initialName: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('New Name');
			});

			// The tab with id tab-1 should remain unchanged (renameTabId=tab-999 doesn't match)
			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.name).toBe('Tab 1');
			// Logger should still be called with undefined tab fields
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'info',
				expect.any(String),
				'TabNaming',
				expect.objectContaining({
					tabId: 'tab-999',
					sessionId: 'session-1',
				})
			);
		});

		it('clears isGeneratingName when renaming a tab that has isGeneratingName=true', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'ag-1',
				name: 'Auto Name',
				isGeneratingName: true,
			} as any);
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: 'Auto Name' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Manual Name');
			});

			const updated = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updated.name).toBe('Manual Name');
			expect(updated.isGeneratingName).toBe(false);
		});

		it('uses claude-code persistence path when toolType is undefined', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				toolType: undefined as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useModalStore.getState().openModal('renameTab', { tabId: 'tab-1', initialName: '' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.handleRenameTab('Renamed');
			});

			// Should fall back to claude-code path when toolType is falsy
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/projects/myapp',
				'ag-1',
				'Renamed'
			);
			expect(window.maestro.agentSessions.setSessionName).not.toHaveBeenCalled();
		});
	});

	// ======================================================================
	// performDeleteSession edge cases
	// ======================================================================

	describe('performDeleteSession edge cases', () => {
		it('continues cleanup when playbooks.deleteAll throws an error', async () => {
			(window.maestro.playbooks.deleteAll as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Storage error')
			);
			const session = createMockSession({ id: 'session-1', cwd: '/projects/myapp' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			// Session should still be removed despite playbook deletion failure
			expect(useSessionStore.getState().sessions).toHaveLength(0);
			expect(useSessionStore.getState().activeSessionId).toBe('');
		});

		it('does not trash when session has no cwd', async () => {
			const session = createMockSession({
				id: 'session-1',
				cwd: '' as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, true);
			});

			// eraseWorkingDirectory is true but cwd is empty, so trashItem should not be called
			expect(window.maestro.shell.trashItem).not.toHaveBeenCalled();
			// Session should still be removed
			expect(useSessionStore.getState().sessions).toHaveLength(0);
		});

		it('activates first session when deleting the middle session from three sessions', async () => {
			const session1 = createMockSession({ id: 'session-1', name: 'First' });
			const session2 = createMockSession({ id: 'session-2', name: 'Middle' });
			const session3 = createMockSession({ id: 'session-3', name: 'Last' });
			useSessionStore.setState({
				sessions: [session1, session2, session3],
				activeSessionId: 'session-2',
			});

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session2, false);
			});

			const state = useSessionStore.getState();
			expect(state.sessions).toHaveLength(2);
			expect(state.sessions[0].id).toBe('session-1');
			expect(state.sessions[1].id).toBe('session-3');
			// First remaining session becomes active
			expect(state.activeSessionId).toBe('session-1');
		});

		it('still deletes playbooks and removes session when both process kills fail', async () => {
			(window.maestro.process.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Process not found')
			);
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			await act(async () => {
				await result.current.performDeleteSession(session, false);
			});

			// Both kills failed, but cleanup should continue
			expect(window.maestro.process.kill).toHaveBeenCalledTimes(2);
			expect(window.maestro.playbooks.deleteAll).toHaveBeenCalledWith('session-1');
			expect(useSessionStore.getState().sessions).toHaveLength(0);
		});
	});

	// ======================================================================
	// toggleTabStar edge cases
	// ======================================================================

	describe('toggleTabStar edge cases', () => {
		it('only toggles the active tab when session has multiple tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1', starred: false, agentSessionId: 'ag-1' });
			const tab2 = createMockAITab({ id: 'tab-2', starred: false, agentSessionId: 'ag-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			const tabs = useSessionStore.getState().sessions[0].aiTabs;
			expect(tabs[0].starred).toBe(true); // active tab toggled
			expect(tabs[1].starred).toBe(false); // other tab unchanged
		});

		it('uses claude-code persistence fallback when toolType is undefined', () => {
			const tab = createMockAITab({ id: 'tab-1', starred: false, agentSessionId: 'ag-1' });
			const session = createMockSession({
				id: 'session-1',
				toolType: undefined as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleTabStar();
			});

			// Should fall back to claude-code path when toolType is falsy
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/projects/myapp',
				'ag-1',
				true
			);
			expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		});
	});

	// ======================================================================
	// toggleTabUnread edge cases
	// ======================================================================

	describe('toggleTabUnread edge cases', () => {
		it('returns early if session has no tabs (no active tab)', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [],
				activeTabId: '',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			const sessionsBefore = useSessionStore.getState().sessions;

			act(() => {
				result.current.toggleTabUnread();
			});

			// Sessions should be unchanged (no update applied)
			expect(useSessionStore.getState().sessions[0].aiTabs).toEqual(sessionsBefore[0].aiTabs);
		});
	});

	// ======================================================================
	// toggleUnreadFilter edge cases
	// ======================================================================

	describe('toggleUnreadFilter edge cases', () => {
		it('saves null as preFilterActiveTabId when entering filter mode with no activeTabId', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [],
				activeTabId: '',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useUIStore.setState({ showUnreadOnly: false, preFilterActiveTabId: null });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			expect(useUIStore.getState().showUnreadOnly).toBe(true);
			// Empty string activeTabId is falsy, so `session?.activeTabId || null` resolves to null
			expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
		});

		it('clears filter and does not restore tab when preFilterActiveTabId is null on exit', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useUIStore.setState({ showUnreadOnly: true, preFilterActiveTabId: null });

			const { result } = renderHook(() => useSessionLifecycle(createDeps()));

			act(() => {
				result.current.toggleUnreadFilter();
			});

			expect(useUIStore.getState().showUnreadOnly).toBe(false);
			// activeTabId should remain unchanged since preFilterActiveTabId was null
			expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-1');
		});
	});

	// ======================================================================
	// Navigation history edge cases
	// ======================================================================

	describe('navigation history edge cases', () => {
		it('tracks tabId as undefined when session has aiTabs but inputMode is terminal', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal' as any,
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useSessionLifecycle(createDeps()));

			expect(mockPushNavigation).toHaveBeenCalledWith({
				sessionId: 'session-1',
				tabId: undefined,
			});
		});
	});
});
