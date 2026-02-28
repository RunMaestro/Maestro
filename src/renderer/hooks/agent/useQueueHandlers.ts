/**
 * useQueueHandlers — extracted from App.tsx
 *
 * Provides handlers for managing the execution queue UI:
 *   - Remove a queued item from a session
 *   - Switch to a session that has queued items
 *   - Reorder queued items within a session
 *
 * Reads from: sessionStore (setSessions, setActiveSessionId)
 */

import { useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';

// ============================================================================
// Return type
// ============================================================================

export interface UseQueueHandlersReturn {
	/** Remove a queued item from a session's execution queue */
	handleRemoveQueueItem: (sessionId: string, itemId: string) => void;
	/** Switch active session to the given session */
	handleSwitchQueueSession: (sessionId: string) => void;
	/** Reorder queued items within a session (move item from fromIndex to toIndex) */
	handleReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useQueueHandlers(): UseQueueHandlersReturn {
	// --- Store actions (stable via getState) ---
	const { setSessions, setActiveSessionId } = useSessionStore.getState();

	const handleRemoveQueueItem = useCallback((sessionId: string, itemId: string) => {
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				return {
					...s,
					executionQueue: s.executionQueue.filter((item) => item.id !== itemId),
				};
			})
		);
	}, []);

	const handleSwitchQueueSession = useCallback((sessionId: string) => {
		setActiveSessionId(sessionId);
	}, []);

	const handleReorderQueueItems = useCallback(
		(sessionId: string, fromIndex: number, toIndex: number) => {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					const len = s.executionQueue.length;
					if (
						fromIndex === toIndex ||
						fromIndex < 0 ||
						fromIndex >= len ||
						toIndex < 0 ||
						toIndex >= len
					)
						return s;
					const queue = [...s.executionQueue];
					const [removed] = queue.splice(fromIndex, 1);
					queue.splice(toIndex, 0, removed);
					return { ...s, executionQueue: queue };
				})
			);
		},
		[]
	);

	return {
		handleRemoveQueueItem,
		handleSwitchQueueSession,
		handleReorderQueueItems,
	};
}
