import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { resetStore } from '../../helpers';

describe('uiStore', () => {
	beforeEach(() => {
		resetStore(useUIStore);
	});

	describe('initial state', () => {
		it('has correct default values', () => {
			const state = useUIStore.getState();

			expect(state.leftSidebarOpen).toBe(true);
			expect(state.rightPanelOpen).toBe(true);
			expect(state.activeFocus).toBe('main');
			expect(state.activeRightTab).toBe('files');
			expect(state.bookmarksCollapsed).toBe(false);
			expect(state.showUnreadOnly).toBe(false);
			expect(state.preFilterActiveTabId).toBeNull();
			expect(state.preTerminalFileTabId).toBeNull();
			expect(state.selectedSidebarIndex).toBe(0);
			expect(state.outputSearchByKey).toEqual({});
			expect(state.sessionFilterOpen).toBe(false);
			expect(state.historySearchFilterOpen).toBe(false);
			expect(state.draggingSessionId).toBeNull();
			expect(state.editingGroupId).toBeNull();
			expect(state.editingSessionId).toBeNull();
			expect(state.usageDashboardViewMode).toBe('overview');
		});
	});

	describe('sidebar state', () => {
		it('sets left sidebar open with a value', () => {
			useUIStore.getState().setLeftSidebarOpen(false);
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});

		it('sets left sidebar open with an updater function', () => {
			useUIStore.getState().setLeftSidebarOpen((prev) => !prev);
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});

		it('toggles left sidebar', () => {
			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
			useUIStore.getState().toggleLeftSidebar();
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
			useUIStore.getState().toggleLeftSidebar();
			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
		});

		it('sets right panel open with a value', () => {
			useUIStore.getState().setRightPanelOpen(false);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('sets right panel open with an updater function', () => {
			useUIStore.getState().setRightPanelOpen((prev) => !prev);
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
		});

		it('toggles right panel', () => {
			expect(useUIStore.getState().rightPanelOpen).toBe(true);
			useUIStore.getState().toggleRightPanel();
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
			useUIStore.getState().toggleRightPanel();
			expect(useUIStore.getState().rightPanelOpen).toBe(true);
		});
	});

	describe('focus state', () => {
		it('sets active focus with a value', () => {
			useUIStore.getState().setActiveFocus('sidebar');
			expect(useUIStore.getState().activeFocus).toBe('sidebar');
		});

		it('sets active focus with an updater function', () => {
			useUIStore.getState().setActiveFocus(() => 'right');
			expect(useUIStore.getState().activeFocus).toBe('right');
		});

		it('sets active right tab', () => {
			useUIStore.getState().setActiveRightTab('history');
			expect(useUIStore.getState().activeRightTab).toBe('history');

			useUIStore.getState().setActiveRightTab('autorun');
			expect(useUIStore.getState().activeRightTab).toBe('autorun');
		});
	});

	describe('sidebar collapse/expand state', () => {
		it('sets bookmarks collapsed', () => {
			useUIStore.getState().setBookmarksCollapsed(true);
			expect(useUIStore.getState().bookmarksCollapsed).toBe(true);
		});

		it('toggles bookmarks collapsed', () => {
			expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
			useUIStore.getState().toggleBookmarksCollapsed();
			expect(useUIStore.getState().bookmarksCollapsed).toBe(true);
			useUIStore.getState().toggleBookmarksCollapsed();
			expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
		});

		it('persists bookmarks collapse state so it survives restarts', () => {
			const setSetting = (window as any).maestro.settings.set as ReturnType<typeof vi.fn>;
			setSetting.mockClear();

			useUIStore.getState().setBookmarksCollapsed(true);
			expect(setSetting).toHaveBeenCalledWith('bookmarksCollapsed', true);

			useUIStore.getState().toggleBookmarksCollapsed();
			expect(setSetting).toHaveBeenLastCalledWith('bookmarksCollapsed', false);
		});
	});

	describe('session list filter state', () => {
		it('sets show unread only', () => {
			useUIStore.getState().setShowUnreadOnly(true);
			expect(useUIStore.getState().showUnreadOnly).toBe(true);
		});

		it('sets show unread only with an updater', () => {
			useUIStore.getState().setShowUnreadOnly((prev) => !prev);
			expect(useUIStore.getState().showUnreadOnly).toBe(true);
		});

		it('toggles show unread only', () => {
			expect(useUIStore.getState().showUnreadOnly).toBe(false);
			useUIStore.getState().toggleShowUnreadOnly();
			expect(useUIStore.getState().showUnreadOnly).toBe(true);
			useUIStore.getState().toggleShowUnreadOnly();
			expect(useUIStore.getState().showUnreadOnly).toBe(false);
		});

		it('sets show unread agents only', () => {
			useUIStore.getState().setShowUnreadAgentsOnly(true);
			expect(useUIStore.getState().showUnreadAgentsOnly).toBe(true);
		});

		it('toggles show unread agents only', () => {
			expect(useUIStore.getState().showUnreadAgentsOnly).toBe(false);
			useUIStore.getState().toggleShowUnreadAgentsOnly();
			expect(useUIStore.getState().showUnreadAgentsOnly).toBe(true);
			useUIStore.getState().toggleShowUnreadAgentsOnly();
			expect(useUIStore.getState().showUnreadAgentsOnly).toBe(false);
		});

		it('sets pre-filter active tab id', () => {
			useUIStore.getState().setPreFilterActiveTabId('tab-123');
			expect(useUIStore.getState().preFilterActiveTabId).toBe('tab-123');

			useUIStore.getState().setPreFilterActiveTabId(null);
			expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
		});

		it('sets pre-terminal file tab id', () => {
			useUIStore.getState().setPreTerminalFileTabId('file-tab-456');
			expect(useUIStore.getState().preTerminalFileTabId).toBe('file-tab-456');

			useUIStore.getState().setPreTerminalFileTabId(null);
			expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
		});
	});

	describe('session sidebar selection', () => {
		it('sets selected sidebar index with a value', () => {
			useUIStore.getState().setSelectedSidebarIndex(5);
			expect(useUIStore.getState().selectedSidebarIndex).toBe(5);
		});

		it('sets selected sidebar index with an updater', () => {
			useUIStore.getState().setSelectedSidebarIndex(3);
			useUIStore.getState().setSelectedSidebarIndex((prev) => prev + 1);
			expect(useUIStore.getState().selectedSidebarIndex).toBe(4);
		});
	});

	describe('flash notification setters (compatibility shims → centerFlashStore)', () => {
		it('setFlashNotification fires a yellow center flash', async () => {
			const { useCenterFlashStore } = await import('../../../renderer/stores/centerFlashStore');
			useCenterFlashStore.getState().setActive(null);

			useUIStore.getState().setFlashNotification('Commands disabled');
			const active = useCenterFlashStore.getState().active;
			expect(active?.message).toBe('Commands disabled');
			expect(active?.color).toBe('yellow');

			// Passing null is a no-op (auto-dismiss handles clearing)
			useUIStore.getState().setFlashNotification(null);
			expect(useCenterFlashStore.getState().active?.message).toBe('Commands disabled');
		});

		it('setSuccessFlashNotification fires a themed center flash', async () => {
			const { useCenterFlashStore } = await import('../../../renderer/stores/centerFlashStore');
			useCenterFlashStore.getState().setActive(null);

			useUIStore.getState().setSuccessFlashNotification('Refresh complete');
			const active = useCenterFlashStore.getState().active;
			expect(active?.message).toBe('Refresh complete');
			expect(active?.color).toBe('theme');

			useUIStore.getState().setSuccessFlashNotification(null);
			expect(useCenterFlashStore.getState().active?.message).toBe('Refresh complete');
		});
	});

	describe('output search state (scoped per agent+tab key)', () => {
		const KEY = 'agent-1::tab-1';

		it('sets output search open for a key', () => {
			useUIStore.getState().setOutputSearchOpen(KEY, true);
			expect(useUIStore.getState().outputSearchByKey[KEY]?.open).toBe(true);
		});

		it('sets output search query for a key', () => {
			useUIStore.getState().setOutputSearchQuery(KEY, 'find this');
			expect(useUIStore.getState().outputSearchByKey[KEY]?.query).toBe('find this');
		});

		it('keeps each key independent', () => {
			useUIStore.getState().setOutputSearchOpen('a::1', true);
			useUIStore.getState().setOutputSearchQuery('a::1', 'alpha');
			expect(useUIStore.getState().outputSearchByKey['b::1']).toBeUndefined();
		});

		it('prunes a slot when closed with an empty query', () => {
			useUIStore.getState().setOutputSearchOpen(KEY, true);
			useUIStore.getState().setOutputSearchOpen(KEY, false);
			expect(useUIStore.getState().outputSearchByKey[KEY]).toBeUndefined();
		});
	});

	describe('session filter state', () => {
		it('sets session filter open', () => {
			useUIStore.getState().setSessionFilterOpen(true);
			expect(useUIStore.getState().sessionFilterOpen).toBe(true);
		});

		it('sets session filter open with an updater', () => {
			useUIStore.getState().setSessionFilterOpen((prev) => !prev);
			expect(useUIStore.getState().sessionFilterOpen).toBe(true);
		});
	});

	describe('history search filter state', () => {
		it('sets history search filter open', () => {
			useUIStore.getState().setHistorySearchFilterOpen(true);
			expect(useUIStore.getState().historySearchFilterOpen).toBe(true);
		});

		it('sets history search filter open with an updater', () => {
			useUIStore.getState().setHistorySearchFilterOpen((prev) => !prev);
			expect(useUIStore.getState().historySearchFilterOpen).toBe(true);
		});
	});

	describe('drag and drop state', () => {
		it('sets dragging session id', () => {
			useUIStore.getState().setDraggingSessionId('session-789');
			expect(useUIStore.getState().draggingSessionId).toBe('session-789');

			useUIStore.getState().setDraggingSessionId(null);
			expect(useUIStore.getState().draggingSessionId).toBeNull();
		});
	});

	describe('editing state', () => {
		it('sets editing group id', () => {
			useUIStore.getState().setEditingGroupId('group-1');
			expect(useUIStore.getState().editingGroupId).toBe('group-1');

			useUIStore.getState().setEditingGroupId(null);
			expect(useUIStore.getState().editingGroupId).toBeNull();
		});

		it('sets editing session id', () => {
			useUIStore.getState().setEditingSessionId('session-1');
			expect(useUIStore.getState().editingSessionId).toBe('session-1');

			useUIStore.getState().setEditingSessionId(null);
			expect(useUIStore.getState().editingSessionId).toBeNull();
		});
	});

	describe('usage dashboard view mode', () => {
		it('sets the last-selected tab with a value', () => {
			useUIStore.getState().setUsageDashboardViewMode('cue');
			expect(useUIStore.getState().usageDashboardViewMode).toBe('cue');
		});

		it('sets the last-selected tab with an updater', () => {
			useUIStore.getState().setUsageDashboardViewMode('autorun');
			useUIStore
				.getState()
				.setUsageDashboardViewMode((prev) => (prev === 'autorun' ? 'activity' : 'overview'));
			expect(useUIStore.getState().usageDashboardViewMode).toBe('activity');
		});
	});

	describe('React hook integration', () => {
		it('provides state to React components via selectors', () => {
			const { result } = renderHook(() => useUIStore((s) => s.leftSidebarOpen));
			expect(result.current).toBe(true);
		});

		it('re-renders when selected state changes', () => {
			const { result } = renderHook(() => useUIStore((s) => s.leftSidebarOpen));
			expect(result.current).toBe(true);

			act(() => {
				useUIStore.getState().setLeftSidebarOpen(false);
			});

			expect(result.current).toBe(false);
		});

		it('does not re-render when unrelated state changes', () => {
			let renderCount = 0;
			const { result } = renderHook(() => {
				renderCount++;
				return useUIStore((s) => s.leftSidebarOpen);
			});

			const initialRenderCount = renderCount;

			// Change unrelated state
			act(() => {
				useUIStore.getState().setOutputSearchQuery('k::1', 'test');
			});

			// Should not have re-rendered (selector isolation)
			expect(renderCount).toBe(initialRenderCount);
			expect(result.current).toBe(true);
		});

		it('works with multiple selectors in the same component', () => {
			const { result } = renderHook(() => ({
				leftOpen: useUIStore((s) => s.leftSidebarOpen),
				rightOpen: useUIStore((s) => s.rightPanelOpen),
			}));

			expect(result.current.leftOpen).toBe(true);
			expect(result.current.rightOpen).toBe(true);

			act(() => {
				useUIStore.getState().setLeftSidebarOpen(false);
			});

			expect(result.current.leftOpen).toBe(false);
			expect(result.current.rightOpen).toBe(true);
		});
	});

	describe('action stability (getState extraction pattern)', () => {
		it('returns stable action references across state changes', () => {
			const actionsBefore = useUIStore.getState();
			useUIStore.getState().setLeftSidebarOpen(false);
			useUIStore.getState().setOutputSearchQuery('k::1', 'changed');
			const actionsAfter = useUIStore.getState();

			// Actions must be the same function references after state mutations.
			// App.tsx relies on this by extracting actions via getState() once
			// instead of subscribing through selectors.
			expect(actionsAfter.setLeftSidebarOpen).toBe(actionsBefore.setLeftSidebarOpen);
			expect(actionsAfter.toggleLeftSidebar).toBe(actionsBefore.toggleLeftSidebar);
			expect(actionsAfter.setActiveFocus).toBe(actionsBefore.setActiveFocus);
			expect(actionsAfter.setFlashNotification).toBe(actionsBefore.setFlashNotification);
			expect(actionsAfter.setSelectedSidebarIndex).toBe(actionsBefore.setSelectedSidebarIndex);
		});

		it('extracted actions still mutate state correctly', () => {
			// Grab actions once, then call them — mirrors the App.tsx pattern
			const { setLeftSidebarOpen, setActiveFocus } = useUIStore.getState();

			setLeftSidebarOpen(false);
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);

			setActiveFocus('sidebar');
			expect(useUIStore.getState().activeFocus).toBe('sidebar');
		});

		it('extracted actions work with updater functions', () => {
			const { setSelectedSidebarIndex } = useUIStore.getState();

			setSelectedSidebarIndex(10);
			expect(useUIStore.getState().selectedSidebarIndex).toBe(10);

			setSelectedSidebarIndex((prev) => prev - 3);
			expect(useUIStore.getState().selectedSidebarIndex).toBe(7);
		});
	});

	describe('non-React access (getState)', () => {
		it('provides current state outside React', () => {
			const state = useUIStore.getState();
			expect(state.leftSidebarOpen).toBe(true);
		});

		it('allows mutations outside React', () => {
			useUIStore.getState().setLeftSidebarOpen(false);
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});

		it('supports the preFilterActiveTabId ref-replacement pattern', () => {
			// This tests the pattern used in App.tsx toggleUnreadFilter:
			// save → read → clear
			useUIStore.getState().setPreFilterActiveTabId('tab-1');
			expect(useUIStore.getState().preFilterActiveTabId).toBe('tab-1');

			const saved = useUIStore.getState().preFilterActiveTabId;
			expect(saved).toBe('tab-1');

			useUIStore.getState().setPreFilterActiveTabId(null);
			expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
		});

		it('supports the preTerminalFileTabId ref-replacement pattern', () => {
			// This tests the pattern used in App.tsx toggleInputMode:
			// save → read → clear
			useUIStore.getState().setPreTerminalFileTabId('file-tab-1');
			expect(useUIStore.getState().preTerminalFileTabId).toBe('file-tab-1');

			const saved = useUIStore.getState().preTerminalFileTabId;
			expect(saved).toBe('file-tab-1');

			useUIStore.getState().setPreTerminalFileTabId(null);
			expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
		});
	});
});
