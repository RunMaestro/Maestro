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
import { scheduleRetryForError, getRetryEntry } from '../../../stores/retryStore';
import { useProcessWindowScope } from './useProcessWindowScope';
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
	const isSessionInCurrentWindow = useProcessWindowScope();

	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;
		const { openModal } = useModalStore.getState();

		const unsubscribe = window.maestro.process.onAgentError((sessionId: string, error) => {
			if (!isSessionInCurrentWindow(sessionId)) return;

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

			// Agent Resilience: for transient upstream / quota errors, auto-retry
			// instead of surfacing the blocking error modal. Two paths, both gated
			// on the per-agent toggles inside scheduleRetryForError:
			//   - interactive turn → resend the snapshotted prompt.
			//   - Auto Run batch (goal-based or spec-driven) → resume the parked
			//     batch loop after the backoff (via the registered resumer). The
			//     loop is parked by pauseBatchOnError further below in this handler.
			// Skipped for session_not_found (recovered below). Requires a concrete
			// tab so the retry targets the right turn / countdown.
			const batchState = deps.getBatchStateRef.current?.(actualSessionId);
			const batchOwnsError = !!(batchState?.isRunning && !batchState.errorPaused);
			const canAutoRetry = !isSessionNotFound && !!tabIdFromSession;
			const willAutoRetryInteractive =
				canAutoRetry &&
				!batchOwnsError &&
				scheduleRetryForError(actualSessionId, tabIdFromSession!, agentError);
			const willAutoRetryBatch =
				canAutoRetry &&
				batchOwnsError &&
				scheduleRetryForError(actualSessionId, tabIdFromSession!, agentError, { batch: true });
			const willAutoRetry = willAutoRetryInteractive || willAutoRetryBatch;

			// Agent Resilience transcript card: the auto-retry path collapses all
			// attempts into ONE live status bubble (RetryStatusCard) instead of a
			// wall of error frames. Append the anchor marker only on the FIRST
			// failure of an outage (attempt 0); continuations update the store-backed
			// card in place and add nothing to the transcript.
			const activeRetry =
				willAutoRetry && tabIdFromSession
					? getRetryEntry(actualSessionId, tabIdFromSession)
					: undefined;
			const isFirstOutageFailure = activeRetry?.attempt === 0;
			const retryOutageId = activeRetry?.outageId;

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
					const lastUserPrompt =
						isSessionNotFound && targetTab
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
					// When auto-retry takes over we log a non-blocking outage marker
					// instead of an error frame; the marker renders as a live
					// RetryStatusCard (driven by retryStore) showing attempt count,
					// elapsed time, next-retry countdown, and Try now / Stop controls.
					const errorLogEntry: LogEntry = {
						id: generateId(),
						timestamp: agentError.timestamp,
						source: isSessionNotFound || willAutoRetry ? 'system' : 'error',
						text: canOfferRecovery
							? 'Session not found, however we can recover it raw or compressed.'
							: agentError.message,
						agentError: isSessionNotFound || willAutoRetry ? undefined : agentError,
						...(willAutoRetry && retryOutageId ? { retryOutageId } : {}),
						...(isInteractive && !isSessionNotFound && !willAutoRetry
							? { renderStyle: 'text-stream' as const }
							: {}),
						...(canOfferRecovery
							? { recoveryAction: { lastUserPrompt: lastUserPrompt!, tabId: targetTab!.id } }
							: {}),
					};
					// On a continued outage (attempt > 0) the card already lives in the
					// transcript — just strip the transient progress log, append nothing.
					const isRetryContinuation = willAutoRetry && !isFirstOutageFailure;
					const updatedAiTabs = targetTab
						? s.aiTabs.map((tab) =>
								tab.id === targetTab.id
									? {
											...tab,
											logs: isRetryContinuation
												? removeHiddenProgressLog(tab.logs, tab.id)
												: [...removeHiddenProgressLog(tab.logs, tab.id), errorLogEntry],
											agentError: isSessionNotFound ? undefined : agentError,
											...(isSessionNotFound ? { agentSessionId: null } : {}),
										}
									: tab
							)
						: s.aiTabs;

					// session_not_found recovers below; auto-retry keeps the session
					// out of the blocking `error` state (the countdown chip owns the
					// UI, and the exit listener idles the tab).
					if (isSessionNotFound || willAutoRetry) {
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
							willAutoRetryBatch
								? '- Agent Resilience is retrying this automatically; the run will continue on its own once the provider recovers.'
								: agentError.type === 'auth_expired'
									? '- Re-authenticate with the provider (e.g., run `claude login` in terminal)'
									: agentError.type === 'token_exhaustion'
										? '- Start a new session to reset the context window'
										: agentError.type === 'rate_limited'
											? '- Wait a few minutes before retrying'
											: agentError.type === 'network_error'
												? '- Check your internet connection and try again'
												: '- Review the error message and take appropriate action',
							'',
							willAutoRetryBatch
								? 'You can also cancel the auto-retry to resume, skip, or abort manually.'
								: 'After resolving the issue, you can resume, skip, or abort the Auto Run.',
						]
							.filter(Boolean)
							.join('\n');

						deps.addHistoryEntryRef.current({
							type: 'AUTO',
							summary: `Auto Run ${willAutoRetryBatch ? 'auto-retry' : 'error'}: ${errorTitle}${currentDoc ? ` (${currentDoc})` : ''}`,
							fullResponse: errorExplanation,
							projectPath: session.cwd,
							sessionId: actualSessionId,
							success: false,
						});
					}

					const errorTitle = getErrorTitleForType(agentError.type);
					notifyToast({
						type: willAutoRetryBatch ? 'warning' : 'error',
						title: willAutoRetryBatch
							? `Auto Run: retrying (${errorTitle})`
							: `Auto Run: ${errorTitle}`,
						message: willAutoRetryBatch
							? `${agentError.message} Auto Run will continue automatically.`
							: agentError.message,
						sessionId: actualSessionId,
					});
				}
			}

			if (!isSessionNotFound && !willAutoRetry) {
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
		isSessionInCurrentWindow,
	]);
}
