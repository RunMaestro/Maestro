import { useCallback, useLayoutEffect, useRef } from 'react';
import type { AgentSession, SessionMessage } from '../../../hooks/agent/useSessionViewer';
import type { AgentSessionsBrowserProps } from '../types';
import { buildUsageStats } from '../utils/buildUsageStats';
import { messagesToLogEntries } from '../utils/messagesToLogEntries';

interface UseAgentSessionsResumeArgs {
	viewingSession: AgentSession | null;
	messages: SessionMessage[];
	starredSessions: Set<string>;
	onResumeSession: AgentSessionsBrowserProps['onResumeSession'];
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
	const resumeRequestRef = useRef(0);
	useLayoutEffect(() => {
		return () => {
			// A new view or browser scope must survive an older resume completing.
			resumeRequestRef.current++;
		};
	}, [viewingSession]);

	const handleResume = useCallback(async () => {
		if (!viewingSession) return;
		const request = ++resumeRequestRef.current;

		const logEntries = messagesToLogEntries(messages, viewingSession.sessionId);
		const isStarred = starredSessions.has(viewingSession.sessionId);
		const usageStats = buildUsageStats(viewingSession);
		const resumed = await onResumeSession(
			viewingSession.sessionId,
			logEntries,
			viewingSession.sessionName,
			isStarred,
			usageStats,
			// The browser owns project-root/alias resolution; the receipt owns native cwd.
			undefined,
			{
				targetSessionId: viewingSession.ownerAgentId,
				nativeSessionBinding: viewingSession.nativeSessionBinding
					? structuredClone(viewingSession.nativeSessionBinding)
					: undefined,
			}
		);
		if (resumed === true && resumeRequestRef.current === request) onClose();
	}, [viewingSession, messages, onResumeSession, onClose, starredSessions]);

	const handleQuickResume = useCallback(
		async (session: AgentSession, e: React.MouseEvent) => {
			e.stopPropagation();
			const request = ++resumeRequestRef.current;
			const isStarred = starredSessions.has(session.sessionId);
			const usageStats = buildUsageStats(session);
			// Empty messages array - history loads lazily when the live tab opens
			const resumed = await onResumeSession(
				session.sessionId,
				[],
				session.sessionName,
				isStarred,
				usageStats,
				undefined,
				{
					targetSessionId: session.ownerAgentId,
					nativeSessionBinding: session.nativeSessionBinding
						? structuredClone(session.nativeSessionBinding)
						: undefined,
				}
			);
			if (resumed === true && resumeRequestRef.current === request) onClose();
		},
		[starredSessions, onResumeSession, onClose]
	);

	return { handleResume, handleQuickResume };
}
