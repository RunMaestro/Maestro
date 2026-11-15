/**
 * Wire shape for the `diff_review_command` message - the CLI half of the Git
 * Diff viewer's review comments (`maestro-cli diff-review`).
 *
 * In the viewer a user pins comments to diff lines, lists them in the Review
 * tray, removes one, discards them all, and sends them (or puts them in the
 * composer). This module makes the same five reachable from the CLI. It lives
 * in `shared/` because all three processes need it: the CLI builds the request,
 * the main process validates it on the way through, and the renderer - which
 * holds the pending comments - answers it.
 *
 * One message with an `action`, for the reason `snoozeCommands.ts` gives.
 */

/** The verbs a diff review command can carry. */
export const DIFF_REVIEW_COMMAND_ACTIONS = ['list', 'add', 'remove', 'clear', 'send'] as const;

export type DiffReviewCommandAction = (typeof DIFF_REVIEW_COMMAND_ACTIONS)[number];

/** Which version of the file a line number refers to: `old` for removed lines. */
export type DiffReviewSide = 'old' | 'new';

/** One diff review command, already validated. */
export interface DiffReviewCommandRequest {
	action: DiffReviewCommandAction;
	/** Agent whose diff is being reviewed. Every verb names one. */
	sessionId: string;
	/** `add`: repo-relative path, as the diff names it. */
	path?: string;
	/** `add`: first line, 1-based. */
	startLine?: number;
	/** `add`: last line, inclusive. Defaults to `startLine`. */
	endLine?: number;
	/** `add`: which version the numbers are in. Defaults to `new`. */
	side?: DiffReviewSide;
	/** `add`: the comment. */
	body?: string;
	/** `remove`: the comment to drop, from `list`. */
	commentId?: string;
	/** `send`: put the review in the agent's composer instead of sending it. */
	compose?: boolean;
	/** `send`: deliver without switching the agent or tab, and without the flash. */
	background?: boolean;
}

/** One pending comment, as it crosses the wire. */
export interface DiffReviewCommentSummary {
	id: string;
	/** The path the line numbers refer to. */
	path: string;
	side: DiffReviewSide;
	startLine: number;
	endLine: number;
	/** `src/app.ts:12-14`, with "(previous version)" for old-side lines. */
	location: string;
	body: string;
	/** Its lines changed since it was written: kept, but never sent. */
	outdated: boolean;
}

/** What the renderer answers a diff review command with. */
export interface DiffReviewCommandResult {
	success: boolean;
	error?: string;
	/** The repository the review belongs to (the agent's git working directory). */
	cwd?: string;
	/** `list`: every pending comment, in the order it was written. */
	comments?: DiffReviewCommentSummary[];
	/** `add`: the comment created. `remove`: the comment dropped. */
	comment?: DiffReviewCommentSummary;
	/** `clear`: how many comments were dropped. */
	cleared?: number;
	/** `send`: the comments delivered. */
	delivered?: DiffReviewCommentSummary[];
	/** `send`: comments left behind because their lines changed. */
	outdated?: DiffReviewCommentSummary[];
	/** `send`: the prompt the agent received (or found in its composer). */
	prompt?: string;
}

function isAction(value: unknown): value is DiffReviewCommandAction {
	return (
		typeof value === 'string' &&
		DIFF_REVIEW_COMMAND_ACTIONS.includes(value as DiffReviewCommandAction)
	);
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Parse a `--lines` value: `12` or `12-14`.
 *
 * @returns The span, or null when it is not one or two positive integers.
 */
export function parseLineSpan(text: string): { startLine: number; endLine: number } | null {
	const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(text);
	if (!match) return null;
	const startLine = Number(match[1]);
	const endLine = match[2] ? Number(match[2]) : startLine;
	if (startLine < 1 || endLine < 1) return null;
	return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) };
}

/**
 * Validate a raw `diff_review_command` message.
 *
 * Runs in the main process, between a CLI that can be any version and a
 * renderer that must never be handed a half-formed request.
 */
export function parseDiffReviewCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: DiffReviewCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing diff review action. Must be one of: ${DIFF_REVIEW_COMMAND_ACTIONS.join(', ')}`,
		};
	}
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
	if (!sessionId) return { ok: false, error: `diff-review ${action} requires an agent` };

	if (action === 'add') {
		const path = typeof message.path === 'string' ? message.path.trim() : '';
		if (!path) return { ok: false, error: 'diff-review add requires a file path' };
		const startLine = positiveInt(message.startLine);
		if (!startLine) return { ok: false, error: 'diff-review add requires a line number' };
		const endLine = message.endLine === undefined ? startLine : positiveInt(message.endLine);
		if (!endLine) return { ok: false, error: 'diff-review add: invalid end line' };
		const side = message.side === undefined ? 'new' : message.side;
		if (side !== 'old' && side !== 'new') {
			return { ok: false, error: 'diff-review add: side must be old or new' };
		}
		const body = typeof message.body === 'string' ? message.body.trim() : '';
		if (!body) return { ok: false, error: 'A review comment needs some text' };
		return {
			ok: true,
			request: {
				action,
				sessionId,
				path,
				startLine: Math.min(startLine, endLine),
				endLine: Math.max(startLine, endLine),
				side,
				body,
			},
		};
	}

	if (action === 'remove') {
		const commentId = typeof message.commentId === 'string' ? message.commentId.trim() : '';
		if (!commentId) return { ok: false, error: 'diff-review remove requires a comment id' };
		return { ok: true, request: { action, sessionId, commentId } };
	}

	if (action === 'send') {
		return {
			ok: true,
			request: {
				action,
				sessionId,
				...(message.compose === true ? { compose: true } : {}),
				// Opt-in only: a literal `true`. See `readBackgroundField`.
				...(message.background === true ? { background: true } : {}),
			},
		};
	}

	return { ok: true, request: { action, sessionId } };
}

/**
 * Narrow whatever the renderer sent back to a result, so a malformed answer
 * becomes a failed command rather than a `success: undefined` the CLI reports
 * as done.
 */
export function normalizeDiffReviewCommandResult(raw: unknown): DiffReviewCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid diff review response' };
	}
	const candidate = raw as Partial<DiffReviewCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Diff review command failed',
			...(Array.isArray(candidate.outdated) ? { outdated: candidate.outdated } : {}),
		};
	}
	return {
		success: true,
		...(typeof candidate.cwd === 'string' ? { cwd: candidate.cwd } : {}),
		...(Array.isArray(candidate.comments) ? { comments: candidate.comments } : {}),
		...(candidate.comment ? { comment: candidate.comment } : {}),
		...(typeof candidate.cleared === 'number' ? { cleared: candidate.cleared } : {}),
		...(Array.isArray(candidate.delivered) ? { delivered: candidate.delivered } : {}),
		...(Array.isArray(candidate.outdated) ? { outdated: candidate.outdated } : {}),
		...(typeof candidate.prompt === 'string' ? { prompt: candidate.prompt } : {}),
	};
}
