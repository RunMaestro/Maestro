import { useEffect, useRef, RefObject } from 'react';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';

interface UseAgentSessionsFocusRestoreArgs {
	viewingSession: AgentSession | null;
	inputRef: RefObject<HTMLInputElement | null>;
	selectedItemRef: RefObject<HTMLButtonElement | null>;
}

export function useAgentSessionsFocusRestore({
	viewingSession,
	inputRef,
	selectedItemRef,
}: UseAgentSessionsFocusRestoreArgs): void {
	const prevViewingSessionRef = useRef<AgentSession | null>(null);

	useEffect(() => {
		// Fire only when transitioning from detail view back to list view
		if (prevViewingSessionRef.current && !viewingSession) {
			const timer = setTimeout(() => {
				inputRef.current?.focus();
				selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}, 50);
			prevViewingSessionRef.current = viewingSession;
			return () => clearTimeout(timer);
		}
		prevViewingSessionRef.current = viewingSession;
	}, [viewingSession, inputRef, selectedItemRef]);
}
