import { useCallback, MutableRefObject } from 'react';
import type { Session } from '../../types';
import { navigateToUnifiedTabById } from '../../utils/tabHelpers';
import { useSessionStore } from '../../stores/sessionStore';
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
 * PERF: Session existence is checked via getState() at event time so App does
 * not need a reactive `sessions` subscription for this handler.
 *
 * @param deps - Dependencies including navigation functions and state setters
 * @returns Object containing navigation handler functions
 */
export function useSessionNavigation(deps: UseSessionNavigationDeps): UseSessionNavigationReturn {
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
			const sessionExists = useSessionStore
				.getState()
				.sessions.some((s) => s.id === entry.sessionId);
			if (!sessionExists) return;

			setActiveSessionId(entry.sessionId);
			cyclePositionRef.current = -1;

			if (entry.tabId) {
				const targetTabId = entry.tabId;
				// Legacy entries predate tabKind and only ever pointed at AI tabs.
				const targetKind = entry.tabKind ?? 'ai';
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== entry.sessionId) return s;
						// Reuse the per-kind activation logic so file/browser/terminal/ai
						// tabs all restore with the correct active-tab fields and inputMode.
						const result = navigateToUnifiedTabById(s, targetKind, targetTabId);
						return result ? result.session : s;
					})
				);
			}
		},
		[setActiveSessionId, cyclePositionRef, setSessions, onNavigateToGroupChat]
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
