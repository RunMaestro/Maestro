/**
 * Wire shape for the `auto_run_steering_command` message - the CLI half of the
 * Thought Stream's Steer Auto Run bar (`maestro-cli steer-auto-run`).
 *
 * Steering is three gestures in the panel: send a note for the next task, take
 * back one no task has read yet, and read what was said and what came back.
 * This module is what makes the same three reachable from the CLI, and it lives
 * in `shared/` because all three processes need it: the CLI builds the request,
 * the main process validates it on the way through, and the renderer - which
 * owns the notes - answers it.
 *
 * One message with an `action` rather than three, for the reason
 * `snoozeCommands.ts` gives: the verbs differ only in which fields they carry,
 * and three parallel callbacks, IPC channels and renderer handlers would be
 * three chances for one of them to drift from the click path it mirrors.
 *
 * The note itself, its length cap, and the block an agent reads are defined in
 * `autorunSteering.ts`. Nothing about them is restated here.
 */

import { MAX_STEERING_NOTE_LENGTH } from './autorunSteering';

/** The verbs a steering command can carry. */
export const STEERING_COMMAND_ACTIONS = ['send', 'list', 'cancel'] as const;

export type SteeringCommandAction = (typeof STEERING_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a steering action. */
export function isSteeringCommandAction(value: unknown): value is SteeringCommandAction {
	return (
		typeof value === 'string' && STEERING_COMMAND_ACTIONS.includes(value as SteeringCommandAction)
	);
}

/** One steering command, already validated. */
export interface SteeringCommandRequest {
	action: SteeringCommandAction;
	/** Agent whose Auto Run is being steered. Every verb names one. */
	sessionId: string;
	/** `send` only: the note, trimmed. */
	text?: string;
	/** `cancel` only: the pending note to take back, from `list`. */
	noteId?: string;
	/**
	 * `send` only: suppress the "Steering note queued" flash (`--background`).
	 *
	 * It is the NOTICE this suppresses, never the note: the note is parked for
	 * the next task either way.
	 */
	background?: boolean;
}

/** One note the operator sent, as it crosses the wire. */
export interface SteeringNoteSummary {
	/** Stable handle for `cancel` while the note is still pending. */
	id: string;
	text: string;
	/** When it was sent (ms epoch). */
	timestamp: number;
}

/** What the task that took a delivery's notes said back. */
export interface SteeringReplySummary {
	/** One-line synopsis of the task. */
	summary: string;
	/** The task's whole reply, or its error when it failed. */
	text: string;
	/** False when the task that took the notes failed. */
	success: boolean;
	/** When the task finished (ms epoch). */
	timestamp: number;
}

/**
 * The notes one task took together, and its single reply to all of them.
 *
 * Grouped rather than flattened to one row per note: a reply is a whole task
 * response, and notes taken together share ONE, so a flat list would put the
 * same response on the wire once per note.
 */
export interface SteeringDeliverySummary {
	deliveryId: string;
	notes: SteeringNoteSummary[];
	/** Absent while the task that took the notes is still running. */
	reply?: SteeringReplySummary;
}

/** What the renderer answers a steering command with. */
export interface SteeringCommandResult {
	success: boolean;
	error?: string;
	/** `send`: the note that was parked. `cancel`: the note that was taken back. */
	note?: SteeringNoteSummary;
	/**
	 * `list` only: whether a `send` would be accepted right now - a run this
	 * client owns is in flight. False is an answer, not a failure: the delivered
	 * notes of a finished run are still worth reading.
	 */
	steerable?: boolean;
	/** `list` only: notes waiting for the next task, oldest first. */
	pending?: SteeringNoteSummary[];
	/** `list` only: notes a task already took, oldest delivery first. */
	deliveries?: SteeringDeliverySummary[];
}

/**
 * Narrow whatever the renderer sent back to a result.
 *
 * The reply crosses an IPC boundary from a process that can be a different
 * build (a browser client left open across an update), so a malformed answer
 * has to become a failed command rather than a `success: undefined` the CLI
 * reports as done.
 */
export function normalizeSteeringCommandResult(raw: unknown): SteeringCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid steering response' };
	}
	const candidate = raw as Partial<SteeringCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Steering command failed',
		};
	}
	return {
		success: true,
		...(candidate.note ? { note: candidate.note } : {}),
		...(typeof candidate.steerable === 'boolean' ? { steerable: candidate.steerable } : {}),
		...(Array.isArray(candidate.pending) ? { pending: candidate.pending } : {}),
		...(Array.isArray(candidate.deliveries) ? { deliveries: candidate.deliveries } : {}),
	};
}

/**
 * Validate a raw `auto_run_steering_command` message.
 *
 * Runs in the main process, between a CLI that can be any version and a
 * renderer that must never be handed a half-formed request.
 *
 * An over-long note is REFUSED here rather than trimmed to fit. The panel can
 * cap as the operator types because they watch the box stop accepting text; a
 * caller on the far side of a socket sees nothing, and a note silently cut off
 * mid-sentence is an instruction the agent follows that nobody wrote.
 *
 * @returns The validated request, or a message naming what is missing.
 */
export function parseSteeringCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: SteeringCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isSteeringCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing steering action. Must be one of: ${STEERING_COMMAND_ACTIONS.join(', ')}`,
		};
	}

	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	if (!sessionId) return { ok: false, error: `steering ${action} requires a sessionId` };

	if (action === 'send') {
		const text = typeof message.text === 'string' ? message.text.trim() : '';
		if (!text) return { ok: false, error: 'A steering note needs some text' };
		if (text.length > MAX_STEERING_NOTE_LENGTH) {
			return {
				ok: false,
				error: `Steering note is ${text.length} characters; the limit is ${MAX_STEERING_NOTE_LENGTH}`,
			};
		}
		return {
			ok: true,
			request: {
				action,
				sessionId,
				text,
				// Opt-in only: a literal `true`. See `readBackgroundField`.
				...(message.background === true ? { background: true } : {}),
			},
		};
	}

	if (action === 'cancel') {
		const noteId = typeof message.noteId === 'string' ? message.noteId.trim() : '';
		if (!noteId) return { ok: false, error: 'steering cancel requires a note id' };
		return { ok: true, request: { action, sessionId, noteId } };
	}

	return { ok: true, request: { action, sessionId } };
}
