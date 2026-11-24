/**
 * Wire shape for the `design_pick_command` message - the CLI half of the
 * Design Mode chip strip (`maestro-cli browser-picks`).
 *
 * A Design Mode pick waits in the composer as a chip until the message is
 * sent. In the strip a person reads each chip (its popover shows the whole
 * block) and takes one off with its X. This module makes the same two
 * reachable from the CLI: `list` reads the chips staged on the agent's
 * composer target tab (the tab a pick lands in), and `remove` takes one off by
 * id. It lives in `shared/` because all three processes need it: the CLI
 * builds the request, the main process validates it on the way through, and
 * the renderer, which holds the chips, answers it.
 *
 * One message with an `action`, for the reason `snoozeCommands.ts` gives.
 */

/** The verbs a Design Mode chip command can carry. */
export const DESIGN_PICK_COMMAND_ACTIONS = ['list', 'remove'] as const;

export type DesignPickCommandAction = (typeof DESIGN_PICK_COMMAND_ACTIONS)[number];

/** What a chip holds: one picked element, or a dragged region of the page. */
export type DesignPickKind = 'element' | 'region';

/** One Design Mode chip command, already validated. */
export interface DesignPickCommandRequest {
	action: DesignPickCommandAction;
	/** Agent whose composer holds the chips. Every verb names one. */
	sessionId: string;
	/** `remove`: the chip, by the id `list` or `browser-pick --json` reported. */
	pickId?: string;
}

/** One staged chip, as it crosses the wire. */
export interface DesignPickSummary {
	id: string;
	kind: DesignPickKind;
	/** The short label the chip shows, as in `button.cta "Sign up"`. Page data. */
	label: string;
	/** The page the pick was made on. */
	url: string;
	/** The user's note, sent after the block. Empty when there is none. */
	note: string;
	/** The block the chip adds to the message at send, without the note. */
	text: string;
	/** Whether the chip carries a screenshot. The image itself stays in the app. */
	screenshot: boolean;
}

/** What the renderer answers a Design Mode chip command with. */
export interface DesignPickCommandResult {
	success: boolean;
	error?: string;
	/** The AI tab whose composer holds the chips. */
	aiTabId?: string;
	/** `list`: every chip staged on that tab, in chip order (the order they are sent in). */
	picks?: DesignPickSummary[];
	/** `remove`: the chip taken off. */
	removed?: DesignPickSummary;
}

function isAction(value: unknown): value is DesignPickCommandAction {
	return (
		typeof value === 'string' &&
		DESIGN_PICK_COMMAND_ACTIONS.includes(value as DesignPickCommandAction)
	);
}

/**
 * Validate a raw `design_pick_command` message.
 *
 * Runs in the main process, between a CLI that can be any version and a
 * renderer that must never be handed a half-formed request.
 */
export function parseDesignPickCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: DesignPickCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing Design Mode chip action. Must be one of: ${DESIGN_PICK_COMMAND_ACTIONS.join(', ')}`,
		};
	}
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	if (!sessionId) return { ok: false, error: `browser-picks ${action} requires an agent` };

	if (action === 'remove') {
		const pickId = typeof message.pickId === 'string' ? message.pickId.trim() : '';
		if (!pickId) return { ok: false, error: 'browser-picks remove requires a chip id' };
		return { ok: true, request: { action, sessionId, pickId } };
	}
	return { ok: true, request: { action, sessionId } };
}

/**
 * Narrow whatever the renderer sent back to a result, so a malformed answer
 * becomes a failed command rather than a `success: undefined` the CLI reports
 * as done.
 */
export function normalizeDesignPickCommandResult(raw: unknown): DesignPickCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid Design Mode chip response' };
	}
	const candidate = raw as Partial<DesignPickCommandResult>;
	const tab = typeof candidate.aiTabId === 'string' ? { aiTabId: candidate.aiTabId } : {};
	if (candidate.success !== true) {
		return {
			success: false,
			error:
				typeof candidate.error === 'string' ? candidate.error : 'Design Mode chip command failed',
			...tab,
		};
	}
	return {
		success: true,
		...tab,
		...(Array.isArray(candidate.picks) ? { picks: candidate.picks } : {}),
		...(candidate.removed && typeof candidate.removed === 'object'
			? { removed: candidate.removed }
			: {}),
	};
}
