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

type RuntimePatch = Partial<Session>;

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
			(sessionId: string, runtimeFeatures: AgentRuntimeFeatureState | null) => {
				update(sessionId, () =>
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
		return () => {
			removeRuntimeFeatures();
			removeApproval();
			removeApprovalCancelled();
			removeOpenExternalUrl();
			removeComposerText();
			removeSessionTitle();
		};
	}, [ownedGate]);
}
