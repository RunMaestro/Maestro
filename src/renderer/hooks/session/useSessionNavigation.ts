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
	/** Navigate to a group chat (loads messages, starts moderator) */
	onNavigateToGroupChat?: (id: string) => Promise<void>;
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
	const {
		navigateBack,
		navigateForward,
		setActiveSessionId,
		setSessions,
		cyclePositionRef,
		onNavigateToGroupChat,
	} = deps;

	// Shared logic for navigating to a history entry
	const navigateToEntry = useCallback(
		(entry: NavHistoryEntry) => {
			// Group chat entry
			if (entry.groupChatId) {
				onNavigateToGroupChat?.(entry.groupChatId);
				return;
			}

			// Session entry
			if (!entry.sessionId) return;
			const sessionExists = sessions.some((s) => s.id === entry.sessionId);
			if (!sessionExists) return;

			setActiveSessionId(entry.sessionId);
			cyclePositionRef.current = -1;

			if (entry.tabId) {
				const targetTabId = entry.tabId;
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id === entry.sessionId && s.aiTabs?.some((t) => t.id === targetTabId)) {
							return { ...s, activeTabId: targetTabId };
						}
						return s;
					})
				);
			}
		},
		[sessions, setActiveSessionId, cyclePositionRef, setSessions, onNavigateToGroupChat]
	);

	// Navigate back in history (through sessions, tabs, and group chats)
	const handleNavBack = useCallback(() => {
		const entry = navigateBack();
		if (entry) navigateToEntry(entry);
	}, [navigateBack, navigateToEntry]);

	// Navigate forward in history (through sessions, tabs, and group chats)
	const handleNavForward = useCallback(() => {
		const entry = navigateForward();
		if (entry) navigateToEntry(entry);
	}, [navigateForward, navigateToEntry]);

	return {
		handleNavBack,
		handleNavForward,
	};
}
