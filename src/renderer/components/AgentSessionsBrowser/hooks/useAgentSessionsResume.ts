import { useCallback } from 'react';
import type { AgentSession, SessionMessage } from '../../../hooks/agent/useSessionViewer';
import type { LogEntry, UsageStats } from '../../../types';
import { buildUsageStats } from '../utils/buildUsageStats';
import { messagesToLogEntries } from '../utils/messagesToLogEntries';

interface UseAgentSessionsResumeArgs {
	viewingSession: AgentSession | null;
	messages: SessionMessage[];
	starredSessions: Set<string>;
	onResumeSession: (
		agentSessionId: string,
		messages: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats
	) => void;
	onClose: () => void;
}

export function useAgentSessionsResume({
	viewingSession,
	messages,
	starredSessions,
	onResumeSession,
	onClose,
}: UseAgentSessionsResumeArgs): {
	handleResume: () => void;
	handleQuickResume: (session: AgentSession, e: React.MouseEvent) => void;
} {
	const handleResume = useCallback(() => {
		if (!viewingSession) return;

		const logEntries = messagesToLogEntries(messages, viewingSession.sessionId);
		const isStarred = starredSessions.has(viewingSession.sessionId);
		const usageStats = buildUsageStats(viewingSession);
		onResumeSession(
			viewingSession.sessionId,
			logEntries,
			viewingSession.sessionName,
			isStarred,
			usageStats
		);
		onClose();
	}, [viewingSession, messages, onResumeSession, onClose, starredSessions]);

	const handleQuickResume = useCallback(
		(session: AgentSession, e: React.MouseEvent) => {
			e.stopPropagation();
			const isStarred = starredSessions.has(session.sessionId);
			const usageStats = buildUsageStats(session);
			// Empty messages array - history loads lazily when the live tab opens
			onResumeSession(session.sessionId, [], session.sessionName, isStarred, usageStats);
			onClose();
		},
		[starredSessions, onResumeSession, onClose]
	);

	return { handleResume, handleQuickResume };
}
