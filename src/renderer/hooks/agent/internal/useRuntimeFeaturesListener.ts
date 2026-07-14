import { useEffect } from 'react';
import type {
	AgentApprovalRequest,
	AgentRuntimeFeatureState,
} from '../../../../shared/agent-runtime-features';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';

type RuntimePatch = Pick<Session, 'runtimeFeatures' | 'pendingApprovals'>;

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
		const removeRuntimeFeatures = window.maestro.process.onRuntimeFeatures(
			(sessionId: string, runtimeFeatures: AgentRuntimeFeatureState) => {
				update(sessionId, () => ({ runtimeFeatures }));
			}
		);
		const removeApproval = window.maestro.process.onApprovalRequest(
			(approval: AgentApprovalRequest) => {
				update(approval.sessionId, (session) => ({
					pendingApprovals: [...(session.pendingApprovals ?? []), approval],
				}));
			}
		);
		return () => {
			removeRuntimeFeatures();
			removeApproval();
		};
	}, [ownedGate]);
}
