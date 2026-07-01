/**
 * useAgentErrorListener — registers `window.maestro.process.onAgentError`
 *
 * Three branches:
 *  1. Group chat errors → routed to `groupChatStore.setGroupChatError` and
 *     a `⚠️` system message in the chat. `session_not_found` is suppressed
 *     here because the exit listener handles recovery.
 *  2. Synopsis processes → ignored (errors don't surface).
 *  3. Per-session errors → an error log entry is appended to the targeted
 *     tab; `session.agentError` + `agentErrorTabId` + `agentErrorPaused`
 *     are stamped; the agentError modal opens. On `session_not_found`
 *     specifically, the stale `agentSessionId` is cleared so the next
 *     spawn starts fresh, and the modal is suppressed.
 *
 * If an Auto Run batch is active, this listener pauses it via
 * `pauseBatchOnErrorRef` and records a USER-facing history entry with a
 * remediation hint specific to the error type.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useModalStore } from '../../../stores/modalStore';
import { useGroupChatStore } from '../../../stores/groupChatStore';
import { notifyToast } from '../../../stores/notificationStore';
import {
	parseSessionId,
	parseGroupChatSessionId,
	isSynopsisSession,
} from '../../../utils/sessionIdParser';
import { getActiveTab } from '../../../utils/tabHelpers';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { removeHiddenProgressLog } from './helpers/exitTabCleanup';
import { getErrorTitleForType } from './helpers/errorTitles';
import { isLimitError } from '../../../../shared/types';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { AgentError, GroupChatMessage, LogEntry, SessionState } from '../../../types';
import type { UseAgentListenersDeps, ToolProgressState } from './types';

export interface UseAgentErrorListenerDeps {
	getBatchStateRef: UseAgentListenersDeps['getBatchStateRef'];
	pauseBatchOnErrorRef: UseAgentListenersDeps['pauseBatchOnErrorRef'];
	addHistoryEntryRef: UseAgentListenersDeps['addHistoryEntryRef'];
	activeHiddenToolRef: React.RefObject<
		Map<string, { toolName: string; toolState?: ToolProgressState }>
	>;
}

export function useAgentErrorListener(deps: UseAgentErrorListenerDeps): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;
		const { openModal } = useModalStore.getState();

		const unsubscribe = window.maestro.process.onAgentError((sessionId: string, error) => {
			// Window scoping: only the owning window handles the error (and pauses
			// its batch). Events are broadcast to all windows.
			if (!ownedGate.current?.(sessionId)) return;
			const agentError: AgentError = {
				type: error.type as AgentError['type'],
				message: error.message,
				recoverable: error.recoverable,
				agentId: error.agentId,
				sessionId: error.sessionId,
				timestamp: error.timestamp,
				raw: error.raw,
				parsedJson: error.parsedJson,
			};

			// Limit pauses (rate-limit / token-or-credit exhaustion) get auto-resume
			// bookkeeping seeded here: a zeroed retry counter now, and a best-effort
			// `limitResetAt` patched in below (asynchronously, never blocking the pause).
			const isLimit = isLimitError(agentError);
			if (isLimit) {
				agentError.resumeAttemptCount = 0;
			}

			const groupChatParsed = parseGroupChatSessionId(sessionId);
			if (groupChatParsed.isGroupChat) {
				const groupChatId = groupChatParsed.groupChatId!;
				const isModeratorError = groupChatParsed.isModerator ?? false;
				const participantOrModerator = isModeratorError
					? 'moderator'
					: groupChatParsed.participantName!;

				logger.info('[onAgentError] Group chat error received:', undefined, {
					rawSessionId: sessionId,
					groupChatId,
					participantName: isModeratorError ? 'Moderator' : participantOrModerator,
					errorType: error.type,
					message: error.message,
					recoverable: error.recoverable,
				});

				if (agentError.type === 'session_not_found') {
					logger.info(
						'[onAgentError] Suppressing session_not_found for group chat - exit-listener will handle recovery:',
						undefined,
						{
							groupChatId,
							participantName: isModeratorError ? 'Moderator' : participantOrModerator,
						}
					);
					return;
				}

				const gcStore = useGroupChatStore.getState();
				gcStore.setGroupChatError({
					groupChatId,
					error: agentError,
					participantName: isModeratorError ? 'Moderator' : participantOrModerator,
				});

				const errorMessage: GroupChatMessage = {
					timestamp: new Date(agentError.timestamp).toISOString(),
					from: 'system',
					content: `⚠️ ${
						isModeratorError ? 'Moderator' : participantOrModerator
					} error: ${agentError.message}`,
				};
				gcStore.setGroupChatMessages((prev) => [...prev, errorMessage]);

				gcStore.setGroupChatState('idle');
				gcStore.setGroupChatStates((prev) => {
					const next = new Map(prev);
					next.set(groupChatId, 'idle');
					return next;
				});
				return;
			}

			if (isSynopsisSession(sessionId)) {
				logger.info('[onAgentError] Ignoring synopsis process error:', undefined, {
					rawSessionId: sessionId,
					errorType: error.type,
					message: error.message,
				});
				return;
			}

			const parsed = parseSessionId(sessionId);
			const actualSessionId = parsed.baseSessionId;
			const tabIdFromSession = parsed.tabId ?? undefined;

			logger.info('[onAgentError] Agent error received:', undefined, {
				rawSessionId: sessionId,
				actualSessionId,
				errorType: error.type,
				message: error.message,
				recoverable: error.recoverable,
			});

			const isSessionNotFound = agentError.type === 'session_not_found';

			if (tabIdFromSession) {
				deps.activeHiddenToolRef.current?.delete(`${actualSessionId}:${tabIdFromSession}`);
			}

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== actualSessionId) return s;

					// If the error is for a tab the user closed mid-thinking, drop the
					// orphan entry — there's no tab UI to surface the error on, and the
					// pill should stop showing this thinking item.
					const isOrphanError =
						!!tabIdFromSession &&
						!!s.orphanedThinkingTabs?.some((tab) => tab.id === tabIdFromSession);
					if (isOrphanError && s.orphanedThinkingTabs) {
						const updatedOrphans = s.orphanedThinkingTabs.filter(
							(tab) => tab.id !== tabIdFromSession
						);
						const anyAiTabStillBusy = s.aiTabs?.some((tab) => tab.state === 'busy') ?? false;
						const stillThinking = anyAiTabStillBusy || updatedOrphans.length > 0;
						return {
							...s,
							orphanedThinkingTabs: updatedOrphans.length > 0 ? updatedOrphans : undefined,
							state: stillThinking ? s.state : ('idle' as SessionState),
							busySource: stillThinking ? s.busySource : undefined,
							thinkingStartTime: stillThinking ? s.thinkingStartTime : undefined,
						};
					}

					const targetTab = tabIdFromSession
						? s.aiTabs.find((tab) => tab.id === tabIdFromSession)
						: getActiveTab(s);

					// For session_not_found, find the most recent user message on the
					// target tab so the recovery modal can re-send it after grooming.
					// Without this, the prompt that triggered the dead session is lost.
					// Limit pauses reuse the same capture: when the prompt that hit the
					// limit was a direct send (not a queued item the drainer would replay),
					// stashing it as `recoveryAction.lastUserPrompt` lets Phase 3 re-fire it.
					const lastUserPrompt =
						(isSessionNotFound || isLimit) && targetTab
							? [...targetTab.logs].reverse().find((l) => l.source === 'user')?.text
							: undefined;

					// Tag the error frame with `renderStyle: 'text-stream'` when the
					// session is running through maestro-p (interactive TUI) so the
					// bottom-center pill on the error card reads "TUI" instead of
					// "API". The same tagger runs on assistant output in
					// useBatchedSessionUpdates; errors live in their own listener and
					// need parity here. system-source entries (session_not_found
					// recovery) stay untagged — they aren't real Claude turns.
					const isInteractive = s.claudeInteractive?.mode === 'interactive';
					const canOfferRecovery = isSessionNotFound && !!lastUserPrompt && !!targetTab;
					// Limit pauses keep the normal error log (message + agentError), but
					// also carry the captured prompt so the auto-resume coordinator can
					// re-fire a direct send. The `canOfferRecovery` session_not_found flow
					// owns the special "recover raw or compressed" copy; this only adds data.
					const stashLimitPrompt = isLimit && !!lastUserPrompt && !!targetTab;
					const errorLogEntry: LogEntry = {
						id: generateId(),
						timestamp: agentError.timestamp,
						source: isSessionNotFound ? 'system' : 'error',
						text: canOfferRecovery
							? 'Session not found, however we can recover it raw or compressed.'
							: agentError.message,
						agentError: isSessionNotFound ? undefined : agentError,
						...(isInteractive && !isSessionNotFound ? { renderStyle: 'text-stream' as const } : {}),
						...(canOfferRecovery || stashLimitPrompt
							? { recoveryAction: { lastUserPrompt: lastUserPrompt!, tabId: targetTab!.id } }
							: {}),
					};
					const updatedAiTabs = targetTab
						? s.aiTabs.map((tab) =>
								tab.id === targetTab.id
									? {
											...tab,
											logs: [...removeHiddenProgressLog(tab.logs, tab.id), errorLogEntry],
											agentError: isSessionNotFound ? undefined : agentError,
											...(isSessionNotFound ? { agentSessionId: null } : {}),
										}
									: tab
							)
						: s.aiTabs;

					if (isSessionNotFound) {
						return { ...s, aiTabs: updatedAiTabs };
					}

					return {
						...s,
						agentError,
						agentErrorTabId: targetTab?.id,
						agentErrorPaused: true,
						state: 'error' as SessionState,
						aiTabs: updatedAiTabs,
					};
				})
			);

			// Best-effort: estimate when the provider limit window reopens and stamp
			// it onto the paused error so the auto-resume coordinator (Phase 3) can
			// schedule its probe. Fired AFTER the synchronous pause above so it never
			// blocks it; a missing bridge / non-Claude provider just leaves it unset.
			//
			// Skip SSH-backed sessions: the usage snapshot is sampled on THIS machine
			// and reflects the local account, not the remote one. Stamping a local
			// reset time would make isEligibleToProbe defer the probe on the wrong
			// window; leaving limitResetAt unset routes SSH sessions through the
			// interval-based fallback that probeAvailability was designed for.
			const pausedSession = getSessions().find((s) => s.id === actualSessionId);
			const isSshBacked = !!pausedSession?.sshRemoteId;
			if (isLimit && !isSshBacked && window.maestro.agents?.getLimitResetAt) {
				void window.maestro.agents
					.getLimitResetAt(agentError.agentId)
					.then((resetAt) => {
						if (typeof resetAt !== 'number') return;
						setSessions((prev) =>
							prev.map((s) => {
								// Only patch if THIS error is still the active one (a newer
								// error would carry a different timestamp).
								if (s.id !== actualSessionId || s.agentError?.timestamp !== agentError.timestamp) {
									return s;
								}
								const patchedError: AgentError = { ...s.agentError, limitResetAt: resetAt };
								return {
									...s,
									agentError: patchedError,
									aiTabs: s.aiTabs.map((tab) =>
										tab.agentError?.timestamp === agentError.timestamp
											? { ...tab, agentError: patchedError }
											: tab
									),
								};
							})
						);
					})
					.catch(() => {
						// Reset estimate is advisory - swallow so a probe failure never
						// disrupts the pause/notification flow.
					});
			}

			// Pause active Auto Run batch and record history when applicable.
			if (deps.getBatchStateRef.current && deps.pauseBatchOnErrorRef.current) {
				const batchState = deps.getBatchStateRef.current(actualSessionId);
				if (batchState.isRunning && !batchState.errorPaused) {
					logger.info(
						'[onAgentError] Pausing active batch run due to error:',
						undefined,
						actualSessionId
					);
					const currentDoc = batchState.documents[batchState.currentDocumentIndex];
					deps.pauseBatchOnErrorRef.current(
						actualSessionId,
						agentError,
						batchState.currentDocumentIndex,
						currentDoc ? `Processing ${currentDoc}` : undefined
					);

					const session = getSessions().find((s) => s.id === actualSessionId);

					if (deps.addHistoryEntryRef.current && session) {
						const errorTitle = getErrorTitleForType(agentError.type);
						const errorExplanation = [
							`**Auto Run Error: ${errorTitle}**`,
							'',
							`Auto Run encountered an error while processing:`,
							currentDoc ? `- Document: ${currentDoc}` : '',
							`- Error: ${agentError.message}`,
							'',
							'**What to do:**',
							agentError.type === 'auth_expired'
								? '- Re-authenticate with the provider (e.g., run `claude login` in terminal)'
								: agentError.type === 'token_exhaustion'
									? '- Start a new session to reset the context window'
									: agentError.type === 'rate_limited'
										? '- Wait a few minutes before retrying'
										: agentError.type === 'network_error'
											? '- Check your internet connection and try again'
											: '- Review the error message and take appropriate action',
							'',
							'After resolving the issue, you can resume, skip, or abort the Auto Run.',
						]
							.filter(Boolean)
							.join('\n');

						deps.addHistoryEntryRef.current({
							type: 'AUTO',
							summary: `Auto Run error: ${errorTitle}${currentDoc ? ` (${currentDoc})` : ''}`,
							fullResponse: errorExplanation,
							projectPath: session.cwd,
							sessionId: actualSessionId,
							success: false,
						});
					}

					const errorTitle = getErrorTitleForType(agentError.type);
					notifyToast({
						type: 'error',
						title: `Auto Run: ${errorTitle}`,
						message: agentError.message,
						sessionId: actualSessionId,
					});
				}
			}

			if (!isSessionNotFound) {
				openModal('agentError', { sessionId: actualSessionId });
			}
		});

		return () => {
			unsubscribe();
		};
	}, [
		deps.activeHiddenToolRef,
		deps.addHistoryEntryRef,
		deps.getBatchStateRef,
		deps.pauseBatchOnErrorRef,
		ownedGate,
	]);
}
