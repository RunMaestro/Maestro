/**
 * useDebouncedPersistence.ts
 *
 * A hook that debounces session persistence to reduce disk writes.
 * During AI streaming, sessions can change 100+ times per second.
 * This hook batches those changes and writes at most once every 2 seconds.
 *
 * Features:
 * - Configurable debounce delay (default 2 seconds)
 * - Flush-on-unmount to prevent data loss
 * - isPending state for UI feedback
 * - flushNow() for immediate persistence at critical moments
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Session } from '../../types';

// Maximum persisted logs per AI tab (matches session persistence limit)
const MAX_PERSISTED_LOGS_PER_TAB = 100;

/**
 * Prepare a session for persistence by:
 * 1. Truncating logs in each AI tab to MAX_PERSISTED_LOGS_PER_TAB entries
 * 2. Resetting runtime-only state (busy state, thinking time, etc.)
 * 3. Excluding runtime-only fields (closedTabHistory, agentError, etc.)
 *
 * This ensures sessions don't get stuck in busy state after app restart,
 * since underlying processes are gone after restart.
 *
 * This is a local copy to avoid circular imports in session persistence logic.
 */
const prepareSessionForPersistence = (session: Session): Session => {
  // If no aiTabs, return as-is (shouldn't happen after migration)
  if (!session.aiTabs || session.aiTabs.length === 0) {
    return session;
  }

  // Truncate logs and reset runtime state in each tab
  const truncatedTabs = session.aiTabs.map(tab => ({
    ...tab,
    logs: tab.logs.length > MAX_PERSISTED_LOGS_PER_TAB
      ? tab.logs.slice(-MAX_PERSISTED_LOGS_PER_TAB)
      : tab.logs,
    // Reset runtime-only tab state - processes don't survive app restart
    state: 'idle' as const,
    thinkingStartTime: undefined,
    agentError: undefined,
  }));

  // Return session without runtime-only fields
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { closedTabHistory, agentError, agentErrorPaused, agentErrorTabId, ...sessionWithoutRuntimeFields } = session;

  return {
    ...sessionWithoutRuntimeFields,
    aiTabs: truncatedTabs,
    // Reset runtime-only session state - processes don't survive app restart
    state: 'idle',
    busySource: undefined,
    thinkingStartTime: undefined,
    currentCycleTokens: undefined,
    currentCycleBytes: undefined,
    statusMessage: undefined,
  } as Session;
};

export interface UseDebouncedPersistenceReturn {
  /** True if there are pending changes that haven't been persisted yet */
  isPending: boolean;
  /** Force immediate persistence of pending changes */
  flushNow: () => void;
}

/** Default debounce delay in milliseconds */
export const DEFAULT_DEBOUNCE_DELAY = 2000;

/**
 * Hook that debounces session persistence to reduce disk writes.
 *
 * @param sessions - Array of sessions to persist
 * @param initialLoadComplete - Ref indicating if initial load is done (prevents persisting on mount)
 * @param delay - Debounce delay in milliseconds (default 2000)
 * @returns Object with isPending state and flushNow function
 */
export function useDebouncedPersistence(
  sessions: Session[],
  initialLoadComplete: React.MutableRefObject<boolean>,
  delay: number = DEFAULT_DEBOUNCE_DELAY
): UseDebouncedPersistenceReturn {
  // Track if there are pending changes
  const [isPending, setIsPending] = useState(false);

  // Store the latest sessions in a ref for access in flush callbacks
  const sessionsRef = useRef<Session[]>(sessions);
  sessionsRef.current = sessions;

  // Store the timer ID for cleanup
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if flush is in progress to prevent double-flushing
  const flushingRef = useRef(false);

  /**
   * Internal function to persist sessions immediately.
   * Called by both the debounce timer and flushNow.
   */
  const persistSessions = useCallback(() => {
    if (flushingRef.current) return;

    flushingRef.current = true;
    try {
      const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
      window.maestro.sessions.setAll(sessionsForPersistence);
      setIsPending(false);
    } finally {
      flushingRef.current = false;
    }
  }, []);

  /**
   * Force immediate persistence of pending changes.
   * Use this for critical moments like:
   * - Session deletion/rename
   * - App quit/visibility change
   * - Tab switching
   */
  const flushNow = useCallback(() => {
    // Clear any pending timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Only flush if there are pending changes
    if (isPending) {
      persistSessions();
    }
  }, [isPending, persistSessions]);

  // Debounced persistence effect
  useEffect(() => {
    // Skip persistence during initial load
    if (!initialLoadComplete.current) {
      return;
    }

    // Mark as pending
    setIsPending(true);

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Set new debounce timer
    timerRef.current = setTimeout(() => {
      persistSessions();
      timerRef.current = null;
    }, delay);

    // Cleanup on unmount or when sessions change
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [sessions, delay, initialLoadComplete, persistSessions]);

  // Flush on unmount to prevent data loss
  useEffect(() => {
    return () => {
      // On unmount, if there are pending changes, persist immediately
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Only flush if initial load is complete - otherwise we might save an empty array
      // before sessions have been loaded, wiping out the user's data
      if (initialLoadComplete.current) {
        const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
        window.maestro.sessions.setAll(sessionsForPersistence);
      }
    };
  }, []);

  // Flush on visibility change (user switching away from app)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isPending) {
        flushNow();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPending, flushNow]);

  // Flush on beforeunload (app closing)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isPending) {
        // Synchronous flush for beforeunload
        const sessionsForPersistence = sessionsRef.current.map(prepareSessionForPersistence);
        window.maestro.sessions.setAll(sessionsForPersistence);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isPending]);

  return { isPending, flushNow };
}
