/**
 * Wire shape for the `closed_tab_command` message - the CLI half of Cmd+Shift+T.
 *
 * The closed-tab stack (`Session.unifiedClosedTabHistory`) lives in the
 * renderer that owns the agent, so the CLI reads and reopens it through that
 * renderer rather than through the stored inventory: the store lags a close by
 * up to the persistence debounce, so `tab close X; tab closed` would miss X and
 * `--index 0` would address a different entry than Cmd+Shift+T reopens next.
 * The inventory is also a list of OPEN tabs, and every tab verb matches ids
 * against it, so closed entries do not belong there.
 *
 * One message with an `action` (the `snooze_command` pattern): `list` and
 * `reopen` name the same agent and the same entries, and two parallel
 * callbacks and IPC channels would be two chances to drift.
 *
 * Lives in `shared/` because all three processes need it: the CLI builds the
 * request, main validates it on the way through, and the renderer answers it.
 */

/** The verbs a closed-tab command can carry. */
export const CLOSED_TAB_COMMAND_ACTIONS = ['list', 'reopen'] as const;

export type ClosedTabCommandAction = (typeof CLOSED_TAB_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a closed-tab action. */
export function isClosedTabCommandAction(value: unknown): value is ClosedTabCommandAction {
	return (
		typeof value === 'string' &&
		CLOSED_TAB_COMMAND_ACTIONS.includes(value as ClosedTabCommandAction)
	);
}

/** One closed-tab command, already validated. */
export interface ClosedTabCommandRequest {
	action: ClosedTabCommandAction;
	/** Agent whose stack is read or reopened from. */
	sessionId: string;
	/**
	 * `reopen` only: position in the stack, 0 being the entry Cmd+Shift+T
	 * reopens next. Absent (and no `tabId`) means 0.
	 */
	index?: number;
	/**
	 * `reopen` only: the id the tab had when it was closed (exact, or a unique
	 * prefix). Mutually exclusive with `index`.
	 */
	tabId?: string;
	/**
	 * Restore the tab without changing the agent's active tab or the selected
	 * agent (`--background`). Opt-in only: read with `readBackgroundField`.
	 */
	background?: boolean;
}

/** Kinds of tab the stack holds. */
export type ClosedTabType = 'ai' | 'file' | 'terminal' | 'browser';

/**
 * One closed tab, flattened for the wire.
 *
 * Flat rather than the stored `ClosedTabEntry`: an entry closed in this run
 * still carries its whole transcript in memory, and "what can I reopen?" must
 * not put that on a socket.
 */
export interface ClosedTabSummary {
	/** Position in the stack; 0 is what Cmd+Shift+T reopens next. */
	index: number;
	type: ClosedTabType;
	/** Display label (`getTabDisplayName()` for an AI tab). */
	label: string;
	/** The tab's id when it was closed. A reopened AI tab usually gets a new one. */
	tabId: string;
	/** When it was closed (ms epoch). */
	closedAt: number;
	/** The tab was a pane of a tiled group; reopening rebuilds the pane. */
	tiled?: boolean;
	/** AI only: the provider session the transcript is read back from. */
	agentSessionId?: string;
}

/**
 * Whether a reopened tab's content (transcript, file text) is in place.
 * `pending` means the read outlived the reply budget and is still running.
 */
export type ReopenedContentState = 'loaded' | 'skipped' | 'unavailable' | 'failed' | 'pending';

/** What the renderer answers a closed-tab command with. */
export interface ClosedTabCommandResult {
	success: boolean;
	error?: string;
	/** `list` only: the stack, newest first. */
	closedTabs?: ClosedTabSummary[];
	/** `reopen` only: the entry that was taken off the stack. */
	reopened?: ClosedTabSummary;
	/** `reopen` only: the tab that is open now (the restored tab's NEW id). */
	tabId?: string;
	/** `reopen` only: the kind of tab `tabId` names. */
	tabType?: ClosedTabType;
	/**
	 * `reopen` only: an equivalent tab was already open (same conversation or
	 * same file), so the entry was dropped and `tabId` names the open tab.
	 */
	wasDuplicate?: boolean;
	/** `reopen` only: whether the reopened tab's content was read back. */
	content?: ReopenedContentState;
}

const CONTENT_STATES: readonly ReopenedContentState[] = [
	'loaded',
	'skipped',
	'unavailable',
	'failed',
	'pending',
];

const TAB_TYPES: readonly ClosedTabType[] = ['ai', 'file', 'terminal', 'browser'];

/**
 * Narrow whatever the renderer sent back to a result.
 *
 * The reply crosses an IPC boundary, so a malformed answer becomes a failed
 * command rather than a `success: undefined` the CLI would report as done.
 */
export function normalizeClosedTabCommandResult(raw: unknown): ClosedTabCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid closed-tab response' };
	}
	const candidate = raw as Partial<ClosedTabCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Closed-tab command failed',
		};
	}
	return {
		success: true,
		...(Array.isArray(candidate.closedTabs) ? { closedTabs: candidate.closedTabs } : {}),
		...(candidate.reopened && typeof candidate.reopened === 'object'
			? { reopened: candidate.reopened }
			: {}),
		...(typeof candidate.tabId === 'string' ? { tabId: candidate.tabId } : {}),
		...(candidate.tabType && TAB_TYPES.includes(candidate.tabType)
			? { tabType: candidate.tabType }
			: {}),
		...(candidate.wasDuplicate === true ? { wasDuplicate: true } : {}),
		...(candidate.content && CONTENT_STATES.includes(candidate.content)
			? { content: candidate.content }
			: {}),
	};
}

/**
 * Validate a raw `closed_tab_command` message.
 *
 * Runs in main, between a CLI of any version and the renderer. A negative or
 * fractional index, or both an index and a tab id, is refused here so the
 * renderer never has to guess which entry was meant.
 *
 * @returns The validated request, or a message naming what is wrong.
 */
export function parseClosedTabCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: ClosedTabCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isClosedTabCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing closed-tab action. Must be one of: ${CLOSED_TAB_COMMAND_ACTIONS.join(', ')}`,
		};
	}

	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	if (!sessionId) return { ok: false, error: `Closed-tab ${action} requires a sessionId` };

	if (action === 'list') return { ok: true, request: { action, sessionId } };

	let index: number | undefined;
	if (message.index !== undefined && message.index !== null) {
		const raw = message.index;
		if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
			return { ok: false, error: 'index must be a non-negative integer' };
		}
		index = raw;
	}
	const tabId = typeof message.tabId === 'string' ? message.tabId.trim() : '';
	if (index !== undefined && tabId) {
		return { ok: false, error: 'Name the closed tab by index or by tab id, not both' };
	}

	return {
		ok: true,
		request: {
			action,
			sessionId,
			...(index !== undefined ? { index } : {}),
			...(tabId ? { tabId } : {}),
			...(message.background === true ? { background: true } : {}),
		},
	};
}
