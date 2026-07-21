import { useCallback } from 'react';
import type { Session } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { getActiveTab } from '../../utils/tabHelpers';

/**
 * Dependencies required by the useInputSync hook
 */
export interface UseInputSyncDeps {
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

/**
 * Optional pin so blur/replay restore write to the composer that owned the draft,
 * not whichever agent is active when the callback runs (focus can move first).
 */
export interface InputSyncTarget {
	sessionId: string;
	tabId?: string;
}

/**
 * Return type for the useInputSync hook
 */
export interface UseInputSyncReturn {
	/**
	 * Persist AI input value to a session tab.
	 * Called on blur/submit to sync local input state to session state.
	 * Prefer passing `target` when the write must follow a prior focus/replay
	 * (live getState can point at a different agent after a fast switch).
	 */
	syncAiInputToSession: (value: string, target?: InputSyncTarget) => void;
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
 * PERF: Resolves the active session via getState() when no explicit target is
 * passed. Callers must not pass a React-subscribed Session - that would
 * re-render App / MaestroConsoleInner on every streaming log or token update.
 *
 * Extracted from App.tsx to reduce file size and improve maintainability.
 * These are simple session state updates with no async operations.
 *
 * @param deps - Dependencies including state setters
 * @returns Object containing input sync functions
 */
export function useInputSync(deps: UseInputSyncDeps): UseInputSyncReturn {
	const { setSessions } = deps;

	// Function to persist AI input to session state (called on blur/submit)
	const syncAiInputToSession = useCallback(
		(value: string, target?: InputSyncTarget) => {
			const live = selectActiveSession(useSessionStore.getState());
			const sessionId = target?.sessionId ?? live?.id;
			if (!sessionId) return;

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					const tabId = target?.tabId ?? getActiveTab(s)?.id;
					if (!tabId) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, inputValue: value } : tab)),
					};
				})
			);
		},
		[setSessions]
	);

	// Function to persist terminal input to session state (called on blur/session switch)
	const syncTerminalInputToSession = useCallback(
		(value: string, sessionId?: string) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			const targetSessionId = sessionId || activeSession?.id;
			if (!targetSessionId) return;
			setSessions((prev) =>
				prev.map((s) => (s.id === targetSessionId ? { ...s, terminalDraftInput: value } : s))
			);
		},
		[setSessions]
	);

	return {
		syncAiInputToSession,
		syncTerminalInputToSession,
	};
}
