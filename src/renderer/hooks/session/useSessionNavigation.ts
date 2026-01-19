import { useCallback, MutableRefObject } from 'react';
import type { Session } from '../../types';
import type { NavHistoryEntry } from './useNavigationHistory';

/**
 * Dependencies required by the useSessionNavigation hook
 */
export interface UseSessionNavigationDeps {
	/** Function from useNavigationHistory to navigate back */
	navigateBack: () => NavHistoryEntry | null;
	/** Function from useNavigationHistory to navigate forward */
	navigateForward: () => NavHistoryEntry | null;
	/** Session state setter (setActiveSessionIdInternal in App.tsx) */
	setActiveSessionId: (id: string) => void;
	/** Session list state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Ref for tracking cycle position during session cycling */
	cyclePositionRef: MutableRefObject<number>;
}

/**
 * Return type for the useSessionNavigation hook
 */
export interface UseSessionNavigationReturn {
	/**
	 * Navigate back in history (through sessions and tabs).
	 * If the target session/tab still exists, navigates to it.
	 * Resets cycle position after navigation.
	 */
	handleNavBack: () => void;
	/**
	 * Navigate forward in history (through sessions and tabs).
	 * If the target session/tab still exists, navigates to it.
	 * Resets cycle position after navigation.
	 */
	handleNavForward: () => void;
}

/**
 * Hook that provides session navigation handlers for back/forward navigation
 * through sessions and AI tabs.
 *
 * Extracted from App.tsx to reduce file size and improve maintainability.
 * Works with useNavigationHistory to implement browser-like back/forward
 * navigation across sessions and their AI conversation tabs.
 *
 * @param sessions - The current list of sessions
 * @param deps - Dependencies including navigation functions and state setters
 * @returns Object containing navigation handler functions
 */
export function useSessionNavigation(
	sessions: Session[],
	deps: UseSessionNavigationDeps
): UseSessionNavigationReturn {
	const { navigateBack, navigateForward, setActiveSessionId, setSessions, cyclePositionRef } = deps;

	// Navigate back in history (through sessions and tabs)
	const handleNavBack = useCallback(() => {
		const entry = navigateBack();
		if (entry) {
			// Check if session still exists
			const sessionExists = sessions.some((s) => s.id === entry.sessionId);
			if (sessionExists) {
				// Navigate to the session
				setActiveSessionId(entry.sessionId);
				cyclePositionRef.current = -1;

				// If there's a tab ID, also switch to that tab
				if (entry.tabId) {
					const targetTabId = entry.tabId; // Capture in variable to satisfy TypeScript narrowing
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id === entry.sessionId && s.aiTabs?.some((t) => t.id === targetTabId)) {
								return { ...s, activeTabId: targetTabId };
							}
							return s;
						})
					);
				}
			}
		}
	}, [navigateBack, sessions, setActiveSessionId, cyclePositionRef, setSessions]);

	// Navigate forward in history (through sessions and tabs)
	const handleNavForward = useCallback(() => {
		const entry = navigateForward();
		if (entry) {
			// Check if session still exists
			const sessionExists = sessions.some((s) => s.id === entry.sessionId);
			if (sessionExists) {
				// Navigate to the session
				setActiveSessionId(entry.sessionId);
				cyclePositionRef.current = -1;

				// If there's a tab ID, also switch to that tab
				if (entry.tabId) {
					const targetTabId = entry.tabId; // Capture in variable to satisfy TypeScript narrowing
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id === entry.sessionId && s.aiTabs?.some((t) => t.id === targetTabId)) {
								return { ...s, activeTabId: targetTabId };
							}
							return s;
						})
					);
				}
			}
		}
	}, [navigateForward, sessions, setActiveSessionId, cyclePositionRef, setSessions]);

	return {
		handleNavBack,
		handleNavForward,
	};
}
