import { useState, useEffect, useRef } from 'react';
import type { Session } from '../../types';
import type { TerminalViewHandle } from '../../components/TerminalView';
import { useSessionStore } from '../../stores/sessionStore';

/**
 * Manages terminal session mounting lifecycle.
 *
 * Tracks which sessions have had their TerminalView mounted so switching
 * away and back doesn't destroy the xterm.js buffer contents. Also handles
 * cleanup when sessions are deleted from the store or terminal tabs are closed.
 */
export function useTerminalMounting(activeSession: Session | null) {
	// Map of sessionId → TerminalViewHandle for each mounted terminal session.
	// Using a Map instead of a single ref so we can keep terminals alive for all sessions,
	// not just the currently active one.
	const terminalViewRefs = useRef<Map<string, TerminalViewHandle>>(new Map());

	// Tracks which sessions have had their TerminalView mounted (by session ID).
	// Once a session's terminals are mounted we keep them hidden (visibility:hidden) so that
	// switching away and back doesn't destroy the xterm.js buffer contents.
	const mountedTerminalSessionsRef = useRef<Map<string, Session>>(new Map());
	const [mountedTerminalSessionIds, setMountedTerminalSessionIds] = useState<string[]>([]);

	const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);

	// Narrow subscription: only re-renders when sessions are added/removed (not on content updates).
	// Used to clean up deleted sessions from mountedTerminalSessionIds.
	const allSessionIds = useSessionStore((s) => s.sessions.map((ses) => ses.id).join(','));

	// Add session to the mounted set when it becomes active and has terminal tabs.
	// Remove it when its terminal tabs are all closed.
	// Deliberately depend only on id and terminalTabs.length to avoid running on every AI message.
	useEffect(() => {
		if (!activeSession) return;
		const hasTerminalTabs = (activeSession.terminalTabs?.length ?? 0) > 0;
		if (hasTerminalTabs) {
			// Always update the snapshot so we have the latest when this session becomes non-active.
			mountedTerminalSessionsRef.current.set(activeSession.id, activeSession);
			setMountedTerminalSessionIds((prev) => {
				return prev.includes(activeSession.id) ? prev : [...prev, activeSession.id];
			});
		} else if (mountedTerminalSessionsRef.current.has(activeSession.id)) {
			// Last terminal tab was closed — remove from mounted set.
			mountedTerminalSessionsRef.current.delete(activeSession.id);
			setMountedTerminalSessionIds((prev) => prev.filter((id) => id !== activeSession.id));
		}
	}, [activeSession?.id, activeSession?.terminalTabs?.length]);

	// Evict sessions that were deleted entirely from the store.
	useEffect(() => {
		const liveIds = new Set(allSessionIds.split(',').filter(Boolean));
		setMountedTerminalSessionIds((prev) => {
			const filtered = prev.filter((id) => liveIds.has(id));
			if (filtered.length !== prev.length) {
				// Also clean up the snapshot ref.
				prev
					.filter((id) => !liveIds.has(id))
					.forEach((id) => mountedTerminalSessionsRef.current.delete(id));
				return filtered;
			}
			return prev; // Same reference → no re-render
		});
	}, [allSessionIds]);

	// Close terminal search when switching away from terminal mode
	useEffect(() => {
		if (activeSession?.inputMode !== 'terminal') {
			setTerminalSearchOpen(false);
		}
	}, [activeSession?.inputMode]);

	return {
		terminalViewRefs,
		mountedTerminalSessionIds,
		mountedTerminalSessionsRef,
		terminalSearchOpen,
		setTerminalSearchOpen,
	};
}
