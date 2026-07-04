/**
 * useAgentSessionIdListener — registers `window.maestro.process.onSessionId`
 *
 * Captures provider session IDs at tab and (for non-claude-code agents)
 * session level. Detects resume failure when an existing tab receives a
 * different ID and surfaces a yellow toast + system log; updates the
 * context gauge to zero so the user can see the reset.
 *
 * Special case: claude-code emits fresh fork IDs on every spawn that have
 * no backing JSONL — for that agent the original tab ID is treated as
 * immutable and the session-level field is never written.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { notifyToast } from '../../../stores/notificationStore';
import { parseSessionId, isBatchSession } from '../../../utils/sessionIdParser';
import { getActiveTab } from '../../../utils/tabHelpers';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry } from '../../../types';
import type { BatchedUpdater } from './types';

export interface UseAgentSessionIdListenerDeps {
	batchedUpdater: BatchedUpdater;
}

export function useAgentSessionIdListener(deps: UseAgentSessionIdListenerDeps): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;

		const unsubscribe = window.maestro.process.onSessionId(
			async (sessionId: string, agentSessionId: string) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				if (isBatchSession(sessionId)) return;

				const parsed = parseSessionId(sessionId);
				const actualSessionId = parsed.actualSessionId;
				const tabId = parsed.tabId ?? undefined;

				let resumeFailureDetected = false;

				setSessions((prev) => {
					const session = prev.find((s) => s.id === actualSessionId);
					if (!session) return prev;

					window.maestro.agentSessions
						.registerSessionOrigin(session.projectRoot, agentSessionId, 'user')
						.catch((err) =>
							logger.error('[onSessionId] Failed to register session origin:', undefined, err)
						);

					return prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						// Claude Code 2.1.x in batch mode emits a fresh `session_id` on every spawn —
						// but never writes a JSONL file under that fresh ID; the conversation
						// continues to be appended to the original JSONL. Storing the fork ID and
						// using it on the next spawn produces "no conversation found with session id"
						// because the file does not exist. So once a claude-code tab/session has an
						// agentSessionId, treat it as immutable and ignore subsequent fork IDs.
						const isClaudeCode = s.toolType === 'claude-code';

						let targetTab;
						if (tabId) {
							targetTab = s.aiTabs?.find((tab) => tab.id === tabId);
							if (!targetTab) {
								logger.info(
									'[onSessionId] Tab was closed, storing session ID at session level only:',
									undefined,
									{
										tabId: tabId.substring(0, 8),
										agentSessionId: agentSessionId.substring(0, 8),
									}
								);
								return isClaudeCode ? s : { ...s, agentSessionId };
							}
						}

						if (!targetTab) {
							const awaitingTab = s.aiTabs?.find(
								(tab) => tab.awaitingSessionId && !tab.agentSessionId
							);
							targetTab = awaitingTab || getActiveTab(s);
						}

						if (!targetTab) {
							logger.error(
								'[onSessionId] No target tab found - session has no aiTabs, storing at session level only'
							);
							return isClaudeCode ? s : { ...s, agentSessionId };
						}

						if (targetTab.agentSessionId && targetTab.agentSessionId !== agentSessionId) {
							if (isClaudeCode) {
								const updatedAiTabs = s.aiTabs.map((tab) => {
									if (tab.id !== targetTab.id) return tab;
									return { ...tab, awaitingSessionId: false };
								});
								return { ...s, aiTabs: updatedAiTabs };
							}

							logger.warn(
								'[onSessionId] Session resume failed — agent returned a new session ID',
								undefined,
								{
									expected: targetTab.agentSessionId,
									received: agentSessionId,
									tabId: targetTab.id,
									sessionId: actualSessionId,
								}
							);

							resumeFailureDetected = true;

							const resumeFailLog: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'system',
								text: '⚠️ Session resume failed — agent started a new session. Previous context was lost.',
							};

							const updatedAiTabs = s.aiTabs.map((tab) => {
								if (tab.id !== targetTab.id) return tab;
								return {
									...tab,
									agentSessionId,
									awaitingSessionId: false,
									usageStats: undefined,
									logs: [...tab.logs, resumeFailLog],
								};
							});

							return { ...s, aiTabs: updatedAiTabs, agentSessionId };
						}

						const updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id !== targetTab.id) return tab;
							const newName = tab.name && tab.name !== 'New Session' ? tab.name : null;
							return {
								...tab,
								agentSessionId,
								awaitingSessionId: false,
								name: newName,
							};
						});

						return isClaudeCode
							? { ...s, aiTabs: updatedAiTabs }
							: { ...s, aiTabs: updatedAiTabs, agentSessionId };
					});
				});

				if (resumeFailureDetected) {
					deps.batchedUpdater.updateContextUsage(actualSessionId, 0);
					notifyToast({
						color: 'yellow',
						title: 'Session Resume Failed',
						message: 'Agent started a new session. Previous context was lost.',
						sessionId: actualSessionId,
					});
				}
			}
		);

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, ownedGate]);
}
