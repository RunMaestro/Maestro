import { useCallback, useEffect, useRef } from 'react';
import type { Session, Group, FocusArea } from '../types';

/**
 * Dependencies for useKeyboardNavigation hook
 */
export interface UseKeyboardNavigationDeps {
  /** All sessions sorted in visual display order */
  sortedSessions: Session[];
  /** Current selected sidebar index */
  selectedSidebarIndex: number;
  /** Setter for selected sidebar index */
  setSelectedSidebarIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Active session ID */
  activeSessionId: string | null;
  /** Setter for active session ID */
  setActiveSessionId: (id: string) => void;
  /** Current focus area */
  activeFocus: FocusArea;
  /** Setter for focus area */
  setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
  /** Session groups */
  groups: Group[];
  /** Setter for groups (for collapse/expand) */
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  /** Whether bookmarks section is collapsed */
  bookmarksCollapsed: boolean;
  /** Setter for bookmarks collapsed state */
  setBookmarksCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether a session is being renamed (prevents keyboard nav) */
  editingSessionId: string | null;
  /** Whether a group is being renamed (prevents keyboard nav) */
  editingGroupId: string | null;
  /** Input ref for focus management */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Terminal output ref for escape handling */
  terminalOutputRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Return type for useKeyboardNavigation hook
 */
export interface UseKeyboardNavigationReturn {
  /** Handle sidebar navigation keyboard events. Returns true if event was handled. */
  handleSidebarNavigation: (e: KeyboardEvent) => boolean;
  /** Handle Tab navigation between panels. Returns true if event was handled. */
  handleTabNavigation: (e: KeyboardEvent) => boolean;
  /** Handle Enter to activate selected session. Returns true if event was handled. */
  handleEnterToActivate: (e: KeyboardEvent) => boolean;
  /** Handle Escape in main area. Returns true if event was handled. */
  handleEscapeInMain: (e: KeyboardEvent) => boolean;
}

/**
 * Keyboard navigation utilities for sidebar and panel focus management.
 *
 * Provides handlers for:
 * - Arrow key navigation through sessions (with group collapse/expand)
 * - Tab navigation between panels (sidebar, main, right)
 * - Enter to activate selected session
 * - Escape to blur input and focus terminal output
 *
 * @param deps - Hook dependencies containing state and setters
 * @returns Navigation handlers for the main keyboard event handler
 */
export function useKeyboardNavigation(
  deps: UseKeyboardNavigationDeps
): UseKeyboardNavigationReturn {
  const {
    sortedSessions,
    selectedSidebarIndex,
    setSelectedSidebarIndex,
    activeSessionId,
    setActiveSessionId,
    activeFocus,
    setActiveFocus,
    groups,
    setGroups,
    bookmarksCollapsed,
    setBookmarksCollapsed,
    editingSessionId,
    editingGroupId,
    inputRef,
    terminalOutputRef,
  } = deps;

  // Use refs for values that change frequently to avoid stale closures
  const sortedSessionsRef = useRef(sortedSessions);
  sortedSessionsRef.current = sortedSessions;

  const selectedSidebarIndexRef = useRef(selectedSidebarIndex);
  selectedSidebarIndexRef.current = selectedSidebarIndex;

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const bookmarksCollapsedRef = useRef(bookmarksCollapsed);
  bookmarksCollapsedRef.current = bookmarksCollapsed;

  const activeFocusRef = useRef(activeFocus);
  activeFocusRef.current = activeFocus;

  /**
   * Handle sidebar navigation with arrow keys.
   * Supports collapse/expand of groups and bookmarks sections.
   * Returns true if the event was handled.
   */
  const handleSidebarNavigation = useCallback((e: KeyboardEvent): boolean => {
    const sessions = sortedSessionsRef.current;
    const currentGroups = groupsRef.current;
    const currentIndex = selectedSidebarIndexRef.current;
    const isBookmarksCollapsed = bookmarksCollapsedRef.current;
    const focus = activeFocusRef.current;

    // Only handle when sidebar has focus
    if (focus !== 'sidebar') return false;

    // Skip if Alt+Cmd+Arrow is pressed (layout toggle shortcut)
    const isToggleLayoutShortcut = e.altKey && (e.metaKey || e.ctrlKey) &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
    if (isToggleLayoutShortcut) return false;

    // Only handle arrow keys and space
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      return false;
    }

    e.preventDefault();
    if (sessions.length === 0) return true;

    const currentSession = sessions[currentIndex];

    // ArrowLeft: Collapse the current group or bookmarks section
    if (e.key === 'ArrowLeft' && currentSession) {
      // Check if session is bookmarked and bookmarks section is expanded
      if (currentSession.bookmarked && !isBookmarksCollapsed) {
        setBookmarksCollapsed(true);
        return true;
      }

      // Check if session is in a group
      if (currentSession.groupId) {
        const currentGroup = currentGroups.find(g => g.id === currentSession.groupId);
        if (currentGroup && !currentGroup.collapsed) {
          setGroups(prev => prev.map(g =>
            g.id === currentGroup.id ? { ...g, collapsed: true } : g
          ));
          return true;
        }
      }
      return true;
    }

    // ArrowRight: Expand the current group or bookmarks section (if collapsed)
    if (e.key === 'ArrowRight' && currentSession) {
      // Check if session is bookmarked and bookmarks section is collapsed
      if (currentSession.bookmarked && isBookmarksCollapsed) {
        setBookmarksCollapsed(false);
        return true;
      }

      // Check if session is in a collapsed group
      if (currentSession.groupId) {
        const currentGroup = currentGroups.find(g => g.id === currentSession.groupId);
        if (currentGroup && currentGroup.collapsed) {
          setGroups(prev => prev.map(g =>
            g.id === currentGroup.id ? { ...g, collapsed: false } : g
          ));
          return true;
        }
      }
      return true;
    }

    // Space: Close the current group and jump to nearest visible session
    if (e.key === ' ' && currentSession?.groupId) {
      const currentGroup = currentGroups.find(g => g.id === currentSession.groupId);
      if (currentGroup && !currentGroup.collapsed) {
        // Collapse the group
        setGroups(prev => prev.map(g =>
          g.id === currentGroup.id ? { ...g, collapsed: true } : g
        ));

        // Helper to check if a session will be visible after collapse
        const willBeVisible = (s: Session) => {
          if (s.groupId === currentGroup.id) return false; // In the group being collapsed
          if (!s.groupId) return true; // Ungrouped sessions are always visible
          const g = currentGroups.find(grp => grp.id === s.groupId);
          return g && !g.collapsed; // In an expanded group
        };

        // Find current position in sortedSessions
        const sessionIndex = sessions.findIndex(s => s.id === currentSession.id);

        // First, look BELOW (after) the current position
        let nextVisible: Session | undefined;
        for (let i = sessionIndex + 1; i < sessions.length; i++) {
          if (willBeVisible(sessions[i])) {
            nextVisible = sessions[i];
            break;
          }
        }

        // If nothing below, look ABOVE (before) the current position
        if (!nextVisible) {
          for (let i = sessionIndex - 1; i >= 0; i--) {
            if (willBeVisible(sessions[i])) {
              nextVisible = sessions[i];
              break;
            }
          }
        }

        if (nextVisible) {
          const newIndex = sessions.findIndex(s => s.id === nextVisible!.id);
          setSelectedSidebarIndex(newIndex);
          setActiveSessionId(nextVisible.id);
        }
        return true;
      }
    }

    // ArrowUp/ArrowDown: Navigate through sessions, expanding collapsed groups as needed
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const totalSessions = sessions.length;

      // Helper to check if a session is in a collapsed group
      const isInCollapsedGroup = (session: Session) => {
        if (!session.groupId) return false;
        const group = currentGroups.find(g => g.id === session.groupId);
        return group?.collapsed ?? false;
      };

      // Helper to get all sessions in a group
      const getGroupSessions = (groupId: string) => {
        return sessions.filter(s => s.groupId === groupId);
      };

      // Find the next session, skipping visible sessions in collapsed groups
      // but stopping when we hit a NEW collapsed group (to expand it)
      let nextIndex = currentIndex;
      let foundCollapsedGroup: string | null = null;

      if (e.key === 'ArrowDown') {
        // Moving down
        for (let i = 1; i <= totalSessions; i++) {
          const candidateIndex = (currentIndex + i) % totalSessions;
          const candidate = sessions[candidateIndex];

          if (!candidate.groupId) {
            // Ungrouped session - can navigate to it
            nextIndex = candidateIndex;
            break;
          }

          const candidateGroup = currentGroups.find(g => g.id === candidate.groupId);
          if (!candidateGroup?.collapsed) {
            // Session in expanded group - can navigate to it
            nextIndex = candidateIndex;
            break;
          }

          // Session is in a collapsed group
          // Check if this is a different group than we're currently in
          if (candidate.groupId !== currentSession?.groupId) {
            // We've hit a collapsed group - expand it and go to FIRST item
            foundCollapsedGroup = candidate.groupId;
            const groupSessions = getGroupSessions(candidate.groupId);
            nextIndex = sessions.findIndex(s => s.id === groupSessions[0]?.id);
            break;
          }
          // Same collapsed group, keep looking (shouldn't happen if current is visible)
        }
      } else {
        // Moving up
        for (let i = 1; i <= totalSessions; i++) {
          const candidateIndex = (currentIndex - i + totalSessions) % totalSessions;
          const candidate = sessions[candidateIndex];

          if (!candidate.groupId) {
            // Ungrouped session - can navigate to it
            nextIndex = candidateIndex;
            break;
          }

          const candidateGroup = currentGroups.find(g => g.id === candidate.groupId);
          if (!candidateGroup?.collapsed) {
            // Session in expanded group - can navigate to it
            nextIndex = candidateIndex;
            break;
          }

          // Session is in a collapsed group
          // Check if this is a different group than we're currently in
          if (candidate.groupId !== currentSession?.groupId) {
            // We've hit a collapsed group - expand it and go to LAST item
            foundCollapsedGroup = candidate.groupId;
            const groupSessions = getGroupSessions(candidate.groupId);
            nextIndex = sessions.findIndex(s => s.id === groupSessions[groupSessions.length - 1]?.id);
            break;
          }
          // Same collapsed group, keep looking
        }
      }

      // If we found a collapsed group, expand it
      if (foundCollapsedGroup) {
        setGroups(prev => prev.map(g =>
          g.id === foundCollapsedGroup ? { ...g, collapsed: false } : g
        ));
      }

      setSelectedSidebarIndex(nextIndex);
      return true;
    }

    return false;
  }, [setSelectedSidebarIndex, setActiveSessionId, setGroups, setBookmarksCollapsed]);

  /**
   * Handle Tab navigation between panels.
   * Returns true if the event was handled.
   */
  const handleTabNavigation = useCallback((e: KeyboardEvent): boolean => {
    if (e.key !== 'Tab') return false;

    // Skip global Tab handling when input is focused - let input handler handle it
    if (document.activeElement === inputRef.current) {
      return false;
    }

    e.preventDefault();
    const focus = activeFocusRef.current;

    if (focus === 'sidebar' && !e.shiftKey) {
      // Tab from sidebar goes to main input
      setActiveFocus('main');
      setTimeout(() => inputRef.current?.focus(), 0);
      return true;
    }

    const order: FocusArea[] = ['sidebar', 'main', 'right'];
    const currentIdx = order.indexOf(focus);
    if (e.shiftKey) {
      const next = currentIdx === 0 ? order.length - 1 : currentIdx - 1;
      setActiveFocus(order[next]);
    } else {
      const next = currentIdx === order.length - 1 ? 0 : currentIdx + 1;
      setActiveFocus(order[next]);
    }
    return true;
  }, [setActiveFocus, inputRef]);

  /**
   * Handle Enter to load selected session from sidebar.
   * Returns true if the event was handled.
   */
  const handleEnterToActivate = useCallback((e: KeyboardEvent): boolean => {
    const focus = activeFocusRef.current;
    if (focus !== 'sidebar' || e.key !== 'Enter') return false;

    e.preventDefault();
    const sessions = sortedSessionsRef.current;
    const currentIndex = selectedSidebarIndexRef.current;

    if (sessions[currentIndex]) {
      setActiveSessionId(sessions[currentIndex].id);
    }
    return true;
  }, [setActiveSessionId]);

  /**
   * Handle Escape in main area to blur input and focus terminal.
   * Returns true if the event was handled.
   */
  const handleEscapeInMain = useCallback((e: KeyboardEvent): boolean => {
    const focus = activeFocusRef.current;
    if (focus !== 'main' || e.key !== 'Escape') return false;
    if (document.activeElement !== inputRef.current) return false;

    e.preventDefault();
    inputRef.current?.blur();
    terminalOutputRef.current?.focus();
    return true;
  }, [inputRef, terminalOutputRef]);

  // Sync selectedSidebarIndex with activeSessionId
  // IMPORTANT: Only sync when activeSessionId changes, NOT when sortedSessions changes
  // This allows keyboard navigation to move the selector independently of the active session
  // The sync happens when user clicks a session or presses Enter to activate
  useEffect(() => {
    const currentIndex = sortedSessions.findIndex(s => s.id === activeSessionId);
    if (currentIndex !== -1) {
      setSelectedSidebarIndex(currentIndex);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]); // Intentionally excluding sortedSessions - see comment above

  return {
    handleSidebarNavigation,
    handleTabNavigation,
    handleEnterToActivate,
    handleEscapeInMain,
  };
}
