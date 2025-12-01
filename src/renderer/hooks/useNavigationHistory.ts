import { useRef, useCallback } from 'react';

// Navigation history entry - tracks session and AI tab position
export interface NavHistoryEntry {
  sessionId: string;
  tabId?: string; // Optional AI tab ID (only for AI mode with tabs)
}

const MAX_HISTORY = 50;

/**
 * Hook for managing navigation history (back/forward) through sessions and AI tabs.
 *
 * Usage:
 * - Call `pushNavigation` when navigating to a new session or tab
 * - Call `navigateBack` to go back
 * - Call `navigateForward` to go forward
 */
export function useNavigationHistory() {
  // History stacks stored in refs to avoid unnecessary re-renders
  const historyRef = useRef<NavHistoryEntry[]>([]);
  const forwardStackRef = useRef<NavHistoryEntry[]>([]);
  const currentRef = useRef<NavHistoryEntry | null>(null);

  // Flag to prevent recording navigation during back/forward
  const isNavigatingRef = useRef(false);

  /**
   * Push a new navigation entry. Should be called when user navigates to a new session/tab.
   * Clears forward stack since we're creating a new branch in history.
   */
  const pushNavigation = useCallback((entry: NavHistoryEntry) => {
    // Don't record if we're in the middle of a back/forward navigation
    if (isNavigatingRef.current) {
      return;
    }

    // Don't push if it's the same as current
    if (currentRef.current &&
        currentRef.current.sessionId === entry.sessionId &&
        currentRef.current.tabId === entry.tabId) {
      return;
    }

    // Push current to history if we have one
    if (currentRef.current) {
      historyRef.current.push(currentRef.current);

      // Limit history size
      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current.shift();
      }
    }

    // Set new current
    currentRef.current = entry;

    // Clear forward stack - new navigation creates a new branch
    forwardStackRef.current = [];
  }, []);

  /**
   * Navigate back in history. Returns the entry to navigate to, or null if can't go back.
   */
  const navigateBack = useCallback((): NavHistoryEntry | null => {
    if (historyRef.current.length === 0) {
      return null;
    }

    isNavigatingRef.current = true;

    // Push current to forward stack
    if (currentRef.current) {
      forwardStackRef.current.push(currentRef.current);
    }

    // Pop from history
    const entry = historyRef.current.pop()!;
    currentRef.current = entry;

    // Reset flag after a tick to allow the navigation to complete
    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 0);

    return entry;
  }, []);

  /**
   * Navigate forward in history. Returns the entry to navigate to, or null if can't go forward.
   */
  const navigateForward = useCallback((): NavHistoryEntry | null => {
    if (forwardStackRef.current.length === 0) {
      return null;
    }

    isNavigatingRef.current = true;

    // Push current to history
    if (currentRef.current) {
      historyRef.current.push(currentRef.current);
    }

    // Pop from forward stack
    const entry = forwardStackRef.current.pop()!;
    currentRef.current = entry;

    // Reset flag after a tick to allow the navigation to complete
    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 0);

    return entry;
  }, []);

  /**
   * Check if we can go back
   */
  const canGoBack = useCallback((): boolean => {
    return historyRef.current.length > 0;
  }, []);

  /**
   * Check if we can go forward
   */
  const canGoForward = useCallback((): boolean => {
    return forwardStackRef.current.length > 0;
  }, []);

  /**
   * Clear all history (e.g., when all sessions are deleted)
   */
  const clearHistory = useCallback(() => {
    historyRef.current = [];
    forwardStackRef.current = [];
    currentRef.current = null;
  }, []);

  /**
   * Update the current entry's tab without affecting history.
   * Useful when tab changes within the same session (to update tab tracking).
   */
  const updateCurrentTab = useCallback((tabId: string | undefined) => {
    if (currentRef.current) {
      currentRef.current = {
        ...currentRef.current,
        tabId
      };
    }
  }, []);

  return {
    pushNavigation,
    navigateBack,
    navigateForward,
    canGoBack,
    canGoForward,
    clearHistory,
    updateCurrentTab,
  };
}
