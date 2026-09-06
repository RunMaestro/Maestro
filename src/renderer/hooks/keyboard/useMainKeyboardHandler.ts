import { useEffect, useRef, useState } from 'react';
import type { Session, AITab } from '../../types';
import {
	cycleShowThinkingFields,
	moveActiveUnifiedTabToEdge,
	toggleReadOnlyModeFields,
} from '../../utils/tabHelpers';
import { resolveActiveTabRef, resolveTabRefRenameValue } from '../../utils/panelLayout';
import { DESTINATION_SHORTCUT_IDS, getModalActions, useModalStore } from '../../stores/modalStore';
import { toggleAllCadenzas } from '../../stores/cadenzaStore';
import { requestEditLastQueuedMessage } from '../../services/editQueuedMessage';
import { requestOpenStagedImagesOrganizer } from '../../services/stagedImagesOrganizer';
import { toggleAllUnreadFilters } from '../../services/unreadFilters';
import { useNotificationStore } from '../../stores/notificationStore';
import { useMediaPlaybackStore } from '../../stores/mediaPlaybackStore';
import { stepMediaItem } from '../../utils/mediaItems';
import { resolveSnoozeTarget } from '../../utils/snoozeHelpers';
import { selectActiveSession, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { FONT_ZOOM_DEFAULT, FONT_ZOOM_STEP, clampFontZoom } from '../../../shared/typography';
import { useUIStore } from '../../stores/uiStore';
import { groupChatOutputSearchKey, isActiveOutputSearchOpen } from '../../utils/outputSearch';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { toggleGroupChatRightTab } from '../../utils/groupChatRightTab';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../ui/useOutputSearchLayer';
import { tileNewTabInSession } from '../../services/tileNewTabAction';
import type { TileableTabKind } from '../tabs/tileNewTab';
import { isMacOSPlatform } from '../../utils/platformUtils';
import { editClipboardImage } from '../../components/ImageAnnotator/editClipboardImage';
import { FORCED_PARALLEL_SEND_EVENT } from '../input/useInputKeyDown';
import { isWebDesktop } from '../../utils/runtimeContext';
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

export type KeyboardHandlerContext = any;

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
			const ctx = keyboardHandlerRef.current;
			if (!ctx) return;
			const activeSession = selectActiveSession(useSessionStore.getState());

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
			const isMac = isMacOSPlatform();
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

			if (ctx.hasOpenLayers()) {
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
				// Next unread / draft tab is benign navigation, so it stays live behind a
				// modal. Resolved by SHORTCUT ID rather than by key, for two reasons: it
				// has already moved combos once and the hard-coded arrow left behind by
				// that move silently stopped matching it, and a user who REBINDS it would
				// otherwise get a shortcut that dies the moment any modal is open -
				// including the Shortcuts settings pane they rebound it in.
				const isNextUnreadTabShortcut = ctx.isShortcut(e, 'nextUnreadTab');
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
				// Allow font size shortcuts (Cmd+=/+, Cmd+-, Cmd+0) even when modals/overlays are open
				const isFontSizeShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					(e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0');
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
			if (ctx.editingSessionId || ctx.editingGroupId) {
				return;
			}

			// Keyboard navigation handlers from useKeyboardNavigation hook
			// Sidebar navigation with arrow keys (works when sidebar has focus)
			if (ctx.handleSidebarNavigation(e)) return;

			// Enter to load selected session from sidebar
			if (ctx.handleEnterToActivate(e)) return;

			// Tab navigation between panels
			if (ctx.handleTabNavigation(e)) return;

			// Escape in main area focuses terminal output
			if (ctx.handleEscapeInMain(e)) return;

			// Which "Tile New ... Below" command this event matches, if any. Resolved
			// once here rather than as four more links in the else-if chain below.
			// isPaneShortcut, not isShortcut: the family lives on Ctrl+Cmd and the
			// general matcher treats Ctrl and Cmd as the same modifier, so it would
			// report a match on a bare Cmd+T.
			const matchedTile = TILE_SHORTCUTS.find((t) => ctx.isPaneShortcut(e, t.shortcutId)) ?? null;

			// Helper to track shortcut usage for keyboard mastery gamification
			// AND for the daily-usage time series shown on the Usage Dashboard.
			// Mastery is short-circuited on second+ firings of the same shortcut
			// (it's a unique-set), but the daily counter increments every time.
			const trackShortcut = (shortcutId: string) => {
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
			} else if (ctx.isShortcut(e, 'newInstance')) {
				e.preventDefault();
				// Cmd+N goes directly to manual agent creation, bypassing the choice modal
				useModalStore.getState().openModal('newInstance', { duplicatingSessionId: null });
				trackShortcut('newInstance');
			} else if (ctx.isShortcut(e, 'newGroupChat')) {
				e.preventDefault();
				ctx.setShowNewGroupChatModal(true);
				trackShortcut('newGroupChat');
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
				// AI-only: a file, terminal, or browser tab has no model to retune.
				// Resolved through resolveActiveTabRef so a focused pane in a tiled
				// group is retuned rather than the standalone tab hidden behind it.
				const modelEffortRef = activeSession ? resolveActiveTabRef(activeSession) : null;
				if (modelEffortRef?.type === 'ai') {
					useModalStore.getState().openModal('modelEffort', { tabId: modelEffortRef.id });
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
			} else if (ctx.isShortcut(e, 'focusActiveTab')) {
				e.preventDefault();
				ctx.mainPanelRef?.current?.focusActiveTab();
				trackShortcut('focusActiveTab');
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
			} else if (ctx.isShortcut(e, 'nextUnreadTab')) {
				e.preventDefault();
				ctx.goToNextUnreadTab();
				trackShortcut('nextUnreadTab');
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
				const isInAutoRunPanel = ctx.activeFocus === 'right' && ctx.activeRightTab === 'autorun';
				// Also check if the focused element is within an autorun panel (handles edge cases where activeFocus state may be stale)
				const activeElement = document.activeElement;
				const isInAutoRunDOM = activeElement?.closest('[data-tour="autorun-panel"]') !== null;
				// Check if Auto Run is running and editing is locked (running without worktree)
				const isAutoRunLocked =
					ctx.activeBatchRunState?.isRunning && !ctx.activeBatchRunState?.worktreeActive;
				if (!isInAutoRunPanel && !isInAutoRunDOM && !isAutoRunLocked) {
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
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				if (e.key === '=' || e.key === '+') {
					e.preventDefault();
					const { fontZoom, setFontZoom } = useSettingsStore.getState();
					const next = clampFontZoom(fontZoom + FONT_ZOOM_STEP);
					if (next !== fontZoom) setFontZoom(next);
					trackShortcut('fontSizeIncrease');
					return;
				}
				if (e.key === '-') {
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
					const result = ctx.reopenUnifiedClosedTab(activeSession);
					if (result) {
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => (s.id === activeSession!.id ? result.session : s))
						);
						trackShortcut('reopenClosedTab');
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
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
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
