import { useEffect, useRef, useState } from 'react';
import type { Session, AITab } from '../types';
import { TAB_SHORTCUTS } from '../constants/shortcuts';
import { getInitialRenameValue } from '../utils/tabHelpers';

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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

        const isCycleShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']');
        // Allow sidebar toggle shortcuts (Alt+Cmd+Arrow) even when modals are open
        const isLayoutShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
        // Allow right panel tab shortcuts (Cmd+Shift+F/H/S) even when overlays are open
        const keyLower = e.key.toLowerCase();
        const isRightPanelShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (keyLower === 'f' || keyLower === 'h' || keyLower === 's');
        // Allow jumpToBottom (Cmd+Shift+J) from anywhere - always scroll main panel to bottom
        const isJumpToBottomShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && keyLower === 'j';
        // Allow system utility shortcuts (Alt+Cmd+L for logs, Alt+Cmd+P for processes) even when modals are open
        // NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters (e.g., Alt+P = π)
        const codeKeyLower = e.code?.replace('Key', '').toLowerCase() || '';
        const isSystemUtilShortcut = e.altKey && (e.metaKey || e.ctrlKey) && (codeKeyLower === 'l' || codeKeyLower === 'p');
        // Allow session jump shortcuts (Alt+Cmd+NUMBER) even when modals are open
        // NOTE: Must use e.code for Alt key combos on macOS because e.key produces special characters
        const isSessionJumpShortcut = e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code || '');

        if (ctx.hasOpenModal()) {
          // TRUE MODAL is open - block most shortcuts from App.tsx
          // The modal's own handler will handle Cmd+Shift+[] if it supports it
          // BUT allow layout shortcuts (sidebar toggles), system utility shortcuts, session jump, and jumpToBottom to work
          if (!isLayoutShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut && !isJumpToBottomShortcut) {
            return;
          }
          // Fall through to handle layout/system utility/session jump/jumpToBottom shortcuts below
        } else {
          // Only OVERLAYS are open (FilePreview, LogViewer, etc.)
          // Allow Cmd+Shift+[] to fall through to App.tsx handler
          // (which will cycle right panel tabs when previewFile is set)
          // Also allow right panel tab shortcuts to switch tabs while overlay is open
          if (!isCycleShortcut && !isLayoutShortcut && !isRightPanelShortcut && !isSystemUtilShortcut && !isSessionJumpShortcut && !isJumpToBottomShortcut) {
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


      // General shortcuts
      // Only allow collapsing left sidebar when there are sessions (prevent collapse on empty state)
      if (ctx.isShortcut(e, 'toggleSidebar')) {
        if (ctx.sessions.length > 0 || !ctx.leftSidebarOpen) {
          ctx.setLeftSidebarOpen((p: boolean) => !p);
        }
      }
      else if (ctx.isShortcut(e, 'toggleRightPanel')) ctx.setRightPanelOpen((p: boolean) => !p);
      else if (ctx.isShortcut(e, 'newInstance')) ctx.addNewSession();
      else if (ctx.isShortcut(e, 'newGroupChat')) {
        e.preventDefault();
        ctx.setShowNewGroupChatModal(true);
      }
      else if (ctx.isShortcut(e, 'killInstance')) {
        // Delete whichever is currently active: group chat or agent session
        if (ctx.activeGroupChatId) {
          ctx.deleteGroupChatWithConfirmation(ctx.activeGroupChatId);
        } else if (ctx.activeSessionId) {
          ctx.deleteSession(ctx.activeSessionId);
        }
      }
      else if (ctx.isShortcut(e, 'moveToGroup')) {
        if (ctx.activeSession) {
          ctx.setQuickActionInitialMode('move-to-group');
          ctx.setQuickActionOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'cyclePrev')) {
        // Cycle to previous Maestro session (global shortcut)
        ctx.cycleSession('prev');
      }
      else if (ctx.isShortcut(e, 'cycleNext')) {
        // Cycle to next Maestro session (global shortcut)
        ctx.cycleSession('next');
      }
      else if (ctx.isShortcut(e, 'navBack')) {
        // Navigate back in history (through sessions and tabs)
        e.preventDefault();
        ctx.handleNavBack();
      }
      else if (ctx.isShortcut(e, 'navForward')) {
        // Navigate forward in history (through sessions and tabs)
        e.preventDefault();
        ctx.handleNavForward();
      }
      else if (ctx.isShortcut(e, 'toggleMode')) ctx.toggleInputMode();
      else if (ctx.isShortcut(e, 'quickAction')) {
        // Only open quick actions if there are agents
        if (ctx.sessions.length > 0) {
          ctx.setQuickActionInitialMode('main');
          ctx.setQuickActionOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'help')) ctx.setShortcutsHelpOpen(true);
      else if (ctx.isShortcut(e, 'settings')) { ctx.setSettingsModalOpen(true); ctx.setSettingsTab('general'); }
      else if (ctx.isShortcut(e, 'goToFiles')) {
        e.preventDefault();
        ctx.setRightPanelOpen(true);
        // In group chat, Cmd+Shift+F goes to Participants tab (no Files tab in group chat)
        if (ctx.activeGroupChatId) {
          ctx.setGroupChatRightTab('participants');
        } else {
          ctx.handleSetActiveRightTab('files');
        }
        ctx.setActiveFocus('right');
      }
      else if (ctx.isShortcut(e, 'goToHistory')) {
        e.preventDefault();
        ctx.setRightPanelOpen(true);
        // In group chat, Cmd+Shift+H goes to History tab (same concept)
        if (ctx.activeGroupChatId) {
          ctx.setGroupChatRightTab('history');
        } else {
          ctx.handleSetActiveRightTab('history');
        }
        ctx.setActiveFocus('right');
      }
      else if (ctx.isShortcut(e, 'goToAutoRun')) { e.preventDefault(); ctx.setRightPanelOpen(true); ctx.handleSetActiveRightTab('autorun'); ctx.setActiveFocus('right'); }
      else if (ctx.isShortcut(e, 'fuzzyFileSearch')) { e.preventDefault(); if (ctx.activeSession) ctx.setFuzzyFileSearchOpen(true); }
      else if (ctx.isShortcut(e, 'openImageCarousel')) {
        e.preventDefault();
        // Use group chat staged images when group chat is active
        const images = ctx.activeGroupChatId ? ctx.groupChatStagedImages : ctx.stagedImages;
        if (images && images.length > 0) {
          ctx.handleSetLightboxImage(images[0], images, 'staged');
        }
      }
      else if (ctx.isShortcut(e, 'toggleTabStar')) {
        e.preventDefault();
        ctx.toggleTabStar();
      }
      else if (ctx.isShortcut(e, 'openPromptComposer')) {
        e.preventDefault();
        // Only open in AI mode
        if (ctx.activeSession?.inputMode === 'ai') {
          ctx.setPromptComposerOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'openWizard')) {
        e.preventDefault();
        ctx.openWizardModal();
      }
      else if (ctx.isShortcut(e, 'focusInput')) {
        e.preventDefault();
        // Use group chat input ref when group chat is active
        const targetInputRef = ctx.activeGroupChatId ? ctx.groupChatInputRef : ctx.inputRef;
        // Toggle between input and main panel output for keyboard scrolling
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
      else if (ctx.isShortcut(e, 'focusSidebar')) {
        e.preventDefault();
        // Expand sidebar if collapsed
        if (!ctx.leftSidebarOpen) {
          ctx.setLeftSidebarOpen(true);
        }
        // Focus the sidebar (both logical state and DOM focus for keyboard events like Cmd+F)
        ctx.setActiveFocus('sidebar');
        setTimeout(() => ctx.sidebarContainerRef?.current?.focus(), 0);
      }
      else if (ctx.isShortcut(e, 'viewGitDiff') && !ctx.activeGroupChatId) {
        e.preventDefault();
        ctx.handleViewGitDiff();
      }
      else if (ctx.isShortcut(e, 'viewGitLog') && !ctx.activeGroupChatId) {
        e.preventDefault();
        if (ctx.activeSession?.isGitRepo) {
          ctx.setGitLogOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'agentSessions')) {
        e.preventDefault();
        // Use capability check instead of hardcoded toolType
        if (ctx.hasActiveSessionCapability('supportsSessionStorage')) {
          ctx.setActiveAgentSessionId(null);
          ctx.setAgentSessionsOpen(true);
        }
      }
      else if (ctx.isShortcut(e, 'systemLogs')) {
        e.preventDefault();
        ctx.setLogViewerOpen(true);
      }
      else if (ctx.isShortcut(e, 'processMonitor')) {
        e.preventDefault();
        ctx.setProcessMonitorOpen(true);
      }
      else if (ctx.isShortcut(e, 'jumpToBottom')) {
        e.preventDefault();
        // Jump to the bottom of the current main panel output (AI logs or terminal output)
        ctx.logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }
      else if (ctx.isShortcut(e, 'toggleMarkdownMode')) {
        // Toggle markdown raw mode for AI message history
        // Skip when in AutoRun panel (it has its own Cmd+E handler for edit/preview toggle)
        // Skip when FilePreview is open (it handles its own Cmd+E)
        // Check both state-based detection AND DOM-based detection for robustness
        const isInAutoRunPanel = ctx.activeFocus === 'right' && ctx.activeRightTab === 'autorun';
        // Also check if the focused element is within an autorun panel (handles edge cases where activeFocus state may be stale)
        const activeElement = document.activeElement;
        const isInAutoRunDOM = activeElement?.closest('[data-tour="autorun-panel"]') !== null;
        if (!isInAutoRunPanel && !isInAutoRunDOM && !ctx.previewFile) {
          e.preventDefault();
          ctx.setMarkdownEditMode(!ctx.markdownEditMode);
        }
      }
      else if (ctx.isShortcut(e, 'toggleAutoRunExpanded')) {
        // Toggle Auto Run expanded/contracted view
        e.preventDefault();
        ctx.rightPanelRef?.current?.toggleAutoRunExpanded();
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
          // Also expand sidebar if collapsed
          if (!ctx.leftSidebarOpen) {
            ctx.setLeftSidebarOpen(true);
          }
        }
      }

      // Tab shortcuts (AI mode only, requires an explicitly selected session, disabled in group chat view)
      if (ctx.activeSessionId && ctx.activeSession?.inputMode === 'ai' && ctx.activeSession?.aiTabs && !ctx.activeGroupChatId) {
        if (ctx.isTabShortcut(e, 'tabSwitcher')) {
          e.preventDefault();
          ctx.setTabSwitcherOpen(true);
        }
        if (ctx.isTabShortcut(e, 'newTab')) {
          e.preventDefault();
          const result = ctx.createTab(ctx.activeSession, { saveToHistory: ctx.defaultSaveToHistory, showThinking: ctx.defaultShowThinking });
          if (result) {
            ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
            // Auto-focus the input so user can start typing immediately
            ctx.setActiveFocus('main');
            setTimeout(() => ctx.inputRef.current?.focus(), 50);
          }
        }
        if (ctx.isTabShortcut(e, 'closeTab')) {
          e.preventDefault();
          // Only close if there's more than one tab (closeTab returns null otherwise)
          const result = ctx.closeTab(ctx.activeSession, ctx.activeSession.activeTabId, ctx.showUnreadOnly);
          if (result) {
            ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'reopenClosedTab')) {
          e.preventDefault();
          // Reopen the most recently closed tab, or switch to existing if duplicate
          const result = ctx.reopenClosedTab(ctx.activeSession);
          if (result) {
            ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'renameTab')) {
          e.preventDefault();
          const activeTab = ctx.getActiveTab(ctx.activeSession);
          // Only allow rename if tab has an active Claude session
          if (activeTab?.agentSessionId) {
            ctx.setRenameTabId(activeTab.id);
            ctx.setRenameTabInitialName(getInitialRenameValue(activeTab));
            ctx.setRenameTabModalOpen(true);
          }
        }
        if (ctx.isTabShortcut(e, 'toggleReadOnlyMode')) {
          e.preventDefault();
          ctx.setSessions((prev: Session[]) => prev.map((s: Session) => {
            if (s.id !== ctx.activeSession!.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map((tab: AITab) =>
                tab.id === s.activeTabId ? { ...tab, readOnlyMode: !tab.readOnlyMode } : tab
              )
            };
          }));
        }
        if (ctx.isTabShortcut(e, 'toggleSaveToHistory')) {
          e.preventDefault();
          ctx.setSessions((prev: Session[]) => prev.map((s: Session) => {
            if (s.id !== ctx.activeSession!.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map((tab: AITab) =>
                tab.id === s.activeTabId ? { ...tab, saveToHistory: !tab.saveToHistory } : tab
              )
            };
          }));
        }
        if (ctx.isTabShortcut(e, 'toggleShowThinking')) {
          e.preventDefault();
          ctx.setSessions((prev: Session[]) => prev.map((s: Session) => {
            if (s.id !== ctx.activeSession!.id) return s;
            return {
              ...s,
              aiTabs: s.aiTabs.map((tab: AITab) => {
                if (tab.id !== s.activeTabId) return tab;
                // When turning OFF, also clear any existing thinking/tool logs
                if (tab.showThinking) {
                  return { ...tab, showThinking: false, logs: tab.logs.filter(l => l.source !== 'thinking' && l.source !== 'tool') };
                }
                return { ...tab, showThinking: true };
              })
            };
          }));
        }
        if (ctx.isTabShortcut(e, 'filterUnreadTabs')) {
          e.preventDefault();
          ctx.toggleUnreadFilter();
        }
        if (ctx.isTabShortcut(e, 'toggleTabUnread')) {
          e.preventDefault();
          ctx.toggleTabUnread();
        }
        if (ctx.isTabShortcut(e, 'nextTab')) {
          e.preventDefault();
          const result = ctx.navigateToNextTab(ctx.activeSession, ctx.showUnreadOnly);
          if (result) {
            ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        if (ctx.isTabShortcut(e, 'prevTab')) {
          e.preventDefault();
          const result = ctx.navigateToPrevTab(ctx.activeSession, ctx.showUnreadOnly);
          if (result) {
            ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
              s.id === ctx.activeSession!.id ? result.session : s
            ));
          }
        }
        // Cmd+1 through Cmd+9: Jump to specific tab by index (disabled in unread-only mode)
        if (!ctx.showUnreadOnly) {
          for (let i = 1; i <= 9; i++) {
            if (ctx.isTabShortcut(e, `goToTab${i}` as keyof typeof TAB_SHORTCUTS)) {
              e.preventDefault();
              const result = ctx.navigateToTabByIndex(ctx.activeSession, i - 1);
              if (result) {
                ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
                  s.id === ctx.activeSession!.id ? result.session : s
                ));
              }
              break;
            }
          }
          // Cmd+0: Jump to last tab
          if (ctx.isTabShortcut(e, 'goToLastTab')) {
            e.preventDefault();
            const result = ctx.navigateToLastTab(ctx.activeSession);
            if (result) {
              ctx.setSessions((prev: Session[]) => prev.map((s: Session) =>
                s.id === ctx.activeSession!.id ? result.session : s
              ));
            }
          }
        }
      }

      // Cmd+F to open file tree filter when file tree has focus
      if (e.key === 'f' && (e.metaKey || e.ctrlKey) && ctx.activeFocus === 'right' && ctx.activeRightTab === 'files') {
        e.preventDefault();
        ctx.setFileTreeFilterOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty dependencies - handler reads from ref

  // Track Opt+Cmd modifier keys to show session jump number badges
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Show number badges when Opt+Cmd is held (but no number pressed yet)
      if (e.altKey && (e.metaKey || e.ctrlKey) && !showSessionJumpNumbers) {
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
  }, [showSessionJumpNumbers]);

  return {
    keyboardHandlerRef,
    showSessionJumpNumbers,
  };
}
