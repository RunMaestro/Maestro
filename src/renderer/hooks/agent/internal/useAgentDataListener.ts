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
import type { SessionState } from '../../../types';
import type { BatchedUpdater, ToolProgressState } from './types';

export interface UseAgentDataListenerDeps {
	batchedUpdater: BatchedUpdater;
	activeHiddenToolRef: React.RefObject<
		Map<string, { toolName: string; toolState?: ToolProgressState }>
	>;
}

export function useAgentDataListener(deps: UseAgentDataListenerDeps): void {
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;
		const getActiveSessionId = () => useSessionStore.getState().activeSessionId;

		const unsubscribe = window.maestro.process.onData((sessionId: string, data: string) => {
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

			let targetTabId = tabIdFromSession;
			if (!targetTabId) {
				const session = getSessions().find((s) => s.id === actualSessionId);
				if (session) {
					const targetTab = getWriteModeTab(session) || getActiveTab(session);
					if (targetTab) {
						targetTabId = targetTab.id;
					}
				}
			}

			if (!targetTabId) {
				logger.error(
					'[onData] No target tab found - session has no aiTabs, this should not happen'
				);
				return;
			}

			deps.activeHiddenToolRef.current?.delete(`${actualSessionId}:${targetTabId}`);

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

			deps.batchedUpdater.appendLog(actualSessionId, targetTabId, true, data);
			deps.batchedUpdater.markDelivered(actualSessionId, targetTabId);
			deps.batchedUpdater.updateCycleBytes(actualSessionId, data.length);

			const sessionForErrorCheck = getSessions().find((s) => s.id === actualSessionId);
			if (sessionForErrorCheck?.agentError) {
				const activeAgentError = sessionForErrorCheck.agentError;
				const errorTabId = sessionForErrorCheck.agentErrorTabId ?? targetTabId;

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

			const session = getSessions().find((s) => s.id === actualSessionId);
			if (session) {
				const targetTab = session.aiTabs?.find((t) => t.id === targetTabId);
				if (targetTab) {
					const isTargetTabActive = targetTab.id === session.activeTabId;
					const isThisSessionActive = session.id === getActiveSessionId();
					const isUserAtBottom = targetTab.isAtBottom !== false;
					const shouldMarkUnread = !isTargetTabActive || !isThisSessionActive || !isUserAtBottom;
					deps.batchedUpdater.markUnread(actualSessionId, targetTabId, shouldMarkUnread);
				}
			}
		});

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, deps.activeHiddenToolRef]);
}
