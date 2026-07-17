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

// Only the fields these listeners actually patch. Kept narrow so the same
// patch can be spread into both Session and AITab (a Partial<Session> spread
// into AITab is a type error: e.g. their `state` unions differ).
type RuntimePatch = Partial<Pick<Session, 'name' | 'runtimeFeatures' | 'pendingApprovals'>>;

export function useRuntimeFeaturesListener(): void {
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
			if (event.phase === 'turn_end') {
				completedOmpTurns.add(sessionId);
				return;
			}
			if (
				event.phase !== 'agent_start' ||
				event.continuation !== true ||
				!completedOmpTurns.delete(sessionId)
			)
				return;
			const { baseSessionId, tabId } = parseSessionId(sessionId);
			if (!tabId) return;
			setSessions((sessions) =>
				sessions.map((session) => {
					if (session.id !== baseSessionId) return session;
					return {
						...session,
						state: 'busy',
						busySource: 'ai',
						thinkingStartTime: Date.now(),
						aiTabs: session.aiTabs.map((tab) => {
							if (tab.id !== tabId) return tab;
							const continuationEntry = tab.logs.find(
								(log) =>
									log.deliveryIntent === event.deliveryIntent &&
									(event.deliveryIntent !== 'follow_up' || log.deliveryState === 'queued')
							);
							return {
								...tab,
								state: 'busy',
								thinkingStartTime: Date.now(),
								logs: continuationEntry
									? [
											...tab.logs.filter((log) => log.id !== continuationEntry.id),
											{ ...continuationEntry, deliveryState: 'consumed' as const },
										]
									: tab.logs,
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
	}, [ownedGate]);
}
