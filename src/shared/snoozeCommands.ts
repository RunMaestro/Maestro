/**
 * Wire shape for the `snooze_command` message - the CLI half of the snooze UI.
 *
 * Snoozing parks a tab out of the tab bar until a chosen moment, and every one
 * of its verbs (park, list, wake, dismiss, reschedule, history) is reachable by
 * clicking. This module is what makes the same six reachable from
 * `maestro-cli snooze`, and it lives in `shared/` because all three processes
 * need it: the CLI builds the request, the main process validates it on the way
 * through, and the renderer - which owns the authoritative snooze state -
 * answers it.
 *
 * One message with an `action` rather than six messages: the six differ only in
 * which id they name and which fields they carry, and six parallel callbacks,
 * IPC channels and renderer handlers would be six chances for one of them to
 * drift from the click path it mirrors.
 *
 * Deliberately NOT here: parsing the `<when>` expression. That is
 * {@link parseSnoozeInput} in `shared/snooze.ts`, resolved by the CLI against
 * its own clock so a bad phrase fails before a round trip and so the resolved
 * instant on the wire is unambiguous.
 */

/** The verbs a snooze command can carry. */
export const SNOOZE_COMMAND_ACTIONS = [
	'list',
	'snooze',
	'wake',
	'dismiss',
	'reschedule',
	'history',
] as const;

export type SnoozeCommandAction = (typeof SNOOZE_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a snooze action. */
export function isSnoozeCommandAction(value: unknown): value is SnoozeCommandAction {
	return typeof value === 'string' && SNOOZE_COMMAND_ACTIONS.includes(value as SnoozeCommandAction);
}

/** One snooze command, already validated. */
export interface SnoozeCommandRequest {
	action: SnoozeCommandAction;
	/**
	 * Agent that owns the target. Required for every write; on `list` it is an
	 * optional filter and on `history` it is ignored (the log is app-wide, and
	 * an agent it names may no longer exist).
	 */
	sessionId?: string;
	/**
	 * `snooze`: the tab or tiled-group id to park. `wake` / `dismiss` /
	 * `reschedule`: the snooze id from `snooze list`.
	 */
	targetId?: string;
	/** Absolute wake instant (ms epoch). Required by `snooze` and `reschedule`. */
	wakeAt?: number;
	/**
	 * Note-to-self surfaced in the wake notification. On `reschedule` an absent
	 * field keeps the existing note and an empty string clears it, matching the
	 * dialog - which is why these stay `undefined` rather than defaulting to ''.
	 */
	note?: string;
	/** Prompt dispatched to the agent the instant the tab comes back. */
	wakePrompt?: string;
	/** `history` only: cap on how many resolved snoozes to return. */
	limit?: number;
	/**
	 * Suppress the verb's notice (`--background`).
	 *
	 * Only `snooze` and `dismiss` render one. It is the NOTICE this suppresses,
	 * never the work: a parked tab leaving the strip is the verb itself, not
	 * placement, so there is no quieter form of it to ask for.
	 */
	background?: boolean;
}

/**
 * One parked tab, flattened for the wire.
 *
 * Flat rather than the stored `SnoozedTabEntry` because that entry carries the
 * whole parked tab - a full AI transcript, every log entry - and a list of five
 * snoozes would put megabytes on a socket to answer "what is parked?".
 */
export interface SnoozedTabSummary {
	/** Stable handle for `wake` / `dismiss` / `reschedule`. */
	snoozeId: string;
	agentId: string;
	agentName: string;
	type: 'ai' | 'file' | 'terminal' | 'browser' | 'group';
	/** Display label, resolved the same way the Snoozed Tabs list resolves it. */
	label: string;
	/** The parked tab's own id, or the group's id for a parked group. */
	tabId: string;
	snoozedAt: number;
	wakeAt: number;
	note?: string;
	wakePrompt?: string;
	/** Panes held by a parked group. Absent for the single-tab kinds. */
	memberCount?: number;
}

/** One resolved snooze from the history log. */
export interface SnoozeHistorySummary {
	id: string;
	label: string;
	agentId: string;
	agentName: string;
	tabId: string;
	note?: string;
	snoozedAt: number;
	wakeAt: number;
	resolvedAt: number;
	resolution: 'woke' | 'unsnoozed' | 'dismissed';
}

/** What the renderer answers a snooze command with. */
export interface SnoozeCommandResult {
	success: boolean;
	error?: string;
	/** The snooze this command created, changed, or ended. */
	snooze?: SnoozedTabSummary;
	/** `list` only. */
	snoozes?: SnoozedTabSummary[];
	/** `history` only. */
	history?: SnoozeHistorySummary[];
	/** `wake` only: the tab that came back (a group answers with its group id). */
	tabId?: string;
	/**
	 * `wake` only: an equivalent tab was already open, so nothing was restored
	 * and `tabId` names the tab that was already there.
	 */
	wasDuplicate?: boolean;
}

/**
 * Narrow whatever the renderer sent back to a result.
 *
 * The reply crosses an IPC boundary from a process that can be a different
 * build (a browser client left open across an update), so a malformed answer
 * has to become a failed command rather than a `success: undefined` the CLI
 * reads as truthy-ish and reports as done.
 */
export function normalizeSnoozeCommandResult(raw: unknown): SnoozeCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid snooze response' };
	}
	const candidate = raw as Partial<SnoozeCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Snooze command failed',
		};
	}
	return {
		success: true,
		...(candidate.snooze ? { snooze: candidate.snooze } : {}),
		...(Array.isArray(candidate.snoozes) ? { snoozes: candidate.snoozes } : {}),
		...(Array.isArray(candidate.history) ? { history: candidate.history } : {}),
		...(typeof candidate.tabId === 'string' ? { tabId: candidate.tabId } : {}),
		...(candidate.wasDuplicate === true ? { wasDuplicate: true } : {}),
	};
}

/**
 * Validate a raw `snooze_command` message.
 *
 * Runs in the main process, between a CLI that can be any version and a
 * renderer that must never be handed a half-formed request: a `snooze` with no
 * `wakeAt` would park a tab with a wake instant of `NaN`, which never comes
 * due and never appears overdue, so the tab would simply be gone.
 *
 * @returns The validated request, or a message naming what is missing.
 */
export function parseSnoozeCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: SnoozeCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isSnoozeCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing snooze action. Must be one of: ${SNOOZE_COMMAND_ACTIONS.join(', ')}`,
		};
	}

	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	const targetId = typeof message.targetId === 'string' ? message.targetId.trim() : '';

	if (action !== 'list' && action !== 'history') {
		if (!sessionId) return { ok: false, error: `snooze ${action} requires a sessionId` };
		if (!targetId) {
			return {
				ok: false,
				error:
					action === 'snooze'
						? 'snooze requires the id of the tab or group to park'
						: `snooze ${action} requires a snooze id`,
			};
		}
	}

	let wakeAt: number | undefined;
	if (action === 'snooze' || action === 'reschedule') {
		const raw = message.wakeAt;
		if (typeof raw !== 'number' || !Number.isFinite(raw)) {
			return { ok: false, error: `snooze ${action} requires a numeric wakeAt (ms epoch)` };
		}
		wakeAt = Math.floor(raw);
	}

	let limit: number | undefined;
	if (typeof message.limit === 'number' && Number.isFinite(message.limit) && message.limit >= 0) {
		limit = Math.floor(message.limit);
	}

	return {
		ok: true,
		request: {
			action,
			...(sessionId ? { sessionId } : {}),
			...(targetId ? { targetId } : {}),
			...(wakeAt !== undefined ? { wakeAt } : {}),
			// Empty string is meaningful on reschedule (it clears the field), so
			// only a genuinely absent field is dropped.
			...(typeof message.note === 'string' ? { note: message.note } : {}),
			...(typeof message.wakePrompt === 'string' ? { wakePrompt: message.wakePrompt } : {}),
			...(limit !== undefined ? { limit } : {}),
			// Opt-in only: a literal `true`. See `readBackgroundField`.
			...(message.background === true ? { background: true } : {}),
		},
	};
}
