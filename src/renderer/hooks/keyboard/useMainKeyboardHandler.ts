import { useEffect, useRef, useState } from 'react';
import type { Session, AITab } from '../../types';
import {
	cycleShowThinkingFields,
	moveActiveUnifiedTabByOne,
	moveActiveUnifiedTabToEdge,
	toggleReadOnlyModeFields,
} from '../../utils/tabHelpers';
import {
	resolveActiveTabRef,
	resolveModelEffortTabId,
	resolveTabRefRenameValue,
} from '../../utils/panelLayout';
import { DESTINATION_SHORTCUT_IDS, getModalActions, useModalStore } from '../../stores/modalStore';
import { toggleAllCadenzas } from '../../stores/cadenzaStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { reopenDesktopTabIfNeeded } from '../../services/desktopTabClose';
import { requestEditLastQueuedMessage } from '../../services/editQueuedMessage';
import { requestOpenStagedImagesOrganizer } from '../../services/stagedImagesOrganizer';
import { toggleAllUnreadFilters } from '../../services/unreadFilters';
import { toggleInAppToasts } from '../../services/inAppToasts';
import { keyboardModeToggleShadow, switchKeyboardMode } from '../../services/keyboardMode';
import { focusRegionDirection, focusRegionVertical } from '../../services/regionFocus';
import { growFocusedRegion, shrinkFocusedRegion } from '../../services/regionResize';
import { requestSidebarReveal } from '../../utils/sidebarReveal';
import { getGitShortcutActions } from '../../services/gitShortcutActions';
import { useNotificationStore } from '../../stores/notificationStore';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { stepMediaItem } from '../../utils/mediaItems';
import { resolveSnoozeTarget } from '../../utils/snoozeHelpers';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { FONT_ZOOM_DEFAULT, FONT_ZOOM_STEP, clampFontZoom } from '../../../shared/typography';
import { deckModeArmedNow, useUIStore } from '../../stores/uiStore';
import { groupChatOutputSearchKey, isActiveOutputSearchOpen } from '../../utils/outputSearch';
import { toggleGroupChatRightTab } from '../../utils/groupChatRightTab';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../ui/useOutputSearchLayer';
import { tileNewTabInSession } from '../../services/tileNewTabAction';
import type { TileableTabKind } from '../tabs/tileNewTab';
import { isMacOSKeyboard } from '../../utils/platformUtils';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { createSequenceMatcher, type SequenceBinding } from '../../utils/shortcutSequence';
import { publishSequencePrefix } from '../../stores/sequencePrefixStore';
import { isNormalMode } from '../../utils/messageScrollNavigation';
import {
	applyInsertEscape,
	insertEscapeTarget,
	type InsertEscapeBinding,
	type InsertEscapeField,
} from '../../utils/vimInsertEscape';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import {
	DECK_MODE_LEADER_ID,
	findDeckModeAction,
	isDeckModeCancelKey,
} from '../../constants/deckMode';
import { editClipboardImage } from '../../components/ImageAnnotator/editClipboardImage';
import { FORCED_PARALLEL_SEND_EVENT } from '../input/useInputKeyDown';
import { requestSteerSend } from '../../services/chatSteering';
import { isWebDesktop } from '../../utils/runtimeContext';
import { canOpenComputerHistory } from '../../utils/computerHistoryAvailability';
import { noteDesktopAiTabSelection } from '../../utils/desktopTabSelectionSync';

/**
 * Open the floating media player on whatever it should be showing.
 *
 * The store owns the reasoning, so this key and the palette command cannot
 * disagree about what "open the player" means. Read at press time, so a queue
 * that advanced since the last render cannot strand the shortcut on a finished
 * file.
 */
function openMediaPlayerFromShortcut(): void {
	useMediaPlaybackStore.getState().openPlayer();
}

/**
 * Step the queue by one, the same way MediaPlaybackHost's own transport does.
 * No-op when there is nothing loaded - stepping from nowhere has no meaning.
 */
function stepMediaFromShortcut(direction: 1 | -1): void {
	const state = useMediaPlaybackStore.getState();
	if (!state.activeItemId) return;
	const next = stepMediaItem(state.items, state.activeItemId, direction);
	if (next) state.setActiveItem(next.id, { autoplay: true });
}

// Font zoom keyboard shortcut constants live in src/shared/typography.ts

/**
 * Context object passed to the main keyboard handler via ref.
 * Uses 'any' type to avoid complex type dependencies on App.tsx internals.
 * The actual shape matches what App.tsx assigns to keyboardHandlerRef.current.
 *
 * Key properties include:
 * - isShortcut, isTabShortcut: Shortcut matching functions
 * - sessions length / active Session (via getState at event time), activeSessionId: Session state
 * - activeFocus, activeRightTab: UI focus state
 * - Various modal open states (quickActionOpen, settingsModalOpen, etc.)
 * - hasOpenLayers, hasOpenModal: Layer stack functions
 * - State setters (setLeftSidebarOpen, setSessions, etc.)
 * - Handler functions (addNewSession, deleteSession, cycleSession, etc.)
 * - Tab management (createTab, closeTab, navigateToNextTab, etc.)
 * - Navigation handlers (handleSidebarNavigation, handleTabNavigation, etc.)
 * - Refs (logsEndRef, inputRef, terminalOutputRef)
 * - recordShortcutUsage: Track shortcut usage for keyboard mastery gamification
 * - onKeyboardMasteryLevelUp: Callback when user levels up in keyboard mastery
 */

/** Delay (ms) to allow React re-render before focusing the input element. */
const FOCUS_AFTER_RENDER_DELAY_MS = 50;

/**
 * The "Tile New ... Below" shortcut family, paired with the tab kind each one
 * creates. All four ship on Ctrl+Cmd (T / J / B / F), the same namespace as the
 * pane commands, so they are matched with `isPaneShortcut` rather than
 * `isShortcut` - the general matcher folds Meta and Ctrl into one modifier and
 * would fire these on a plain Cmd+T. Keeping them in one table means adding a
 * tileable kind is a single line here rather than a fourth branch in the
 * keydown chain.
 */
const TILE_SHORTCUTS: ReadonlyArray<{ shortcutId: string; kind: TileableTabKind }> = [
	{ shortcutId: 'tileTerminalBelow', kind: 'terminal' },
	{ shortcutId: 'tileAiBelow', kind: 'ai' },
	{ shortcutId: 'tileBrowserBelow', kind: 'browser' },
	{ shortcutId: 'tileFileBelow', kind: 'file' },
];

/**
 * Stable empty list, for a context that carries no sequence bindings.
 *
 * `KeyboardHandlerContext` is `any`, so nothing type-checks that a caller sets
 * the field: App does, and the hand-built contexts in the test suite do not.
 */
const NO_SEQUENCE_BINDINGS: readonly SequenceBinding[] = [];

export type KeyboardHandlerContext = any;

/**
 * A view of the keyboard context whose shortcut matchers answer about ONE
 * action id instead of about the event's keys.
 *
 * This is what lets the sequence layer dispatch without a table of its own. The
 * chord ladder below is driven entirely by `isShortcut` / `isTabShortcut` /
 * `isPaneShortcut`, so forcing those three to agree on the matched id runs that
 * action's EXISTING branch, with that branch's own guards intact. A second
 * action-id-to-handler map would be the alternative, and it would drift: an
 * action added to the ladder in Phase 03 would work from its chord and
 * silently do nothing from its sequence.
 *
 * All three matchers are forced together because they are not cleanly
 * separable - `isTabShortcut` already falls back to the general map - and the
 * two id spaces are disjoint, so there is no id a sequence could legitimately
 * match in one and not the other.
 *
 * The copy is shallow and made only on a match, which is rare, and nothing in
 * the handler writes through `ctx`, so no later reader can tell the difference.
 */
function withForcedAction(ctx: KeyboardHandlerContext, actionId: string): KeyboardHandlerContext {
	const matchesForcedAction = (_e: KeyboardEvent, id: string) => id === actionId;
	return {
		...ctx,
		isShortcut: matchesForcedAction,
		isTabShortcut: matchesForcedAction,
		isPaneShortcut: matchesForcedAction,
	};
}

/**
 * Return type for useMainKeyboardHandler hook
 */
export interface UseMainKeyboardHandlerReturn {
	/** Ref to be updated with current keyboard handler context each render */
	keyboardHandlerRef: React.MutableRefObject<KeyboardHandlerContext | null>;
	/** Whether session jump number badges should be displayed */
	showSessionJumpNumbers: boolean;
}

/**
 * Main keyboard handler hook for App.tsx.
 *
 * Sets up the primary keydown event listener with empty dependencies (using ref pattern
 * for performance - avoids re-attaching listener on every state change).
 *
 * Also manages the session jump number badges display state.
 *
 * IMPORTANT: The caller must update keyboardHandlerRef.current synchronously during render
 * with the current context values. This hook only sets up the listener.
 *
 * @returns keyboardHandlerRef and showSessionJumpNumbers state
 */
export function useMainKeyboardHandler(): UseMainKeyboardHandlerReturn {
	// Ref to hold all keyboard handler dependencies
	// This is a critical performance optimization: the keyboard handler was being removed and re-added
	// on every state change due to 51+ dependencies, causing memory leaks and event listener bloat
	const keyboardHandlerRef = useRef<KeyboardHandlerContext | null>(null);

	// State for showing session jump number badges when Opt+Cmd is held
	const [showSessionJumpNumbers, setShowSessionJumpNumbers] = useState(false);

	// Main keyboard handler effect
	useEffect(() => {
		// One sequence matcher for the life of the listener. Deliberately NOT
		// rebuilt when bindings change: `feed` takes the live binding list per
		// call, so a settings write cannot discard a half-typed prefix.
		const sequenceMatcher = createSequenceMatcher();

		// A SECOND matcher, for the in-field escape (`jk`). Separate from the one
		// above rather than a binding inside it, because the two run under
		// opposite gates and want opposite things from a captured step: a
		// normal-mode sequence fires only when NO text field has focus and
		// swallows every step, while `jk` fires only when one does and must let
		// its first step through as a typed character. One matcher holding both
		// would also let a `g` typed in the composer survive into a normal-mode
		// run, since the prefix buffer is a single piece of state.
		const insertEscapeMatcher = createSequenceMatcher();
		/**
		 * The field a half-typed insert escape belongs to, or null.
		 *
		 * An escape is only an escape in the field it was started in: without
		 * this, a `j` typed in the composer and a `k` typed after clicking into
		 * the Settings filter would blur a field that never saw the `j`, and the
		 * retraction would find the wrong character before the caret. Cleared on
		 * every outcome except a captured step, so the reference outlives the
		 * keystroke by at most one keypress.
		 */
		let insertEscapeField: InsertEscapeField | null = null;
		const endInsertEscapeRun = () => {
			if (!insertEscapeField) return;
			insertEscapeMatcher.reset();
			insertEscapeField = null;
		};

		/**
		 * Tell the prefix indicator what the matcher is holding.
		 *
		 * The matcher's own answer is published verbatim, so the chip cannot
		 * disagree with it: a match, an aborted run, Escape and an expired prefix
		 * all leave `prefix()` empty, which is how the chip learns to disappear,
		 * and a modifier-only keydown leaves it unchanged, which is how a capital
		 * mid-sequence does not make the chip flicker. The one case the matcher
		 * cannot report is the timeout, because it expires lazily on read; the
		 * indicator owns a timer for that.
		 *
		 * Safe to call on every keydown: `prefix()` is identity-stable while the
		 * run is unchanged and the store skips a write that changes nothing.
		 */
		const publishPrefix = () => publishSequencePrefix(sequenceMatcher.prefix());

		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target;
			const activeElement = document.activeElement;
			const isXtermElement = (el: EventTarget | null) =>
				el instanceof Element &&
				(el.classList.contains('xterm-helper-textarea') || !!el.closest('.xterm'));
			const isXtermTarget = isXtermElement(target) || isXtermElement(activeElement);
			const isEditableTarget =
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable);

			// Block browser refresh (Cmd+R / Ctrl+R / Cmd+Shift+R / Ctrl+Shift+R) globally
			// We override these shortcuts for other purposes, but even in views where that
			// doesn't apply (e.g., file preview), we never want the app to refresh
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
				e.preventDefault();
			}

			// Read all values from ref - this allows the handler to stay attached while still
			// accessing current state values. Active Session is resolved at event time from
			// the store so App does not need to push a live Session object onto this ref.
			// Reassignable: a matched key sequence swaps in a view of this same
			// context whose matchers answer about the matched action (see
			// `withForcedAction` and the sequence block below).
			let ctx = keyboardHandlerRef.current;
			if (!ctx) return;
			const activeSession = selectActiveSession(useSessionStore.getState());

			// Helper to track shortcut usage for keyboard mastery gamification
			// AND for the daily-usage time series shown on the Usage Dashboard.
			// Mastery is short-circuited on second+ firings of the same shortcut
			// (it's a unique-set), but the daily counter increments every time.
			//
			// Usage is recorded PER ACTION, never per mode, per chord, per
			// sequence, or per Deck key. The same action fired from a Vim
			// sequence, from Deck mode, and from its default-mode chord is one
			// entry in the mastery set, which is what makes the count mean "you
			// know this action" rather than "you know this keystroke". Every new
			// keyboard path must call this with the action id (the Deck block
			// below and the sequence layer further down both do).
			//
			// Defined up here, above every guard, because the Deck block is the
			// first thing in the chain and records the action it fires. Nothing
			// about the closure cares where it sits: it reads `ctx` at CALL time,
			// so a later `withForcedAction` swap is invisible to it (the copy
			// carries the same `recordShortcutUsage`).
			//
			// `reported` makes one keypress one usage: the Deck and sequence
			// layers record the action they matched before the ladder runs, and
			// the branch that then fires records the same id. Mastery is a set and
			// would not notice, but the daily counter would count that keypress
			// twice.
			const reported = new Set<string>();
			const trackShortcut = (shortcutId: string) => {
				if (reported.has(shortcutId)) return;
				reported.add(shortcutId);
				if (ctx.recordShortcutUsage) {
					const result = ctx.recordShortcutUsage(shortcutId);
					if (result.newLevel !== null && ctx.onKeyboardMasteryLevelUp) {
						ctx.onKeyboardMasteryLevelUp(result.newLevel);
					}
				}
				// Fire-and-forget. A failed IPC must never block a shortcut from
				// taking effect; the daily counter is best-effort telemetry.
				void window.maestro?.stats?.recordShortcutUsage?.(Date.now());
			};

			// --- Deck mode: the leader chord and the one key that follows it ---
			//
			// First in the chain, above the terminal blocks, the in-field escape
			// and the layer guard, because an armed Deck mode owns the NEXT
			// keystroke outright and every path below claims bare keys for its own
			// good reasons: terminal focus recovery forwards them to the shell,
			// `jk` reads a `j` as a prefix step, the layer guard hands them to
			// whatever modal is open, and sidebar navigation claims a bare Space.
			// Deck mode is the one keyboard route that is meant to fire from a
			// focused composer and over an open surface, so it has to be asked
			// before any of them.
			//
			// `deckModeArmedNow()`, never the raw `deckModeArmed` flag: the window
			// expires lazily (no timer), so the store helper is the only thing that
			// answers "is the mode live" correctly, and it disarms an expired one on
			// the way out.
			//
			// On a hit the action is dispatched the same way a matched sequence is -
			// by forcing the three matchers onto the action id and falling through
			// to that action's EXISTING ladder branch, with that branch's own guards
			// intact. A second action-id-to-handler map here would drift the first
			// time a branch grew a guard. What a forced Deck action does NOT do is
			// re-enter the guards between here and the ladder: the keystroke has
			// already been matched against the Deck table, and those guards read raw
			// keys, so each one below is skipped while `deckAction` is set.
			let deckAction: string | null = null;
			if (deckModeArmedNow()) {
				const { disarmDeckMode } = useUIStore.getState();
				if (isDeckModeCancelKey(e.key)) {
					// THE ONE PLACE THE LAYER STACK YIELDS. Escape normally closes the
					// topmost layer from LayerStackProvider's capture-phase listener,
					// which runs before this one and stops propagation; that listener
					// asks `deckModeArmedNow()` first and declines while the mode is
					// armed, which is what lets the keypress reach here. An armed
					// leader is what the user is cancelling, and taking their modal
					// away in the same keystroke would charge them twice for one
					// mistyped chord. Escape fires nothing and is tracked against
					// nothing: cancelling is the mode's own behaviour, not an action
					// (see DECK_MODE_CANCEL).
					e.preventDefault();
					disarmDeckMode();
					return;
				}
				if (e.metaKey || e.ctrlKey || e.altKey) {
					// A chord while armed is not a Deck key at all. The user changed
					// their mind and pressed something they meant for the app, so the
					// mode gets out of the way: disarm, do NOT swallow the event, and
					// let it be matched as the chord it is. Pressing the leader again
					// lands here and then re-arms below, which is how a second press
					// restarts the clock.
					disarmDeckMode();
				} else {
					const row = findDeckModeAction(e.key);
					// Swallowed and disarmed on BOTH outcomes, before the branch. A
					// one-shot mode must not leak the key into the composer it was
					// armed from, and a miss deliberately does not fall through to the
					// normal binding ladder: a leader that sometimes passed the key
					// along would leave the user guessing whether it had taken effect.
					e.preventDefault();
					disarmDeckMode();
					if (!row) return;
					trackShortcut(row.id);
					ctx = withForcedAction(ctx, row.id);
					deckAction = row.id;
				}
			}
			if (deckAction === null && ctx.isShortcut(e, DECK_MODE_LEADER_ID)) {
				e.preventDefault();
				useUIStore.getState().armDeckMode();
				trackShortcut(DECK_MODE_LEADER_ID);
				// Both half-finished keyboard ideas are abandoned with it. The leader
				// is a deliberate fresh start, and a live `g` prefix or an in-field
				// `j` that outlived it would complete against a key the user aimed at
				// the Deck table.
				sequenceMatcher.reset();
				publishPrefix();
				endInsertEscapeRun();
				return;
			}

			// Terminal focus recovery: if a key event reaches this window handler while in
			// terminal mode, xterm's textarea likely lost focus. Recover early (before any
			// global shortcut/navigation logic) so arrow keys and editor escape paths still
			// work in interactive TUIs like vi/vim/nano.
			const isTerminalRecoveryContext =
				activeSession?.inputMode === 'terminal' &&
				!ctx.activeGroupChatId &&
				!ctx.hasOpenLayers() &&
				!e.defaultPrevented &&
				!isXtermTarget &&
				!isEditableTarget;
			if (isTerminalRecoveryContext) {
				// Preserve explicit app shortcuts that are intentionally global.
				const isExplicitAppShortcut =
					e.metaKey || e.altKey || (e.ctrlKey && e.shiftKey && e.code === 'Backquote');
				if (!isExplicitAppShortcut) {
					const tabId = activeSession.activeTerminalTabId;
					if (tabId) {
						const termSid = `${activeSession.id}-terminal-${tabId}`;
						let data: string | null = null;
						const isNavigationKey =
							e.key === 'ArrowUp' ||
							e.key === 'ArrowDown' ||
							e.key === 'ArrowRight' ||
							e.key === 'ArrowLeft' ||
							e.key === 'Home' ||
							e.key === 'End' ||
							e.key === 'Delete' ||
							e.key === 'PageUp' ||
							e.key === 'PageDown';

						if (!e.ctrlKey && e.key.length === 1) {
							data = e.key;
						} else if (e.key === 'Enter') {
							data = '\r';
						} else if (e.key === 'Backspace') {
							data = '\x7f';
						} else if (e.key === 'Escape') {
							data = '\x1b';
						} else if (e.key === 'Tab') {
							data = '\t';
						} else if (e.ctrlKey && e.key.length === 1) {
							// Keep Ctrl+F available for terminal search routing when xterm
							// is not focused (Windows/Linux app-level shortcut behavior).
							if (e.key.toLowerCase() !== 'f') {
								// Ctrl+A..Z -> send control character
								const code = e.key.toUpperCase().charCodeAt(0);
								if (code >= 65 && code <= 90) {
									data = String.fromCharCode(code - 64);
								}
							}
						}

						if (data !== null) {
							ctx.mainPanelRef?.current?.focusActiveTerminal?.();
							e.preventDefault();
							window.maestro?.process?.write(termSid, data);
							return;
						}
						if (isNavigationKey) {
							// Avoid synthesizing arrow/home/end escapes on focus recovery:
							// xterm is authoritative for these and manual sequences can
							// corrupt insert mode in editors (vi/vim).
							ctx.mainPanelRef?.current?.focusActiveTerminal?.();
							e.preventDefault();
							return;
						}
					}
				}
			}

			// CRITICAL: When in terminal mode, let xterm.js handle Ctrl+[A-Z] control sequences.
			// These include Ctrl+C (SIGINT), Ctrl+D (EOF), Ctrl+Z (suspend), Ctrl+\ (quit), etc.
			// On macOS, Ctrl is used for terminal control sequences; Cmd (Meta) is for Maestro shortcuts.
			// On Windows/Linux, Ctrl doubles as the modifier for Maestro shortcuts (Ctrl+F, Ctrl+W, etc.)
			// so we only bypass for macOS to avoid breaking cross-platform app shortcuts.
			// Exception: Ctrl+Shift+` always creates a new terminal tab regardless of mode/platform.
			const isMac = isMacOSKeyboard();
			if (
				isMac &&
				activeSession?.inputMode === 'terminal' &&
				!ctx.activeGroupChatId &&
				!isXtermTarget &&
				e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				!(e.shiftKey && e.code === 'Backquote') // Allow Ctrl+Shift+` for new terminal tab
			) {
				// If the event reached this window handler, xterm's textarea may have lost focus
				// (xterm normally stopPropagation's handled Ctrl events). Re-focus and forward
				// the control character so Ctrl+C/D/Z still work in vim/vi/nano.
				ctx.mainPanelRef?.current?.focusActiveTerminal?.();
				const tabId = activeSession.activeTerminalTabId;
				if (tabId && e.key.length === 1) {
					const code = e.key.toUpperCase().charCodeAt(0);
					if (code >= 65 && code <= 90) {
						e.preventDefault();
						const termSid = `${activeSession.id}-terminal-${tabId}`;
						window.maestro?.process?.write(termSid, String.fromCharCode(code - 64));
					}
				}
				return;
			}

			// --- `jk` to leave a text field (Vim mode's insert-mode escape) ---
			//
			// Placed here, ABOVE the layer guard, on purpose. That guard returns
			// early for every bare key while a modal is open, so a block below it
			// would make `jk` dead in exactly the text fields a modal is made of -
			// the Settings filter, a rename field, the search box. It is below the
			// two terminal blocks for the opposite reason: those own the keyboard
			// when xterm has it, and `insertEscapeTarget` excludes `.xterm`
			// anyway, so a `jk` typed into `vim` in a Maestro terminal reaches the
			// shell and nothing else.
			//
			// `ctx.insertEscape` is null unless Vim mode is live AND the setting
			// parses, so default-mode users pay one property read for this. A
			// forced Deck action nulls it outright: a Deck `j` is a region move the
			// user asked for by name, not the first half of an escape, and feeding
			// it to this matcher would leave a prefix waiting to eat the next real
			// `k` they typed.
			//
			// No `trackShortcut` call: keyboard mastery counts ACTIONS, and every
			// id it knows is declared in `DEFAULT_SHORTCUTS` or `TAB_SHORTCUTS`
			// with a row in Settings > Shortcuts. The insert escape is a text-field
			// behavior configured by a string setting, not a bindable action, so
			// recording it would put an id in the mastery set that no table
			// declares and no row could ever explain.
			const insertEscape: InsertEscapeBinding | null = deckAction
				? null
				: (ctx.insertEscape ?? null);
			if (insertEscape) {
				const field = insertEscapeTarget(target);
				// Focus moved mid-run (a click into another input, a modal
				// autofocusing its first field): the run ended with it.
				if (field !== insertEscapeField) endInsertEscapeRun();
				if (field) {
					const escapeResult = insertEscapeMatcher.feed(e, insertEscape.bindings);
					if (escapeResult.outcome === 'consumed-prefix') {
						// Deliberately NOT prevented. The `j` is a character the user
						// typed and it belongs in the field; if no `k` follows,
						// nothing was ever taken away from them.
						insertEscapeField = field;
					} else if (escapeResult.outcome === 'matched') {
						insertEscapeField = null;
						if (applyInsertEscape(field, insertEscape.inserted)) {
							e.preventDefault();
							return;
						}
						// The prefix is not where it was expected to be, so this was
						// never an escape. Fall through and let the key be the
						// character it is - a near miss costs the user nothing.
					} else {
						insertEscapeField = null;
					}
				}
			}

			// When layers (modals/overlays) are open, we need nuanced shortcut handling:
			// - Escape: handled by LayerStackContext in capture phase
			// - Tab: allowed for accessibility navigation
			// - Cmd+Shift+[/]: depends on layer type (modal vs overlay)
			//
			// TRUE MODALS (Settings, QuickActions, etc.): Block ALL shortcuts except Tab
			//   - These modals have their own internal handlers for Cmd+Shift+[]
			//
			// OVERLAYS (FilePreview, LogViewer): Allow Cmd+Shift+[] for tab cycling
			//   - App.tsx handles this with modified behavior (cycle tabs not sessions)

			// `!deckAction`: a Deck key reached its table through the leader, which
			// is the user naming one action out of a list they are being shown, so
			// it is not a stray keypress for this guard to adjudicate.
			if (!deckAction && ctx.hasOpenLayers()) {
				// Allow Tab for accessibility navigation within modals
				if (e.key === 'Tab') return;

				// Handle both bracket and brace characters: on macOS, Shift+[ produces { and Shift+] produces }
				const isCycleShortcut =
					(e.metaKey || e.ctrlKey) &&
					e.shiftKey &&
					(e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}');
				// Allow sidebar toggle shortcuts (Alt+Cmd+Left/Right) even when modals are open
				const isLayoutShortcut =
					e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
				// Walking unread / draft tabs is benign navigation, so it stays live
				// behind a modal - in BOTH directions. Resolved by SHORTCUT ID rather
				// than by key, for two reasons: it has already moved combos once and the
				// hard-coded arrow left behind by that move silently stopped matching it,
				// and a user who REBINDS it would otherwise get a shortcut that dies the
				// moment any modal is open - including the Shortcuts settings pane they
				// rebound it in.
				const isNextUnreadTabShortcut =
					ctx.isShortcut(e, 'nextUnreadTab') || ctx.isShortcut(e, 'previousUnreadTab');
				// Allow right panel tab shortcuts (Cmd+Shift+F/H/S) even when overlays are open
				const keyLower = e.key.toLowerCase();
				const isRightPanelShortcut =
					(e.metaKey || e.ctrlKey) &&
					e.shiftKey &&
					(keyLower === 'f' || keyLower === 'h' || keyLower === 's');
				// Allow jumpToBottom and jumpToTerminal from anywhere - benign navigation actions
				const isJumpToBottomShortcut = ctx.isShortcut(e, 'jumpToBottom');
				const isJumpToTerminalShortcut = ctx.isShortcut(e, 'jumpToTerminal');
				// Allow markdown toggle (Cmd+E) for chat history, even when overlays are open
				// (e.g., when output search is open, user should still be able to toggle markdown mode)
				const isMarkdownToggleShortcut =
					(e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && keyLower === 'e';
				// Alt+Cmd+S stays live over an open modal. The l/p/u chords that used to
				// be listed here are now matched by binding through
				// isDestinationSurfaceShortcut below; `s` is Snooze Tab (the
				// auto-scroll toggle this comment used to name is long gone).
				// NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters (e.g., Alt+P = π)
				const codeKeyLower = e.code?.replace('Key', '').toLowerCase() || '';
				const isSystemUtilShortcut = e.altKey && (e.metaKey || e.ctrlKey) && codeKeyLower === 's';
				// A destination surface replaces whatever destination is showing (see
				// DESTINATION_MODALS), so its hotkey has to survive the modal guard -
				// otherwise you can switch between two full-window surfaces in one
				// direction and not the other. Resolved through the BINDINGS, so a
				// rebound surface keeps working; the old hardcoded Alt+Cmd+{l,p,u}
				// test is what made the direction depend on which chord it happened
				// to spell.
				let isDestinationSurfaceShortcut = false;
				for (const id of DESTINATION_SHORTCUT_IDS) {
					if (ctx.isShortcut(e, id)) {
						isDestinationSurfaceShortcut = true;
						break;
					}
				}
				// Allow session jump shortcuts (Alt+Cmd+NUMBER) even when modals are open
				// NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters
				const isSessionJumpShortcut =
					e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code || '');
				// Allow tab management shortcuts even when file preview overlay is open:
				// - Cmd+T: new tab
				// - Cmd+W: close tab
				// - Cmd+Shift+T: reopen closed tab
				const isTabManagementShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					((keyLower === 't' && !e.shiftKey) || // Cmd+T
						keyLower === 'w' || // Cmd+W (with or without shift)
						(keyLower === 't' && e.shiftKey)); // Cmd+Shift+T
				// Allow tab switcher shortcut (Alt+Cmd+T) even when file preview is open
				// NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters
				const isTabSwitcherShortcut =
					e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey && codeKeyLower === 't';
				// Allow toggleMode (Cmd+J) to switch to terminal view from file preview
				const isToggleModeShortcut = ctx.isShortcut(e, 'toggleMode');
				// Allow focusBrowserAddress (Cmd+L) to focus address bar when browser tab is active overlay
				const isBrowserAddressShortcut =
					ctx.isTabShortcut(e, 'focusBrowserAddress') && !!activeSession?.activeBrowserTabId;
				// Allow browser-tab Cmd+F (in-page find) to reach its handler even when
				// modals/overlays are open. The find bar is locally-scoped to the
				// browser tab; the overlay-guard's broader "block app shortcuts"
				// behavior would otherwise eat it.
				const isBrowserFindShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					e.key.toLowerCase() === 'f' &&
					!!activeSession?.activeBrowserTabId;
				// Allow Cmd+Left / Cmd+Right (browser history back/forward) to fall
				// through when a browser tab is active. The address/find bar inputs
				// still preserve macOS line navigation via the target check below.
				const isBrowserNavShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					(e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
					!!activeSession?.activeBrowserTabId;
				// Allow Cmd+F to fall through and re-focus the file-tree filter input
				// when the filter is already open and the files panel is focused. The
				// open filter registers an overlay layer, so without this exception the
				// overlay-guard below returns early and the re-focus branch never runs.
				const isFileFilterRefocusShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					keyLower === 'f' &&
					ctx.activeFocus === 'right' &&
					ctx.activeRightTab === 'files' &&
					ctx.fileTreeFilterOpen;
				// Cmd+F on a focused side pane is that pane's local filter, even if
				// the transcript Find bar is still open from earlier.
				const isPaneLocalFindShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					keyLower === 'f' &&
					(ctx.activeFocus === 'right' || ctx.activeFocus === 'sidebar');
				// The Concerto keys stay live through the guard. The stage is a
				// workspace surface, not a dialog, so its own toggle has to be able to
				// close it - a toggle that only ever opens is a dead keypress. And
				// cadenzas float ABOVE every modal, so the only way to stash a stack of
				// them while something else is open is to let this key through.
				const isConcertoToggleShortcut =
					(ctx.isShortcut(e, 'toggleConcerto') || ctx.isShortcut(e, 'toggleCadenzas')) &&
					ctx.encoreFeatures?.concerto === true;
				// Allow the zoom shortcuts (Cmd+=/+, Cmd+-, Cmd+Shift+0) even when
				// modals/overlays are open. `=`/`-` take no Shift (matching the
				// in/out handler below); `+` is included regardless of Shift because
				// US layouts only produce it WITH Shift held (Cmd+Shift+= reads as
				// Cmd++), so requiring !e.shiftKey there would make it unreachable.
				// `0` takes Shift ONLY - the actual reset is Cmd+Shift+0 (see the
				// comment above that handler); a bare Cmd+0 is "Go to Last Tab" and
				// must NOT fall through here, or it switches tabs behind an open
				// modal instead of being blocked by the guard.
				const isFontSizeShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					(((e.key === '=' || e.key === '-') && !e.shiftKey) ||
						e.key === '+' ||
						(e.shiftKey && e.key === '0'));
				// Allow the openPromptComposer shortcut to fall through while the Prompt
				// Composer is the open modal, so pressing it again cycles windowed ->
				// full screen -> windowed (cyclePromptComposer) instead of being eaten
				// by the modal guard below.
				const isPromptComposerCycleShortcut =
					ctx.isShortcut(e, 'openPromptComposer') &&
					useModalStore.getState().modals.get('promptComposer')?.open === true;
				// The output-search find bar registers a lightweight overlay (same
				// priority as slash autocomplete). It must not suppress the genuinely
				// global launchers (Switch Agent, Quick Actions, Fuzzy File Search) or
				// its own re-invocation (Cmd+F). Without these exceptions, opening Find
				// traps the user: Cmd+O / Cmd+K go dead and there's no keyboard path
				// back to the find input. Scoped to the find bar via uiStore so other
				// overlays (file preview, log viewer) keep their stricter behavior.
				const isOutputSearchOpen = isActiveOutputSearchOpen();
				const isOutputSearchGlobalShortcut =
					isOutputSearchOpen &&
					(ctx.isShortcut(e, 'agentSwitcher') ||
						ctx.isShortcut(e, 'quickAction') ||
						ctx.isShortcut(e, 'fuzzyFileSearch') ||
						// "Not in this tab - search them all" is the natural escalation
						// from an open Find bar, so it must not be eaten by the guard.
						ctx.isShortcut(e, 'searchAllTabs'));
				const isOutputSearchRefocusShortcut =
					isOutputSearchOpen &&
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					keyLower === 'f';

				if (ctx.hasOpenModal()) {
					// TRUE MODAL is open - block most shortcuts from App.tsx
					// The modal's own handler will handle Cmd+Shift+[] if it supports it
					// BUT allow layout shortcuts (sidebar toggles), system utility shortcuts, session jump,
					// jumpToBottom, jumpToTerminal, markdown toggle, and font size to work (these are benign navigation/viewing preferences)
					if (
						!isLayoutShortcut &&
						!isNextUnreadTabShortcut &&
						!isSystemUtilShortcut &&
						!isDestinationSurfaceShortcut &&
						!isSessionJumpShortcut &&
						!isJumpToBottomShortcut &&
						!isJumpToTerminalShortcut &&
						!isMarkdownToggleShortcut &&
						!isFontSizeShortcut &&
						!isConcertoToggleShortcut &&
						!isPromptComposerCycleShortcut
					) {
						return;
					}
					// Fall through to handle layout/system utility/session jump/jumpToBottom/jumpToTerminal/markdown toggle/font size shortcuts below
				} else {
					// Only OVERLAYS are open (file tabs, LogViewer, etc.)
					// Allow Cmd+Shift+[] to fall through to App.tsx handler
					// (which will cycle right panel tabs when file tab is active)
					// Also allow right panel tab shortcuts to switch tabs while overlay is open
					// Also allow tab management shortcuts (Cmd+T/W, Alt+Cmd+T tab switcher) from file preview
					if (
						!isCycleShortcut &&
						!isLayoutShortcut &&
						!isNextUnreadTabShortcut &&
						!isRightPanelShortcut &&
						!isSystemUtilShortcut &&
						!isDestinationSurfaceShortcut &&
						!isSessionJumpShortcut &&
						!isJumpToBottomShortcut &&
						!isJumpToTerminalShortcut &&
						!isMarkdownToggleShortcut &&
						!isTabManagementShortcut &&
						!isTabSwitcherShortcut &&
						!isToggleModeShortcut &&
						!isBrowserAddressShortcut &&
						!isBrowserFindShortcut &&
						!isBrowserNavShortcut &&
						!isFileFilterRefocusShortcut &&
						!isPaneLocalFindShortcut &&
						!isOutputSearchGlobalShortcut &&
						!isOutputSearchRefocusShortcut &&
						!isConcertoToggleShortcut &&
						!isFontSizeShortcut
					) {
						return;
					}
					// Fall through to cyclePrev/cycleNext logic below
				}
			}

			// Skip all keyboard handling when editing a session or group name in the sidebar
			if (!deckAction && (ctx.editingSessionId || ctx.editingGroupId)) {
				return;
			}

			// Keyboard navigation handlers from useKeyboardNavigation hook.
			// Skipped for a forced Deck action: these read raw keys rather than
			// bindings, and `handleSidebarNavigation` claims a bare Space outright,
			// which is the Deck key for Quick Actions.
			if (!deckAction) {
				// Sidebar navigation with arrow keys (works when sidebar has focus)
				if (ctx.handleSidebarNavigation(e)) return;

				// Enter to load selected session from sidebar
				if (ctx.handleEnterToActivate(e)) return;

				// Tab navigation between panels
				if (ctx.handleTabNavigation(e)) return;

				// Escape in main area focuses terminal output
				if (ctx.handleEscapeInMain(e)) return;
			}

			// Cmd+F while the output find bar is already open: bring focus back to its
			// input from anywhere in the MAIN chat, instead of no-opping. Do NOT steal
			// the chord when a side pane is focused: the Right Bar (Files/History) and
			// Left Bar have their own Cmd+F filters, and a click on those panes is the
			// user asking for that filter, not the transcript Find they left open.
			const sidePaneOwnsFind = ctx.activeFocus === 'right' || ctx.activeFocus === 'sidebar';
			if (
				isActiveOutputSearchOpen() &&
				!sidePaneOwnsFind &&
				(e.metaKey || e.ctrlKey) &&
				!e.altKey &&
				!e.shiftKey &&
				e.key.toLowerCase() === 'f'
			) {
				e.preventDefault();
				document.querySelector<HTMLInputElement>(OUTPUT_SEARCH_INPUT_SELECTOR)?.focus();
				return;
			}

			// Tab tiling (split panes): the Ctrl+Cmd pane family is matched with a
			// dedicated matcher (isPaneShortcut requires BOTH Ctrl and Cmd) so it never
			// collides with the plain-Cmd shortcuts below (Cmd+W, Cmd+=, Cmd+D pieces).
			// Every handler is window-scoped and no-ops when there's no active group,
			// so it's safe to only preventDefault when a group is actually present.
			const hasActiveGroup =
				!!activeSession?.activeGroupId &&
				(activeSession.tabGroups ?? []).some(
					(g: { id: string }) => g.id === activeSession.activeGroupId
				);
			if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneFocusLeft')) {
				e.preventDefault();
				ctx.tilingShortcuts.focusPane('left');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneFocusRight')) {
				e.preventDefault();
				ctx.tilingShortcuts.focusPane('right');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneFocusUp')) {
				e.preventDefault();
				ctx.tilingShortcuts.focusPane('up');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneFocusDown')) {
				e.preventDefault();
				ctx.tilingShortcuts.focusPane('down');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneSplitColumn')) {
				// Stacked split - checked before paneSplitRow because it carries Shift.
				e.preventDefault();
				ctx.tilingShortcuts.splitFocusedPane('column');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneSplitRow')) {
				e.preventDefault();
				ctx.tilingShortcuts.splitFocusedPane('row');
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneClose')) {
				e.preventDefault();
				ctx.tilingShortcuts.closeFocusedPane();
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneZoom')) {
				e.preventDefault();
				ctx.tilingShortcuts.toggleZoom();
				return;
			} else if (hasActiveGroup && ctx.isPaneShortcut(e, 'paneRebalance')) {
				e.preventDefault();
				ctx.tilingShortcuts.rebalance();
				return;
			}

			// Alt+[ / Alt+] cycle focus through the active group's panes (prev/next). These
			// live on Alt (not the Ctrl+Cmd family) so they're matched by the general
			// isShortcut. Skip when typing in an input so Opt+[ / Opt+] can still produce
			// their macOS characters ("/') in the AI input; only act on a live group.
			if (hasActiveGroup && !isEditableTarget && ctx.isShortcut(e, 'paneCyclePrev')) {
				e.preventDefault();
				ctx.tilingShortcuts.cyclePane('prev');
				trackShortcut('paneCyclePrev');
				return;
			} else if (hasActiveGroup && !isEditableTarget && ctx.isShortcut(e, 'paneCycleNext')) {
				e.preventDefault();
				ctx.tilingShortcuts.cyclePane('next');
				trackShortcut('paneCycleNext');
				return;
			}

			// --- Key sequences (`g g`, `g t`) ---
			//
			// Placed BEFORE the chord ladder and AFTER every early return above
			// it, both deliberately. Before, because a sequence step is a bare
			// key and the ladder would otherwise get first refusal on it. After,
			// because the paths above already own bare keys for better reasons:
			// terminal focus recovery forwards them to the shell, the layer guard
			// hands them to whatever modal is open, the sidebar / Enter / Escape
			// navigation handlers claim theirs, and the Cmd+R block only ever
			// calls preventDefault. Group chat handling is not above this point -
			// it lives inside the ladder - so a matched sequence reaches it the
			// same way its chord does.
			//
			// Both halves of normal mode are checked here. `isNormalMode` owns the
			// focus half (nothing that accepts typed text holds the keystroke) and
			// `hasOpenLayers` owns the modal half, which is React context rather
			// than DOM and so cannot live in the predicate.
			//
			// Skipped entirely when the live mode binds no sequence at all, which
			// is every default-mode user who has not recorded one. This is the
			// hottest path in the app, and `isNormalMode` costs two `closest()`
			// walks; with no bindings `feed` can only answer 'no-match' and no
			// prefix can be live to reset, so the skip changes nothing but the
			// cost.
			//
			// Skipped entirely for a forced Deck action, which is why Deck mode
			// "composes with" the sequence matcher rather than competing with it:
			// the leader already reset any live prefix, and feeding the Deck key
			// here would let it start or finish a run it was never aimed at.
			const sequenceBindings: readonly SequenceBinding[] =
				ctx.sequenceBindings ?? NO_SEQUENCE_BINDINGS;
			if (!deckAction && sequenceBindings.length > 0) {
				if (isNormalMode(e) && !ctx.hasOpenLayers()) {
					const sequenceResult = sequenceMatcher.feed(e, sequenceBindings);
					// Before the branches, so every outcome repaints the chip from
					// one place: a captured step shows it, a match or an abort hides
					// it, and a modifier-only key leaves it exactly as it was.
					publishPrefix();
					if (sequenceResult.outcome === 'consumed-prefix') {
						// The keypress belongs to the run in progress. Letting it
						// also reach the ladder would fire an action mid-sequence.
						e.preventDefault();
						return;
					}
					if (sequenceResult.outcome === 'matched') {
						// Swallowed for the same reason its prefix was: the key
						// completed a sequence, so it is not also a key in its own
						// right.
						e.preventDefault();
						trackShortcut(sequenceResult.actionId);
						ctx = withForcedAction(ctx, sequenceResult.actionId);
					}
					// 'no-match' falls through untouched, to be matched as a chord.
				} else {
					// A keypress that could not be a sequence step ends the run:
					// the user has clicked into a text field or opened a modal, and
					// a prefix that outlived either would complete against a
					// keystroke they no longer connect to it.
					sequenceMatcher.reset();
					publishPrefix();
				}
			}

			// Which "Tile New ... Below" command this event matches, if any. Resolved
			// once here rather than as four more links in the else-if chain below.
			// isPaneShortcut, not isShortcut: the family lives on Ctrl+Cmd and the
			// general matcher treats Ctrl and Cmd as the same modifier, so it would
			// report a match on a bare Cmd+T.
			//
			// Resolved AFTER the sequence block, so it sees the forced matcher on a
			// match like every other ladder branch does. Computed earlier it would
			// have been the one branch a sequence could never reach.
			const matchedTile = TILE_SHORTCUTS.find((t) => ctx.isPaneShortcut(e, t.shortcutId)) ?? null;

			// General shortcuts
			// Only allow collapsing left sidebar when there are sessions (prevent collapse on empty state)
			if (ctx.isShortcut(e, 'toggleSidebar')) {
				if (useSessionStore.getState().sessions.length > 0 || !ctx.leftSidebarOpen) {
					ctx.setLeftSidebarOpen((p: boolean) => !p);
					trackShortcut('toggleSidebar');
				}
			} else if (ctx.isShortcut(e, 'toggleRightPanel')) {
				ctx.setRightPanelOpen((p: boolean) => !p);
				trackShortcut('toggleRightPanel');
			} else if (ctx.isShortcut(e, 'toggleZenMode')) {
				// Zen composes the two toggles above, so it sits beside them. It writes
				// the store action rather than ctx.setLeftSidebarOpen / setRightPanelOpen
				// because the whole point of the action is that entry takes ONE snapshot
				// of all three visibility booleans and exit spreads it back: three
				// independent setter calls from here could not restore the Left Bar's
				// tri-state, and would reopen a Right Bar the user had already closed.
				useUIStore.getState().toggleZenMode();
				trackShortcut('toggleZenMode');
			} else if (ctx.isShortcut(e, 'newInstance')) {
				e.preventDefault();
				// Cmd+N goes directly to manual agent creation, bypassing the choice modal
				useModalStore.getState().openModal('newInstance', { duplicatingSessionId: null });
				trackShortcut('newInstance');
			} else if (ctx.isShortcut(e, 'newGroupChat')) {
				e.preventDefault();
				ctx.setShowNewGroupChatModal(true);
				trackShortcut('newGroupChat');
			} else if (ctx.isShortcut(e, 'toggleGroupChatModeratorOnly')) {
				// Only means anything inside a room; outside one the chord stays free
				// for whatever branch comes after it.
				if (ctx.activeGroupChatId) {
					e.preventDefault();
					useGroupChatStore.getState().toggleGroupChatModeratorOnly();
					trackShortcut('toggleGroupChatModeratorOnly');
				}
			} else if (ctx.isShortcut(e, 'killInstance')) {
				// Delete whichever is currently active: group chat or agent session
				if (ctx.activeGroupChatId) {
					ctx.deleteGroupChatWithConfirmation(ctx.activeGroupChatId);
					trackShortcut('killInstance');
				} else if (ctx.activeSessionId) {
					ctx.deleteSession(ctx.activeSessionId);
					trackShortcut('killInstance');
				}
			} else if (ctx.isShortcut(e, 'moveToGroup')) {
				if (activeSession) {
					ctx.setQuickActionOpen(true, 'move-to-group');
					trackShortcut('moveToGroup');
				}
			} else if (ctx.isShortcut(e, 'cyclePrev')) {
				// Cycle to previous Maestro session (global shortcut)
				e.preventDefault();
				ctx.cycleSession('prev');
				trackShortcut('cyclePrev');
			} else if (ctx.isShortcut(e, 'cycleNext')) {
				// Cycle to next Maestro session (global shortcut)
				e.preventDefault();
				ctx.cycleSession('next');
				trackShortcut('cycleNext');
			} else if (ctx.isShortcut(e, 'navBack')) {
				// Navigate back in history (through sessions and tabs)
				e.preventDefault();
				ctx.handleNavBack();
				trackShortcut('navBack');
			} else if (ctx.isShortcut(e, 'navForward')) {
				// Navigate forward in history (through sessions and tabs)
				e.preventDefault();
				ctx.handleNavForward();
				trackShortcut('navForward');
			} else if (ctx.isShortcut(e, 'toggleMode')) {
				e.preventDefault();
				if (ctx.activeSessionId) {
					// Cmd+J always opens a new terminal tab (analogous to Cmd+T for AI tabs).
					// handleOpenTerminalTab creates the tab and sets inputMode:'terminal' automatically.
					// Safe in wizard tabs - it creates a new tab rather than disrupting wizard state.
					ctx.handleOpenTerminalTab();
					setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
				} else {
					// Auto-focus the input so user can start typing immediately
					ctx.setActiveFocus('main');
					setTimeout(() => ctx.inputRef.current?.focus(), FOCUS_AFTER_RENDER_DELAY_MS);
				}
				trackShortcut('toggleMode');
			} else if (matchedTile) {
				// The tile-below family. Each is the tiled twin of its plain "new tab"
				// chord: instead of a new tab that takes over the panel, split the
				// current view and put the new tab in the bottom half. Unlike the pane
				// commands above this is NOT gated on an existing group - tiling into a
				// single view is what creates the first one. tileNewTabInSession focuses
				// the new pane; it flashes and no-ops when the agent has nothing on
				// screen to tile with.
				e.preventDefault();
				if (ctx.activeSessionId) {
					tileNewTabInSession(ctx.activeSessionId, matchedTile.kind);
					trackShortcut(matchedTile.shortcutId);
				}
			} else if (ctx.isShortcut(e, 'agentSwitcher')) {
				e.preventDefault();
				if (useSessionStore.getState().sessions.length > 0) {
					ctx.setQuickActionOpen(true, 'agents');
					trackShortcut('agentSwitcher');
				}
			} else if (ctx.isShortcut(e, 'quickAction')) {
				e.preventDefault();
				if (useSessionStore.getState().sessions.length > 0) {
					ctx.setQuickActionOpen(true, 'main');
					trackShortcut('quickAction');
				}
			} else if (ctx.isShortcut(e, 'clearTerminal') && activeSession?.inputMode === 'terminal') {
				// Clears the active xterm buffer in terminal mode
				e.preventDefault();
				ctx.mainPanelRef?.current?.clearActiveTerminal();
				trackShortcut('clearTerminal');
			} else if (ctx.isShortcut(e, 'help')) {
				e.preventDefault();
				ctx.setShortcutsHelpOpen(true);
				trackShortcut('help');
			} else if (
				eventMatchesShortcutKeys(e, FIXED_SHORTCUTS.toggleKeyboardMode.keys) &&
				!keyboardModeToggleShadow()
			) {
				// The keyboard route back out of the mode you switched into. Matched by
				// its FIXED chord rather than through ctx.isShortcut, because it is not
				// in the configurable map at all: it has to be the same chord in every
				// mode, or a mode could rebind its own exit key.
				//
				// The shadow check is what makes the user's own binding win. When the
				// live set gives Opt+Cmd+V to another action, this branch stands down
				// and the event falls through to that action's own branch; Settings >
				// Shortcuts names the action that took it, so the chord is explained
				// rather than silently dead.
				e.preventDefault();
				switchKeyboardMode();
				trackShortcut('toggleKeyboardMode');
			} else if (ctx.isShortcut(e, 'settings')) {
				e.preventDefault();
				ctx.setSettingsModalOpen(true);
				trackShortcut('settings');
			} else if (ctx.isShortcut(e, 'openThemeSettings')) {
				e.preventDefault();
				ctx.setSettingsTab?.('theme');
				ctx.setSettingsModalOpen(true);
				trackShortcut('openThemeSettings');
			} else if (ctx.isShortcut(e, 'showSnoozeList')) {
				// Registered unbound since Part 3 and never wired, so binding a key to
				// it did nothing. Same route the tab strip and the palette already use.
				e.preventDefault();
				useModalStore.getState().openModal('snoozedTabs');
				trackShortcut('showSnoozeList');
			} else if (ctx.isShortcut(e, 'openLeaderboard')) {
				e.preventDefault();
				useModalStore.getState().openModal('leaderboard');
				trackShortcut('openLeaderboard');
			} else if (
				ctx.isShortcut(e, 'openNotificationCenter') &&
				useSettingsStore.getState().notificationCenterEnabled
			) {
				e.preventDefault();
				useNotificationStore.getState().setNotificationCenterOpen(true);
				trackShortcut('openNotificationCenter');
			} else if (ctx.isShortcut(e, 'toggleInAppToasts')) {
				e.preventDefault();
				toggleInAppToasts();
				trackShortcut('toggleInAppToasts');
			} else if (ctx.isShortcut(e, 'clearAllNotifications')) {
				e.preventDefault();
				useNotificationStore.getState().clearToasts();
				trackShortcut('clearAllNotifications');
			} else if (ctx.isShortcut(e, 'openMediaPlayer')) {
				e.preventDefault();
				openMediaPlayerFromShortcut();
				trackShortcut('openMediaPlayer');
			} else if (ctx.isShortcut(e, 'mediaPlayPause')) {
				e.preventDefault();
				useMediaPlaybackStore.getState().requestToggle();
				trackShortcut('mediaPlayPause');
			} else if (ctx.isShortcut(e, 'mediaNext')) {
				e.preventDefault();
				stepMediaFromShortcut(1);
				trackShortcut('mediaNext');
			} else if (ctx.isShortcut(e, 'mediaPrev')) {
				e.preventDefault();
				stepMediaFromShortcut(-1);
				trackShortcut('mediaPrev');
			} else if (ctx.isShortcut(e, 'agentSettings')) {
				// In group chat, open the moderator's settings for the active chat.
				// Otherwise open agent settings for the current session.
				if (ctx.activeGroupChatId) {
					e.preventDefault();
					useModalStore.getState().openModal('editGroupChat', {
						groupChatId: ctx.activeGroupChatId,
					});
					trackShortcut('agentSettings');
				} else if (activeSession) {
					ctx.setEditAgentSession(activeSession);
					trackShortcut('agentSettings');
				}
			} else if (ctx.isShortcut(e, 'goToFiles')) {
				e.preventDefault();
				ctx.setRightPanelOpen(true);
				// In group chat, Cmd+Shift+F goes to Participants tab (no Files tab in group chat)
				if (ctx.activeGroupChatId) {
					ctx.setGroupChatRightTab('participants');
				} else {
					ctx.handleSetActiveRightTab('files');
					// Move real DOM focus with the app's focus state. Without this the
					// caret stayed in the editor the user came from, so the next Enter
					// there also opened the tree's selected file.
					ctx.rightPanelRef?.current?.focusFileTree();
				}
				ctx.setActiveFocus('right');
				trackShortcut('goToFiles');
			} else if (ctx.isShortcut(e, 'goToHistory')) {
				e.preventDefault();
				ctx.setRightPanelOpen(true);
				// In group chat, Cmd+Shift+H goes to History tab (same concept)
				if (ctx.activeGroupChatId) {
					ctx.setGroupChatRightTab('history');
				} else {
					ctx.handleSetActiveRightTab('history');
				}
				ctx.setActiveFocus('right');
				trackShortcut('goToHistory');
			} else if (ctx.isShortcut(e, 'goToAutoRun')) {
				e.preventDefault();
				if (useSettingsStore.getState().autoRunDisabled) return;
				ctx.setRightPanelOpen(true);
				ctx.handleSetActiveRightTab('autorun');
				ctx.setActiveFocus('right');
				trackShortcut('goToAutoRun');
			} else if (ctx.isShortcut(e, 'fuzzyFileSearch')) {
				e.preventDefault();
				if (activeSession) {
					ctx.setFuzzyFileSearchOpen(true);
					trackShortcut('fuzzyFileSearch');
				}
			} else if (ctx.isShortcut(e, 'toggleBookmark')) {
				e.preventDefault();
				if (activeSession) {
					ctx.toggleBookmark(activeSession.id);
					trackShortcut('toggleBookmark');
				}
			} else if (ctx.isShortcut(e, 'openImageCarousel')) {
				e.preventDefault();
				// Use group chat staged images when group chat is active
				const images = ctx.activeGroupChatId ? ctx.groupChatStagedImages : ctx.stagedImages;
				if (images && images.length > 0) {
					ctx.handleSetLightboxImage(images[0], images, 'staged');
					trackShortcut('openImageCarousel');
				}
			} else if (ctx.isShortcut(e, 'openImageOrganizer')) {
				e.preventDefault();
				// The expanded organizer is InputArea-only, and only has a job with
				// more than one image. The strip guards both conditions itself; we
				// mirror the count check here so the shortcut is a clean no-op (not a
				// tracked event) when there is nothing to organize.
				if (ctx.stagedImages && ctx.stagedImages.length > 1) {
					requestOpenStagedImagesOrganizer();
					trackShortcut('openImageOrganizer');
				}
			} else if (ctx.isShortcut(e, 'editClipboardImage')) {
				e.preventDefault();
				void editClipboardImage();
				trackShortcut('editClipboardImage');
			} else if (ctx.isShortcut(e, 'toggleTabStar')) {
				e.preventDefault();
				ctx.toggleTabStar();
				trackShortcut('toggleTabStar');
			} else if (ctx.isShortcut(e, 'openPromptComposer')) {
				e.preventDefault();
				// Only act in AI mode - the composer is AI-only. While it's already
				// open, the hotkey cycles between windowed and full-screen instead of
				// being a no-op.
				// A group chat is an AI surface too, but it has no inputMode of its
				// own: activeSession still points at whatever agent was selected
				// before the room was opened, so gating on that alone made the
				// hotkey work or silently die depending on an unrelated agent's mode.
				if (ctx.activeGroupChatId || activeSession?.inputMode === 'ai') {
					const composerOpen = useModalStore.getState().modals.get('promptComposer')?.open === true;
					if (ctx.activeGroupChatId && !composerOpen) ctx.flushGroupChatDraft?.();
					useModalStore.getState().cyclePromptComposer();
					trackShortcut('openPromptComposer');
				}
			} else if (ctx.isShortcut(e, 'openModelEffort')) {
				e.preventDefault();
				// AI-only, and never while a group chat owns the view - see
				// resolveModelEffortTabId for why a room resolves to a live but wrong
				// target rather than to nothing. It also resolves through
				// resolveActiveTabRef, so a focused pane in a tiled group is retuned
				// rather than the standalone tab hidden behind it.
				const modelEffortTabId = resolveModelEffortTabId(activeSession, ctx.activeGroupChatId);
				if (modelEffortTabId) {
					useModalStore.getState().openModal('modelEffort', { tabId: modelEffortTabId });
					trackShortcut('openModelEffort');
				}
			} else if (ctx.isShortcut(e, 'openWizard')) {
				e.preventDefault();
				ctx.openWizardModal();
				trackShortcut('openWizard');
			} else if (ctx.isShortcut(e, 'focusInput')) {
				e.preventDefault();
				// In terminal mode, Cmd+. focuses the active xterm instance so the user
				// can resume typing shell commands - mirrors AI mode's input focus toggle.
				if (activeSession?.inputMode === 'terminal') {
					ctx.setActiveFocus('main');
					ctx.mainPanelRef?.current?.focusActiveTerminal();
				} else {
					// AI mode: toggle between input textarea and main panel output
					const targetInputRef = ctx.activeGroupChatId ? ctx.groupChatInputRef : ctx.inputRef;
					if (document.activeElement === targetInputRef?.current) {
						// Input is focused - blur and focus main panel output
						targetInputRef?.current?.blur();
						ctx.terminalOutputRef.current?.focus();
					} else {
						// Main panel output (or elsewhere) - focus input
						ctx.setActiveFocus('main');
						setTimeout(() => targetInputRef?.current?.focus(), 0);
					}
				}
				trackShortcut('focusInput');
			} else if (ctx.isShortcut(e, 'focusSidebar')) {
				e.preventDefault();
				// Expand sidebar if collapsed
				if (!ctx.leftSidebarOpen) {
					ctx.setLeftSidebarOpen(true);
				}
				// Focus the sidebar (both logical state and DOM focus for keyboard events like Cmd+F)
				ctx.setActiveFocus('sidebar');
				setTimeout(() => ctx.sidebarContainerRef?.current?.focus(), 0);
				trackShortcut('focusSidebar');
			} else if (ctx.isShortcut(e, 'focusRegionLeft')) {
				// The six region actions generalize focusSidebar above, so they sit
				// directly after it. Each one is a single call into the service that owns
				// the behavior - reveal-before-focus, the clamp at both ends, and the
				// per-region vertical axis all live in regionFocus.ts, which the command
				// palette rows call too, so a key and a palette row cannot drift apart.
				e.preventDefault();
				focusRegionDirection('left');
				trackShortcut('focusRegionLeft');
			} else if (ctx.isShortcut(e, 'focusRegionRight')) {
				e.preventDefault();
				focusRegionDirection('right');
				trackShortcut('focusRegionRight');
			} else if (ctx.isShortcut(e, 'focusRegionUp')) {
				// Inside a bar, `focusRegionVertical` moves the list selection by
				// dispatching a bare ArrowUp/ArrowDown at the panel, and that synthetic
				// event bubbles back to this same window listener. Binding this action to
				// a bare arrow key therefore has it match its own echo. The guard is the
				// service's own re-entrancy check rather than an `e.isTrusted` test here:
				// XTerminal's passthrough and the webview's forwarded input both reach
				// this handler as UNTRUSTED synthetic events, so trust says nothing about
				// whether a press was real.
				e.preventDefault();
				focusRegionVertical('up');
				trackShortcut('focusRegionUp');
			} else if (ctx.isShortcut(e, 'focusRegionDown')) {
				e.preventDefault();
				focusRegionVertical('down');
				trackShortcut('focusRegionDown');
			} else if (ctx.isShortcut(e, 'growRegion')) {
				// Zero-arg wrappers, not resizeFocusedRegion(STEP), so the key and the
				// palette row cannot end up stepping by different amounts. Which region
				// moves is the service's call: focus in the Main Window steps the Right
				// Bar INVERTED, because the Main Window is the flex child with no width
				// of its own and can only grow by taking the step back from a bar. See
				// src/renderer/services/regionResize.ts for that reasoning in full.
				e.preventDefault();
				growFocusedRegion();
				trackShortcut('growRegion');
			} else if (ctx.isShortcut(e, 'shrinkRegion')) {
				e.preventDefault();
				shrinkFocusedRegion();
				trackShortcut('shrinkRegion');
			} else if (ctx.isShortcut(e, 'focusActiveTab')) {
				e.preventDefault();
				// First press parks focus on the active tab header. A second press has
				// nothing left to do (the tab is already focused and in view), so it
				// escalates to walking BACKWARD through unread/draft tabs - the mirror
				// of Opt+Cmd+Down, which walks forward.
				const alreadyParked = ctx.mainPanelRef?.current?.focusActiveTab() === true;
				if (alreadyParked) {
					ctx.goToPreviousUnreadTab?.();
					trackShortcut('previousUnreadTab');
				} else {
					trackShortcut('focusActiveTab');
				}
			} else if (ctx.isShortcut(e, 'searchAllTabs')) {
				// Resolve the agent from the store at event time rather than reading
				// `ctx.activeSession`. The keyboard context's shape is not stable across
				// branches (the multi-window work drops `activeSession` from the ref and
				// resolves it per event), and a missing property here made the guard
				// silently falsy - which, with preventDefault already called, swallowed
				// the keystroke with no visible effect.
				const searchSession = selectActiveSession(useSessionStore.getState());
				// Group chats have no AI tabs to search across. preventDefault only when
				// we actually act, so an inapplicable context falls through instead of
				// eating the key.
				if (!ctx.activeGroupChatId && searchSession?.aiTabs?.length) {
					e.preventDefault();
					ctx.handleOpenCrossTabSearch?.();
					trackShortcut('searchAllTabs');
				}
			} else if (ctx.isShortcut(e, 'viewGitDiff') && !ctx.activeGroupChatId) {
				e.preventDefault();
				ctx.handleViewGitDiff();
				trackShortcut('viewGitDiff');
			} else if (ctx.isShortcut(e, 'viewGitLog') && !ctx.activeGroupChatId) {
				e.preventDefault();
				if (activeSession?.isGitRepo) {
					ctx.setGitLogOpen(true);
					trackShortcut('viewGitLog');
				}
			} else if (ctx.isShortcut(e, 'gitPull') && !ctx.activeGroupChatId) {
				// The remaining branch-pill actions. All four fire the SAME action set
				// the pill menu and Cmd+K fire (published by GitShortcutActionsBridge),
				// so a chord can't drift from the menu row it mirrors. preventDefault
				// only once the agent is a git repo: on a non-git agent there is
				// nothing to run, and eating the key would be worse than passing it on.
				const git = getGitShortcutActions();
				if (git?.isGitRepo) {
					e.preventDefault();
					git.pull();
					trackShortcut('gitPull');
				}
			} else if (ctx.isShortcut(e, 'gitPush') && !ctx.activeGroupChatId) {
				const git = getGitShortcutActions();
				if (git?.isGitRepo) {
					e.preventDefault();
					git.push();
					trackShortcut('gitPush');
				}
			} else if (ctx.isShortcut(e, 'gitChangeBranch') && !ctx.activeGroupChatId) {
				const git = getGitShortcutActions();
				if (git?.isGitRepo) {
					e.preventDefault();
					git.switchBranch();
					trackShortcut('gitChangeBranch');
				}
			} else if (ctx.isShortcut(e, 'gitCreatePR') && !ctx.activeGroupChatId) {
				// canCreatePR, not isGitRepo: a repo with no resolved branch has no
				// source to open a PR from, which is the same reason the pill menu
				// omits the row.
				const git = getGitShortcutActions();
				if (git?.canCreatePR) {
					e.preventDefault();
					git.createPR();
					trackShortcut('gitCreatePR');
				}
			} else if (ctx.isShortcut(e, 'agentSessions')) {
				e.preventDefault();
				// Use capability check instead of hardcoded toolType
				if (ctx.hasActiveSessionCapability('supportsSessionStorage')) {
					ctx.setActiveAgentSessionId(null);
					ctx.setAgentSessionsOpen(true);
					trackShortcut('agentSessions');
				}
			} else if (ctx.isShortcut(e, 'openMemoryViewer')) {
				e.preventDefault();
				if (ctx.hasActiveSessionCapability('supportsProjectMemory')) {
					ctx.setMemoryViewerOpen(true);
					trackShortcut('openMemoryViewer');
				}
			} else if (ctx.isShortcut(e, 'systemLogs')) {
				e.preventDefault();
				ctx.setLogViewerOpen(true);
				trackShortcut('systemLogs');
			} else if (ctx.isShortcut(e, 'processMonitor')) {
				e.preventDefault();
				ctx.setProcessMonitorOpen(true);
				trackShortcut('processMonitor');
			} else if (ctx.isShortcut(e, 'usageDashboard') && ctx.encoreFeatures?.usageStats) {
				e.preventDefault();
				ctx.setUsageDashboardOpen(true);
				trackShortcut('usageDashboard');
			} else if (ctx.isShortcut(e, 'refreshGitFileState')) {
				e.preventDefault();
				// Same handler the Cmd+K entry runs, so the chord and the palette
				// cannot drift on what "refresh" reloads or what it flashes.
				void ctx.handleQuickActionsRefreshGitFileState?.();
				trackShortcut('refreshGitFileState');
			} else if (ctx.isShortcut(e, 'executionQueue')) {
				e.preventDefault();
				ctx.handleOpenQueueBrowser();
				trackShortcut('executionQueue');
			} else if (ctx.isShortcut(e, 'openSymphony') && ctx.encoreFeatures?.symphony) {
				e.preventDefault();
				ctx.setSymphonyModalOpen(true);
				trackShortcut('openSymphony');
			} else if (ctx.isShortcut(e, 'directorNotes') && ctx.encoreFeatures?.directorNotes) {
				e.preventDefault();
				ctx.setDirectorNotesOpen?.(true);
				trackShortcut('directorNotes');
			} else if (
				// A Ctrl+Cmd chord: isShortcut folds the two modifiers into one and
				// would fire this on plain Cmd+H (macOS Hide) and Ctrl+H.
				ctx.isPaneShortcut(e, 'computerHistory') &&
				canOpenComputerHistory(ctx.encoreFeatures)
			) {
				e.preventDefault();
				getModalActions().setComputerHistoryOpen(true);
				trackShortcut('computerHistory');
			} else if (ctx.isShortcut(e, 'openCue') && ctx.encoreFeatures?.maestroCue) {
				e.preventDefault();
				ctx.setCueModalOpen?.(true);
				trackShortcut('openCue');
			} else if (ctx.isShortcut(e, 'toggleConcerto') && ctx.encoreFeatures?.concerto) {
				// Toggle, not open: the stage is a window the user parks and brings
				// back, and its panels keep running either way.
				e.preventDefault();
				getModalActions().toggleConcertoStage();
				trackShortcut('toggleConcerto');
			} else if (ctx.isShortcut(e, 'toggleCadenzas') && ctx.encoreFeatures?.concerto) {
				e.preventDefault();
				toggleAllCadenzas();
				trackShortcut('toggleCadenzas');
			} else if (
				ctx.isShortcut(e, 'toggleThroughputGauge') &&
				ctx.encoreFeatures?.throughputGauge
			) {
				// Toggle the visibility latch only. Showing the card never moves focus,
				// so the composer keeps the caret.
				e.preventDefault();
				useThroughputGaugeStore.getState().toggle();
				trackShortcut('toggleThroughputGauge');
			} else if (ctx.isShortcut(e, 'nextUnreadTab')) {
				e.preventDefault();
				ctx.goToNextUnreadTab();
				trackShortcut('nextUnreadTab');
			} else if (ctx.isShortcut(e, 'previousUnreadTab')) {
				// Ships unbound - reachable via a second Opt+Cmd+Up or from Cmd+K -
				// but honored here for anyone who gives it a dedicated chord.
				e.preventDefault();
				ctx.goToPreviousUnreadTab?.();
				trackShortcut('previousUnreadTab');
			} else if (ctx.isShortcut(e, 'filterUnreadAgents')) {
				e.preventDefault();
				ctx.toggleShowUnreadAgentsOnly();
				trackShortcut('filterUnreadAgents');
			} else if (ctx.isShortcut(e, 'toggleUnreadFilters')) {
				e.preventDefault();
				toggleAllUnreadFilters();
				trackShortcut('toggleUnreadFilters');
			} else if (ctx.isShortcut(e, 'forcedParallelSend')) {
				// The composer owns this chord while the caret is inside it - only it
				// can read the live draft it may need to send. Everywhere else the
				// chord still has to work: with an empty draft it force-sends the
				// newest eligible QUEUED item, and the queue is drawn in the
				// transcript, so requiring focus in a textarea made the shortcut look
				// broken from the one place the user was actually looking at the thing
				// it acts on. The composer decides what to do with it (see
				// runForcedParallelSend); this branch only says the chord fired.
				const composerRef = ctx.activeGroupChatId ? ctx.groupChatInputRef : ctx.inputRef;
				const cameFromComposer = !!composerRef?.current && e.target === composerRef.current;
				if (!cameFromComposer && useSettingsStore.getState().forcedParallelExecution) {
					e.preventDefault();
					window.dispatchEvent(new CustomEvent(FORCED_PARALLEL_SEND_EVENT));
				}
			} else if (ctx.isShortcut(e, 'steerSend')) {
				// Same split as forcedParallelSend above: the composer answers the chord
				// itself while the caret is in it, and everywhere else the chord still
				// has to work, because the queued message it steers is drawn in the
				// transcript. A group chat has no running turn of this agent on screen.
				const cameFromComposer = !!ctx.inputRef?.current && e.target === ctx.inputRef.current;
				if (!cameFromComposer && !ctx.activeGroupChatId) {
					e.preventDefault();
					requestSteerSend();
				}
			} else if (ctx.isShortcut(e, 'jumpToBottom')) {
				e.preventDefault();
				// Jump to the bottom of the current main panel output (AI logs or terminal output)
				// Find the scroll container (parent of logsEndRef) and scroll to bottom
				// Using scrollTo() instead of scrollIntoView() for reliable scrolling in nested containers
				const scrollContainer = ctx.logsEndRef.current?.parentElement;
				if (scrollContainer) {
					scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'instant' });
				}
				trackShortcut('jumpToBottom');
			} else if (ctx.isShortcut(e, 'toggleMarkdownMode')) {
				// Toggle markdown raw mode for AI message history
				// Skip when in AutoRun panel (it has its own Cmd+E handler for edit/preview toggle)
				// Skip when Auto Run is running (editing is locked)
				// Note: FilePreview handles its own Cmd+E with stopPropagation when focused,
				// so if the event reaches here, the user isn't interacting with a file tab.
				// Check both state-based detection AND DOM-based detection for robustness
				// Who actually holds focus decides this, not the panel-selection state.
				//
				// Two defects lived in these three lines. `?.closest(...) !== null`
				// evaluated to `undefined !== null`, i.e. TRUE, whenever nothing was
				// focused - so a moment with no `document.activeElement` silently
				// claimed the caret was in Auto Run and swallowed the toggle. And
				// `activeFocus`/`activeRightTab` are a proxy: they describe which
				// panel was last selected, not where the caret is, so they can still
				// read 'right'/'autorun' while the user is reading the chat.
				//
				// DOM containment answers the real question, so it wins whenever
				// there is a genuine focus target. The state pair is consulted only
				// when nothing meaningful is focused and it is the sole signal left.
				const activeElement = document.activeElement;
				const hasRealFocus = activeElement instanceof Element && activeElement !== document.body;
				const isInAutoRunPanel = hasRealFocus
					? activeElement.closest('[data-tour="autorun-panel"]') !== null
					: ctx.activeFocus === 'right' && ctx.activeRightTab === 'autorun';
				// Check if Auto Run is running and editing is locked (running without worktree)
				const isAutoRunLocked =
					ctx.activeBatchRunState?.isRunning && !ctx.activeBatchRunState?.worktreeActive;
				if (!isInAutoRunPanel && !isAutoRunLocked) {
					e.preventDefault();
					// Toggle chat raw text mode (not file preview edit mode)
					ctx.setChatRawTextMode(!ctx.chatRawTextMode);
					trackShortcut('toggleMarkdownMode');
				}
			} else if (ctx.isShortcut(e, 'openBatchRunner')) {
				// Open the Auto Run run modal (BatchRunnerModal) - works from anywhere
				e.preventDefault();
				if (useSettingsStore.getState().autoRunDisabled) return;
				if (activeSession) {
					ctx.handleOpenBatchRunner();
					trackShortcut('openBatchRunner');
				}
			} else if (ctx.isShortcut(e, 'toggleAutoRunExpanded')) {
				// Toggle Auto Run expanded/contracted view. Works from anywhere so it
				// doubles as a quick scratch-pad surface (mirrors the command palette entry).
				e.preventDefault();
				if (useSettingsStore.getState().autoRunDisabled) return;
				ctx.rightPanelRef?.current?.toggleAutoRunExpanded();
				trackShortcut('toggleAutoRunExpanded');
			} else if (ctx.isShortcut(e, 'editLastQueuedMessage')) {
				// Open the edit modal on the newest queued message. The picking rules
				// and the "nothing to edit" reporting live in the service so this and
				// the palette's "Edit Last Queued Message" entry cannot disagree.
				e.preventDefault();
				if (requestEditLastQueuedMessage()) trackShortcut('editLastQueuedMessage');
			} else if (ctx.isShortcut(e, 'jumpToTerminal')) {
				e.preventDefault();
				if (activeSession && !ctx.activeGroupChatId) {
					const result = ctx.navigateToClosestTerminalTab(activeSession);
					if (result) {
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => (s.id === activeSession!.id ? result.session : s))
						);
						// Focus the terminal after switching
						setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
					} else if (ctx.activeSessionId) {
						// No terminal tabs exist - create one (same as Cmd+J / toggleMode)
						ctx.handleOpenTerminalTab();
						setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
					}
					trackShortcut('jumpToTerminal');
				}
			}

			// Ctrl+Shift+` - Create a new terminal tab (works regardless of inputMode)
			// Use e.code to reliably detect the backtick key (Shift+` produces ~ via e.key on US layout)
			if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
				e.preventDefault();
				if (ctx.activeSessionId) {
					// handleOpenTerminalTab creates the tab and sets inputMode:'terminal' automatically
					ctx.handleOpenTerminalTab();
				}
			}

			// Opt+Cmd+NUMBER: Jump to visible session by number (1-9, 0=10th)
			// Use e.code instead of e.key because Option key on macOS produces special characters
			const digitMatch = e.code?.match(/^Digit([0-9])$/);
			if (e.altKey && (e.metaKey || e.ctrlKey) && digitMatch) {
				e.preventDefault();
				const digit = digitMatch[1];
				const num = digit === '0' ? 10 : parseInt(digit, 10);
				const targetIndex = num - 1;
				if (targetIndex >= 0 && targetIndex < ctx.visibleSessions.length) {
					const targetSession = ctx.visibleSessions[targetIndex];
					ctx.setActiveSessionId(targetSession.id);
					// Jumping to the agent that is already active is not a switch, so ask
					// for the reveal explicitly; the Left Bar may be scrolled away from it.
					requestSidebarReveal();
					trackShortcut('jumpToSession');
					// Also expand sidebar if collapsed
					if (!ctx.leftSidebarOpen) {
						ctx.setLeftSidebarOpen(true);
					}
				}
			}

			// Zoom shortcuts: Cmd+= (in), Cmd+- (out), Cmd+Shift+0 (reset).
			//
			// These move `fontZoom`, a multiplier applied to every surface size
			// equally, NOT the interface size directly. Each surface now carries
			// its own size, and pushing the base around would have compressed
			// those differences on the way up and lost them entirely at the
			// clamp - so a user who set the terminal smaller than the chat would
			// watch that distinction dissolve after a few keypresses. A pure
			// multiplier preserves the ratios exactly and is perfectly
			// reversible, which is what makes the reset below able to restore
			// custom sizes rather than flatten them.
			if ((e.metaKey || e.ctrlKey) && !e.altKey) {
				// `+` is included regardless of Shift: US layouts only produce it
				// WITH Shift held, so Cmd+Shift+= (read as Cmd++) must still zoom in.
				if (e.key === '+' || (!e.shiftKey && e.key === '=')) {
					e.preventDefault();
					const { fontZoom, setFontZoom } = useSettingsStore.getState();
					const next = clampFontZoom(fontZoom + FONT_ZOOM_STEP);
					if (next !== fontZoom) setFontZoom(next);
					trackShortcut('fontSizeIncrease');
					return;
				}
				if (!e.shiftKey && e.key === '-') {
					e.preventDefault();
					const { fontZoom, setFontZoom } = useSettingsStore.getState();
					const next = clampFontZoom(fontZoom - FONT_ZOOM_STEP);
					if (next !== fontZoom) setFontZoom(next);
					trackShortcut('fontSizeDecrease');
					return;
				}
			}
			// Cmd+Shift+0: reset the zoom (Cmd+0 is reserved for "Go to Last Tab").
			// Resets ONLY the zoom, deliberately: the per-surface sizes are a
			// preference the user set in Settings, not zoom state, and wiping
			// them from a keystroke would be unrecoverable. Settings -> Display
			// has Factory Reset Fonts for that.
			if (ctx.isShortcut(e, 'fontSizeReset')) {
				e.preventDefault();
				const { fontZoom, setFontZoom } = useSettingsStore.getState();
				if (fontZoom !== FONT_ZOOM_DEFAULT) setFontZoom(FONT_ZOOM_DEFAULT);
				trackShortcut('fontSizeReset');
				return;
			}

			// A group chat has no AI tabs, so the tab-cycling chord is free there and
			// walks the Right Bar's two panels (Participants / History) instead. It
			// opens the Right Bar when it is closed: switching a pane the user cannot
			// see is indistinguishable from the shortcut doing nothing. Focus moves
			// with it so the panel it lands on answers the arrow keys straight away,
			// rather than needing a click first.
			if (ctx.activeGroupChatId) {
				const wantsTabCycle = ctx.isTabShortcut(e, 'nextTab') || ctx.isTabShortcut(e, 'prevTab');
				if (wantsTabCycle) {
					e.preventDefault();
					const { rightPanelOpen, setRightPanelOpen } = useUIStore.getState();
					if (!rightPanelOpen) setRightPanelOpen(true);
					toggleGroupChatRightTab();
					ctx.setActiveFocus('right');
					trackShortcut(ctx.isTabShortcut(e, 'nextTab') ? 'nextTab' : 'prevTab');
					return;
				}
			}

			// Unified tab shortcuts - works across ALL tab types (AI, file preview, terminal).
			// Terminal tabs are part of unifiedTabOrder and the navigation functions
			// (navigateToNextUnifiedTab, etc.) handle inputMode switching automatically.
			// Some shortcuts only apply in AI mode (e.g., newTab, toggleReadOnly) - those
			// are individually gated below. Navigation shortcuts work in ALL modes.
			// Use event-time activeSession only - do not mix with ctx.activeSessionId
			// from the last App render, which can lag a store switch by one frame.
			if (activeSession && !ctx.activeGroupChatId) {
				if (ctx.isTabShortcut(e, 'tabSwitcher')) {
					e.preventDefault();
					ctx.setTabSwitcherOpen(true);
					trackShortcut('tabSwitcher');
				}
				// Cmd+T: New AI tab (works in any mode including terminal)
				if (ctx.isTabShortcut(e, 'newTab')) {
					e.preventDefault();
					ctx.handleNewTab();
					// Auto-focus the input so user can start typing immediately once the
					// desktop-owned tab arrives in either renderer.
					ctx.setActiveFocus('main');
					setTimeout(() => ctx.inputRef.current?.focus(), FOCUS_AFTER_RENDER_DELAY_MS);
					trackShortcut('newTab');
				}
				// Alt+N: New file tab (works in any mode)
				if (ctx.isTabShortcut(e, 'newFileTab')) {
					e.preventDefault();
					ctx.handleNewFileTab();
					trackShortcut('newFileTab');
				}
				// Cmd+B: New browser tab (works in any mode)
				if (ctx.isTabShortcut(e, 'newBrowserTab')) {
					e.preventDefault();
					ctx.handleNewBrowserTab();
					trackShortcut('newBrowserTab');
				}
				// Cmd+L: Focus browser address bar (only when a browser tab is active)
				if (ctx.isTabShortcut(e, 'focusBrowserAddress') && activeSession?.activeBrowserTabId) {
					e.preventDefault();
					ctx.mainPanelRef?.current?.focusBrowserAddressBar();
					trackShortcut('focusBrowserAddress');
				}
				// Cmd+Left / Cmd+Right: Browser history back/forward when a browser
				// tab is active. We deliberately skip when focus is inside an
				// editable element (URL bar, find bar, any other text input) so
				// macOS line-navigation (Cmd+Left = beginning-of-line) keeps
				// working there. File preview's own keydown handler runs first
				// with stopPropagation when the preview is the active surface, so
				// this never collides with filePreviewBack/Forward.
				if (
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					(e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
					activeSession?.activeBrowserTabId &&
					!isEditableTarget
				) {
					e.preventDefault();
					if (e.key === 'ArrowLeft') {
						ctx.mainPanelRef?.current?.browserBack();
					} else {
						ctx.mainPanelRef?.current?.browserForward();
					}
					trackShortcut(e.key === 'ArrowLeft' ? 'navBack' : 'navForward');
					return;
				}
				// Cmd+R: Reload active browser tab (when a browser tab is active)
				if (
					ctx.isTabShortcut(e, 'toggleReadOnlyMode') &&
					activeSession?.activeBrowserTabId &&
					!e.shiftKey
				) {
					e.preventDefault();
					ctx.mainPanelRef?.current?.reloadBrowserTab();
					return;
				}
				// Cmd+W: Close the active tab (AI, file, browser, or terminal) via unified handler
				if (ctx.isTabShortcut(e, 'closeTab')) {
					e.preventDefault();
					const closeResult = ctx.handleCloseCurrentTab();

					if (closeResult.type === 'file') {
						trackShortcut('closeTab');
					} else if (closeResult.type === 'browser') {
						trackShortcut('closeTab');
					} else if (closeResult.type === 'terminal' && closeResult.tabId) {
						ctx.handleCloseTerminalTab(closeResult.tabId);
						trackShortcut('closeTab');
					} else if (closeResult.type === 'ai' && closeResult.tabId) {
						if (closeResult.hasWizardUserInteraction) {
							useModalStore.getState().openModal('confirm', {
								message: 'Close this wizard? Your progress will be lost and cannot be restored.',
								onConfirm: () => {
									ctx.performTabClose(closeResult.tabId);
									trackShortcut('closeTab');
								},
							});
						} else if (closeResult.isWizardTab) {
							// Wizard active but no user interaction - close without confirmation
							ctx.performTabClose(closeResult.tabId);
							trackShortcut('closeTab');
						} else if (closeResult.hasDraft) {
							useModalStore.getState().openModal('confirm', {
								message: 'This tab has an unsent draft. Are you sure you want to close it?',
								onConfirm: () => {
									ctx.performTabClose(closeResult.tabId);
									trackShortcut('closeTab');
								},
							});
						} else {
							ctx.performTabClose(closeResult.tabId);
							trackShortcut('closeTab');
						}
					}
					// 'prevented' or 'none' - do nothing
				}
				// Bulk close shortcuts (AI mode only - terminal tabs don't have bulk close)
				if (activeSession.inputMode === 'ai') {
					// Snooze the active AI tab (Opt+Cmd+S). AI-only: file, terminal, and
					// browser tabs have no conversation to come back to.
					if (ctx.isTabShortcut(e, 'snoozeTab')) {
						e.preventDefault();
						const tab = activeSession.aiTabs?.find(
							(t: AITab) => t.id === activeSession.activeTabId
						);
						const target = tab ? resolveSnoozeTarget(activeSession, tab.id) : null;
						if (target) {
							useModalStore.getState().openModal('snoozeTab', target);
							trackShortcut('snoozeTab');
						}
					}
					if (ctx.isTabShortcut(e, 'closeAllTabs')) {
						e.preventDefault();
						ctx.handleCloseAllTabs();
						trackShortcut('closeAllTabs');
					}
					if (ctx.isTabShortcut(e, 'closeOtherTabs')) {
						e.preventDefault();
						if (activeSession.aiTabs.length > 1) {
							ctx.handleCloseOtherTabs();
							trackShortcut('closeOtherTabs');
						}
					}
					if (ctx.isTabShortcut(e, 'closeTabsLeft')) {
						e.preventDefault();
						const activeTabIndex = activeSession.aiTabs.findIndex(
							(t: AITab) => t.id === activeSession.activeTabId
						);
						if (activeTabIndex > 0) {
							ctx.handleCloseTabsLeft();
							trackShortcut('closeTabsLeft');
						}
					}
					if (ctx.isTabShortcut(e, 'closeTabsRight')) {
						e.preventDefault();
						const activeTabIndex = activeSession.aiTabs.findIndex(
							(t: AITab) => t.id === activeSession.activeTabId
						);
						if (activeTabIndex < activeSession.aiTabs.length - 1) {
							ctx.handleCloseTabsRight();
							trackShortcut('closeTabsRight');
						}
					}
				}
				if (ctx.isTabShortcut(e, 'reopenClosedTab')) {
					e.preventDefault();
					if (reopenDesktopTabIfNeeded(activeSession)) {
						trackShortcut('reopenClosedTab');
					} else {
						const result = ctx.reopenUnifiedClosedTab(activeSession);
						if (result) {
							ctx.setSessions((prev: Session[]) =>
								prev.map((s: Session) => (s.id === activeSession!.id ? result.session : s))
							);
							trackShortcut('reopenClosedTab');
						}
					}
				}
				if (ctx.isTabShortcut(e, 'renameTab')) {
					e.preventDefault();
					// Group-aware: with a tiled group active this targets its FOCUSED PANE,
					// so renaming a terminal/browser/file tile actually renames that tile
					// instead of the AI tab hidden behind the group.
					const renameRef = resolveActiveTabRef(activeSession);
					const renameValue = renameRef ? resolveTabRefRenameValue(activeSession, renameRef) : null;
					if (renameRef && renameValue !== null) {
						ctx.setRenameTabId(renameRef.id);
						ctx.setRenameTabInitialName(renameValue);
						ctx.setRenameTabModalOpen(true);
						trackShortcut('renameTab');
					}
				}
				// AI-tab-specific metadata toggles (read-only, save-to-history,
				// show-thinking). These only make sense when an AI chat tab is the
				// active tab. inputMode alone is insufficient: file and browser tabs
				// keep inputMode 'ai' (only terminal flips it), so without also
				// excluding active file/browser tabs these shortcuts would silently
				// mutate the last-visited AI tab while the user is looking at a file.
				const isAiChatTabActive =
					activeSession.inputMode === 'ai' &&
					!activeSession.activeFileTabId &&
					!activeSession.activeBrowserTabId;
				if (isAiChatTabActive) {
					if (ctx.isTabShortcut(e, 'toggleReadOnlyMode')) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => {
								if (s.id !== activeSession!.id) return s;
								return {
									...s,
									aiTabs: s.aiTabs.map((tab: AITab) =>
										tab.id === s.activeTabId ? { ...tab, ...toggleReadOnlyModeFields(tab) } : tab
									),
								};
							})
						);
						trackShortcut('toggleReadOnlyMode');
					}
					if (ctx.isTabShortcut(e, 'toggleSaveToHistory')) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => {
								if (s.id !== activeSession!.id) return s;
								return {
									...s,
									aiTabs: s.aiTabs.map((tab: AITab) =>
										tab.id === s.activeTabId ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
									),
								};
							})
						);
						trackShortcut('toggleSaveToHistory');
					}
					if (ctx.isTabShortcut(e, 'toggleShowThinking')) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => {
								if (s.id !== activeSession!.id) return s;
								return {
									...s,
									aiTabs: s.aiTabs.map((tab: AITab) => {
										if (tab.id !== s.activeTabId) return tab;
										if (tab.wizardState?.isActive) {
											return {
												...tab,
												wizardState: {
													...tab.wizardState,
													showWizardThinking: !tab.wizardState.showWizardThinking,
													thinkingContent: !tab.wizardState.showWizardThinking
														? ''
														: tab.wizardState.thinkingContent,
												},
											};
										}
										return { ...tab, ...cycleShowThinkingFields(tab) };
									}),
								};
							})
						);
						trackShortcut('toggleShowThinking');
					}
				}
				// Unread filter/toggle - works across ALL tab types (AI, file, terminal)
				if (ctx.isTabShortcut(e, 'filterUnreadTabs')) {
					e.preventDefault();
					ctx.toggleUnreadFilter();
					trackShortcut('filterUnreadTabs');
				}
				if (ctx.isTabShortcut(e, 'toggleTabUnread')) {
					e.preventDefault();
					ctx.toggleTabUnread();
					trackShortcut('toggleTabUnread');
				}
				// Cmd+Shift+] / Cmd+Shift+[ - Navigate tabs in unified order
				// Cycles through ALL tab types (AI, file, terminal) via unifiedTabOrder
				if (ctx.isTabShortcut(e, 'nextTab')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const result = ctx.navigateToNextUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						if (result.type === 'ai' && !isWebDesktop()) {
							noteDesktopAiTabSelection(current.id, result.id);
						}
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('nextTab');
				}
				if (ctx.isTabShortcut(e, 'prevTab')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const result = ctx.navigateToPrevUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						if (result.type === 'ai' && !isWebDesktop()) {
							noteDesktopAiTabSelection(current.id, result.id);
						}
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('prevTab');
				}
				// Cmd+Shift+Left / Cmd+Shift+Right - Move the active tab to the first /
				// last position. Works for ALL tab kinds (AI, file, browser, terminal)
				// since it reorders unifiedTabOrder directly.
				if (ctx.isTabShortcut(e, 'moveTabToStart')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const updated = moveActiveUnifiedTabToEdge(current, 'start');
						if (updated === current) return prev;
						return prev.map((s: Session) => (s.id === current.id ? updated : s));
					});
					trackShortcut('moveTabToStart');
				}
				if (ctx.isTabShortcut(e, 'moveTabToEnd')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const updated = moveActiveUnifiedTabToEdge(current, 'end');
						if (updated === current) return prev;
						return prev.map((s: Session) => (s.id === current.id ? updated : s));
					});
					trackShortcut('moveTabToEnd');
				}
				// Move the active tab one VISIBLE position. Ships unassigned, so this
				// only fires once the user binds a chord (or switches to a mode that
				// does). Clamps at both ends rather than wrapping - see
				// moveActiveUnifiedTabByOne.
				if (ctx.isTabShortcut(e, 'moveTabLeft')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const updated = moveActiveUnifiedTabByOne(current, 'left');
						if (updated === current) return prev;
						return prev.map((s: Session) => (s.id === current.id ? updated : s));
					});
					trackShortcut('moveTabLeft');
				}
				if (ctx.isTabShortcut(e, 'moveTabRight')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const updated = moveActiveUnifiedTabByOne(current, 'right');
						if (updated === current) return prev;
						return prev.map((s: Session) => (s.id === current.id ? updated : s));
					});
					trackShortcut('moveTabRight');
				}
				// Cmd+1-9, Cmd+0 - Jump to tab by index in unified order.
				// In unread-only mode, index into the filtered/visible tabs so Cmd+N matches
				// the Nth tab currently shown in the tab bar (not the Nth tab overall).
				// When useCmd0AsLastTab is off, fall back to browser-style mapping:
				// Cmd+1-8 jump to tabs 1-8, Cmd+9 jumps to the last tab, Cmd+0 is unused.
				const useCmd0AsLastTab = useSettingsStore.getState().useCmd0AsLastTab;
				const maxNumberedTab = useCmd0AsLastTab ? 9 : 8;
				for (let i = 1; i <= maxNumberedTab; i++) {
					if (ctx.isTabShortcut(e, `goToTab${i}`)) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) => {
							const current = prev.find((s: Session) => s.id === activeSession.id);
							if (!current) return prev;
							const result = ctx.navigateToUnifiedTabByIndex(current, i - 1, ctx.showUnreadOnly);
							if (!result) return prev;
							if (result.type === 'ai' && !isWebDesktop()) {
								noteDesktopAiTabSelection(current.id, result.id);
							}
							return prev.map((s: Session) => (s.id === current.id ? result.session : s));
						});
						trackShortcut(`goToTab${i}`);
						break;
					}
				}
				const lastTabActionId = useCmd0AsLastTab ? 'goToLastTab' : 'goToTab9';
				if (ctx.isTabShortcut(e, lastTabActionId)) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === activeSession.id);
						if (!current) return prev;
						const result = ctx.navigateToLastUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						if (result.type === 'ai' && !isWebDesktop()) {
							noteDesktopAiTabSelection(current.id, result.id);
						}
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('goToLastTab');
				}
			}

			// Cmd+F contextual shortcuts - prioritize explicit focus over input mode.
			// Alt is excluded: Opt+Cmd+F is searchAllTabs (cross-tab message search)
			// and must not also open in-tab Find, group Find, Files filter, or
			// terminal/browser find.
			if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				// Browser-tab in-page find takes precedence whenever a browser tab is
				// the active tab. Routed both here (when webview isn't focused) and via
				// `onBrowserTabShortcutKey` (when it is).
				if (activeSession?.activeBrowserTabId) {
					e.preventDefault();
					ctx.mainPanelRef?.current?.openBrowserFind();
					trackShortcut('searchOutput');
					return;
				}
				if (ctx.activeFocus === 'right' && ctx.activeRightTab === 'files') {
					e.preventDefault();
					if (!ctx.fileTreeFilterOpen) {
						ctx.setFileTreeFilterOpen(true);
					}
					// Re-focus the filter input (and put the caret at the end of any
					// existing query) so Cmd+F while the filter is already open but
					// focus has moved into the file list pulls focus back here.
					setTimeout(() => {
						const input = ctx.fileTreeFilterInputRef?.current;
						if (!input) return;
						input.focus();
						const len = input.value.length;
						input.setSelectionRange(len, len);
					}, 0);
					trackShortcut('filterFiles');
				} else if (ctx.activeFocus === 'sidebar') {
					// Sidebar filter - handled by SessionList component, just track here
					trackShortcut('filterSessions');
				} else if (ctx.activeFocus === 'right' && ctx.activeRightTab === 'history') {
					// History filter - handled by HistoryPanel component, just track here
					trackShortcut('filterHistory');
				} else if (activeSession?.inputMode === 'terminal') {
					// Terminal search - works whether xterm is focused or not. xterm forwards
					// Cmd+F via attachCustomKeyEventHandler (re-dispatching a synthetic event on
					// window) so this branch handles both the direct and forwarded cases.
					e.preventDefault();
					ctx.mainPanelRef?.current?.openTerminalSearch();
					trackShortcut('searchTerminal');
				} else if (ctx.activeGroupChatId) {
					// Group chat replaces MainPanel/TerminalOutput, so Find must open here.
					// When the Right Bar history tab is focused, leave Cmd+F to that panel's filter.
					const groupRightTab = useGroupChatStore.getState().groupChatRightTab;
					if (ctx.activeFocus === 'right' && groupRightTab === 'history') {
						trackShortcut('filterHistory');
					} else {
						e.preventDefault();
						useUIStore
							.getState()
							.setOutputSearchOpen(groupChatOutputSearchKey(ctx.activeGroupChatId), true);
						trackShortcut('searchOutput');
					}
				} else if (ctx.activeFocus === 'main') {
					// Main panel search - handled by TerminalOutput component, just track here
					trackShortcut('searchOutput');
				}
			}
		};
		// A half-typed sequence does not survive the window losing focus: the keys
		// that would finish it are going somewhere else now. The lazy timeout
		// would expire it a second later anyway, but the prefix indicator is a
		// painted thing and would otherwise sit on screen over a window that no
		// longer has the keyboard, so the chip is taken down with the run.
		const handleBlur = () => {
			sequenceMatcher.reset();
			publishPrefix();
			// The in-field escape goes with it, and for a second reason: the run
			// holds a reference to the field it started in, and the window losing
			// focus is the clearest signal that the keys finishing it are going
			// somewhere else.
			endInsertEscapeRun();
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('blur', handleBlur);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('blur', handleBlur);
		};
	}, []); // Empty dependencies - handler reads from ref

	// Browser tab shortcut forwarding: the main process intercepts shortcuts
	// via before-input-event on webview guest contents and sends them here
	// over IPC.  We blur the webview and re-dispatch so the main keyboard
	// handler (above) processes them like any other shortcut.
	useEffect(() => {
		if (!window.maestro?.app?.onBrowserTabShortcutKey) return;
		return window.maestro.app.onBrowserTabShortcutKey((input) => {
			if (document.activeElement?.tagName === 'WEBVIEW') {
				(document.activeElement as HTMLElement).blur();
			}

			// Handle browser address bar focus directly: build a synthetic event
			// for isTabShortcut matching, then focus the address bar without
			// re-dispatching through the main handler (which may be blocked
			// by the overlay/modal shortcut guard).
			const ctx = keyboardHandlerRef.current;
			const activeSession = selectActiveSession(useSessionStore.getState());
			if (activeSession?.activeBrowserTabId) {
				const probe = new KeyboardEvent('keydown', {
					key: input.key,
					code: input.code,
					metaKey: input.meta,
					ctrlKey: input.control,
					altKey: input.alt,
					shiftKey: input.shift,
				});
				if (ctx?.isTabShortcut(probe, 'focusBrowserAddress')) {
					ctx.mainPanelRef?.current?.focusBrowserAddressBar();
					return;
				}
				// Cmd+F arrives here when forwarded from the webview guest. Open the
				// in-page find bar directly instead of re-dispatching through the
				// window keydown handler (which would land in the activeFocus-gated
				// Cmd+F switch below and miss the browser-tab case).
				if (
					(input.meta || input.control) &&
					!input.alt &&
					!input.shift &&
					(input.key === 'f' || input.key === 'F')
				) {
					ctx?.mainPanelRef?.current?.openBrowserFind();
					return;
				}
				// Cmd+Left / Cmd+Right forwarded from the webview guest → browser
				// history back/forward. Routed directly so the overlay-guard /
				// re-dispatch path never sees it.
				if (
					(input.meta || input.control) &&
					!input.alt &&
					!input.shift &&
					(input.key === 'ArrowLeft' || input.key === 'ArrowRight')
				) {
					if (input.key === 'ArrowLeft') {
						ctx?.mainPanelRef?.current?.browserBack();
					} else {
						ctx?.mainPanelRef?.current?.browserForward();
					}
					return;
				}
				// Cmd+Shift+, / Cmd+Shift+. forwarded from the webview guest →
				// breadcrumb back/forward through visited tabs. Handled directly
				// because a synthetic window event from a focused webview doesn't
				// reliably reach the navBack/navForward branch of the window handler.
				if (ctx?.isShortcut(probe, 'navBack')) {
					ctx.handleNavBack();
					return;
				}
				if (ctx?.isShortcut(probe, 'navForward')) {
					ctx.handleNavForward();
					return;
				}
			}

			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: input.key,
					code: input.code,
					metaKey: input.meta,
					ctrlKey: input.control,
					altKey: input.alt,
					shiftKey: input.shift,
					bubbles: true,
					cancelable: true,
				})
			);
		});
	}, []);

	// Track Opt+Cmd modifier keys to show session jump number badges
	// Uses ref to read current state without adding it to deps (avoids re-registering
	// listeners every time the modifier state toggles)
	const showSessionJumpNumbersRef = useRef(false);
	showSessionJumpNumbersRef.current = showSessionJumpNumbers;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Show number badges when Opt+Cmd is held (but no number pressed yet)
			if (e.altKey && (e.metaKey || e.ctrlKey) && !showSessionJumpNumbersRef.current) {
				setShowSessionJumpNumbers(true);
			}
		};

		const handleKeyUp = (e: KeyboardEvent) => {
			// Hide number badges when either modifier is released
			if (!e.altKey || (!e.metaKey && !e.ctrlKey)) {
				setShowSessionJumpNumbers(false);
			}
		};

		// Also hide when window loses focus
		const handleBlur = () => {
			setShowSessionJumpNumbers(false);
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', handleBlur);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', handleBlur);
		};
	}, []); // Empty deps - reads state via ref

	return {
		keyboardHandlerRef,
		showSessionJumpNumbers,
	};
}
