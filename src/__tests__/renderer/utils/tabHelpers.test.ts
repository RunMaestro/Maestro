/**
 * Tests for tabHelpers.ts - AI multi-tab management utilities
 *
 * Functions tested:
 * - getActiveTab
 * - createTab
 * - closeTab (including skipHistory option for wizard tabs)
 * - reopenClosedTab
 * - closeFileTab
 * - addAiTabToUnifiedHistory
 * - reopenUnifiedClosedTab
 * - setActiveTab
 * - getWriteModeTab
 * - getBusyTabs
 * - getNavigableTabs
 * - navigateToNextTab
 * - navigateToPrevTab
 * - navigateToTabByIndex
 * - navigateToLastTab
 * - navigateToUnifiedTabByIndex
 * - navigateToLastUnifiedTab
 * - navigateToNextUnifiedTab
 * - navigateToPrevUnifiedTab
 * - createMergedSession
 * - hasActiveWizard
 * - extractQuickTabName
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	getActiveTab,
	createTab,
	closeTab,
	reopenClosedTab,
	closeFileTab,
	addAiTabToUnifiedHistory,
	reopenUnifiedClosedTab,
	setActiveTab,
	getWriteModeTab,
	getBusyTabs,
	getNavigableTabs,
	navigateToNextTab,
	navigateToPrevTab,
	navigateToTabByIndex,
	navigateToLastTab,
	navigateToUnifiedTabByIndex,
	navigateToLastUnifiedTab,
	navigateToNextUnifiedTab,
	navigateToPrevUnifiedTab,
	createMergedSession,
	hasActiveWizard,
	extractQuickTabName,
	buildUnifiedTabs,
	ensureInUnifiedTabOrder,
	getRepairedUnifiedTabOrder,
} from '../../../renderer/utils/tabHelpers';
import type { LogEntry } from '../../../renderer/types';
import type {
	Session,
	AITab,
	ClosedTab,
	ClosedTabEntry,
	FilePreviewTab,
} from '../../../renderer/types';

// Mock the generateId function to return predictable IDs
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-generated-id'),
}));

// Helper to create a minimal Session for testing
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
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
	};
}

// Helper to create a minimal AITab for testing
function createMockTab(overrides: Partial<AITab> = {}): AITab {
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
		...overrides,
	};
}

// Helper to create a minimal FilePreviewTab for testing
function createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-tab-1',
		path: '/test/file.ts',
		name: 'file',
		extension: '.ts',
		content: '// test content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
		...overrides,
	};
}

describe('tabHelpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getActiveTab', () => {
		it('returns undefined for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [], activeTabId: '' });
			expect(getActiveTab(session)).toBeUndefined();
		});

		it('returns undefined for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(getActiveTab(session)).toBeUndefined();
		});

		it('returns the active tab when activeTabId matches', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
			});

			const result = getActiveTab(session);
			expect(result).toBe(tab2);
		});

		it('returns first tab as fallback when activeTabId does not match', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'non-existent-id',
			});

			const result = getActiveTab(session);
			expect(result).toBe(tab1);
		});
	});

	describe('createTab', () => {
		it('creates a new tab with default options', () => {
			const session = createMockSession({ aiTabs: [] });

			const result = createTab(session);

			expect(result.tab).toMatchObject({
				id: 'mock-generated-id',
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				state: 'idle',
				saveToHistory: true,
			});
			expect(result.tab.createdAt).toBeDefined();
			expect(result.session.aiTabs).toHaveLength(1);
			expect(result.session.activeTabId).toBe('mock-generated-id');
		});

		it('creates a tab with custom options', () => {
			const session = createMockSession({ aiTabs: [] });
			const options = {
				agentSessionId: 'claude-123',
				name: 'My Tab',
				starred: true,
				logs: [{ id: 'log-1', timestamp: 123, source: 'user' as const, text: 'test' }],
				usageStats: {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 200000,
				},
				saveToHistory: true,
			};

			const result = createTab(session, options);

			expect(result.tab.agentSessionId).toBe('claude-123');
			expect(result.tab.name).toBe('My Tab');
			expect(result.tab.starred).toBe(true);
			expect(result.tab.logs).toHaveLength(1);
			expect(result.tab.usageStats).toEqual(options.usageStats);
			expect(result.tab.saveToHistory).toBe(true);
		});

		it('creates a tab with showThinking option', () => {
			const session = createMockSession({ aiTabs: [] });

			// Default should be 'off'
			const defaultResult = createTab(session);
			expect(defaultResult.tab.showThinking).toBe('off');

			// Explicit 'on'
			const trueResult = createTab(session, { showThinking: 'on' });
			expect(trueResult.tab.showThinking).toBe('on');

			// Explicit 'off'
			const falseResult = createTab(session, { showThinking: 'off' });
			expect(falseResult.tab.showThinking).toBe('off');

			// Explicit 'sticky'
			const stickyResult = createTab(session, { showThinking: 'sticky' });
			expect(stickyResult.tab.showThinking).toBe('sticky');
		});

		it('appends tab to existing tabs', () => {
			const existingTab = createMockTab({ id: 'existing-tab' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-tab',
			});

			const result = createTab(session);

			expect(result.session.aiTabs).toHaveLength(2);
			expect(result.session.aiTabs[0]).toBe(existingTab);
			expect(result.session.aiTabs[1]).toBe(result.tab);
		});

		it('sets new tab as active', () => {
			const existingTab = createMockTab({ id: 'existing-tab' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-tab',
			});

			const result = createTab(session);

			expect(result.session.activeTabId).toBe(result.tab.id);
		});
	});

	describe('closeTab', () => {
		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(closeTab(session, 'any-id')).toBeNull();
		});

		it('returns null for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(closeTab(session, 'any-id')).toBeNull();
		});

		it('returns null if tab is not found', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(closeTab(session, 'non-existent')).toBeNull();
		});

		it('closes tab and adds to history', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				closedTabHistory: [],
			});

			const result = closeTab(session, 'tab-1');

			expect(result).not.toBeNull();
			expect(result!.closedTab.tab.id).toBe('tab-1');
			expect(result!.closedTab.index).toBe(0);
			expect(result!.closedTab.closedAt).toBeDefined();
			expect(result!.session.aiTabs).toHaveLength(1);
			expect(result!.session.aiTabs[0].id).toBe('tab-2');
		});

		it('selects previous tab (to the left) when active tab is closed', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-2',
			});

			const result = closeTab(session, 'tab-2');

			// Should select tab-1 (to the left), not tab-3 (to the right)
			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('selects previous tab when closing last tab in list', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
			});

			const result = closeTab(session, 'tab-2');

			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('selects new first tab when closing first tab in list', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = closeTab(session, 'tab-1');

			// When closing the first tab, select the new first tab (was previously to the right)
			expect(result!.session.activeTabId).toBe('tab-2');
		});

		it('creates fresh tab when closing the only tab', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			const result = closeTab(session, 'tab-1');

			expect(result!.session.aiTabs).toHaveLength(1);
			expect(result!.session.aiTabs[0].id).toBe('mock-generated-id');
			expect(result!.session.activeTabId).toBe('mock-generated-id');
		});

		it('maintains max 25 items in closed tab history', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const existingHistory: ClosedTab[] = Array.from({ length: 25 }, (_, i) => ({
				tab: createMockTab({ id: `old-tab-${i}` }),
				index: 0,
				closedAt: Date.now() - i * 1000,
			}));
			const session = createMockSession({
				aiTabs: [tab, createMockTab({ id: 'tab-2' })],
				activeTabId: 'tab-1',
				closedTabHistory: existingHistory,
			});

			const result = closeTab(session, 'tab-1');

			expect(result!.session.closedTabHistory).toHaveLength(25);
			expect(result!.session.closedTabHistory[0].tab.id).toBe('tab-1');
		});

		it('preserves activeTabId when closing non-active tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			const result = closeTab(session, 'tab-2');

			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('skips adding to history when skipHistory option is true', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				closedTabHistory: [],
			});

			const result = closeTab(session, 'tab-1', false, { skipHistory: true });

			expect(result).not.toBeNull();
			expect(result!.session.aiTabs).toHaveLength(1);
			expect(result!.session.closedTabHistory).toHaveLength(0); // Not added to history
		});

		it('adds to history when skipHistory option is false', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				closedTabHistory: [],
			});

			const result = closeTab(session, 'tab-1', false, { skipHistory: false });

			expect(result).not.toBeNull();
			expect(result!.session.closedTabHistory).toHaveLength(1); // Added to history
			expect(result!.session.closedTabHistory[0].tab.id).toBe('tab-1');
		});

		it('adds to history by default when no options provided', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				closedTabHistory: [],
			});

			const result = closeTab(session, 'tab-1');

			expect(result).not.toBeNull();
			expect(result!.session.closedTabHistory).toHaveLength(1); // Added to history by default
		});

		it('preserves existing history when skipHistory is true', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const existingHistory: ClosedTab[] = [
				{ tab: createMockTab({ id: 'old-tab' }), index: 0, closedAt: Date.now() - 1000 },
			];
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				closedTabHistory: existingHistory,
			});

			const result = closeTab(session, 'tab-1', false, { skipHistory: true });

			expect(result).not.toBeNull();
			expect(result!.session.closedTabHistory).toHaveLength(1); // Still only the old one
			expect(result!.session.closedTabHistory[0].tab.id).toBe('old-tab');
		});
	});

	describe('reopenClosedTab', () => {
		it('returns null when no closed tabs exist', () => {
			const session = createMockSession({ closedTabHistory: [] });
			expect(reopenClosedTab(session)).toBeNull();
		});

		it('returns null when closedTabHistory is undefined', () => {
			const session = createMockSession();
			(session as any).closedTabHistory = undefined;
			expect(reopenClosedTab(session)).toBeNull();
		});

		it('restores tab at original index', () => {
			const existingTab = createMockTab({ id: 'existing' });
			const closedTab = createMockTab({
				id: 'closed-tab',
				agentSessionId: null,
				name: 'Restored Tab',
			});
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing',
				closedTabHistory: [{ tab: closedTab, index: 0, closedAt: Date.now() }],
			});

			const result = reopenClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.aiTabs).toHaveLength(2);
			expect(result!.session.aiTabs[0].name).toBe('Restored Tab');
			expect(result!.session.activeTabId).toBe('mock-generated-id');
		});

		it('generates new ID for restored tab', () => {
			const closedTab = createMockTab({ id: 'old-id' });
			const session = createMockSession({
				aiTabs: [],
				closedTabHistory: [{ tab: closedTab, index: 0, closedAt: Date.now() }],
			});

			const result = reopenClosedTab(session);

			expect(result!.tab.id).toBe('mock-generated-id');
		});

		it('detects duplicate by agentSessionId and switches instead', () => {
			const existingTab = createMockTab({
				id: 'existing',
				agentSessionId: 'session-123',
			});
			const closedTab = createMockTab({
				id: 'closed',
				agentSessionId: 'session-123',
			});
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'some-other-tab',
				closedTabHistory: [{ tab: closedTab, index: 1, closedAt: Date.now() }],
			});

			const result = reopenClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(true);
			expect(result!.tab).toBe(existingTab);
			expect(result!.session.activeTabId).toBe('existing');
			expect(result!.session.aiTabs).toHaveLength(1);
		});

		it('does not consider null agentSessionId as duplicate', () => {
			const existingTab = createMockTab({
				id: 'existing',
				agentSessionId: null,
			});
			const closedTab = createMockTab({
				id: 'closed',
				agentSessionId: null,
			});
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing',
				closedTabHistory: [{ tab: closedTab, index: 0, closedAt: Date.now() }],
			});

			const result = reopenClosedTab(session);

			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.aiTabs).toHaveLength(2);
		});

		it('appends at end if original index exceeds current length', () => {
			const existingTab = createMockTab({ id: 'existing' });
			const closedTab = createMockTab({ id: 'closed', agentSessionId: null });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing',
				closedTabHistory: [{ tab: closedTab, index: 10, closedAt: Date.now() }],
			});

			const result = reopenClosedTab(session);

			expect(result!.session.aiTabs).toHaveLength(2);
			expect(result!.session.aiTabs[1].id).toBe('mock-generated-id');
		});

		it('removes tab from history after restoration', () => {
			const closedTab1 = createMockTab({ id: 'closed-1', agentSessionId: null });
			const closedTab2 = createMockTab({ id: 'closed-2', agentSessionId: null });
			const session = createMockSession({
				aiTabs: [],
				closedTabHistory: [
					{ tab: closedTab1, index: 0, closedAt: Date.now() },
					{ tab: closedTab2, index: 0, closedAt: Date.now() - 1000 },
				],
			});

			const result = reopenClosedTab(session);

			expect(result!.session.closedTabHistory).toHaveLength(1);
			expect(result!.session.closedTabHistory[0].tab.id).toBe('closed-2');
		});
	});

	describe('setActiveTab', () => {
		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(setActiveTab(session, 'any-id')).toBeNull();
		});

		it('returns null for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(setActiveTab(session, 'any-id')).toBeNull();
		});

		it('returns null if tab not found', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(setActiveTab(session, 'non-existent')).toBeNull();
		});

		it('returns same session object when already active', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});

			const result = setActiveTab(session, 'tab-1');

			expect(result!.session).toBe(session);
			expect(result!.tab).toBe(tab);
		});

		it('updates activeTabId when switching tabs', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			const result = setActiveTab(session, 'tab-2');

			expect(result!.session.activeTabId).toBe('tab-2');
			expect(result!.tab).toBe(tab2);
		});

		it('clears activeFileTabId when selecting an AI tab', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
				activeFileTabId: 'file-tab-1', // A file tab was active
			});

			const result = setActiveTab(session, 'tab-1');

			// Should return a new session with activeFileTabId cleared
			expect(result!.session).not.toBe(session);
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.activeTabId).toBe('tab-1');
		});
	});

	describe('getWriteModeTab', () => {
		it('returns undefined for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(getWriteModeTab(session)).toBeUndefined();
		});

		it('returns undefined for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(getWriteModeTab(session)).toBeUndefined();
		});

		it('returns undefined when no tab is busy', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const tab2 = createMockTab({ id: 'tab-2', state: 'idle' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			expect(getWriteModeTab(session)).toBeUndefined();
		});

		it('returns the busy tab', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const tab2 = createMockTab({ id: 'tab-2', state: 'busy' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			expect(getWriteModeTab(session)).toBe(tab2);
		});

		it('returns first busy tab when multiple are busy', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'busy' });
			const tab2 = createMockTab({ id: 'tab-2', state: 'busy' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			expect(getWriteModeTab(session)).toBe(tab1);
		});
	});

	describe('getBusyTabs', () => {
		it('returns empty array for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(getBusyTabs(session)).toEqual([]);
		});

		it('returns empty array for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(getBusyTabs(session)).toEqual([]);
		});

		it('returns empty array when no tabs are busy', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const tab2 = createMockTab({ id: 'tab-2', state: 'idle' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			expect(getBusyTabs(session)).toEqual([]);
		});

		it('returns all busy tabs', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'busy' });
			const tab2 = createMockTab({ id: 'tab-2', state: 'idle' });
			const tab3 = createMockTab({ id: 'tab-3', state: 'busy' });
			const session = createMockSession({ aiTabs: [tab1, tab2, tab3] });

			const result = getBusyTabs(session);

			expect(result).toHaveLength(2);
			expect(result).toContain(tab1);
			expect(result).toContain(tab3);
		});
	});

	describe('getNavigableTabs', () => {
		it('returns empty array for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(getNavigableTabs(session)).toEqual([]);
		});

		it('returns empty array for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(getNavigableTabs(session)).toEqual([]);
		});

		it('returns all tabs when showUnreadOnly is false', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: false });
			const session = createMockSession({ aiTabs: [tab1, tab2, tab3] });

			const result = getNavigableTabs(session, false);

			expect(result).toHaveLength(3);
			expect(result).toContain(tab1);
			expect(result).toContain(tab2);
			expect(result).toContain(tab3);
		});

		it('returns same array as session.aiTabs when showUnreadOnly is false', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			const result = getNavigableTabs(session, false);

			expect(result).toBe(session.aiTabs);
		});

		it('returns only unread tabs when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({ aiTabs: [tab1, tab2, tab3] });

			const result = getNavigableTabs(session, true);

			expect(result).toHaveLength(2);
			expect(result).toContain(tab2);
			expect(result).toContain(tab3);
		});

		it('includes tabs with draft input when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, inputValue: '' });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, inputValue: 'draft text' });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: false, inputValue: '   ' });
			const session = createMockSession({ aiTabs: [tab1, tab2, tab3] });

			const result = getNavigableTabs(session, true);

			expect(result).toHaveLength(1);
			expect(result).toContain(tab2);
		});

		it('includes tabs with staged images when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, stagedImages: [] });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, stagedImages: ['image-data'] });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			const result = getNavigableTabs(session, true);

			expect(result).toHaveLength(1);
			expect(result).toContain(tab2);
		});

		it('includes tabs that have both unread and draft', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true, inputValue: 'draft' });
			const session = createMockSession({ aiTabs: [tab1] });

			const result = getNavigableTabs(session, true);

			expect(result).toHaveLength(1);
			expect(result).toContain(tab1);
		});

		it('returns empty array when no tabs match filter criteria', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, inputValue: '' });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, inputValue: '' });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			expect(getNavigableTabs(session, true)).toEqual([]);
		});

		it('defaults showUnreadOnly to false', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const session = createMockSession({ aiTabs: [tab1, tab2] });

			// Called without second argument
			const result = getNavigableTabs(session);

			expect(result).toHaveLength(2);
		});
	});

	describe('navigateToNextTab', () => {
		it('returns null for session with less than 2 tabs', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(navigateToNextTab(session)).toBeNull();
		});

		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(navigateToNextTab(session)).toBeNull();
		});

		it('returns null for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(navigateToNextTab(session)).toBeNull();
		});

		it('navigates to next tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToNextTab(session);

			expect(result!.tab).toBe(tab2);
			expect(result!.session.activeTabId).toBe('tab-2');
		});

		it('wraps around to first tab from last', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
			});

			const result = navigateToNextTab(session);

			expect(result!.tab).toBe(tab1);
			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('filters to unread tabs when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-2',
			});

			const result = navigateToNextTab(session, true);

			expect(result!.tab).toBe(tab3);
		});

		it('includes tabs with draft content when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, inputValue: '' });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, inputValue: 'draft text' });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToNextTab(session, true);

			expect(result!.tab).toBe(tab2);
		});

		it('includes tabs with staged images when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, stagedImages: [] });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, stagedImages: ['image-data'] });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			const result = navigateToNextTab(session, true);

			expect(result!.tab).toBe(tab2);
		});

		it('returns null when no navigable tabs in filtered mode', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			expect(navigateToNextTab(session, true)).toBeNull();
		});

		it('goes to first navigable tab when current is not navigable', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToNextTab(session, true);

			expect(result!.tab).toBe(tab2);
		});

		it('returns null when only one navigable tab and current is not in list', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			// First call switches to tab-2
			const result1 = navigateToNextTab(session, true);
			expect(result1!.tab).toBe(tab2);

			// Now we're on tab-2, and it's the only navigable tab
			const result2 = navigateToNextTab(result1!.session, true);
			expect(result2).toBeNull();
		});
	});

	describe('navigateToPrevTab', () => {
		it('returns null for session with less than 2 tabs', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(navigateToPrevTab(session)).toBeNull();
		});

		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(navigateToPrevTab(session)).toBeNull();
		});

		it('navigates to previous tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-3',
			});

			const result = navigateToPrevTab(session);

			expect(result!.tab).toBe(tab2);
			expect(result!.session.activeTabId).toBe('tab-2');
		});

		it('wraps around to last tab from first', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			const result = navigateToPrevTab(session);

			expect(result!.tab).toBe(tab2);
			expect(result!.session.activeTabId).toBe('tab-2');
		});

		it('filters to unread tabs when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-3',
			});

			const result = navigateToPrevTab(session, true);

			expect(result!.tab).toBe(tab1);
		});

		it('returns null when no navigable tabs in filtered mode', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			expect(navigateToPrevTab(session, true)).toBeNull();
		});

		it('goes to last navigable tab when current is not navigable', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-2',
			});

			const result = navigateToPrevTab(session, true);

			expect(result!.tab).toBe(tab3);
		});

		it('returns null when current tab is only navigable tab', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: false });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-2',
			});

			// Current tab (tab-2) is the only unread tab
			const result = navigateToPrevTab(session, true);

			expect(result).toBeNull();
		});
	});

	describe('navigateToTabByIndex', () => {
		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(navigateToTabByIndex(session, 0)).toBeNull();
		});

		it('returns null for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(navigateToTabByIndex(session, 0)).toBeNull();
		});

		it('returns null for negative index', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(navigateToTabByIndex(session, -1)).toBeNull();
		});

		it('returns null for out of bounds index', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });

			expect(navigateToTabByIndex(session, 5)).toBeNull();
		});

		it('navigates to tab by index', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToTabByIndex(session, 2);

			expect(result!.tab).toBe(tab3);
			expect(result!.session.activeTabId).toBe('tab-3');
		});

		it('returns same session when already on target tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
			});

			const result = navigateToTabByIndex(session, 1);

			expect(result!.session).toBe(session);
		});

		it('navigates within filtered list when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: true });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			// Index 0 in filtered list (unread only) is tab-2
			const result = navigateToTabByIndex(session, 0, true);

			expect(result!.tab).toBe(tab2);
		});

		it('returns null for out of bounds in filtered list', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			// Only 1 unread tab, index 1 is out of bounds
			expect(navigateToTabByIndex(session, 1, true)).toBeNull();
		});
	});

	describe('navigateToLastTab', () => {
		it('returns null for session with no tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			expect(navigateToLastTab(session)).toBeNull();
		});

		it('returns null for session with undefined aiTabs', () => {
			const session = createMockSession();
			(session as any).aiTabs = undefined;
			expect(navigateToLastTab(session)).toBeNull();
		});

		it('navigates to last tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToLastTab(session);

			expect(result!.tab).toBe(tab3);
			expect(result!.session.activeTabId).toBe('tab-3');
		});

		it('navigates to last unread tab when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const tab3 = createMockTab({ id: 'tab-3', hasUnread: true });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
			});

			const result = navigateToLastTab(session, true);

			expect(result!.tab).toBe(tab3);
		});

		it('returns null when no navigable tabs in filtered mode', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});

			expect(navigateToLastTab(session, true)).toBeNull();
		});
	});

	describe('navigateToUnifiedTabByIndex', () => {
		it('returns null for session with no unifiedTabOrder', () => {
			const session = createMockSession({ unifiedTabOrder: [] });
			expect(navigateToUnifiedTabByIndex(session, 0)).toBeNull();
		});

		it('returns null for session with undefined unifiedTabOrder', () => {
			const session = createMockSession();
			(session as any).unifiedTabOrder = undefined;
			expect(navigateToUnifiedTabByIndex(session, 0)).toBeNull();
		});

		it('returns null for negative index', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			expect(navigateToUnifiedTabByIndex(session, -1)).toBeNull();
		});

		it('returns null for out of bounds index', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});
			expect(navigateToUnifiedTabByIndex(session, 5)).toBeNull();
		});

		it('navigates to AI tab by unified index', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 1);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-2');
			expect(result!.session.activeTabId).toBe('tab-2');
			expect(result!.session.activeFileTabId).toBeNull();
		});

		it('navigates to file tab by unified index', () => {
			const aiTab = createMockTab({ id: 'ai-tab-1' });
			const fileTab = createMockFileTab({ id: 'file-tab-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-tab-1' },
					{ type: 'file', id: 'file-tab-1' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 1);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-tab-1');
			expect(result!.session.activeFileTabId).toBe('file-tab-1');
			// activeTabId is preserved for switching back
			expect(result!.session.activeTabId).toBe('ai-tab-1');
		});

		it('clears activeFileTabId when selecting AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-tab-1' });
			const fileTab = createMockFileTab({ id: 'file-tab-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-tab-1',
				activeFileTabId: 'file-tab-1', // Currently on a file tab
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-tab-1' },
					{ type: 'file', id: 'file-tab-1' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 0); // Navigate to AI tab

			expect(result!.type).toBe('ai');
			expect(result!.session.activeTabId).toBe('ai-tab-1');
			expect(result!.session.activeFileTabId).toBeNull();
		});

		it('returns same session when already on target AI tab', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});

			const result = navigateToUnifiedTabByIndex(session, 0);

			expect(result!.session).toBe(session);
		});

		it('returns same session when already on target file tab', () => {
			const fileTab = createMockFileTab({ id: 'file-tab-1' });
			const session = createMockSession({
				aiTabs: [],
				filePreviewTabs: [fileTab],
				activeTabId: '',
				activeFileTabId: 'file-tab-1',
				unifiedTabOrder: [{ type: 'file', id: 'file-tab-1' }],
			});

			const result = navigateToUnifiedTabByIndex(session, 0);

			expect(result!.session).toBe(session);
		});

		it('returns null if AI tab reference does not exist in aiTabs', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				unifiedTabOrder: [{ type: 'ai', id: 'non-existent' }],
			});

			expect(navigateToUnifiedTabByIndex(session, 0)).toBeNull();
		});

		it('returns null if file tab reference does not exist in filePreviewTabs', () => {
			const session = createMockSession({
				aiTabs: [],
				filePreviewTabs: [],
				unifiedTabOrder: [{ type: 'file', id: 'non-existent' }],
			});

			expect(navigateToUnifiedTabByIndex(session, 0)).toBeNull();
		});

		it('handles mixed AI and file tabs correctly', () => {
			const aiTab1 = createMockTab({ id: 'ai-1' });
			const aiTab2 = createMockTab({ id: 'ai-2' });
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });
			const session = createMockSession({
				aiTabs: [aiTab1, aiTab2],
				filePreviewTabs: [fileTab1, fileTab2],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'file', id: 'file-2' },
				],
			});

			// Index 0: AI tab
			const result0 = navigateToUnifiedTabByIndex(session, 0);
			expect(result0!.type).toBe('ai');
			expect(result0!.id).toBe('ai-1');

			// Index 1: File tab
			const result1 = navigateToUnifiedTabByIndex(session, 1);
			expect(result1!.type).toBe('file');
			expect(result1!.id).toBe('file-1');

			// Index 2: AI tab
			const result2 = navigateToUnifiedTabByIndex(session, 2);
			expect(result2!.type).toBe('ai');
			expect(result2!.id).toBe('ai-2');

			// Index 3: File tab
			const result3 = navigateToUnifiedTabByIndex(session, 3);
			expect(result3!.type).toBe('file');
			expect(result3!.id).toBe('file-2');
		});
	});

	describe('navigateToLastUnifiedTab', () => {
		it('returns null for session with no unifiedTabOrder', () => {
			const session = createMockSession({ unifiedTabOrder: [] });
			expect(navigateToLastUnifiedTab(session)).toBeNull();
		});

		it('returns null for session with undefined unifiedTabOrder', () => {
			const session = createMockSession();
			(session as any).unifiedTabOrder = undefined;
			expect(navigateToLastUnifiedTab(session)).toBeNull();
		});

		it('navigates to last AI tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, tab3],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
					{ type: 'ai', id: 'tab-3' },
				],
			});

			const result = navigateToLastUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-3');
			expect(result!.session.activeTabId).toBe('tab-3');
		});

		it('navigates to last file tab when file is last in unified order', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToLastUnifiedTab(session);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
			expect(result!.session.activeFileTabId).toBe('file-1');
		});

		it('returns single tab when only one exists', () => {
			const tab = createMockTab({ id: 'only-tab' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'only-tab',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'only-tab' }],
			});

			const result = navigateToLastUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('only-tab');
			expect(result!.session).toBe(session); // Same session since already active
		});

		it('skips orphaned AI entries to find last valid tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'orphaned-ai' }, // No matching AI tab
				],
			});

			const result = navigateToLastUnifiedTab(session);

			// Should skip orphaned entry and return ai-1 (already active)
			expect(result).not.toBeNull();
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-1');
		});
	});

	describe('createMergedSession', () => {
		it('creates a session with basic options', () => {
			const { session, tabId } = createMergedSession({
				name: 'Merged Session',
				projectRoot: '/path/to/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			expect(session.name).toBe('Merged Session');
			expect(session.projectRoot).toBe('/path/to/project');
			expect(session.cwd).toBe('/path/to/project');
			expect(session.fullPath).toBe('/path/to/project');
			expect(session.toolType).toBe('claude-code');
			expect(session.state).toBe('idle');
			expect(session.aiTabs).toHaveLength(1);
			expect(session.activeTabId).toBe(tabId);
			expect(tabId).toBe('mock-generated-id'); // Uses mocked generateId
			expect(session.autoRunFolderPath).toBe('/path/to/project/Auto Run Docs');
		});

		it('creates a session with merged logs in the tab', () => {
			const testLogs: LogEntry[] = [
				{ id: 'log-1', timestamp: 1000, source: 'user', text: 'Hello' },
				{ id: 'log-2', timestamp: 2000, source: 'ai', text: 'Hi there!' },
			];

			const { session } = createMergedSession({
				name: 'With Logs',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: testLogs,
			});

			const activeTab = session.aiTabs[0];
			expect(activeTab.logs).toEqual(testLogs);
		});

		it('creates a session with usage stats', () => {
			const usageStats = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 100,
				cacheCreationTokens: 50,
				costUsd: 0.05,
			};

			const { session } = createMergedSession({
				name: 'With Stats',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				usageStats,
			});

			expect(session.aiTabs[0].usageStats).toEqual(usageStats);
		});

		it('creates a session with group assignment', () => {
			const { session } = createMergedSession({
				name: 'Grouped',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				groupId: 'group-123',
			});

			expect(session.groupId).toBe('group-123');
		});

		it('creates a session with saveToHistory option', () => {
			const { session: sessionWithHistory } = createMergedSession({
				name: 'With History',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				saveToHistory: true,
			});

			expect(sessionWithHistory.aiTabs[0].saveToHistory).toBe(true);

			const { session: sessionWithoutHistory } = createMergedSession({
				name: 'Without History',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				saveToHistory: false,
			});

			expect(sessionWithoutHistory.aiTabs[0].saveToHistory).toBe(false);
		});

		it('creates a session with showThinking option', () => {
			const { session: sessionWithThinking } = createMergedSession({
				name: 'With Thinking',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				showThinking: 'on',
			});

			expect(sessionWithThinking.aiTabs[0].showThinking).toBe('on');

			const { session: sessionWithoutThinking } = createMergedSession({
				name: 'Without Thinking',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				showThinking: 'off',
			});

			expect(sessionWithoutThinking.aiTabs[0].showThinking).toBe('off');

			const { session: sessionWithSticky } = createMergedSession({
				name: 'Sticky Thinking',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
				showThinking: 'sticky',
			});

			expect(sessionWithSticky.aiTabs[0].showThinking).toBe('sticky');

			// Default should be 'off'
			const { session: sessionDefault } = createMergedSession({
				name: 'Default Thinking',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			expect(sessionDefault.aiTabs[0].showThinking).toBe('off');
		});

		it('creates a session with terminal toolType sets correct inputMode', () => {
			const { session } = createMergedSession({
				name: 'Terminal Session',
				projectRoot: '/project',
				toolType: 'terminal',
				mergedLogs: [],
			});

			expect(session.inputMode).toBe('terminal');
		});

		it('creates a session with non-terminal toolType sets ai inputMode', () => {
			const { session } = createMergedSession({
				name: 'AI Session',
				projectRoot: '/project',
				toolType: 'opencode',
				mergedLogs: [],
			});

			expect(session.inputMode).toBe('ai');
		});

		it('creates tab with agentSessionId as null (assigned on spawn)', () => {
			const { session } = createMergedSession({
				name: 'New Session',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			expect(session.aiTabs[0].agentSessionId).toBeNull();
		});

		it('creates session with standard defaults', () => {
			const { session } = createMergedSession({
				name: 'Defaults Test',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			// Check standard session defaults match pattern from App.tsx
			expect(session.isGitRepo).toBe(false);
			expect(session.isLive).toBe(false);
			expect(session.aiPid).toBe(0);
			expect(session.terminalPid).toBe(0);
			expect(session.contextUsage).toBe(0);
			expect(session.activeTimeMs).toBe(0);
			expect(session.changedFiles).toEqual([]);
			expect(session.fileTree).toEqual([]);
			expect(session.fileExplorerExpanded).toEqual([]);
			expect(session.executionQueue).toEqual([]);
			expect(session.closedTabHistory).toEqual([]);
			expect(session.shellCwd).toBe('/project');
			expect(session.fileTreeAutoRefreshInterval).toBe(180);
			expect(session.autoRunFolderPath).toBe('/project/Auto Run Docs');
		});

		it('creates shell log with merged context message', () => {
			const { session } = createMergedSession({
				name: 'Shell Log Test',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			expect(session.shellLogs).toHaveLength(1);
			expect(session.shellLogs[0].source).toBe('system');
			expect(session.shellLogs[0].text).toBe('Merged Context Session Ready.');
		});

		it('creates tab in idle state', () => {
			const { session } = createMergedSession({
				name: 'State Test',
				projectRoot: '/project',
				toolType: 'claude-code',
				mergedLogs: [],
			});

			expect(session.aiTabs[0].state).toBe('idle');
			expect(session.aiTabs[0].starred).toBe(false);
			expect(session.aiTabs[0].inputValue).toBe('');
			expect(session.aiTabs[0].stagedImages).toEqual([]);
		});
	});

	describe('hasActiveWizard', () => {
		it('returns false for tab with no wizardState', () => {
			const tab = createMockTab({ id: 'tab-1' });
			expect(hasActiveWizard(tab)).toBe(false);
		});

		it('returns false for tab with undefined wizardState', () => {
			const tab = createMockTab({ id: 'tab-1', wizardState: undefined });
			expect(hasActiveWizard(tab)).toBe(false);
		});

		it('returns false for tab with inactive wizardState', () => {
			const tab = createMockTab({
				id: 'tab-1',
				wizardState: {
					isActive: false,
					mode: null,
					confidence: 0,
					conversationHistory: [],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			expect(hasActiveWizard(tab)).toBe(false);
		});

		it('returns true for tab with active wizardState', () => {
			const tab = createMockTab({
				id: 'tab-1',
				wizardState: {
					isActive: true,
					mode: 'new',
					confidence: 50,
					conversationHistory: [],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			expect(hasActiveWizard(tab)).toBe(true);
		});

		it('returns true for tab with active wizard in iterate mode', () => {
			const tab = createMockTab({
				id: 'tab-1',
				wizardState: {
					isActive: true,
					mode: 'iterate',
					confidence: 75,
					conversationHistory: [],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			expect(hasActiveWizard(tab)).toBe(true);
		});
	});

	// closeFileTab tests
	describe('closeFileTab', () => {
		it('returns null for empty session', () => {
			const session = createMockSession({
				filePreviewTabs: [],
			});
			expect(closeFileTab(session, 'nonexistent')).toBeNull();
		});

		it('returns null for non-existent tab', () => {
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				filePreviewTabs: [fileTab],
				unifiedTabOrder: [{ type: 'file', id: 'file-1' }],
			});
			expect(closeFileTab(session, 'nonexistent')).toBeNull();
		});

		it('closes file tab and adds to unified history', () => {
			const fileTab = createMockFileTab({ id: 'file-1', path: '/test/myfile.ts' });
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
				unifiedClosedTabHistory: [],
			});

			const result = closeFileTab(session, 'file-1');

			expect(result).not.toBeNull();
			expect(result!.closedTabEntry.type).toBe('file');
			expect(result!.closedTabEntry.tab.path).toBe('/test/myfile.ts');
			expect(result!.closedTabEntry.unifiedIndex).toBe(1);
			expect(result!.session.filePreviewTabs).toHaveLength(0);
			expect(result!.session.unifiedTabOrder).toHaveLength(1);
			expect(result!.session.unifiedClosedTabHistory).toHaveLength(1);
			// Should switch to AI tab when file tab is closed
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.activeTabId).toBe('ai-1');
		});

		it('selects new first tab when closing first file tab', () => {
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab1, fileTab2],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'file', id: 'file-2' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = closeFileTab(session, 'file-1');

			// When closing first tab, select the new first tab (file-2 was previously to the right)
			expect(result).not.toBeNull();
			expect(result!.session.activeFileTabId).toBe('file-2');
		});

		it('selects previous file tab when closing non-first file tab', () => {
			const fileTab1 = createMockFileTab({ id: 'file-1' });
			const fileTab2 = createMockFileTab({ id: 'file-2' });
			const fileTab3 = createMockFileTab({ id: 'file-3' });
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab1, fileTab2, fileTab3],
				activeFileTabId: 'file-2',
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'file', id: 'file-2' },
					{ type: 'file', id: 'file-3' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = closeFileTab(session, 'file-2');

			// Should select file-1 (to the left), not file-3 (to the right)
			expect(result).not.toBeNull();
			expect(result!.session.activeFileTabId).toBe('file-1');
		});
	});

	// addAiTabToUnifiedHistory tests
	describe('addAiTabToUnifiedHistory', () => {
		it('adds AI tab to unified closed history', () => {
			const aiTab = createMockTab({ id: 'ai-1', agentSessionId: 'session-123' });
			const session = createMockSession({
				unifiedClosedTabHistory: [],
			});

			const result = addAiTabToUnifiedHistory(session, aiTab, 0);

			expect(result.unifiedClosedTabHistory).toHaveLength(1);
			expect(result.unifiedClosedTabHistory[0].type).toBe('ai');
			expect(result.unifiedClosedTabHistory[0].tab.agentSessionId).toBe('session-123');
			expect(result.unifiedClosedTabHistory[0].unifiedIndex).toBe(0);
		});

		it('prepends to existing history', () => {
			const existingEntry = {
				type: 'file' as const,
				tab: createMockFileTab({ id: 'old-file' }),
				unifiedIndex: 1,
				closedAt: Date.now() - 1000,
			};
			const aiTab = createMockTab({ id: 'ai-new' });
			const session = createMockSession({
				unifiedClosedTabHistory: [existingEntry],
			});

			const result = addAiTabToUnifiedHistory(session, aiTab, 0);

			expect(result.unifiedClosedTabHistory).toHaveLength(2);
			expect(result.unifiedClosedTabHistory[0].type).toBe('ai');
			expect(result.unifiedClosedTabHistory[1].type).toBe('file');
		});
	});

	// reopenUnifiedClosedTab tests
	describe('reopenUnifiedClosedTab', () => {
		it('returns null when unified history is empty', () => {
			const session = createMockSession({
				unifiedClosedTabHistory: [],
				closedTabHistory: [],
			});
			expect(reopenUnifiedClosedTab(session)).toBeNull();
		});

		it('reopens file tab from unified history', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const closedFileTab = createMockFileTab({ id: 'closed-file', path: '/test/closed.ts' });
			const closedEntry = {
				type: 'file' as const,
				tab: closedFileTab,
				unifiedIndex: 1,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('file');
			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.filePreviewTabs).toHaveLength(1);
			expect(result!.session.filePreviewTabs[0].path).toBe('/test/closed.ts');
			expect(result!.session.activeFileTabId).toBe(result!.tabId);
			expect(result!.session.unifiedClosedTabHistory).toHaveLength(0);
		});

		it('resets navigation history when restoring file tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			// Create a file tab with stale navigation history (multiple entries)
			const closedFileTab = createMockFileTab({
				id: 'closed-file',
				path: '/test/fileB.ts',
				name: 'fileB',
				scrollTop: 100,
				navigationHistory: [
					{ path: '/test/fileA.ts', name: 'fileA', scrollTop: 0 },
					{ path: '/test/fileB.ts', name: 'fileB', scrollTop: 100 },
					{ path: '/test/fileC.ts', name: 'fileC', scrollTop: 200 },
				],
				navigationIndex: 1, // Currently viewing fileB
			});
			const closedEntry = {
				type: 'file' as const,
				tab: closedFileTab,
				unifiedIndex: 1,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('file');
			const restoredTab = result!.session.filePreviewTabs[0];
			// Navigation history should be reset to just the current file
			expect(restoredTab.navigationHistory).toHaveLength(1);
			expect(restoredTab.navigationHistory![0].path).toBe('/test/fileB.ts');
			expect(restoredTab.navigationHistory![0].name).toBe('fileB');
			expect(restoredTab.navigationHistory![0].scrollTop).toBe(100);
			expect(restoredTab.navigationIndex).toBe(0);
		});

		it('reopens AI tab from unified history', () => {
			const existingAiTab = createMockTab({ id: 'ai-existing' });
			const closedAiTab = createMockTab({ id: 'ai-closed', agentSessionId: 'session-456' });
			const closedEntry = {
				type: 'ai' as const,
				tab: closedAiTab,
				unifiedIndex: 0,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [existingAiTab],
				activeTabId: 'ai-existing',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-existing' }],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('ai');
			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.aiTabs).toHaveLength(2);
			expect(result!.session.activeTabId).toBe(result!.tabId);
			expect(result!.session.activeFileTabId).toBeNull();
		});

		it('switches to existing file tab when duplicate found', () => {
			const existingFileTab = createMockFileTab({ id: 'file-existing', path: '/test/same.ts' });
			const closedFileTab = createMockFileTab({ id: 'file-closed', path: '/test/same.ts' });
			const closedEntry = {
				type: 'file' as const,
				tab: closedFileTab,
				unifiedIndex: 1,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				filePreviewTabs: [existingFileTab],
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-existing' },
				],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('file');
			expect(result!.wasDuplicate).toBe(true);
			expect(result!.tabId).toBe('file-existing');
			expect(result!.session.filePreviewTabs).toHaveLength(1); // No new tab created
			expect(result!.session.activeFileTabId).toBe('file-existing');
			// Verify tab is ensured in unifiedTabOrder
			expect(result!.session.unifiedTabOrder).toContainEqual({ type: 'file', id: 'file-existing' });
		});

		it('repairs unifiedTabOrder when file duplicate is orphaned', () => {
			const existingFileTab = createMockFileTab({ id: 'file-existing', path: '/test/same.ts' });
			const closedFileTab = createMockFileTab({ id: 'file-closed', path: '/test/same.ts' });
			const closedEntry = {
				type: 'file' as const,
				tab: closedFileTab,
				unifiedIndex: 1,
				closedAt: Date.now(),
			};
			// Simulate orphaned tab: in filePreviewTabs but NOT in unifiedTabOrder
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				filePreviewTabs: [existingFileTab],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }], // file tab missing!
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(true);
			// The fix should have added the tab to unifiedTabOrder
			expect(result!.session.unifiedTabOrder).toContainEqual({ type: 'file', id: 'file-existing' });
		});

		it('switches to existing AI tab when duplicate found', () => {
			const existingAiTab = createMockTab({ id: 'ai-existing', agentSessionId: 'session-same' });
			const closedAiTab = createMockTab({ id: 'ai-closed', agentSessionId: 'session-same' });
			const closedEntry = {
				type: 'ai' as const,
				tab: closedAiTab,
				unifiedIndex: 0,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [existingAiTab],
				activeTabId: 'ai-existing',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-existing' }],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('ai');
			expect(result!.wasDuplicate).toBe(true);
			expect(result!.tabId).toBe('ai-existing');
			expect(result!.session.aiTabs).toHaveLength(1); // No new tab created
			// Verify tab is ensured in unifiedTabOrder
			expect(result!.session.unifiedTabOrder).toContainEqual({ type: 'ai', id: 'ai-existing' });
		});

		it('repairs unifiedTabOrder when AI duplicate is orphaned', () => {
			const existingAiTab = createMockTab({ id: 'ai-existing', agentSessionId: 'session-same' });
			const closedAiTab = createMockTab({ id: 'ai-closed', agentSessionId: 'session-same' });
			const closedEntry = {
				type: 'ai' as const,
				tab: closedAiTab,
				unifiedIndex: 0,
				closedAt: Date.now(),
			};
			// Simulate orphaned tab: in aiTabs but NOT in unifiedTabOrder
			const session = createMockSession({
				aiTabs: [existingAiTab],
				activeTabId: 'ai-existing',
				unifiedTabOrder: [], // orphaned!
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(true);
			// The fix should have added the tab to unifiedTabOrder
			expect(result!.session.unifiedTabOrder).toContainEqual({ type: 'ai', id: 'ai-existing' });
		});

		it('falls back to legacy closedTabHistory when unified is empty', () => {
			const closedAiTab = createMockTab({ id: 'legacy-closed', agentSessionId: 'legacy-session' });
			const closedEntry: ClosedTab = {
				tab: closedAiTab,
				index: 0,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [],
				closedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('ai');
			expect(result!.wasDuplicate).toBe(false);
		});
	});

	describe('navigateToNextUnifiedTab', () => {
		it('returns null for session with no unifiedTabOrder', () => {
			const session = createMockSession({ unifiedTabOrder: [] });
			expect(navigateToNextUnifiedTab(session)).toBeNull();
		});

		it('returns null for session with single tab', () => {
			const tab = createMockTab({ id: 'only-tab' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'only-tab',
				unifiedTabOrder: [{ type: 'ai', id: 'only-tab' }],
			});
			expect(navigateToNextUnifiedTab(session)).toBeNull();
		});

		it('navigates to next AI tab in unified order', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-2');
			expect(result!.session.activeTabId).toBe('tab-2');
		});

		it('navigates from AI tab to file tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
			expect(result!.session.activeFileTabId).toBe('file-1');
		});

		it('navigates from file tab to AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: 'file-1', // File tab is active
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-1');
			expect(result!.session.activeTabId).toBe('ai-1');
			expect(result!.session.activeFileTabId).toBeNull();
		});

		it('wraps around to first tab when at last tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2', // At last tab
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-1');
		});

		it('skips read AI tabs without drafts in showUnreadOnly mode', () => {
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const unreadTab = createMockTab({ id: 'unread-tab', hasUnread: true });
			const session = createMockSession({
				aiTabs: [readTab, unreadTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'read-tab' },
					{ type: 'ai', id: 'unread-tab' },
				],
			});

			const result = navigateToNextUnifiedTab(session, true);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('unread-tab');
		});

		it('includes file tabs in showUnreadOnly mode', () => {
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [readTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'read-tab' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToNextUnifiedTab(session, true);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
		});

		it('navigates to first tab when current tab not found in unified order', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'non-existent',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-1');
		});

		it('skips orphaned AI entries in unifiedTabOrder', () => {
			const tab1 = createMockTab({ id: 'ai-1' });
			const tab2 = createMockTab({ id: 'ai-2' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-2',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'ai', id: 'orphaned-ai' }, // No matching AI tab
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			// Should skip orphaned entry and navigate to file-1
			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
			expect(result!.session.activeFileTabId).toBe('file-1');
		});

		it('skips orphaned file entries in unifiedTabOrder', () => {
			const tab1 = createMockTab({ id: 'ai-1' });
			const tab2 = createMockTab({ id: 'ai-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				filePreviewTabs: [],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'orphaned-file' }, // No matching file tab
					{ type: 'ai', id: 'ai-2' },
				],
			});

			const result = navigateToNextUnifiedTab(session);

			// Should skip orphaned file entry and navigate to ai-2
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-2');
		});

		it('skips orphaned entries in showUnreadOnly mode', () => {
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const unreadTab = createMockTab({ id: 'unread-tab', hasUnread: true });
			const session = createMockSession({
				aiTabs: [readTab, unreadTab],
				filePreviewTabs: [],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'read-tab' },
					{ type: 'file', id: 'orphaned-file' }, // No matching file tab
					{ type: 'ai', id: 'unread-tab' },
				],
			});

			const result = navigateToNextUnifiedTab(session, true);

			// Should skip orphaned file and read AI tab, navigate to unread tab
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('unread-tab');
		});
	});

	describe('navigateToPrevUnifiedTab', () => {
		it('returns null for session with no unifiedTabOrder', () => {
			const session = createMockSession({ unifiedTabOrder: [] });
			expect(navigateToPrevUnifiedTab(session)).toBeNull();
		});

		it('returns null for session with single tab', () => {
			const tab = createMockTab({ id: 'only-tab' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'only-tab',
				unifiedTabOrder: [{ type: 'ai', id: 'only-tab' }],
			});
			expect(navigateToPrevUnifiedTab(session)).toBeNull();
		});

		it('navigates to previous AI tab in unified order', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-1');
			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('navigates from file tab to AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: 'file-1', // File tab is active
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-1');
			expect(result!.session.activeTabId).toBe('ai-1');
			expect(result!.session.activeFileTabId).toBeNull();
		});

		it('navigates from AI tab to file tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
			expect(result!.session.activeFileTabId).toBe('file-1');
		});

		it('wraps around to last tab when at first tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1', // At first tab
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-2');
		});

		it('skips read AI tabs without drafts in showUnreadOnly mode', () => {
			const unreadTab = createMockTab({ id: 'unread-tab', hasUnread: true });
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [unreadTab, readTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'unread-tab' },
					{ type: 'ai', id: 'read-tab' },
				],
			});

			const result = navigateToPrevUnifiedTab(session, true);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('unread-tab');
		});

		it('includes file tabs in showUnreadOnly mode', () => {
			const fileTab = createMockFileTab({ id: 'file-1' });
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [readTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'read-tab' },
				],
			});

			const result = navigateToPrevUnifiedTab(session, true);

			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
		});

		it('navigates to last tab when current tab not found in unified order', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'non-existent',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-2');
		});

		it('skips orphaned AI entries in unifiedTabOrder', () => {
			const tab1 = createMockTab({ id: 'ai-1' });
			const tab2 = createMockTab({ id: 'ai-2' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'orphaned-ai' }, // No matching AI tab
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'ai-2' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			// Should skip orphaned entry and navigate to file-1
			expect(result!.type).toBe('file');
			expect(result!.id).toBe('file-1');
			expect(result!.session.activeFileTabId).toBe('file-1');
		});

		it('skips orphaned file entries in unifiedTabOrder', () => {
			const tab1 = createMockTab({ id: 'ai-1' });
			const tab2 = createMockTab({ id: 'ai-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				filePreviewTabs: [],
				activeTabId: 'ai-2',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'orphaned-file' }, // No matching file tab
					{ type: 'ai', id: 'ai-2' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			// Should skip orphaned file entry and navigate to ai-1
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-1');
		});

		it('cycles through mixed AI and file tabs correctly', () => {
			const aiTab1 = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const aiTab2 = createMockTab({ id: 'ai-2' });
			const session = createMockSession({
				aiTabs: [aiTab1, aiTab2],
				filePreviewTabs: [fileTab],
				activeTabId: 'ai-2',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
				],
			});

			// First navigation: ai-2 -> file-1
			const result1 = navigateToPrevUnifiedTab(session);
			expect(result1!.type).toBe('file');
			expect(result1!.id).toBe('file-1');

			// Second navigation: file-1 -> ai-1
			const result2 = navigateToPrevUnifiedTab(result1!.session);
			expect(result2!.type).toBe('ai');
			expect(result2!.id).toBe('ai-1');

			// Third navigation: ai-1 -> ai-2 (wrap around)
			const result3 = navigateToPrevUnifiedTab(result2!.session);
			expect(result3!.type).toBe('ai');
			expect(result3!.id).toBe('ai-2');
		});
	});

	describe('extractQuickTabName', () => {
		it('extracts PR number from GitHub PR URL', () => {
			expect(
				extractQuickTabName('https://github.com/RunMaestro/Maestro/pull/380 review this PR')
			).toBe('PR #380');
		});

		it('extracts issue number from GitHub issue URL', () => {
			expect(
				extractQuickTabName(
					'thoughts on this issue? https://github.com/RunMaestro/Maestro/issues/381'
				)
			).toBe('Issue #381');
		});

		it('extracts discussion number from GitHub discussion URL', () => {
			expect(extractQuickTabName('https://github.com/org/repo/discussions/42')).toBe(
				'Discussion #42'
			);
		});

		it('extracts Jira-style ticket ID', () => {
			expect(extractQuickTabName('fix JIRA-1234 memory leak')).toBe('JIRA-1234');
			expect(extractQuickTabName('implement PROJ-99')).toBe('PROJ-99');
		});

		it('extracts inline PR reference', () => {
			expect(extractQuickTabName('review PR #256')).toBe('PR #256');
			expect(extractQuickTabName('look at pull request #100')).toBe('PR #100');
		});

		it('extracts inline issue reference', () => {
			expect(extractQuickTabName('fix issue #42')).toBe('Issue #42');
		});

		it('returns null for plain text messages', () => {
			expect(extractQuickTabName('help me implement dark mode')).toBeNull();
			expect(extractQuickTabName('refactor the auth module')).toBeNull();
		});

		it('returns null for empty or whitespace-only messages', () => {
			expect(extractQuickTabName('')).toBeNull();
			expect(extractQuickTabName('   ')).toBeNull();
		});

		it('prefers GitHub URL over inline reference when both present', () => {
			// URL pattern matches first
			expect(extractQuickTabName('review PR #999 at https://github.com/org/repo/pull/123')).toBe(
				'PR #123'
			);
		});

		it('handles URLs with query params and fragments', () => {
			expect(extractQuickTabName('https://github.com/org/repo/pull/456?diff=split#review')).toBe(
				'PR #456'
			);
			expect(extractQuickTabName('https://github.com/org/repo/issues/789?q=is%3Aopen')).toBe(
				'Issue #789'
			);
		});
	});

	describe('buildUnifiedTabs', () => {
		it('returns tabs in unifiedTabOrder sequence', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				unifiedTabOrder: [
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = buildUnifiedTabs(session);

			expect(result).toHaveLength(2);
			expect(result[0].type).toBe('file');
			expect(result[0].id).toBe('file-1');
			expect(result[1].type).toBe('ai');
			expect(result[1].id).toBe('ai-1');
		});

		it('appends orphaned AI tabs not in unifiedTabOrder', () => {
			const aiTab1 = createMockTab({ id: 'ai-1' });
			const aiTab2 = createMockTab({ id: 'ai-orphaned' });
			const session = createMockSession({
				aiTabs: [aiTab1, aiTab2],
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }], // ai-orphaned missing
			});

			const result = buildUnifiedTabs(session);

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('ai-1');
			expect(result[1].id).toBe('ai-orphaned');
			expect(result[1].type).toBe('ai');
		});

		it('appends orphaned file tabs not in unifiedTabOrder', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-orphaned' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }], // file-orphaned missing
			});

			const result = buildUnifiedTabs(session);

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('ai-1');
			expect(result[1].id).toBe('file-orphaned');
			expect(result[1].type).toBe('file');
		});

		it('skips unifiedTabOrder refs with no matching tab data', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'ai-deleted' }, // no matching tab
				],
			});

			const result = buildUnifiedTabs(session);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('ai-1');
		});

		it('returns empty array for empty session', () => {
			const session = createMockSession({
				aiTabs: [],
				filePreviewTabs: [],
				unifiedTabOrder: [],
			});

			expect(buildUnifiedTabs(session)).toHaveLength(0);
		});
	});

	describe('ensureInUnifiedTabOrder', () => {
		it('returns same array if tab already present', () => {
			const order = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'file' as const, id: 'file-1' },
			];

			const result = ensureInUnifiedTabOrder(order, 'ai', 'ai-1');

			expect(result).toBe(order); // Same reference - no mutation
		});

		it('appends tab if not present', () => {
			const order = [{ type: 'ai' as const, id: 'ai-1' }];

			const result = ensureInUnifiedTabOrder(order, 'file', 'file-new');

			expect(result).toHaveLength(2);
			expect(result[1]).toEqual({ type: 'file', id: 'file-new' });
			expect(result).not.toBe(order); // New array
		});

		it('distinguishes between ai and file types with same id', () => {
			const order = [{ type: 'ai' as const, id: 'same-id' }];

			// Looking for 'file' type with 'same-id' - should NOT match
			const result = ensureInUnifiedTabOrder(order, 'file', 'same-id');

			expect(result).toHaveLength(2);
			expect(result[1]).toEqual({ type: 'file', id: 'same-id' });
		});

		it('works with empty array', () => {
			const result = ensureInUnifiedTabOrder([], 'ai', 'ai-1');

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ type: 'ai', id: 'ai-1' });
		});
	});

	describe('getRepairedUnifiedTabOrder', () => {
		it('returns original order when no orphans exist', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toBe(session.unifiedTabOrder); // Same reference
		});

		it('appends orphaned AI tabs not in unifiedTabOrder', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const orphan = createMockTab({ id: 'orphan-tab' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, orphan],
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toHaveLength(3);
			expect(result[2]).toEqual({ type: 'ai', id: 'orphan-tab' });
		});

		it('appends orphaned file tabs not in unifiedTabOrder', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				filePreviewTabs: [fileTab],
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			});

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toHaveLength(2);
			expect(result[1]).toEqual({ type: 'file', id: 'file-1' });
		});

		it('handles undefined unifiedTabOrder', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			(session as any).unifiedTabOrder = undefined;

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ type: 'ai', id: 'tab-1' });
		});
	});

	describe('navigation with orphaned tabs', () => {
		it('navigateToNextUnifiedTab reaches orphaned tabs', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const orphan = createMockTab({ id: 'orphan-tab' });
			const session = createMockSession({
				aiTabs: [tab1, tab2, orphan],
				activeTabId: 'tab-2',
				activeFileTabId: null,
				// orphan-tab is in aiTabs but NOT in unifiedTabOrder
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = navigateToNextUnifiedTab(session);
			// Should navigate to orphan-tab (appended by repair), NOT wrap to tab-1
			expect(result).not.toBeNull();
			expect(result!.id).toBe('orphan-tab');
			expect(result!.session.activeTabId).toBe('orphan-tab');
			// Repair should be persisted in the session
			expect(result!.session.unifiedTabOrder).toHaveLength(3);
		});

		it('navigateToPrevUnifiedTab reaches orphaned tabs', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const orphan = createMockTab({ id: 'orphan-tab' });
			const session = createMockSession({
				aiTabs: [tab1, orphan],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});

			const result = navigateToPrevUnifiedTab(session);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('orphan-tab');
			expect(result!.session.unifiedTabOrder).toHaveLength(2);
		});

		it('navigateToUnifiedTabByIndex navigates to orphaned tab position', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const orphan = createMockTab({ id: 'orphan-tab' });
			const session = createMockSession({
				aiTabs: [tab1, orphan],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});

			// Index 1 is the orphaned tab (appended by repair)
			const result = navigateToUnifiedTabByIndex(session, 1);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('orphan-tab');
			expect(result!.session.unifiedTabOrder).toHaveLength(2);
		});

		it('navigateToLastUnifiedTab reaches orphaned last tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const orphan = createMockTab({ id: 'orphan-tab' });
			const session = createMockSession({
				aiTabs: [tab1, orphan],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
			});

			const result = navigateToLastUnifiedTab(session);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('orphan-tab');
		});
	});

	describe('reopenClosedTab unifiedTabOrder fix', () => {
		it('adds restored tab to unifiedTabOrder', () => {
			const closedTab = createMockTab({ id: 'closed-1', agentSessionId: null });
			const remainingTab = createMockTab({ id: 'remaining-1' });
			const session = createMockSession({
				aiTabs: [remainingTab],
				activeTabId: 'remaining-1',
				closedTabHistory: [{ tab: closedTab, index: 0 }],
				unifiedTabOrder: [{ type: 'ai', id: 'remaining-1' }],
			});

			const result = reopenClosedTab(session);
			expect(result).not.toBeNull();
			expect(result!.session.unifiedTabOrder).toHaveLength(2);
			expect(result!.session.unifiedTabOrder[1]).toEqual({
				type: 'ai',
				id: 'mock-generated-id',
			});
		});

		it('adds duplicate tab to unifiedTabOrder when switching', () => {
			const existingTab = createMockTab({ id: 'existing-1', agentSessionId: 'session-abc' });
			const closedTab = createMockTab({ id: 'closed-1', agentSessionId: 'session-abc' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-1',
				closedTabHistory: [{ tab: closedTab, index: 0 }],
				unifiedTabOrder: [], // Deliberately empty to test repair
			});

			const result = reopenClosedTab(session);
			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(true);
			expect(result!.session.unifiedTabOrder).toHaveLength(1);
			expect(result!.session.unifiedTabOrder[0]).toEqual({
				type: 'ai',
				id: 'existing-1',
			});
		});
	});
});
