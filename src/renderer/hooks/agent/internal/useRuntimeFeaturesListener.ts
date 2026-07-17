import { useEffect } from 'react';
import type {
	AgentApprovalRequest,
	AgentRuntimeFeatureState,
} from '../../../../shared/agent-runtime-features';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import { openInSystemBrowser } from '../../../utils/openUrl';
import { useComposerInputStore } from '../../../stores/composerInputStore';
import type { BatchedUpdater } from './types';
import { NOOP_OMP_EVENT_COORDINATOR, type OmpEventCoordinator } from './useOmpEventCoordinator';

// Only the fields these listeners actually patch. Kept narrow so the same
// patch can be spread into both Session and AITab (a Partial<Session> spread
// into AITab is a type error: e.g. their `state` unions differ).
type RuntimePatch = Partial<Pick<Session, 'name' | 'runtimeFeatures' | 'pendingApprovals'>>;
const NOOP_BATCHED_UPDATER: Pick<
	BatchedUpdater,
	'flushNow' | 'flushSessionNow' | 'flushTargetNow'
> = { flushNow: () => undefined };
const NOOP_THINKING_FLUSH = () => undefined;

export function useRuntimeFeaturesListener(
	batchedUpdater: Pick<
		BatchedUpdater,
		'flushNow' | 'flushSessionNow' | 'flushTargetNow'
	> = NOOP_BATCHED_UPDATER,
	flushThinkingForSession: (sessionId: string) => void = NOOP_THINKING_FLUSH,
	ompEventCoordinator: OmpEventCoordinator = NOOP_OMP_EVENT_COORDINATOR
): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const update = (sessionId: string, patch: (session: Session) => RuntimePatch) => {
			if (!ownedGate.current?.(sessionId)) return;
			const { baseSessionId, tabId } = parseSessionId(sessionId);
			setSessions((sessions) =>
				sessions.map((session) => {
					if (session.id !== baseSessionId) return session;
					const next = patch(session);
					if (!tabId) return { ...session, ...next };
					return {
						...session,
						...next,
						aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, ...next } : tab)),
					};
				})
			);
		};
		// Runtime feature projections are ownership-exclusive: a tab-scoped event
		// updates ONLY that tab and a base-scoped event ONLY the base session.
		// (`update` above intentionally writes both — approvals/titles are read at
		// session level by MainPanelContent — but feature projections must never
		// leak across scopes: a null for inactive tab A would otherwise clear the
		// parent copy that consumers were rendering for live tab B.)
		const updateExclusive = (sessionId: string, patch: RuntimePatch) => {
			if (!ownedGate.current?.(sessionId)) return;
			const { baseSessionId, tabId } = parseSessionId(sessionId);
			setSessions((sessions) =>
				sessions.map((session) => {
					if (session.id !== baseSessionId) return session;
					if (!tabId) return { ...session, ...patch };
					return {
						...session,
						aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
					};
				})
			);
		};
		const removeRuntimeFeatures = window.maestro.process.onRuntimeFeatures(
			(sessionId: string, runtimeFeatures: AgentRuntimeFeatureState | null) => {
				updateExclusive(
					sessionId,
					runtimeFeatures
						? { runtimeFeatures, pendingApprovals: [] }
						: { runtimeFeatures: undefined, pendingApprovals: [] }
				);
			}
		);
		const removeApproval = window.maestro.process.onApprovalRequest(
			(approval: AgentApprovalRequest) => {
				update(approval.sessionId, (session) => ({
					pendingApprovals: [...(session.pendingApprovals ?? []), approval],
				}));
			}
		);
		const removeApprovalCancelled = window.maestro.process.onApprovalCancelled(
			(sessionId: string, requestId: string) => {
				update(sessionId, (session) => ({
					pendingApprovals: session.pendingApprovals?.filter(
						(approval) => approval.id !== requestId
					),
				}));
			}
		);
		const removeOpenExternalUrl = window.maestro.process.onOpenExternalUrl(
			(sessionId: string, url: string) => {
				if (ownedGate.current?.(sessionId)) openInSystemBrowser(url);
			}
		);
		const removeComposerText = window.maestro.process.onComposerText(
			(sessionId: string, text: string) => {
				if (ownedGate.current?.(sessionId)) useComposerInputStore.getState().setAiValue(text);
			}
		);
		const removeSessionTitle = window.maestro.process.onSessionTitle(
			(sessionId: string, title: string) => {
				update(sessionId, () => ({ name: title }));
			}
		);

		// A follow-up remains visible through streamed output from the current
		// turn. It is consumed only when this exact tab reports a completed turn
		// followed by the native agent starting the next queued turn.
		const completedOmpTurns = new Set<string>();
		const removeOmpTurnLifecycle = window.maestro.process.onOmpTurnLifecycle((sessionId, event) => {
			if (!ownedGate.current?.(sessionId)) return;
			const flushed = ompEventCoordinator.flush(sessionId);
			if (!flushed) {
				const { baseSessionId } = parseSessionId(sessionId);
				if (batchedUpdater.flushTargetNow) batchedUpdater.flushTargetNow(sessionId);
				else if (batchedUpdater.flushSessionNow) batchedUpdater.flushSessionNow(baseSessionId);
				else batchedUpdater.flushNow();
			}
			flushThinkingForSession(sessionId);
			if (event.phase === 'continuation_failed' && event.deliveryId) {
				completedOmpTurns.delete(sessionId);
				const { baseSessionId, tabId } = parseSessionId(sessionId);
				if (!tabId) return;
				setSessions((sessions) =>
					sessions.map((session) => {
						if (session.id !== baseSessionId) return session;
						return {
							...session,
							aiTabs: session.aiTabs.map((tab) => {
								if (tab.id !== tabId) return tab;
								const failedEntry = tab.logs.find(
									(log) =>
										(log.deliveryId === event.deliveryId || log.id === event.deliveryId) &&
										log.deliveryIntent === event.deliveryIntent &&
										log.deliveryState === 'queued'
								);
								return failedEntry
									? {
											...tab,
											logs: tab.logs.map((log) =>
												log.id === failedEntry.id
													? { ...log, deliveryState: 'failed' as const }
													: log
											),
										}
									: tab;
							}),
						};
					})
				);
				return;
			}
			if (event.phase === 'turn_end') {
				completedOmpTurns.add(sessionId);
				const { baseSessionId, tabId } = parseSessionId(sessionId);
				if (!tabId) return;
				const endedAt = Date.now();
				setSessions((sessions) =>
					sessions.map((session) => {
						if (session.id !== baseSessionId) return session;
						return {
							...session,
							aiTabs: session.aiTabs.map((tab) =>
								tab.id !== tabId
									? tab
									: {
											...tab,
											logs: [
												...tab.logs,
												{
													id: `omp-turn-boundary:${sessionId}:${endedAt}:${tab.logs.length}`,
													timestamp: endedAt,
													source: 'system',
													text: '',
													metadata: { ompTurnBoundary: true as const },
												},
											],
										}
							),
						};
					})
				);
				return;
			}
			const isAtomicReplacement = event.deliveryIntent === 'abort_and_prompt';
			if (
				event.phase !== 'agent_start' ||
				event.continuation !== true ||
				!event.deliveryId ||
				(!completedOmpTurns.has(sessionId) && !isAtomicReplacement)
			)
				return;
			const continuationStartedAt = Date.now();
			const { baseSessionId, tabId } = parseSessionId(sessionId);
			setSessions((sessions) =>
				sessions.map((session) => {
					if (session.id !== baseSessionId) return session;
					const continuationEntry = session.aiTabs
						.find((tab) => tab.id === tabId)
						?.logs.find(
							(log) =>
								(log.deliveryId === event.deliveryId || log.id === event.deliveryId) &&
								log.deliveryIntent === event.deliveryIntent &&
								log.deliveryState === 'queued'
						);
					if (!continuationEntry) return session;
					completedOmpTurns.delete(sessionId);
					return {
						...session,
						state: 'busy',
						busySource: 'ai',
						thinkingStartTime: continuationStartedAt,
						aiTabs: session.aiTabs.map((tab) => {
							if (tab.id !== tabId) return tab;
							return {
								...tab,
								state: 'busy',
								thinkingStartTime: continuationStartedAt,
								logs: [
									...tab.logs.filter((log) => log.id !== continuationEntry.id),
									...(isAtomicReplacement
										? [
												{
													id: `omp-turn-boundary:${sessionId}:${continuationStartedAt}:${tab.logs.length - 1}`,
													timestamp: continuationStartedAt,
													source: 'system' as const,
													text: '',
													metadata: { ompTurnBoundary: true as const },
												},
											]
										: []),
									{
										...continuationEntry,
										timestamp: continuationStartedAt,
										deliveryState: 'consumed' as const,
									},
								],
							};
						}),
					};
				})
			);
		});
		return () => {
			removeRuntimeFeatures();
			removeApproval();
			removeApprovalCancelled();
			removeOpenExternalUrl();
			removeComposerText();
			removeSessionTitle();
			removeOmpTurnLifecycle();
		};
	}, [batchedUpdater, flushThinkingForSession, ompEventCoordinator, ownedGate]);
}
