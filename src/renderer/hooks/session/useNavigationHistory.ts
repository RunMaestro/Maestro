import { useRef, useCallback } from 'react';
import type { Session } from '../../types';

// Kind of tab a navigation entry points at. Mirrors UnifiedTabRef['type'].
export type NavTabKind = 'ai' | 'file' | 'terminal' | 'browser';

// Navigation history entry - tracks session/tab position or group chat
export interface NavHistoryEntry {
	sessionId?: string;
	tabId?: string; // ID of the active tab within the session (any kind)
	tabKind?: NavTabKind; // Kind of the active tab; absent/legacy entries are treated as 'ai'
	groupChatId?: string; // Set when navigating to a group chat
}

/**
 * Resolve the active tab of a session into a breadcrumb descriptor (id + kind).
 *
 * Priority mirrors findActiveUnifiedTabIndex (terminal > file > browser > ai)
 * so the breadcrumb tracks whichever tab the user actually sees.
 *
 * Shared by BOTH sides of the breadcrumb: the recorder (useSessionLifecycle)
 * uses it to stamp each visit, and the navigator (useSessionNavigation) uses it
 * to tell "this entry would move me" from "this entry is where I already am".
 * One definition, so the two can never drift into disagreeing about what the
 * current position is.
 */
export function resolveActiveNavTab(session: Session): { tabId?: string; tabKind?: NavTabKind } {
	if (session.activeTerminalTabId) {
		return { tabId: session.activeTerminalTabId, tabKind: 'terminal' };
	}
	if (session.activeFileTabId) {
		return { tabId: session.activeFileTabId, tabKind: 'file' };
	}
	if (session.activeBrowserTabId) {
		return { tabId: session.activeBrowserTabId, tabKind: 'browser' };
	}
	if (session.aiTabs?.length > 0) {
		return { tabId: session.activeTabId, tabKind: 'ai' };
	}
	return {};
}

/**
 * Can this entry still be navigated to, and would going there actually move the
 * view? Supplied by the caller (which owns session state) to
 * {@link useNavigationHistory}'s navigateBack/navigateForward.
 */
export type NavEntryUsable = (entry: NavHistoryEntry) => boolean;

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
		if (
			currentRef.current &&
			currentRef.current.sessionId === entry.sessionId &&
			currentRef.current.tabId === entry.tabId &&
			currentRef.current.tabKind === entry.tabKind &&
			currentRef.current.groupChatId === entry.groupChatId
		) {
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
	 * Pop the newest entry from `stack` that the caller says is still usable,
	 * DISCARDING every entry it has to step over.
	 *
	 * Discarding is the point. An entry is unusable for one of two reasons, and
	 * neither can heal: the tab or agent it names is gone, or it names the spot
	 * the user is already looking at. Keeping such an entry made Cmd+Shift+, a
	 * dead key - each press silently burned one tombstone and moved nothing, so
	 * closing a couple of tabs was enough to make breadcrumb navigation look
	 * broken. Dropping them means one press always produces one visible move.
	 */
	const popUsable = (stack: NavHistoryEntry[], canUse?: NavEntryUsable): NavHistoryEntry | null => {
		while (stack.length > 0) {
			const candidate = stack.pop()!;
			if (!canUse || canUse(candidate)) return candidate;
		}
		return null;
	};

	/**
	 * Navigate back in history. Returns the entry to navigate to, or null if can't go back.
	 *
	 * @param canUse - Optional filter; entries it rejects are dropped, not visited.
	 */
	const navigateBack = useCallback((canUse?: NavEntryUsable): NavHistoryEntry | null => {
		const entry = popUsable(historyRef.current, canUse);
		if (!entry) {
			return null;
		}

		isNavigatingRef.current = true;

		// Push current to forward stack
		if (currentRef.current) {
			forwardStackRef.current.push(currentRef.current);
		}

		currentRef.current = entry;

		// Reset flag after a tick to allow the navigation to complete
		setTimeout(() => {
			isNavigatingRef.current = false;
		}, 0);

		return entry;
	}, []);

	/**
	 * Navigate forward in history. Returns the entry to navigate to, or null if can't go forward.
	 *
	 * @param canUse - Optional filter; entries it rejects are dropped, not visited.
	 */
	const navigateForward = useCallback((canUse?: NavEntryUsable): NavHistoryEntry | null => {
		const entry = popUsable(forwardStackRef.current, canUse);
		if (!entry) {
			return null;
		}

		isNavigatingRef.current = true;

		// Push current to history
		if (currentRef.current) {
			historyRef.current.push(currentRef.current);
		}

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
				tabId,
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
