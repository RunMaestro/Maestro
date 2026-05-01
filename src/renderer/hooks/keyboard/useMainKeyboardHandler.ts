import { useEffect, useRef, useState } from 'react';
import type { Session, AITab, ThinkingMode } from '../../types';
import { getInitialRenameValue } from '../../utils/tabHelpers';
import { useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';

// Font size keyboard shortcut constants
const FONT_SIZE_STEP = 2;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_DEFAULT = 14;

/**
 * Context object passed to the main keyboard handler via ref.
 * Uses 'any' type to avoid complex type dependencies on App.tsx internals.
 * The actual shape matches what App.tsx assigns to keyboardHandlerRef.current.
 *
 * Key properties include:
 * - isShortcut, isTabShortcut: Shortcut matching functions
 * - sessions, activeSession, activeSessionId: Session state
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
			// accessing current state values
			const ctx = keyboardHandlerRef.current;
			if (!ctx) return;

			// Terminal focus recovery: if a key event reaches this window handler while in
			// terminal mode, xterm's textarea likely lost focus. Recover early (before any
			// global shortcut/navigation logic) so arrow keys and editor escape paths still
			// work in interactive TUIs like vi/vim/nano.
			const isTerminalRecoveryContext =
				ctx.activeSession?.inputMode === 'terminal' &&
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
					const tabId = ctx.activeSession.activeTerminalTabId;
					if (tabId) {
						const termSid = `${ctx.activeSession.id}-terminal-${tabId}`;
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
			const isMac = navigator.platform.toUpperCase().includes('MAC');
			if (
				isMac &&
				ctx.activeSession?.inputMode === 'terminal' &&
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
				const tabId = ctx.activeSession.activeTerminalTabId;
				if (tabId && e.key.length === 1) {
					const code = e.key.toUpperCase().charCodeAt(0);
					if (code >= 65 && code <= 90) {
						e.preventDefault();
						const termSid = `${ctx.activeSession.id}-terminal-${tabId}`;
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
				// Allow sidebar toggle shortcuts (Alt+Cmd+Arrow) and next-unread (Alt+Cmd+ArrowDown) even when modals are open
				const isLayoutShortcut =
					e.altKey &&
					(e.metaKey || e.ctrlKey) &&
					(e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowDown');
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
				// Allow system utility shortcuts (Alt+Cmd+L for logs, Alt+Cmd+P for processes, Alt+Cmd+S for auto-scroll toggle) even when modals are open
				// NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters (e.g., Alt+P = π)
				const codeKeyLower = e.code?.replace('Key', '').toLowerCase() || '';
				const isSystemUtilShortcut =
					e.altKey &&
					(e.metaKey || e.ctrlKey) &&
					(codeKeyLower === 'l' ||
						codeKeyLower === 'p' ||
						codeKeyLower === 'u' ||
						codeKeyLower === 's');
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
					ctx.isTabShortcut(e, 'focusBrowserAddress') && !!ctx.activeSession?.activeBrowserTabId;
				// Allow font size shortcuts (Cmd+=/+, Cmd+-, Cmd+0) even when modals/overlays are open
				const isFontSizeShortcut =
					(e.metaKey || e.ctrlKey) &&
					!e.altKey &&
					!e.shiftKey &&
					(e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0');

				if (ctx.hasOpenModal()) {
					// TRUE MODAL is open - block most shortcuts from App.tsx
					// The modal's own handler will handle Cmd+Shift+[] if it supports it
					// BUT allow layout shortcuts (sidebar toggles), system utility shortcuts, session jump,
					// jumpToBottom, jumpToTerminal, markdown toggle, and font size to work (these are benign navigation/viewing preferences)
					if (
						!isLayoutShortcut &&
						!isSystemUtilShortcut &&
						!isSessionJumpShortcut &&
						!isJumpToBottomShortcut &&
						!isJumpToTerminalShortcut &&
						!isMarkdownToggleShortcut &&
						!isFontSizeShortcut
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
						!isRightPanelShortcut &&
						!isSystemUtilShortcut &&
						!isSessionJumpShortcut &&
						!isJumpToBottomShortcut &&
						!isJumpToTerminalShortcut &&
						!isMarkdownToggleShortcut &&
						!isTabManagementShortcut &&
						!isTabSwitcherShortcut &&
						!isToggleModeShortcut &&
						!isBrowserAddressShortcut &&
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

			// Helper to track shortcut usage for keyboard mastery gamification
			const trackShortcut = (shortcutId: string) => {
				if (ctx.recordShortcutUsage) {
					const result = ctx.recordShortcutUsage(shortcutId);
					if (result.newLevel !== null && ctx.onKeyboardMasteryLevelUp) {
						ctx.onKeyboardMasteryLevelUp(result.newLevel);
					}
				}
			};

			// General shortcuts
			// Only allow collapsing left sidebar when there are sessions (prevent collapse on empty state)
			if (ctx.isShortcut(e, 'toggleSidebar')) {
				if (ctx.sessions.length > 0 || !ctx.leftSidebarOpen) {
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
				if (ctx.activeSession) {
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
				// Disable mode toggle for wizard tabs - they have a unique input that doesn't support CLI switchover
				const activeTab = ctx.activeSession?.aiTabs?.find(
					(t: AITab) => t.id === ctx.activeSession?.activeTabId
				);
				if (activeTab?.wizardState?.isActive) return;
				e.preventDefault();
				if (ctx.activeSessionId) {
					// Cmd+J always opens a new terminal tab (analogous to Cmd+T for AI tabs).
					// handleOpenTerminalTab creates the tab and sets inputMode:'terminal' automatically.
					ctx.handleOpenTerminalTab();
					setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
				} else {
					// Auto-focus the input so user can start typing immediately
					ctx.setActiveFocus('main');
					setTimeout(() => ctx.inputRef.current?.focus(), FOCUS_AFTER_RENDER_DELAY_MS);
				}
				trackShortcut('toggleMode');
			} else if (ctx.isShortcut(e, 'agentSwitcher')) {
				e.preventDefault();
				if (ctx.sessions.length > 0) {
					ctx.setQuickActionOpen(true, 'agents');
					trackShortcut('agentSwitcher');
				}
			} else if (ctx.isShortcut(e, 'quickAction')) {
				e.preventDefault();
				if (ctx.sessions.length > 0) {
					ctx.setQuickActionOpen(true, 'main');
					trackShortcut('quickAction');
				}
			} else if (
				ctx.isShortcut(e, 'clearTerminal') &&
				ctx.activeSession?.inputMode === 'terminal'
			) {
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
				ctx.setSettingsTab('general');
				trackShortcut('settings');
			} else if (ctx.isShortcut(e, 'agentSettings')) {
				// Open agent settings for the current session
				if (ctx.activeSession) {
					ctx.setEditAgentSession(ctx.activeSession);
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
				if (ctx.activeSession) {
					ctx.setFuzzyFileSearchOpen(true);
					trackShortcut('fuzzyFileSearch');
				}
			} else if (ctx.isShortcut(e, 'toggleBookmark')) {
				e.preventDefault();
				if (ctx.activeSession) {
					ctx.toggleBookmark(ctx.activeSession.id);
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
			} else if (ctx.isShortcut(e, 'toggleTabStar')) {
				e.preventDefault();
				ctx.toggleTabStar();
				trackShortcut('toggleTabStar');
			} else if (ctx.isShortcut(e, 'openPromptComposer')) {
				e.preventDefault();
				// Only open in AI mode
				if (ctx.activeSession?.inputMode === 'ai') {
					ctx.setPromptComposerOpen(true);
					trackShortcut('openPromptComposer');
				}
			} else if (ctx.isShortcut(e, 'openWizard')) {
				e.preventDefault();
				ctx.openWizardModal();
				trackShortcut('openWizard');
			} else if (ctx.isShortcut(e, 'focusInput')) {
				e.preventDefault();
				// In terminal mode, Cmd+. focuses the active xterm instance so the user
				// can resume typing shell commands — mirrors AI mode's input focus toggle.
				if (ctx.activeSession?.inputMode === 'terminal') {
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
			} else if (ctx.isShortcut(e, 'viewGitDiff') && !ctx.activeGroupChatId) {
				e.preventDefault();
				ctx.handleViewGitDiff();
				trackShortcut('viewGitDiff');
			} else if (ctx.isShortcut(e, 'viewGitLog') && !ctx.activeGroupChatId) {
				e.preventDefault();
				if (ctx.activeSession?.isGitRepo) {
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
			} else if (ctx.isShortcut(e, 'openAgentDispatch') && ctx.encoreFeatures?.agentDispatch) {
				e.preventDefault();
				ctx.setAgentDispatchOpen?.(true);
				trackShortcut('openAgentDispatch');
			} else if (ctx.isShortcut(e, 'openDeliveryPlanner') && ctx.encoreFeatures?.deliveryPlanner) {
				e.preventDefault();
				ctx.setDeliveryPlannerOpen?.(true);
				trackShortcut('openDeliveryPlanner');
			} else if (
				ctx.isShortcut(e, 'openPlanningPipeline') &&
				ctx.encoreFeatures?.planningPipeline
			) {
				e.preventDefault();
				ctx.setPlanningPipelineOpen?.(true);
				trackShortcut('openPlanningPipeline');
			} else if (ctx.isShortcut(e, 'nextUnreadTab')) {
				e.preventDefault();
				ctx.goToNextUnreadTab();
				trackShortcut('nextUnreadTab');
			} else if (ctx.isShortcut(e, 'filterUnreadAgents')) {
				e.preventDefault();
				ctx.toggleShowUnreadAgentsOnly();
				trackShortcut('filterUnreadAgents');
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
			} else if (ctx.isShortcut(e, 'toggleAutoRunExpanded')) {
				// Toggle Auto Run expanded/contracted view
				e.preventDefault();
				if (useSettingsStore.getState().autoRunDisabled) return;
				ctx.rightPanelRef?.current?.toggleAutoRunExpanded();
				trackShortcut('toggleAutoRunExpanded');
			} else if (ctx.isShortcut(e, 'jumpToTerminal')) {
				e.preventDefault();
				if (ctx.activeSession && !ctx.activeGroupChatId) {
					const result = ctx.navigateToClosestTerminalTab(ctx.activeSession);
					if (result) {
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => (s.id === ctx.activeSession!.id ? result.session : s))
						);
						// Focus the terminal after switching
						setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
					} else if (ctx.activeSessionId) {
						// No terminal tabs exist — create one (same as Cmd+J / toggleMode)
						ctx.handleOpenTerminalTab();
						setTimeout(() => ctx.mainPanelRef?.current?.focusActiveTerminal(), 100);
					}
					trackShortcut('jumpToTerminal');
				}
			}

			// Ctrl+Shift+` — Create a new terminal tab (works regardless of inputMode)
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

			// Font size shortcuts: Cmd+= (zoom in), Cmd+- (zoom out), Cmd+Shift+0 (reset)
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				if (e.key === '=' || e.key === '+') {
					e.preventDefault();
					const { fontSize, setFontSize } = useSettingsStore.getState();
					const newSize = Math.min(fontSize + FONT_SIZE_STEP, FONT_SIZE_MAX);
					if (newSize !== fontSize) setFontSize(newSize);
					trackShortcut('fontSizeIncrease');
					return;
				}
				if (e.key === '-') {
					e.preventDefault();
					const { fontSize, setFontSize } = useSettingsStore.getState();
					const newSize = Math.max(fontSize - FONT_SIZE_STEP, FONT_SIZE_MIN);
					if (newSize !== fontSize) setFontSize(newSize);
					trackShortcut('fontSizeDecrease');
					return;
				}
			}
			// Cmd+Shift+0: Reset font size (Cmd+0 is reserved for "Go to Last Tab")
			if (ctx.isShortcut(e, 'fontSizeReset')) {
				e.preventDefault();
				const { fontSize, setFontSize } = useSettingsStore.getState();
				if (fontSize !== FONT_SIZE_DEFAULT) setFontSize(FONT_SIZE_DEFAULT);
				trackShortcut('fontSizeReset');
				return;
			}

			// Unified tab shortcuts — works across ALL tab types (AI, file preview, terminal).
			// Terminal tabs are part of unifiedTabOrder and the navigation functions
			// (navigateToNextUnifiedTab, etc.) handle inputMode switching automatically.
			// Some shortcuts only apply in AI mode (e.g., newTab, toggleReadOnly) — those
			// are individually gated below. Navigation shortcuts work in ALL modes.
			if (ctx.activeSessionId && ctx.activeSession && !ctx.activeGroupChatId) {
				if (ctx.isTabShortcut(e, 'tabSwitcher')) {
					e.preventDefault();
					ctx.setTabSwitcherOpen(true);
					trackShortcut('tabSwitcher');
				}
				// Cmd+T: New AI tab (works in any mode including terminal)
				if (ctx.isTabShortcut(e, 'newTab')) {
					e.preventDefault();
					const result = ctx.createTab(ctx.activeSession, {
						saveToHistory: ctx.defaultSaveToHistory,
						showThinking: ctx.defaultShowThinking,
					});
					if (result) {
						const newSession = { ...result.session, inputMode: 'ai' as const };
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => (s.id === ctx.activeSession!.id ? newSession : s))
						);
						// Auto-focus the input so user can start typing immediately
						ctx.setActiveFocus('main');
						setTimeout(() => ctx.inputRef.current?.focus(), FOCUS_AFTER_RENDER_DELAY_MS);
						trackShortcut('newTab');
					}
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
				if (ctx.isTabShortcut(e, 'focusBrowserAddress') && ctx.activeSession?.activeBrowserTabId) {
					e.preventDefault();
					ctx.mainPanelRef?.current?.focusBrowserAddressBar();
					trackShortcut('focusBrowserAddress');
				}
				// Cmd+R: Reload active browser tab (when a browser tab is active)
				if (
					ctx.isTabShortcut(e, 'toggleReadOnlyMode') &&
					ctx.activeSession?.activeBrowserTabId &&
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
				// Bulk close shortcuts (AI mode only — terminal tabs don't have bulk close)
				if (ctx.activeSession.inputMode === 'ai') {
					if (ctx.isTabShortcut(e, 'closeAllTabs')) {
						e.preventDefault();
						ctx.handleCloseAllTabs();
						trackShortcut('closeAllTabs');
					}
					if (ctx.isTabShortcut(e, 'closeOtherTabs')) {
						e.preventDefault();
						if (ctx.activeSession.aiTabs.length > 1) {
							ctx.handleCloseOtherTabs();
							trackShortcut('closeOtherTabs');
						}
					}
					if (ctx.isTabShortcut(e, 'closeTabsLeft')) {
						e.preventDefault();
						const activeTabIndex = ctx.activeSession.aiTabs.findIndex(
							(t: AITab) => t.id === ctx.activeSession.activeTabId
						);
						if (activeTabIndex > 0) {
							ctx.handleCloseTabsLeft();
							trackShortcut('closeTabsLeft');
						}
					}
					if (ctx.isTabShortcut(e, 'closeTabsRight')) {
						e.preventDefault();
						const activeTabIndex = ctx.activeSession.aiTabs.findIndex(
							(t: AITab) => t.id === ctx.activeSession.activeTabId
						);
						if (activeTabIndex < ctx.activeSession.aiTabs.length - 1) {
							ctx.handleCloseTabsRight();
							trackShortcut('closeTabsRight');
						}
					}
				}
				if (ctx.isTabShortcut(e, 'reopenClosedTab')) {
					e.preventDefault();
					const result = ctx.reopenUnifiedClosedTab(ctx.activeSession);
					if (result) {
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => (s.id === ctx.activeSession!.id ? result.session : s))
						);
						trackShortcut('reopenClosedTab');
					}
				}
				if (ctx.isTabShortcut(e, 'renameTab')) {
					e.preventDefault();
					if (ctx.activeSession.inputMode === 'terminal') {
						const activeTerminalTabId = ctx.activeSession.activeTerminalTabId;
						const terminalTab = ctx.activeSession.terminalTabs?.find(
							(t: { id: string }) => t.id === activeTerminalTabId
						);
						if (activeTerminalTabId && terminalTab) {
							ctx.setRenameTabId(activeTerminalTabId);
							ctx.setRenameTabInitialName(terminalTab.name ?? '');
							ctx.setRenameTabModalOpen(true);
							trackShortcut('renameTab');
						}
					} else if (ctx.activeSession.activeBrowserTabId) {
						const browserTab = ctx.activeSession.browserTabs?.find(
							(t: { id: string }) => t.id === ctx.activeSession.activeBrowserTabId
						);
						if (browserTab) {
							ctx.setRenameTabId(browserTab.id);
							ctx.setRenameTabInitialName(browserTab.title ?? '');
							ctx.setRenameTabModalOpen(true);
							trackShortcut('renameTab');
						}
					} else {
						const activeTab = ctx.getActiveTab(ctx.activeSession);
						if (activeTab) {
							ctx.setRenameTabId(activeTab.id);
							ctx.setRenameTabInitialName(getInitialRenameValue(activeTab));
							ctx.setRenameTabModalOpen(true);
							trackShortcut('renameTab');
						}
					}
				}
				// AI-tab-specific metadata toggles (not applicable to terminal tabs)
				if (ctx.activeSession.inputMode === 'ai') {
					if (ctx.isTabShortcut(e, 'toggleReadOnlyMode')) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => {
								if (s.id !== ctx.activeSession!.id) return s;
								return {
									...s,
									aiTabs: s.aiTabs.map((tab: AITab) =>
										tab.id === s.activeTabId ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
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
								if (s.id !== ctx.activeSession!.id) return s;
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
						const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
							if (!current || current === 'off') return 'on';
							if (current === 'on') return 'sticky';
							return 'off';
						};
						ctx.setSessions((prev: Session[]) =>
							prev.map((s: Session) => {
								if (s.id !== ctx.activeSession!.id) return s;
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
										const newMode = cycleThinkingMode(tab.showThinking);
										if (newMode === 'off') {
											return {
												...tab,
												showThinking: 'off',
												logs: tab.logs.filter(
													(l) => l.source !== 'thinking' && l.source !== 'tool'
												),
											};
										}
										return { ...tab, showThinking: newMode };
									}),
								};
							})
						);
						trackShortcut('toggleShowThinking');
					}
				}
				// Unread filter/toggle — works across ALL tab types (AI, file, terminal)
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
				// Cmd+Shift+] / Cmd+Shift+[ — Navigate tabs in unified order
				// Cycles through ALL tab types (AI, file, terminal) via unifiedTabOrder
				if (ctx.isTabShortcut(e, 'nextTab')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === ctx.activeSessionId);
						if (!current) return prev;
						const result = ctx.navigateToNextUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('nextTab');
				}
				if (ctx.isTabShortcut(e, 'prevTab')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === ctx.activeSessionId);
						if (!current) return prev;
						const result = ctx.navigateToPrevUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('prevTab');
				}
				// Cmd+1-9, Cmd+0 — Jump to tab by index in unified order.
				// In unread-only mode, index into the filtered/visible tabs so Cmd+N matches
				// the Nth tab currently shown in the tab bar (not the Nth tab overall).
				for (let i = 1; i <= 9; i++) {
					if (ctx.isTabShortcut(e, `goToTab${i}`)) {
						e.preventDefault();
						ctx.setSessions((prev: Session[]) => {
							const current = prev.find((s: Session) => s.id === ctx.activeSessionId);
							if (!current) return prev;
							const result = ctx.navigateToUnifiedTabByIndex(current, i - 1, ctx.showUnreadOnly);
							if (!result) return prev;
							return prev.map((s: Session) => (s.id === current.id ? result.session : s));
						});
						trackShortcut(`goToTab${i}`);
						break;
					}
				}
				if (ctx.isTabShortcut(e, 'goToLastTab')) {
					e.preventDefault();
					ctx.setSessions((prev: Session[]) => {
						const current = prev.find((s: Session) => s.id === ctx.activeSessionId);
						if (!current) return prev;
						const result = ctx.navigateToLastUnifiedTab(current, ctx.showUnreadOnly);
						if (!result) return prev;
						return prev.map((s: Session) => (s.id === current.id ? result.session : s));
					});
					trackShortcut('goToLastTab');
				}
			}

			// Cmd+F contextual shortcuts - prioritize explicit focus over input mode
			if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
				if (ctx.activeFocus === 'right' && ctx.activeRightTab === 'files') {
					e.preventDefault();
					ctx.setFileTreeFilterOpen(true);
					trackShortcut('filterFiles');
				} else if (ctx.activeFocus === 'sidebar') {
					// Sidebar filter - handled by SessionList component, just track here
					trackShortcut('filterSessions');
				} else if (ctx.activeFocus === 'right' && ctx.activeRightTab === 'history') {
					// History filter - handled by HistoryPanel component, just track here
					trackShortcut('filterHistory');
				} else if (ctx.activeSession?.inputMode === 'terminal') {
					// Terminal search — works whether xterm is focused or not. xterm forwards
					// Cmd+F via attachCustomKeyEventHandler (re-dispatching a synthetic event on
					// window) so this branch handles both the direct and forwarded cases.
					e.preventDefault();
					ctx.mainPanelRef?.current?.openTerminalSearch();
					trackShortcut('searchTerminal');
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
			if (ctx?.activeSession?.activeBrowserTabId) {
				const probe = new KeyboardEvent('keydown', {
					key: input.key,
					code: input.code,
					metaKey: input.meta,
					ctrlKey: input.control,
					altKey: input.alt,
					shiftKey: input.shift,
				});
				if (ctx.isTabShortcut(probe, 'focusBrowserAddress')) {
					ctx.mainPanelRef?.current?.focusBrowserAddressBar();
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
