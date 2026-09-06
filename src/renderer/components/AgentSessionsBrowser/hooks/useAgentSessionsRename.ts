import { useState, useCallback, useRef, RefObject } from 'react';
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
	beginRename: (session: AgentSession) => void;
	startRename: (session: AgentSession, e: React.MouseEvent) => void;
	submitRename: (sessionId: string) => Promise<void>;
	cancelRename: () => void;
	consumeFocusRestore: () => boolean;
} {
	const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const focusRestorePendingRef = useRef(false);

	// The rename itself, with no event to consume: the edit button, the detail
	// header, and the keyboard shortcut all enter rename mode the same way.
	const beginRename = useCallback((session: AgentSession) => {
		setRenamingSessionId(session.sessionId);
		setRenameValue(session.sessionName || '');
		// Focus is claimed by useFocusAfterRender in the host component, which
		// runs after the commit that mounts the input. A setTimeout here would
		// race that mount.
	}, []);

	const startRename = useCallback(
		(session: AgentSession, e: React.MouseEvent) => {
			e.stopPropagation();
			beginRename(session);
		},
		[beginRename]
	);

	const cancelRename = useCallback(() => {
		// The rename input is about to unmount. If it still owns the keyboard the
		// user is leaving by keyboard (Escape, or Enter through submitRename) and
		// nothing else will claim focus, so the caller has to hand it somewhere -
		// otherwise focus lands on <body> and the arrow keys go dead.
		//
		// A blur-submit lands here too, but by then the user has already clicked
		// somewhere else, so activeElement is not the input and we leave their
		// focus alone.
		//
		// Recorded rather than acted on: the new target can only be focused after
		// the commit that unmounts this input, or focusing it fires the input's
		// own onBlur and submits the name the user just escaped out of.
		focusRestorePendingRef.current =
			!!renameInputRef.current && document.activeElement === renameInputRef.current;

		setRenamingSessionId(null);
		setRenameValue('');
	}, [renameInputRef]);

	const consumeFocusRestore = useCallback(() => {
		const pending = focusRestorePendingRef.current;
		focusRestorePendingRef.current = false;
		return pending;
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
		beginRename,
		startRename,
		submitRename,
		cancelRename,
		consumeFocusRestore,
	};
}
