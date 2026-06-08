import { useState, useCallback, RefObject } from 'react';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { Session } from '../../../types';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';

interface UseAgentSessionsRenameArgs {
	activeSession: Session | undefined;
	agentId: string;
	viewingSession: AgentSession | null;
	setViewingSession: React.Dispatch<React.SetStateAction<AgentSession | null>>;
	updateSession: (sessionId: string, updates: Partial<AgentSession>) => void;
	onUpdateTab?: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
	renameInputRef: RefObject<HTMLInputElement | null>;
}

export function useAgentSessionsRename({
	activeSession,
	agentId,
	viewingSession,
	setViewingSession,
	updateSession,
	onUpdateTab,
	renameInputRef,
}: UseAgentSessionsRenameArgs): {
	renamingSessionId: string | null;
	renameValue: string;
	setRenameValue: React.Dispatch<React.SetStateAction<string>>;
	setRenamingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
	startRename: (session: AgentSession, e: React.MouseEvent) => void;
	submitRename: (sessionId: string) => Promise<void>;
	cancelRename: () => void;
} {
	const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');

	const startRename = useCallback(
		(session: AgentSession, e: React.MouseEvent) => {
			e.stopPropagation();
			setRenamingSessionId(session.sessionId);
			setRenameValue(session.sessionName || '');
			setTimeout(() => renameInputRef.current?.focus(), 50);
		},
		[renameInputRef]
	);

	const cancelRename = useCallback(() => {
		setRenamingSessionId(null);
		setRenameValue('');
	}, []);

	const submitRename = useCallback(
		async (sessionId: string) => {
			if (!activeSession?.projectRoot) return;

			const trimmedName = renameValue.trim();
			try {
				if (agentId === 'claude-code') {
					await window.maestro.claude.updateSessionName(
						activeSession.projectRoot,
						sessionId,
						trimmedName
					);
				} else {
					await window.maestro.agentSessions.setSessionName(
						agentId,
						activeSession.projectRoot,
						sessionId,
						trimmedName || null
					);
				}

				updateSession(sessionId, { sessionName: trimmedName || undefined });

				if (viewingSession?.sessionId === sessionId) {
					setViewingSession((prev) =>
						prev ? { ...prev, sessionName: trimmedName || undefined } : null
					);
				}

				onUpdateTab?.(sessionId, { name: trimmedName || null });
			} catch (error) {
				logger.error('Failed to rename session:', undefined, error);
				captureException(error, {
					extra: { agentId, sessionId, projectPath: activeSession?.projectRoot },
				});
			}

			cancelRename();
		},
		[
			activeSession?.projectRoot,
			agentId,
			renameValue,
			viewingSession?.sessionId,
			cancelRename,
			onUpdateTab,
			updateSession,
			setViewingSession,
		]
	);

	return {
		renamingSessionId,
		renameValue,
		setRenameValue,
		setRenamingSessionId,
		startRename,
		submitRename,
		cancelRename,
	};
}
