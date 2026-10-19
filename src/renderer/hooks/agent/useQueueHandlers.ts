/**
 * useQueueHandlers - extracted from App.tsx
 *
 * Provides handlers for managing the execution queue UI:
 *   - Remove a queued item from a session
 *   - Switch to a session that has queued items
 *   - Reorder queued items within a session
 *   - Force send a queued item out of turn
 *   - Merge a queued message into the earlier message for its tab
 *
 * Reads from: sessionStore (setSessions, setActiveSessionId)
 */

import { useCallback } from 'react';
import type { QueuedItem, QueuedItemEditPatch } from '../../types';
import { aiTabFocusFields } from '../../utils/tabHelpers';
import { steerQueuedItem } from '../../services/chatSteering';
import type { QueueSteerResult } from '../../../shared/chatSteering';
import { useSessionStore } from '../../stores/sessionStore';
import {
	editQueuedItem,
	mergeQueuedItemIntoAbove,
	sendQueuedItemNow,
	toggleQueuedItemPaused,
} from '../../services/queuedPrompt';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseQueueHandlersDeps {
	/** Dispatches a queued item to its agent (from useQueueProcessing) */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseQueueHandlersReturn {
	/** Remove a queued item from a session's execution queue */
	handleRemoveQueueItem: (sessionId: string, itemId: string) => void;
	/** Switch active session to the given session and optionally activate a specific tab */
	handleSwitchQueueSession: (sessionId: string, tabId?: string) => void;
	/** Reorder queued items within a session (move item from fromIndex to toIndex) */
	handleReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;
	/** Toggle the held/paused state of a queued item (held items are skipped by dispatch) */
	handleTogglePauseQueueItem: (sessionId: string, itemId: string) => void;
	/** Edit a queued message's prompt text and attached images within a session */
	handleEditQueueItem: (sessionId: string, itemId: string, patch: QueuedItemEditPatch) => void;
	/** Dispatch one queued item immediately, out of queue order */
	handleForceSendQueueItem: (sessionId: string, itemId: string) => void;
	/**
	 * Steer a queued message into the turn ALREADY RUNNING on its tab, rather than
	 * waiting for that turn to finish. Claude-interactive turns only - see
	 * getSteerEligibility.
	 */
	handleSteerQueueItem: (sessionId: string, itemId: string) => Promise<QueueSteerResult>;
	/** Fold a queued message into the earlier message for its tab (Execution Queue browser) */
	handleMergeQueueItem: (sessionId: string, itemId: string) => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useQueueHandlers({
	processQueuedItem,
}: UseQueueHandlersDeps): UseQueueHandlersReturn {
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

	const handleSwitchQueueSession = useCallback((sessionId: string, tabId?: string) => {
		setActiveSessionId(sessionId);
		if (tabId) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id === sessionId && s.aiTabs?.some((t) => t.id === tabId)) {
						return { ...s, ...aiTabFocusFields(tabId) };
					}
					return s;
				})
			);
		}
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

	const handleTogglePauseQueueItem = useCallback((sessionId: string, itemId: string) => {
		toggleQueuedItemPaused(sessionId, itemId);
	}, []);

	// One edit rule for every queued edit (this browser, the inline cards, a tab
	// window): `editQueuedItem` also plans the consult again from the edited text.
	const handleEditQueueItem = useCallback(
		(sessionId: string, itemId: string, patch: QueuedItemEditPatch) => {
			editQueuedItem(sessionId, itemId, patch);
		},
		[]
	);

	// Force Send: run this exact item now instead of waiting for its turn. Used by
	// the Execution Queue browser (any agent, any tab) and by the inline chat
	// list's Force Send button, so both surfaces share one dispatch path.
	// The rules (never over an in-flight turn, forceParallel beside another tab's,
	// who owns a failed dispatch) live in `sendQueuedItemNow`.
	const handleForceSendQueueItem = useCallback(
		(sessionId: string, itemId: string) => {
			sendQueuedItemNow(sessionId, itemId, processQueuedItem);
		},
		[processQueuedItem]
	);

	// Steering: hand this message to the turn already in flight so claude can change
	// course mid-task. The inverse of Force Send above - that one needs the tab IDLE
	// and spawns a turn, this one needs it BUSY and types into the live TUI. The
	// whole flow, including what happens when the transcript answers later, lives in
	// services/chatSteering.ts.
	const handleSteerQueueItem = useCallback(
		(sessionId: string, itemId: string) => steerQueuedItem(sessionId, itemId),
		[]
	);

	// Merge: the same service the inline card's Merge button and
	// `maestro-cli queue merge` reach, so the rules cannot differ by surface.
	const handleMergeQueueItem = useCallback((sessionId: string, itemId: string) => {
		mergeQueuedItemIntoAbove(sessionId, itemId);
	}, []);

	return {
		handleRemoveQueueItem,
		handleSwitchQueueSession,
		handleReorderQueueItems,
		handleTogglePauseQueueItem,
		handleEditQueueItem,
		handleForceSendQueueItem,
		handleSteerQueueItem,
		handleMergeQueueItem,
	};
}
