// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/stores/uiStore.test.ts
// Source: src/__tests__/renderer/stores/feedbackDraftStore.test.ts
// Source: src/__tests__/renderer/stores/sidebarNavStore.test.ts
// Source: src/__tests__/renderer/stores/cadenzaStore.test.ts
// Source: src/__tests__/renderer/stores/codexResetCreditsStore.test.ts
// Source: src/__tests__/renderer/stores/sessionEquality.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUIStore as s1_useUIStore } from '../../../renderer/stores/uiStore';
import { resetStore } from '../../helpers';
import {
	useFeedbackDraftStore,
	type FeedbackDraft,
} from '../../../renderer/stores/feedbackDraftStore';
import { useSidebarNavStore } from '../../../renderer/stores/sidebarNavStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore as s3_useUIStore } from '../../../renderer/stores/uiStore';
import { createMockSession as s3_createMockSession } from '../../helpers';
import type { StarredItem } from '../../../renderer/hooks/session/useStarredItems';
import { useCadenzaStore, applyCadenzaPayload } from '../../../renderer/stores/cadenzaStore';
import { useCodexResetCreditsStore } from '../../../renderer/stores/codexResetCreditsStore';
import { useCodexUsageStore } from '../../../renderer/stores/codexUsageStore';
import type { CodexResetCredit } from '../../../shared/codexResetCredits';
import {
	sidebarSessionEquality,
	activeSessionChromeEquality,
} from '../../../renderer/stores/sessionEquality';
import { createMockSession as s6_createMockSession } from '../../helpers/mockSession';
import type { AITab, Session } from '../../../renderer/types';
// Source: src/__tests__/renderer/stores/uiStore.test.ts
describe('', () => {
	describe('uiStore', () => {
		beforeEach(() => {
			resetStore(s1_useUIStore);
		});
		describe('initial state', () => {
			it('has correct default values', () => {
				const state = s1_useUIStore.getState();
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
				expect(state.focusRequest).toBeNull();
			});
		});
		describe('focus request', () => {
			it('publishes a pane request for the given leaf id', () => {
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				expect(s1_useUIStore.getState().focusRequest).toEqual({ leafId: 'leaf-1' });
			});
			it('publishes a tab request for the given tab ref', () => {
				s1_useUIStore.getState().requestTabFocus({ type: 'browser', id: 'b-1' });
				expect(s1_useUIStore.getState().focusRequest).toEqual({
					tab: { type: 'browser', id: 'b-1' },
				});
			});
			it('clears the request once it has been consumed', () => {
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				s1_useUIStore.getState().clearFocusRequest();
				expect(s1_useUIStore.getState().focusRequest).toBeNull();
			});
			it('replaces an unconsumed request rather than queueing', () => {
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				s1_useUIStore.getState().requestPaneFocus('leaf-2');
				expect(s1_useUIStore.getState().focusRequest).toEqual({ leafId: 'leaf-2' });
			});
			it('lets a tab request supersede a pane request, so there is one focus owner', () => {
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				s1_useUIStore.getState().requestTabFocus({ type: 'file', id: 'f-1' });
				expect(s1_useUIStore.getState().focusRequest).toEqual({ tab: { type: 'file', id: 'f-1' } });
			});
			it('re-publishes the same leaf after a clear so a repeat press refocuses', () => {
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				s1_useUIStore.getState().clearFocusRequest();
				s1_useUIStore.getState().requestPaneFocus('leaf-1');
				expect(s1_useUIStore.getState().focusRequest).toEqual({ leafId: 'leaf-1' });
			});
		});
		describe('sidebar state', () => {
			it('sets left sidebar open with a value', () => {
				s1_useUIStore.getState().setLeftSidebarOpen(false);
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
			it('sets left sidebar open with an updater function', () => {
				s1_useUIStore.getState().setLeftSidebarOpen((prev) => !prev);
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
			it('toggles left sidebar', () => {
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(true);
				s1_useUIStore.getState().toggleLeftSidebar();
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
				s1_useUIStore.getState().toggleLeftSidebar();
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(true);
			});
			it('sets right panel open with a value', () => {
				s1_useUIStore.getState().setRightPanelOpen(false);
				expect(s1_useUIStore.getState().rightPanelOpen).toBe(false);
			});
			it('sets right panel open with an updater function', () => {
				s1_useUIStore.getState().setRightPanelOpen((prev) => !prev);
				expect(s1_useUIStore.getState().rightPanelOpen).toBe(false);
			});
			it('toggles right panel', () => {
				expect(s1_useUIStore.getState().rightPanelOpen).toBe(true);
				s1_useUIStore.getState().toggleRightPanel();
				expect(s1_useUIStore.getState().rightPanelOpen).toBe(false);
				s1_useUIStore.getState().toggleRightPanel();
				expect(s1_useUIStore.getState().rightPanelOpen).toBe(true);
			});
			describe('closeLeftSidebarForNavigation', () => {
				const setViewportWidth = (width: number) => {
					Object.defineProperty(window, 'innerWidth', {
						configurable: true,
						writable: true,
						value: width,
					});
				};
				const originalWidth = window.innerWidth;
				afterEach(() => {
					setViewportWidth(originalWidth);
				});
				it('closes the drawer on a narrow viewport', () => {
					setViewportWidth(390);
					s1_useUIStore.getState().setLeftSidebarOpen(true);
					s1_useUIStore.getState().closeLeftSidebarForNavigation();
					expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
				});
				it('leaves the sidebar alone on a wide viewport', () => {
					setViewportWidth(1440);
					s1_useUIStore.getState().setLeftSidebarOpen(true);
					s1_useUIStore.getState().closeLeftSidebarForNavigation();
					expect(s1_useUIStore.getState().leftSidebarOpen).toBe(true);
				});
				it('is a no-op when the drawer is already closed', () => {
					setViewportWidth(390);
					s1_useUIStore.getState().setLeftSidebarOpen(false);
					const before = s1_useUIStore.getState();
					s1_useUIStore.getState().closeLeftSidebarForNavigation();
					expect(s1_useUIStore.getState()).toBe(before);
				});
			});
			describe('closeRightPanelForNavigation', () => {
				const setViewportWidth = (width: number) => {
					Object.defineProperty(window, 'innerWidth', {
						configurable: true,
						writable: true,
						value: width,
					});
				};
				const originalWidth = window.innerWidth;
				afterEach(() => {
					setViewportWidth(originalWidth);
				});
				it('closes the drawer on a narrow viewport', () => {
					setViewportWidth(390);
					s1_useUIStore.getState().setRightPanelOpen(true);
					s1_useUIStore.getState().closeRightPanelForNavigation();
					expect(s1_useUIStore.getState().rightPanelOpen).toBe(false);
				});
				it('leaves the Right Bar alone on a wide viewport', () => {
					setViewportWidth(1440);
					s1_useUIStore.getState().setRightPanelOpen(true);
					s1_useUIStore.getState().closeRightPanelForNavigation();
					expect(s1_useUIStore.getState().rightPanelOpen).toBe(true);
				});
				it('is a no-op when the drawer is already closed', () => {
					setViewportWidth(390);
					s1_useUIStore.getState().setRightPanelOpen(false);
					const before = s1_useUIStore.getState();
					s1_useUIStore.getState().closeRightPanelForNavigation();
					expect(s1_useUIStore.getState()).toBe(before);
				});
				it('does not disturb the left drawer', () => {
					setViewportWidth(390);
					s1_useUIStore.getState().setLeftSidebarOpen(true);
					s1_useUIStore.getState().setRightPanelOpen(true);
					s1_useUIStore.getState().closeRightPanelForNavigation();
					expect(s1_useUIStore.getState().rightPanelOpen).toBe(false);
					expect(s1_useUIStore.getState().leftSidebarOpen).toBe(true);
				});
			});
		});
		describe('focus state', () => {
			it('sets active focus with a value', () => {
				s1_useUIStore.getState().setActiveFocus('sidebar');
				expect(s1_useUIStore.getState().activeFocus).toBe('sidebar');
			});
			it('sets active focus with an updater function', () => {
				s1_useUIStore.getState().setActiveFocus(() => 'right');
				expect(s1_useUIStore.getState().activeFocus).toBe('right');
			});
			it('sets active right tab', () => {
				s1_useUIStore.getState().setActiveRightTab('history');
				expect(s1_useUIStore.getState().activeRightTab).toBe('history');
				s1_useUIStore.getState().setActiveRightTab('autorun');
				expect(s1_useUIStore.getState().activeRightTab).toBe('autorun');
			});
		});
		describe('sidebar collapse/expand state', () => {
			it('sets bookmarks collapsed', () => {
				s1_useUIStore.getState().setBookmarksCollapsed(true);
				expect(s1_useUIStore.getState().bookmarksCollapsed).toBe(true);
			});
			it('toggles bookmarks collapsed', () => {
				expect(s1_useUIStore.getState().bookmarksCollapsed).toBe(false);
				s1_useUIStore.getState().toggleBookmarksCollapsed();
				expect(s1_useUIStore.getState().bookmarksCollapsed).toBe(true);
				s1_useUIStore.getState().toggleBookmarksCollapsed();
				expect(s1_useUIStore.getState().bookmarksCollapsed).toBe(false);
			});
			it('persists bookmarks collapse state so it survives restarts', () => {
				const setSetting = (window as any).maestro.settings.set as ReturnType<typeof vi.fn>;
				setSetting.mockClear();
				s1_useUIStore.getState().setBookmarksCollapsed(true);
				expect(setSetting).toHaveBeenCalledWith('bookmarksCollapsed', true);
				s1_useUIStore.getState().toggleBookmarksCollapsed();
				expect(setSetting).toHaveBeenLastCalledWith('bookmarksCollapsed', false);
			});
		});
		describe('session list filter state', () => {
			it('sets show unread only', () => {
				s1_useUIStore.getState().setShowUnreadOnly(true);
				expect(s1_useUIStore.getState().showUnreadOnly).toBe(true);
			});
			it('sets show unread only with an updater', () => {
				s1_useUIStore.getState().setShowUnreadOnly((prev) => !prev);
				expect(s1_useUIStore.getState().showUnreadOnly).toBe(true);
			});
			it('toggles show unread only', () => {
				expect(s1_useUIStore.getState().showUnreadOnly).toBe(false);
				s1_useUIStore.getState().toggleShowUnreadOnly();
				expect(s1_useUIStore.getState().showUnreadOnly).toBe(true);
				s1_useUIStore.getState().toggleShowUnreadOnly();
				expect(s1_useUIStore.getState().showUnreadOnly).toBe(false);
			});
			it('sets show unread agents only', () => {
				s1_useUIStore.getState().setShowUnreadAgentsOnly(true);
				expect(s1_useUIStore.getState().showUnreadAgentsOnly).toBe(true);
			});
			it('toggles show unread agents only', () => {
				expect(s1_useUIStore.getState().showUnreadAgentsOnly).toBe(false);
				s1_useUIStore.getState().toggleShowUnreadAgentsOnly();
				expect(s1_useUIStore.getState().showUnreadAgentsOnly).toBe(true);
				s1_useUIStore.getState().toggleShowUnreadAgentsOnly();
				expect(s1_useUIStore.getState().showUnreadAgentsOnly).toBe(false);
			});
			it('sets pre-filter active tab id', () => {
				s1_useUIStore.getState().setPreFilterActiveTabId('tab-123');
				expect(s1_useUIStore.getState().preFilterActiveTabId).toBe('tab-123');
				s1_useUIStore.getState().setPreFilterActiveTabId(null);
				expect(s1_useUIStore.getState().preFilterActiveTabId).toBeNull();
			});
			it('sets pre-terminal file tab id', () => {
				s1_useUIStore.getState().setPreTerminalFileTabId('file-tab-456');
				expect(s1_useUIStore.getState().preTerminalFileTabId).toBe('file-tab-456');
				s1_useUIStore.getState().setPreTerminalFileTabId(null);
				expect(s1_useUIStore.getState().preTerminalFileTabId).toBeNull();
			});
		});
		describe('session sidebar selection', () => {
			it('sets selected sidebar index with a value', () => {
				s1_useUIStore.getState().setSelectedSidebarIndex(5);
				expect(s1_useUIStore.getState().selectedSidebarIndex).toBe(5);
			});
			it('sets selected sidebar index with an updater', () => {
				s1_useUIStore.getState().setSelectedSidebarIndex(3);
				s1_useUIStore.getState().setSelectedSidebarIndex((prev) => prev + 1);
				expect(s1_useUIStore.getState().selectedSidebarIndex).toBe(4);
			});
		});
		describe('flash notification setters (compatibility shims → centerFlashStore)', () => {
			it('setFlashNotification fires a yellow center flash', async () => {
				const { useCenterFlashStore } = await import('../../../renderer/stores/centerFlashStore');
				useCenterFlashStore.getState().setActive(null);
				s1_useUIStore.getState().setFlashNotification('Commands disabled');
				const active = useCenterFlashStore.getState().active;
				expect(active?.message).toBe('Commands disabled');
				expect(active?.color).toBe('yellow');
				// Passing null is a no-op (auto-dismiss handles clearing)
				s1_useUIStore.getState().setFlashNotification(null);
				expect(useCenterFlashStore.getState().active?.message).toBe('Commands disabled');
			});
			it('setSuccessFlashNotification fires a themed center flash', async () => {
				const { useCenterFlashStore } = await import('../../../renderer/stores/centerFlashStore');
				useCenterFlashStore.getState().setActive(null);
				s1_useUIStore.getState().setSuccessFlashNotification('Refresh complete');
				const active = useCenterFlashStore.getState().active;
				expect(active?.message).toBe('Refresh complete');
				expect(active?.color).toBe('theme');
				s1_useUIStore.getState().setSuccessFlashNotification(null);
				expect(useCenterFlashStore.getState().active?.message).toBe('Refresh complete');
			});
		});
		describe('output search state (scoped per agent+tab key)', () => {
			const KEY = 'agent-1::tab-1';
			it('sets output search open for a key', () => {
				s1_useUIStore.getState().setOutputSearchOpen(KEY, true);
				expect(s1_useUIStore.getState().outputSearchByKey[KEY]?.open).toBe(true);
			});
			it('sets output search query for a key', () => {
				s1_useUIStore.getState().setOutputSearchQuery(KEY, 'find this');
				expect(s1_useUIStore.getState().outputSearchByKey[KEY]?.query).toBe('find this');
			});
			it('keeps each key independent', () => {
				s1_useUIStore.getState().setOutputSearchOpen('a::1', true);
				s1_useUIStore.getState().setOutputSearchQuery('a::1', 'alpha');
				expect(s1_useUIStore.getState().outputSearchByKey['b::1']).toBeUndefined();
			});
			it('prunes a slot when closed with an empty query', () => {
				s1_useUIStore.getState().setOutputSearchOpen(KEY, true);
				s1_useUIStore.getState().setOutputSearchOpen(KEY, false);
				expect(s1_useUIStore.getState().outputSearchByKey[KEY]).toBeUndefined();
			});
		});
		describe('pending log jump (cross-tab search)', () => {
			const JUMP = { sessionId: 'agent-1', tabId: 'tab-2', logId: 'log-9' };
			it('starts empty', () => {
				expect(s1_useUIStore.getState().pendingLogJump).toBeNull();
			});
			it('stores a jump request', () => {
				s1_useUIStore.getState().setPendingLogJump(JUMP);
				expect(s1_useUIStore.getState().pendingLogJump).toEqual(JUMP);
			});
			it('clears the request once the target entry consumes it', () => {
				s1_useUIStore.getState().setPendingLogJump(JUMP);
				s1_useUIStore.getState().clearPendingLogJump('log-9');
				expect(s1_useUIStore.getState().pendingLogJump).toBeNull();
			});
			it('does not clear a newer request queued for a different entry', () => {
				s1_useUIStore.getState().setPendingLogJump(JUMP);
				s1_useUIStore.getState().clearPendingLogJump('some-older-log');
				expect(s1_useUIStore.getState().pendingLogJump).toEqual(JUMP);
			});
			it('replaces an unconsumed request', () => {
				s1_useUIStore.getState().setPendingLogJump(JUMP);
				const next = { sessionId: 'agent-1', tabId: 'tab-3', logId: 'log-10' };
				s1_useUIStore.getState().setPendingLogJump(next);
				expect(s1_useUIStore.getState().pendingLogJump).toEqual(next);
			});
		});
		describe('session filter state', () => {
			it('sets session filter open', () => {
				s1_useUIStore.getState().setSessionFilterOpen(true);
				expect(s1_useUIStore.getState().sessionFilterOpen).toBe(true);
			});
			it('sets session filter open with an updater', () => {
				s1_useUIStore.getState().setSessionFilterOpen((prev) => !prev);
				expect(s1_useUIStore.getState().sessionFilterOpen).toBe(true);
			});
		});
		describe('history search filter state', () => {
			it('sets history search filter open', () => {
				s1_useUIStore.getState().setHistorySearchFilterOpen(true);
				expect(s1_useUIStore.getState().historySearchFilterOpen).toBe(true);
			});
			it('sets history search filter open with an updater', () => {
				s1_useUIStore.getState().setHistorySearchFilterOpen((prev) => !prev);
				expect(s1_useUIStore.getState().historySearchFilterOpen).toBe(true);
			});
		});
		describe('drag and drop state', () => {
			it('sets dragging session id', () => {
				s1_useUIStore.getState().setDraggingSessionId('session-789');
				expect(s1_useUIStore.getState().draggingSessionId).toBe('session-789');
				s1_useUIStore.getState().setDraggingSessionId(null);
				expect(s1_useUIStore.getState().draggingSessionId).toBeNull();
			});
		});
		describe('editing state', () => {
			it('sets editing group id', () => {
				s1_useUIStore.getState().setEditingGroupId('group-1');
				expect(s1_useUIStore.getState().editingGroupId).toBe('group-1');
				s1_useUIStore.getState().setEditingGroupId(null);
				expect(s1_useUIStore.getState().editingGroupId).toBeNull();
			});
			it('sets editing session id', () => {
				s1_useUIStore.getState().setEditingSessionId('session-1');
				expect(s1_useUIStore.getState().editingSessionId).toBe('session-1');
				s1_useUIStore.getState().setEditingSessionId(null);
				expect(s1_useUIStore.getState().editingSessionId).toBeNull();
			});
		});
		describe('usage dashboard view mode', () => {
			it('sets the last-selected tab with a value', () => {
				s1_useUIStore.getState().setUsageDashboardViewMode('cue');
				expect(s1_useUIStore.getState().usageDashboardViewMode).toBe('cue');
			});
			it('sets the last-selected tab with an updater', () => {
				s1_useUIStore.getState().setUsageDashboardViewMode('autorun');
				s1_useUIStore
					.getState()
					.setUsageDashboardViewMode((prev) => (prev === 'autorun' ? 'activity' : 'overview'));
				expect(s1_useUIStore.getState().usageDashboardViewMode).toBe('activity');
			});
		});
		describe('React hook integration', () => {
			it('provides state to React components via selectors', () => {
				const { result } = renderHook(() => s1_useUIStore((s) => s.leftSidebarOpen));
				expect(result.current).toBe(true);
			});
			it('re-renders when selected state changes', () => {
				const { result } = renderHook(() => s1_useUIStore((s) => s.leftSidebarOpen));
				expect(result.current).toBe(true);
				act(() => {
					s1_useUIStore.getState().setLeftSidebarOpen(false);
				});
				expect(result.current).toBe(false);
			});
			it('does not re-render when unrelated state changes', () => {
				let renderCount = 0;
				const { result } = renderHook(() => {
					renderCount++;
					return s1_useUIStore((s) => s.leftSidebarOpen);
				});
				const initialRenderCount = renderCount;
				// Change unrelated state
				act(() => {
					s1_useUIStore.getState().setOutputSearchQuery('k::1', 'test');
				});
				// Should not have re-rendered (selector isolation)
				expect(renderCount).toBe(initialRenderCount);
				expect(result.current).toBe(true);
			});
			it('works with multiple selectors in the same component', () => {
				const { result } = renderHook(() => ({
					leftOpen: s1_useUIStore((s) => s.leftSidebarOpen),
					rightOpen: s1_useUIStore((s) => s.rightPanelOpen),
				}));
				expect(result.current.leftOpen).toBe(true);
				expect(result.current.rightOpen).toBe(true);
				act(() => {
					s1_useUIStore.getState().setLeftSidebarOpen(false);
				});
				expect(result.current.leftOpen).toBe(false);
				expect(result.current.rightOpen).toBe(true);
			});
		});
		describe('action stability (getState extraction pattern)', () => {
			it('returns stable action references across state changes', () => {
				const actionsBefore = s1_useUIStore.getState();
				s1_useUIStore.getState().setLeftSidebarOpen(false);
				s1_useUIStore.getState().setOutputSearchQuery('k::1', 'changed');
				const actionsAfter = s1_useUIStore.getState();
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
				// Grab actions once, then call them - mirrors the App.tsx pattern
				const { setLeftSidebarOpen, setActiveFocus } = s1_useUIStore.getState();
				setLeftSidebarOpen(false);
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
				setActiveFocus('sidebar');
				expect(s1_useUIStore.getState().activeFocus).toBe('sidebar');
			});
			it('extracted actions work with updater functions', () => {
				const { setSelectedSidebarIndex } = s1_useUIStore.getState();
				setSelectedSidebarIndex(10);
				expect(s1_useUIStore.getState().selectedSidebarIndex).toBe(10);
				setSelectedSidebarIndex((prev) => prev - 3);
				expect(s1_useUIStore.getState().selectedSidebarIndex).toBe(7);
			});
		});
		describe('non-React access (getState)', () => {
			it('provides current state outside React', () => {
				const state = s1_useUIStore.getState();
				expect(state.leftSidebarOpen).toBe(true);
			});
			it('allows mutations outside React', () => {
				s1_useUIStore.getState().setLeftSidebarOpen(false);
				expect(s1_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
			it('supports the preFilterActiveTabId ref-replacement pattern', () => {
				// This tests the pattern used in App.tsx toggleUnreadFilter:
				// save → read → clear
				s1_useUIStore.getState().setPreFilterActiveTabId('tab-1');
				expect(s1_useUIStore.getState().preFilterActiveTabId).toBe('tab-1');
				const saved = s1_useUIStore.getState().preFilterActiveTabId;
				expect(saved).toBe('tab-1');
				s1_useUIStore.getState().setPreFilterActiveTabId(null);
				expect(s1_useUIStore.getState().preFilterActiveTabId).toBeNull();
			});
			it('supports the preTerminalFileTabId ref-replacement pattern', () => {
				// This tests the pattern used in App.tsx toggleInputMode:
				// save → read → clear
				s1_useUIStore.getState().setPreTerminalFileTabId('file-tab-1');
				expect(s1_useUIStore.getState().preTerminalFileTabId).toBe('file-tab-1');
				const saved = s1_useUIStore.getState().preTerminalFileTabId;
				expect(saved).toBe('file-tab-1');
				s1_useUIStore.getState().setPreTerminalFileTabId(null);
				expect(s1_useUIStore.getState().preTerminalFileTabId).toBeNull();
			});
		});
	});
});
// Source: src/__tests__/renderer/stores/feedbackDraftStore.test.ts
describe('', () => {
	const makeDraft = (overrides: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
		id: 'd1',
		suggestedName: 'Draft one',
		category: 'bug_report',
		summary: '',
		confidence: 0,
		agentType: 'claude-code',
		messages: [],
		attachments: [],
		inputDraft: '',
		includeDebugPackage: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	});
	describe('feedbackDraftStore', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useFeedbackDraftStore.setState({
				isMinimized: false,
				hasDraft: false,
				drafts: [],
				resumeDraftId: null,
				activeDraftId: null,
				activeDraft: null,
				saveError: null,
			});
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [] });
			window.maestro.feedback.drafts.save.mockImplementation((draft: FeedbackDraft) =>
				Promise.resolve({ draft })
			);
			window.maestro.feedback.drafts.delete.mockResolvedValue({});
		});
		it('loadDrafts populates the drafts list from the IPC bridge', async () => {
			const draft = makeDraft();
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [draft] });
			await useFeedbackDraftStore.getState().loadDrafts();
			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(useFeedbackDraftStore.getState().drafts).toEqual([draft]);
		});
		it('saveDraft persists, refreshes the list, and tracks the active id', async () => {
			const draft = makeDraft({ id: 'saved-1' });
			window.maestro.feedback.drafts.save.mockResolvedValue({ draft });
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [draft] });
			const id = await useFeedbackDraftStore.getState().saveDraft(draft);
			expect(window.maestro.feedback.drafts.save).toHaveBeenCalledWith(draft);
			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(id).toBe('saved-1');
			expect(useFeedbackDraftStore.getState().activeDraftId).toBe('saved-1');
			expect(useFeedbackDraftStore.getState().drafts).toEqual([draft]);
		});
		it('deleteDraft removes via IPC, refreshes, and clears a matching active id', async () => {
			useFeedbackDraftStore.setState({ activeDraftId: 'd1' });
			window.maestro.feedback.drafts.list.mockResolvedValue({ drafts: [] });
			await useFeedbackDraftStore.getState().deleteDraft('d1');
			expect(window.maestro.feedback.drafts.delete).toHaveBeenCalledWith('d1');
			expect(window.maestro.feedback.drafts.list).toHaveBeenCalled();
			expect(useFeedbackDraftStore.getState().drafts).toEqual([]);
			expect(useFeedbackDraftStore.getState().activeDraftId).toBeNull();
		});
		it('reset clears the ephemeral session flags but preserves the persisted drafts', () => {
			const drafts = [makeDraft()];
			useFeedbackDraftStore.setState({
				isMinimized: true,
				hasDraft: true,
				drafts,
				activeDraftId: 'd1',
				activeDraft: drafts[0],
				resumeDraftId: 'd1',
			});
			useFeedbackDraftStore.getState().reset();
			const state = useFeedbackDraftStore.getState();
			expect(state.isMinimized).toBe(false);
			expect(state.hasDraft).toBe(false);
			expect(state.activeDraftId).toBeNull();
			expect(state.activeDraft).toBeNull();
			expect(state.resumeDraftId).toBeNull();
			// The persisted drafts list must survive a reset so it stays resumable.
			expect(state.drafts).toEqual(drafts);
		});
		it('saveActiveDraft writes out whatever the open editor holds', async () => {
			const snapshot = makeDraft({ id: '', inputDraft: 'half-written report' });
			useFeedbackDraftStore.setState({ activeDraft: snapshot });
			window.maestro.feedback.drafts.save.mockResolvedValue({ draft: makeDraft({ id: 'quit-1' }) });
			const id = await useFeedbackDraftStore.getState().saveActiveDraft();
			expect(id).toBe('quit-1');
			expect(window.maestro.feedback.drafts.save).toHaveBeenCalledWith(
				expect.objectContaining({ inputDraft: 'half-written report' })
			);
		});
		it('saveActiveDraft is a no-op when the editor is empty', async () => {
			useFeedbackDraftStore.setState({ activeDraft: null });
			const id = await useFeedbackDraftStore.getState().saveActiveDraft();
			expect(id).toBeNull();
			expect(window.maestro.feedback.drafts.save).not.toHaveBeenCalled();
		});
		it('saveDraft surfaces a failure as null and records a saveError', async () => {
			window.maestro.feedback.drafts.save.mockRejectedValue(new Error('disk full'));
			const id = await useFeedbackDraftStore.getState().saveDraft(makeDraft());
			expect(id).toBeNull();
			expect(useFeedbackDraftStore.getState().saveError).toBeTruthy();
		});
		it('saveDraft patches the live snapshot id so later saves upsert instead of duplicating', async () => {
			const snapshot = makeDraft({ id: '' });
			useFeedbackDraftStore.setState({ activeDraft: snapshot, saveError: 'stale error' });
			window.maestro.feedback.drafts.save.mockResolvedValue({
				draft: makeDraft({ id: 'minted-1' }),
			});
			const id = await useFeedbackDraftStore.getState().saveDraft(snapshot);
			expect(id).toBe('minted-1');
			const state = useFeedbackDraftStore.getState();
			expect(state.activeDraftId).toBe('minted-1');
			expect(state.activeDraft?.id).toBe('minted-1');
			expect(state.saveError).toBeNull();
		});
		it('dedupes concurrent first-saves of a new draft into a single draft row', async () => {
			// Mirror the main-process handler: an empty id mints a fresh UUID per
			// call, while an existing id upserts the matching row in place.
			const persisted: FeedbackDraft[] = [];
			let mintCounter = 0;
			window.maestro.feedback.drafts.save.mockImplementation(async (incoming: FeedbackDraft) => {
				const id = incoming.id || `minted-${++mintCounter}`;
				const existing = persisted.findIndex((d) => d.id === id);
				const saved = { ...incoming, id };
				if (existing >= 0) persisted[existing] = saved;
				else persisted.push(saved);
				return { draft: saved };
			});
			window.maestro.feedback.drafts.list.mockImplementation(async () => ({
				drafts: [...persisted],
			}));
			// Both saves fire before the first resolves, so both serialize an empty id.
			const { saveDraft } = useFeedbackDraftStore.getState();
			const newDraft = makeDraft({ id: '' });
			const [id1, id2] = await Promise.all([saveDraft(newDraft), saveDraft(newDraft)]);
			// Exactly one row is created and both calls resolve to the same minted id.
			expect(mintCounter).toBe(1);
			expect(persisted).toHaveLength(1);
			expect(id1).toBe('minted-1');
			expect(id2).toBe('minted-1');
			expect(useFeedbackDraftStore.getState().activeDraftId).toBe('minted-1');
		});
	});
});
// Source: src/__tests__/renderer/stores/sidebarNavStore.test.ts
describe('', () => {
	const SESSION_ID = 'session-1';
	const TAB_ID = 'tab-1';
	const openItem: StarredItem = {
		kind: 'open',
		key: `${SESSION_ID}:${TAB_ID}`,
		displayName: 'Refactor pass',
		agentName: 'Maestro',
		parentSessionId: SESSION_ID,
		tabId: TAB_ID,
	};
	const originalWidth = window.innerWidth;
	const setViewportWidth = (width: number) => {
		Object.defineProperty(window, 'innerWidth', {
			configurable: true,
			writable: true,
			value: width,
		});
	};
	describe('sidebarNavStore', () => {
		beforeEach(() => {
			useSidebarNavStore.setState(useSidebarNavStore.getInitialState(), true);
			useSessionStore.setState({
				sessions: [s3_createMockSession({ id: SESSION_ID, name: 'Maestro' })],
				activeSessionId: '',
			});
			useGroupChatStore.setState({ activeGroupChatId: null });
			s3_useUIStore.setState({ leftSidebarOpen: true });
		});
		afterEach(() => {
			setViewportWidth(originalWidth);
			vi.restoreAllMocks();
		});
		describe('activateStarredItem', () => {
			it('activates the owning agent and its tab', async () => {
				setViewportWidth(1440);
				await useSidebarNavStore.getState().activateStarredItem(openItem);
				expect(useSessionStore.getState().activeSessionId).toBe(SESSION_ID);
				const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
				expect(session?.activeTabId).toBe(TAB_ID);
				expect(session?.activeFileTabId).toBeNull();
				expect(session?.inputMode).toBe('ai');
			});
			it('closes the left drawer on a narrow viewport', async () => {
				setViewportWidth(390);
				await useSidebarNavStore.getState().activateStarredItem(openItem);
				expect(s3_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
			it('closes the drawer even when the starred row names the active agent', async () => {
				// The case the activeSessionId-transition effect cannot see: the id
				// the tap sets is the id that was already there.
				setViewportWidth(390);
				useSessionStore.setState({ activeSessionId: SESSION_ID });
				await useSidebarNavStore.getState().activateStarredItem(openItem);
				expect(s3_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
			it('leaves the Left Bar open when it is a permanent column', async () => {
				setViewportWidth(1440);
				await useSidebarNavStore.getState().activateStarredItem(openItem);
				expect(s3_useUIStore.getState().leftSidebarOpen).toBe(true);
			});
			it('closes the drawer for a closed starred session too', async () => {
				setViewportWidth(390);
				const onJumpToStarredSession = vi.fn().mockResolvedValue(true);
				useSidebarNavStore.getState().registerStarredHandlers({ onJumpToStarredSession });
				await useSidebarNavStore.getState().activateStarredItem({
					kind: 'closed',
					key: 'closed-1',
					displayName: 'Aged out thread',
					agentName: 'Maestro',
					parentSessionId: SESSION_ID,
					agentId: 'claude-code',
					agentSessionId: 'abc-123',
					projectPath: '/tmp/project',
					sessionName: 'Aged out thread',
				});
				expect(onJumpToStarredSession).toHaveBeenCalled();
				expect(s3_useUIStore.getState().leftSidebarOpen).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/renderer/stores/cadenzaStore.test.ts
describe('', () => {
	function reset() {
		useCadenzaStore.setState({ cadenzas: [], flashedId: null });
	}
	describe('applyCadenzaPayload', () => {
		beforeEach(reset);
		it('open applies defaults (tracker type, theme color, id as title)', () => {
			applyCadenzaPayload({ op: 'open', id: 'tests' });
			const c = useCadenzaStore.getState().cadenzas[0];
			expect(c).toMatchObject({ id: 'tests', viewType: 'tracker', color: 'theme', title: 'tests' });
			expect(typeof c.x).toBe('number');
			expect(typeof c.y).toBe('number');
		});
		it('open honors explicit fields', () => {
			applyCadenzaPayload({
				op: 'open',
				id: 'c',
				viewType: 'decision',
				title: 'Ship it?',
				color: 'orange',
				options: [{ label: 'Yes', value: 'yes' }],
			});
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
				viewType: 'decision',
				title: 'Ship it?',
				color: 'orange',
				options: [{ label: 'Yes', value: 'yes' }],
			});
		});
		it('update patches only the sent fields, leaving title intact on a body-only update', () => {
			applyCadenzaPayload({ op: 'open', id: 'c', title: 'Suite', body: 'running' });
			applyCadenzaPayload({ op: 'update', id: 'c', body: '3/10 passed' });
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
				title: 'Suite',
				body: '3/10 passed',
			});
		});
		it('re-opening an existing id preserves its position', () => {
			applyCadenzaPayload({ op: 'open', id: 'c' });
			const { x, y } = useCadenzaStore.getState().cadenzas[0];
			applyCadenzaPayload({ op: 'open', id: 'c', title: 'renamed' });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(1);
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({ x, y, title: 'renamed' });
		});
		it('close removes the cadenza', () => {
			applyCadenzaPayload({ op: 'open', id: 'c' });
			applyCadenzaPayload({ op: 'close', id: 'c' });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
		});
		it('keeps static plugin view data safe across update and close', () => {
			const id = 'com.acme.metrics/release-summary';
			applyCadenzaPayload({
				op: 'open',
				id,
				viewType: 'view',
				title: 'Release summary',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Initial report' }] }),
				sourcePlugin: 'Acme Metrics',
			});
			applyCadenzaPayload({
				op: 'update',
				id,
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
			});
			expect(useCadenzaStore.getState().cadenzas).toMatchObject([
				{
					id,
					viewType: 'view',
					title: 'Release summary',
					sourcePlugin: 'Acme Metrics',
					body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
				},
			]);
			applyCadenzaPayload({ op: 'close', id });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
		});
	});
	describe('flashItem', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			reset();
		});
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});
		it('pulses the id then clears it after the timeout', () => {
			useCadenzaStore.getState().flashItem('c');
			expect(useCadenzaStore.getState().flashedId).toBe('c');
			vi.advanceTimersByTime(2200);
			expect(useCadenzaStore.getState().flashedId).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/stores/codexResetCreditsStore.test.ts
describe('', () => {
	/**
	 * The store is the only path that spends a reset credit, and a credit is
	 * finite, expires, and cannot be refunded. So the behaviours pinned here are
	 * the ones whose failure costs the user something real: a second spend landing
	 * for one click, a spend aimed at the wrong credit, and a failed read making a
	 * stocked account look empty.
	 */
	const CODEX_HOME = '/home/tester/.codex';
	function credit(overrides: Partial<CodexResetCredit> = {}): CodexResetCredit {
		return {
			id: 'credit-1',
			supportedByPlan: true,
			status: 'available',
			...overrides,
		};
	}
	let getCredits: ReturnType<typeof vi.fn>;
	let consumeCredit: ReturnType<typeof vi.fn>;
	describe('codexResetCreditsStore', () => {
		beforeEach(() => {
			useCodexResetCreditsStore.getState().__resetForTests();
			getCredits = vi.fn().mockResolvedValue({
				ok: true,
				detail: { credits: [credit()], available: 1, applicable: 1 },
			});
			consumeCredit = vi.fn().mockResolvedValue({ ok: true, windowsReset: 2 });
			(
				globalThis as {
					window?: unknown;
				}
			).window = {
				maestro: {
					agents: {
						getCodexResetCredits: getCredits,
						consumeCodexResetCredit: consumeCredit,
					},
				},
			};
			// The usage bars are re-read after a spend; stub it so the store's
			// invalidation can be asserted without a second IPC surface.
			useCodexUsageStore.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
		});
		describe('load', () => {
			it('stores the credits and both counts from a successful read', async () => {
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
				expect(entry?.credits).toHaveLength(1);
				expect(entry?.counts).toEqual({ available: 1, applicable: 1 });
				expect(entry?.error).toBeUndefined();
			});
			it('passes an absent applicable count through as undefined', async () => {
				// Unknown and zero drive different verdicts: coercing here would make
				// every spend on this account report as wasteful.
				getCredits.mockResolvedValue({
					ok: true,
					detail: { credits: [credit()], available: 1 },
				});
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				expect(useCodexResetCreditsStore.getState().entries[CODEX_HOME]?.counts).toEqual({
					available: 1,
					applicable: undefined,
				});
			});
			it('keeps the last known credits when a read fails', async () => {
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				getCredits.mockResolvedValue({ ok: false, error: 'Codex auth token was rejected.' });
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
				// Blanking the list would tell a user holding credits that they have
				// none, which is the one wrong answer that stops them redeeming.
				expect(entry?.credits).toHaveLength(1);
				expect(entry?.error).toBe('Codex auth token was rejected.');
			});
			it('never leaves the account stuck loading when the bridge throws', async () => {
				getCredits.mockRejectedValue(new Error('bridge is gone'));
				await useCodexResetCreditsStore.getState().load(CODEX_HOME);
				expect(useCodexResetCreditsStore.getState().loading[CODEX_HOME]).toBe(false);
			});
		});
		describe('redeem', () => {
			it('spends the soonest-to-expire credit when none is named', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [
								credit({ id: 'later', expiresAt: '2026-11-01T00:00:00.000Z' }),
								credit({ id: 'soon', expiresAt: '2026-09-20T00:00:00.000Z' }),
							],
							counts: { available: 2, applicable: 2 },
						},
					},
				});
				await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'soon', expect.any(String));
			});
			it('redeems the named credit when the caller picks one', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [credit({ id: 'a' }), credit({ id: 'b' })],
							counts: { available: 2, applicable: 2 },
						},
					},
				});
				await useCodexResetCreditsStore.getState().redeem(CODEX_HOME, 'b');
				expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'b', expect.any(String));
			});
			it('refuses a second spend while one is in flight', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				let release: (value: { ok: boolean; windowsReset: number }) => void = () => {};
				consumeCredit.mockReturnValue(
					new Promise<{
						ok: boolean;
						windowsReset: number;
					}>((resolve) => {
						release = resolve;
					})
				);
				const first = useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				const second = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				// The guard is claimed synchronously, so a double click cannot land two
				// spends for one credit.
				expect(second.attempted).toBe(false);
				expect(consumeCredit).toHaveBeenCalledTimes(1);
				release({ ok: true, windowsReset: 1 });
				await first;
				expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
			});
			it('leaves a different account free to redeem concurrently', async () => {
				const other = '/home/tester/.codex-work';
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: { credits: [credit()], counts: { available: 1 } },
						[other]: { credits: [credit({ id: 'credit-2' })], counts: { available: 1 } },
					},
					redeeming: { [CODEX_HOME]: true },
				});
				const result = await useCodexResetCreditsStore.getState().redeem(other);
				expect(result.attempted).toBe(true);
				expect(consumeCredit).toHaveBeenCalledWith(other, 'credit-2', expect.any(String));
			});
			it('reports no attempt when the account holds nothing spendable', async () => {
				useCodexResetCreditsStore.setState({
					entries: {
						[CODEX_HOME]: {
							credits: [credit({ status: 'redeemed' })],
							counts: { available: 0 },
						},
					},
				});
				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				expect(result.attempted).toBe(false);
				expect(consumeCredit).not.toHaveBeenCalled();
			});
			it('re-reads the credits and the usage bars after a successful spend', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				expect(result).toMatchObject({ ok: true, windowsReset: 2, attempted: true });
				// Otherwise the panel keeps showing the exhausted windows the user just
				// paid to reopen, which reads as the redemption having failed.
				expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
				expect(useCodexUsageStore.getState().refresh).toHaveBeenCalled();
			});
			it('still re-reads after a refused spend, so a dead credit leaves the list', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				consumeCredit.mockResolvedValue({
					ok: false,
					windowsReset: 0,
					code: 'no_credit',
					message: 'That reset credit is no longer available.',
				});
				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				expect(result).toMatchObject({ ok: false, attempted: true, code: 'no_credit' });
				expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
			});
			it('reports an undecided outcome and clears the guard when the bridge throws', async () => {
				useCodexResetCreditsStore.setState({
					entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
				});
				consumeCredit.mockRejectedValue(new Error('bridge is gone'));
				const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
				// The request may have landed, so never claim the credit was preserved.
				expect(result).toMatchObject({ ok: false, attempted: true });
				expect(result.message).toContain('may or may not have been spent');
				expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/renderer/stores/sessionEquality.test.ts
describe('', () => {
	function tab(overrides: Partial<AITab> = {}): AITab {
		return {
			id: 'tab-1',
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: 0,
			state: 'idle',
			...overrides,
		};
	}
	describe('sidebarSessionEquality', () => {
		it('returns true for the same array reference', () => {
			const arr: Session[] = [s6_createMockSession({ id: 'a' })];
			expect(sidebarSessionEquality(arr, arr)).toBe(true);
		});
		it('returns false when length differs', () => {
			const a = [s6_createMockSession({ id: 'a' })];
			const b = [s6_createMockSession({ id: 'a' }), s6_createMockSession({ id: 'b' })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns true when only streaming-only fields change (logs, usage, cycle counters)', () => {
			const base = s6_createMockSession({
				id: 'a',
				aiTabs: [tab({ id: 't1', logs: [] })],
			});
			const next: Session = {
				...base,
				// Streaming-heavy fields the equality fn intentionally ignores:
				aiLogs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'hi' }],
				shellLogs: [{ id: 'log-2', timestamp: 0, source: 'stdout', text: 'hi' }],
				usageStats: {
					inputTokens: 1,
					outputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000,
				},
				contextUsage: 42,
				aiTabs: [
					tab({
						id: 't1',
						logs: [{ id: 'log-3', timestamp: 0, source: 'stdout', text: 'streamed' }],
					}),
				],
			};
			expect(sidebarSessionEquality([base], [next])).toBe(true);
		});
		it('returns false when name changes', () => {
			const a = [s6_createMockSession({ id: 'a', name: 'old' })];
			const b = [s6_createMockSession({ id: 'a', name: 'new' })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when state changes', () => {
			const a = [s6_createMockSession({ id: 'a', state: 'idle' })];
			const b = [s6_createMockSession({ id: 'a', state: 'busy' })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when bookmarked toggles', () => {
			const a = [s6_createMockSession({ id: 'a', bookmarked: false })];
			const b = [s6_createMockSession({ id: 'a', bookmarked: true })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when groupId changes', () => {
			const a = [s6_createMockSession({ id: 'a', groupId: 'g1' })];
			const b = [s6_createMockSession({ id: 'a', groupId: 'g2' })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when worktreesExpanded toggles', () => {
			const a = [s6_createMockSession({ id: 'a', worktreesExpanded: true })];
			const b = [s6_createMockSession({ id: 'a', worktreesExpanded: false })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when an AI tab hasUnread flips', () => {
			const a = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', hasUnread: false })] })];
			const b = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', hasUnread: true })] })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns false when an AI tab busy state flips', () => {
			const a = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', state: 'idle' })] })];
			const b = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1', state: 'busy' })] })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
		it('returns true when AI tab logs change but tab metadata is identical', () => {
			const a = [
				s6_createMockSession({
					id: 'a',
					aiTabs: [tab({ id: 't1', logs: [] })],
				}),
			];
			const b = [
				s6_createMockSession({
					id: 'a',
					aiTabs: [
						tab({
							id: 't1',
							logs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'streamed' }],
						}),
					],
				}),
			];
			expect(sidebarSessionEquality(a, b)).toBe(true);
		});
		it('returns false when AI tab count changes', () => {
			const a = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1' })] })];
			const b = [s6_createMockSession({ id: 'a', aiTabs: [tab({ id: 't1' }), tab({ id: 't2' })] })];
			expect(sidebarSessionEquality(a, b)).toBe(false);
		});
	});
	describe('activeSessionChromeEquality', () => {
		it('returns true when isGeneratingName flips (MainPanel owns naming spinner)', () => {
			const a = s6_createMockSession({ aiTabs: [tab({ id: 't1', isGeneratingName: false })] });
			const b: Session = {
				...a,
				aiTabs: [{ ...a.aiTabs[0], isGeneratingName: true }],
			};
			expect(activeSessionChromeEquality(a, b)).toBe(true);
		});
		it('returns true when session/tab busy state flips (sidebar + MainPanel own busy paint)', () => {
			const a = s6_createMockSession({
				state: 'idle',
				aiTabs: [tab({ id: 't1', state: 'idle' })],
			});
			const b: Session = {
				...a,
				state: 'busy',
				aiTabs: [{ ...a.aiTabs[0], state: 'busy' }],
			};
			expect(activeSessionChromeEquality(a, b)).toBe(true);
		});
		it('returns false when browser customTitle changes', () => {
			const a = s6_createMockSession({
				browserTabs: [{ id: 'b1', title: 'Docs', url: 'https://x', customTitle: undefined } as any],
			});
			const b = s6_createMockSession({
				browserTabs: [{ id: 'b1', title: 'Docs', url: 'https://x', customTitle: 'Pinned' } as any],
			});
			expect(activeSessionChromeEquality(a, b)).toBe(false);
		});
		it('returns true when only logs change', () => {
			const a = s6_createMockSession({
				aiTabs: [tab({ id: 't1', logs: [] })],
			});
			const b: Session = {
				...a,
				aiTabs: [
					{
						...a.aiTabs[0],
						logs: [{ id: 'log-1', timestamp: 0, source: 'stdout', text: 'streamed' }],
					},
				],
			};
			expect(activeSessionChromeEquality(a, b)).toBe(true);
		});
	});
});
