import type { LogEntry, QueuedItem, Session, SessionState } from '../../../types';
import { resolveQueuedItemTarget } from '../../../utils/tabHelpers';
import { takeNextRunnableQueueItem } from '../../../utils/executionQueue';

export interface AgentQueueExitTransition {
	session: Session;
	dequeuedItem: QueuedItem | null;
}

/**
 * Applies the state transition after an agent exits. The first runnable item is
 * removed without moving held work or later items; callers own dispatching the
 * returned item after the state update has been scheduled.
 */
export function reduceAgentQueueAfterExit(
	session: Session,
	now: number,
	createLogId: () => string
): AgentQueueExitTransition {
	const { item, remaining } = takeNextRunnableQueueItem(session.executionQueue);
	if (!item) {
		const aiTabs =
			session.aiTabs?.length > 0
				? session.aiTabs.map((tab) =>
						tab.state === 'busy'
							? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
							: tab
					)
				: session.aiTabs;
		return {
			dequeuedItem: null,
			session: {
				...session,
				state: 'idle' as SessionState,
				busySource: undefined,
				thinkingStartTime: undefined,
				pendingAICommandForSynopsis: undefined,
				aiTabs,
			},
		};
	}

	const target = resolveQueuedItemTarget(session, item);
	if (!target) {
		return {
			dequeuedItem: item,
			session: {
				...session,
				state: 'busy' as SessionState,
				busySource: 'ai',
				executionQueue: remaining,
				thinkingStartTime: now,
				currentCycleTokens: 0,
				currentCycleBytes: 0,
				pendingAICommandForSynopsis: undefined,
			},
		};
	}

	const logEntry: LogEntry | null =
		item.type === 'message' && item.text
			? {
					id: createLogId(),
					timestamp: now,
					source: 'user',
					text: item.text,
					images: item.images,
				}
			: null;

	if (target.location === 'orphan') {
		return {
			dequeuedItem: item,
			session: {
				...session,
				state: 'busy' as SessionState,
				busySource: 'ai',
				...(logEntry &&
					session.orphanedThinkingTabs && {
						orphanedThinkingTabs: session.orphanedThinkingTabs.map((tab) =>
							tab.id === target.tabId ? { ...tab, logs: [...tab.logs, logEntry] } : tab
						),
					}),
				executionQueue: remaining,
				thinkingStartTime: now,
				currentCycleTokens: 0,
				currentCycleBytes: 0,
				pendingAICommandForSynopsis: undefined,
			},
		};
	}

	return {
		dequeuedItem: item,
		session: {
			...session,
			state: 'busy' as SessionState,
			busySource: 'ai',
			aiTabs: logEntry
				? session.aiTabs.map((tab) =>
						tab.id === target.tabId ? { ...tab, logs: [...tab.logs, logEntry] } : tab
					)
				: session.aiTabs,
			activeTabId: target.tabId,
			executionQueue: remaining,
			thinkingStartTime: now,
			currentCycleTokens: 0,
			currentCycleBytes: 0,
			pendingAICommandForSynopsis: undefined,
		},
	};
}
