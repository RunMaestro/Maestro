import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useTabStore,
	selectActiveTab,
	selectActiveFileTab,
	selectUnifiedTabs,
	selectTabById,
	selectFileTabById,
	selectTabCount,
	selectAllTabs,
	selectAllFileTabs,
	getTabState,
	getTabActions,
} from '../../../renderer/stores/tabStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, AITab, FilePreviewTab } from '../../../renderer/types';

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
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

/**
 * Set up sessionStore with an active session that has tabs.
 * Returns the session ID for assertions.
 */
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

// ============================================================================
// Tests
// ============================================================================

describe('tabStore', () => {
	beforeEach(() => {
		// Reset both stores before each test
		useTabStore.setState({
			tabGistContent: null,
			fileGistUrls: {},
		});
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
	});

	// ========================================================================
	// Initial State
	// ========================================================================

	describe('initial state', () => {
		it('should have correct default values', () => {
			const state = useTabStore.getState();
			expect(state.tabGistContent).toBeNull();
			expect(state.fileGistUrls).toEqual({});
		});
	});

	// ========================================================================
	// Gist UI State
	// ========================================================================

	describe('gist UI state', () => {
		it('should set and clear tab gist content', () => {
			const { setTabGistContent } = useTabStore.getState();

			setTabGistContent({ filename: 'test.md', content: '# Hello' });
			expect(useTabStore.getState().tabGistContent).toEqual({
				filename: 'test.md',
				content: '# Hello',
			});

			setTabGistContent(null);
			expect(useTabStore.getState().tabGistContent).toBeNull();
		});

		it('should set file gist URLs', () => {
			const { setFileGistUrls } = useTabStore.getState();
			const urls = {
				'/test/file.ts': {
					gistUrl: 'https://gist.github.com/123',
					isPublic: true,
					publishedAt: 1000,
				},
			};
			setFileGistUrls(urls);
			expect(useTabStore.getState().fileGistUrls).toEqual(urls);
		});

		it('should set a single file gist URL', () => {
			const { setFileGistUrl } = useTabStore.getState();
			const info = { gistUrl: 'https://gist.github.com/abc', isPublic: false, publishedAt: 2000 };

			setFileGistUrl('/test/a.ts', info);
			expect(useTabStore.getState().fileGistUrls['/test/a.ts']).toEqual(info);

			// Setting another should preserve existing
			const info2 = { gistUrl: 'https://gist.github.com/def', isPublic: true, publishedAt: 3000 };
			setFileGistUrl('/test/b.ts', info2);
			expect(useTabStore.getState().fileGistUrls['/test/a.ts']).toEqual(info);
			expect(useTabStore.getState().fileGistUrls['/test/b.ts']).toEqual(info2);
		});

		it('should clear a single file gist URL', () => {
			const { setFileGistUrl, clearFileGistUrl } = useTabStore.getState();
			const info = { gistUrl: 'https://gist.github.com/abc', isPublic: false, publishedAt: 2000 };

			setFileGistUrl('/test/a.ts', info);
			setFileGistUrl('/test/b.ts', info);
			clearFileGistUrl('/test/a.ts');

			expect(useTabStore.getState().fileGistUrls['/test/a.ts']).toBeUndefined();
			expect(useTabStore.getState().fileGistUrls['/test/b.ts']).toEqual(info);
		});
	});

	// ========================================================================
	// Tab CRUD
	// ========================================================================

	describe('tab CRUD', () => {
		it('should create a new tab in the active session', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			const result = useTabStore.getState().createTab();
			expect(result).not.toBeNull();
			expect(result!.tab).toBeDefined();
			expect(result!.tab.id).toBeTruthy();

			// Session should now have 2 tabs
			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(2);
			// New tab should be active
			expect(session.activeTabId).toBe(result!.tab.id);
		});

		it('should create tab with options', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			const result = useTabStore.getState().createTab({
				name: 'My Tab',
				starred: true,
			});

			expect(result).not.toBeNull();
			expect(result!.tab.name).toBe('My Tab');
			expect(result!.tab.starred).toBe(true);
		});

		it('should return null when no active session', () => {
			// No session set up
			const result = useTabStore.getState().createTab();
			expect(result).toBeNull();
		});

		it('should close an AI tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const result = useTabStore.getState().closeTab('tab-1');
			expect(result).not.toBeNull();

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-2');
		});

		it('should return null when closing non-existent tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			const result = useTabStore.getState().closeTab('non-existent');
			expect(result).toBeNull();
		});

		it('should close a file preview tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });
			setupSessionWithTabs([tab1], [fileTab1, fileTab2], 'tab-1', 'file-1');

			const result = useTabStore.getState().closeFileTab('file-1');
			expect(result).not.toBeNull();

			const session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs).toHaveLength(1);
			expect(session.filePreviewTabs[0].id).toBe('file-2');
		});

		it('should reopen a closed tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			// Close tab-1
			useTabStore.getState().closeTab('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(1);

			// Reopen it
			const result = useTabStore.getState().reopenClosedTab();
			expect(result).not.toBeNull();

			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(2);
		});
	});

	// ========================================================================
	// Tab Navigation
	// ========================================================================

	describe('tab navigation', () => {
		it('should select an AI tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const result = useTabStore.getState().selectTab('tab-2');
			expect(result).not.toBeNull();

			const session = useSessionStore.getState().sessions[0];
			expect(session.activeTabId).toBe('tab-2');
		});

		it('should return null when selecting non-existent tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			const result = useTabStore.getState().selectTab('non-existent');
			expect(result).toBeNull();
		});

		it('should select a file preview tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([tab1], [fileTab1]);

			useTabStore.getState().selectFileTab('file-1');

			const session = useSessionStore.getState().sessions[0];
			expect(session.activeFileTabId).toBe('file-1');
		});

		it('should not select non-existent file tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().selectFileTab('non-existent');

			const session = useSessionStore.getState().sessions[0];
			expect(session.activeFileTabId).toBeNull();
		});

		it('should navigate to next tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const result = useTabStore.getState().navigateToNext();
			expect(result).not.toBeNull();

			const session = useSessionStore.getState().sessions[0];
			// Should have navigated away from tab-1
			expect(session.activeTabId).not.toBe('tab-1');
		});

		it('should navigate to previous tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-2');

			const result = useTabStore.getState().navigateToPrev();
			expect(result).not.toBeNull();

			const session = useSessionStore.getState().sessions[0];
			expect(session.activeTabId).not.toBe('tab-2');
		});

		it('should navigate to tab by index', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-1');

			const result = useTabStore.getState().navigateToIndex(1);
			expect(result).not.toBeNull();
		});

		it('should navigate to last tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-1');

			const result = useTabStore.getState().navigateToLast();
			expect(result).not.toBeNull();
		});

		it('should return null for navigation with no active session', () => {
			expect(useTabStore.getState().navigateToNext()).toBeNull();
			expect(useTabStore.getState().navigateToPrev()).toBeNull();
			expect(useTabStore.getState().navigateToIndex(0)).toBeNull();
			expect(useTabStore.getState().navigateToLast()).toBeNull();
		});
	});

	// ========================================================================
	// Tab Metadata
	// ========================================================================

	describe('tab metadata', () => {
		it('should toggle star on a tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1', starred: false });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().starTab('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].starred).toBe(true);

			// Toggle back
			useTabStore.getState().starTab('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].starred).toBe(false);
		});

		it('should mark tab as unread', () => {
			const tab1 = createMockAITab({ id: 'tab-1', hasUnread: false });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().markUnread('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].hasUnread).toBe(true);

			// Mark as read
			useTabStore.getState().markUnread('tab-1', false);
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].hasUnread).toBe(false);
		});

		it('should update tab name', () => {
			const tab1 = createMockAITab({ id: 'tab-1', name: null });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().updateTabName('tab-1', 'My Feature');
			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].name).toBe('My Feature');
		});

		it('should toggle read-only mode', () => {
			const tab1 = createMockAITab({ id: 'tab-1', readOnlyMode: false });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().toggleReadOnly('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].readOnlyMode).toBe(true);

			useTabStore.getState().toggleReadOnly('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].readOnlyMode).toBe(false);
		});

		it('should toggle save to history', () => {
			const tab1 = createMockAITab({ id: 'tab-1', saveToHistory: false });
			setupSessionWithTabs([tab1]);

			useTabStore.getState().toggleSaveToHistory('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].saveToHistory).toBe(true);

			useTabStore.getState().toggleSaveToHistory('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].saveToHistory).toBe(false);
		});

		it('should cycle thinking mode: off → on → sticky → off', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			// Default is off (undefined → treated as 'off')
			useTabStore.getState().cycleThinkingMode('tab-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].showThinking).toBe('on');

			useTabStore.getState().cycleThinkingMode('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].showThinking).toBe('sticky');

			useTabStore.getState().cycleThinkingMode('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].showThinking).toBe('off');
		});

		it('should be no-op for non-existent tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			// These should not throw
			useTabStore.getState().starTab('non-existent');
			useTabStore.getState().toggleReadOnly('non-existent');
			useTabStore.getState().cycleThinkingMode('non-existent');

			// Tab-1 should be unchanged
			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].starred).toBe(false);
		});
	});

	// ========================================================================
	// Tab Reordering
	// ========================================================================

	describe('tab reordering', () => {
		it('should reorder AI tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3]);

			useTabStore.getState().reorderTabs(0, 2);

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
		});

		it('should reorder unified tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([tab1], [fileTab1]);

			// Initial order: [ai:tab-1, file:file-1]
			useTabStore.getState().reorderUnifiedTabs(0, 1);

			const session = useSessionStore.getState().sessions[0];
			expect(session.unifiedTabOrder[0].id).toBe('file-1');
			expect(session.unifiedTabOrder[1].id).toBe('tab-1');
		});

		it('should handle out-of-bounds reorder gracefully', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			// Out of bounds — should be a no-op
			useTabStore.getState().reorderTabs(0, 5);
			useTabStore.getState().reorderTabs(-1, 0);

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-1');
		});
	});

	// ========================================================================
	// File Tab Content Operations
	// ========================================================================

	describe('file tab content operations', () => {
		it('should update file tab edit content', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1', editContent: undefined });
			setupSessionWithTabs([tab1], [fileTab1]);

			useTabStore.getState().updateFileTabEditContent('file-1', 'modified content');

			const session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].editContent).toBe('modified content');
		});

		it('should update file tab scroll position', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1', scrollTop: 0 });
			setupSessionWithTabs([tab1], [fileTab1]);

			useTabStore.getState().updateFileTabScrollPosition('file-1', 500);

			const session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].scrollTop).toBe(500);
		});

		it('should update file tab search query', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1', searchQuery: '' });
			setupSessionWithTabs([tab1], [fileTab1]);

			useTabStore.getState().updateFileTabSearchQuery('file-1', 'function');

			const session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].searchQuery).toBe('function');
		});

		it('should toggle file tab edit mode', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1', editMode: false });
			setupSessionWithTabs([tab1], [fileTab1]);

			useTabStore.getState().toggleFileTabEditMode('file-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].editMode).toBe(true);

			useTabStore.getState().toggleFileTabEditMode('file-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].editMode).toBe(false);
		});

		it('should be no-op for non-existent file tab', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([tab1], [fileTab1]);

			// These should not throw
			useTabStore.getState().updateFileTabEditContent('non-existent', 'content');
			useTabStore.getState().toggleFileTabEditMode('non-existent');

			// Original tab unchanged
			const session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].editContent).toBeUndefined();
		});
	});

	// ========================================================================
	// Selectors
	// ========================================================================

	describe('selectors', () => {
		describe('selectActiveTab', () => {
			it('should return the active AI tab', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const tab2 = createMockAITab({ id: 'tab-2' });
				setupSessionWithTabs([tab1, tab2], [], 'tab-2');

				const result = selectActiveTab(useSessionStore.getState());
				expect(result).toBeDefined();
				expect(result!.id).toBe('tab-2');
			});

			it('should fall back to first tab if activeTabId not found', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				setupSessionWithTabs([tab1], [], 'non-existent');

				const result = selectActiveTab(useSessionStore.getState());
				expect(result).toBeDefined();
				expect(result!.id).toBe('tab-1');
			});

			it('should return undefined with no active session', () => {
				const result = selectActiveTab(useSessionStore.getState());
				expect(result).toBeUndefined();
			});
		});

		describe('selectActiveFileTab', () => {
			it('should return the active file tab', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const fileTab1 = createMockFileTab({ id: 'file-1' });
				setupSessionWithTabs([tab1], [fileTab1], 'tab-1', 'file-1');

				const result = selectActiveFileTab(useSessionStore.getState());
				expect(result).toBeDefined();
				expect(result!.id).toBe('file-1');
			});

			it('should return undefined when no file tab is active', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				setupSessionWithTabs([tab1]);

				const result = selectActiveFileTab(useSessionStore.getState());
				expect(result).toBeUndefined();
			});
		});

		describe('selectUnifiedTabs', () => {
			it('should return tabs in unified order', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const tab2 = createMockAITab({ id: 'tab-2' });
				const fileTab1 = createMockFileTab({ id: 'file-1' });

				const sessionId = 'test-session';
				const session = createMockSession({
					id: sessionId,
					aiTabs: [tab1, tab2],
					activeTabId: 'tab-1',
					filePreviewTabs: [fileTab1],
					unifiedTabOrder: [
						{ type: 'ai', id: 'tab-1' },
						{ type: 'file', id: 'file-1' },
						{ type: 'ai', id: 'tab-2' },
					],
				});

				useSessionStore.setState({
					sessions: [session],
					activeSessionId: sessionId,
				});

				const result = selectUnifiedTabs(useSessionStore.getState());
				expect(result).toHaveLength(3);
				expect(result[0]).toEqual({ type: 'ai', id: 'tab-1', data: tab1 });
				expect(result[1]).toEqual({ type: 'file', id: 'file-1', data: fileTab1 });
				expect(result[2]).toEqual({ type: 'ai', id: 'tab-2', data: tab2 });
			});

			it('should include orphan tabs not in unified order', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const tab2 = createMockAITab({ id: 'tab-2' });

				const session = createMockSession({
					id: 'test',
					aiTabs: [tab1, tab2],
					activeTabId: 'tab-1',
					unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
					// tab-2 is NOT in unified order
				});

				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'test',
				});

				const result = selectUnifiedTabs(useSessionStore.getState());
				expect(result).toHaveLength(2);
				expect(result[0].id).toBe('tab-1');
				expect(result[1].id).toBe('tab-2');
			});

			it('should return empty array with no active session', () => {
				const result = selectUnifiedTabs(useSessionStore.getState());
				expect(result).toEqual([]);
			});
		});

		describe('selectTabById', () => {
			it('should find tab by ID', () => {
				const tab1 = createMockAITab({ id: 'tab-1', name: 'Found' });
				setupSessionWithTabs([tab1]);

				const result = selectTabById('tab-1')(useSessionStore.getState());
				expect(result).toBeDefined();
				expect(result!.name).toBe('Found');
			});

			it('should return undefined for non-existent tab', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				setupSessionWithTabs([tab1]);

				const result = selectTabById('non-existent')(useSessionStore.getState());
				expect(result).toBeUndefined();
			});
		});

		describe('selectFileTabById', () => {
			it('should find file tab by ID', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const fileTab = createMockFileTab({ id: 'file-1', name: 'app' });
				setupSessionWithTabs([tab1], [fileTab]);

				const result = selectFileTabById('file-1')(useSessionStore.getState());
				expect(result).toBeDefined();
				expect(result!.name).toBe('app');
			});
		});

		describe('selectTabCount', () => {
			it('should return count of AI tabs', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const tab2 = createMockAITab({ id: 'tab-2' });
				setupSessionWithTabs([tab1, tab2]);

				expect(selectTabCount(useSessionStore.getState())).toBe(2);
			});

			it('should return 0 with no active session', () => {
				expect(selectTabCount(useSessionStore.getState())).toBe(0);
			});
		});

		describe('selectAllTabs / selectAllFileTabs', () => {
			it('should return all AI tabs', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const tab2 = createMockAITab({ id: 'tab-2' });
				setupSessionWithTabs([tab1, tab2]);

				const result = selectAllTabs(useSessionStore.getState());
				expect(result).toHaveLength(2);
			});

			it('should return all file tabs', () => {
				const tab1 = createMockAITab({ id: 'tab-1' });
				const fileTab1 = createMockFileTab({ id: 'file-1' });
				const fileTab2 = createMockFileTab({ id: 'file-2' });
				setupSessionWithTabs([tab1], [fileTab1, fileTab2]);

				const result = selectAllFileTabs(useSessionStore.getState());
				expect(result).toHaveLength(2);
			});
		});
	});

	// ========================================================================
	// React Hook Integration
	// ========================================================================

	describe('React hook integration', () => {
		it('should subscribe to gist state changes', () => {
			const { result } = renderHook(() => useTabStore((s) => s.tabGistContent));

			expect(result.current).toBeNull();

			act(() => {
				useTabStore.getState().setTabGistContent({ filename: 'test.md', content: 'hello' });
			});

			expect(result.current).toEqual({ filename: 'test.md', content: 'hello' });
		});

		it('should subscribe to tab selectors via sessionStore', () => {
			const tab1 = createMockAITab({ id: 'tab-1', name: 'First' });
			setupSessionWithTabs([tab1]);

			const { result } = renderHook(() => useSessionStore(selectActiveTab));

			expect(result.current).toBeDefined();
			expect(result.current!.id).toBe('tab-1');

			// Update tab name via tabStore action
			act(() => {
				useTabStore.getState().updateTabName('tab-1', 'Updated');
			});

			expect(result.current!.name).toBe('Updated');
		});
	});

	// ========================================================================
	// Action Stability
	// ========================================================================

	describe('action stability', () => {
		it('should return stable action references from getTabActions', () => {
			const actions1 = getTabActions();
			const actions2 = getTabActions();

			expect(actions1.createTab).toBe(actions2.createTab);
			expect(actions1.closeTab).toBe(actions2.closeTab);
			expect(actions1.selectTab).toBe(actions2.selectTab);
			expect(actions1.starTab).toBe(actions2.starTab);
			expect(actions1.setTabGistContent).toBe(actions2.setTabGistContent);
		});
	});

	// ========================================================================
	// Non-React Access
	// ========================================================================

	describe('non-React access', () => {
		it('should provide current state via getTabState', () => {
			const { setTabGistContent } = useTabStore.getState();
			setTabGistContent({ filename: 'a.ts', content: 'code' });

			const state = getTabState();
			expect(state.tabGistContent).toEqual({ filename: 'a.ts', content: 'code' });
		});

		it('should provide working actions via getTabActions', () => {
			const tab1 = createMockAITab({ id: 'tab-1', starred: false });
			setupSessionWithTabs([tab1]);

			const actions = getTabActions();
			actions.starTab('tab-1');

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].starred).toBe(true);
		});
	});

	// ========================================================================
	// Complex Scenarios
	// ========================================================================

	describe('complex scenarios', () => {
		it('should handle create-select-close flow', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab1]);

			// Create a new tab
			const created = useTabStore.getState().createTab({ name: 'New' });
			expect(created).not.toBeNull();
			const newTabId = created!.tab.id;

			// Session should have 2 tabs, new one is active
			let session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(2);
			expect(session.activeTabId).toBe(newTabId);

			// Select the first tab
			useTabStore.getState().selectTab('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.activeTabId).toBe('tab-1');

			// Close the new tab
			useTabStore.getState().closeTab(newTabId);
			session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-1');
		});

		it('should handle mixed AI and file tab operations', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([tab1], [fileTab1]);

			// Select file tab
			useTabStore.getState().selectFileTab('file-1');
			let session = useSessionStore.getState().sessions[0];
			expect(session.activeFileTabId).toBe('file-1');

			// Update file tab content
			useTabStore.getState().updateFileTabEditContent('file-1', 'edited');
			session = useSessionStore.getState().sessions[0];
			expect(session.filePreviewTabs[0].editContent).toBe('edited');

			// Switch back to AI tab
			useTabStore.getState().selectTab('tab-1');
			session = useSessionStore.getState().sessions[0];
			expect(session.activeTabId).toBe('tab-1');
		});

		it('should handle metadata updates on multiple tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3]);

			// Star tab-1 and tab-3
			useTabStore.getState().starTab('tab-1');
			useTabStore.getState().starTab('tab-3');

			// Mark tab-2 as unread
			useTabStore.getState().markUnread('tab-2');

			// Rename tab-1
			useTabStore.getState().updateTabName('tab-1', 'Main Feature');

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].starred).toBe(true);
			expect(session.aiTabs[0].name).toBe('Main Feature');
			expect(session.aiTabs[1].hasUnread).toBe(true);
			expect(session.aiTabs[1].starred).toBe(false);
			expect(session.aiTabs[2].starred).toBe(true);
		});
	});
});
