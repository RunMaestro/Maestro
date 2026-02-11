import type { Session } from '../types';

export interface WindowCycleResult {
	sessionId: string;
	index: number;
}

/**
 * Determine the next session to activate when cycling within a window.
 * Orders are based on WindowContext.sessionIds, ignoring sessions missing from state.
 */
export function getNextWindowSessionCycle(
	sessions: Session[],
	windowSessionIds: string[],
	activeSessionId: string | null,
	direction: 'next' | 'prev'
): WindowCycleResult | null {
	if (!windowSessionIds.length || !sessions.length) {
		return null;
	}

	const sessionMap = new Map(sessions.map((session) => [session.id, session]));
	const orderedSessions = windowSessionIds
		.map((id) => sessionMap.get(id))
		.filter((session): session is Session => Boolean(session));

	if (!orderedSessions.length) {
		return null;
	}

	const normalizedActiveId = activeSessionId || null;
	const currentIndex =
		normalizedActiveId === null
			? -1
			: orderedSessions.findIndex((session) => session.id === normalizedActiveId);

	const targetIndex =
		currentIndex === -1
			? direction === 'next'
				? 0
				: orderedSessions.length - 1
			: direction === 'next'
				? (currentIndex + 1) % orderedSessions.length
				: (currentIndex - 1 + orderedSessions.length) % orderedSessions.length;

	return { sessionId: orderedSessions[targetIndex].id, index: targetIndex };
}
