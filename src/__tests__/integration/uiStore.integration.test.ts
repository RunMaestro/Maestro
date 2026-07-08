import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore, type UIStore } from '../../renderer/stores/uiStore';

const initialState: UIStore = useUIStore.getState();

describe('uiStore integration', () => {
	beforeEach(() => {
		useUIStore.setState(initialState, true);
	});

	it('exposes the default layout and interaction state', () => {
		expect(useUIStore.getState()).toEqual(
			expect.objectContaining({
				leftSidebarOpen: true,
				rightPanelOpen: true,
				activeFocus: 'main',
				activeRightTab: 'files',
				bookmarksCollapsed: false,
				showUnreadOnly: false,
				showUnreadAgentsOnly: false,
				preFilterActiveTabId: null,
				preTerminalFileTabId: null,
				selectedSidebarIndex: 0,
				sidebarExtraSelection: null,
				outputSearchByKey: {},
				sessionFilterOpen: false,
				historySearchFilterOpen: false,
				groupChatHistorySearchFilterOpen: false,
				draggingSessionId: null,
				editingGroupId: null,
				editingSessionId: null,
				autoFollowEnabled: false,
				usageDashboardViewMode: 'overview',
				hiddenQuotaAccounts: {},
				usageRefreshIntervals: {},
			})
		);
	});

	it('updates every value-backed UI slice', () => {
		const store = useUIStore.getState();
		const outputSearchKey = 'session-1::tab-1';

		store.setLeftSidebarOpen(false);
		store.setRightPanelOpen(false);
		store.setActiveFocus('input');
		store.setActiveRightTab('history');
		store.setBookmarksCollapsed(true);
		store.setShowUnreadOnly(true);
		store.setShowUnreadAgentsOnly(true);
		store.setPreFilterActiveTabId('tab-before-filter');
		store.setPreTerminalFileTabId('terminal-tab');
		store.setSelectedSidebarIndex(3);
		store.setSidebarExtraSelection({ kind: 'starred', key: 'starred-session' });
		store.setOutputSearchOpen(outputSearchKey, true);
		store.setOutputSearchQuery(outputSearchKey, 'build failed');
		store.setOutputSearchRegex(outputSearchKey, true);
		store.setSessionFilterOpen(true);
		store.setHistorySearchFilterOpen(true);
		store.setGroupChatHistorySearchFilterOpen(true);
		store.setDraggingSessionId('session-1');
		store.setEditingGroupId('group-1');
		store.setEditingSessionId('session-2');
		store.setAutoFollowEnabled(true);
		store.setUsageDashboardViewMode('providers');
		store.toggleHiddenQuotaAccount('claude-code', 'account-1');
		store.setUsageRefreshInterval('codex', 60_000);

		expect(useUIStore.getState()).toEqual(
			expect.objectContaining({
				leftSidebarOpen: false,
				rightPanelOpen: false,
				activeFocus: 'input',
				activeRightTab: 'history',
				bookmarksCollapsed: true,
				showUnreadOnly: true,
				showUnreadAgentsOnly: true,
				preFilterActiveTabId: 'tab-before-filter',
				preTerminalFileTabId: 'terminal-tab',
				selectedSidebarIndex: 3,
				sidebarExtraSelection: { kind: 'starred', key: 'starred-session' },
				outputSearchByKey: {
					[outputSearchKey]: {
						open: true,
						query: 'build failed',
						regex: true,
					},
				},
				sessionFilterOpen: true,
				historySearchFilterOpen: true,
				groupChatHistorySearchFilterOpen: true,
				draggingSessionId: 'session-1',
				editingGroupId: 'group-1',
				editingSessionId: 'session-2',
				autoFollowEnabled: true,
				usageDashboardViewMode: 'providers',
				hiddenQuotaAccounts: {
					'claude-code': ['account-1'],
				},
				usageRefreshIntervals: {
					codex: 60_000,
				},
			})
		);
	});

	it('supports updater functions and toggles for interactive state transitions', () => {
		const store = useUIStore.getState();
		const outputSearchKey = 'session-2::tab-2';

		store.toggleLeftSidebar();
		store.toggleRightPanel();
		store.toggleBookmarksCollapsed();
		store.toggleShowUnreadOnly();
		store.toggleShowUnreadAgentsOnly();
		store.setActiveFocus(() => 'sidebar');
		store.setActiveRightTab(() => 'git');
		store.setLeftSidebarOpen((open) => !open);
		store.setRightPanelOpen((open) => !open);
		store.setBookmarksCollapsed((collapsed) => !collapsed);
		store.setShowUnreadOnly((show) => !show);
		store.setShowUnreadAgentsOnly((show) => !show);
		store.setSelectedSidebarIndex((index) => index + 4);
		store.setOutputSearchOpen(outputSearchKey, (open) => !open);
		store.setOutputSearchQuery(outputSearchKey, (query) => `${query}error`);
		store.toggleOutputSearchRegex(outputSearchKey);
		store.setSessionFilterOpen((open) => !open);
		store.setHistorySearchFilterOpen((open) => !open);
		store.setGroupChatHistorySearchFilterOpen((open) => !open);
		store.setDraggingSessionId((id) => `${id ?? 'none'}-drag`);
		store.setEditingGroupId((id) => `${id ?? 'none'}-group`);
		store.setEditingSessionId((id) => `${id ?? 'none'}-session`);
		store.setAutoFollowEnabled((enabled) => !enabled);
		store.setUsageDashboardViewMode((mode) => (mode === 'overview' ? 'providers' : 'overview'));
		store.toggleHiddenQuotaAccount('codex', 'account-2');

		expect(useUIStore.getState()).toEqual(
			expect.objectContaining({
				leftSidebarOpen: true,
				rightPanelOpen: true,
				activeFocus: 'sidebar',
				activeRightTab: 'git',
				bookmarksCollapsed: false,
				showUnreadOnly: false,
				showUnreadAgentsOnly: false,
				selectedSidebarIndex: 4,
				outputSearchByKey: {
					[outputSearchKey]: {
						open: true,
						query: 'error',
						regex: true,
					},
				},
				sessionFilterOpen: true,
				historySearchFilterOpen: true,
				groupChatHistorySearchFilterOpen: true,
				draggingSessionId: 'none-drag',
				editingGroupId: 'none-group',
				editingSessionId: 'none-session',
				autoFollowEnabled: true,
				usageDashboardViewMode: 'providers',
				hiddenQuotaAccounts: {
					codex: ['account-2'],
				},
			})
		);
	});
});
