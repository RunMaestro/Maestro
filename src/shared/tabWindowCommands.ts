/**
 * Wire shape for the `tab_window_command` message - the CLI half of Tab Windows
 * (`maestro-cli tab pop-out`, `tab dock`, `tab windows`, TW-12).
 *
 * It lives in `shared/` because all three processes need it: the CLI builds
 * the request, the main process validates it, resolves the owning agent, and
 * answers `list` from the window registry, and the agent's owner window
 * answers `pop-out` and `dock` through `services/tabWindowActions.ts`, the
 * same service the chip menu, Cmd+K, and the shortcut call.
 *
 * One message with an `action` rather than one per verb, for the same reason
 * as `snooze_command` and `window_command`: the verbs differ only in what they
 * do with one tab id, and parallel callbacks would be parallel chances to drift
 * from the click path.
 */

import { readBackgroundField } from './focusPlacement';
import { isSingleTabRef } from './unifiedTabRef';
import type { TabWindowTabRef } from './tabWindowTypes';

/** The verbs a tab window command can carry. */
export const TAB_WINDOW_COMMAND_ACTIONS = ['pop-out', 'dock', 'list'] as const;

export type TabWindowCommandAction = (typeof TAB_WINDOW_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a tab window command action. */
export function isTabWindowCommandAction(value: unknown): value is TabWindowCommandAction {
	return (
		typeof value === 'string' &&
		TAB_WINDOW_COMMAND_ACTIONS.includes(value as TabWindowCommandAction)
	);
}

/** One tab window command, already validated. */
export interface TabWindowCommandRequest {
	action: TabWindowCommandAction;
	/**
	 * The agent that owns the tab. Optional from the CLI (`--agent`); main fills
	 * it in from the tab id before it forwards the request, so the owner window
	 * always receives it.
	 */
	sessionId?: string;
	/** `pop-out` / `dock`: the tab id, exact or a unique prefix, of any tab kind. */
	tabId?: string;
	/** `pop-out` only: add the tab without raising the tab window (`--background`). */
	background?: boolean;
}

/** One tab window, flattened for the wire with its agent's name. */
export interface TabWindowSummary {
	windowId: string;
	agentId: string;
	/** Null when the sessions store no longer knows the agent. */
	agentName: string | null;
	/** The popped tabs, in the tab window's own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The tab shown in the tab window, or null while it holds none. */
	activeTabRef: TabWindowTabRef | null;
}

/** What a tab window command answers with. */
export interface TabWindowCommandResult {
	success: boolean;
	error?: string;
	/** `pop-out` / `dock`: the agent that owns the tab. */
	agentId?: string;
	/** `pop-out` / `dock`: the tab acted on, with its kind. */
	tabRef?: TabWindowTabRef;
	/** `pop-out` / `dock`: the agent's tab window. */
	windowId?: string;
	/** `pop-out` only: true when this call opened the window. */
	created?: boolean;
	/**
	 * `pop-out` / `dock`: the tabs left in the tab window after the verb ran.
	 * Empty after a dock that closed the window.
	 */
	tabRefs?: TabWindowTabRef[];
	/** `list` only. */
	windows?: TabWindowSummary[];
}

function isTabRefList(value: unknown): value is TabWindowTabRef[] {
	return Array.isArray(value) && value.every(isSingleTabRef);
}

/**
 * Narrow whatever the renderer sent back to a result, so a malformed answer
 * becomes a failed command rather than a `success: undefined` the CLI reports
 * as done.
 */
export function normalizeTabWindowCommandResult(raw: unknown): TabWindowCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid tab window response' };
	}
	const candidate = raw as Partial<Record<keyof TabWindowCommandResult, unknown>>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Tab window command failed',
		};
	}
	return {
		success: true,
		...(typeof candidate.agentId === 'string' ? { agentId: candidate.agentId } : {}),
		...(isSingleTabRef(candidate.tabRef) ? { tabRef: candidate.tabRef } : {}),
		...(typeof candidate.windowId === 'string' ? { windowId: candidate.windowId } : {}),
		...(typeof candidate.created === 'boolean' ? { created: candidate.created } : {}),
		...(isTabRefList(candidate.tabRefs) ? { tabRefs: candidate.tabRefs } : {}),
		...(Array.isArray(candidate.windows)
			? { windows: candidate.windows as TabWindowSummary[] }
			: {}),
	};
}

/**
 * Validate a raw `tab_window_command` message in the main process, between a
 * CLI that can be any version and a renderer that must never be handed a
 * half-formed request.
 */
export function parseTabWindowCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: TabWindowCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isTabWindowCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing tab window action. Must be one of: ${TAB_WINDOW_COMMAND_ACTIONS.join(', ')}`,
		};
	}
	if (action === 'list') return { ok: true, request: { action } };

	const tabId = typeof message.tabId === 'string' ? message.tabId.trim() : '';
	if (!tabId) return { ok: false, error: `tab ${action} requires a tab id` };
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	return {
		ok: true,
		request: {
			action,
			tabId,
			...(sessionId ? { sessionId } : {}),
			...(action === 'pop-out' ? { background: readBackgroundField(message) } : {}),
		},
	};
}

// ============================================================================
// Tab id resolution
// ============================================================================

const TAB_ARRAYS: ReadonlyArray<[TabWindowTabRef['type'], string]> = [
	['ai', 'aiTabs'],
	['file', 'filePreviewTabs'],
	['terminal', 'terminalTabs'],
	['browser', 'browserTabs'],
];

/** A tab id resolved to its agent and kind. */
export interface ResolvedTabId {
	agentId: string;
	tabRef: TabWindowTabRef;
}

/**
 * Find the tab `tabId` names among `sessions`' four tab arrays (AI, file,
 * terminal, browser): an exact id first, else a unique prefix, the rule every
 * other `maestro-cli tab` verb follows. `sessions` is read defensively, so main
 * can pass the raw sessions store and the renderer one `Session`.
 */
export function resolveTabIdInSessions(
	sessions: ReadonlyArray<unknown>,
	tabId: string
): { ok: true; resolved: ResolvedTabId } | { ok: false; error: string } {
	const exact: ResolvedTabId[] = [];
	const prefixed: ResolvedTabId[] = [];
	for (const session of sessions) {
		if (!session || typeof session !== 'object') continue;
		const record = session as Record<string, unknown>;
		if (typeof record.id !== 'string') continue;
		for (const [type, key] of TAB_ARRAYS) {
			const tabs = record[key];
			if (!Array.isArray(tabs)) continue;
			for (const tab of tabs as Array<{ id?: unknown }>) {
				if (typeof tab?.id !== 'string') continue;
				const match = { agentId: record.id, tabRef: { type, id: tab.id } };
				if (tab.id === tabId) exact.push(match);
				else if (tab.id.startsWith(tabId)) prefixed.push(match);
			}
		}
	}
	const matches = exact.length > 0 ? exact : prefixed;
	if (matches.length === 1) return { ok: true, resolved: matches[0] };
	if (matches.length > 1) {
		return { ok: false, error: `Ambiguous tab ID '${tabId}' (${matches.length} matches)` };
	}
	return { ok: false, error: `Tab not found: ${tabId}` };
}
