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
import type { FocusArea, RightPanelTab, UsageDashboardViewMode } from '../types';
import { notifyCenterFlash } from './centerFlashStore';

export interface UIStoreState {
	// Sidebar
	leftSidebarOpen: boolean;
	rightPanelOpen: boolean;

	// Focus
	activeFocus: FocusArea;
	activeRightTab: RightPanelTab;

	// Sidebar collapse/expand
	bookmarksCollapsed: boolean;

	// Session list filter
	showUnreadOnly: boolean;
	showUnreadAgentsOnly: boolean;
	preFilterActiveTabId: string | null;
	preTerminalFileTabId: string | null;

	// Session sidebar selection
	selectedSidebarIndex: number;

	// Output search
	outputSearchOpen: boolean;
	outputSearchQuery: string;
	outputSearchRegex: boolean;

	// Session filter (sidebar agent search)
	sessionFilterOpen: boolean;

	// History panel search
	historySearchFilterOpen: boolean;

	// Group chat history panel search
	groupChatHistorySearchFilterOpen: boolean;

	// Drag and drop (session dragging in sidebar)
	draggingSessionId: string | null;

	// Editing (inline renaming in sidebar)
	editingGroupId: string | null;
	editingSessionId: string | null;

	// Auto-follow active task during batch runs
	autoFollowEnabled: boolean;

	// Last-selected Usage Dashboard tab. In-memory only: survives closing and
	// reopening the dashboard within a session, resets to 'overview' on restart.
	usageDashboardViewMode: UsageDashboardViewMode;

	// Accounts the user hid in the Usage Dashboard provider quota panels, keyed
	// by provider id ('claude-code' | 'codex'); values are canonical account
	// keys. Persisted via settings write-through (mirrors bookmarksCollapsed) and
	// hydrated by loadAllSettings on startup.
	hiddenQuotaAccounts: Record<string, string[]>;
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

	// Session list filter
	setShowUnreadOnly: (show: boolean | ((prev: boolean) => boolean)) => void;
	toggleShowUnreadOnly: () => void;
	setShowUnreadAgentsOnly: (show: boolean | ((prev: boolean) => boolean)) => void;
	toggleShowUnreadAgentsOnly: () => void;
	setPreFilterActiveTabId: (id: string | null) => void;
	setPreTerminalFileTabId: (id: string | null) => void;

	// Session sidebar selection
	setSelectedSidebarIndex: (index: number | ((prev: number) => number)) => void;

	/**
	 * Compatibility shim — fires a yellow center flash.
	 * New code should call `notifyCenterFlash({ message, color: 'yellow' })` directly.
	 * Passing `null` is a no-op (auto-dismiss handles clearing).
	 */
	setFlashNotification: (msg: string | null | ((prev: string | null) => string | null)) => void;
	/**
	 * Compatibility shim — fires a themed center flash.
	 * New code should call `notifyCenterFlash({ message })` directly (defaults to `theme`).
	 * Passing `null` is a no-op (auto-dismiss handles clearing).
	 */
	setSuccessFlashNotification: (
		msg: string | null | ((prev: string | null) => string | null)
	) => void;

	// Output search
	setOutputSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setOutputSearchQuery: (query: string | ((prev: string) => string)) => void;
	setOutputSearchRegex: (regex: boolean | ((prev: boolean) => boolean)) => void;
	toggleOutputSearchRegex: () => void;

	// Session filter (sidebar agent search)
	setSessionFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// History panel search
	setHistorySearchFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Group chat history panel search
	setGroupChatHistorySearchFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Drag and drop
	setDraggingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;

	// Editing
	setEditingGroupId: (id: string | null | ((prev: string | null) => string | null)) => void;
	setEditingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;

	// Auto-follow
	setAutoFollowEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;

	// Usage Dashboard last-selected tab
	setUsageDashboardViewMode: (
		mode: UsageDashboardViewMode | ((prev: UsageDashboardViewMode) => UsageDashboardViewMode)
	) => void;

	// Toggle a provider quota account between hidden and visible.
	toggleHiddenQuotaAccount: (providerId: string, accountKey: string) => void;
}

export type UIStore = UIStoreState & UIStoreActions;

/**
 * Helper to resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

/**
 * Persist the Bookmarks section collapse state so it survives app restarts.
 * The runtime value lives here (filter mode transiently toggles it), so this
 * write-through is the single persistence point; the saved value is hydrated
 * back into this store on startup by `loadAllSettings` in settingsStore.
 */
function persistBookmarksCollapsed(value: boolean): void {
	window.maestro?.settings?.set('bookmarksCollapsed', value);
}

/**
 * Persist the per-provider hidden quota accounts map so the user's hide choices
 * survive app restarts. Hydrated back into this store on startup by
 * `loadAllSettings` in settingsStore.
 */
function persistHiddenQuotaAccounts(value: Record<string, string[]>): void {
	window.maestro?.settings?.set('hiddenQuotaAccounts', value);
}

export const useUIStore = create<UIStore>()((set) => ({
	// --- State ---
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
	outputSearchOpen: false,
	outputSearchQuery: '',
	outputSearchRegex: false,
	sessionFilterOpen: false,
	historySearchFilterOpen: false,
	groupChatHistorySearchFilterOpen: false,
	draggingSessionId: null,
	editingGroupId: null,
	editingSessionId: null,
	autoFollowEnabled: false,
	usageDashboardViewMode: 'overview',
	hiddenQuotaAccounts: {},

	// --- Actions ---
	setLeftSidebarOpen: (v) => set((s) => ({ leftSidebarOpen: resolve(v, s.leftSidebarOpen) })),
	toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
	setRightPanelOpen: (v) => set((s) => ({ rightPanelOpen: resolve(v, s.rightPanelOpen) })),
	toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

	setActiveFocus: (v) => set((s) => ({ activeFocus: resolve(v, s.activeFocus) })),
	setActiveRightTab: (v) => set((s) => ({ activeRightTab: resolve(v, s.activeRightTab) })),

	setBookmarksCollapsed: (v) =>
		set((s) => {
			const next = resolve(v, s.bookmarksCollapsed);
			persistBookmarksCollapsed(next);
			return { bookmarksCollapsed: next };
		}),
	toggleBookmarksCollapsed: () =>
		set((s) => {
			const next = !s.bookmarksCollapsed;
			persistBookmarksCollapsed(next);
			return { bookmarksCollapsed: next };
		}),

	setShowUnreadOnly: (v) => set((s) => ({ showUnreadOnly: resolve(v, s.showUnreadOnly) })),
	toggleShowUnreadOnly: () => set((s) => ({ showUnreadOnly: !s.showUnreadOnly })),
	setShowUnreadAgentsOnly: (v) =>
		set((s) => ({ showUnreadAgentsOnly: resolve(v, s.showUnreadAgentsOnly) })),
	toggleShowUnreadAgentsOnly: () => set((s) => ({ showUnreadAgentsOnly: !s.showUnreadAgentsOnly })),
	setPreFilterActiveTabId: (id) => set({ preFilterActiveTabId: id }),
	setPreTerminalFileTabId: (id) => set({ preTerminalFileTabId: id }),

	setSelectedSidebarIndex: (v) =>
		set((s) => ({ selectedSidebarIndex: resolve(v, s.selectedSidebarIndex) })),

	setFlashNotification: (v) => {
		const value = typeof v === 'function' ? v(null) : v;
		if (value === null) return;
		notifyCenterFlash({ message: value, color: 'yellow' });
	},
	setSuccessFlashNotification: (v) => {
		const value = typeof v === 'function' ? v(null) : v;
		if (value === null) return;
		notifyCenterFlash({ message: value, color: 'theme' });
	},

	setOutputSearchOpen: (v) => set((s) => ({ outputSearchOpen: resolve(v, s.outputSearchOpen) })),
	setOutputSearchQuery: (v) => set((s) => ({ outputSearchQuery: resolve(v, s.outputSearchQuery) })),
	setOutputSearchRegex: (v) => set((s) => ({ outputSearchRegex: resolve(v, s.outputSearchRegex) })),
	toggleOutputSearchRegex: () => set((s) => ({ outputSearchRegex: !s.outputSearchRegex })),

	setSessionFilterOpen: (v) => set((s) => ({ sessionFilterOpen: resolve(v, s.sessionFilterOpen) })),
	setHistorySearchFilterOpen: (v) =>
		set((s) => ({ historySearchFilterOpen: resolve(v, s.historySearchFilterOpen) })),
	setGroupChatHistorySearchFilterOpen: (v) =>
		set((s) => ({
			groupChatHistorySearchFilterOpen: resolve(v, s.groupChatHistorySearchFilterOpen),
		})),

	setDraggingSessionId: (v) => set((s) => ({ draggingSessionId: resolve(v, s.draggingSessionId) })),

	setEditingGroupId: (v) => set((s) => ({ editingGroupId: resolve(v, s.editingGroupId) })),
	setEditingSessionId: (v) => set((s) => ({ editingSessionId: resolve(v, s.editingSessionId) })),

	setAutoFollowEnabled: (v) => set((s) => ({ autoFollowEnabled: resolve(v, s.autoFollowEnabled) })),

	setUsageDashboardViewMode: (v) =>
		set((s) => ({ usageDashboardViewMode: resolve(v, s.usageDashboardViewMode) })),

	toggleHiddenQuotaAccount: (providerId, accountKey) =>
		set((s) => {
			const current = s.hiddenQuotaAccounts[providerId] ?? [];
			const next = current.includes(accountKey)
				? current.filter((k) => k !== accountKey)
				: [...current, accountKey];
			const nextMap = { ...s.hiddenQuotaAccounts, [providerId]: next };
			persistHiddenQuotaAccounts(nextMap);
			return { hiddenQuotaAccounts: nextMap };
		}),
}));
