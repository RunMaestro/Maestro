/**
 * Tests for useTabHandlers hook
 *
 * Tests derived state, AI tab operations, file tab operations, tab close
 * operations, tab property handlers, scroll/log handlers, and file tab navigation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTabHandlers } from '../../../renderer/hooks/tabs/useTabHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session, AITab, FilePreviewTab } from '../../../renderer/types';

// ============================================================================
// window.maestro is mocked globally in src/__tests__/setup.ts
// We just override specific return values needed by our tests in beforeEach.
// ============================================================================

// ============================================================================
// Test Helpers
// ============================================================================

function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	const id = overrides.id ?? `tab-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		agentSessionId: null,
		name: overrides.name ?? null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		...overrides,
	} as AITab;
}

function createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	const id = overrides.id ?? `file-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		path: overrides.path ?? `/test/${id}.ts`,
		name: overrides.name ?? id,
		extension: overrides.extension ?? '.ts',
		content: overrides.content ?? 'test content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
		isLoading: false,
		...overrides,
	} as FilePreviewTab;
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
		name: overrides.name ?? 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function setupSessionWithTabs(
	tabs: AITab[],
	fileTabs: FilePreviewTab[] = [],
	activeTabId?: string,
	activeFileTabId?: string | null
): string {
	const sessionId = 'test-session';
	const unifiedTabOrder = [
		...tabs.map((t) => ({ type: 'ai' as const, id: t.id })),
		...fileTabs.map((t) => ({ type: 'file' as const, id: t.id })),
	];

	const session = createMockSession({
		id: sessionId,
		aiTabs: tabs,
		activeTabId: activeTabId ?? tabs[0]?.id ?? '',
		filePreviewTabs: fileTabs,
		activeFileTabId: activeFileTabId ?? null,
		unifiedTabOrder,
		closedTabHistory: [],
		unifiedClosedTabHistory: [],
	});

	useSessionStore.setState({
		sessions: [session],
		activeSessionId: sessionId,
	});

	return sessionId;
}

function getSession(): Session {
	const state = useSessionStore.getState();
	return state.sessions.find((s) => s.id === state.activeSessionId)!;
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Helper: render the hook, then set up session state inside act() to avoid
 * React concurrent rendering issues with Zustand subscriptions.
 */
function renderWithSession(
	tabs: AITab[],
	fileTabs: FilePreviewTab[] = [],
	activeTabId?: string,
	activeFileTabId?: string | null
) {
	const hookResult = renderHook(() => useTabHandlers());
	act(() => {
		setupSessionWithTabs(tabs, fileTabs, activeTabId, activeFileTabId);
	});
	return hookResult;
}

describe('useTabHandlers', () => {
	beforeEach(() => {
		// Reset all stores
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
		});
		useModalStore.setState({
			modals: new Map(),
		});
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: undefined,
			fileTabAutoRefreshEnabled: false,
		} as any);

		vi.clearAllMocks();

		// Override return values needed by tab handler tests
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('file content');
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 100,
			createdAt: new Date().toISOString(),
			modifiedAt: new Date().toISOString(),
		} as any);

		// Ensure setSessionStarred exists (may not be in global setup)
		if (!(window.maestro.agentSessions as any).setSessionStarred) {
			(window.maestro.agentSessions as any).setSessionStarred = vi
				.fn()
				.mockResolvedValue(undefined);
		}
	});

	afterEach(() => {
		cleanup();
	});

	// ========================================================================
	// Derived State
	// ========================================================================

	describe('derived state', () => {
		it('returns undefined activeTab when no session exists', () => {
			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.activeTab).toBeUndefined();
		});

		it('returns empty arrays when no session exists', () => {
			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.unifiedTabs).toEqual([]);
			expect(result.current.fileTabBackHistory).toEqual([]);
			expect(result.current.fileTabForwardHistory).toEqual([]);
		});

		it('computes activeTab from active session', () => {
			const tab = createMockAITab({ id: 'tab-1', name: 'Tab 1' });
			const { result } = renderWithSession([tab]);
			expect(result.current.activeTab?.id).toBe('tab-1');
		});

		it('computes unifiedTabs in correct order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.unifiedTabs).toHaveLength(2);
			expect(result.current.unifiedTabs[0].type).toBe('ai');
			expect(result.current.unifiedTabs[0].id).toBe('ai-1');
			expect(result.current.unifiedTabs[1].type).toBe('file');
			expect(result.current.unifiedTabs[1].id).toBe('file-1');
		});

		it('returns activeFileTab when file tab is active', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1', name: 'myFile' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.activeFileTab?.id).toBe('file-1');
		});

		it('returns null activeFileTab when no file tab is active', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab]);

			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.activeFileTab).toBeNull();
		});

		it('computes isResumingSession based on agentSessionId', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-123' });
			const { result } = renderWithSession([tab]);
			expect(result.current.isResumingSession).toBe(true);
		});

		it('isResumingSession is false when no agentSessionId', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: null });
			const { result } = renderWithSession([tab]);
			expect(result.current.isResumingSession).toBe(false);
		});

		it('computes file tab navigation history', () => {
			const fileTab = createMockFileTab({
				id: 'file-1',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
					{ path: '/c.ts', name: 'c', scrollTop: 0 },
				],
				navigationIndex: 1,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			expect(result.current.fileTabCanGoBack).toBe(true);
			expect(result.current.fileTabCanGoForward).toBe(true);
			expect(result.current.fileTabBackHistory).toHaveLength(1);
			expect(result.current.fileTabForwardHistory).toHaveLength(1);
			expect(result.current.activeFileTabNavIndex).toBe(1);
		});
	});

	// ========================================================================
	// AI Tab Operations
	// ========================================================================

	describe('AI tab operations', () => {
		it('handleNewAgentSession creates a new tab', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleNewAgentSession();
			});

			const session = getSession();
			expect(session.aiTabs.length).toBe(2);
		});

		it('handleNewAgentSession closes agentSessions modal', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab]);

			// Open the agentSessions modal first
			useModalStore.getState().openModal('agentSessions', { activeAgentSessionId: null });

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleNewAgentSession();
			});

			expect(useModalStore.getState().isOpen('agentSessions')).toBe(false);
		});

		it('handleTabSelect sets the active tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabSelect('tab-2');
			});

			const session = getSession();
			expect(session.activeTabId).toBe('tab-2');
		});
	});

	// ========================================================================
	// File Tab Operations
	// ========================================================================

	describe('file tab operations', () => {
		it('handleOpenFileTab creates a new file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/new.ts',
					name: 'new.ts',
					content: 'new content',
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1);
			expect(session.filePreviewTabs[0].path).toBe('/test/new.ts');
			expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
		});

		it('handleOpenFileTab selects existing tab if path matches', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1', path: '/test/existing.ts' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/existing.ts',
					name: 'existing.ts',
					content: 'updated content',
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1); // No new tab created
			expect(session.activeFileTabId).toBe('file-1');
			expect(session.filePreviewTabs[0].content).toBe('updated content');
		});

		it('handleSelectFileTab sets the active file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleSelectFileTab('file-1');
			});

			const session = getSession();
			expect(session.activeFileTabId).toBe('file-1');
		});

		it('handleCloseFileTab closes a file tab without unsaved changes', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1', editContent: undefined });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseFileTab('file-1');
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(0);
			expect(session.activeFileTabId).toBeNull();
		});

		it('handleCloseFileTab shows confirmation for unsaved changes', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				editContent: 'unsaved changes',
				name: 'test',
				extension: '.ts',
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseFileTab('file-1');
			});

			// Confirm modal should be open
			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		});

		it('handleFileTabEditModeChange updates edit mode', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1', editMode: false });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabEditModeChange('file-1', true);
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].editMode).toBe(true);
		});

		it('handleFileTabEditContentChange updates edit content', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabEditContentChange('file-1', 'edited text');
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].editContent).toBe('edited text');
		});

		it('handleFileTabEditContentChange updates saved content when provided', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1', content: 'old' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabEditContentChange('file-1', undefined, 'saved content');
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].editContent).toBeUndefined();
			expect(session.filePreviewTabs[0].content).toBe('saved content');
		});

		it('handleFileTabSearchQueryChange updates search query', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabSearchQueryChange('file-1', 'search term');
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].searchQuery).toBe('search term');
		});

		it('handleFileTabScrollPositionChange updates scroll position', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabScrollPositionChange('file-1', 500);
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].scrollTop).toBe(500);
		});
	});

	// ========================================================================
	// Tab Close Operations
	// ========================================================================

	describe('tab close operations', () => {
		it('handleTabClose closes a regular AI tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('tab-1');
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-2');
		});

		it('handleNewTab creates a new AI tab', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleNewTab();
			});

			const session = getSession();
			expect(session.aiTabs.length).toBe(2);
		});

		it('handleCloseAllTabs closes all tabs and creates a fresh one', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseAllTabs();
			});

			const session = getSession();
			// closeTab creates a fresh tab when the last one is closed
			expect(session.aiTabs.length).toBe(1);
			// The new tab should not be any of the originals
			expect(['tab-1', 'tab-2', 'tab-3']).not.toContain(session.aiTabs[0].id);
		});

		it('handleCloseOtherTabs keeps only the active tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseOtherTabs();
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-2');
		});

		it('handleCloseTabsLeft closes tabs left of active', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsLeft();
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(2);
			expect(session.aiTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3']);
		});

		it('handleCloseTabsRight closes tabs right of active', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsRight();
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(2);
			expect(session.aiTabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2']);
		});

		it('handleCloseCurrentTab returns file type for active file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			let closeResult: any;
			act(() => {
				closeResult = result.current.handleCloseCurrentTab();
			});

			expect(closeResult.type).toBe('file');
			expect(closeResult.tabId).toBe('file-1');
		});

		it('handleCloseCurrentTab returns ai type for active AI tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			let closeResult: any;
			act(() => {
				closeResult = result.current.handleCloseCurrentTab();
			});

			expect(closeResult.type).toBe('ai');
			expect(closeResult.tabId).toBe('tab-1');
		});

		it('handleCloseCurrentTab returns prevented when only one AI tab', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const { result } = renderWithSession([tab]);
			let closeResult: any;
			act(() => {
				closeResult = result.current.handleCloseCurrentTab();
			});

			expect(closeResult.type).toBe('prevented');
		});

		it('handleCloseCurrentTab returns none when no session', () => {
			const { result } = renderHook(() => useTabHandlers());
			let closeResult: any;
			act(() => {
				closeResult = result.current.handleCloseCurrentTab();
			});

			expect(closeResult.type).toBe('none');
		});
	});

	// ========================================================================
	// Tab Property Handlers
	// ========================================================================

	describe('tab property handlers', () => {
		it('handleTabReorder reorders AI tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabReorder(0, 2);
			});

			const session = getSession();
			expect(session.aiTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
		});

		it('handleUnifiedTabReorder reorders unified tab order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleUnifiedTabReorder(0, 1);
			});

			const session = getSession();
			expect(session.unifiedTabOrder[0]).toEqual({ type: 'file', id: 'file-1' });
			expect(session.unifiedTabOrder[1]).toEqual({ type: 'ai', id: 'ai-1' });
		});

		it('handleUnifiedTabReorder is no-op for invalid indices', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleUnifiedTabReorder(-1, 0);
			});

			const session = getSession();
			expect(session.unifiedTabOrder).toHaveLength(1);
		});

		it('handleRequestTabRename opens rename tab modal', () => {
			const tab = createMockAITab({ id: 'tab-1', name: 'My Tab' });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleRequestTabRename('tab-1');
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(true);
		});

		it('handleTabStar persists starred state', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-1' });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleTabStar('tab-1', true);
			});

			const session = getSession();
			expect(session.aiTabs[0].starred).toBe(true);
		});

		it('handleTabMarkUnread sets hasUnread on tab', () => {
			const tab = createMockAITab({ id: 'tab-1', hasUnread: false });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleTabMarkUnread('tab-1');
			});

			const session = getSession();
			expect(session.aiTabs[0].hasUnread).toBe(true);
		});

		it('handleToggleTabReadOnlyMode toggles read-only', () => {
			const tab = createMockAITab({ id: 'tab-1', readOnlyMode: false } as any);
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleToggleTabReadOnlyMode();
			});

			const session = getSession();
			expect((session.aiTabs[0] as any).readOnlyMode).toBe(true);
		});

		it('handleToggleTabSaveToHistory toggles save-to-history', () => {
			const tab = createMockAITab({ id: 'tab-1', saveToHistory: true } as any);
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleToggleTabSaveToHistory();
			});

			const session = getSession();
			expect((session.aiTabs[0] as any).saveToHistory).toBe(false);
		});

		it('handleToggleTabShowThinking cycles thinking mode', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const { result } = renderWithSession([tab]);

			// off -> on
			act(() => {
				result.current.handleToggleTabShowThinking();
			});
			expect(getSession().aiTabs[0].showThinking).toBe('on');

			// on -> sticky
			act(() => {
				result.current.handleToggleTabShowThinking();
			});
			expect(getSession().aiTabs[0].showThinking).toBe('sticky');

			// sticky -> off
			act(() => {
				result.current.handleToggleTabShowThinking();
			});
			expect(getSession().aiTabs[0].showThinking).toBe('off');
		});

		it('handleUpdateTabByClaudeSessionId updates tab by agent session id', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'agent-1',
				name: 'Old Name',
			});
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleUpdateTabByClaudeSessionId('agent-1', {
					name: 'New Name',
					starred: true,
				});
			});

			const session = getSession();
			expect(session.aiTabs[0].name).toBe('New Name');
			expect(session.aiTabs[0].starred).toBe(true);
		});
	});

	// ========================================================================
	// Scroll/Log Handlers
	// ========================================================================

	describe('scroll and log handlers', () => {
		it('handleScrollPositionChange updates AI tab scroll position', () => {
			const tab = createMockAITab({ id: 'tab-1', scrollTop: 0 });
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleScrollPositionChange(250);
			});

			const session = getSession();
			expect(session.aiTabs[0].scrollTop).toBe(250);
		});

		it('handleScrollPositionChange updates terminal scroll in terminal mode', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				inputMode: 'terminal',
				terminalScrollTop: 0,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleScrollPositionChange(300);
			});

			const updated = getSession();
			expect((updated as any).terminalScrollTop).toBe(300);
		});

		it('handleAtBottomChange updates isAtBottom and clears unread', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				isAtBottom: false,
				hasUnread: true,
			});
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleAtBottomChange(true);
			});

			const session = getSession();
			expect(session.aiTabs[0].isAtBottom).toBe(true);
			expect(session.aiTabs[0].hasUnread).toBe(false);
		});

		it('handleDeleteLog removes user command and associated logs', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				logs: [
					{ id: 'log-1', source: 'user', text: 'test command', timestamp: Date.now() },
					{ id: 'log-2', source: 'ai', text: 'response', timestamp: Date.now() },
					{ id: 'log-3', source: 'user', text: 'second command', timestamp: Date.now() },
				] as any,
			});
			const { result } = renderWithSession([tab]);
			let nextIndex: number | null;
			act(() => {
				nextIndex = result.current.handleDeleteLog('log-1');
			});

			const session = getSession();
			// First user command + its response should be removed, leaving only the second command
			expect(session.aiTabs[0].logs).toHaveLength(1);
			expect(session.aiTabs[0].logs[0].id).toBe('log-3');
		});

		it('handleDeleteLog returns null for non-existent log', () => {
			const tab = createMockAITab({ id: 'tab-1', logs: [] });
			const { result } = renderWithSession([tab]);
			let nextIndex: number | null = -1;
			act(() => {
				nextIndex = result.current.handleDeleteLog('nonexistent');
			});

			expect(nextIndex).toBeNull();
		});
	});

	// ========================================================================
	// File Tab Navigation
	// ========================================================================

	describe('file tab navigation', () => {
		it('handleClearFilePreviewHistory clears history', () => {
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				filePreviewHistory: [{ path: '/a.ts' }, { path: '/b.ts' }] as any,
				filePreviewHistoryIndex: 1,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleClearFilePreviewHistory();
			});

			const updated = getSession();
			expect((updated as any).filePreviewHistory).toEqual([]);
			expect((updated as any).filePreviewHistoryIndex).toBe(-1);
		});

		it('handleFileTabNavigateBack loads previous file in history', async () => {
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/b.ts',
				name: 'b',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
				],
				navigationIndex: 1,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateBack();
			});

			const session = getSession();
			const updatedTab = session.filePreviewTabs[0];
			expect(updatedTab.path).toBe('/a.ts');
			expect(updatedTab.navigationIndex).toBe(0);
		});

		it('handleFileTabNavigateForward loads next file in history', async () => {
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/a.ts',
				name: 'a',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
				],
				navigationIndex: 0,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateForward();
			});

			const session = getSession();
			const updatedTab = session.filePreviewTabs[0];
			expect(updatedTab.path).toBe('/b.ts');
			expect(updatedTab.navigationIndex).toBe(1);
		});

		it('handleFileTabNavigateToIndex loads file at specific index', async () => {
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/a.ts',
				name: 'a',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
					{ path: '/c.ts', name: 'c', scrollTop: 0 },
				],
				navigationIndex: 0,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateToIndex(2);
			});

			const session = getSession();
			const updatedTab = session.filePreviewTabs[0];
			expect(updatedTab.path).toBe('/c.ts');
			expect(updatedTab.navigationIndex).toBe(2);
		});
	});

	// ========================================================================
	// handleReloadFileTab
	// ========================================================================

	describe('handleReloadFileTab', () => {
		it('reloads file content from disk and updates tab', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/reload.ts',
				content: 'old content',
				editContent: 'unsaved',
				lastModified: 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);

			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('new content from disk');
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				size: 200,
				createdAt: new Date().toISOString(),
				modifiedAt: new Date(2000).toISOString(),
			} as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleReloadFileTab('file-1');
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].content).toBe('new content from disk');
			expect(session.filePreviewTabs[0].editContent).toBeUndefined();
		});

		it('does nothing when file tab does not exist', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab]);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleReloadFileTab('nonexistent');
			});

			// Should not throw
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('handles read errors gracefully', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/missing.ts',
				content: 'original',
			});
			setupSessionWithTabs([aiTab], [fileTab]);

			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(new Error('File not found'));

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleReloadFileTab('file-1');
			});

			// Content unchanged on error
			const session = getSession();
			expect(session.filePreviewTabs[0].content).toBe('original');
		});
	});

	// ========================================================================
	// handleSelectFileTab — auto-refresh
	// ========================================================================

	describe('handleSelectFileTab auto-refresh', () => {
		it('auto-refreshes content when file changed on disk and auto-refresh enabled', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const oldTime = Date.now() - 10000;
			const newTime = Date.now();
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/auto.ts',
				content: 'old',
				lastModified: oldTime,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);

			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				size: 100,
				createdAt: new Date().toISOString(),
				modifiedAt: new Date(newTime).toISOString(),
			} as any);
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('refreshed content');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			const session = getSession();
			expect(session.activeFileTabId).toBe('file-1');
			expect(session.filePreviewTabs[0].content).toBe('refreshed content');
		});

		it('does not auto-refresh when file has pending edits', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/edited.ts',
				content: 'original',
				editContent: 'unsaved edits',
				lastModified: 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			expect(window.maestro.fs.stat).not.toHaveBeenCalled();
		});

		it('does not auto-refresh when file has not changed', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTime = Date.now();
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/same.ts',
				content: 'same',
				lastModified: fileTime,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);

			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				size: 100,
				createdAt: new Date().toISOString(),
				modifiedAt: new Date(fileTime - 1000).toISOString(),
			} as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			// Tab active but content not refreshed (no readFile call after stat)
			const session = getSession();
			expect(session.activeFileTabId).toBe('file-1');
			expect(session.filePreviewTabs[0].content).toBe('same');
		});
	});

	// ========================================================================
	// handleTabClose — wizard tab
	// ========================================================================

	describe('handleTabClose wizard tab', () => {
		it('shows confirmation modal for wizard tab', () => {
			const wizardTab = createMockAITab({
				id: 'wizard-1',
				wizardState: { isActive: true, currentStep: 0, steps: ['step1'] },
			} as any);
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([wizardTab, tab2], [], 'wizard-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('wizard-1');
			});

			// Should open confirm modal instead of closing directly
			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
			const modal = useModalStore.getState().modals.get('confirm');
			expect((modal?.data as any)?.message).toContain('wizard');
		});

		it('closes directly for non-wizard tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('tab-1');
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		});
	});

	// ========================================================================
	// handleToggleTabShowThinking — clears logs on off
	// ========================================================================

	describe('handleToggleTabShowThinking log clearing', () => {
		it('clears thinking and tool logs when cycling to off', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'sticky',
				logs: [
					{ id: 'l1', source: 'user', text: 'cmd' },
					{ id: 'l2', source: 'thinking', text: 'thinking...' },
					{ id: 'l3', source: 'ai', text: 'response' },
					{ id: 'l4', source: 'tool', text: 'tool output' },
				] as any,
			});
			const { result } = renderWithSession([tab]);

			// sticky -> off
			act(() => {
				result.current.handleToggleTabShowThinking();
			});

			const session = getSession();
			expect(session.aiTabs[0].showThinking).toBe('off');
			// thinking and tool logs should be filtered out
			const logSources = session.aiTabs[0].logs.map((l) => l.source);
			expect(logSources).not.toContain('thinking');
			expect(logSources).not.toContain('tool');
			expect(logSources).toContain('user');
			expect(logSources).toContain('ai');
		});
	});

	// ========================================================================
	// handleDeleteLog — additional coverage
	// ========================================================================

	describe('handleDeleteLog additional coverage', () => {
		it('returns null for non-user log source', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				logs: [
					{ id: 'log-1', source: 'user', text: 'cmd', timestamp: Date.now() },
					{ id: 'log-2', source: 'ai', text: 'response', timestamp: Date.now() },
				] as any,
			});
			const { result } = renderWithSession([tab]);
			let nextIndex: number | null = -1;
			act(() => {
				nextIndex = result.current.handleDeleteLog('log-2');
			});

			expect(nextIndex).toBeNull();
			// Logs unchanged
			expect(getSession().aiTabs[0].logs).toHaveLength(2);
		});

		it('deletes from shell logs in terminal mode', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				inputMode: 'terminal',
				shellLogs: [
					{ id: 'sl-1', source: 'user', text: 'ls', timestamp: Date.now() },
					{ id: 'sl-2', source: 'output', text: 'file1.ts', timestamp: Date.now() },
					{ id: 'sl-3', source: 'user', text: 'pwd', timestamp: Date.now() },
				] as any,
				shellCommandHistory: ['ls', 'pwd'],
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleDeleteLog('sl-1');
			});

			const updated = getSession();
			expect((updated as any).shellLogs).toHaveLength(1);
			expect((updated as any).shellLogs[0].id).toBe('sl-3');
			// Command history also updated
			expect((updated as any).shellCommandHistory).not.toContain('ls');
		});

		it('calls IPC deleteMessagePair for AI tab logs', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'agent-1',
				logs: [
					{ id: 'log-1', source: 'user', text: 'test command', timestamp: Date.now() },
					{ id: 'log-2', source: 'ai', text: 'response', timestamp: Date.now() },
				] as any,
			});
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				cwd: '/project',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			// Mock the IPC call
			(window.maestro.claude as any).deleteMessagePair = vi
				.fn()
				.mockResolvedValue({ success: true });

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleDeleteLog('log-1');
			});

			expect((window.maestro.claude as any).deleteMessagePair).toHaveBeenCalledWith(
				'/project',
				'agent-1',
				'log-1',
				'test command'
			);
		});

		it('removes command from aiCommandHistory', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				logs: [
					{ id: 'log-1', source: 'user', text: '  hello world  ', timestamp: Date.now() },
				] as any,
			});
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				aiCommandHistory: ['hello world', 'other command'],
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleDeleteLog('log-1');
			});

			const updated = getSession();
			expect((updated as any).aiCommandHistory).toEqual(['other command']);
		});
	});

	// ========================================================================
	// handleAtBottomChange — edge cases
	// ========================================================================

	describe('handleAtBottomChange edge cases', () => {
		it('preserves hasUnread when scrolled away from bottom', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				isAtBottom: true,
				hasUnread: true,
			});
			const { result } = renderWithSession([tab]);
			act(() => {
				result.current.handleAtBottomChange(false);
			});

			const session = getSession();
			expect(session.aiTabs[0].isAtBottom).toBe(false);
			expect(session.aiTabs[0].hasUnread).toBe(true); // Preserved, not cleared
		});
	});

	// ========================================================================
	// handleCloseOtherTabs — with file tabs
	// ========================================================================

	describe('handleCloseOtherTabs with file tabs', () => {
		it('keeps active file tab and closes all others', () => {
			const aiTab1 = createMockAITab({ id: 'ai-1' });
			const aiTab2 = createMockAITab({ id: 'ai-2' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });

			const session = createMockSession({
				id: 'test-session',
				aiTabs: [aiTab1, aiTab2],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab1, fileTab2],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'file', id: 'file-2' },
				],
				closedTabHistory: [],
				unifiedClosedTabHistory: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseOtherTabs();
			});

			const updated = getSession();
			// Active file tab should remain; other file tab closed; AI tabs handled by closeTab logic
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-1')).toBe(true);
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-2')).toBe(false);
		});
	});

	// ========================================================================
	// handleCloseTabsLeft/Right — with file tabs
	// ========================================================================

	describe('handleCloseTabsLeft with file tabs', () => {
		it('closes file tabs left of active in unified order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });

			const session = createMockSession({
				id: 'test-session',
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab1, fileTab2],
				activeFileTabId: 'file-2',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'file', id: 'file-2' },
				],
				closedTabHistory: [],
				unifiedClosedTabHistory: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsLeft();
			});

			const updated = getSession();
			// ai-1 and file-1 should be closed (left of active file-2)
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-1')).toBe(false);
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-2')).toBe(true);
		});
	});

	describe('handleCloseTabsRight with file tabs', () => {
		it('closes file tabs right of active in unified order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });

			const session = createMockSession({
				id: 'test-session',
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab1, fileTab2],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-2' },
				],
				closedTabHistory: [],
				unifiedClosedTabHistory: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsRight();
			});

			const updated = getSession();
			// ai-1 and file-2 should be closed (right of active file-1)
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-1')).toBe(true);
			expect(updated.filePreviewTabs.some((t) => t.id === 'file-2')).toBe(false);
		});
	});

	// ========================================================================
	// handleOpenFileTab — adjacent insertion
	// ========================================================================

	describe('handleOpenFileTab adjacent insertion', () => {
		it('inserts new file tab adjacent to active file tab in unified order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });

			const session = createMockSession({
				id: 'test-session',
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
				closedTabHistory: [],
				unifiedClosedTabHistory: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/new.ts',
					name: 'new.ts',
					content: 'new content',
				});
			});

			const updated = getSession();
			expect(updated.filePreviewTabs).toHaveLength(2);
			// New tab should be after file-1 in unified order
			const fileIndices = updated.unifiedTabOrder
				.map((ref, i) => (ref.type === 'file' ? i : -1))
				.filter((i) => i >= 0);
			expect(fileIndices).toHaveLength(2);
			// The new file tab should come right after file-1
			expect(fileIndices[1] - fileIndices[0]).toBe(1);
		});

		it('builds navigation history when using openInNewTab=false', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/old.ts',
				name: 'old',
				content: 'old content',
				navigationHistory: [{ path: '/test/old.ts', name: 'old', scrollTop: 0 }],
				navigationIndex: 0,
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/test/new.ts', name: 'new.ts', content: 'new' },
					{ openInNewTab: false }
				);
			});

			const session = getSession();
			const tab = session.filePreviewTabs[0];
			expect(tab.navigationHistory?.length).toBeGreaterThan(1);
			expect(tab.navigationHistory?.[tab.navigationHistory.length - 1].path).toBe('/test/new.ts');
		});
	});

	// ========================================================================
	// handleNewAgentSession — settings defaults
	// ========================================================================

	describe('handleNewAgentSession settings', () => {
		it('applies defaultSaveToHistory and defaultShowThinking from settings', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab]);
			useSettingsStore.setState({
				defaultSaveToHistory: false,
				defaultShowThinking: 'on',
			} as any);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleNewAgentSession();
			});

			const session = getSession();
			const newTab = session.aiTabs.find((t) => t.id !== 'tab-1');
			expect(newTab).toBeDefined();
			expect((newTab as any).saveToHistory).toBe(false);
			expect((newTab as any).showThinking).toBe('on');
		});
	});

	// ========================================================================
	// performTabClose (exposed for keyboard handler)
	// ========================================================================

	describe('performTabClose', () => {
		it('closes an AI tab and adds to history', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.performTabClose('tab-1');
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-2');
		});
	});

	// ========================================================================
	// Edge Cases
	// ========================================================================

	describe('edge cases', () => {
		it('handlers are no-ops when no active session', () => {
			const { result } = renderHook(() => useTabHandlers());

			// These should not throw
			act(() => {
				result.current.handleNewAgentSession();
				result.current.handleTabSelect('nonexistent');
				result.current.handleTabClose('nonexistent');
				result.current.handleNewTab();
				result.current.handleScrollPositionChange(100);
				result.current.handleAtBottomChange(true);
			});

			// No crash — state unchanged
			expect(useSessionStore.getState().sessions).toEqual([]);
		});

		it('handleOpenFileTab with openInNewTab=false replaces content in current file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/old.ts',
				name: 'old',
				content: 'old content',
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab(
					{
						path: '/test/new.ts',
						name: 'new.ts',
						content: 'new content',
					},
					{ openInNewTab: false }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1);
			expect(session.filePreviewTabs[0].path).toBe('/test/new.ts');
			expect(session.filePreviewTabs[0].content).toBe('new content');
		});
	});
});
