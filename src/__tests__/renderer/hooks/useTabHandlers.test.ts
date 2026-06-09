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
		(window.maestro.claude as any).deleteMessagePair = vi.fn().mockResolvedValue({ success: true });

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

		it('returns null activeFileTab when active file tab id is stale', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'missing-file');

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

		it('handleTabSelect preserves the session when the tab id is missing', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab]);
			const originalSession = getSession();

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabSelect('missing-tab');
			});

			expect(getSession()).toBe(originalSession);
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

		it('handleOpenFileTab updates only the matching existing file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/existing.ts',
				content: 'old content',
				lastModified: 111,
			});
			const siblingTab = createMockFileTab({
				id: 'file-2',
				path: '/test/sibling.ts',
				content: 'sibling content',
			});
			setupSessionWithTabs([aiTab], [fileTab, siblingTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/existing.ts',
					name: 'existing.ts',
					content: 'updated content',
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(2);
			expect(session.filePreviewTabs[0]).toMatchObject({
				id: 'file-1',
				content: 'updated content',
				lastModified: 111,
			});
			expect(session.filePreviewTabs[1]).toMatchObject({
				id: 'file-2',
				content: 'sibling content',
			});
			expect(session.activeFileTabId).toBe('file-1');
		});

		it('handleOpenFileTab creates extensionless file tabs for names without dots', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/Makefile',
					name: 'Makefile',
					content: 'build:',
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs[0]).toMatchObject({
				path: '/test/Makefile',
				name: 'Makefile',
				extension: '',
			});
			expect(session.filePreviewTabs[0].navigationHistory).toEqual([
				{ path: '/test/Makefile', name: 'Makefile', scrollTop: 0 },
			]);
		});

		it('handleOpenFileTab leaves inactive sessions unchanged when active session is missing', () => {
			const session = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'missing-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/new.ts',
					name: 'new.ts',
					content: 'new content',
				});
			});

			expect(useSessionStore.getState().sessions[0]).toBe(session);
		});

		it('handleOpenFileTab replaces the active file tab when opening in the current tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/current.ts',
				name: 'current',
				extension: '.ts',
				scrollTop: 42,
				navigationHistory: [
					{ path: '/test/previous.ts', name: 'previous', scrollTop: 5 },
					{ path: '/test/forward.ts', name: 'forward', scrollTop: 9 },
				],
				navigationIndex: 0,
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab(
					{
						path: '/test/README',
						name: 'README',
						content: 'read me',
						lastModified: 1234,
						sshRemoteId: 'remote-1',
					},
					{ openInNewTab: false }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1);
			expect(session.filePreviewTabs[0]).toMatchObject({
				id: 'file-1',
				path: '/test/README',
				name: 'README',
				extension: '',
				content: 'read me',
				lastModified: 1234,
				sshRemoteId: 'remote-1',
				navigationIndex: 2,
			});
			expect(session.filePreviewTabs[0].navigationHistory).toEqual([
				{ path: '/test/previous.ts', name: 'previous', scrollTop: 5 },
				{ path: '/test/current.ts', name: 'current', scrollTop: 42 },
				{ path: '/test/README', name: 'README', scrollTop: 0 },
			]);
		});

		it('handleOpenFileTab preserves sibling file tabs when replacing the active file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const activeFile = createMockFileTab({
				id: 'file-1',
				path: '/test/current.ts',
				name: 'current',
				content: 'current content',
			});
			const siblingFile = createMockFileTab({
				id: 'file-2',
				path: '/test/sibling.ts',
				name: 'sibling',
				content: 'sibling content',
			});
			setupSessionWithTabs([aiTab], [activeFile, siblingFile], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab(
					{
						path: '/test/replacement.ts',
						name: 'replacement.ts',
						content: 'replacement content',
					},
					{ openInNewTab: false }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs.find((tab) => tab.id === 'file-1')).toMatchObject({
				path: '/test/replacement.ts',
				name: 'replacement',
				content: 'replacement content',
			});
			expect(session.filePreviewTabs.find((tab) => tab.id === 'file-2')).toBe(siblingFile);
		});

		it('handleOpenFileTab does not duplicate the current file when replacing with existing history', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/current.ts',
				name: 'current',
				extension: '.ts',
				navigationHistory: [{ path: '/test/current.ts', name: 'current', scrollTop: 12 }],
				navigationIndex: 0,
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab(
					{
						path: '/test/next.ts',
						name: 'next.ts',
						content: 'next',
					},
					{ openInNewTab: false }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].navigationHistory).toEqual([
				{ path: '/test/current.ts', name: 'current', scrollTop: 12 },
				{ path: '/test/next.ts', name: 'next', scrollTop: 0 },
			]);
		});

		it('handleOpenFileTab inserts new file tabs adjacent to the active file tab', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/adjacent.ts',
					name: 'adjacent.ts',
					content: 'adjacent',
				});
			});

			const session = getSession();
			const newFileTab = session.filePreviewTabs.find((tab) => tab.path === '/test/adjacent.ts');
			expect(newFileTab).toBeDefined();
			expect(session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'file', id: newFileTab!.id },
			]);
		});

		it('handleOpenFileTab appends when the active file tab is absent from unified order', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) =>
					session.id === 'test-session'
						? { ...session, unifiedTabOrder: [{ type: 'ai' as const, id: 'ai-1' }] }
						: session
				),
			}));

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleOpenFileTab({
					path: '/test/appended.ts',
					name: 'appended.ts',
					content: 'appended',
				});
			});

			const session = getSession();
			const newFileTab = session.filePreviewTabs.find((tab) => tab.path === '/test/appended.ts');
			expect(newFileTab).toBeDefined();
			expect(session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: newFileTab!.id },
			]);
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

		it('handleSelectFileTab is a no-op without an active session or matching file tab', async () => {
			const { result } = renderHook(() => useTabHandlers());

			await act(async () => {
				await result.current.handleSelectFileTab('missing-file');
			});
			expect(window.maestro.fs.stat).not.toHaveBeenCalled();

			const aiTab = createMockAITab({ id: 'ai-1' });
			act(() => {
				setupSessionWithTabs([aiTab]);
			});

			await act(async () => {
				await result.current.handleSelectFileTab('missing-file');
			});

			expect(getSession().activeFileTabId).toBeNull();
			expect(window.maestro.fs.stat).not.toHaveBeenCalled();
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

		it('handleCloseFileTab closes unsaved file tab after confirmation', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				editContent: 'unsaved changes',
				name: 'draft',
				extension: '.ts',
			});
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseFileTab('file-1');
			});

			const modal = useModalStore.getState().modals.get('confirm');
			act(() => {
				(modal?.data as any)?.onConfirm();
			});

			expect(getSession().filePreviewTabs).toEqual([]);
			expect(getSession().activeFileTabId).toBeNull();
		});

		it('handleCloseFileTab is a no-op when the active session or file tab is missing', () => {
			const { result } = renderHook(() => useTabHandlers());

			act(() => {
				result.current.handleCloseFileTab('missing-file');
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(false);

			const aiTab = createMockAITab({ id: 'ai-1' });
			act(() => {
				setupSessionWithTabs([aiTab]);
			});

			act(() => {
				result.current.handleCloseFileTab('missing-file');
			});

			expect(getSession().filePreviewTabs).toEqual([]);
			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
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

		it('file tab field handlers preserve other sessions and non-target file tabs', () => {
			const targetTab = createMockFileTab({
				id: 'target-file',
				navigationHistory: [
					{ path: '/test/first.ts', name: 'first', scrollTop: 1 },
					{ path: '/test/target.ts', name: 'target', scrollTop: 2 },
				],
				navigationIndex: 1,
			});
			const siblingTab = createMockFileTab({ id: 'sibling-file', editMode: false });
			const inactiveFileTab = createMockFileTab({ id: 'inactive-file', editMode: false });
			const activeSession = createMockSession({
				id: 'active-session',
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				filePreviewTabs: [targetTab, siblingTab],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'target-file' },
					{ type: 'file', id: 'sibling-file' },
				],
			});
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'inactive-ai' })],
				activeTabId: 'inactive-ai',
				filePreviewTabs: [inactiveFileTab],
				unifiedTabOrder: [
					{ type: 'ai', id: 'inactive-ai' },
					{ type: 'file', id: 'inactive-file' },
				],
			});
			useSessionStore.setState({
				sessions: [inactiveSession, activeSession],
				activeSessionId: 'active-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabEditModeChange('target-file', true);
				result.current.handleFileTabEditContentChange('target-file', 'draft');
				result.current.handleFileTabSearchQueryChange('target-file', 'needle');
				result.current.handleFileTabScrollPositionChange('target-file', 77);
			});

			const sessions = useSessionStore.getState().sessions;
			const updatedActive = sessions.find((session) => session.id === 'active-session')!;
			const updatedTarget = updatedActive.filePreviewTabs.find((tab) => tab.id === 'target-file')!;
			const updatedSibling = updatedActive.filePreviewTabs.find(
				(tab) => tab.id === 'sibling-file'
			)!;
			const updatedInactive = sessions.find((session) => session.id === 'inactive-session')!;

			expect(updatedTarget).toMatchObject({
				editMode: true,
				editContent: 'draft',
				searchQuery: 'needle',
				scrollTop: 77,
			});
			expect(updatedTarget.navigationHistory).toEqual([
				{ path: '/test/first.ts', name: 'first', scrollTop: 1 },
				{ path: '/test/target.ts', name: 'target', scrollTop: 77 },
			]);
			expect(updatedSibling).toMatchObject({
				id: 'sibling-file',
				editMode: false,
				editContent: undefined,
				searchQuery: '',
				scrollTop: 0,
			});
			expect(updatedInactive.filePreviewTabs[0]).toMatchObject({
				id: 'inactive-file',
				editMode: false,
				editContent: undefined,
				searchQuery: '',
				scrollTop: 0,
			});
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

		it('handleCloseCurrentTab returns none when the session has no active tab', () => {
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				activeTabId: '',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

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

		it('handleRequestTabRename clears generating state before opening rename modal', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				name: 'Generated Name',
				isGeneratingName: true,
			});
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'inactive-tab', isGeneratingName: true })],
				activeTabId: 'inactive-tab',
				unifiedTabOrder: [{ type: 'ai', id: 'inactive-tab' }],
			});
			setupSessionWithTabs([tab]);
			useSessionStore.setState((state) => ({
				sessions: [...state.sessions, inactiveSession],
			}));

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleRequestTabRename('tab-1');
			});

			const activeSession = getSession();
			const unchangedInactiveSession = useSessionStore
				.getState()
				.sessions.find((session) => session.id === 'inactive-session')!;
			expect(activeSession.aiTabs[0].isGeneratingName).toBe(false);
			expect(unchangedInactiveSession.aiTabs[0].isGeneratingName).toBe(true);
			expect(useModalStore.getState().getData('renameTab')).toMatchObject({
				tabId: 'tab-1',
				initialName: 'Generated Name',
			});
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

		it('handleTabStar persists starred state through non-Claude agent sessions', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-1' });
			const session = createMockSession({
				id: 'test-session',
				toolType: 'codex',
				projectRoot: '/repo/project',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabStar('tab-1', true);
			});

			expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
				'codex',
				'/repo/project',
				'agent-1',
				true
			);
			expect(getSession().aiTabs[0].starred).toBe(true);
		});

		it('handleTabStar logs persistence failures without reverting local state', async () => {
			const error = new Error('persist failed');
			vi.mocked(window.maestro.claude.updateSessionStarred).mockRejectedValueOnce(error);
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-1' });
			const { result } = renderWithSession([tab]);

			act(() => {
				result.current.handleTabStar('tab-1', true);
			});
			await Promise.resolve();

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to persist tab starred:', error);
			expect(getSession().aiTabs[0].starred).toBe(true);
			consoleErrorSpy.mockRestore();
		});

		it('handleTabStar logs non-Claude persistence failures without reverting local state', async () => {
			const error = new Error('agent persistence failed');
			vi.mocked(window.maestro.agentSessions.setSessionStarred).mockRejectedValueOnce(error);
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'agent-1' });
			const session = createMockSession({
				id: 'test-session',
				toolType: 'codex',
				projectRoot: '/repo/project',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'test-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabStar('tab-1', true);
			});
			await Promise.resolve();

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to persist tab starred:', error);
			expect(getSession().aiTabs[0].starred).toBe(true);
			consoleErrorSpy.mockRestore();
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

		it('logs navigation read errors and preserves the current file tab', async () => {
			const error = new Error('read failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/a.ts',
				name: 'a',
				content: 'current',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
				],
				navigationIndex: 0,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');
			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(error);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateForward();
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to navigate forward:', error);
			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/a.ts',
				content: 'current',
				navigationIndex: 0,
			});
			consoleErrorSpy.mockRestore();
		});

		it('logs back navigation read errors and preserves the current file tab', async () => {
			const error = new Error('read failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/b.ts',
				name: 'b',
				content: 'current',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
				],
				navigationIndex: 1,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');
			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(error);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateBack();
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to navigate back:', error);
			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/b.ts',
				content: 'current',
				navigationIndex: 1,
			});
			consoleErrorSpy.mockRestore();
		});

		it('logs indexed navigation read errors and preserves the current file tab', async () => {
			const error = new Error('read failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/a.ts',
				name: 'a',
				content: 'current',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 0 },
					{ path: '/b.ts', name: 'b', scrollTop: 0 },
				],
				navigationIndex: 0,
			});
			const aiTab = createMockAITab({ id: 'ai-1' });
			setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');
			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(error);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateToIndex(1);
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to navigate to index:', error);
			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/a.ts',
				content: 'current',
				navigationIndex: 0,
			});
			consoleErrorSpy.mockRestore();
		});

		it('file tab navigation guards missing active tabs and empty file reads', async () => {
			const { result } = renderHook(() => useTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateBack();
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(0);
			});
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

			const aiTab = createMockAITab({ id: 'ai-1' });
			act(() => {
				setupSessionWithTabs([aiTab], [], 'ai-1', 'missing-file');
			});
			await act(async () => {
				await result.current.handleFileTabNavigateBack();
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(0);
			});
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/b.ts',
				name: 'b',
				content: 'current',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 3 },
					{ path: '/b.ts', name: 'b', scrollTop: 5 },
					{ path: '/c.ts', name: 'c', scrollTop: 7 },
				],
				navigationIndex: 1,
			});
			act(() => {
				setupSessionWithTabs([aiTab], [fileTab], 'ai-1', 'file-1');
			});
			vi.mocked(window.maestro.fs.readFile)
				.mockResolvedValueOnce('')
				.mockResolvedValueOnce('')
				.mockResolvedValueOnce('');

			await act(async () => {
				await result.current.handleFileTabNavigateBack();
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(2);
			});

			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/b.ts',
				content: 'current',
				navigationIndex: 1,
			});
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

		it('leaves the tab unchanged when reload returns no file content', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/deleted.ts',
				content: 'original',
				editContent: 'draft',
				lastModified: 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleReloadFileTab('file-1');
			});

			const reloadedTab = getSession().filePreviewTabs[0];
			expect(reloadedTab.content).toBe('original');
			expect(reloadedTab.editContent).toBe('draft');
		});

		it('handles read errors gracefully', async () => {
			const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
			try {
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

				expect(consoleDebugSpy).toHaveBeenCalledWith(
					'[handleReloadFileTab] Failed to reload:',
					expect.any(Error)
				);
				// Content unchanged on error
				const session = getSession();
				expect(session.filePreviewTabs[0].content).toBe('original');
			} finally {
				consoleDebugSpy.mockRestore();
			}
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

		it('does not auto-refresh when file stat is unavailable', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/stat-missing.ts',
				content: 'same',
				lastModified: Date.now() - 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce(null as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			expect(getSession().activeFileTabId).toBe('file-1');
			expect(getSession().filePreviewTabs[0].content).toBe('same');
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('does not auto-refresh when file stat has no modified time', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/no-mtime.ts',
				content: 'same',
				lastModified: Date.now() - 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				size: 100,
				createdAt: new Date().toISOString(),
			} as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			expect(getSession().activeFileTabId).toBe('file-1');
			expect(getSession().filePreviewTabs[0].content).toBe('same');
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('leaves auto-refreshed content unchanged when the changed file cannot be read', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/missing-after-stat.ts',
				content: 'same',
				lastModified: Date.now() - 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				size: 100,
				createdAt: new Date().toISOString(),
				modifiedAt: new Date(Date.now() + 1000).toISOString(),
			} as any);
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			expect(getSession().activeFileTabId).toBe('file-1');
			expect(getSession().filePreviewTabs[0].content).toBe('same');
		});

		it('logs auto-refresh failures without changing file content', async () => {
			const error = new Error('stat failed');
			const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/test/error.ts',
				content: 'same',
				lastModified: Date.now() - 1000,
			});
			setupSessionWithTabs([aiTab], [fileTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
			vi.mocked(window.maestro.fs.stat).mockRejectedValueOnce(error);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('file-1');
			});

			expect(consoleDebugSpy).toHaveBeenCalledWith(
				'[handleSelectFileTab] Auto-refresh failed:',
				error
			);
			expect(getSession().filePreviewTabs[0].content).toBe('same');
			consoleDebugSpy.mockRestore();
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

		it('closes wizard tab after confirmation', () => {
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
			const modal = useModalStore.getState().modals.get('confirm');

			act(() => {
				(modal?.data as any)?.onConfirm();
			});

			expect(getSession().aiTabs).toEqual([expect.objectContaining({ id: 'tab-2' })]);
			expect(getSession().unifiedClosedTabHistory).toEqual([]);
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
	// handleTabClose — draft confirmation
	// ========================================================================

	describe('handleTabClose draft confirmation', () => {
		it('shows confirmation modal when tab has unsent draft text', () => {
			const draftTab = createMockAITab({ id: 'draft-1', inputValue: 'unsent message' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([draftTab, tab2], [], 'draft-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('draft-1');
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
			const modal = useModalStore.getState().modals.get('confirm');
			expect((modal?.data as any)?.message).toContain('unsent draft');
		});

		it('shows confirmation modal when tab has staged images', () => {
			const draftTab = createMockAITab({
				id: 'draft-1',
				inputValue: '',
				stagedImages: ['data:image/png;base64,abc'],
			});
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([draftTab, tab2], [], 'draft-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('draft-1');
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		});

		it('closes directly when tab has no draft', () => {
			const tab1 = createMockAITab({ id: 'tab-1', inputValue: '' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('tab-1');
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
		});

		it('closes tab after confirming draft modal', () => {
			const draftTab = createMockAITab({ id: 'draft-1', inputValue: 'unsent message' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([draftTab, tab2], [], 'draft-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabClose('draft-1');
			});

			// Confirm the modal
			const modal = useModalStore.getState().modals.get('confirm');
			act(() => {
				(modal?.data as any)?.onConfirm();
			});

			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-2');
		});
	});

	// ========================================================================
	// handleCloseAllTabs — draft confirmation
	// ========================================================================

	describe('handleCloseAllTabs draft confirmation', () => {
		it('shows confirmation modal when any tab has a draft', () => {
			const tab1 = createMockAITab({ id: 'tab-1', inputValue: 'draft text' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseAllTabs();
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
			const modal = useModalStore.getState().modals.get('confirm');
			expect((modal?.data as any)?.message).toContain('unsent drafts');
		});

		it('closes all tabs directly when none have drafts', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseAllTabs();
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
			const session = getSession();
			expect(session.aiTabs.length).toBe(1);
			expect(['tab-1', 'tab-2']).not.toContain(session.aiTabs[0].id);
		});
	});

	// ========================================================================
	// handleCloseOtherTabs — draft confirmation
	// ========================================================================

	describe('handleCloseOtherTabs draft confirmation', () => {
		it('shows confirmation modal when other tabs have drafts', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2', inputValue: 'draft text' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseOtherTabs();
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		});

		it('does not show modal when active tab has draft but others do not', () => {
			const tab1 = createMockAITab({ id: 'tab-1', inputValue: 'my draft' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			setupSessionWithTabs([tab1, tab2], [], 'tab-1');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseOtherTabs();
			});

			// Active tab's draft doesn't matter — it's not being closed
			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
			const session = getSession();
			expect(session.aiTabs).toHaveLength(1);
			expect(session.aiTabs[0].id).toBe('tab-1');
		});
	});

	// ========================================================================
	// handleCloseTabsLeft/Right — draft confirmation
	// ========================================================================

	describe('handleCloseTabsLeft draft confirmation', () => {
		it('shows confirmation modal when left tabs have drafts', () => {
			const tab1 = createMockAITab({ id: 'tab-1', inputValue: 'draft' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsLeft();
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		});

		it('does not close tabs when active tab moves to the left edge before confirmation', () => {
			const tab1 = createMockAITab({ id: 'tab-1', inputValue: 'draft' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsLeft();
			});
			const modal = useModalStore.getState().modals.get('confirm');
			expect(typeof (modal?.data as any)?.onConfirm).toBe('function');

			act(() => {
				setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-1');
				(modal?.data as any)?.onConfirm();
			});

			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-3']);
		});
	});

	describe('handleCloseTabsRight draft confirmation', () => {
		it('shows confirmation modal when right tabs have drafts', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3', inputValue: 'draft' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsRight();
			});

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		});

		it('does not close tabs when active tab moves to the right edge before confirmation', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3', inputValue: 'draft' });
			setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-2');

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseTabsRight();
			});
			const modal = useModalStore.getState().modals.get('confirm');
			expect(typeof (modal?.data as any)?.onConfirm).toBe('function');

			act(() => {
				setupSessionWithTabs([tab1, tab2, tab3], [], 'tab-3');
				(modal?.data as any)?.onConfirm();
			});

			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-3']);
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

		it('logs deleteMessagePair unsuccessful results', async () => {
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
			(window.maestro.claude as any).deleteMessagePair = vi.fn().mockResolvedValue({
				success: false,
				error: 'not found',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleDeleteLog('log-1');
			});
			await Promise.resolve();

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'[handleDeleteLog] Failed to delete from Claude session:',
				'not found'
			);
			consoleWarnSpy.mockRestore();
		});

		it('logs deleteMessagePair rejected promises', async () => {
			const error = new Error('delete failed');
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
			(window.maestro.claude as any).deleteMessagePair = vi.fn().mockRejectedValue(error);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleDeleteLog('log-1');
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'[handleDeleteLog] Error deleting from Claude session:',
				error
			);
			consoleErrorSpy.mockRestore();
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

		it('returns the previous user command index when deleting the final command group', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				logs: [
					{ id: 'log-1', source: 'user', text: 'first command', timestamp: Date.now() },
					{ id: 'log-2', source: 'ai', text: 'first response', timestamp: Date.now() },
					{ id: 'log-3', source: 'user', text: 'second command', timestamp: Date.now() },
					{ id: 'log-4', source: 'ai', text: 'second response', timestamp: Date.now() },
				] as any,
			});
			const { result } = renderWithSession([tab]);
			let nextIndex: number | null = null;

			act(() => {
				nextIndex = result.current.handleDeleteLog('log-3');
			});

			expect(nextIndex).toBe(0);
			expect(getSession().aiTabs[0].logs).toEqual([
				expect.objectContaining({ id: 'log-1' }),
				expect.objectContaining({ id: 'log-2' }),
			]);
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
	// Additional guard coverage
	// ========================================================================

	describe('additional guard coverage', () => {
		it('tab close menu handlers are no-ops without a session or at tab boundaries', () => {
			const { result } = renderHook(() => useTabHandlers());

			act(() => {
				result.current.handleCloseAllTabs();
				result.current.handleCloseOtherTabs();
				result.current.handleCloseTabsLeft();
				result.current.handleCloseTabsRight();
			});

			expect(useSessionStore.getState().sessions).toEqual([]);

			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			act(() => {
				setupSessionWithTabs([tab1, tab2], [], 'tab-1');
			});

			act(() => {
				result.current.handleCloseTabsLeft();
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);

			act(() => {
				setupSessionWithTabs([tab1, tab2], [], 'tab-2');
			});
			act(() => {
				result.current.handleCloseTabsRight();
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		});

		it('tab property and scroll handlers guard missing sessions and missing active AI tabs', () => {
			const { result } = renderHook(() => useTabHandlers());

			act(() => {
				result.current.handleRequestTabRename('missing');
				result.current.handleTabStar('missing', true);
				result.current.handleToggleTabReadOnlyMode();
				result.current.handleToggleTabSaveToHistory();
				result.current.handleToggleTabShowThinking();
				result.current.handleScrollPositionChange(200);
				result.current.handleAtBottomChange(false);
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
			expect(useSessionStore.getState().sessions).toEqual([]);

			const session = createMockSession({
				id: 'test-session',
				aiTabs: [],
				activeTabId: '',
				inputMode: 'ai',
				unifiedTabOrder: [],
			});
			act(() => {
				useSessionStore.setState({
					sessions: [session],
					activeSessionId: 'test-session',
				});
			});

			act(() => {
				result.current.handleTabStar('missing', true);
				result.current.handleToggleTabReadOnlyMode();
				result.current.handleToggleTabSaveToHistory();
				result.current.handleToggleTabShowThinking();
				result.current.handleScrollPositionChange(300);
				result.current.handleAtBottomChange(true);
			});

			expect(getSession().aiTabs).toEqual([]);
			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
		});

		it('mapped tab and file field handlers preserve inactive sessions', () => {
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'inactive-ai', hasUnread: false })],
				activeTabId: 'inactive-ai',
				filePreviewTabs: [createMockFileTab({ id: 'inactive-file', content: 'inactive' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'inactive-ai' },
					{ type: 'file', id: 'inactive-file' },
				],
			});
			const activeFile = createMockFileTab({
				id: 'active-file',
				content: 'old file',
				navigationHistory: [{ path: '/active.ts', name: 'active', scrollTop: 1 }],
				navigationIndex: 0,
			});
			const activeSession = createMockSession({
				id: 'active-session',
				aiTabs: [
					createMockAITab({ id: 'active-ai-1' }),
					createMockAITab({ id: 'active-ai-2', hasUnread: false }),
				],
				activeTabId: 'active-ai-1',
				filePreviewTabs: [activeFile],
				activeFileTabId: 'active-file',
				unifiedTabOrder: [
					{ type: 'ai', id: 'active-ai-1' },
					{ type: 'ai', id: 'active-ai-2' },
					{ type: 'file', id: 'active-file' },
				],
			});
			useSessionStore.setState({
				sessions: [inactiveSession, activeSession],
				activeSessionId: 'active-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabSelect('active-ai-2');
				result.current.handleTabMarkUnread('active-ai-2');
				result.current.handleFileTabEditModeChange('active-file', true);
				result.current.handleFileTabEditContentChange('active-file', 'draft', 'saved file');
				result.current.handleFileTabScrollPositionChange('active-file', 44);
				result.current.handleFileTabSearchQueryChange('active-file', 'needle');
			});

			let sessions = useSessionStore.getState().sessions;
			expect(sessions[0]).toBe(inactiveSession);
			expect(sessions[1].activeTabId).toBe('active-ai-2');
			expect(sessions[1].aiTabs.find((tab) => tab.id === 'active-ai-2')?.hasUnread).toBe(true);
			expect(sessions[1].filePreviewTabs[0]).toMatchObject({
				editMode: true,
				editContent: 'draft',
				content: 'saved file',
				scrollTop: 44,
				searchQuery: 'needle',
			});

			act(() => {
				result.current.handleCloseFileTab('active-file');
			});
			const modal = useModalStore.getState().modals.get('confirm');
			act(() => {
				(modal?.data as any)?.onConfirm();
			});

			sessions = useSessionStore.getState().sessions;
			expect(sessions[0]).toBe(inactiveSession);
			expect(sessions[1].filePreviewTabs).toEqual([]);
		});

		it('mapped tab close, reorder, toggle, and log handlers preserve inactive sessions', () => {
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'inactive-ai', logs: [] })],
				activeTabId: 'inactive-ai',
				filePreviewTabs: [createMockFileTab({ id: 'inactive-file', content: 'inactive' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'inactive-ai' },
					{ type: 'file', id: 'inactive-file' },
				],
			});
			const makeActiveSession = (overrides: Partial<Session> = {}) => {
				const firstTab = createMockAITab({
					id: 'active-ai-1',
					agentSessionId: 'agent-1',
					logs: [
						{ id: 'log-1', timestamp: 1, source: 'user', text: 'run command' },
						{ id: 'log-2', timestamp: 2, source: 'ai', text: 'done' },
					],
				});
				const secondTab = createMockAITab({ id: 'active-ai-2', logs: [] });
				const fileTab = createMockFileTab({ id: 'active-file', content: 'active file' });
				return createMockSession({
					id: 'active-session',
					aiTabs: [firstTab, secondTab],
					activeTabId: firstTab.id,
					aiCommandHistory: ['run command'],
					shellLogs: [
						{ id: 'shell-1', timestamp: 1, source: 'user', text: 'npm test' },
						{ id: 'shell-2', timestamp: 2, source: 'stdout', text: 'pass' },
					],
					shellCommandHistory: ['npm test'],
					filePreviewTabs: [fileTab],
					activeFileTabId: null,
					filePreviewHistory: [{ path: '/old.ts', name: 'old' }],
					filePreviewHistoryIndex: 0,
					unifiedTabOrder: [
						{ type: 'ai', id: firstTab.id },
						{ type: 'ai', id: secondTab.id },
						{ type: 'file', id: fileTab.id },
					],
					...overrides,
				});
			};
			const { result } = renderHook(() => useTabHandlers());
			const runPreservationCase = (session: Session, action: () => void) => {
				act(() => {
					useModalStore.getState().closeAll();
					useSessionStore.setState({
						sessions: [inactiveSession, session],
						activeSessionId: 'active-session',
					});
				});

				act(action);

				expect(useSessionStore.getState().sessions[0]).toBe(inactiveSession);
			};

			runPreservationCase(makeActiveSession(), () => result.current.handleNewAgentSession());
			runPreservationCase(makeActiveSession(), () => result.current.handleNewTab());
			runPreservationCase(makeActiveSession(), () => result.current.handleUnifiedTabReorder(0, 1));
			runPreservationCase(makeActiveSession(), () => result.current.handleTabClose('active-ai-2'));
			runPreservationCase(makeActiveSession(), () => result.current.handleCloseAllTabs());
			runPreservationCase(makeActiveSession(), () => result.current.handleCloseOtherTabs());
			runPreservationCase(makeActiveSession({ activeTabId: 'active-ai-2' }), () =>
				result.current.handleCloseTabsLeft()
			);
			runPreservationCase(makeActiveSession(), () => result.current.handleCloseTabsRight());
			runPreservationCase(
				makeActiveSession({ activeFileTabId: 'active-file' }),
				() => void result.current.handleCloseCurrentTab()
			);
			runPreservationCase(makeActiveSession(), () => void result.current.handleDeleteLog('log-1'));
			runPreservationCase(
				makeActiveSession({ inputMode: 'terminal' }),
				() => void result.current.handleDeleteLog('shell-1')
			);
			runPreservationCase(makeActiveSession(), () => result.current.handleTabReorder(0, 1));
			runPreservationCase(makeActiveSession(), () =>
				result.current.handleUpdateTabByClaudeSessionId('agent-1', { name: 'Renamed' })
			);
			runPreservationCase(makeActiveSession(), () =>
				result.current.handleUpdateTabByClaudeSessionId('missing-agent', { name: 'Noop' })
			);
			runPreservationCase(makeActiveSession(), () =>
				result.current.handleTabStar('active-ai-1', true)
			);
			runPreservationCase(makeActiveSession(), () => result.current.handleToggleTabReadOnlyMode());
			runPreservationCase(makeActiveSession(), () => result.current.handleToggleTabSaveToHistory());
			runPreservationCase(makeActiveSession(), () => result.current.handleToggleTabShowThinking());
			runPreservationCase(makeActiveSession(), () => result.current.handleScrollPositionChange(77));
			runPreservationCase(makeActiveSession(), () => result.current.handleAtBottomChange(false));
			runPreservationCase(makeActiveSession(), () =>
				result.current.handleClearFilePreviewHistory()
			);
		});

		it('reload and auto-refresh updates only the active session', async () => {
			const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(5000);
			try {
				const inactiveSession = createMockSession({
					id: 'inactive-session',
					aiTabs: [createMockAITab({ id: 'inactive-ai' })],
					activeTabId: 'inactive-ai',
					filePreviewTabs: [createMockFileTab({ id: 'inactive-file', content: 'inactive' })],
					unifiedTabOrder: [
						{ type: 'ai', id: 'inactive-ai' },
						{ type: 'file', id: 'inactive-file' },
					],
				});
				const activeSession = createMockSession({
					id: 'active-session',
					aiTabs: [createMockAITab({ id: 'active-ai' })],
					activeTabId: 'active-ai',
					filePreviewTabs: [
						createMockFileTab({
							id: 'active-file',
							path: '/active.ts',
							content: 'old',
							editContent: 'draft',
							lastModified: 1000,
						}),
					],
					activeFileTabId: 'active-file',
					unifiedTabOrder: [
						{ type: 'ai', id: 'active-ai' },
						{ type: 'file', id: 'active-file' },
					],
				});
				useSessionStore.setState({
					sessions: [inactiveSession, activeSession],
					activeSessionId: 'active-session',
				});
				useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
				vi.mocked(window.maestro.fs.readFile)
					.mockResolvedValueOnce('reloaded')
					.mockResolvedValueOnce('auto refreshed');
				vi.mocked(window.maestro.fs.stat)
					.mockResolvedValueOnce({ size: 1, createdAt: new Date().toISOString() } as any)
					.mockResolvedValueOnce({
						size: 1,
						createdAt: new Date().toISOString(),
						modifiedAt: new Date(6000).toISOString(),
					} as any);

				const { result } = renderHook(() => useTabHandlers());
				await act(async () => {
					await result.current.handleReloadFileTab('active-file');
				});

				let sessions = useSessionStore.getState().sessions;
				expect(sessions[0]).toBe(inactiveSession);
				expect(sessions[1].filePreviewTabs[0]).toMatchObject({
					content: 'reloaded',
					editContent: undefined,
					lastModified: 5000,
				});

				await act(async () => {
					await result.current.handleSelectFileTab('active-file');
				});

				sessions = useSessionStore.getState().sessions;
				expect(sessions[0]).toBe(inactiveSession);
				expect(sessions[1].filePreviewTabs[0]).toMatchObject({
					content: 'auto refreshed',
					lastModified: 6000,
				});
			} finally {
				dateSpy.mockRestore();
			}
		});

		it('file history navigation restores default scroll and preserves inactive sessions', async () => {
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				aiTabs: [createMockAITab({ id: 'inactive-ai' })],
				activeTabId: 'inactive-ai',
				filePreviewTabs: [createMockFileTab({ id: 'inactive-file', content: 'inactive' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'inactive-ai' },
					{ type: 'file', id: 'inactive-file' },
				],
			});
			const activeFile = createMockFileTab({
				id: 'active-file',
				path: '/b.ts',
				name: 'b',
				content: 'b current',
				navigationHistory: [
					{ path: '/a.ts', name: 'a' } as any,
					{ path: '/b.ts', name: 'b' } as any,
					{ path: '/c.ts', name: 'c' } as any,
				],
				navigationIndex: 1,
			});
			const activeSession = createMockSession({
				id: 'active-session',
				aiTabs: [createMockAITab({ id: 'active-ai' })],
				activeTabId: 'active-ai',
				filePreviewTabs: [activeFile],
				activeFileTabId: 'active-file',
				unifiedTabOrder: [
					{ type: 'ai', id: 'active-ai' },
					{ type: 'file', id: 'active-file' },
				],
			});
			useSessionStore.setState({
				sessions: [inactiveSession, activeSession],
				activeSessionId: 'active-session',
			});
			vi.mocked(window.maestro.fs.readFile)
				.mockResolvedValueOnce('a content')
				.mockResolvedValueOnce('b content')
				.mockResolvedValueOnce('c content');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateBack();
			});

			let sessions = useSessionStore.getState().sessions;
			expect(sessions[0]).toBe(inactiveSession);
			expect(sessions[1].filePreviewTabs[0]).toMatchObject({
				path: '/a.ts',
				content: 'a content',
				scrollTop: 0,
				navigationIndex: 0,
			});

			await act(async () => {
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(2);
			});

			sessions = useSessionStore.getState().sessions;
			expect(sessions[0]).toBe(inactiveSession);
			expect(sessions[1].filePreviewTabs[0]).toMatchObject({
				path: '/c.ts',
				content: 'c content',
				scrollTop: 0,
				navigationIndex: 2,
			});
		});

		it('handleReloadFileTab is a no-op when no session is active', async () => {
			const { result } = renderHook(() => useTabHandlers());

			await act(async () => {
				await result.current.handleReloadFileTab('missing-file');
			});

			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions).toEqual([]);
		});

		it('close and history handlers guard missing active entities', () => {
			const { result } = renderHook(() => useTabHandlers());

			act(() => {
				expect(result.current.handleDeleteLog('missing-log')).toBeNull();
				result.current.handleClearFilePreviewHistory();
			});

			expect(useSessionStore.getState().sessions).toEqual([]);

			const staleFileSession = createMockSession({
				id: 'active-session',
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
				filePreviewTabs: [],
				activeFileTabId: 'missing-file',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			act(() => {
				useSessionStore.setState({
					sessions: [staleFileSession],
					activeSessionId: 'active-session',
				});
			});

			act(() => {
				expect(result.current.handleCloseCurrentTab()).toEqual({
					type: 'file',
					tabId: 'missing-file',
				});
				result.current.handleTabClose('missing-ai-tab');
			});

			expect(useSessionStore.getState().sessions[0]).toBe(staleFileSession);
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
	// Branch completion coverage
	// ========================================================================

	describe('branch completion coverage', () => {
		it('updates file scroll history via default index and preserves invalid history indexes', () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fallbackTab = createMockFileTab({
				id: 'fallback-file',
				navigationHistory: [{ path: '/fallback.ts', name: 'fallback', scrollTop: 5 }],
				navigationIndex: undefined,
			});
			const invalidIndexTab = createMockFileTab({
				id: 'invalid-index-file',
				navigationHistory: [{ path: '/invalid.ts', name: 'invalid', scrollTop: 7 }],
				navigationIndex: 3,
			});
			setupSessionWithTabs([aiTab], [fallbackTab, invalidIndexTab]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleFileTabScrollPositionChange('fallback-file', 111);
				result.current.handleFileTabScrollPositionChange('invalid-index-file', 222);
			});

			const session = getSession();
			expect(session.filePreviewTabs[0].scrollTop).toBe(111);
			expect(session.filePreviewTabs[0].navigationHistory?.[0].scrollTop).toBe(111);
			expect(session.filePreviewTabs[1].scrollTop).toBe(222);
			expect(session.filePreviewTabs[1].navigationHistory?.[0].scrollTop).toBe(7);
		});

		it('reloads one file tab without changing sibling file tabs', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const targetTab = createMockFileTab({
				id: 'target-file',
				path: '/target.ts',
				content: 'old target',
				editContent: 'draft target',
			});
			const siblingTab = createMockFileTab({
				id: 'sibling-file',
				path: '/sibling.ts',
				content: 'sibling content',
				editContent: 'sibling draft',
			});
			setupSessionWithTabs([aiTab], [targetTab, siblingTab]);
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('reloaded target');
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				modifiedAt: '2026-01-02T00:00:00.000Z',
			} as any);

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleReloadFileTab('target-file');
			});

			const session = getSession();
			expect(session.filePreviewTabs[0]).toMatchObject({
				content: 'reloaded target',
				editContent: undefined,
			});
			expect(session.filePreviewTabs[1]).toMatchObject({
				content: 'sibling content',
				editContent: 'sibling draft',
			});
		});

		it('auto-refreshes one selected file tab without changing sibling file tabs', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const targetTab = createMockFileTab({
				id: 'target-file',
				path: '/target.ts',
				content: 'stale target',
				lastModified: 1,
			});
			const siblingTab = createMockFileTab({
				id: 'sibling-file',
				path: '/sibling.ts',
				content: 'sibling content',
				lastModified: 1,
			});
			setupSessionWithTabs([aiTab], [targetTab, siblingTab]);
			useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
			vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
				modifiedAt: '2026-01-03T00:00:00.000Z',
			} as any);
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('fresh target');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleSelectFileTab('target-file');
			});

			const session = getSession();
			expect(session.activeFileTabId).toBe('target-file');
			expect(session.filePreviewTabs[0].content).toBe('fresh target');
			expect(session.filePreviewTabs[1].content).toBe('sibling content');
		});

		it('returns AI close metadata with false wizard and draft flags when active tab is stale', () => {
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
				activeTabId: 'missing-tab',
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'test-session' });

			const { result } = renderHook(() => useTabHandlers());

			expect(result.current.handleCloseCurrentTab()).toEqual({
				type: 'ai',
				tabId: 'missing-tab',
				isWizardTab: false,
				hasDraft: false,
			});
		});

		it('skips already-removed duplicate tab ids when closing all tabs', () => {
			const firstDuplicate = createMockAITab({ id: 'duplicate-tab' });
			const secondDuplicate = createMockAITab({ id: 'duplicate-tab' });
			setupSessionWithTabs([firstDuplicate, secondDuplicate]);

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleCloseAllTabs();
			});

			expect(getSession().aiTabs).toHaveLength(1);
			expect(getSession().aiTabs[0].id).not.toBe('duplicate-tab');
		});

		it('deletes AI log groups after scanning past non-user logs', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				logs: [
					{ id: 'log-0', source: 'ai', text: 'preface', timestamp: 1 },
					{ id: 'log-1', source: 'user', text: 'first command', timestamp: 2 },
					{ id: 'log-2', source: 'ai', text: 'first response', timestamp: 3 },
					{ id: 'log-3', source: 'user', text: 'second command', timestamp: 4 },
					{ id: 'log-4', source: 'ai', text: 'second response', timestamp: 5 },
				] as any,
			});
			const { result } = renderWithSession([tab]);
			let nextIndex: number | null = null;

			act(() => {
				nextIndex = result.current.handleDeleteLog('log-3');
			});

			expect(nextIndex).toBe(1);
			expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['log-0', 'log-1', 'log-2']);
		});

		it('uses empty AI logs when the active AI tab is missing', () => {
			const session = createMockSession({
				id: 'test-session',
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				activeTabId: 'missing-tab',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'test-session' });

			const { result } = renderHook(() => useTabHandlers());

			expect(result.current.handleDeleteLog('log-1')).toBeNull();
		});

		it('uses empty AI logs when the active AI tab has no logs array', () => {
			const tab = createMockAITab({ id: 'tab-1', logs: undefined as any });
			const { result } = renderWithSession([tab]);

			expect(result.current.handleDeleteLog('log-1')).toBeNull();
		});

		it('deletes terminal logs when shell command history is missing', () => {
			const session = createMockSession({
				id: 'test-session',
				inputMode: 'terminal',
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
				shellLogs: [
					{ id: 'shell-1', source: 'user', text: 'ls', timestamp: 1 },
					{ id: 'shell-2', source: 'system', text: 'listing', timestamp: 2 },
					{ id: 'shell-3', source: 'user', text: 'pwd', timestamp: 3 },
				] as any,
				shellCommandHistory: undefined as any,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'test-session' });

			const { result } = renderHook(() => useTabHandlers());
			let nextIndex: number | null = null;
			act(() => {
				nextIndex = result.current.handleDeleteLog('shell-1');
			});

			const updated = getSession() as any;
			expect(nextIndex).toBe(0);
			expect(updated.shellLogs.map((log: any) => log.id)).toEqual(['shell-3']);
			expect(updated.shellCommandHistory).toEqual([]);
		});

		it('clears generating state only on the renamed tab', () => {
			const tab = createMockAITab({ id: 'tab-1', isGeneratingName: true } as any);
			const sibling = createMockAITab({ id: 'tab-2', isGeneratingName: true } as any);
			const { result } = renderWithSession([tab, sibling], [], 'tab-1');

			act(() => {
				result.current.handleRequestTabRename('tab-1');
			});

			expect(getSession().aiTabs.find((t) => t.id === 'tab-1')?.isGeneratingName).toBe(false);
			expect(getSession().aiTabs.find((t) => t.id === 'tab-2')?.isGeneratingName).toBe(true);
			expect(useModalStore.getState().isOpen('renameTab')).toBe(true);
		});

		it('updates starred state by Claude session id without overwriting an absent name update', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'agent-1',
				name: 'Original',
				starred: false,
			});
			const sibling = createMockAITab({
				id: 'tab-2',
				agentSessionId: 'agent-2',
				name: 'Sibling',
				starred: false,
			});
			const { result } = renderWithSession([tab, sibling]);

			act(() => {
				result.current.handleUpdateTabByClaudeSessionId('agent-1', { starred: true });
			});

			expect(getSession().aiTabs[0]).toMatchObject({ name: 'Original', starred: true });
			expect(getSession().aiTabs[1]).toMatchObject({ name: 'Sibling', starred: false });
		});

		it('stars Claude tabs through the default agent id when the session tool type is empty', () => {
			const target = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'agent-1',
				starred: false,
			});
			const sibling = createMockAITab({
				id: 'tab-2',
				agentSessionId: 'agent-2',
				starred: false,
			});
			const session = createMockSession({
				id: 'test-session',
				toolType: '' as any,
				aiTabs: [target, sibling],
				activeTabId: 'tab-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'test-session' });

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabStar('tab-1', true);
			});

			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/test',
				'agent-1',
				true
			);
			expect(getSession().aiTabs[0].starred).toBe(true);
			expect(getSession().aiTabs[1].starred).toBe(false);
		});

		it('leaves duplicate active-session records unchanged when they do not contain the starred tab', () => {
			const targetSession = createMockSession({
				id: 'duplicate-session',
				aiTabs: [
					createMockAITab({
						id: 'tab-1',
						agentSessionId: 'agent-1',
						starred: false,
					}),
				],
				activeTabId: 'tab-1',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			const staleDuplicateSession = createMockSession({
				id: 'duplicate-session',
				aiTabs: [createMockAITab({ id: 'tab-1', agentSessionId: null, starred: false })],
				activeTabId: 'tab-1',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			useSessionStore.setState({
				sessions: [targetSession, staleDuplicateSession],
				activeSessionId: 'duplicate-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleTabStar('tab-1', true);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].aiTabs[0].starred).toBe(true);
			expect(sessions[1].aiTabs[0].starred).toBe(false);
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledTimes(1);
		});

		it('updates terminal scroll only on the active terminal session and ignores at-bottom changes', () => {
			const activeSession = createMockSession({
				id: 'active-session',
				inputMode: 'terminal',
				terminalScrollTop: 0,
				aiTabs: [createMockAITab({ id: 'tab-1', isAtBottom: false })],
				activeTabId: 'tab-1',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			const inactiveSession = createMockSession({
				id: 'inactive-session',
				inputMode: 'terminal',
				terminalScrollTop: 5,
				aiTabs: [createMockAITab({ id: 'tab-2' })],
				activeTabId: 'tab-2',
				unifiedTabOrder: [{ type: 'ai', id: 'tab-2' }],
			});
			useSessionStore.setState({
				sessions: [activeSession, inactiveSession],
				activeSessionId: 'active-session',
			});

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleScrollPositionChange(321);
				result.current.handleAtBottomChange(true);
			});

			const sessions = useSessionStore.getState().sessions;
			expect((sessions[0] as any).terminalScrollTop).toBe(321);
			expect(sessions[0].aiTabs[0].isAtBottom).toBe(false);
			expect((sessions[1] as any).terminalScrollTop).toBe(5);
		});

		it('navigates file history while preserving sibling file tabs', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const fileTab = createMockFileTab({
				id: 'file-1',
				path: '/b.ts',
				content: 'B',
				navigationHistory: [
					{ path: '/a.ts', name: 'A', scrollTop: 1 },
					{ path: '/b.ts', name: 'B', scrollTop: 2 },
					{ path: '/c.ts', name: 'C', scrollTop: 3 },
				],
				navigationIndex: 1,
			});
			const siblingTab = createMockFileTab({
				id: 'file-2',
				path: '/sibling.ts',
				content: 'sibling',
			});
			setupSessionWithTabs([aiTab], [fileTab, siblingTab], 'ai-1', 'file-1');
			vi.mocked(window.maestro.fs.readFile)
				.mockResolvedValueOnce('A content')
				.mockResolvedValueOnce('B content')
				.mockResolvedValueOnce('C content');

			const { result } = renderHook(() => useTabHandlers());
			await act(async () => {
				await result.current.handleFileTabNavigateBack();
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(2);
			});

			const session = getSession();
			expect(session.filePreviewTabs[0]).toMatchObject({
				path: '/c.ts',
				content: 'C content',
				navigationIndex: 2,
			});
			expect(session.filePreviewTabs[1]).toMatchObject({
				path: '/sibling.ts',
				content: 'sibling',
			});
		});

		it('uses empty navigation history and fallback indexes without reading files', async () => {
			const aiTab = createMockAITab({ id: 'ai-1' });
			const noHistoryTab = createMockFileTab({
				id: 'file-1',
				navigationHistory: undefined,
				navigationIndex: undefined,
			});
			const fallbackIndexTab = createMockFileTab({
				id: 'file-2',
				navigationHistory: [
					{ path: '/a.ts', name: 'A', scrollTop: 1 },
					{ path: '/b.ts', name: 'B', scrollTop: 2 },
				],
				navigationIndex: undefined,
			});
			setupSessionWithTabs([aiTab], [noHistoryTab, fallbackIndexTab], 'ai-1', 'file-1');
			const { result } = renderHook(() => useTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateBack();
				await result.current.handleFileTabNavigateForward();
				await result.current.handleFileTabNavigateToIndex(0);
			});

			act(() => {
				useSessionStore.setState({
					sessions: [
						{
							...getSession(),
							activeFileTabId: 'file-2',
						},
					],
					activeSessionId: 'test-session',
				});
			});
			await act(async () => {
				await result.current.handleFileTabNavigateForward();
			});

			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('ignores orphan AI refs while closing other, left, and right unified tabs', () => {
			const tab1 = createMockAITab({ id: 'tab-1' });
			const tab2 = createMockAITab({ id: 'tab-2' });
			const tab3 = createMockAITab({ id: 'tab-3' });
			const fileLeft = createMockFileTab({ id: 'file-left' });
			const fileRight = createMockFileTab({ id: 'file-right' });
			const buildSession = () =>
				createMockSession({
					id: 'test-session',
					aiTabs: [tab1, tab2, tab3],
					activeTabId: 'tab-2',
					filePreviewTabs: [fileLeft, fileRight],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: 'orphan-left' },
						{ type: 'ai', id: 'tab-1' },
						{ type: 'file', id: 'file-left' },
						{ type: 'ai', id: 'tab-2' },
						{ type: 'file', id: 'file-right' },
						{ type: 'ai', id: 'orphan-right' },
						{ type: 'ai', id: 'tab-3' },
					],
				});
			const { result } = renderHook(() => useTabHandlers());

			act(() => {
				useSessionStore.setState({ sessions: [buildSession()], activeSessionId: 'test-session' });
			});
			act(() => {
				result.current.handleCloseOtherTabs();
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-2']);
			expect(getSession().filePreviewTabs).toEqual([]);

			act(() => {
				useSessionStore.setState({ sessions: [buildSession()], activeSessionId: 'test-session' });
			});
			act(() => {
				result.current.handleCloseTabsLeft();
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-2', 'tab-3']);
			expect(getSession().filePreviewTabs.map((tab) => tab.id)).toEqual(['file-right']);

			act(() => {
				useSessionStore.setState({ sessions: [buildSession()], activeSessionId: 'test-session' });
			});
			act(() => {
				result.current.handleCloseTabsRight();
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
			expect(getSession().filePreviewTabs.map((tab) => tab.id)).toEqual(['file-left']);
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

		it('does not create AI tabs when the active session id is stale', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			setupSessionWithTabs([tab]);
			useSessionStore.setState({ activeSessionId: 'missing-session' });

			const { result } = renderHook(() => useTabHandlers());
			act(() => {
				result.current.handleNewAgentSession();
				result.current.handleNewTab();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(1);
			expect(sessions[0].aiTabs).toHaveLength(1);
			expect(sessions[0].aiTabs[0].id).toBe('tab-1');
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
