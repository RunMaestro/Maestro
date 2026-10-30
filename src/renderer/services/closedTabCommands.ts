/**
 * closedTabCommands - the renderer end of `closed_tab_command`
 * (`maestro-cli tab closed` / `tab reopen`).
 *
 * The owning window answers from its live `unifiedClosedTabHistory`, so the
 * CLI sees a close the moment it happens and `--index 0` is the entry
 * Cmd+Shift+T reopens next. A reopen runs the shortcut's own function,
 * `reopenClosedTabWithTiling()` (index-aware for a deeper entry), then waits
 * for the tab's content and a tracked flush before it answers, so a following
 * `session show` reads the restored transcript from the store.
 */

import type { ClosedTabEntry, Session } from '../types';
import type { ReopenUnifiedClosedTabResult } from '../utils/tabHelpers';
import type {
	ClosedTabCommandRequest,
	ClosedTabCommandResult,
	ClosedTabSummary,
	ReopenedContentState,
} from '../../shared/closedTabCommands';
import { readBackgroundField } from '../../shared/focusPlacement';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { getTabDisplayName } from '../utils/tabHelpers';
import { reopenClosedTabWithTiling } from '../utils/panelLayout';
import { getParkedTabLabel } from '../utils/snoozeHelpers';
import { noteDesktopAiTabSelection } from '../utils/desktopTabSelectionSync';
import { loadReopenedTabContent } from './reopenedTabContent';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';

/**
 * How long a reopen waits for the tab's transcript or file before it answers
 * with `content: 'pending'`. The read carries on; the reply must fit the CLI's
 * 10 s request budget together with the flush.
 */
export const REOPEN_CONTENT_BUDGET_MS = 5_000;

/** What a reopen needs from App's hook tree. */
export interface ClosedTabCommandDeps {
	/** App's agent selector (dismisses a group chat, flushes batched updates). */
	selectAgent?: (sessionId: string) => void;
}

/** Display label for a closed tab: `getTabDisplayName()` for AI, the parked-tab label otherwise. */
export function getClosedTabLabel(entry: ClosedTabEntry): string {
	return entry.type === 'ai' ? getTabDisplayName(entry.tab) : getParkedTabLabel(entry);
}

/** Flatten one stack entry for the wire. */
export function toClosedTabSummary(entry: ClosedTabEntry, index: number): ClosedTabSummary {
	return {
		index,
		type: entry.type,
		label: getClosedTabLabel(entry),
		tabId: entry.tab.id,
		closedAt: entry.closedAt,
		...(entry.tilePlacement ? { tiled: true } : {}),
		...(entry.type === 'ai' && entry.tab.agentSessionId
			? { agentSessionId: entry.tab.agentSessionId }
			: {}),
	};
}

/** An agent's closed-tab stack, newest first, as the CLI lists it. */
export function listClosedTabs(session: Session): ClosedTabSummary[] {
	return (session.unifiedClosedTabHistory ?? []).map(toClosedTabSummary);
}

/** Pick the stack position a reopen request names. */
function resolveEntryIndex(
	history: ClosedTabEntry[],
	request: ClosedTabCommandRequest
): { ok: true; index: number } | { ok: false; error: string } {
	if (history.length === 0) return { ok: false, error: 'No closed tabs to reopen' };

	if (request.tabId) {
		const ref = request.tabId;
		const exact = history.findIndex((entry) => entry.tab.id === ref);
		if (exact !== -1) return { ok: true, index: exact };
		const matches = history
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.tab.id.startsWith(ref));
		if (matches.length === 1) return { ok: true, index: matches[0].index };
		if (matches.length > 1) {
			return {
				ok: false,
				error: `Tab id prefix "${ref}" matches ${matches.length} closed tabs; use more characters or --index`,
			};
		}
		return { ok: false, error: `No closed tab with id ${ref}` };
	}

	const index = request.index ?? 0;
	if (index >= history.length) {
		return {
			ok: false,
			error: `No closed tab at index ${index} (the stack holds ${history.length})`,
		};
	}
	return { ok: true, index };
}

/** The fields that decide what the user sees inside an agent. */
function focusFields(
	session: Session
): Pick<
	Session,
	| 'activeTabId'
	| 'activeFileTabId'
	| 'activeBrowserTabId'
	| 'activeTerminalTabId'
	| 'activeGroupId'
	| 'inputMode'
> {
	return {
		activeTabId: session.activeTabId,
		activeFileTabId: session.activeFileTabId,
		activeBrowserTabId: session.activeBrowserTabId,
		activeTerminalTabId: session.activeTerminalTabId,
		activeGroupId: session.activeGroupId,
		inputMode: session.inputMode,
	};
}

/** Wait for the content read, but no longer than the budget. */
async function awaitContent(read: Promise<ReopenedContentState>): Promise<ReopenedContentState> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<ReopenedContentState>((resolve) => {
		timer = setTimeout(() => resolve('pending'), REOPEN_CONTENT_BUDGET_MS);
	});
	try {
		return await Promise.race([read, budget]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Run one closed-tab verb. Answers rather than throws for every expected
 * outcome (unknown agent, empty stack, bad index): the caller is a CLI process
 * reporting to a human.
 */
export async function runRemoteClosedTabCommand(
	request: ClosedTabCommandRequest,
	deps: ClosedTabCommandDeps = {}
): Promise<ClosedTabCommandResult> {
	const { sessionId } = request;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return { success: false, error: `Session not found: ${sessionId}` };

	if (request.action === 'list') {
		return { success: true, closedTabs: listClosedTabs(session) };
	}

	const history = session.unifiedClosedTabHistory ?? [];
	const picked = resolveEntryIndex(history, request);
	if (!picked.ok) return { success: false, error: picked.error };
	const entry = history[picked.index];
	const summary = toClosedTabSummary(entry, picked.index);
	const background = readBackgroundField(request);

	let reopened = null as ReopenUnifiedClosedTabResult | null;
	updateSessionWith(sessionId, (current) => {
		// The store write is synchronous, so the entry is still at this index;
		// the identity check guards a future async gap all the same.
		if (current.unifiedClosedTabHistory?.[picked.index] !== entry) return current;
		const result = reopenClosedTabWithTiling(current, picked.index);
		if (!result) return current;
		reopened = result;
		// `--background`: the tab comes back where it was closed, and the view
		// inside the agent stays where the user left it.
		return background ? { ...result.session, ...focusFields(current) } : result.session;
	});
	if (!reopened) return { success: false, error: `Could not reopen closed tab ${entry.tab.id}` };
	const { tabId, tabType, wasDuplicate } = reopened;

	if (!background) {
		deps.selectAgent?.(sessionId);
		if (tabType === 'ai') noteDesktopAiTabSelection(sessionId, tabId);
	}

	const content = await awaitContent(
		loadReopenedTabContent(sessionId, { type: tabType, id: tabId })
	);
	await flushSessionPersistenceNow(useSessionStore.getState().sessions);

	return {
		success: true,
		reopened: summary,
		tabId,
		tabType,
		...(wasDuplicate ? { wasDuplicate: true } : {}),
		content,
	};
}
