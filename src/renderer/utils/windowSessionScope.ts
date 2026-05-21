import type { Session, ThinkingItem } from '../types';

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

export function getThinkingItemsForSessions(sessions: Session[]): ThinkingItem[] {
	const items: ThinkingItem[] = [];
	for (const session of sessions) {
		if (session.state === 'busy' && session.busySource === 'ai') {
			const busyTabs = session.aiTabs?.filter((tab) => tab.state === 'busy');
			if (busyTabs && busyTabs.length > 0) {
				for (const tab of busyTabs) {
					items.push({ session, tab });
				}
			} else if (!session.orphanedThinkingTabs?.length) {
				items.push({ session, tab: null });
			}
		}
		for (const orphan of session.orphanedThinkingTabs ?? []) {
			items.push({ session, tab: orphan });
		}
	}
	return items;
}

export function getWindowScopedIds(
	ids: string[],
	windowId: string | null,
	windowSessionIds: string[]
): string[] {
	if (!windowId) {
		return ids;
	}

	const windowSessionIdSet = new Set(windowSessionIds);
	return ids.filter((id) => windowSessionIdSet.has(id));
}
