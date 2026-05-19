/**
 * useAIMessageHistory — in-memory, per-session AI input history navigation.
 *
 * Implements terminal-style up/down arrow history for the AI chat input:
 * - ArrowUp at position 0 navigates to the previous sent message
 * - ArrowDown walks forward, restoring the saved draft at the end
 * - The current draft is preserved when navigation starts and restored
 *   when the user returns to the bottom of the history stack
 * - History is scoped per session and lives only for the app session
 *   (not persisted across restarts)
 */

import { useRef, useCallback } from 'react';

const MAX_HISTORY_SIZE = 100;

export interface UseAIMessageHistoryReturn {
	/**
	 * Navigate to the previous message in history.
	 * Saves `currentValue` as draft on first call (index was -1).
	 * Returns the message to display, or null if already at the oldest entry.
	 */
	navigateBack: (sessionId: string, currentValue: string) => string | null;
	/**
	 * Navigate to the next message in history.
	 * Returns the message to display, or the saved draft when reaching the end.
	 * Returns null if not currently navigating.
	 */
	navigateForward: (sessionId: string) => string | null;
	/**
	 * Record a sent message into the history for the given session.
	 * Skips empty strings and consecutive duplicates.
	 * Resets the navigation index back to -1.
	 */
	recordMessage: (sessionId: string, message: string) => void;
	/**
	 * Returns true when the user is mid-navigation (index !== -1).
	 * Used to decide whether ArrowDown should be intercepted.
	 */
	isNavigating: (sessionId: string) => boolean;
}

export function useAIMessageHistory(): UseAIMessageHistoryReturn {
	// Per-session arrays of sent messages (oldest → newest)
	const historyRef = useRef<Map<string, string[]>>(new Map());
	// Per-session current navigation index (-1 = current draft, not navigating)
	const indexRef = useRef<Map<string, number>>(new Map());
	// Per-session saved draft (the text that was in the input when navigation started)
	const draftRef = useRef<Map<string, string>>(new Map());

	const getHistory = (sessionId: string): string[] => {
		if (!historyRef.current.has(sessionId)) {
			historyRef.current.set(sessionId, []);
		}
		return historyRef.current.get(sessionId)!;
	};

	const getIndex = (sessionId: string): number => {
		return indexRef.current.get(sessionId) ?? -1;
	};

	const recordMessage = useCallback((sessionId: string, message: string) => {
		const trimmed = message.trim();
		if (!trimmed) return;
		const history = getHistory(sessionId);
		// Skip consecutive duplicate
		if (history[history.length - 1] === trimmed) return;
		history.push(trimmed);
		if (history.length > MAX_HISTORY_SIZE) history.shift();
		// Reset navigation state on send
		indexRef.current.set(sessionId, -1);
		draftRef.current.delete(sessionId);
	}, []);

	const navigateBack = useCallback((sessionId: string, currentValue: string): string | null => {
		const history = getHistory(sessionId);
		if (history.length === 0) return null;

		const currentIndex = getIndex(sessionId);

		if (currentIndex === -1) {
			// First ArrowUp — save the current draft and jump to newest history entry
			draftRef.current.set(sessionId, currentValue);
			const newIndex = history.length - 1;
			indexRef.current.set(sessionId, newIndex);
			return history[newIndex];
		} else if (currentIndex > 0) {
			// Step further back
			const newIndex = currentIndex - 1;
			indexRef.current.set(sessionId, newIndex);
			return history[newIndex];
		}

		// Already at the oldest entry — do not move
		return null;
	}, []);

	const navigateForward = useCallback((sessionId: string): string | null => {
		const currentIndex = getIndex(sessionId);
		if (currentIndex === -1) return null; // Not navigating

		const history = getHistory(sessionId);

		if (currentIndex < history.length - 1) {
			// Step forward
			const newIndex = currentIndex + 1;
			indexRef.current.set(sessionId, newIndex);
			return history[newIndex];
		} else {
			// At the newest entry — restore the saved draft
			const draft = draftRef.current.get(sessionId) ?? '';
			indexRef.current.set(sessionId, -1);
			draftRef.current.delete(sessionId);
			return draft;
		}
	}, []);

	const isNavigating = useCallback((sessionId: string): boolean => {
		return getIndex(sessionId) !== -1;
	}, []);

	return { navigateBack, navigateForward, recordMessage, isNavigating };
}
