import { useEffect, useRef } from 'react';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';

interface UseAgentSessionsAutoViewArgs {
	loading: boolean;
	sessions: AgentSession[];
	activeAgentSessionId: string | null;
	viewingSession: AgentSession | null;
	handleViewSession: (session: AgentSession) => void;
}

export function useAgentSessionsAutoView({
	loading,
	sessions,
	activeAgentSessionId,
	viewingSession,
	handleViewSession,
}: UseAgentSessionsAutoViewArgs): void {
	// Track which session we've auto-jumped to - prevents re-jumping after user navigates back
	const autoJumpedRef = useRef<string | null>(null);

	useEffect(() => {
		if (
			!loading &&
			sessions.length > 0 &&
			activeAgentSessionId &&
			!viewingSession &&
			autoJumpedRef.current !== activeAgentSessionId
		) {
			const targetSession = sessions.find((s) => s.sessionId === activeAgentSessionId);
			if (targetSession) {
				autoJumpedRef.current = activeAgentSessionId;
				handleViewSession(targetSession);
			}
		}
	}, [loading, sessions, activeAgentSessionId, viewingSession, handleViewSession]);
}
