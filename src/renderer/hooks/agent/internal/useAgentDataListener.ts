/**
 * useAgentDataListener — registers `window.maestro.process.onData`
 *
 * High-frequency listener for process stdout. Behaviour:
 *  - Routes terminal output through `batchedUpdater.appendLog(_, null, false)`.
 *  - Routes AI output through `batchedUpdater.appendLog(_, tabId, true)`,
 *    plus `markDelivered` + `updateCycleBytes` on every chunk.
 *  - Removes the hidden-progress placeholder log on first visible chunk.
 *  - Clears any lingering `session.agentError` (and its matching error log)
 *    when fresh data arrives — the agent is visibly recovered.
 *  - Marks the target tab unread when it isn't the active tab / the user
 *    has scrolled away.
 *
 * Receives the shared `activeHiddenToolRef` from the coordinator and deletes
 * the per-tab entry on first chunk so any progress placeholder bookkeeping
 * stays in sync.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { getActiveTab, getWriteModeTab } from '../../../utils/tabHelpers';
import { logger } from '../../../utils/logger';
import { removeHiddenProgressLog } from './helpers/exitTabCleanup';
import { removeMatchingAgentErrorLog } from './helpers/agentErrorLogMatch';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { SessionState } from '../../../types';
import type { BatchedUpdater, ToolProgressState } from './types';
import { NOOP_OMP_EVENT_COORDINATOR, type OmpEventCoordinator } from './useOmpEventCoordinator';

export interface UseAgentDataListenerDeps {
	batchedUpdater: BatchedUpdater;
	ompEventCoordinator?: OmpEventCoordinator;
	activeHiddenToolRef: React.RefObject<
		Map<string, { toolName: string; toolState?: ToolProgressState }>
	>;
}

export function useAgentDataListener(deps: UseAgentDataListenerDeps): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const ompEventCoordinator = deps.ompEventCoordinator ?? NOOP_OMP_EVENT_COORDINATOR;
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;
		const getActiveSessionId = () => useSessionStore.getState().activeSessionId;

		const unsubscribe = window.maestro.process.onData((sessionId: string, data: string) => {
			// Window scoping: ignore agents this window doesn't own (events are broadcast).
			if (!ownedGate.current?.(sessionId)) return;
			let actualSessionId: string;
			let isFromAi: boolean;
			let tabIdFromSession: string | undefined;

			const aiTabMatch = sessionId.match(REGEX_AI_TAB);
			if (aiTabMatch) {
				actualSessionId = aiTabMatch[1];
				tabIdFromSession = aiTabMatch[2];
				isFromAi = true;
			} else if (sessionId.endsWith('-terminal')) {
				return;
			} else if (sessionId.includes('-batch-')) {
				return;
			} else {
				actualSessionId = sessionId;
				isFromAi = false;
			}

			if (!isFromAi && !data.trim()) return;

			if (!isFromAi) {
				deps.batchedUpdater.appendLog(actualSessionId, null, false, data);
				return;
			}

			// Resolve the session once and reuse it for tab resolution, placeholder
			// removal, the agentError-recovery check, and the unread check. The
			// batched updater never writes the store synchronously, and the only
			// synchronous write below (placeholder removal) just strips a log entry,
			// so none of the fields these checks read go stale. This collapses what
			// used to be up to three full-array getSessions().find() scans per chunk
			// down to a single lookup on the hottest path in the app.
			const session = getSessions().find((s) => s.id === actualSessionId);

			let targetTabId = tabIdFromSession;
			if (!targetTabId && session) {
				const targetTab = getWriteModeTab(session) || getActiveTab(session);
				if (targetTab) {
					targetTabId = targetTab.id;
				}
			}

			if (!targetTabId) {
				logger.error(
					'[onData] No target tab found - session has no aiTabs, this should not happen'
				);
				return;
			}

			if (session?.toolType === 'omp') {
				ompEventCoordinator.enqueue(sessionId, () => {
					deps.batchedUpdater.appendLog(actualSessionId, targetTabId!, true, data);
					deps.batchedUpdater.markDelivered(actualSessionId, targetTabId!);
					deps.batchedUpdater.updateCycleBytes(actualSessionId, data.length);
				});
				return;
			}
			deps.activeHiddenToolRef.current?.delete(`${actualSessionId}:${targetTabId}`);

			const targetTab = session?.aiTabs?.find((t) => t.id === targetTabId);

			// Only rewrite the sessions array when the target tab still carries a
			// hidden-progress placeholder to strip. That holds on the first visible
			// chunk of a turn; for the thousands of chunks that follow it doesn't, so
			// we skip the full prev.map() allocation and store notification entirely
			// instead of mapping every session just to return `prev` unchanged.
			if (targetTab && removeHiddenProgressLog(targetTab.logs, targetTabId) !== targetTab.logs) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						let didChange = false;
						const updatedTabs = s.aiTabs.map((tab) => {
							if (tab.id !== targetTabId) return tab;
							const updatedLogs = removeHiddenProgressLog(tab.logs, targetTabId!);
							if (updatedLogs === tab.logs) return tab;
							didChange = true;
							return { ...tab, logs: updatedLogs };
						});
						return didChange ? { ...s, aiTabs: updatedTabs } : s;
					})
				);
			}

			deps.batchedUpdater.appendLog(actualSessionId, targetTabId, true, data);
			deps.batchedUpdater.markDelivered(actualSessionId, targetTabId);
			deps.batchedUpdater.updateCycleBytes(actualSessionId, data.length);

			if (session?.agentError) {
				const activeAgentError = session.agentError;
				const errorTabId = session.agentErrorTabId ?? targetTabId;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const updatedAiTabs = s.aiTabs.map((tab) =>
							tab.id === targetTabId || tab.id === errorTabId
								? {
										...tab,
										logs:
											tab.id === errorTabId
												? removeMatchingAgentErrorLog(tab.logs, activeAgentError)
												: tab.logs,
										agentError: undefined,
									}
								: tab
						);
						return {
							...s,
							agentError: undefined,
							agentErrorTabId: undefined,
							agentErrorPaused: false,
							state: 'busy' as SessionState,
							aiTabs: updatedAiTabs,
						};
					})
				);
				window.maestro.agentError.clearError(actualSessionId).catch((err) => {
					logger.error('Failed to clear agent error on successful data:', undefined, err);
				});
			}

			if (session && targetTab) {
				const isTargetTabActive = targetTab.id === session.activeTabId;
				const isThisSessionActive = session.id === getActiveSessionId();
				const isUserAtBottom = targetTab.isAtBottom !== false;
				const shouldMarkUnread = !isTargetTabActive || !isThisSessionActive || !isUserAtBottom;
				deps.batchedUpdater.markUnread(actualSessionId, targetTabId, shouldMarkUnread);
			}
		});

		return () => {
			unsubscribe();
		};
	}, [deps.activeHiddenToolRef, deps.batchedUpdater, deps.ompEventCoordinator, ownedGate]);
}
