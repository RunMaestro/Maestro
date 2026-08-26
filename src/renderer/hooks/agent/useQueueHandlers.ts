/**
 * useQueueHandlers - extracted from App.tsx
 *
 * Provides handlers for managing the execution queue UI:
 *   - Remove a queued item from a session
 *   - Switch to a session that has queued items
 *   - Reorder queued items within a session
 *   - Force send a queued item out of turn
 *
 * Reads from: sessionStore (setSessions, setActiveSessionId)
 */

import { useCallback } from 'react';
import type { QueuedItem } from '../../types';
import { aiTabFocusFields } from '../../utils/tabHelpers';
import {
	applyQueuedItemDispatch,
	applyQueuedItemRelease,
	getQueueBusyContext,
} from '../../utils/executionQueue';
import { useSessionStore } from '../../stores/sessionStore';
import { planCrossAgentMentions } from '../../services/crossAgentMentions';
import { logger } from '../../utils/logger';

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
	handleEditQueueItem: (
		sessionId: string,
		itemId: string,
		patch: { text: string; images: string[] }
	) => void;
	/** Dispatch one queued item immediately, out of queue order */
	handleForceSendQueueItem: (sessionId: string, itemId: string) => void;
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
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				return {
					...s,
					executionQueue: s.executionQueue.map((item) =>
						item.id === itemId ? { ...item, paused: !item.paused } : item
					),
				};
			})
		);
	}, []);

	const handleEditQueueItem = useCallback(
		(sessionId: string, itemId: string, patch: { text: string; images: string[] }) => {
			// Re-resolve the pending consult against the EDITED text: the user may
			// have added or removed an `@agent` mention, and the item's stale flag
			// would otherwise consult the wrong agent (or nobody) when it dispatches.
			//
			// BOTH flags have to be re-derived, not just `crossAgentMention`. Whether
			// this agent answers at all is decided by where the mention sits, and the
			// edit can move it: `@Codex do X` -> `do X, and @Codex too` must go back to
			// spawning locally, and the reverse must stop spawning. Leaving
			// `crossAgentOnly` behind silently discards half of what the user edited.
			const mentionPlan = planCrossAgentMentions(patch.text, sessionId);
			const crossAgentMention = !!mentionPlan;
			const crossAgentOnly = mentionPlan?.suppressLocal ?? false;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						executionQueue: s.executionQueue.map((item) =>
							item.id === itemId
								? {
										...item,
										text: patch.text,
										images: patch.images,
										crossAgentMention,
										crossAgentOnly,
									}
								: item
						),
					};
				})
			);
		},
		[]
	);

	// Force Send: run this exact item now instead of waiting for its turn. Used by
	// the Execution Queue browser (any agent, any tab) and by the inline chat
	// list's Force Send button, so both surfaces share one dispatch path.
	const handleForceSendQueueItem = useCallback(
		(sessionId: string, itemId: string) => {
			const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
			const item = session?.executionQueue?.find((i) => i.id === itemId);
			if (!session || !item) return;

			// A tab runs one turn at a time - never spawn over an in-flight one.
			const { targetTabBusy, otherBusyTabs } = getQueueBusyContext(session, item);
			if (targetTabBusy) return;

			// Stamp forceParallel when another tab is mid-turn: it badges the chat log
			// entry and tells the on-exit dequeue guard this turn was a deliberate
			// override rather than a normal sequential dispatch.
			const dispatchItem: QueuedItem =
				otherBusyTabs.length > 0 ? { ...item, forceParallel: true } : item;

			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? applyQueuedItemDispatch(s, dispatchItem) : s))
			);

			processQueuedItem(sessionId, dispatchItem).catch((err) => {
				logger.error('[ForceSend] Dispatch failed, re-queueing item', undefined, err);
				// Put the item back at the front and release the tab. The agent only
				// returns to idle if no OTHER tab is still working.
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...applyQueuedItemRelease(s, dispatchItem.tabId),
							executionQueue: [dispatchItem, ...s.executionQueue],
						};
					})
				);
			});
		},
		[processQueuedItem]
	);

	return {
		handleRemoveQueueItem,
		handleSwitchQueueSession,
		handleReorderQueueItems,
		handleTogglePauseQueueItem,
		handleEditQueueItem,
		handleForceSendQueueItem,
	};
}
