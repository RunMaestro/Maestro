import { useCallback } from 'react';
import type { Session } from '../types';
import { getActiveTab } from '../utils/tabHelpers';

/**
 * Dependencies required by the useInputSync hook
 */
export interface UseInputSyncDeps {
  /** Session state setter */
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

/**
 * Return type for the useInputSync hook
 */
export interface UseInputSyncReturn {
  /**
   * Persist AI input value to the active session's active tab.
   * Called on blur/submit to sync local input state to session state.
   */
  syncAiInputToSession: (value: string) => void;
  /**
   * Persist terminal input value to a session.
   * Called on blur/session switch to sync local input state to session state.
   * @param value - The terminal input value to persist
   * @param sessionId - Optional session ID (defaults to active session)
   */
  syncTerminalInputToSession: (value: string, sessionId?: string) => void;
}

/**
 * Hook that provides input synchronization functions for persisting
 * local input state to session state.
 *
 * Extracted from App.tsx to reduce file size and improve maintainability.
 * These are simple session state updates with no async operations.
 *
 * @param activeSession - The currently active session (can be null)
 * @param deps - Dependencies including state setters
 * @returns Object containing input sync functions
 */
export function useInputSync(
  activeSession: Session | null,
  deps: UseInputSyncDeps
): UseInputSyncReturn {
  const { setSessions } = deps;

  // Function to persist AI input to session state (called on blur/submit)
  const syncAiInputToSession = useCallback((value: string) => {
    if (!activeSession) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      const currentActiveTab = getActiveTab(s);
      if (!currentActiveTab) return s;
      return {
        ...s,
        aiTabs: s.aiTabs.map(tab =>
          tab.id === currentActiveTab.id
            ? { ...tab, inputValue: value }
            : tab
        )
      };
    }));
  }, [activeSession, setSessions]);

  // Function to persist terminal input to session state (called on blur/session switch)
  const syncTerminalInputToSession = useCallback((value: string, sessionId?: string) => {
    const targetSessionId = sessionId || activeSession?.id;
    if (!targetSessionId) return;
    setSessions(prev => prev.map(s =>
      s.id === targetSessionId ? { ...s, terminalDraftInput: value } : s
    ));
  }, [activeSession?.id, setSessions]);

  return {
    syncAiInputToSession,
    syncTerminalInputToSession,
  };
}
