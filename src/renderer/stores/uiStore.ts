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
import type { FocusArea, RightPanelTab, UnifiedTabRef, UsageDashboardViewMode } from '../types';
import { notifyCenterFlash } from './centerFlashStore';
import { isNarrowViewportNow } from '../hooks/ui/useViewportBreakpoint';
import { SEQUENCE_TIMEOUT_MS } from '../utils/shortcutSequence';

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

/**
 * A request to scroll a specific transcript entry into view and flash it.
 * Set by cross-tab message search (Opt+Cmd+F) after it switches tabs; consumed
 * by the TerminalOutput instance whose agent+tab match, which clears it.
 */
export interface PendingLogJump {
	sessionId: string;
	tabId: string;
	logId: string;
}

/**
 * The exact visibility of both bars at the moment zen mode was entered, so
 * leaving restores what the user had rather than what zen assumes they had.
 *
 * All THREE flags, not two: the Left Bar is a tri-state, so a user who was
 * sitting in the collapsed status-dot strip (`!hidden && !open`) has to land
 * back in the strip and not in the full panel.
 */
export interface ZenLayoutSnapshot {
	leftSidebarOpen: boolean;
	leftSidebarHidden: boolean;
	rightPanelOpen: boolean;
}

export interface UIStoreState {
	// Sidebar - tri-state via two booleans: !hidden && open = full panel,
	// !hidden && !open = collapsed status-dot strip, hidden = no panel at all.
	leftSidebarOpen: boolean;
	leftSidebarHidden: boolean;
	rightPanelOpen: boolean;

	// Zen mode: both bars put away so the Main Window has the whole window.
	// Transient (not persisted) - zen is a posture for the next few minutes of
	// reading, not a layout someone should find themselves still in after a
	// restart with no memory of how they got there.
	zenMode: boolean;
	/**
	 * What the bars looked like before zen, restored verbatim on the way out.
	 * null whenever `zenMode` is false. See {@link ZenLayoutSnapshot}.
	 */
	preZenLayout: ZenLayoutSnapshot | null;

	/**
	 * DECK MODE: whether the leader chord has armed the one-shot mode.
	 *
	 * True only between the leader chord and the next keystroke. While it is
	 * true, a single bare key is matched against `DECK_MODE_KEYS` alone (see
	 * `constants/deckMode.ts`), fires that action, and the mode ends - so this
	 * flag is the one thing that decides whether the next `j` moves the focus
	 * ring or gets typed into the composer. It is also what the hint bar's
	 * visibility is keyed on.
	 *
	 * Transient by nature rather than by policy: nothing may observe it for
	 * longer than {@link SEQUENCE_TIMEOUT_MS}, so there is nothing here to
	 * persist and no startup state to hydrate.
	 */
	deckModeArmed: boolean;
	/**
	 * `Date.now()` at the moment the leader armed the mode, or 0 when disarmed.
	 *
	 * The timeout is LAZY, exactly as the sequence matcher's is: this timestamp
	 * is compared against the clock when the armed state is next READ
	 * ({@link deckModeArmedNow}) rather than expired by a `setTimeout`. No timer
	 * means the store owns no DOM globals, has nothing to cancel, and cannot
	 * fire a callback into a torn-down renderer - and the answer is correct
	 * whenever it is asked, which is the only moment that matters for a mode
	 * whose entire job is to interpret one keypress.
	 *
	 * A caller that PAINTS the armed state (the hint bar) needs a repaint when
	 * the window lapses with no keypress at all, so it owns its own timer, the
	 * same division of labour as `SequencePrefixIndicator` and the prefix chip.
	 */
	deckModeArmedAt: number;

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

	// One-shot request to move DOM FOCUS into a tab's real input (the caret into
	// its terminal / editor / address bar / chat box), consumed and cleared by
	// MainPanelContent. Addressed EITHER by tiled pane leaf id or by tab ref, since
	// both routes end at the same place: a keyboard pane command knows the leaf it
	// moved to, while a plain "new tab" handler only ever knows the tab it minted.
	// One request slot rather than two so there is a single focus owner and a
	// single cancel chain - a later request always supersedes an earlier one.
	//
	// Fired ONLY by explicit create/move commands - moving the focus ring alone
	// leaves the user typing into whatever had focus before.
	//
	// Deliberately a request rather than an effect keyed on `focusedPaneId`: a mouse
	// press anywhere in a pane also moves `focusedPaneId`, so a derived effect would
	// yank the caret into the AI input mid-drag and break text selection in the
	// conversation. Keeping it explicit ties the steal to user intent.
	focusRequest: { leafId: string } | { tab: UnifiedTabRef } | null;

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

	// Pending "jump to this message" request from cross-tab search. Null when no
	// jump is in flight; the target transcript clears it once it has scrolled.
	pendingLogJump: PendingLogJump | null;

	// Session filter (sidebar agent search)
	sessionFilterOpen: boolean;
	/**
	 * The sidebar's filter text. Shared rather than local to the filter hook,
	 * because Cmd+[ / Cmd+] has to cycle exactly the rows the sidebar is drawing
	 * and a `useState` inside the hook gives every caller its own copy - the
	 * cycle could not see the filter at all, so it walked agents that were not
	 * on screen.
	 */
	sessionFilter: string;
	/**
	 * Whether archived group chats are shown. Same reason as `sessionFilter`:
	 * membership of the drawn list is a shared question, not a private one.
	 */
	showArchivedGroupChats: boolean;

	// History panel search
	historySearchFilterOpen: boolean;

	// Group chat history panel search
	groupChatHistorySearchFilterOpen: boolean;

	// Drag and drop (session dragging in sidebar)
	draggingSessionId: string | null;

	// Editing (inline renaming in sidebar)
	editingGroupId: string | null;
	editingSessionId: string | null;

	// Queued message currently open in the edit modal (QueuedItemEditModal), or
	// null when it is closed. Lives here rather than inside QueuedItemsList so
	// the "Edit Last Queued Message" shortcut can open the modal from anywhere -
	// the list itself is buried in the transcript scroll area.
	editingQueuedItemId: string | null;

	// Auto-follow active task during batch runs
	autoFollowEnabled: boolean;

	// Whether a performance-profiling recording is active. Drives the animated
	// wand indicator in the Left Bar header. Source of truth is the main process
	// (contentTracing singleton); the command palette reconciles this on open.
	profilingActive: boolean;

	// Trace-buffer usage of the active recording, 0-1. Chromium drops events once
	// the buffer fills, so this - not elapsed time - is what limits a capture, and
	// showing it is what lets a user see how much window they have left instead of
	// guessing. Refreshed whenever the palette reconciles profiling status.
	profilingBufferPercent: number;

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

	// Namespaced ids (`<pluginId>/<panelId>`) of docked plugin panels the user
	// collapsed to the reopen rail (PluginPanelSlot). Dock-only affordance; the
	// frame's non-suppressible provenance line is untouched. Persisted via
	// settings write-through (mirrors hiddenQuotaAccounts) and hydrated by
	// loadAllSettings on startup.
	hiddenPluginPanels: string[];

	// Namespaced id (`<pluginId>/<panelId>`) of the ONE `modal`-placement plugin
	// panel currently open, or null. Deliberately global rather than local to
	// Settings: the same mount serves the Settings -> Encore -> Plugins launch
	// path and a plugin summoning its own panel via `ui.openPanel`/`togglePanel`,
	// so the two can never fight over the panel's webview guest. Transient (not
	// persisted) - a summoned overlay should not survive a restart.
	openPluginPanelId: string | null;
}

export interface UIStoreActions {
	// Sidebar
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleLeftSidebar: () => void;
	setLeftSidebarHidden: (hidden: boolean | ((prev: boolean) => boolean)) => void;
	cycleLeftSidebar: () => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleRightPanel: () => void;
	/**
	 * Put both bars away and give the whole window to the Main Window; press
	 * again to put them back exactly as they were. Returns whether zen is now ON.
	 *
	 * The restore reads a SNAPSHOT taken on entry rather than assuming both bars
	 * were open: someone who already works with the Right Bar closed must not
	 * find it open after a round trip through zen, and someone parked in the
	 * Left Bar's collapsed strip must land back in the strip.
	 *
	 * Nothing is destroyed on either leg. This writes three visibility booleans
	 * and nothing else - no tab is closed, no transcript dropped, no panel state
	 * reset - so the way out is as cheap as the way in.
	 *
	 * Entering fires a center flash naming the way out, because zen removes the
	 * two bars the user would otherwise click to undo it, and the action ships
	 * unassigned: without the flash, a user who reached it from the palette has
	 * no visible route back. See {@link setZenExitChordResolver} for how the
	 * chord half of that message is resolved.
	 */
	toggleZenMode: () => boolean;
	/**
	 * Narrow viewports: the left drawer covers the main panel, so activating
	 * anything listed in it - an agent row, a group chat, a starred session - is
	 * a request to LOOK at that thing, and the drawer gets out of the way. No-op
	 * on a wide viewport, where the Left Bar is a permanent column beside the
	 * panel and closing it would be a surprise.
	 *
	 * Call it AT THE TAP rather than from an effect keyed on what became active:
	 * tapping the row that is already active (an agent still selected behind an
	 * open group chat, the chat the user is already in) changes no state at all,
	 * and a transition-keyed effect reads that as nothing having happened -
	 * leaving the user staring at the drawer they just tapped through.
	 */
	closeLeftSidebarForNavigation: () => void;
	/**
	 * The right drawer's half of the same rule, and it fails the same way.
	 * Opening a file from the Files panel is a request to LOOK at that file, and
	 * on a phone the drawer covers the whole screen - so it gets out of the way.
	 *
	 * Call it AT THE OPEN, for the same reason as its left-hand twin: the
	 * transition-keyed effect in `App.tsx` watches `activeFileTabId` and friends,
	 * and re-previewing the file that is ALREADY the active tab moves none of
	 * them. The effect reads that as nothing having happened, so the file the
	 * user just tapped Preview on stays behind the tree they tapped it in.
	 * Media is the permanent case: it never becomes a tab at all, so that key
	 * can never change for it.
	 */
	closeRightPanelForNavigation: () => void;

	/**
	 * Arm Deck mode: the leader chord was pressed, so the NEXT bare key belongs
	 * to the Deck table rather than to whatever has focus.
	 *
	 * Re-arming while already armed is legal and restarts the clock. The leader
	 * is a chord, so pressing it again is a deliberate "I meant it" rather than
	 * a stray key, and refreshing the window is kinder than either ignoring it
	 * or treating it as the miss that disarms.
	 *
	 * Arming also installs a window-blur guard, removed again by
	 * {@link UIStoreActions.disarmDeckMode}. See `armDeckMode` in the store body
	 * for why that guard lives here and not in a component.
	 */
	armDeckMode: () => void;
	/**
	 * End Deck mode, from any of the five routes that end it: a key matched and
	 * fired, a key missed, Escape, the timeout lapsing, the window losing focus,
	 * or `keyboardMode` changing under it.
	 *
	 * Idempotent, and a no-op disarm returns the SAME state object so the hint
	 * bar does not re-render on the Escape presses that were only ever meant for
	 * the layer stack.
	 */
	disarmDeckMode: () => void;

	// Focus
	setActiveFocus: (focus: FocusArea | ((prev: FocusArea) => FocusArea)) => void;
	setActiveRightTab: (tab: RightPanelTab | ((prev: RightPanelTab) => RightPanelTab)) => void;

	// Tab tiling: set/clear the zoomed (maximized) pane id.
	setZoomedPaneId: (id: string | null) => void;

	// Tab tiling: set/clear the transient pane-rearrange drag state.
	setPaneDrag: (drag: UIStore['paneDrag']) => void;

	// Ask the panel to put DOM focus inside a pane (by tiled leaf id) or a tab (by
	// ref), and clear that request once it has been acted on.
	requestPaneFocus: (leafId: string) => void;
	requestTabFocus: (tab: UnifiedTabRef) => void;
	clearFocusRequest: () => void;

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

	// Cross-tab search jump target
	setPendingLogJump: (jump: PendingLogJump | null) => void;
	/** Clear only if the pending jump still points at this exact entry. */
	clearPendingLogJump: (logId: string) => void;

	// Session filter (sidebar agent search)
	setSessionFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setSessionFilter: (value: string | ((prev: string) => string)) => void;
	setShowArchivedGroupChats: (show: boolean | ((prev: boolean) => boolean)) => void;

	// History panel search
	setHistorySearchFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Group chat history panel search
	setGroupChatHistorySearchFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Drag and drop
	setDraggingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;

	// Editing
	setEditingGroupId: (id: string | null | ((prev: string | null) => string | null)) => void;
	setEditingSessionId: (id: string | null | ((prev: string | null) => string | null)) => void;
	setEditingQueuedItemId: (id: string | null) => void;

	// Auto-follow
	setAutoFollowEnabled: (enabled: boolean | ((prev: boolean) => boolean)) => void;

	// Performance-profiling indicator (drives the wand animation)
	setProfilingActive: (active: boolean | ((prev: boolean) => boolean)) => void;
	setProfilingBufferPercent: (percent: number) => void;

	// Usage Dashboard last-selected tab
	setUsageDashboardViewMode: (
		mode: UsageDashboardViewMode | ((prev: UsageDashboardViewMode) => UsageDashboardViewMode)
	) => void;

	// Toggle a provider quota account between hidden and visible.
	toggleHiddenQuotaAccount: (providerId: string, accountKey: string) => void;

	// Set the auto-refresh interval (ms; 0 = off) for a provider quota panel.
	setUsageRefreshInterval: (providerId: string, ms: number) => void;

	// Toggle a docked plugin panel between shown and collapsed (reopen rail).
	toggleHiddenPluginPanel: (panelId: string) => void;

	/** Open (or, with null, close) the single modal plugin-panel mount. */
	setOpenPluginPanelId: (panelId: string | null) => void;
	/** Open the panel, or close it if that same panel is already open. */
	toggleOpenPluginPanelId: (panelId: string) => void;
}

export type UIStore = UIStoreState & UIStoreActions;

/**
 * Helper to resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

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

/**
 * Persist the collapsed docked-plugin-panel id list so a user's hide choice
 * survives app restarts. Hydrated back into this store on startup by
 * loadAllSettings in settingsStore.
 */
function persistHiddenPluginPanels(value: string[]): void {
	window.maestro?.settings?.set('hiddenPluginPanels', value);
}

/**
 * What zen mode's flash says when no chord is bound to `toggleZenMode`, which
 * is how it ships. Names the palette by the label the action carries in
 * `DEFAULT_SHORTCUTS`, so searching Quick Actions for the words in the flash
 * finds the entry that turns it back off.
 */
const ZEN_EXIT_HINT_UNBOUND = 'To exit, run Toggle Zen Mode again from Quick Actions';

/**
 * Resolves the chord currently bound to `toggleZenMode`, formatted for display,
 * or null when the action is unbound in the live keyboard mode.
 */
export type ZenExitChordResolver = () => string | null;

let resolveZenExitChord: ZenExitChordResolver = () => null;

/**
 * Teach this store how to name the chord that leaves zen mode.
 *
 * A seam rather than an import because the bindings live in settingsStore, and
 * settingsStore already imports THIS module. Importing it back would make the
 * single most widely imported store in the renderer drag the whole settings
 * module graph into every test and every bundle chunk that touches a sidebar
 * flag, to resolve one hint string. The resolver is installed once from
 * settingsStore, which is where the live binding map already is.
 *
 * The default answers null, so an uninstalled resolver degrades to naming Quick
 * Actions - true for every user who has not bound a chord, and the shipped
 * state of the action either way.
 */
export function setZenExitChordResolver(resolver: ZenExitChordResolver): void {
	resolveZenExitChord = resolver;
}

/** The flash detail line for entering zen: the chord out, or the palette route. */
function zenExitHint(): string {
	const chord = resolveZenExitChord();
	return chord ? `Press ${chord} to exit` : ZEN_EXIT_HINT_UNBOUND;
}

/**
 * Whether an armed-at timestamp has aged out of the Deck window.
 *
 * Pure, and exported so the hint bar can set its own hide timer off the same
 * arithmetic the handler disarms on, rather than re-deriving the deadline.
 * `armedAt` of 0 (never armed) reads as expired, which is the honest answer and
 * keeps callers from needing a second null check.
 */
export function deckModeExpired(armedAt: number, now: number = Date.now()): boolean {
	return armedAt === 0 || now - armedAt > SEQUENCE_TIMEOUT_MS;
}

/**
 * Is Deck mode armed RIGHT NOW, with the timeout applied?
 *
 * This is the question the keyboard handler asks before it matches a key
 * against the Deck table, and it is deliberately not the raw `deckModeArmed`
 * flag: an armed mode nobody followed up on has to stop swallowing keys on its
 * own, whether or not anything was painting it. An expired window is disarmed
 * here as a side effect, so the state the hint bar reads agrees with the answer
 * the handler acted on.
 *
 * Reuses `SEQUENCE_TIMEOUT_MS` rather than inventing a Deck-specific figure:
 * both are "how long does a half-finished keyboard idea stay live", and the
 * constraints are identical (long enough to reach the second key without
 * hurrying, short enough that a forgotten prefix cannot swallow a keypress the
 * user has stopped connecting to it). One number also means one thing for the
 * user to learn and Settings has one figure to quote.
 */
export function deckModeArmedNow(): boolean {
	const { deckModeArmed, deckModeArmedAt, disarmDeckMode } = useUIStore.getState();
	if (!deckModeArmed) return false;
	if (!deckModeExpired(deckModeArmedAt)) return true;
	disarmDeckMode();
	return false;
}

/**
 * Deck mode's window-blur guard, installed only while the mode is armed.
 *
 * An armed mode that survives the user switching apps is a trap: the keystroke
 * that lands when they come back was meant for whatever they were doing, and
 * firing `closeTab` off it is both surprising and destructive. The lazy timeout
 * would have expired the window a second later anyway, but a second is long
 * enough to Cmd+Tab away and back.
 *
 * It lives in the store rather than in a `useEffect` because the guard must not
 * depend on anything being mounted. The hint bar is the only component that
 * renders for Deck mode and it renders only WHILE armed, so an effect there
 * would be installed and torn down on exactly the state it is meant to police -
 * and any later caller that arms the mode without the bar on screen would have
 * no guard at all.
 *
 * Installed on arm and removed on disarm, so the listener's lifetime is exactly
 * the armed state's: nothing is attached in the 99.9% of a session when Deck
 * mode is idle, and there is no permanent listener to leak.
 */
let deckBlurGuardInstalled = false;

function handleDeckModeWindowBlur(): void {
	useUIStore.getState().disarmDeckMode();
}

function installDeckBlurGuard(): void {
	if (deckBlurGuardInstalled || typeof window === 'undefined') return;
	window.addEventListener('blur', handleDeckModeWindowBlur);
	deckBlurGuardInstalled = true;
}

function removeDeckBlurGuard(): void {
	if (!deckBlurGuardInstalled || typeof window === 'undefined') return;
	window.removeEventListener('blur', handleDeckModeWindowBlur);
	deckBlurGuardInstalled = false;
}

export const useUIStore = create<UIStore>()((set) => ({
	// --- State ---
	leftSidebarOpen: true,
	leftSidebarHidden: false,
	rightPanelOpen: true,
	zenMode: false,
	preZenLayout: null,
	deckModeArmed: false,
	deckModeArmedAt: 0,
	activeFocus: 'main',
	activeRightTab: 'files',
	zoomedPaneId: null,
	paneDrag: null,
	focusRequest: null,
	bookmarksCollapsed: false,
	showUnreadOnly: false,
	showUnreadAgentsOnly: false,
	preFilterActiveTabId: null,
	preTerminalFileTabId: null,
	pianolaView: 'dashboard',
	selectedSidebarIndex: 0,
	sidebarExtraSelection: null,
	outputSearchByKey: {},
	pendingLogJump: null,
	sessionFilterOpen: false,
	sessionFilter: '',
	showArchivedGroupChats: false,
	historySearchFilterOpen: false,
	groupChatHistorySearchFilterOpen: false,
	draggingSessionId: null,
	editingGroupId: null,
	editingSessionId: null,
	editingQueuedItemId: null,
	autoFollowEnabled: false,
	profilingActive: false,
	profilingBufferPercent: 0,
	usageDashboardViewMode: 'overview',
	hiddenQuotaAccounts: {},
	usageRefreshIntervals: {},
	hiddenPluginPanels: [],
	openPluginPanelId: null,

	// --- Actions ---
	setLeftSidebarOpen: (v) => set((s) => ({ leftSidebarOpen: resolve(v, s.leftSidebarOpen) })),
	toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
	setLeftSidebarHidden: (v) => set((s) => ({ leftSidebarHidden: resolve(v, s.leftSidebarHidden) })),
	// Cycle: full → collapsed → hidden → full. Lets the same control walk
	// through all three states with a single click.
	cycleLeftSidebar: () =>
		set((s) => {
			if (s.leftSidebarHidden) return { leftSidebarHidden: false, leftSidebarOpen: true };
			if (s.leftSidebarOpen) return { leftSidebarOpen: false, leftSidebarHidden: false };
			return { leftSidebarOpen: false, leftSidebarHidden: true };
		}),
	setRightPanelOpen: (v) => set((s) => ({ rightPanelOpen: resolve(v, s.rightPanelOpen) })),
	toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
	toggleZenMode: () => {
		let entered = false;
		set((s) => {
			if (s.zenMode) {
				// Leaving: replay the snapshot. Spread LAST so it wins over nothing
				// and reads as "these three fields go back to what they were". A
				// missing snapshot (only reachable if something set `zenMode` behind
				// this action's back) leaves the bars exactly where they are rather
				// than guessing a layout the user never had.
				return { zenMode: false, preZenLayout: null, ...(s.preZenLayout ?? {}) };
			}
			entered = true;
			return {
				zenMode: true,
				preZenLayout: {
					leftSidebarOpen: s.leftSidebarOpen,
					leftSidebarHidden: s.leftSidebarHidden,
					rightPanelOpen: s.rightPanelOpen,
				},
				// `hidden`, not merely `!open`: the collapsed Left Bar is still a
				// 64px strip of status dots, and zen is the state where the Main
				// Window has the window.
				leftSidebarOpen: false,
				leftSidebarHidden: true,
				rightPanelOpen: false,
			};
		});
		// Outside the updater: `set` can be called more than once for one commit,
		// and a flash fired from inside it would be a side effect in a reducer.
		if (entered) notifyCenterFlash({ message: 'Zen Mode', detail: zenExitHint() });
		return entered;
	},
	closeLeftSidebarForNavigation: () =>
		set((s) => (s.leftSidebarOpen && isNarrowViewportNow() ? { leftSidebarOpen: false } : s)),
	closeRightPanelForNavigation: () =>
		set((s) => (s.rightPanelOpen && isNarrowViewportNow() ? { rightPanelOpen: false } : s)),

	armDeckMode: () => {
		// Outside the updater, for the same reason zen's flash is: attaching a
		// listener is a side effect, and zustand may call an updater more than
		// once for one commit. The install is idempotent regardless.
		installDeckBlurGuard();
		set({ deckModeArmed: true, deckModeArmedAt: Date.now() });
	},
	disarmDeckMode: () => {
		removeDeckBlurGuard();
		set((s) =>
			s.deckModeArmed || s.deckModeArmedAt !== 0 ? { deckModeArmed: false, deckModeArmedAt: 0 } : s
		);
	},

	setActiveFocus: (v) => set((s) => ({ activeFocus: resolve(v, s.activeFocus) })),
	setActiveRightTab: (v) => set((s) => ({ activeRightTab: resolve(v, s.activeRightTab) })),

	setZoomedPaneId: (id) => set({ zoomedPaneId: id }),
	setPaneDrag: (drag) => set({ paneDrag: drag }),

	requestPaneFocus: (leafId) => set({ focusRequest: { leafId } }),
	requestTabFocus: (tab) => set({ focusRequest: { tab } }),
	clearFocusRequest: () => set({ focusRequest: null }),

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
	setPianolaView: (view) => set({ pianolaView: view }),

	setSelectedSidebarIndex: (v) =>
		set((s) => ({ selectedSidebarIndex: resolve(v, s.selectedSidebarIndex) })),
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
				open: resolve(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).open),
			}),
		})),
	setOutputSearchQuery: (key, v) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				query: resolve(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).query),
			}),
		})),
	setOutputSearchRegex: (key, v) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				regex: resolve(v, (s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).regex),
			}),
		})),
	toggleOutputSearchRegex: (key) =>
		set((s) => ({
			outputSearchByKey: patchOutputSearchSlot(s.outputSearchByKey, key, {
				regex: !(s.outputSearchByKey[key] ?? DEFAULT_OUTPUT_SEARCH).regex,
			}),
		})),

	setPendingLogJump: (jump) => set({ pendingLogJump: jump }),
	// Guarded so a stale consumer can't wipe a newer jump the user just queued.
	clearPendingLogJump: (logId) =>
		set((s) => (s.pendingLogJump?.logId === logId ? { pendingLogJump: null } : s)),

	setSessionFilterOpen: (v) => set((s) => ({ sessionFilterOpen: resolve(v, s.sessionFilterOpen) })),
	setSessionFilter: (v) => set((s) => ({ sessionFilter: resolve(v, s.sessionFilter) })),
	setShowArchivedGroupChats: (v) =>
		set((s) => ({ showArchivedGroupChats: resolve(v, s.showArchivedGroupChats) })),
	setHistorySearchFilterOpen: (v) =>
		set((s) => ({ historySearchFilterOpen: resolve(v, s.historySearchFilterOpen) })),
	setGroupChatHistorySearchFilterOpen: (v) =>
		set((s) => ({
			groupChatHistorySearchFilterOpen: resolve(v, s.groupChatHistorySearchFilterOpen),
		})),

	setDraggingSessionId: (v) => set((s) => ({ draggingSessionId: resolve(v, s.draggingSessionId) })),

	setEditingGroupId: (v) => set((s) => ({ editingGroupId: resolve(v, s.editingGroupId) })),
	setEditingSessionId: (v) => set((s) => ({ editingSessionId: resolve(v, s.editingSessionId) })),
	setEditingQueuedItemId: (id) => set({ editingQueuedItemId: id }),

	setAutoFollowEnabled: (v) => set((s) => ({ autoFollowEnabled: resolve(v, s.autoFollowEnabled) })),

	setProfilingActive: (v) => set((s) => ({ profilingActive: resolve(v, s.profilingActive) })),
	setProfilingBufferPercent: (percent) => set({ profilingBufferPercent: percent }),

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

	setUsageRefreshInterval: (providerId, ms) =>
		set((s) => {
			const nextMap = { ...s.usageRefreshIntervals, [providerId]: ms };
			persistUsageRefreshIntervals(nextMap);
			return { usageRefreshIntervals: nextMap };
		}),

	toggleHiddenPluginPanel: (panelId) =>
		set((s) => {
			const next = s.hiddenPluginPanels.includes(panelId)
				? s.hiddenPluginPanels.filter((id) => id !== panelId)
				: [...s.hiddenPluginPanels, panelId];
			persistHiddenPluginPanels(next);
			return { hiddenPluginPanels: next };
		}),

	setOpenPluginPanelId: (panelId) => set({ openPluginPanelId: panelId }),

	// Toggle by namespaced id: open it, or close it if that exact panel is already
	// the open one. A DIFFERENT panel being open swaps to the requested one rather
	// than closing, since only one modal panel mount exists.
	toggleOpenPluginPanelId: (panelId) =>
		set((s) => ({ openPluginPanelId: s.openPluginPanelId === panelId ? null : panelId })),
}));
