import { useCallback, MutableRefObject } from 'react';
import type { Session } from '../../types';
import { navigateToUnifiedTabById } from '../../utils/tabHelpers';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { resolveActiveNavTab } from './useNavigationHistory';
import type { NavEntryUsable, NavHistoryEntry } from './useNavigationHistory';

/**
 * Dependencies required by the useSessionNavigation hook
 */
export interface UseSessionNavigationDeps {
	/** Function from useNavigationHistory to navigate back */
	navigateBack: (canUse?: NavEntryUsable) => NavHistoryEntry | null;
	/** Function from useNavigationHistory to navigate forward */
	navigateForward: (canUse?: NavEntryUsable) => NavHistoryEntry | null;
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
		[sessions, setActiveSessionId, cyclePositionRef, setSessions, onNavigateToGroupChat]
	);

	// Would visiting this entry actually take the user somewhere?
	//
	// Two kinds of entry answer no, and both used to be visited anyway - the
	// keypress consumed the entry and moved nothing, which is what made
	// breadcrumb navigation feel dead after a few tabs were closed:
	//   - STALE: the agent was deleted, or the tab was closed (Cmd+W, unread
	//     filtering, a worktree teardown). navigateToUnifiedTabById is the same
	//     resolver the restore path uses, so "can't resolve" here means exactly
	//     "restore would no-op".
	//   - REDUNDANT: the entry names the tab already on screen. Recording pushes
	//     one entry per active-tab change, but a close or a filter change can
	//     land the user back on a tab that is already the newest entry.
	// Read live state rather than the render-time `sessions` prop so a rapid
	// sequence of presses judges each hop against the state the previous hop
	// produced.
	const canUseEntry = useCallback<NavEntryUsable>((entry: NavHistoryEntry): boolean => {
		const activeGroupChatId = useGroupChatStore.getState().activeGroupChatId;

		if (entry.groupChatId) {
			const exists = useGroupChatStore
				.getState()
				.groupChats.some((chat) => chat.id === entry.groupChatId);
			return exists && entry.groupChatId !== activeGroupChatId;
		}

		if (!entry.sessionId) return false;
		const { sessions: liveSessions, activeSessionId } = useSessionStore.getState();
		const session = liveSessions.find((s) => s.id === entry.sessionId);
		if (!session) return false;

		// Legacy entries predate tabKind and only ever pointed at AI tabs.
		const targetKind = entry.tabKind ?? 'ai';
		if (entry.tabId && !navigateToUnifiedTabById(session, targetKind, entry.tabId)) {
			return false;
		}

		// A group chat is covering the panel, so any agent entry is a real move.
		if (activeGroupChatId) return true;
		if (entry.sessionId !== activeSessionId) return true;

		// Same agent: only a move when it targets a different tab than the visible one.
		const current = resolveActiveNavTab(session);
		return !(current.tabId === entry.tabId && (current.tabKind ?? 'ai') === targetKind);
	}, []);

	// Navigate back in history (through sessions, tabs, and group chats)
	const handleNavBack = useCallback(() => {
		const entry = navigateBack(canUseEntry);
		if (entry) navigateToEntry(entry);
	}, [navigateBack, navigateToEntry, canUseEntry]);

	// Navigate forward in history (through sessions, tabs, and group chats)
	const handleNavForward = useCallback(() => {
		const entry = navigateForward(canUseEntry);
		if (entry) navigateToEntry(entry);
	}, [navigateForward, navigateToEntry, canUseEntry]);

	return {
		handleNavBack,
		handleNavForward,
	};
}
