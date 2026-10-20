/**
 * regionFocus - move real keyboard focus between Maestro's three regions.
 *
 * A tiling-window-manager keymap leans on "focus the pane in this direction".
 * Maestro has no split panes at that level, but it does have three regions laid
 * out as a row: the Left Bar, the Main Window, and the Right Bar. These actions
 * map the direction keys onto that row.
 *
 * Two axes, two different meanings, and the difference is the whole point:
 *
 *   LEFT / RIGHT crosses between regions. `focusRegionDirection` walks
 *   {@link REGION_ORDER} and CLAMPS at both ends - pressing "focus left" while
 *   the Left Bar already has focus does nothing, because there is nothing
 *   further left. Wrapping would throw the user across the window.
 *
 *   UP / DOWN stays inside the focused region and moves along its vertical
 *   axis, which is a different thing per region:
 *     - Main Window: the transcript (up) and the composer (down). That is the
 *       same pair the `focusInput` action already toggles between, and they sit
 *       in that order on screen.
 *     - Left Bar: the agent list selection (starred rows, agents, group chats).
 *     - Right Bar: the focused tab's list selection (the Files tree today).
 *
 * Everything reads the stores at call time rather than a render snapshot: the
 * keyboard handler, the command palette, and the menu all fire these from
 * different render trees, and a stale snapshot is the one way they could
 * disagree about which region currently has focus.
 *
 * Three pieces of existing machinery are reused rather than rebuilt:
 *
 *   1. VISIBILITY. A hidden region cannot take focus, so focusing one reveals
 *      it first - through `setLeftSidebarOpen` / `setLeftSidebarHidden` /
 *      `setRightPanelOpen`, the same setters the toggleSidebar and
 *      toggleRightPanel shortcuts write to. No parallel visibility state.
 *   2. THE MAIN WINDOW CARET. The composer is not reachable by selector (the
 *      Main Window can be showing a terminal, a browser, or a file editor
 *      instead of a chat), so the caret is requested through uiStore's one-slot
 *      `focusRequest`, which `MainPanelContent` consumes and routes per tab
 *      kind. Its retry is owned by a ref there, deliberately: consuming the
 *      request nulls the field the effect subscribes to, so a retry owned by
 *      the effect's cleanup would cancel the focus it just asked for.
 *   3. THE LIST SELECTION. Both bars already move their selection on a bare
 *      arrow key, through window-level keydown handlers gated on `activeFocus`
 *      (`handleSidebarNavigation` in useKeyboardNavigation for the Left Bar,
 *      `handleFileExplorerKeys` in useFileExplorerEffects for the Files tab).
 *      So up/down in a bar dispatches that bare arrow at the region's panel
 *      element rather than forking several hundred lines of list-order logic.
 */

import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { resolveActiveTabRef } from '../utils/panelLayout';
import type { FocusArea } from '../types';

/** One of the three regions Maestro's window is divided into, left to right. */
export type MaestroRegion = 'leftBar' | 'mainWindow' | 'rightBar';

/**
 * The regions in SCREEN order, left to right. `focusRegionDirection` walks this
 * list, so its order is the contract - not an implementation detail.
 */
export const REGION_ORDER: readonly MaestroRegion[] = ['leftBar', 'mainWindow', 'rightBar'];

/**
 * A region's root element. Both bars already carry these attributes (and
 * `tabIndex={0}`) for their own focus rings, so there is nothing new to mark up.
 */
export const LEFT_BAR_SELECTOR = '[data-panel="left"]';
export const RIGHT_BAR_SELECTOR = '[data-panel="right"]';
/**
 * The Main Window transcript. `TerminalOutput` owns this class for its prose
 * styles and gives the container `tabIndex={0}`, which is what lets it hold
 * focus and scroll under the arrow keys.
 */
export const TRANSCRIPT_SELECTOR = '.terminal-output';

/** uiStore's `activeFocus` vocabulary, which predates these actions. */
const REGION_FOCUS_AREA: Record<MaestroRegion, FocusArea> = {
	leftBar: 'sidebar',
	mainWindow: 'main',
	rightBar: 'right',
};

const FOCUS_AREA_REGION: Record<FocusArea, MaestroRegion> = {
	sidebar: 'leftBar',
	main: 'mainWindow',
	right: 'rightBar',
};

/**
 * How long to keep re-trying a region's focus, and how often. Revealing a
 * hidden Left Bar removes a `display: none` (see `[data-panel='left']
 * [data-hidden='true']` in index.css) and a closed Right Bar is zero-width, and
 * neither element can take focus until React has committed that change. One
 * fixed delay is either too early or needlessly sluggish, so poll and stop the
 * moment the element actually accepts focus.
 */
const FOCUS_RETRY_INTERVAL_MS = 16;
const FOCUS_RETRY_TIMEOUT_MS = 500;

/**
 * Cancels whatever focus attempt is still in flight. One slot, mirroring
 * uiStore's single `focusRequest`: a later region focus always supersedes an
 * earlier one, so there is a single focus owner and a single cancel chain.
 */
let cancelPendingFocus: (() => void) | null = null;

/**
 * True only for the synchronous instant `focusRegionVertical` spends inside its
 * bar arrow dispatch, so the action cannot be re-entered by the event it just
 * sent. See the comment at the top of that function for why this is not an
 * `e.isTrusted` check in the keyboard handler.
 */
let dispatchingListArrow = false;

/** Abandon any in-flight region focus. Exported for tests and teardown. */
export function cancelRegionFocus(): void {
	cancelPendingFocus?.();
	cancelPendingFocus = null;
}

/**
 * Focus the element `selector` names, reporting whether it took.
 *
 * `document.activeElement` is the check rather than a visibility probe: a
 * `display: none` element silently refuses `focus()`, and `offsetParent` - the
 * usual visibility test - is always null under jsdom, so a probe would report
 * every element unfocusable in tests and every hidden one focusable in the app.
 * Asking the document who ended up focused is true in both.
 */
function tryFocus(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.focus();
	return document.activeElement === element;
}

/**
 * Focus `selector` now, and keep re-trying on a short interval while the DOM
 * refuses - which is what a region that is still mid-reveal does.
 */
function focusWhenReady(selector: string): void {
	cancelRegionFocus();
	if (tryFocus(selector)) return;

	let elapsed = 0;
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const attempt = () => {
		if (cancelled) return;
		if (tryFocus(selector)) {
			cancelPendingFocus = null;
			return;
		}
		elapsed += FOCUS_RETRY_INTERVAL_MS;
		if (elapsed >= FOCUS_RETRY_TIMEOUT_MS) {
			cancelPendingFocus = null;
			return;
		}
		timer = setTimeout(attempt, FOCUS_RETRY_INTERVAL_MS);
	};

	timer = setTimeout(attempt, FOCUS_RETRY_INTERVAL_MS);
	cancelPendingFocus = () => {
		cancelled = true;
		if (timer) clearTimeout(timer);
	};
}

/** Which region currently holds focus, per uiStore's `activeFocus`. */
export function focusedRegion(): MaestroRegion {
	return FOCUS_AREA_REGION[useUIStore.getState().activeFocus];
}

/**
 * Put the caret in the Main Window's real input - the chat composer, or the
 * shell / address bar / editor when the active tab is not a conversation.
 *
 * Routed through uiStore's `focusRequest` because none of those elements is
 * reachable from here: the composer is a ref three components down, and the
 * browser address bar and file editor are resolved by tab id inside
 * `focusPaneInput`. Publishing the request lets `MainPanelContent` do the
 * per-kind routing it already does for new and tiled tabs.
 */
function focusMainWindowInput(): void {
	cancelRegionFocus();
	const session = selectActiveSession(useSessionStore.getState());
	const tab = session ? resolveActiveTabRef(session) : null;
	// No agent, or an agent with nothing open: `activeFocus` still moved, so the
	// arrow keys and Cmd+F now belong to the Main Window. There is simply no
	// input to put a caret in.
	if (!tab) return;
	useUIStore.getState().requestTabFocus(tab);
}

/**
 * Move real DOM focus into `region`, revealing it first when it is hidden.
 *
 * `activeFocus` is set synchronously (it is plain state and several keyboard
 * handlers are gated on it), while the DOM focus follows as soon as the element
 * can accept it.
 */
export function focusRegion(region: MaestroRegion): void {
	const ui = useUIStore.getState();

	// Reveal before focusing. A hidden Left Bar is `display: none` and a closed
	// Right Bar is zero-width; neither can hold focus, so focusing one has to
	// mean "show it and go there" rather than quietly doing nothing.
	if (region === 'leftBar') {
		if (ui.leftSidebarHidden) ui.setLeftSidebarHidden(false);
		if (!ui.leftSidebarOpen) ui.setLeftSidebarOpen(true);
	} else if (region === 'rightBar') {
		if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
	}

	ui.setActiveFocus(REGION_FOCUS_AREA[region]);

	if (region === 'mainWindow') {
		focusMainWindowInput();
		return;
	}
	focusWhenReady(region === 'leftBar' ? LEFT_BAR_SELECTOR : RIGHT_BAR_SELECTOR);
}

/**
 * Cross to the region one step left or right of the focused one.
 *
 * Clamps rather than wraps: the regions are a row on screen, so "focus left"
 * from the Left Bar is a request to go somewhere that does not exist, and the
 * honest answer is to stay put. Wrapping would jump the user from one edge of
 * the window to the other on a key they pressed to move one step.
 */
export function focusRegionDirection(direction: 'left' | 'right'): void {
	const index = REGION_ORDER.indexOf(focusedRegion());
	const next = direction === 'left' ? index - 1 : index + 1;
	if (next < 0 || next >= REGION_ORDER.length) return;
	focusRegion(REGION_ORDER[next]);
}

/**
 * Move along the vertical axis INSIDE the focused region (see the file header
 * for the full mapping): transcript / composer in the Main Window, list
 * selection in either bar.
 */
export function focusRegionVertical(direction: 'up' | 'down'): void {
	// Re-entrancy guard for the bar arrow dispatch at the bottom of this
	// function. That event bubbles to the window, where `useMainKeyboardHandler`
	// is listening - so a user who binds `focusRegionUp` to a bare ArrowUp has
	// this action match its own echo, and without the guard it would recurse
	// until the stack ran out. The flag works because `dispatchEvent` is
	// synchronous: the echo arrives inside the try block, never after it.
	//
	// The guard lives here rather than as an `e.isTrusted` check in the keyboard
	// handler because trust does not answer the question. XTerminal's passthrough
	// and the browser webview's forwarded input both re-dispatch REAL presses to
	// the window as synthetic events, so an untrusted keydown is routinely a key
	// the user actually pressed.
	if (dispatchingListArrow) return;

	const region = focusedRegion();

	if (region === 'mainWindow') {
		// The transcript sits above the composer, so up reaches the conversation
		// and down reaches the place you type. Same pair `focusInput` toggles.
		if (direction === 'up') {
			focusWhenReady(TRANSCRIPT_SELECTOR);
			return;
		}
		focusMainWindowInput();
		return;
	}

	// Both bars already own this behavior on a bare arrow key, in window-level
	// handlers gated on `activeFocus`. Dispatching that arrow at the region's
	// panel element reuses the one implementation of each list's order - the
	// Left Bar's virtual order (starred rows, agents with collapsed-section
	// expansion, group chats) and the Files tree's flat list - instead of
	// forking them here, where they would immediately drift.
	//
	// The panel element is the target rather than `document.activeElement` on
	// purpose: when the caret sits in a bar's filter input, a bare arrow is the
	// caret's to keep, but this ACTION is an explicit request to move the
	// selection, and both handlers skip events whose target is a text field.
	const selector = region === 'leftBar' ? LEFT_BAR_SELECTOR : RIGHT_BAR_SELECTOR;
	const panel = document.querySelector<HTMLElement>(selector);
	if (!panel) return;
	const key = direction === 'up' ? 'ArrowUp' : 'ArrowDown';
	dispatchingListArrow = true;
	try {
		panel.dispatchEvent(
			new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })
		);
	} finally {
		dispatchingListArrow = false;
	}
}
