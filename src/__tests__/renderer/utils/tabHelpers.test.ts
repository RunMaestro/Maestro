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
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	getActiveTab,
	createTab,
	closeTab,
	reopenClosedTab,
	closeBrowserTab,
	closeFileTab,
	addAiTabToUnifiedHistory,
	reopenUnifiedClosedTab,
	reopenClosedAiTabById,
	setActiveTab,
	aiTabFocusFields,
	getWriteModeTab,
	getBusyTabs,
	getNavigableTabs,
	navigateToNextTab,
	navigateToPrevTab,
	navigateToTabByIndex,
	navigateToLastTab,
	navigateToUnifiedTabByIndex,
	navigateToUnifiedTabById,
	navigateToLastUnifiedTab,
	navigateToNextUnifiedTab,
	navigateToPrevUnifiedTab,
	navigateToClosestTerminalTab,
	createMergedSession,
	hasActiveWizard,
	extractQuickTabName,
	buildUnifiedTabs,
	revealAiTab,
	ensureInUnifiedTabOrder,
	getRepairedUnifiedTabOrder,
	moveActiveUnifiedTabToEdge,
	toggleReadOnlyModeFields,
	findNextUnreadSession,
	resolveQueuedItemTarget,
	markTabRunningQueuedItem,
	isSoleAiTabReplacement,
	groupHasUnreadTabs,
	computeUnreadGroupIds,
	computeQueuedTabIds,
	filterUnifiedTabOrderForUnread,
} from '../../../renderer/utils/tabHelpers';
import { resolveTabPermissionMode } from '../../../shared/agentMetadata';
import type { LogEntry } from '../../../renderer/types';
import type {
	Session,
	AITab,
	ClosedTab,
	ClosedTabEntry,
	FilePreviewTab,
	TerminalTab,
	QueuedItem,
} from '../../../renderer/types';
import { createMockAITab as createMockTab, createMockFileTab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

// Mock the generateId function to return predictable IDs
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-generated-id'),
}));

// createMockSession, createMockTab, and createMockFileTab are imported from
// shared factories (mockSession and mockTab) via the imports at the top.

function createMockBrowserTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'browser-tab-1',
		url: 'https://example.com/',
		title: 'Example',
		createdAt: Date.now(),
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
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
		// These tests assert insert-after-active placement; the setting defaults
		// to 'end', so opt into 'after-current' for the duration of this block.
		beforeEach(() => {
			useSettingsStore.setState({ newTabPlacement: 'after-current' });
		});

		it('creates a new tab with default options', () => {
			const session = createMockSession({ aiTabs: [] });

			const result = createTab(session)!;

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

		it('leaves any active tiled group so the new tab gets focus', () => {
			// Regression: a new AI tab created while a group is active must clear
			// activeGroupId, otherwise the group keeps taking over the panel and the new
			// tab opens in the background (never focused).
			const session = createMockSession({
				aiTabs: [{ id: 'a', name: null, logs: [] }] as never,
				activeGroupId: 'g1',
				tabGroups: [
					{
						id: 'g1',
						name: 'G',
						createdAt: 0,
						focusedPaneId: 'l1',
						layout: {
							kind: 'split',
							id: 's1',
							direction: 'row',
							sizes: [1],
							children: [{ kind: 'leaf', id: 'l1', tab: { type: 'ai', id: 'a' } }],
						},
					},
				] as never,
			});

			const result = createTab(session)!;

			expect(result.session.activeGroupId).toBeNull();
			expect(result.session.activeTabId).toBe('mock-generated-id');
			expect(result.session.inputMode).toBe('ai');
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

			const result = createTab(session, options)!;

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
			const defaultResult = createTab(session)!;
			expect(defaultResult.tab.showThinking).toBe('off');

			// Explicit 'on'
			const trueResult = createTab(session, { showThinking: 'on' })!;
			expect(trueResult.tab.showThinking).toBe('on');

			// Explicit 'off'
			const falseResult = createTab(session, { showThinking: 'off' })!;
			expect(falseResult.tab.showThinking).toBe('off');

			// Explicit 'sticky'
			const stickyResult = createTab(session, { showThinking: 'sticky' })!;
			expect(stickyResult.tab.showThinking).toBe('sticky');
		});

		it('appends tab to existing tabs', () => {
			const existingTab = createMockTab({ id: 'existing-tab' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-tab',
			});

			const result = createTab(session)!;

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

			const result = createTab(session)!;

			expect(result.session.activeTabId).toBe(result.tab.id);
		});

		it('does NOT change the active tab or view when activate is false (background create)', () => {
			const existingTab = createMockTab({ id: 'existing-tab' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-tab',
				activeBrowserTabId: 'browser-1',
				activeFileTabId: 'file-1',
				activeTerminalTabId: 'term-1',
				inputMode: 'terminal',
				activeGroupId: 'group-1',
			});

			const result = createTab(session, { activate: false })!;

			// The new tab is appended and ordered, but every focus-related field
			// is preserved so the user's visible view never changes.
			expect(result.session.aiTabs).toHaveLength(2);
			expect(result.session.aiTabs[1]).toBe(result.tab);
			expect(result.session.unifiedTabOrder).toContainEqual({ type: 'ai', id: result.tab.id });
			expect(result.session.activeTabId).toBe('existing-tab');
			expect(result.session.activeBrowserTabId).toBe('browser-1');
			expect(result.session.activeFileTabId).toBe('file-1');
			expect(result.session.activeTerminalTabId).toBe('term-1');
			expect(result.session.inputMode).toBe('terminal');
			// activeGroupId is preserved too: a background create must not leave the
			// active tiled group (doing so would let the group steal the panel).
			expect(result.session.activeGroupId).toBe('group-1');
		});

		it('clears activeBrowserTabId when creating a new AI tab', () => {
			const existingTab = createMockTab({ id: 'existing-tab' });
			const session = createMockSession({
				aiTabs: [existingTab],
				activeTabId: 'existing-tab',
				activeBrowserTabId: 'browser-1',
			});

			const result = createTab(session)!;

			expect(result.session.activeBrowserTabId).toBeNull();
			expect(result.session.activeTabId).toBe(result.tab.id);
		});

		it('inserts new AI tab directly to the right of the active AI tab in unifiedTabOrder', () => {
			const tabA = createMockTab({ id: 'tab-a' });
			const tabB = createMockTab({ id: 'tab-b' });
			const tabC = createMockTab({ id: 'tab-c' });
			const session = createMockSession({
				aiTabs: [tabA, tabB, tabC],
				activeTabId: 'tab-b',
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-a' },
					{ type: 'ai', id: 'tab-b' },
					{ type: 'ai', id: 'tab-c' },
				],
			});

			const result = createTab(session)!;

			expect(result.session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'tab-a' },
				{ type: 'ai', id: 'tab-b' },
				{ type: 'ai', id: result.tab.id },
				{ type: 'ai', id: 'tab-c' },
			]);
		});

		it('inserts new AI tab directly to the right of an active terminal tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '',
						createdAt: 0,
						state: 'idle',
					},
				],
				activeTerminalTabId: 'term-1',
				inputMode: 'terminal',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
				],
			});

			const result = createTab(session)!;

			expect(result.session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'terminal', id: 'term-1' },
				{ type: 'ai', id: result.tab.id },
			]);
		});

		it('inserts new AI tab directly to the right of an active file tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				filePreviewTabs: [fileTab],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = createTab(session)!;

			expect(result.session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: result.tab.id },
			]);
		});

		it('appends new AI tab when active tab cannot be located in unifiedTabOrder', () => {
			const tabA = createMockTab({ id: 'tab-a' });
			const session = createMockSession({
				aiTabs: [tabA],
				activeTabId: 'tab-a',
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-a' },
					{ type: 'ai', id: 'orphan-not-in-data' },
				],
			});

			const result = createTab(session)!;

			// Active tab is tab-a at index 0 - new tab should land at index 1
			expect(result.session.unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'tab-a' },
				{ type: 'ai', id: result.tab.id },
				{ type: 'ai', id: 'orphan-not-in-data' },
			]);
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

		it('uses repaired order to find neighbor when unifiedTabOrder has stale refs', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-2',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'deleted-tab' }, // stale ref
					{ type: 'ai', id: 'tab-2' },
				],
			});

			// Close the active tab (tab-2). Without repaired order, the stale ref
			// at index 1 would be the fallback neighbor and cause a bad lookup.
			const result = closeTab(session, 'tab-2');
			expect(result).not.toBeNull();
			// Should fall back to tab-1 (the live tab to the left), not the stale ref
			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('keeps session busy and tracks the closed tab in orphanedThinkingTabs when its agent is still running', () => {
			const busyTab = createMockTab({ id: 'tab-busy', state: 'busy' });
			const idleTab = createMockTab({ id: 'tab-idle', state: 'idle' });
			const thinkingStartTime = Date.now();
			const session = createMockSession({
				aiTabs: [busyTab, idleTab],
				activeTabId: 'tab-busy',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime,
			});

			const result = closeTab(session, 'tab-busy');

			expect(result).not.toBeNull();
			// Session stays busy - the underlying agent process is still running
			// even though the tab is no longer visible.
			expect(result!.session.state).toBe('busy');
			expect(result!.session.busySource).toBe('ai');
			expect(result!.session.thinkingStartTime).toBe(thinkingStartTime);
			// The closed busy tab is tracked for the thinking pill.
			expect(result!.session.orphanedThinkingTabs).toHaveLength(1);
			expect(result!.session.orphanedThinkingTabs![0].id).toBe('tab-busy');
		});

		it('keeps session busy when another tab is still busy', () => {
			const busyTab1 = createMockTab({ id: 'tab-busy-1', state: 'busy' });
			const busyTab2 = createMockTab({ id: 'tab-busy-2', state: 'busy' });
			const session = createMockSession({
				aiTabs: [busyTab1, busyTab2],
				activeTabId: 'tab-busy-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: Date.now(),
			});

			const result = closeTab(session, 'tab-busy-1');

			expect(result).not.toBeNull();
			expect(result!.session.state).toBe('busy');
			expect(result!.session.busySource).toBe('ai');
		});

		it('does not change session state when closing an idle tab', () => {
			const idleTab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const idleTab2 = createMockTab({ id: 'tab-2', state: 'idle' });
			const session = createMockSession({
				aiTabs: [idleTab1, idleTab2],
				activeTabId: 'tab-1',
				state: 'idle',
			});

			const result = closeTab(session, 'tab-1');

			expect(result).not.toBeNull();
			expect(result!.session.state).toBe('idle');
		});

		it('does not clear session busy state when busySource is terminal', () => {
			const busyTab = createMockTab({ id: 'tab-1', state: 'busy' });
			const idleTab = createMockTab({ id: 'tab-2', state: 'idle' });
			const session = createMockSession({
				aiTabs: [busyTab, idleTab],
				activeTabId: 'tab-1',
				state: 'busy',
				busySource: 'terminal',
				thinkingStartTime: Date.now(),
			});

			const result = closeTab(session, 'tab-1');

			expect(result).not.toBeNull();
			// busySource is 'terminal', so closing an AI tab should NOT clear it
			expect(result!.session.state).toBe('busy');
			expect(result!.session.busySource).toBe('terminal');
		});

		it('keeps session busy via orphanedThinkingTabs when closing the only (busy) tab and replacing it with a fresh idle tab', () => {
			const busyTab = createMockTab({ id: 'tab-only', state: 'busy' });
			const thinkingStartTime = Date.now();
			const session = createMockSession({
				aiTabs: [busyTab],
				activeTabId: 'tab-only',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime,
			});

			const result = closeTab(session, 'tab-only');

			expect(result).not.toBeNull();
			// A fresh idle tab was created to replace the closed one
			expect(result!.session.aiTabs).toHaveLength(1);
			expect(result!.session.aiTabs[0].state).toBe('idle');
			// Session stays busy - the orphaned tab is still thinking in the background.
			expect(result!.session.state).toBe('busy');
			expect(result!.session.busySource).toBe('ai');
			expect(result!.session.thinkingStartTime).toBe(thinkingStartTime);
			expect(result!.session.orphanedThinkingTabs).toHaveLength(1);
			expect(result!.session.orphanedThinkingTabs![0].id).toBe('tab-only');
		});

		describe('execution queue preservation on close (fire-and-forget)', () => {
			const makeQueuedItem = (tabId: string, text: string): QueuedItem => ({
				id: `q-${text}`,
				timestamp: Date.now(),
				tabId,
				type: 'message',
				text,
			});

			it('keeps queued items for a closed background tab and orphans the tab so they still send', () => {
				const tab1 = createMockTab({ id: 'tab-1' });
				const tab2 = createMockTab({ id: 'tab-2' });
				const session = createMockSession({
					aiTabs: [tab1, tab2],
					activeTabId: 'tab-1',
					executionQueue: [makeQueuedItem('tab-2', 'build api')],
				});

				const result = closeTab(session, 'tab-2');

				// The queued message survives the close: it fires in the background
				// against the now-orphaned tab rather than being discarded.
				expect(result!.session.executionQueue).toHaveLength(1);
				expect(result!.session.executionQueue[0].tabId).toBe('tab-2');
				// The closed tab is orphaned so it stays a valid dispatch target.
				expect(result!.session.orphanedThinkingTabs).toHaveLength(1);
				expect(result!.session.orphanedThinkingTabs![0].id).toBe('tab-2');
			});

			it('keeps the queued item when the only tab is closed and orphans that tab', () => {
				const tab = createMockTab({ id: 'tab-1' });
				const session = createMockSession({
					aiTabs: [tab],
					activeTabId: 'tab-1',
					executionQueue: [makeQueuedItem('tab-1', 'deploy')],
				});

				const result = closeTab(session, 'tab-1');

				// A fresh tab replaces the closed one in the tab bar, but the queued
				// item still belongs to the orphaned original and fires in the
				// background.
				expect(result!.session.executionQueue).toHaveLength(1);
				expect(result!.session.executionQueue[0].tabId).toBe('tab-1');
				expect(result!.session.orphanedThinkingTabs).toHaveLength(1);
				expect(result!.session.orphanedThinkingTabs![0].id).toBe('tab-1');
			});

			it("preserves each tab's queued items as that tab is closed", () => {
				const tab1 = createMockTab({ id: 'tab-1' });
				const tab2 = createMockTab({ id: 'tab-2' });
				const tab3 = createMockTab({ id: 'tab-3' });
				let session = createMockSession({
					aiTabs: [tab1, tab2, tab3],
					activeTabId: 'tab-1',
					executionQueue: [makeQueuedItem('tab-2', 'msg-b'), makeQueuedItem('tab-3', 'msg-c')],
				});

				session = closeTab(session, 'tab-2')!.session;
				// Closing tab-2 keeps both queued items; tab-2 is orphaned.
				expect(session.executionQueue).toHaveLength(2);
				expect(session.orphanedThinkingTabs?.map((t) => t.id)).toContain('tab-2');

				const result = closeTab(session, 'tab-3')!;

				// Closing tab-3 keeps both items; both closed tabs are now orphaned.
				expect(result.session.executionQueue).toHaveLength(2);
				expect(result.session.orphanedThinkingTabs?.map((t) => t.id)).toEqual(
					expect.arrayContaining(['tab-2', 'tab-3'])
				);
			});

			it('does not orphan a closed idle tab that has no queued items', () => {
				const tab1 = createMockTab({ id: 'tab-1' });
				const tab2 = createMockTab({ id: 'tab-2' });
				const queue = [makeQueuedItem('tab-1', 'keep me')];
				const session = createMockSession({
					aiTabs: [tab1, tab2],
					activeTabId: 'tab-1',
					executionQueue: queue,
				});

				const result = closeTab(session, 'tab-2');

				// tab-2 had no queued work and was idle, so nothing is orphaned and
				// tab-1's queued item is left untouched.
				expect(result!.session.executionQueue).toHaveLength(1);
				expect(result!.session.executionQueue[0].tabId).toBe('tab-1');
				expect(result!.session.orphanedThinkingTabs ?? []).toHaveLength(0);
			});
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

		it('switches inputMode to ai when selecting an AI tab from terminal mode', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
				inputMode: 'terminal',
			});

			const result = setActiveTab(session, 'tab-1');

			expect(result!.session).not.toBe(session);
			expect(result!.session.inputMode).toBe('ai');
		});

		it('clears activeBrowserTabId when selecting an AI tab (regression: browser outranks AI)', () => {
			// A browser tab was active. Browser outranks AI in the render precedence
			// (terminal > file > browser > ai), so a lingering activeBrowserTabId would
			// keep the browser view on screen even though activeTabId points at the AI tab.
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab],
				activeTabId: 'tab-1',
				activeBrowserTabId: 'browser-tab-1',
				inputMode: 'ai',
			});

			const result = setActiveTab(session, 'tab-1');

			expect(result!.session).not.toBe(session);
			expect(result!.session.activeBrowserTabId).toBeNull();
			expect(result!.session.activeTabId).toBe('tab-1');
		});

		it('activates the group and focuses the pane when selecting a tiled AI tab', () => {
			// The Tab Switcher lists group-member AI tabs (they stay in aiTabs), but they
			// have no standalone chip and are excluded from buildUnifiedTabs. Selecting one
			// must open its group and focus its pane, not fall through to the standalone path.
			const standalone = createMockTab({ id: 'tab-1' });
			const grouped = createMockTab({ id: 'grouped-ai' });
			const session = createMockSession({
				aiTabs: [standalone, grouped],
				activeTabId: 'tab-1',
				activeGroupId: null,
				inputMode: 'ai',
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'group', id: 'g1' },
				],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						// Focused elsewhere so we can prove selection moves it to leaf-b.
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'other-grouped' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'grouped-ai' } },
							],
						},
					},
				] as never,
			});

			const result = setActiveTab(session, 'grouped-ai');

			expect(result!.tab).toBe(grouped);
			// The group takes over the panel and its focused pane moves to the selected tab.
			expect(result!.session.activeGroupId).toBe('g1');
			expect(result!.session.tabGroups[0].focusedPaneId).toBe('leaf-b');
			// activeTabId is synced so the shared input targets the selected pane; standalone
			// ids clear and we stay in AI mode.
			expect(result!.session.activeTabId).toBe('grouped-ai');
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.activeBrowserTabId).toBeNull();
			expect(result!.session.activeTerminalTabId).toBeNull();
			expect(result!.session.inputMode).toBe('ai');
		});

		it('clears activeGroupId when selecting a standalone AI tab while a group is active', () => {
			// Regression: the standalone "already active" no-op must not fire while a group
			// is active, or the tiled view stays rendered instead of switching to the tab.
			const standalone = createMockTab({ id: 'tab-1' });
			const grouped = createMockTab({ id: 'grouped-ai' });
			const session = createMockSession({
				aiTabs: [standalone, grouped],
				activeTabId: 'tab-1',
				activeGroupId: 'g1',
				inputMode: 'ai',
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [1],
							children: [{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'grouped-ai' } }],
						},
					},
				] as never,
			});

			const result = setActiveTab(session, 'tab-1');

			expect(result!.session).not.toBe(session);
			expect(result!.session.activeGroupId).toBeNull();
			expect(result!.session.activeTabId).toBe('tab-1');
		});
	});

	describe('aiTabFocusFields', () => {
		it('clears all non-AI active-tab ids and forces AI mode', () => {
			const fields = aiTabFocusFields('tab-1');
			expect(fields).toEqual({
				activeTabId: 'tab-1',
				activeFileTabId: null,
				activeTerminalTabId: null,
				activeBrowserTabId: null,
				inputMode: 'ai',
				// Landing on an AI tab exits any active tiled group (tab tiling).
				activeGroupId: null,
			});
		});

		it('omits activeTabId when no tabId is given (keep current AI tab)', () => {
			const fields = aiTabFocusFields();
			expect(fields).not.toHaveProperty('activeTabId');
			expect(fields).toEqual({
				activeFileTabId: null,
				activeTerminalTabId: null,
				activeBrowserTabId: null,
				inputMode: 'ai',
				// Landing on an AI tab exits any active tiled group (tab tiling).
				activeGroupId: null,
			});
		});

		it('produces a patch that lands on the AI tab regardless of prior view', () => {
			// Spreading the patch over a session last viewed on a browser tab must
			// surface the AI tab, not the browser tab.
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
				activeFileTabId: 'file-1',
				activeTerminalTabId: 'term-1',
				activeBrowserTabId: 'browser-1',
				inputMode: 'ai',
			});

			const next = { ...session, ...aiTabFocusFields('tab-1') };

			expect(next.activeFileTabId).toBeNull();
			expect(next.activeTerminalTabId).toBeNull();
			expect(next.activeBrowserTabId).toBeNull();
			expect(next.activeTabId).toBe('tab-1');
			expect(next.inputMode).toBe('ai');
		});
	});

	describe('isSoleAiTabReplacement', () => {
		// closeTab() replaces the sole remaining AI tab with a fresh empty one, so the
		// session still has one tab but its id changed. This is the signal to focus the
		// chat input on that new tab.
		const single = (id: string, overrides: Partial<Session> = {}) =>
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [createMockTab({ id })],
				activeTabId: id,
				...overrides,
			});

		it('detects the sole AI tab being swapped for a fresh one', () => {
			expect(isSoleAiTabReplacement('session-1', ['old-tab'], single('fresh-tab'))).toBe(true);
		});

		it('returns false when the single tab id is unchanged', () => {
			expect(isSoleAiTabReplacement('session-1', ['tab-1'], single('tab-1'))).toBe(false);
		});

		it('returns false when the previous session was a different agent', () => {
			expect(isSoleAiTabReplacement('session-2', ['old-tab'], single('fresh-tab'))).toBe(false);
		});

		it('returns false when there was more than one tab before', () => {
			expect(isSoleAiTabReplacement('session-1', ['a', 'b'], single('fresh-tab'))).toBe(false);
		});

		it('returns false when more than one tab remains', () => {
			const session = single('fresh-tab', {
				aiTabs: [createMockTab({ id: 'fresh-tab' }), createMockTab({ id: 'other' })],
			});
			expect(isSoleAiTabReplacement('session-1', ['old-tab'], session)).toBe(false);
		});

		it('returns false when the view is not in AI mode (e.g. terminal showing)', () => {
			expect(
				isSoleAiTabReplacement(
					'session-1',
					['old-tab'],
					single('fresh-tab', { inputMode: 'terminal' })
				)
			).toBe(false);
		});

		it('returns false for a null/undefined session', () => {
			expect(isSoleAiTabReplacement('session-1', ['old-tab'], null)).toBe(false);
			expect(isSoleAiTabReplacement('session-1', ['old-tab'], undefined)).toBe(false);
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

		it('ignores busy orphaned tabs by default', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const orphan = createMockTab({ id: 'orphan-1', state: 'busy' });
			const session = createMockSession({
				aiTabs: [tab1],
				orphanedThinkingTabs: [orphan],
			});

			expect(getBusyTabs(session)).toEqual([]);
		});

		it('includes busy orphaned tabs when includeOrphans is set', () => {
			const tab1 = createMockTab({ id: 'tab-1', state: 'idle' });
			const orphan = createMockTab({ id: 'orphan-1', state: 'busy' });
			const session = createMockSession({
				aiTabs: [tab1],
				orphanedThinkingTabs: [orphan],
			});

			const result = getBusyTabs(session, { includeOrphans: true });

			expect(result).toHaveLength(1);
			expect(result).toContain(orphan);
		});

		it('counts an orphan as a busy writer even when the fresh aiTab is idle', () => {
			// Regression: Cmd+W on a running tab parks it in orphanedThinkingTabs and
			// leaves a fresh idle aiTab. The orphan is still a live writer, so the
			// single-writer gate must see it (otherwise a new write spawns concurrently).
			const freshTab = createMockTab({ id: 'fresh', state: 'idle', readOnlyMode: false });
			const orphan = createMockTab({ id: 'orphan-1', state: 'busy', readOnlyMode: false });
			const session = createMockSession({
				aiTabs: [freshTab],
				orphanedThinkingTabs: [orphan],
			});

			const busy = getBusyTabs(session, { includeOrphans: true });
			expect(busy).toHaveLength(1);
			expect(busy.every((tab) => tab.readOnlyMode === true)).toBe(false);
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

		it('excludes hidden tabs so tab-cycling never lands on one', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const consult = createMockTab({ id: 'consult', hidden: true });
			const session = createMockSession({ aiTabs: [tab1, consult] });

			expect(getNavigableTabs(session).map((t) => t.id)).toEqual(['tab-1']);
		});

		it('excludes hidden tabs from the unread filter too', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: true });
			const consult = createMockTab({ id: 'consult', hidden: true, hasUnread: true });
			const session = createMockSession({ aiTabs: [tab1, consult] });

			expect(getNavigableTabs(session, true).map((t) => t.id)).toEqual(['tab-1']);
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

		it('includes idle tabs with queued execution items when showUnreadOnly is true', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, inputValue: '' });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				executionQueue: [
					{
						id: 'q-1',
						timestamp: Date.now(),
						tabId: 'tab-2',
						type: 'message',
						text: 'queued prompt',
					},
				],
			});

			expect(getNavigableTabs(session, true).map((t) => t.id)).toEqual(['tab-2']);
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

	describe('computeQueuedTabIds', () => {
		it('returns the ids of tabs that have queued execution items', () => {
			const session = createMockSession({
				executionQueue: [
					{ id: 'q-1', timestamp: 1, tabId: 'tab-2', type: 'message', text: 'a' },
					{ id: 'q-2', timestamp: 2, tabId: 'tab-2', type: 'command', command: '/commit' },
					{ id: 'q-3', timestamp: 3, tabId: 'tab-5', type: 'message', text: 'b' },
				],
			});

			expect(computeQueuedTabIds(session)).toEqual(new Set(['tab-2', 'tab-5']));
		});

		it('returns an empty set when the execution queue is empty', () => {
			const session = createMockSession({ executionQueue: [] });
			expect(computeQueuedTabIds(session).size).toBe(0);
		});

		it('counts paused queued items as pending work', () => {
			const session = createMockSession({
				executionQueue: [
					{ id: 'q-1', timestamp: 1, tabId: 'tab-3', type: 'message', text: 'held', paused: true },
				],
			});

			expect(computeQueuedTabIds(session).has('tab-3')).toBe(true);
		});
	});

	describe('filterUnifiedTabOrderForUnread (queued tabs)', () => {
		it('keeps an idle AI tab visible when it has a queued execution item', () => {
			const tab1 = createMockTab({ id: 'tab-1', hasUnread: false, inputValue: '' });
			const tab2 = createMockTab({ id: 'tab-2', hasUnread: false, inputValue: '' });
			// inputMode 'terminal' so the active-AI-tab branch does not keep tab-1
			// visible; tab-2 must survive purely because it has queued work.
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
				inputMode: 'terminal',
				executionQueue: [
					{ id: 'q-1', timestamp: 1, tabId: 'tab-2', type: 'message', text: 'queued' },
				],
			});

			const filtered = filterUnifiedTabOrderForUnread(session, getRepairedUnifiedTabOrder(session));

			expect(filtered.some((ref) => ref.type === 'ai' && ref.id === 'tab-2')).toBe(true);
			expect(filtered.some((ref) => ref.type === 'ai' && ref.id === 'tab-1')).toBe(false);
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

		it('navigates to a group by unified index (sets activeGroupId, syncs focused AI pane)', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const grouped = createMockTab({ id: 'grouped-ai' });
			const groupedB = createMockTab({ id: 'grouped-ai-b' });
			const session = createMockSession({
				aiTabs: [tab1, grouped, groupedB],
				activeTabId: 'tab-1',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'group', id: 'g1' },
				],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'grouped-ai' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'grouped-ai-b' } },
							],
						},
					},
				] as never,
				activeGroupId: null,
			});

			const result = navigateToUnifiedTabByIndex(session, 1);

			expect(result!.type).toBe('group');
			expect(result!.id).toBe('g1');
			// The group takes over the panel; standalone selections clear; input targets
			// the group's focused AI pane.
			expect(result!.session.activeGroupId).toBe('g1');
			expect(result!.session.activeTabId).toBe('grouped-ai');
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.inputMode).toBe('ai');
		});

		it('clears activeGroupId when navigating from a group to a standalone tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const grouped = createMockTab({ id: 'grouped-ai' });
			const groupedB = createMockTab({ id: 'grouped-ai-b' });
			const session = createMockSession({
				aiTabs: [tab1, grouped, groupedB],
				activeTabId: 'grouped-ai',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'group', id: 'g1' },
				],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'grouped-ai' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'grouped-ai-b' } },
							],
						},
					},
				] as never,
				activeGroupId: 'g1',
			});

			// Index 0 is the standalone tab-1; leaving the group must drop the takeover.
			const result = navigateToUnifiedTabByIndex(session, 0);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('tab-1');
			expect(result!.session.activeGroupId).toBeNull();
			expect(result!.session.activeTabId).toBe('tab-1');
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
			const session = createMockSession({
				aiTabs: [],
				unifiedTabOrder: [{ type: 'ai', id: 'non-existent' }],
			});

			// After pruning, the dead ref is removed and the order is empty
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

		it('when showUnreadOnly is true, index points into the filtered (visible) tab list', () => {
			// Three AI tabs. Only the "unread" one matches the filter; the other inactive, read
			// tab gets hidden from the tab bar. The active AI tab always remains visible because
			// the TabBar renders it regardless of filter.
			const readTab = createMockTab({ id: 'ai-read', hasUnread: false });
			const unreadTab = createMockTab({ id: 'ai-unread', hasUnread: true });
			const activeTab = createMockTab({ id: 'ai-active', hasUnread: false });
			const session = createMockSession({
				aiTabs: [readTab, unreadTab, activeTab],
				activeTabId: 'ai-active',
				inputMode: 'ai',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-read' },
					{ type: 'ai', id: 'ai-unread' },
					{ type: 'ai', id: 'ai-active' },
				],
			});

			// Without filter: index 0 → first tab in original order
			expect(navigateToUnifiedTabByIndex(session, 0)!.id).toBe('ai-read');

			// With filter: read tab is hidden, so the visible list is [unread, active].
			// Index 0 → unread, index 1 → active, index 2 falls off the end.
			expect(navigateToUnifiedTabByIndex(session, 0, true)!.id).toBe('ai-unread');
			expect(navigateToUnifiedTabByIndex(session, 1, true)!.id).toBe('ai-active');
			expect(navigateToUnifiedTabByIndex(session, 2, true)).toBeNull();
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

		it('resets inputMode to ai when navigating from terminal tab to AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const terminalTab = { id: 'term-1', shellType: 'zsh', state: 'idle' as const };
			const session = createMockSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab] as any,
				activeTabId: 'ai-1',
				activeFileTabId: null,
				inputMode: 'terminal',
				activeTerminalTabId: 'term-1',
				unifiedTabOrder: [
					{ type: 'terminal', id: 'term-1' },
					{ type: 'ai', id: 'ai-1' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 1);

			expect(result!.type).toBe('ai');
			expect(result!.session.inputMode).toBe('ai');
			expect(result!.session.activeTerminalTabId).toBeNull();
		});

		it('resets inputMode to ai when navigating from terminal tab to file tab', () => {
			const fileTab = createMockFileTab({ id: 'file-1' });
			const terminalTab = { id: 'term-1', shellType: 'zsh', state: 'idle' as const };
			const session = createMockSession({
				aiTabs: [],
				filePreviewTabs: [fileTab],
				terminalTabs: [terminalTab] as any,
				activeFileTabId: null,
				inputMode: 'terminal',
				activeTerminalTabId: 'term-1',
				unifiedTabOrder: [
					{ type: 'terminal', id: 'term-1' },
					{ type: 'file', id: 'file-1' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 1);

			expect(result!.type).toBe('file');
			expect(result!.session.inputMode).toBe('ai');
			expect(result!.session.activeTerminalTabId).toBeNull();
		});
	});

	describe('navigateToUnifiedTabById', () => {
		it('activates a browser tab by id, clearing file/terminal selection', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				browserTabs: [browserTab] as any,
				activeTabId: 'ai-1',
				activeFileTabId: null,
				activeBrowserTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'browser', id: 'browser-1' },
				],
			});

			const result = navigateToUnifiedTabById(session, 'browser', 'browser-1');

			expect(result!.type).toBe('browser');
			expect(result!.id).toBe('browser-1');
			expect(result!.session.activeBrowserTabId).toBe('browser-1');
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.activeTerminalTabId).toBeNull();
			expect(result!.session.inputMode).toBe('ai');
		});

		it('activates a terminal tab by id, setting inputMode to terminal', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const terminalTab = { id: 'term-1', name: 'Terminal 1' };
			const session = createMockSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab] as any,
				activeTabId: 'ai-1',
				activeTerminalTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
				],
			});

			const result = navigateToUnifiedTabById(session, 'terminal', 'term-1');

			expect(result!.type).toBe('terminal');
			expect(result!.session.activeTerminalTabId).toBe('term-1');
			expect(result!.session.inputMode).toBe('terminal');
		});

		it('returns null when the target tab no longer exists', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			});

			expect(navigateToUnifiedTabById(session, 'browser', 'gone')).toBeNull();
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
			expect(session.autoRunFolderPath).toBe('/path/to/project/.maestro/playbooks');
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
			expect(session.autoRunFolderPath).toBe('/project/.maestro/playbooks');
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

		it('restores a closed terminal tab with a freshly minted coworkingId and bumps the counter', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const closedTerminalTab: TerminalTab = {
				id: 'term-1',
				name: null,
				shellType: 'zsh',
				pid: 0,
				cwd: '/test',
				createdAt: Date.now(),
				state: 'idle',
			};
			const closedEntry = {
				type: 'terminal' as const,
				tab: closedTerminalTab,
				unifiedIndex: 1,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				nextCoworkingId: 5,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('terminal');
			// The restored tab must carry a numeric coworkingId (its term:N id) so it
			// stays addressable by the coworking list_terminals registry, which only
			// exposes terminal tabs where typeof coworkingId === 'number'. An id-less
			// restore would be silently filtered out.
			const restored = result!.session.terminalTabs.find((t) => t.id === result!.tabId);
			expect(restored).toBeDefined();
			expect(typeof restored!.coworkingId).toBe('number');
			// nextCoworkingId was 5 and no terminal tabs existed, so the mint is 5.
			expect(restored!.coworkingId).toBe(5);
			// Counter bumps strictly past the minted id so ids are never reused.
			expect(result!.session.nextCoworkingId).toBe(6);
		});

		it('clamps the restored terminal coworkingId past the highest existing terminal id', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const closedTerminalTab: TerminalTab = {
				id: 'term-1',
				name: null,
				shellType: 'zsh',
				pid: 0,
				cwd: '/test',
				createdAt: Date.now(),
				state: 'idle',
			};
			const closedEntry = {
				type: 'terminal' as const,
				tab: closedTerminalTab,
				unifiedIndex: 2,
				closedAt: Date.now(),
			};
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: 'ai-1',
				// nextCoworkingId intentionally left unset (legacy session). The mint must
				// still clamp against max(existing coworkingId) + 1, not restart at 1.
				terminalTabs: [
					{
						id: 'term-existing',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
						coworkingId: 9,
					},
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-existing' },
				],
				unifiedClosedTabHistory: [closedEntry],
			});

			const result = reopenUnifiedClosedTab(session);

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('terminal');
			const restored = result!.session.terminalTabs.find((t) => t.id === result!.tabId);
			expect(restored).toBeDefined();
			expect(restored!.coworkingId).toBe(10);
			expect(result!.session.nextCoworkingId).toBe(11);
		});
	});

	describe('reopenClosedAiTabById', () => {
		it('returns null when no closed AI tab matches the id', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [],
				closedTabHistory: [],
			});
			expect(reopenClosedAiTabById(session, 'does-not-exist')).toBeNull();
		});

		it('restores a specific closed AI tab from unified history by id', () => {
			const closedA = createMockTab({ id: 'closed-a', agentSessionId: 'session-a' });
			const closedB = createMockTab({ id: 'closed-b', agentSessionId: 'session-b' });
			const entryA = { type: 'ai' as const, tab: closedA, unifiedIndex: 0, closedAt: Date.now() };
			const entryB = { type: 'ai' as const, tab: closedB, unifiedIndex: 1, closedAt: Date.now() };
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				// closedB is more recent (index 0) - target the older closedA by id
				unifiedClosedTabHistory: [entryB, entryA],
			});

			const result = reopenClosedAiTabById(session, 'closed-a');

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('ai');
			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.aiTabs).toHaveLength(2);
			expect(result!.session.activeTabId).toBe(result!.tabId);
			// Only the targeted entry is removed; the more recent one stays.
			expect(result!.session.unifiedClosedTabHistory).toHaveLength(1);
			expect(result!.session.unifiedClosedTabHistory![0].tab.id).toBe('closed-b');
		});

		it('switches to an existing tab instead of duplicating when agentSessionId matches', () => {
			const existing = createMockTab({ id: 'ai-existing', agentSessionId: 'session-dup' });
			const closed = createMockTab({ id: 'closed-dup', agentSessionId: 'session-dup' });
			const entry = { type: 'ai' as const, tab: closed, unifiedIndex: 0, closedAt: Date.now() };
			const session = createMockSession({
				aiTabs: [existing],
				activeTabId: 'ai-existing',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-existing' }],
				unifiedClosedTabHistory: [entry],
			});

			const result = reopenClosedAiTabById(session, 'closed-dup');

			expect(result).not.toBeNull();
			expect(result!.wasDuplicate).toBe(true);
			expect(result!.tabId).toBe('ai-existing');
			expect(result!.session.aiTabs).toHaveLength(1);
			expect(result!.session.unifiedClosedTabHistory).toHaveLength(0);
		});

		it('falls back to legacy closedTabHistory by id', () => {
			const closed = createMockTab({ id: 'legacy-closed', agentSessionId: 'legacy-session' });
			const entry: ClosedTab = { tab: closed, index: 0, closedAt: Date.now() };
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				unifiedClosedTabHistory: [],
				closedTabHistory: [entry],
			});

			const result = reopenClosedAiTabById(session, 'legacy-closed');

			expect(result).not.toBeNull();
			expect(result!.tabType).toBe('ai');
			expect(result!.wasDuplicate).toBe(false);
			expect(result!.session.aiTabs).toHaveLength(2);
			expect(result!.session.closedTabHistory).toHaveLength(0);
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

		it('includes file tabs in showUnreadOnly mode when setting enabled', () => {
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: true });
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
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: false });
		});

		it('skips file tabs in showUnreadOnly mode when setting disabled', () => {
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: false });
			const unreadTab = createMockTab({ id: 'unread-tab', hasUnread: true, inputValue: '' });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [readTab, unreadTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'read-tab' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'unread-tab' },
				],
			});

			const result = navigateToNextUnifiedTab(session, true);

			// Should skip the file tab and land on the unread AI tab
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('unread-tab');
		});

		it('keeps the active file tab visible in showUnreadOnly mode even when file-preview setting is off', () => {
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: false });
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const activeFile = createMockFileTab({ id: 'file-active' });
			const otherFile = createMockFileTab({ id: 'file-other' });
			const session = createMockSession({
				aiTabs: [readTab],
				filePreviewTabs: [activeFile, otherFile],
				activeTabId: 'read-tab',
				activeFileTabId: 'file-active',
				unifiedTabOrder: [
					{ type: 'file', id: 'file-active' },
					{ type: 'file', id: 'file-other' },
					{ type: 'ai', id: 'read-tab' },
				],
			});

			// From the active file tab, Next should wrap past the hidden non-active file tab
			// and land back on the AI tab, then on the active file tab again - confirming the
			// active file is the only file ref in the filtered list.
			const result = navigateToNextUnifiedTab(session, true);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('read-tab');
		});

		it('includes browser tabs in showUnreadOnly mode', () => {
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [readTab],
				browserTabs: [browserTab as any],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'read-tab' },
					{ type: 'browser', id: 'browser-1' },
				],
			});

			const result = navigateToNextUnifiedTab(session, true);

			expect(result!.type).toBe('browser');
			expect(result!.id).toBe('browser-1');
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

		it('does not jump to the last-active AI tab when on a terminal tab in unread filter', () => {
			// Regression: prev/next used to treat activeTabId as reachable regardless of
			// inputMode, so pressing next/prev on a terminal tab while an AI tab was the
			// last-active one would jump through the hidden AI tab. TabBar hides that AI
			// tab when inputMode !== 'ai', and navigation must match.
			const unreadAi = createMockTab({ id: 'ai-unread', hasUnread: true });
			const readAi = createMockTab({ id: 'ai-read', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [unreadAi, readAi],
				terminalTabs: [
					{ id: 'term-1', name: 'Terminal 1' } as any,
					{ id: 'term-2', name: 'Terminal 2' } as any,
				],
				activeTabId: 'ai-read', // last-active AI tab (read, not busy, no draft)
				activeTerminalTabId: 'term-2',
				activeFileTabId: null,
				inputMode: 'terminal',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-unread' },
					{ type: 'terminal', id: 'term-1' },
					{ type: 'ai', id: 'ai-read' },
					{ type: 'terminal', id: 'term-2' },
				],
			});

			// From Terminal 2, next (with wrap) should land on the unread AI tab, not the
			// hidden read AI tab sitting between term-1 and term-2.
			const forward = navigateToNextUnifiedTab(session, true);
			expect(forward!.type).toBe('ai');
			expect(forward!.id).toBe('ai-unread');

			// From Terminal 2, prev should land on Terminal 1 - the hidden AI tab
			// between them must be skipped.
			const backward = navigateToPrevUnifiedTab(session, true);
			expect(backward!.type).toBe('terminal');
			expect(backward!.id).toBe('term-1');
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

		it('includes file tabs in showUnreadOnly mode when setting enabled', () => {
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: true });
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
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: false });
		});

		it('skips file tabs in showUnreadOnly mode when setting disabled', () => {
			useSettingsStore.setState({ showFilePreviewsInUnreadFilter: false });
			const fileTab = createMockFileTab({ id: 'file-1' });
			const unreadTab = createMockTab({ id: 'unread-tab', hasUnread: true, inputValue: '' });
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const session = createMockSession({
				aiTabs: [readTab, unreadTab],
				filePreviewTabs: [fileTab],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: 'unread-tab' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'read-tab' },
				],
			});

			const result = navigateToPrevUnifiedTab(session, true);

			// Should skip the file tab and land on the unread AI tab
			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('unread-tab');
		});

		it('includes browser tabs in showUnreadOnly mode', () => {
			const readTab = createMockTab({ id: 'read-tab', hasUnread: false, inputValue: '' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [readTab],
				browserTabs: [browserTab as any],
				activeTabId: 'read-tab',
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'browser', id: 'browser-1' },
					{ type: 'ai', id: 'read-tab' },
				],
			});

			const result = navigateToPrevUnifiedTab(session, true);

			expect(result!.type).toBe('browser');
			expect(result!.id).toBe('browser-1');
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

		// Regression: when the user is on a browser tab whose adjacent AI tab is
		// also referenced by session.activeTabId (a stale leftover from before
		// the browser tab was opened), navigating prev to the AI tab used to no-op
		// because the AI branch's "already active" early-return ignored
		// activeBrowserTabId and returned without clearing it. The browser tab
		// outranks the AI tab in findActiveUnifiedTabIndex, so the user-visible
		// active tab never changed.
		it('navigates from active browser tab to AI tab even when activeTabId still points at that AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				browserTabs: [browserTab],
				activeTabId: 'ai-1', // Stale - points at the AI tab we're about to navigate to
				activeBrowserTabId: 'browser-1', // What the user is actually on
				activeFileTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'browser', id: 'browser-1' },
				],
			});

			const result = navigateToPrevUnifiedTab(session);

			expect(result!.type).toBe('ai');
			expect(result!.id).toBe('ai-1');
			expect(result!.session.activeTabId).toBe('ai-1');
			expect(result!.session.activeBrowserTabId).toBeNull();
			expect(result!.session.activeFileTabId).toBeNull();
			expect(result!.session.activeTerminalTabId).toBeNull();
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

	describe('hidden AI tabs', () => {
		it('keeps a hidden tab out of the strip even though it holds a unifiedTabOrder ref', () => {
			const visible = createMockTab({ id: 'ai-1' });
			const consult = createMockTab({ id: 'consult', hidden: true });
			const session = createMockSession({
				aiTabs: [visible, consult],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'consult' },
				],
			});

			expect(buildUnifiedTabs(session).map((t) => t.id)).toEqual(['ai-1']);
		});

		it('does not let the orphan fallback re-surface a hidden tab with no order ref', () => {
			const visible = createMockTab({ id: 'ai-1' });
			const consult = createMockTab({ id: 'consult', hidden: true });
			const session = createMockSession({
				aiTabs: [visible, consult],
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			});

			expect(buildUnifiedTabs(session).map((t) => t.id)).toEqual(['ai-1']);
		});

		it('revealAiTab surfaces the tab at its original position in the strip', () => {
			const consult = createMockTab({ id: 'consult', hidden: true });
			const trailing = createMockTab({ id: 'ai-2' });
			const session = createMockSession({
				aiTabs: [consult, trailing],
				unifiedTabOrder: [
					{ type: 'ai', id: 'consult' },
					{ type: 'ai', id: 'ai-2' },
				],
			});

			const revealed = revealAiTab(session, 'consult');

			// Position is preserved because the ref was never removed while hidden.
			expect(buildUnifiedTabs(revealed).map((t) => t.id)).toEqual(['consult', 'ai-2']);
			expect(revealed.aiTabs.find((t) => t.id === 'consult')!.hidden).toBe(false);
		});

		it('revealAiTab returns the session unchanged for a visible or unknown tab', () => {
			const visible = createMockTab({ id: 'ai-1' });
			const session = createMockSession({ aiTabs: [visible] });

			expect(revealAiTab(session, 'ai-1')).toBe(session);
			expect(revealAiTab(session, 'nope')).toBe(session);
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

		it('hides tabs that are tiled into a group (the group chip represents them)', () => {
			const aiTab1 = createMockTab({ id: 'ai-1' });
			const aiTab2 = createMockTab({ id: 'ai-tiled' });
			const fileTab = createMockFileTab({ id: 'file-tiled' });
			const session = createMockSession({
				aiTabs: [aiTab1, aiTab2],
				filePreviewTabs: [fileTab],
				// ai-1 is a standalone strip tab; the other two are tiled and were pulled
				// from unifiedTabOrder, so they'd otherwise resurface via the orphan fallback.
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'ai-tiled' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'file', id: 'file-tiled' } },
							],
						},
					},
				] as never,
				activeGroupId: 'g1',
			});

			const result = buildUnifiedTabs(session);

			// The two tiled members are folded away; the group shows as a single entry
			// (appended here since this session has no group ref in unifiedTabOrder yet -
			// the orphan-group safety net; normalizeTabGroups backfills the ref on load).
			expect(result).toHaveLength(2);
			expect(result.some((t) => t.id === 'ai-1' && t.type === 'ai')).toBe(true);
			expect(result.some((t) => t.id === 'g1' && t.type === 'group')).toBe(true);
			expect(result.some((t) => t.id === 'ai-tiled')).toBe(false);
			expect(result.some((t) => t.id === 'file-tiled')).toBe(false);
		});

		it('renders a group ref inline at its position in unifiedTabOrder', () => {
			const aiTab1 = createMockTab({ id: 'ai-1' });
			const aiTab2 = createMockTab({ id: 'ai-tiled' });
			const fileTab = createMockFileTab({ id: 'file-tiled' });
			const session = createMockSession({
				aiTabs: [aiTab1, aiTab2],
				filePreviewTabs: [fileTab],
				// The group ref sits BEFORE ai-1 in the order, so its chip renders first.
				unifiedTabOrder: [
					{ type: 'group', id: 'g1' },
					{ type: 'ai', id: 'ai-1' },
				],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'ai-tiled' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'file', id: 'file-tiled' } },
							],
						},
					},
				] as never,
				activeGroupId: 'g1',
			});

			const result = buildUnifiedTabs(session);

			expect(result).toHaveLength(2);
			// Group chip renders inline at its order position (index 0), not appended last.
			expect(result[0].type).toBe('group');
			expect(result[0].id).toBe('g1');
			expect(result[1]).toMatchObject({ type: 'ai', id: 'ai-1' });
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

		it('prunes stale entries whose tabs no longer exist', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				aiTabs: [tab1],
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'deleted-tab' },
				],
			});

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ type: 'ai', id: 'tab-1' });
		});

		it('removes duplicate live refs so navigation indices match buildUnifiedTabs', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				aiTabs: [tab1, tab2],
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'tab-1' }, // duplicate
					{ type: 'ai', id: 'tab-2' },
				],
			});

			const result = getRepairedUnifiedTabOrder(session);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ type: 'ai', id: 'tab-1' });
			expect(result[1]).toEqual({ type: 'ai', id: 'tab-2' });
		});

		it('drops a lingering member ref for a tab tiled into a group so navigation matches the strip', () => {
			// A tab that is tiled into a group is represented by the group ref, never its own
			// standalone ref. buildUnifiedTabs filters such member refs out of the rendered
			// strip; the repaired order (which drives Cmd+N / next-prev) must do the same, or
			// navigation would step through group members individually instead of treating the
			// group as a single stop.
			const standalone = createMockTab({ id: 'tab-1' });
			const groupedA = createMockTab({ id: 'grouped-a' });
			const groupedB = createMockTab({ id: 'grouped-b' });
			const session = createMockSession({
				aiTabs: [standalone, groupedA, groupedB],
				// A stale member ref (grouped-a) lingers in the order alongside the group ref.
				unifiedTabOrder: [
					{ type: 'ai', id: 'tab-1' },
					{ type: 'ai', id: 'grouped-a' },
					{ type: 'group', id: 'g1' },
				],
				tabGroups: [
					{
						id: 'g1',
						name: 'Group',
						createdAt: 0,
						focusedPaneId: 'leaf-a',
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'grouped-a' } },
								{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'grouped-b' } },
							],
						},
					},
				] as never,
			});

			const result = getRepairedUnifiedTabOrder(session);
			// Only the standalone tab and the group remain - no individual member refs.
			expect(result).toEqual([
				{ type: 'ai', id: 'tab-1' },
				{ type: 'group', id: 'g1' },
			]);
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

	describe('navigateToClosestTerminalTab', () => {
		it('returns null when no terminal tabs exist', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			});

			expect(navigateToClosestTerminalTab(session)).toBeNull();
		});

		it('navigates to the only terminal tab', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
				],
			});

			const result = navigateToClosestTerminalTab(session);
			expect(result).not.toBeNull();
			expect(result!.type).toBe('terminal');
			expect(result!.id).toBe('term-1');
			expect(result!.session.inputMode).toBe('terminal');
		});

		it('navigates to the closest terminal tab when multiple exist', () => {
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'ai-1' }),
					createMockTab({ id: 'ai-2' }),
					createMockTab({ id: 'ai-3' }),
				],
				activeTabId: 'ai-2',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
					{
						id: 'term-2',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				unifiedTabOrder: [
					{ type: 'terminal', id: 'term-1' },
					{ type: 'ai', id: 'ai-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'ai', id: 'ai-3' },
					{ type: 'terminal', id: 'term-2' },
				],
			});

			const result = navigateToClosestTerminalTab(session);
			expect(result).not.toBeNull();
			expect(result!.type).toBe('terminal');
			// ai-2 is at index 2, term-1 is at index 0 (dist=2), term-2 is at index 4 (dist=2)
			// Equal distance - first found wins (term-1)
			expect(result!.id).toBe('term-1');
		});

		it('cycles to next terminal tab when already on one', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				inputMode: 'terminal',
				activeTerminalTabId: 'term-1',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
					{
						id: 'term-2',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
					{ type: 'terminal', id: 'term-2' },
				],
			});

			const result = navigateToClosestTerminalTab(session);
			expect(result).not.toBeNull();
			expect(result!.type).toBe('terminal');
			expect(result!.id).toBe('term-2');
		});

		it('stays on current terminal tab when only one exists', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				inputMode: 'terminal',
				activeTerminalTabId: 'term-1',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
				],
			});

			const result = navigateToClosestTerminalTab(session);
			expect(result).not.toBeNull();
			expect(result!.type).toBe('terminal');
			expect(result!.id).toBe('term-1');
		});

		it('wraps around to first terminal tab from the last one', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'ai-1' })],
				activeTabId: 'ai-1',
				inputMode: 'terminal',
				activeTerminalTabId: 'term-2',
				terminalTabs: [
					{
						id: 'term-1',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
					{
						id: 'term-2',
						name: null,
						shellType: 'zsh',
						pid: 0,
						cwd: '/test',
						createdAt: Date.now(),
						state: 'idle',
					},
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'terminal', id: 'term-1' },
					{ type: 'terminal', id: 'term-2' },
				],
			});

			const result = navigateToClosestTerminalTab(session);
			expect(result).not.toBeNull();
			expect(result!.type).toBe('terminal');
			expect(result!.id).toBe('term-1');
		});

		it('returns null for empty session', () => {
			const session = createMockSession({ unifiedTabOrder: [] });
			expect(navigateToClosestTerminalTab(session)).toBeNull();
		});
	});

	describe('findNextUnreadSession', () => {
		it('returns jumped=true when another session has unread tabs', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: true })],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
		});

		it('returns the first unread tab that differs from activeTabId', () => {
			const sessions = [
				createMockSession({ id: 'a', aiTabs: [], activeTabId: '' }),
				createMockSession({
					id: 'b',
					aiTabs: [
						createMockTab({ id: 'tab-b1', hasUnread: false }),
						createMockTab({ id: 'tab-b2', hasUnread: true }),
					],
					activeTabId: 'tab-b1',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
			expect(result.targetTabId).toBe('tab-b2');
		});

		it('does not set targetTabId when the first unread tab is already active', () => {
			const sessions = [
				createMockSession({ id: 'a', aiTabs: [], activeTabId: '' }),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b1', hasUnread: true })],
					activeTabId: 'tab-b1',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetTabId).toBeUndefined();
		});

		it('wraps around to find unread sessions before current', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: true })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: false })],
					activeTabId: 'tab-b',
				}),
				createMockSession({
					id: 'c',
					aiTabs: [createMockTab({ id: 'tab-c', hasUnread: false })],
					activeTabId: 'tab-c',
				}),
			];
			const result = findNextUnreadSession(sessions, 'c');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('a');
		});

		it('returns jumped=false when no other session has unread tabs and the only unread is the active tab', () => {
			// Active tab with hasUnread is unusual but we tolerate it: the
			// active tab is what the user is looking at, so we don't silently
			// clear it and don't claim to have "jumped" anywhere.
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: true })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: false })],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(false);
			expect(result.clearedCurrent).toBe(false);
		});

		it('jumps to a non-active unread tab within the current session before searching others', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [
						createMockTab({ id: 'tab-a1', hasUnread: false }),
						createMockTab({ id: 'tab-a2', hasUnread: true }),
					],
					activeTabId: 'tab-a1',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: true })],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('a');
			expect(result.targetTabId).toBe('tab-a2');
			expect(result.clearedCurrent).toBe(false);
		});

		it('reports clearedCurrent=true when moving to another session and current has unread', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: true })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: true })],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
			expect(result.clearedCurrent).toBe(true);
		});

		it('reports clearedCurrent=false when current session has no unread tabs', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(false);
			expect(result.clearedCurrent).toBe(false);
		});

		it('jumps to session with draft tab (unsent input)', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: false, inputValue: 'draft text' })],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
		});

		it('jumps to session with staged images (draft)', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [
						createMockTab({
							id: 'tab-b',
							hasUnread: false,
							stagedImages: [{ name: 'img.png', data: 'base64data', mediaType: 'image/png' }],
						}),
					],
					activeTabId: 'tab-b',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
		});

		it('does not report clearedCurrent when the only draft tab is the active one', () => {
			// The active tab's draft is what the user is composing - we don't
			// jump anywhere and we don't clear unread/draft state.
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false, inputValue: 'wip' })],
					activeTabId: 'tab-a',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(false);
			expect(result.clearedCurrent).toBe(false);
		});

		it('jumps within the current session to a non-active draft tab', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [
						createMockTab({ id: 'tab-a1', hasUnread: false }),
						createMockTab({ id: 'tab-a2', hasUnread: false, inputValue: 'unsent text' }),
					],
					activeTabId: 'tab-a1',
				}),
			];
			const result = findNextUnreadSession(sessions, 'a');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('a');
			expect(result.targetTabId).toBe('tab-a2');
		});

		it('prefers the next session in order over earlier ones', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: true })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: false })],
					activeTabId: 'tab-b',
				}),
				createMockSession({
					id: 'c',
					aiTabs: [createMockTab({ id: 'tab-c', hasUnread: true })],
					activeTabId: 'tab-c',
				}),
			];
			const result = findNextUnreadSession(sessions, 'b');
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('c');
		});

		it('treats a tab with an active wizard as actionable and jumps to it', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
				createMockSession({
					id: 'b',
					aiTabs: [createMockTab({ id: 'tab-b', hasUnread: false })],
					activeTabId: 'tab-b',
				}),
			];
			const isWizardActive = (tabId: string) => tabId === 'tab-b';
			const result = findNextUnreadSession(sessions, 'a', isWizardActive);
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('b');
		});

		it('jumps within the current session to a non-active wizard tab', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [
						createMockTab({ id: 'tab-a1', hasUnread: false }),
						createMockTab({ id: 'tab-a2', hasUnread: false }),
					],
					activeTabId: 'tab-a1',
				}),
			];
			const isWizardActive = (tabId: string) => tabId === 'tab-a2';
			const result = findNextUnreadSession(sessions, 'a', isWizardActive);
			expect(result.jumped).toBe(true);
			expect(result.targetSessionId).toBe('a');
			expect(result.targetTabId).toBe('tab-a2');
		});

		it('does not jump when the only wizard tab is the active one', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					aiTabs: [createMockTab({ id: 'tab-a', hasUnread: false })],
					activeTabId: 'tab-a',
				}),
			];
			const isWizardActive = (tabId: string) => tabId === 'tab-a';
			const result = findNextUnreadSession(sessions, 'a', isWizardActive);
			expect(result.jumped).toBe(false);
			expect(result.clearedCurrent).toBe(false);
		});
	});

	describe('browser tabs', () => {
		it('navigates to a browser tab from unified order', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: aiTab.id,
				browserTabs: [browserTab as any],
				unifiedTabOrder: [
					{ type: 'ai', id: aiTab.id },
					{ type: 'browser', id: 'browser-1' },
				],
			});

			const result = navigateToUnifiedTabByIndex(session, 1);
			expect(result?.type).toBe('browser');
			expect(result?.session.activeBrowserTabId).toBe('browser-1');
			expect(result?.session.inputMode).toBe('ai');
		});

		it('closes an active browser tab and falls back to the previous AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: aiTab.id,
				browserTabs: [browserTab as any],
				activeBrowserTabId: 'browser-1',
				unifiedTabOrder: [
					{ type: 'ai', id: aiTab.id },
					{ type: 'browser', id: 'browser-1' },
				],
			});

			const result = closeBrowserTab(session, 'browser-1');
			expect(result?.session.browserTabs).toHaveLength(0);
			expect(result?.session.activeBrowserTabId).toBeNull();
			expect(result?.session.activeTabId).toBe('ai-1');
		});

		it('clears an active browser tab when selecting an AI tab', () => {
			const aiTab = createMockTab({ id: 'ai-1' });
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const session = createMockSession({
				aiTabs: [aiTab],
				activeTabId: aiTab.id,
				browserTabs: [browserTab as any],
				activeBrowserTabId: 'browser-1',
			});

			const result = setActiveTab(session, 'ai-1');
			expect(result?.session.activeBrowserTabId).toBeNull();
			expect(result?.session.activeFileTabId).toBeNull();
		});
	});

	describe('resolveQueuedItemTarget', () => {
		const msgItem = (tabId: string): QueuedItem => ({
			id: 'q1',
			tabId,
			type: 'message',
			text: 'hi',
			timestamp: 1700000000000,
		});

		it('resolves to a live aiTab when the queued tab is still open', () => {
			const open = createMockTab({ id: 'tab-open' });
			const session = createMockSession({ aiTabs: [open], activeTabId: 'tab-open' });
			expect(resolveQueuedItemTarget(session, msgItem('tab-open'))).toEqual({
				tabId: 'tab-open',
				location: 'aiTab',
			});
		});

		it('resolves to an orphan when the queued tab was closed (fire-and-forget)', () => {
			const active = createMockTab({ id: 'tab-active' });
			const orphan = createMockTab({ id: 'tab-closed' });
			const session = createMockSession({
				aiTabs: [active],
				activeTabId: 'tab-active',
				orphanedThinkingTabs: [orphan],
			});
			// Must NOT fall back to the active tab - that is the bug this guards.
			expect(resolveQueuedItemTarget(session, msgItem('tab-closed'))).toEqual({
				tabId: 'tab-closed',
				location: 'orphan',
			});
		});

		it('falls back to the active tab when the tabId is gone entirely', () => {
			const active = createMockTab({ id: 'tab-active' });
			const session = createMockSession({ aiTabs: [active], activeTabId: 'tab-active' });
			expect(resolveQueuedItemTarget(session, msgItem('tab-vanished'))).toEqual({
				tabId: 'tab-active',
				location: 'active',
			});
		});

		it('prefers a live aiTab over an orphan with the same id', () => {
			const open = createMockTab({ id: 'dup' });
			const orphan = createMockTab({ id: 'dup' });
			const session = createMockSession({
				aiTabs: [open],
				activeTabId: 'dup',
				orphanedThinkingTabs: [orphan],
			});
			expect(resolveQueuedItemTarget(session, msgItem('dup'))?.location).toBe('aiTab');
		});

		it('returns null when the session has no aiTabs to fall back to', () => {
			const session = createMockSession({ aiTabs: [], activeTabId: '' });
			expect(resolveQueuedItemTarget(session, msgItem('whatever'))).toBeNull();
		});
	});

	describe('markTabRunningQueuedItem', () => {
		it('marks the tab busy and appends the user log for a message item', () => {
			const tab = createMockTab({ id: 't1', state: 'idle', logs: [] });
			const item: QueuedItem = {
				id: 'q1',
				tabId: 't1',
				type: 'message',
				text: 'run this',
				timestamp: 1700000000000,
			};
			const result = markTabRunningQueuedItem(tab, item);
			expect(result.state).toBe('busy');
			expect(result.thinkingStartTime).toBeDefined();
			expect(result.logs).toHaveLength(1);
			expect(result.logs[0]).toMatchObject({ source: 'user', text: 'run this' });
			// Does not mutate the input tab.
			expect(tab.logs).toHaveLength(0);
		});

		it('carries forceParallel and readOnly flags onto the log entry', () => {
			const tab = createMockTab({ id: 't1', logs: [] });
			const item: QueuedItem = {
				id: 'q1',
				tabId: 't1',
				type: 'message',
				text: 'parallel read',
				timestamp: 1700000000000,
				forceParallel: true,
				readOnlyMode: true,
			};
			const result = markTabRunningQueuedItem(tab, item);
			expect(result.logs[0]).toMatchObject({ forceParallel: true, readOnly: true });
		});

		it('marks the tab busy without a log for a command item', () => {
			const tab = createMockTab({ id: 't1', logs: [] });
			const item: QueuedItem = {
				id: 'q1',
				tabId: 't1',
				type: 'command',
				command: '/commit',
				timestamp: 1700000000000,
			};
			const result = markTabRunningQueuedItem(tab, item);
			expect(result.state).toBe('busy');
			expect(result.logs).toHaveLength(0);
		});
	});

	describe('group unread rollup (groupHasUnreadTabs / computeUnreadGroupIds)', () => {
		function groupWith(aiLeafIds: string[]) {
			return {
				id: 'g1',
				name: 'G',
				createdAt: 0,
				focusedPaneId: 'l0',
				layout: {
					kind: 'split' as const,
					id: 's1',
					direction: 'row' as const,
					sizes: aiLeafIds.map(() => 1 / aiLeafIds.length),
					children: aiLeafIds.map((id, i) => ({
						kind: 'leaf' as const,
						id: `l${i}`,
						tab: { type: 'ai' as const, id },
					})),
				},
			};
		}

		beforeEach(() => {
			useSettingsStore.setState({ showStarredInUnreadFilter: false });
		});

		it('is true when any AI member has unread', () => {
			const group = groupWith(['a', 'b']);
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'a', hasUnread: false, state: 'idle' }),
					createMockTab({ id: 'b', hasUnread: true, state: 'idle' }),
				],
				tabGroups: [group] as never,
				// Neither member is the active tab, so only unread drives the result.
				activeTabId: 'other',
				inputMode: 'ai',
			});
			expect(groupHasUnreadTabs(session, group as never)).toBe(true);
		});

		it('is true when any AI member is busy (thinking)', () => {
			const group = groupWith(['a', 'b']);
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'a', hasUnread: false, state: 'idle' }),
					createMockTab({ id: 'b', hasUnread: false, state: 'busy' }),
				],
				tabGroups: [group] as never,
				activeTabId: 'other',
				inputMode: 'ai',
			});
			expect(groupHasUnreadTabs(session, group as never)).toBe(true);
		});

		it('is false when no AI member qualifies', () => {
			const group = groupWith(['a', 'b']);
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'a', hasUnread: false, state: 'idle' }),
					createMockTab({ id: 'b', hasUnread: false, state: 'idle' }),
				],
				tabGroups: [group] as never,
				activeTabId: 'other',
				inputMode: 'ai',
			});
			expect(groupHasUnreadTabs(session, group as never)).toBe(false);
		});

		it('is true when an idle, read AI member has a queued execution item', () => {
			const group = groupWith(['a', 'b']);
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'a', hasUnread: false, state: 'idle' }),
					createMockTab({ id: 'b', hasUnread: false, state: 'idle' }),
				],
				tabGroups: [group] as never,
				activeTabId: 'other',
				inputMode: 'ai',
				executionQueue: [{ id: 'q-1', timestamp: 1, tabId: 'b', type: 'message', text: 'queued' }],
			});
			expect(groupHasUnreadTabs(session, group as never)).toBe(true);
		});

		it('computeUnreadGroupIds returns only groups with an unread member', () => {
			const g1 = { ...groupWith(['a']), id: 'g1' };
			const g2 = {
				...groupWith(['b']),
				id: 'g2',
				layout: {
					kind: 'split' as const,
					id: 's2',
					direction: 'row' as const,
					sizes: [1],
					children: [{ kind: 'leaf' as const, id: 'l0', tab: { type: 'ai' as const, id: 'b' } }],
				},
			};
			const session = createMockSession({
				aiTabs: [
					createMockTab({ id: 'a', hasUnread: true, state: 'idle' }),
					createMockTab({ id: 'b', hasUnread: false, state: 'idle' }),
				],
				tabGroups: [g1, g2] as never,
				activeTabId: 'other',
				inputMode: 'ai',
			});
			const ids = computeUnreadGroupIds(session);
			expect(ids.has('g1')).toBe(true);
			expect(ids.has('g2')).toBe(false);
		});
	});

	describe('moveActiveUnifiedTabToEdge', () => {
		// Mixed-kind order: ai(a1) → terminal(t1) → file(f1) → browser(b1).
		// The active tab is chosen via the terminal/file/browser/ai active-id fields.
		function mixedSession(overrides: Record<string, unknown> = {}) {
			return createMockSession({
				aiTabs: [createMockTab({ id: 'a1' })],
				terminalTabs: [
					{ id: 't1', name: null, shellType: 'zsh', pid: 0, cwd: '', createdAt: 1, state: 'idle' },
				],
				filePreviewTabs: [createMockFileTab({ id: 'f1', path: '/tmp/f1' })],
				browserTabs: [createMockBrowserTab({ id: 'b1' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a1' },
					{ type: 'terminal', id: 't1' },
					{ type: 'file', id: 'f1' },
					{ type: 'browser', id: 'b1' },
				],
				activeTabId: 'a1',
				activeTerminalTabId: null,
				activeFileTabId: null,
				activeBrowserTabId: null,
				...overrides,
			});
		}

		it('moves the active AI tab to the last position', () => {
			const session = mixedSession(); // AI tab a1 is active
			const result = moveActiveUnifiedTabToEdge(session, 'end');
			expect(result.unifiedTabOrder.map((r) => r.id)).toEqual(['t1', 'f1', 'b1', 'a1']);
		});

		it('moves the active terminal tab to the first position', () => {
			const session = mixedSession({ activeTerminalTabId: 't1', activeTabId: '' });
			const result = moveActiveUnifiedTabToEdge(session, 'start');
			expect(result.unifiedTabOrder.map((r) => r.id)).toEqual(['t1', 'a1', 'f1', 'b1']);
		});

		it('moves the active file tab to the last position', () => {
			const session = mixedSession({ activeFileTabId: 'f1', activeTabId: '' });
			const result = moveActiveUnifiedTabToEdge(session, 'end');
			expect(result.unifiedTabOrder.map((r) => r.id)).toEqual(['a1', 't1', 'b1', 'f1']);
		});

		it('moves the active browser tab to the first position', () => {
			const session = mixedSession({ activeBrowserTabId: 'b1', activeTabId: '' });
			const result = moveActiveUnifiedTabToEdge(session, 'start');
			expect(result.unifiedTabOrder.map((r) => r.id)).toEqual(['b1', 'a1', 't1', 'f1']);
		});

		it('is a no-op (returns same reference) when already at the target edge', () => {
			const session = mixedSession(); // a1 already first
			expect(moveActiveUnifiedTabToEdge(session, 'start')).toBe(session);
		});

		it('is a no-op when there are fewer than two tabs', () => {
			const session = createMockSession({
				aiTabs: [createMockTab({ id: 'a1' })],
				unifiedTabOrder: [{ type: 'ai', id: 'a1' }],
				activeTabId: 'a1',
			});
			expect(moveActiveUnifiedTabToEdge(session, 'end')).toBe(session);
		});
	});

	describe('toggleReadOnlyModeFields', () => {
		it('toggles a non-read-only tab to readonly on both fields', () => {
			expect(toggleReadOnlyModeFields({ readOnlyMode: false })).toEqual({
				readOnlyMode: true,
				permissionMode: 'readonly',
			});
		});

		it('toggles a read-only tab back to full access on both fields', () => {
			expect(toggleReadOnlyModeFields({ readOnlyMode: true })).toEqual({
				readOnlyMode: false,
				permissionMode: 'full',
			});
		});

		it('treats an unset readOnlyMode as not-read-only', () => {
			expect(toggleReadOnlyModeFields({})).toEqual({
				readOnlyMode: true,
				permissionMode: 'readonly',
			});
		});

		it('keeps permissionMode coherent so resolveTabPermissionMode agrees after a toggle', () => {
			// The invariant this fix protects: the toolbar pill and the spawn path
			// both resolve through resolveTabPermissionMode, so after toggling a Full
			// Access tab to read-only the pill can no longer keep saying "Full Access".
			const afterOn = toggleReadOnlyModeFields({ readOnlyMode: false });
			expect(resolveTabPermissionMode(afterOn)).toBe('readonly');
			const afterOff = toggleReadOnlyModeFields(afterOn);
			expect(resolveTabPermissionMode(afterOff)).toBe('full');
		});
	});
});
