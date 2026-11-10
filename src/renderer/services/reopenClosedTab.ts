/**
 * Reopen Closed Tab for a named agent - the renderer half of
 * `maestro-cli tab reopen`.
 *
 * The keyboard shortcut and the command palette reopen into the ACTIVE agent.
 * The remote path names its agent and may ask for background placement, so it
 * reads the session from the live store by id and runs the same tiling-aware
 * restore (`reopenClosedTabWithTiling`) the shortcut does.
 */

import type { Session } from '../types';
import { NOTHING_TO_REOPEN_ERROR, type ReopenClosedTabResult } from '../../shared/reopenClosedTab';
import { useSessionStore } from '../stores/sessionStore';
import { reopenClosedTabWithTiling } from '../utils/panelLayout';

/**
 * The fields that decide which tab the main window draws. A background reopen
 * keeps all of them from before the restore, so the tab lands in the strip
 * without the agent's view changing.
 */
const VISIBLE_TAB_FIELDS = [
	'activeTabId',
	'activeFileTabId',
	'activeBrowserTabId',
	'activeTerminalTabId',
	'activeGroupId',
	'inputMode',
] as const satisfies readonly (keyof Session)[];

function keepVisibleTab(before: Session, after: Session): Session {
	const kept: Partial<Session> = {};
	for (const field of VISIBLE_TAB_FIELDS) {
		(kept as Record<string, unknown>)[field] = before[field];
	}
	return { ...after, ...kept };
}

export function reopenClosedTabInAgent(
	sessionId: string,
	options: { background?: boolean } = {}
): ReopenClosedTabResult {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) {
		return { success: false, error: `Session not found: ${sessionId}` };
	}

	const result = reopenClosedTabWithTiling(session);
	if (!result) {
		return { success: false, error: NOTHING_TO_REOPEN_ERROR };
	}

	const background = options.background === true;
	const next = background ? keepVisibleTab(session, result.session) : result.session;
	useSessionStore
		.getState()
		.setSessions((prev) => prev.map((s) => (s.id === sessionId ? next : s)));

	return {
		success: true,
		tabId: result.tabId,
		tabType: result.tabType,
		wasDuplicate: result.wasDuplicate,
		background,
	};
}
