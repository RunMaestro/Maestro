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
				groupChatsExpanded: true,
				showUnreadOnly: false,
				preFilterActiveTabId: null,
				preTerminalFileTabId: null,
				selectedSidebarIndex: 0,
				flashNotification: null,
				successFlashNotification: null,
				outputSearchOpen: false,
				outputSearchQuery: '',
				sessionFilterOpen: false,
				historySearchFilterOpen: false,
				groupChatHistorySearchFilterOpen: false,
				draggingSessionId: null,
				editingGroupId: null,
				editingSessionId: null,
			})
		);
	});

	it('updates every value-backed UI slice', () => {
		const store = useUIStore.getState();

		store.setLeftSidebarOpen(false);
		store.setRightPanelOpen(false);
		store.setActiveFocus('input');
		store.setActiveRightTab('history');
		store.setBookmarksCollapsed(true);
		store.setGroupChatsExpanded(false);
		store.setShowUnreadOnly(true);
		store.setPreFilterActiveTabId('tab-before-filter');
		store.setPreTerminalFileTabId('terminal-tab');
		store.setSelectedSidebarIndex(3);
		store.setFlashNotification('syncing');
		store.setSuccessFlashNotification('done');
		store.setOutputSearchOpen(true);
		store.setOutputSearchQuery('build failed');
		store.setSessionFilterOpen(true);
		store.setHistorySearchFilterOpen(true);
		store.setGroupChatHistorySearchFilterOpen(true);
		store.setDraggingSessionId('session-1');
		store.setEditingGroupId('group-1');
		store.setEditingSessionId('session-2');

		expect(useUIStore.getState()).toEqual(
			expect.objectContaining({
				leftSidebarOpen: false,
				rightPanelOpen: false,
				activeFocus: 'input',
				activeRightTab: 'history',
				bookmarksCollapsed: true,
				groupChatsExpanded: false,
				showUnreadOnly: true,
				preFilterActiveTabId: 'tab-before-filter',
				preTerminalFileTabId: 'terminal-tab',
				selectedSidebarIndex: 3,
				flashNotification: 'syncing',
				successFlashNotification: 'done',
				outputSearchOpen: true,
				outputSearchQuery: 'build failed',
				sessionFilterOpen: true,
				historySearchFilterOpen: true,
				groupChatHistorySearchFilterOpen: true,
				draggingSessionId: 'session-1',
				editingGroupId: 'group-1',
				editingSessionId: 'session-2',
			})
		);
	});

	it('supports updater functions and toggles for interactive state transitions', () => {
		const store = useUIStore.getState();

		store.toggleLeftSidebar();
		store.toggleRightPanel();
		store.toggleBookmarksCollapsed();
		store.toggleGroupChatsExpanded();
		store.toggleShowUnreadOnly();
		store.setActiveFocus(() => 'sidebar');
		store.setActiveRightTab(() => 'git');
		store.setLeftSidebarOpen((open) => !open);
		store.setRightPanelOpen((open) => !open);
		store.setBookmarksCollapsed((collapsed) => !collapsed);
		store.setGroupChatsExpanded((expanded) => !expanded);
		store.setShowUnreadOnly((show) => !show);
		store.setSelectedSidebarIndex((index) => index + 4);
		store.setFlashNotification((message) => `${message ?? 'idle'} -> busy`);
		store.setSuccessFlashNotification((message) => `${message ?? 'idle'} -> saved`);
		store.setOutputSearchOpen((open) => !open);
		store.setOutputSearchQuery((query) => `${query}error`);
		store.setSessionFilterOpen((open) => !open);
		store.setHistorySearchFilterOpen((open) => !open);
		store.setGroupChatHistorySearchFilterOpen((open) => !open);
		store.setDraggingSessionId((id) => `${id ?? 'none'}-drag`);
		store.setEditingGroupId((id) => `${id ?? 'none'}-group`);
		store.setEditingSessionId((id) => `${id ?? 'none'}-session`);

		expect(useUIStore.getState()).toEqual(
			expect.objectContaining({
				leftSidebarOpen: true,
				rightPanelOpen: true,
				activeFocus: 'sidebar',
				activeRightTab: 'git',
				bookmarksCollapsed: false,
				groupChatsExpanded: true,
				showUnreadOnly: false,
				selectedSidebarIndex: 4,
				flashNotification: 'idle -> busy',
				successFlashNotification: 'idle -> saved',
				outputSearchOpen: true,
				outputSearchQuery: 'error',
				sessionFilterOpen: true,
				historySearchFilterOpen: true,
				groupChatHistorySearchFilterOpen: true,
				draggingSessionId: 'none-drag',
				editingGroupId: 'none-group',
				editingSessionId: 'none-session',
			})
		);
	});
});
