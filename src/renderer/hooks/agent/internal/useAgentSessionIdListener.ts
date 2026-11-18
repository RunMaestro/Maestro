/**
 * useAgentSessionIdListener - registers `window.maestro.process.onSessionId`
 *
 * Captures provider session IDs at tab and (for non-claude-code agents)
 * session level. Detects resume failure when an existing tab receives a
 * different ID and surfaces a yellow toast + system log; updates the
 * context gauge to zero so the user can see the reset.
 *
 * Special case: claude-code emits fresh fork IDs on every spawn that have
 * no backing JSONL - for that agent the original tab ID is treated as
 * immutable and the session-level field is never written. Grok likewise owns
 * one native ID per tab: a different returned ID is a failed resume, never a
 * replacement conversation. Its IDs require an explicit, existing tab target.
 */

import { useEffect } from 'react';
import type { ProcessSpawnAttempt } from '../../../../main/preload/process/core';
import type { NativeSessionLaunch } from '../../../../main/process-manager/types';
import type { NativeSessionBinding } from '../../../../shared/maestro-lib/agents/providerSwap';
import { matchesNativeSessionBinding } from '../../../services/resumableSession';
import { updateSessionWith, useSessionStore } from '../../../stores/sessionStore';
import { notifyToast } from '../../../stores/notificationStore';
import { parseSessionId, isBatchSession } from '../../../utils/sessionIdParser';
import { getActiveTab } from '../../../utils/tabHelpers';
import { resolveTurnProvider, updateProviderSlot } from '../../../utils/providerTabSessions';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { useOwnedSideEffectGate } from './useOwnedSessionGate';
import type { AgentError, AITab, LogEntry, Session } from '../../../types';
import type { BatchedUpdater } from './types';

// Enumerable symbols survive the ordinary immutable spreads (including provider
// parking), but neither JSON persistence nor structuredClone carries them across
// reconstruction. IDs/timestamps alone cannot distinguish a replaced tab.
const nativeIncarnation = Symbol('native-session-incarnation');
type NativeIncarnation = { [nativeIncarnation]?: object };

interface NativeAttempt {
	attempt: ProcessSpawnAttempt;
	ownerId: string;
	tabId: string;
	owner: object;
	tab: object;
	ownerCreatedAt: Session['createdAt'];
	tabCreatedAt: AITab['createdAt'];
	turnProvider: AITab['turnProvider'];
	retainedId: string | null;
	retainedBinding?: NativeSessionBinding;
	expectedId: string | null;
	expectedBinding?: NativeSessionBinding;
	generation?: number;
}

export interface UseAgentSessionIdListenerDeps {
	batchedUpdater: BatchedUpdater;
}

export function useAgentSessionIdListener(deps: UseAgentSessionIdListenerDeps): void {
	const ownedGate = useOwnedSideEffectGate();
	useEffect(() => {
		// A reload or an older/web bridge has no baseline. Never reconstruct one
		// from an arriving native ID or the currently selected account settings.
		const attempts = new Map<string, NativeAttempt>();
		const currentTab = (capture: NativeAttempt, session: Session | undefined) => {
			const tab = session?.aiTabs.find((item) => item.id === capture.tabId);
			if (
				!session ||
				!tab ||
				(session as Session & NativeIncarnation)[nativeIncarnation] !== capture.owner ||
				(tab as AITab & NativeIncarnation)[nativeIncarnation] !== capture.tab ||
				session.createdAt !== capture.ownerCreatedAt ||
				tab.createdAt !== capture.tabCreatedAt ||
				tab.turnProvider !== capture.turnProvider
			)
				return undefined;
			const slot = session.toolType === 'grok' ? tab : tab.providerSessions?.grok;
			return (slot?.agentSessionId ?? null) === capture.expectedId &&
				slot?.nativeSessionBinding === capture.expectedBinding
				? tab
				: undefined;
		};
		const unsubscribeStore = useSessionStore.subscribe((state, previous) => {
			if (state.sessions === previous.sessions) return;
			for (const [processId, capture] of attempts) {
				if (
					!ownedGate.current?.(processId) ||
					!currentTab(
						capture,
						state.sessions.find((s) => s.id === capture.ownerId)
					)
				)
					attempts.delete(processId);
			}
		});
		const unsubscribeAttempts = window.maestro.process.onSpawnAttempt?.((attempt) => {
			const parsed = parseSessionId(attempt.sessionId);
			// Invalidate BEFORE checking the successor: failed/colliding attempts,
			// non-Grok providers and forced-parallel IDs all supersede this tab.
			for (const [processId, capture] of attempts) {
				if (
					processId === attempt.sessionId ||
					(capture.ownerId === parsed.baseSessionId &&
						((parsed.type === 'ai-tab' &&
							(capture.tabId === parsed.tabId || capture.tabId === attempt.tabId)) ||
							parsed.type === 'legacy-ai' ||
							parsed.type === 'regular'))
				)
					attempts.delete(processId);
			}
			if (
				attempt.toolType !== 'grok' ||
				!ownedGate.current?.(attempt.sessionId) ||
				parsed.type !== 'ai-tab' ||
				!parsed.tabId ||
				(attempt.tabId !== undefined && attempt.tabId !== parsed.tabId)
			)
				return;
			const session = useSessionStore
				.getState()
				.sessions.find((s) => s.id === parsed.actualSessionId);
			const tab = session?.aiTabs.find((item) => item.id === parsed.tabId);
			if (!session || !tab) return;
			const slot = session.toolType === 'grok' ? tab : tab.providerSessions?.grok;
			const owner = (session as Session & NativeIncarnation)[nativeIncarnation] ?? {};
			const incarnation = (tab as AITab & NativeIncarnation)[nativeIncarnation] ?? {};
			attempts.set(attempt.sessionId, {
				attempt: { ...attempt },
				ownerId: session.id,
				tabId: tab.id,
				owner,
				tab: incarnation,
				ownerCreatedAt: session.createdAt,
				tabCreatedAt: tab.createdAt,
				turnProvider: tab.turnProvider,
				retainedId: slot?.agentSessionId ?? null,
				retainedBinding: structuredClone(slot?.nativeSessionBinding),
				expectedId: slot?.agentSessionId ?? null,
				expectedBinding: slot?.nativeSessionBinding,
			});
			updateSessionWith(session.id, (s) => ({
				...s,
				[nativeIncarnation]: owner,
				aiTabs: s.aiTabs.map((item) =>
					item === tab ? { ...item, [nativeIncarnation]: incarnation } : item
				),
			}));
		});
		const unsubscribe = window.maestro.process.onSessionId(
			async (
				sessionId: string,
				agentSessionId: string,
				nativeSessionLaunch?: NativeSessionLaunch
			) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				if (isBatchSession(sessionId)) return;

				const parsed = parseSessionId(sessionId);
				const actualSessionId = parsed.actualSessionId;
				const tabId = parsed.tabId ?? undefined;

				let resumeFailureDetected = false;
				let grokResumeFailure = false;

				const session = useSessionStore.getState().sessions.find((s) => s.id === actualSessionId);
				if (session) {
					const eventTab = session.aiTabs?.find((tab) => tab.id === tabId);
					const capture = attempts.get(sessionId);
					// A receipt must never fall through into another provider's legacy path.
					const isGrokEvent =
						nativeSessionLaunch !== undefined ||
						capture !== undefined ||
						resolveTurnProvider(eventTab, session) === 'grok';
					let binding: NativeSessionBinding | undefined;
					if (isGrokEvent) {
						const launch = nativeSessionLaunch;
						if (
							!capture ||
							!currentTab(capture, session) ||
							!launch ||
							launch.nativeSessionRequestId !== capture.attempt.nativeSessionRequestId ||
							launch.tabId !== capture.tabId ||
							launch.tabId !== tabId ||
							!Number.isSafeInteger(launch.processGeneration) ||
							launch.processGeneration <= 0 ||
							(capture.generation !== undefined &&
								capture.generation !== launch.processGeneration) ||
							launch.requestedNativeSessionId !== capture.attempt.requestedNativeSessionId ||
							launch.scope?.state !== 'bound' ||
							launch.scope.provider !== capture.attempt.toolType ||
							typeof agentSessionId !== 'string'
						)
							return;
						binding = {
							version: launch.scope.version,
							state: 'bound',
							provider: launch.scope.provider,
							nativeSessionId: agentSessionId,
							accountRef: launch.scope.accountRef,
							host: { kind: launch.scope.host?.kind, identity: launch.scope.host?.identity },
							cwd: launch.scope.cwd,
						};
						if (!matchesNativeSessionBinding(binding, binding)) return;
						capture.generation = launch.processGeneration;
					}
					// This legacy bridge writes Claude's origin index, not Grok history.
					if (!isGrokEvent)
						window.maestro.agentSessions
							.registerSessionOrigin(session.projectRoot, agentSessionId, 'user')
							.catch((err) =>
								logger.error('[onSessionId] Failed to register session origin:', undefined, err)
							);

					updateSessionWith(actualSessionId, (s) => {
						if (isGrokEvent && (!capture || !currentTab(capture, s))) return s;
						// Claude Code 2.1.x in batch mode emits a fresh `session_id` on every spawn -
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

						// Settings are codified at send, so this ID belongs to the provider
						// that STARTED the turn. If the user changed the agent's provider while
						// it ran, the live slot now belongs to the incoming provider and this
						// token would be a resume target the new provider has never heard of -
						// park it under its real owner instead.
						const owningProvider = isGrokEvent ? 'grok' : resolveTurnProvider(targetTab, s);
						const isStaleProvider = owningProvider !== s.toolType;
						if (owningProvider === 'grok') {
							if (!capture || !binding) return s;
							const requested = capture.attempt.requestedNativeSessionId;
							if (
								(capture.retainedId !== null && capture.retainedId !== agentSessionId) ||
								(requested !== undefined && requested !== agentSessionId) ||
								(capture.expectedId !== null && capture.expectedId !== agentSessionId)
							) {
								grokResumeFailure = true;
								const error: AgentError = {
									type: 'session_not_found',
									agentId: 'grok',
									sessionId,
									timestamp: Date.now(),
									recoverable: false,
									message:
										'Grok returned a different session ID while resuming. The original session ID and history were retained. Check the selected account and host before retrying.',
								};
								const log: LogEntry = {
									id: generateId(),
									timestamp: error.timestamp,
									source: 'error',
									text: error.message,
									agentError: error,
								};
								return {
									...s,
									...(!isStaleProvider && {
										agentError: error,
										agentErrorTabId: targetTab.id,
										agentErrorPaused: true,
										state: 'error' as const,
									}),
									aiTabs: s.aiTabs.map((tab) =>
										tab.id === targetTab.id
											? {
													...tab,
													...(!isStaleProvider && { awaitingSessionId: false, agentError: error }),
													logs: [...tab.logs, log],
												}
											: tab
									),
								};
							}
							// An ID-only legacy slot or unknown receipt is not ownership.
							// Resume must match the retained scope; only a genuinely new
							// allocation may establish the first bound slot.
							if (
								((capture.retainedId !== null ||
									requested !== undefined ||
									capture.retainedBinding) &&
									!matchesNativeSessionBinding(capture.retainedBinding, binding)) ||
								(capture.expectedId !== null &&
									!matchesNativeSessionBinding(capture.expectedBinding, binding))
							)
								return s;
							// Advance before the synchronous store subscription sees our write.
							capture.expectedId = agentSessionId;
							capture.expectedBinding = binding;
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === targetTab.id
										? {
												...updateProviderSlot(tab, s, owningProvider, {
													agentSessionId,
													nativeSessionBinding: binding,
												}),
												...(!isStaleProvider && {
													awaitingSessionId: false,
													name: tab.name && tab.name !== 'New Session' ? tab.name : null,
												}),
											}
										: tab
								),
							};
						}
						if (isStaleProvider) {
							logger.info(
								'[onSessionId] Session ID arrived for a provider the agent has since switched away from - parking it',
								undefined,
								{
									owningProvider,
									currentProvider: s.toolType,
									tabId: targetTab.id,
									agentSessionId: agentSessionId.substring(0, 8),
								}
							);
							const updatedAiTabs = s.aiTabs.map((tab) =>
								tab.id === targetTab.id
									? updateProviderSlot(tab, s, owningProvider, { agentSessionId })
									: tab
							);
							// The session-level field tracks the CURRENT provider, so it is left
							// alone here for the same reason.
							return { ...s, aiTabs: updatedAiTabs };
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
								'[onSessionId] Session resume failed - agent returned a new session ID',
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
								text: '⚠️ Session resume failed - agent started a new session. Previous context was lost.',
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
				}

				if (grokResumeFailure) {
					notifyToast({
						color: 'yellow',
						title: 'Grok Session Resume Failed',
						message:
							'The original session ID and history were retained. Check the selected account and host.',
						sessionId: actualSessionId,
					});
				}
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
			unsubscribeAttempts?.();
			unsubscribeStore();
			attempts.clear();
		};
	}, [deps.batchedUpdater, ownedGate]);
}
