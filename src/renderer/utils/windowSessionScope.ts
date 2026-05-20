import type { Session } from '../types';

export function getWindowSessions(
	sessions: Session[],
	windowId: string | null,
	windowSessionIds: string[]
): Session[] {
	if (!windowId) {
		return sessions;
	}

	const windowSessionIdSet = new Set(windowSessionIds);
	return sessions.filter((session) => windowSessionIdSet.has(session.id));
}

export function getWindowActiveSession({
	sessions,
	windowSessions,
	windowId,
	windowSessionIds,
	storeActiveSession,
	windowActiveSessionId,
}: {
	sessions: Session[];
	windowSessions: Session[];
	windowId: string | null;
	windowSessionIds: string[];
	storeActiveSession: Session | null;
	windowActiveSessionId: string | null;
}): Session | null {
	if (!windowId) {
		return storeActiveSession;
	}

	const windowSessionIdSet = new Set(windowSessionIds);
	if (storeActiveSession && windowSessionIdSet.has(storeActiveSession.id)) {
		return storeActiveSession;
	}

	const contextActiveSession =
		windowActiveSessionId && sessions.find((session) => session.id === windowActiveSessionId);
	if (contextActiveSession && windowSessionIdSet.has(contextActiveSession.id)) {
		return contextActiveSession;
	}

	return windowSessions[0] ?? null;
}
