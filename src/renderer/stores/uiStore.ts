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
import { resolveUpdater } from '../utils/resolveUpdater';

/**
 * Keyboard-selection cursor for the two Left Bar sections that are NOT plain
 * agents: Starred Sessions (top) and Group Chats (bottom). Plain agent rows are
 * tracked by `selectedSidebarIndex` (an index into navSessions); this token
 * tracks the cursor when arrow-key navigation lands in a non-agent section, so
 * those rows can show the same keyboard-selected highlight. Exactly one of
 * (selectedSidebarIndex >= 0) / (sidebarExtraSelection !== null) is "live" at a
 * time - landing on a starred/group-chat row sets selectedSidebarIndex to -1.
 */
export type SidebarExtraSelection =
	| { kind: 'starred'; key: string }
	| { kind: 'groupChat'; id: string };

/** Per-window state for the AI chat "Find" bar (one slot per agent+AI-tab). */
export interface OutputSearchSlot {
	open: boolean;
	query: string;
	regex: boolean;
}

export interface UIStoreState {
	// Sidebar - tri-state via two booleans: !hidden && open = full panel,
	// !hidden && !open = collapsed status-dot strip, hidden = no panel at all.
	leftSidebarOpen: boolean;
	leftSidebarHidden: boolean;
	rightPanelOpen: boolean;

	// Focus
	activeFocus: FocusArea;
	activeRightTab: RightPanelTab;

	// Tab tiling: id of the pane currently maximized/zoomed to fill the whole
	// panel (Ctrl+Cmd+Z). Transient and non-persisted, per the spec - toggling
	// again clears it. null when no pane is zoomed.
	zoomedPaneId: string | null;

	// Tab tiling: transient state for a pane REARRANGE drag driven by pointer
	// events (not native HTML5 DnD, which does not reliably start a macOS drag
	// session inside child Electron windows). Set while a tile header is being
	// dragged; the drop-zone overlay reads `hover` to paint the target region and
	// the swap/move badge. null when no pane drag is in flight. See usePaneDrag.
	paneDrag: {
		groupId: string;
		leafId: string;
		/** Live pointer position in client (viewport) px, for the drag ghost. */
		pointer: { x: number; y: number };
		/** The pane + zone under the pointer, or null when over no droppable pane. */
		hover: { leafId: string; zone: import('../utils/panelLayout').DropZone } | null;
	} | null;

	// Sidebar collapse/expand
	bookmarksCollapsed: boolean;

	// Session list filter
	showUnreadOnly: boolean;
	showUnreadAgentsOnly: boolean;
	preFilterActiveTabId: string | null;
	preTerminalFileTabId: string | null;

	// Pianola workspace: which pinned view is showing (its chat or the agent dashboard).
	pianolaView: 'chat' | 'dashboard';

	// Session sidebar selection
	selectedSidebarIndex: number;
	// Keyboard cursor when it lands on a Starred / Group Chat row (see type docs).
	// null when the cursor is on a plain agent row (tracked by selectedSidebarIndex).
	sidebarExtraSelection: SidebarExtraSelection | null;

	// Output search (the AI chat "Find" bar). Scoped per agent+AI-tab so a search
	// opened in one chat window doesn't follow the user - state, open flag, and
	// term - across other agents/tabs. Keyed by `${sessionId}::${tabId}` (see
	// outputSearchKeyFor in utils/outputSearch). Slots are pruned when a search is
	// closed with an empty term, so the map only holds windows with an active find.
	outputSearchByKey: Record<string, OutputSearchSlot>;

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

	// Whether a performance-profiling recording is active. Drives the animated
	// wand indicator in the Left Bar header. Source of truth is the main process
	// (contentTracing singleton); the command palette reconciles this on open.
	profilingActive: boolean;

	// Last-selected Usage Dashboard tab. In-memory only: survives closing and
	// reopening the dashboard within a session, resets to 'overview' on restart.
	usageDashboardViewMode: UsageDashboardViewMode;

	// Accounts the user hid in the Usage Dashboard provider quota panels, keyed
	// by provider id ('claude-code' | 'codex'); values are canonical account
	// keys. Persisted via settings write-through (mirrors bookmarksCollapsed) and
	// hydrated by loadAllSettings on startup.
	hiddenQuotaAccounts: Record<string, string[]>;

	// Auto-refresh cadence for the Usage Dashboard provider quota panels, keyed
	// by provider id ('claude-code' | 'codex'); value is the interval in ms
	// (0 = off). Persisted via settings write-through (same as hiddenQuotaAccounts)
	// and hydrated by loadAllSettings on startup. The main-process background
	// scheduler (usage-refresh-scheduler.ts) reads the same persisted map and is
	// the sole driver of background sampling on this cadence.
	usageRefreshIntervals: Record<string, number>;
}

export interface UIStoreActions {
	// Sidebar
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleLeftSidebar: () => void;
	setLeftSidebarHidden: (hidden: boolean | ((prev: boolean) => boolean)) => void;
	cycleLeftSidebar: () => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleRightPanel: () => void;

	// Focus
	setActiveFocus: (focus: FocusArea | ((prev: FocusArea) => FocusArea)) => void;
	setActiveRightTab: (tab: RightPanelTab | ((prev: RightPanelTab) => RightPanelTab)) => void;

	// Tab tiling: set/clear the zoomed (maximized) pane id.
	setZoomedPaneId: (id: string | null) => void;

	// Tab tiling: set/clear the transient pane-rearrange drag state.
	setPaneDrag: (drag: UIStore['paneDrag']) => void;

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
	setPianolaView: (view: 'chat' | 'dashboard') => void;

	// Session sidebar selection
	setSelectedSidebarIndex: (index: number | ((prev: number) => number)) => void;
	setSidebarExtraSelection: (selection: SidebarExtraSelection | null) => void;

	/**
	 * Compatibility shim - fires a yellow center flash.
	 * New code should call `notifyCenterFlash({ message, color: 'yellow' })` directly.
	 * Passing `null` is a no-op (auto-dismiss handles clearing).
	 */
	setFlashNotification: (msg: string | null | ((prev: string | null) => string | null)) => void;
	/**
	 * Compatibility shim - fires a themed center flash.
	 * New code should call `notifyCenterFlash({ message })` directly (defaults to `theme`).
	 * Passing `null` is a no-op (auto-dismiss handles clearing).
	 */
	setSuccessFlashNotification: (
		msg: string | null | ((prev: string | null) => string | null)
	) => void;

	// Output search
	setOutputSearchOpen: (key: string, open: boolean | ((prev: boolean) => boolean)) => void;
	setOutputSearchQuery: (key: string, query: string | ((prev: string) => string)) => void;
	setOutputSearchRegex: (key: string, regex: boolean | ((prev: boolean) => boolean)) => void;
	toggleOutputSearchRegex: (key: string) => void;

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

	// Performance-profiling indicator (drives the wand animation)
	setProfilingActive: (active: boolean | ((prev: boolean) => boolean)) => void;

	// Usage Dashboard last-selected tab
	setUsageDashboardViewMode: (
		mode: UsageDashboardViewMode | ((prev: UsageDashboardViewMode) => UsageDashboardViewMode)
	) => void;

	// Toggle a provider quota account between hidden and visible.
	toggleHiddenQuotaAccount: (providerId: string, accountKey: string) => void;

	// Set the auto-refresh interval (ms; 0 = off) for a provider quota panel.
	setUsageRefreshInterval: (providerId: string, ms: number) => void;
}

export type UIStore = UIStoreState & UIStoreActions;

const DEFAULT_OUTPUT_SEARCH: OutputSearchSlot = { open: false, query: '', regex: false };

/**
 * Immutably patch one agent+tab's Find-bar slot. A closed search with an empty
 * term carries no state worth keeping, so its slot is dropped - this keeps the
 * map bounded to the handful of windows with a live find.
 */
function patchOutputSearchSlot(
	map: Record<string, OutputSearchSlot>,
	key: string,
	patch: Partial<OutputSearchSlot>
): Record<string, OutputSearchSlot> {
	const cur = map[key] ?? DEFAULT_OUTPUT_SEARCH;
	const slot: OutputSearchSlot = { ...cur, ...patch };
	const next = { ...map };
	if (!slot.open && slot.query === '') {
		delete next[key];
	} else {
		next[key] = slot;
	}
	return next;
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

/**
 * Persist the per-provider quota auto-refresh intervals so the dropdown survives
 * app restarts and the main-process background scheduler can read the cadence.
 * Hydrated back into this store on startup by `loadAllSettings` in settingsStore.
 */
function persistUsageRefreshIntervals(value: Record<string, number>): void {
	window.maestro?.settings?.set('usageRefreshIntervals', value);
}

export const useUIStore = create<UIStore>()((set) => ({
	// --- State ---
	leftSidebarOpen: true,
	leftSidebarHidden: false,
	rightPanelOpen: true,
	activeFocus: 'main',
	activeRightTab: 'files',
	zoomedPaneId: null,
	paneDrag: null,
	bookmarksCollapsed: false,
	showUnreadOnly: false,
	showUnreadAgentsOnly: false,
	preFilterActiveTabId: null,
	preTerminalFileTabId: null,
	pianolaView: 'dashboard',
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
	profilingActive: false,
	usageDashboardViewMode: 'overview',
	hiddenQuotaAccounts: {},
	usageRefreshIntervals: {},

	// --- Actions ---
	setLeftSidebarOpen: (v) =>
		set((s) => ({ leftSidebarOpen: resolveUpdater(v, s.leftSidebarOpen) })),
	toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
	setLeftSidebarHidden: (v) =>
		set((s) => ({ leftSidebarHidden: resolveUpdater(v, s.leftSidebarHidden) })),
	// Cycle: full → collapsed → hidden → full. Lets the same control walk
	// through all three states with a single click.
	cycleLeftSidebar: () =>
		set((s) => {
			if (s.leftSidebarHidden) return { leftSidebarHidden: false, leftSidebarOpen: true };
			if (s.leftSidebarOpen) return { leftSidebarOpen: false, leftSidebarHidden: false };
			return { leftSidebarOpen: false, leftSidebarHidden: true };
		}),
	setRightPanelOpen: (v) => set((s) => ({ rightPanelOpen: resolveUpdater(v, s.rightPanelOpen) })),
	toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

	setActiveFocus: (v) => set((s) => ({ activeFocus: resolveUpdater(v, s.activeFocus) })),
	setActiveRightTab: (v) => set((s) => ({ activeRightTab: resolveUpdater(v, s.activeRightTab) })),

	setZoomedPaneId: (id) => set({ zoomedPaneId: id }),
	setPaneDrag: (drag) => set({ paneDrag: drag }),

	setBookmarksCollapsed: (v) =>
		set((s) => {
			const next = resolveUpdater(v, s.bookmarksCollapsed);
			persistBookmarksCollapsed(next);
			return { bookmarksCollapsed: next };
		}),
	toggleBookmarksCollapsed: () =>
		set((s) => {
			const next = !s.bookmarksCollapsed;
			persistBookmarksCollapsed(next);
			return { bookmarksCollapsed: next };
		}),

	setShowUnreadOnly: (v) => set((s) => ({ showUnreadOnly: resolveUpdater(v, s.showUnreadOnly) })),
	toggleShowUnreadOnly: () => set((s) => ({ showUnreadOnly: !s.showUnreadOnly })),
	setShowUnreadAgentsOnly: (v) =>
		set((s) => ({ showUnreadAgentsOnly: resolveUpdater(v, s.showUnreadAgentsOnly) })),
	toggleShowUnreadAgentsOnly: () => set((s) => ({ showUnreadAgentsOnly: !s.showUnreadAgentsOnly })),
	setPreFilterActiveTabId: (id) => set({ preFilterActiveTabId: id }),
	setPreTerminalFileTabId: (id) => set({ preTerminalFileTabId: id }),
	setPianolaView: (view) => set({ pianolaView: view }),

	setSelectedSidebarIndex: (v) =>
		set((s) => ({ selectedSidebarIndex: resolveUpdater(v, s.selectedSidebarIndex) })),
	setSidebarExtraSelection: (selection) => set({ sidebarExtraSelection: selection }),

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

	setOutputSearchOpen: (key, v) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				open: resolveUpdater(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).open),
			}),
		})),
	setOutputSearchQuery: (key, v) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				query: resolveUpdater(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).query),
			}),
		})),
	setOutputSearchRegex: (key, v) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				regex: resolveUpdater(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).regex),
			}),
		})),
	toggleOutputSearchRegex: (key) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				regex: !(s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).regex,
			}),
		})),

	setSessionFilterOpen: (v) =>
		set((s) => ({ sessionFilterOpen: resolveUpdater(v, s.sessionFilterOpen) })),
	setHistorySearchFilterOpen: (v) =>
		set((s) => ({ historySearchFilterOpen: resolveUpdater(v, s.historySearchFilterOpen) })),
	setGroupChatHistorySearchFilterOpen: (v) =>
		set((s) => ({
			groupChatHistorySearchFilterOpen: resolveUpdater(v, s.groupChatHistorySearchFilterOpen),
		})),

	setDraggingSessionId: (v) =>
		set((s) => ({ draggingSessionId: resolveUpdater(v, s.draggingSessionId) })),

	setEditingGroupId: (v) => set((s) => ({ editingGroupId: resolveUpdater(v, s.editingGroupId) })),
	setEditingSessionId: (v) =>
		set((s) => ({ editingSessionId: resolveUpdater(v, s.editingSessionId) })),

	setAutoFollowEnabled: (v) =>
		set((s) => ({ autoFollowEnabled: resolveUpdater(v, s.autoFollowEnabled) })),

	setProfilingActive: (v) =>
		set((s) => ({ profilingActive: resolveUpdater(v, s.profilingActive) })),

	setUsageDashboardViewMode: (v) =>
		set((s) => ({ usageDashboardViewMode: resolveUpdater(v, s.usageDashboardViewMode) })),

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

	setUsageRefreshInterval: (providerId, ms) =>
		set((s) => {
			const nextMap = { ...s.usageRefreshIntervals, [providerId]: ms };
			persistUsageRefreshIntervals(nextMap);
			return { usageRefreshIntervals: nextMap };
		}),
}));
