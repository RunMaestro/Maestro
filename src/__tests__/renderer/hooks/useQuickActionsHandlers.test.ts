/**
 * Tests for useQuickActionsHandlers hook
 *
 * Tests:
 *   - handleQuickActionsToggleReadOnlyMode: toggles readOnlyMode on active AI tab, no-op in terminal mode, no-op with no active tab
 *   - handleQuickActionsToggleTabShowThinking: cycles off→on→sticky→off, clears thinking/tool logs on off, no-op in terminal mode, no-op with no active tab
 *   - handleQuickActionsRefreshGitFileState: calls refreshGitFileState, calls mainPanelRef.refreshGitInfo, sets and clears flash notification
 *   - handleQuickActionsDebugReleaseQueuedItem: removes first item from queue and calls processQueuedItem, no-op with empty queue, no-op with no active session
 *   - handleQuickActionsToggleMarkdownEditMode: toggles markdownEditMode when file tab active, toggles chatRawTextMode when no file tab
 *   - handleQuickActionsSummarizeAndContinue: delegates to handleSummarizeAndContinue
 *   - handleQuickActionsAutoRunResetTasks: calls rightPanelRef.openAutoRunResetTasksModal
 *   - Return type completeness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, AITab } from '../../../renderer/types';
import { useQuickActionsHandlers } from '../../../renderer/hooks/modal/useQuickActionsHandlers';
import type { UseQuickActionsHandlersDeps } from '../../../renderer/hooks/modal/useQuickActionsHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

// ============================================================================
// Helpers
// ============================================================================

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: false,
		showThinking: 'off',
		readOnlyMode: false,
		...overrides,
	} as AITab;
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();
	return {
		id: 'sess-1',
		name: 'Test Session',
		toolType: 'claude-code' as any,
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/test/project',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tab.id }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/test/project/Auto Run Docs',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function createDeps(
	overrides: Partial<UseQuickActionsHandlersDeps> = {}
): UseQuickActionsHandlersDeps {
	return {
		refreshGitFileState: vi.fn().mockResolvedValue(undefined),
		mainPanelRef: { current: { refreshGitInfo: vi.fn().mockResolvedValue(undefined) } as any },
		rightPanelRef: { current: { openAutoRunResetTasksModal: vi.fn() } as any },
		handleSummarizeAndContinue: vi.fn(),
		processQueuedItem: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
	});

	useSettingsStore.setState({
		markdownEditMode: false,
		chatRawTextMode: false,
	} as any);

	useUIStore.setState({
		successFlashNotification: null,
	} as any);
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useQuickActionsHandlers', () => {
	// ========================================================================
	// handleQuickActionsToggleReadOnlyMode
	// ========================================================================
	describe('handleQuickActionsToggleReadOnlyMode', () => {
		it('toggles readOnlyMode from false to true on the active AI tab', () => {
			const tab = createTab({ id: 'tab-1', readOnlyMode: false });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.readOnlyMode).toBe(true);
		});

		it('toggles readOnlyMode from true to false on the active AI tab', () => {
			const tab = createTab({ id: 'tab-1', readOnlyMode: true });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.readOnlyMode).toBe(false);
		});

		it('only modifies the active tab, not other tabs in the same session', () => {
			const activeTab = createTab({ id: 'tab-active', readOnlyMode: false });
			const otherTab = createTab({ id: 'tab-other', readOnlyMode: false });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-active',
				aiTabs: [activeTab, otherTab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActiveTab = sessions[0].aiTabs.find((t: AITab) => t.id === 'tab-active');
			const updatedOtherTab = sessions[0].aiTabs.find((t: AITab) => t.id === 'tab-other');
			expect(updatedActiveTab?.readOnlyMode).toBe(true);
			expect(updatedOtherTab?.readOnlyMode).toBe(false);
		});

		it('is a no-op when inputMode is terminal', () => {
			const tab = createTab({ id: 'tab-1', readOnlyMode: false });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'terminal',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.readOnlyMode).toBe(false);
		});

		it('is a no-op when there is no active tab (activeTabId is null)', () => {
			const tab = createTab({ id: 'tab-1', readOnlyMode: false });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: null as any,
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.readOnlyMode).toBe(false);
		});

		it('is a no-op when no active session exists', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			// Should not throw
			expect(() => {
				act(() => {
					result.current.handleQuickActionsToggleReadOnlyMode();
				});
			}).not.toThrow();
		});

		it('does not modify other sessions', () => {
			const tab1 = createTab({ id: 'tab-a', readOnlyMode: false });
			const tab2 = createTab({ id: 'tab-b', readOnlyMode: false });
			const activeSession = createSession({
				id: 'sess-active',
				inputMode: 'ai',
				activeTabId: 'tab-a',
				aiTabs: [tab1],
			});
			const otherSession = createSession({
				id: 'sess-other',
				inputMode: 'ai',
				activeTabId: 'tab-b',
				aiTabs: [tab2],
			});
			useSessionStore.setState({
				sessions: [activeSession, otherSession],
				activeSessionId: 'sess-active',
			});

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleReadOnlyMode();
			});

			const sessions = useSessionStore.getState().sessions;
			// Active session tab toggled
			expect(sessions[0].aiTabs[0].readOnlyMode).toBe(true);
			// Other session untouched
			expect(sessions[1].aiTabs[0].readOnlyMode).toBe(false);
		});
	});

	// ========================================================================
	// handleQuickActionsToggleTabShowThinking
	// ========================================================================
	describe('handleQuickActionsToggleTabShowThinking', () => {
		it('cycles thinking mode from off to on', () => {
			const tab = createTab({ id: 'tab-1', showThinking: 'off' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('on');
		});

		it('cycles thinking mode from on to sticky', () => {
			const tab = createTab({ id: 'tab-1', showThinking: 'on' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('sticky');
		});

		it('cycles thinking mode from sticky to off', () => {
			const tab = createTab({ id: 'tab-1', showThinking: 'sticky' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('off');
		});

		it('treats undefined showThinking the same as off (undefined → on)', () => {
			const tab = createTab({ id: 'tab-1' });
			(tab as any).showThinking = undefined;
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('on');
		});

		it('clears thinking and tool logs when cycling to off', () => {
			const tab = createTab({
				id: 'tab-1',
				showThinking: 'sticky',
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'user', text: 'Hello' } as any,
					{ id: 'log-2', timestamp: 2, source: 'thinking', text: 'Hmm...' } as any,
					{ id: 'log-3', timestamp: 3, source: 'tool', text: 'Running tool' } as any,
					{ id: 'log-4', timestamp: 4, source: 'ai', text: 'Response' } as any,
				],
			});
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const sources = updatedTab.logs.map((l: any) => l.source);
			expect(sources).not.toContain('thinking');
			expect(sources).not.toContain('tool');
			expect(sources).toContain('user');
			expect(sources).toContain('ai');
		});

		it('does not clear logs when cycling to on', () => {
			const tab = createTab({
				id: 'tab-1',
				showThinking: 'off',
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'user', text: 'Hello' } as any,
					{ id: 'log-2', timestamp: 2, source: 'ai', text: 'Response' } as any,
				],
			});
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.logs).toHaveLength(2);
		});

		it('does not clear logs when cycling to sticky', () => {
			const tab = createTab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'thinking', text: 'Thinking...' } as any,
					{ id: 'log-2', timestamp: 2, source: 'ai', text: 'Response' } as any,
				],
			});
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.logs).toHaveLength(2);
			expect(updatedTab.showThinking).toBe('sticky');
		});

		it('is a no-op when inputMode is terminal', () => {
			const tab = createTab({ id: 'tab-1', showThinking: 'off' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'terminal',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('off');
		});

		it('is a no-op when there is no active tab (activeTabId is null)', () => {
			const tab = createTab({ id: 'tab-1', showThinking: 'off' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: null as any,
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(updatedTab.showThinking).toBe('off');
		});

		it('is a no-op when no active session exists', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			expect(() => {
				act(() => {
					result.current.handleQuickActionsToggleTabShowThinking();
				});
			}).not.toThrow();
		});

		it('only affects the active tab when multiple tabs exist', () => {
			const activeTab = createTab({ id: 'tab-active', showThinking: 'off' });
			const otherTab = createTab({ id: 'tab-other', showThinking: 'off' });
			const session = createSession({
				id: 'sess-1',
				inputMode: 'ai',
				activeTabId: 'tab-active',
				aiTabs: [activeTab, otherTab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleTabShowThinking();
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActive = sessions[0].aiTabs.find((t: AITab) => t.id === 'tab-active');
			const updatedOther = sessions[0].aiTabs.find((t: AITab) => t.id === 'tab-other');
			expect(updatedActive?.showThinking).toBe('on');
			expect(updatedOther?.showThinking).toBe('off');
		});
	});

	// ========================================================================
	// handleQuickActionsRefreshGitFileState
	// ========================================================================
	describe('handleQuickActionsRefreshGitFileState', () => {
		it('calls refreshGitFileState with the active session ID', async () => {
			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(deps.refreshGitFileState).toHaveBeenCalledWith('sess-1');
			expect(deps.refreshGitFileState).toHaveBeenCalledTimes(1);
		});

		it('calls mainPanelRef.refreshGitInfo after refreshing', async () => {
			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(deps.mainPanelRef.current?.refreshGitInfo).toHaveBeenCalledTimes(1);
		});

		it('sets successFlashNotification to the expected message', async () => {
			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(useUIStore.getState().successFlashNotification).toBe('Files, Git, History Refreshed');
		});

		it('clears successFlashNotification after 2000ms', async () => {
			vi.useFakeTimers();

			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(useUIStore.getState().successFlashNotification).toBe('Files, Git, History Refreshed');

			act(() => {
				vi.advanceTimersByTime(2000);
			});

			expect(useUIStore.getState().successFlashNotification).toBeNull();

			vi.useRealTimers();
		});

		it('does not call refreshGitFileState when there is no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(deps.refreshGitFileState).not.toHaveBeenCalled();
			expect(deps.mainPanelRef.current?.refreshGitInfo).not.toHaveBeenCalled();
		});

		it('does not set flash notification when there is no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await act(async () => {
				await result.current.handleQuickActionsRefreshGitFileState();
			});

			expect(useUIStore.getState().successFlashNotification).toBeNull();
		});

		it('handles a null mainPanelRef.current gracefully', async () => {
			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps({
				mainPanelRef: { current: null },
			});
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			await expect(
				act(async () => {
					await result.current.handleQuickActionsRefreshGitFileState();
				})
			).resolves.not.toThrow();

			expect(deps.refreshGitFileState).toHaveBeenCalledWith('sess-1');
		});
	});

	// ========================================================================
	// handleQuickActionsDebugReleaseQueuedItem
	// ========================================================================
	describe('handleQuickActionsDebugReleaseQueuedItem', () => {
		it('removes the first item from the execution queue', () => {
			const item1 = {
				id: 'item-1',
				type: 'message' as const,
				text: 'First',
				tabId: 'tab-1',
				timestamp: 1,
			};
			const item2 = {
				id: 'item-2',
				type: 'message' as const,
				text: 'Second',
				tabId: 'tab-1',
				timestamp: 2,
			};
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsDebugReleaseQueuedItem();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.executionQueue).toHaveLength(1);
			expect(updatedSession.executionQueue[0].id).toBe('item-2');
		});

		it('calls processQueuedItem with the session ID and dequeued item', () => {
			const item = {
				id: 'item-1',
				type: 'message' as const,
				text: 'Do something',
				tabId: 'tab-1',
				timestamp: 1,
			};
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsDebugReleaseQueuedItem();
			});

			expect(deps.processQueuedItem).toHaveBeenCalledWith('sess-1', item);
			expect(deps.processQueuedItem).toHaveBeenCalledTimes(1);
		});

		it('processes the first item when multiple items are queued', () => {
			const item1 = {
				id: 'item-a',
				type: 'message' as const,
				text: 'First',
				tabId: 'tab-1',
				timestamp: 1,
			};
			const item2 = {
				id: 'item-b',
				type: 'message' as const,
				text: 'Second',
				tabId: 'tab-1',
				timestamp: 2,
			};
			const item3 = {
				id: 'item-c',
				type: 'message' as const,
				text: 'Third',
				tabId: 'tab-1',
				timestamp: 3,
			};
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsDebugReleaseQueuedItem();
			});

			expect(deps.processQueuedItem).toHaveBeenCalledWith('sess-1', item1);
			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.executionQueue).toHaveLength(2);
			expect(updatedSession.executionQueue[0].id).toBe('item-b');
			expect(updatedSession.executionQueue[1].id).toBe('item-c');
		});

		it('is a no-op when the execution queue is empty', () => {
			const session = createSession({
				id: 'sess-1',
				executionQueue: [],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsDebugReleaseQueuedItem();
			});

			expect(deps.processQueuedItem).not.toHaveBeenCalled();
		});

		it('is a no-op when there is no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			expect(() => {
				act(() => {
					result.current.handleQuickActionsDebugReleaseQueuedItem();
				});
			}).not.toThrow();

			expect(deps.processQueuedItem).not.toHaveBeenCalled();
		});

		it('only modifies the active session, not other sessions', () => {
			const item1 = {
				id: 'item-a',
				type: 'message' as const,
				text: 'A',
				tabId: 'tab-1',
				timestamp: 1,
			};
			const item2 = {
				id: 'item-b',
				type: 'message' as const,
				text: 'B',
				tabId: 'tab-1',
				timestamp: 2,
			};
			const activeSession = createSession({
				id: 'sess-active',
				executionQueue: [item1],
			});
			const otherSession = createSession({
				id: 'sess-other',
				executionQueue: [item2],
			});
			useSessionStore.setState({
				sessions: [activeSession, otherSession],
				activeSessionId: 'sess-active',
			});

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsDebugReleaseQueuedItem();
			});

			const sessions = useSessionStore.getState().sessions;
			// Active session queue cleared
			expect(sessions[0].executionQueue).toHaveLength(0);
			// Other session untouched
			expect(sessions[1].executionQueue).toHaveLength(1);
			expect(sessions[1].executionQueue[0].id).toBe('item-b');
		});
	});

	// ========================================================================
	// handleQuickActionsToggleMarkdownEditMode
	// ========================================================================
	describe('handleQuickActionsToggleMarkdownEditMode', () => {
		it('toggles markdownEditMode from false to true when a file tab is active', () => {
			useSettingsStore.setState({ markdownEditMode: false } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: 'file-tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().markdownEditMode).toBe(true);
		});

		it('toggles markdownEditMode from true to false when a file tab is active', () => {
			useSettingsStore.setState({ markdownEditMode: true } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: 'file-tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().markdownEditMode).toBe(false);
		});

		it('toggles chatRawTextMode when no file tab is active', () => {
			useSettingsStore.setState({ chatRawTextMode: false, markdownEditMode: false } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: null,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().chatRawTextMode).toBe(true);
		});

		it('toggles chatRawTextMode from true to false when no file tab is active', () => {
			useSettingsStore.setState({ chatRawTextMode: true, markdownEditMode: false } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: null,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().chatRawTextMode).toBe(false);
		});

		it('does not touch chatRawTextMode when a file tab is active', () => {
			useSettingsStore.setState({ markdownEditMode: false, chatRawTextMode: false } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: 'file-tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().chatRawTextMode).toBe(false);
		});

		it('does not touch markdownEditMode when no file tab is active', () => {
			useSettingsStore.setState({ markdownEditMode: false, chatRawTextMode: false } as any);
			const session = createSession({
				id: 'sess-1',
				activeFileTabId: null,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(useSettingsStore.getState().markdownEditMode).toBe(false);
		});

		it('persists markdownEditMode via window.maestro.settings.set', () => {
			useSettingsStore.setState({ markdownEditMode: false } as any);
			const session = createSession({ id: 'sess-1', activeFileTabId: 'file-tab-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('markdownEditMode', true);
		});

		it('persists chatRawTextMode via window.maestro.settings.set', () => {
			useSettingsStore.setState({ chatRawTextMode: false } as any);
			const session = createSession({ id: 'sess-1', activeFileTabId: null });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsToggleMarkdownEditMode();
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('chatRawTextMode', true);
		});
	});

	// ========================================================================
	// handleQuickActionsSummarizeAndContinue
	// ========================================================================
	describe('handleQuickActionsSummarizeAndContinue', () => {
		it('delegates to the handleSummarizeAndContinue dependency', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsSummarizeAndContinue();
			});

			expect(deps.handleSummarizeAndContinue).toHaveBeenCalledTimes(1);
		});

		it('calls handleSummarizeAndContinue with no arguments', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsSummarizeAndContinue();
			});

			expect(deps.handleSummarizeAndContinue).toHaveBeenCalledWith();
		});
	});

	// ========================================================================
	// handleQuickActionsAutoRunResetTasks
	// ========================================================================
	describe('handleQuickActionsAutoRunResetTasks', () => {
		it('calls openAutoRunResetTasksModal on the rightPanelRef', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			act(() => {
				result.current.handleQuickActionsAutoRunResetTasks();
			});

			expect(deps.rightPanelRef.current?.openAutoRunResetTasksModal).toHaveBeenCalledTimes(1);
		});

		it('does not throw when rightPanelRef.current is null', () => {
			const deps = createDeps({
				rightPanelRef: { current: null },
			});
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			expect(() => {
				act(() => {
					result.current.handleQuickActionsAutoRunResetTasks();
				});
			}).not.toThrow();
		});
	});

	// ========================================================================
	// Return type completeness
	// ========================================================================
	describe('return type', () => {
		it('returns all seven handler functions', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useQuickActionsHandlers(deps));

			expect(typeof result.current.handleQuickActionsToggleReadOnlyMode).toBe('function');
			expect(typeof result.current.handleQuickActionsToggleTabShowThinking).toBe('function');
			expect(typeof result.current.handleQuickActionsRefreshGitFileState).toBe('function');
			expect(typeof result.current.handleQuickActionsDebugReleaseQueuedItem).toBe('function');
			expect(typeof result.current.handleQuickActionsToggleMarkdownEditMode).toBe('function');
			expect(typeof result.current.handleQuickActionsSummarizeAndContinue).toBe('function');
			expect(typeof result.current.handleQuickActionsAutoRunResetTasks).toBe('function');
		});

		it('returns stable references for handlers with empty deps across renders', () => {
			const deps = createDeps();
			const { result, rerender } = renderHook(() => useQuickActionsHandlers(deps));

			const firstAutoRunResetTasks = result.current.handleQuickActionsAutoRunResetTasks;
			rerender();
			const secondAutoRunResetTasks = result.current.handleQuickActionsAutoRunResetTasks;

			// handleQuickActionsAutoRunResetTasks has [] deps so should always be stable
			expect(secondAutoRunResetTasks).toBe(firstAutoRunResetTasks);
		});
	});
});
