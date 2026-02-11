/**
 * uiStore - Zustand store for centralized UI layout state management
 *
 * Replaces UILayoutContext. All sidebar, focus, notification, and editing
 * states live here. Components subscribe to individual slices via selectors
 * to avoid unnecessary re-renders.
 *
 * File explorer UI state has been moved to fileExplorerStore.
 *
 * Can be used outside React via useUIStore.getState() / useUIStore.setState().
 */

import { create } from 'zustand';
import type { FocusArea, RightPanelTab } from '../types';

export interface UIStoreState {
	// Sidebar
	leftSidebarOpen: boolean;
	rightPanelOpen: boolean;

	// Focus
	activeFocus: FocusArea;
	activeRightTab: RightPanelTab;

	// Sidebar collapse/expand
	bookmarksCollapsed: boolean;
	groupChatsExpanded: boolean;

	// Session list filter
	showUnreadOnly: boolean;
	preFilterActiveTabId: string | null;
	preTerminalFileTabId: string | null;

	// Session sidebar selection
	selectedSidebarIndex: number;

	// Flash notifications
	flashNotification: string | null;
	successFlashNotification: string | null;

	// Output search
	outputSearchOpen: boolean;
	outputSearchQuery: string;

	// Session filter (sidebar agent search)
	sessionFilterOpen: boolean;

	// History panel search
	historySearchFilterOpen: boolean;

	// Drag and drop (session dragging in sidebar)
	draggingSessionId: string | null;

	// Editing (inline renaming in sidebar)
	editingGroupId: string | null;
	editingSessionId: string | null;
}

export interface UIStoreActions {
	// Sidebar
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleLeftSidebar: () => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleRightPanel: () => void;

	// Focus
	setActiveFocus: (focus: FocusArea | ((prev: FocusArea) => FocusArea)) => void;
	setActiveRightTab: (tab: RightPanelTab | ((prev: RightPanelTab) => RightPanelTab)) => void;

	// Sidebar collapse/expand
	setBookmarksCollapsed: (collapsed: boolean | ((prev: boolean) => boolean)) => void;
	toggleBookmarksCollapsed: () => void;
	setGroupChatsExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void;
	toggleGroupChatsExpanded: () => void;

	// Session list filter
	setShowUnreadOnly: (show: boolean | ((prev: boolean) => boolean)) => void;
	toggleShowUnreadOnly: () => void;
	setPreFilterActiveTabId: (id: string | null) => void;
	setPreTerminalFileTabId: (id: string | null) => void;

	// Session sidebar selection
	setSelectedSidebarIndex: (index: number | ((prev: number) => number)) => void;

	// Flash notifications
	setFlashNotification: (msg: string | null | ((prev: string | null) => string | null)) => void;
	setSuccessFlashNotification: (
		msg: string | null | ((prev: string | null) => string | null)
	) => void;

	// Output search
	setOutputSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setOutputSearchQuery: (query: string | ((prev: string) => string)) => void;

	// Session filter (sidebar agent search)
	setSessionFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// History panel search
	setHistorySearchFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Drag and drop
	setDraggingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;

	// Editing
	setEditingGroupId: (id: string | null | ((prev: string | null) => string | null)) => void;
	setEditingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
}

export type UIStore = UIStoreState & UIStoreActions;

/**
 * Helper to resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

export const useUIStore = create<UIStore>()((set) => ({
	// --- State ---
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
	draggingSessionId: null,
	editingGroupId: null,
	editingSessionId: null,

	// --- Actions ---
	setLeftSidebarOpen: (v) => set((s) => ({ leftSidebarOpen: resolve(v, s.leftSidebarOpen) })),
	toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
	setRightPanelOpen: (v) => set((s) => ({ rightPanelOpen: resolve(v, s.rightPanelOpen) })),
	toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

	setActiveFocus: (v) => set((s) => ({ activeFocus: resolve(v, s.activeFocus) })),
	setActiveRightTab: (v) => set((s) => ({ activeRightTab: resolve(v, s.activeRightTab) })),

	setBookmarksCollapsed: (v) =>
		set((s) => ({ bookmarksCollapsed: resolve(v, s.bookmarksCollapsed) })),
	toggleBookmarksCollapsed: () => set((s) => ({ bookmarksCollapsed: !s.bookmarksCollapsed })),
	setGroupChatsExpanded: (v) =>
		set((s) => ({ groupChatsExpanded: resolve(v, s.groupChatsExpanded) })),
	toggleGroupChatsExpanded: () => set((s) => ({ groupChatsExpanded: !s.groupChatsExpanded })),

	setShowUnreadOnly: (v) => set((s) => ({ showUnreadOnly: resolve(v, s.showUnreadOnly) })),
	toggleShowUnreadOnly: () => set((s) => ({ showUnreadOnly: !s.showUnreadOnly })),
	setPreFilterActiveTabId: (id) => set({ preFilterActiveTabId: id }),
	setPreTerminalFileTabId: (id) => set({ preTerminalFileTabId: id }),

	setSelectedSidebarIndex: (v) =>
		set((s) => ({ selectedSidebarIndex: resolve(v, s.selectedSidebarIndex) })),

	setFlashNotification: (v) => set((s) => ({ flashNotification: resolve(v, s.flashNotification) })),
	setSuccessFlashNotification: (v) =>
		set((s) => ({ successFlashNotification: resolve(v, s.successFlashNotification) })),

	setOutputSearchOpen: (v) => set((s) => ({ outputSearchOpen: resolve(v, s.outputSearchOpen) })),
	setOutputSearchQuery: (v) => set((s) => ({ outputSearchQuery: resolve(v, s.outputSearchQuery) })),

	setSessionFilterOpen: (v) => set((s) => ({ sessionFilterOpen: resolve(v, s.sessionFilterOpen) })),
	setHistorySearchFilterOpen: (v) =>
		set((s) => ({ historySearchFilterOpen: resolve(v, s.historySearchFilterOpen) })),

	setDraggingSessionId: (v) => set((s) => ({ draggingSessionId: resolve(v, s.draggingSessionId) })),

	setEditingGroupId: (v) => set((s) => ({ editingGroupId: resolve(v, s.editingGroupId) })),
	setEditingSessionId: (v) => set((s) => ({ editingSessionId: resolve(v, s.editingSessionId) })),
}));
