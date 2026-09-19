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
import type { QueuedItem, QueuedItemEditPatch } from '../../types';
import { aiTabFocusFields, resolveQueuedItemTarget } from '../../utils/tabHelpers';
import { notifyToast } from '../../stores/notificationStore';
import {
	applyQueuedItemDispatch,
	applyQueuedItemEdit,
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
	handleEditQueueItem: (sessionId: string, itemId: string, patch: QueuedItemEditPatch) => void;
	/** Dispatch one queued item immediately, out of queue order */
	handleForceSendQueueItem: (sessionId: string, itemId: string) => void;
	/**
	 * Steer a queued message into the turn ALREADY RUNNING on its tab, rather than
	 * waiting for that turn to finish. Claude-interactive turns only - see
	 * getSteerEligibility.
	 */
	handleSteerQueueItem: (sessionId: string, itemId: string) => Promise<void>;
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
		(sessionId: string, itemId: string, patch: QueuedItemEditPatch) => {
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
			const crossAgent = {
				crossAgentMention: !!mentionPlan,
				crossAgentOnly: mentionPlan?.suppressLocal ?? false,
			};
			setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId
						? {
								...s,
								executionQueue: applyQueuedItemEdit(s.executionQueue, itemId, patch, crossAgent),
							}
						: s
				)
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

			// Recovery (release the tab, take the card back, re-queue the prompt) is
			// owned by `agentStore.processQueuedItem`'s catch, which is the only place
			// that knows WHY the dispatch failed. This rejection still needs an owner
			// so it does not surface as an unhandled promise crash report.
			processQueuedItem(sessionId, dispatchItem).catch((err) => {
				logger.error('[ForceSend] Dispatch failed, item returned to queue', undefined, err);
			});
		},
		[processQueuedItem]
	);

	// Steering: hand this message to the turn already in flight so claude can change
	// course mid-task. The inverse of Force Send above - that one needs the tab IDLE
	// and spawns a turn, this one needs it BUSY and types into the live TUI.
	//
	// Nothing here decides whether the turn CAN be steered. maestro-p owns that (it
	// is the only party holding the TUI screen) and answers with a verdict; the UI's
	// job is to act on the answer without ever losing the user's message.
	const handleSteerQueueItem = useCallback(async (sessionId: string, itemId: string) => {
		const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
		const item = session?.executionQueue?.find((i) => i.id === itemId);
		if (!session || !item) return;

		const target = resolveQueuedItemTarget(session, item);
		if (!target) return;
		const processKey = `${sessionId}-ai-${target.tabId}`;

		const steer = window.maestro?.process?.steer;
		if (!steer) {
			// Web renderer, or a build without the bridge. Say so rather than leaving
			// the click silent.
			notifyToast({
				color: 'yellow',
				title: 'Steering unavailable',
				message: 'This client cannot steer a running turn.',
			});
			return;
		}

		// Guarded by getSteerEligibility before the button renders; re-checked because
		// this hook is also reachable from a surface that has not asked.
		const text = item.text?.trim();
		if (!text || item.images?.length) return;

		const result = await steer(processKey, text);

		// Delivered: claude has the text, so the queue must let go of it or the same
		// message sends again when the turn ends. What claude DOES with it (absorbed
		// into this turn, or run as a follow-up) arrives later on maestro-p's stdout
		// and is not known here - see SteeringVerdict.
		if (
			result.verdict === 'delivered' ||
			result.verdict === 'absorbed' ||
			result.verdict === 'queued'
		) {
			setSessions((prev) =>
				prev.map((s) =>
					s.id === sessionId
						? { ...s, executionQueue: s.executionQueue.filter((i) => i.id !== itemId) }
						: s
				)
			);
			notifyToast({
				color: 'green',
				title: 'Steered the running turn',
				message: 'Claude received your message while it was working.',
				sessionId,
				tabId: target.tabId,
			});
			return;
		}

		// Refused: nothing was typed, so the message is still ours and stays queued
		// exactly where it was. It will send normally when the turn ends.
		if (result.verdict === 'refused') {
			notifyToast({
				color: 'yellow',
				title: 'Could not steer this turn',
				message: `${result.detail ?? 'Claude could not take the message right now.'} It stays queued.`,
				sessionId,
				tabId: target.tabId,
			});
			return;
		}

		// Unknown: the text MAY have been typed and we never got confirmation. Both
		// automatic choices are wrong here - dropping the item can lose a message the
		// user wrote, and leaving it queued sends it a second time without asking. So
		// PAUSE it: the message is kept, nothing sends behind the user's back, and the
		// card's own play button is the one-click resolution.
		setSessions((prev) =>
			prev.map((s) =>
				s.id === sessionId
					? {
							...s,
							executionQueue: s.executionQueue.map((i) =>
								i.id === itemId ? { ...i, paused: true } : i
							),
						}
					: s
			)
		);
		notifyToast({
			color: 'orange',
			title: 'Steering result unconfirmed',
			message:
				'Claude may or may not have received the message, so it has been paused rather than sent twice. Resume it if the agent never answered it.',
			dismissible: true,
			sessionId,
			tabId: target.tabId,
		});
	}, []);

	return {
		handleRemoveQueueItem,
		handleSwitchQueueSession,
		handleReorderQueueItems,
		handleTogglePauseQueueItem,
		handleEditQueueItem,
		handleForceSendQueueItem,
		handleSteerQueueItem,
	};
}
