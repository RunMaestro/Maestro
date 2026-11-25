// Review commands - the CLI half of the line review comments the desktop app
// collects in two places:
//
//  - `diff-review`: comments pinned to lines of the agent's current `git diff`
//    (the Git Diff viewer's Review tray).
//  - `file-review`: comments pinned to lines of one file (the File Preview's
//    Review tray, opened from "Comment on line" on its right-click menu).
//
// `send` hands every current comment to the agent as one prompt, each with its
// path:lines and the text it was left on, through the same code the tray's
// Send Review button runs. The two families are the same verbs with a
// different target, so each verb below is written once and takes the target.
//
// Every verb rides the one `diff_review_command` message (a file review names
// its `file`). The pending comments are held by the desktop renderer (the
// views draw them), so these fail with the usual "not running" error when the
// app is down.

import { failCommand, resolveAgentOrFail } from '../services/session-command';
import { withMaestroClient } from '../services/maestro-client';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { resolveAgentCwdArg } from '../utils/parse';
import {
	parseLineSpan,
	type DiffReviewCommandRequest,
	type DiffReviewCommandResult,
	type DiffReviewCommentSummary,
} from '../../shared/diffReviewCommands';

export interface DiffReviewOptions {
	agent: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

export interface DiffReviewAddOptions extends DiffReviewOptions {
	side?: string;
}

export interface DiffReviewSendOptions extends DiffReviewOptions {
	compose?: boolean;
}

/**
 * `add`, `list` and `send` run `git diff` (or read the file) on the desktop
 * side, over SSH for a remote agent, before answering, so allow more than the
 * 10s default.
 */
const DIFF_REVIEW_TIMEOUT_MS = 35_000;

/**
 * Which review a verb acts on: the agent's git diff (no `file`), or the line
 * comments of one file.
 */
interface ReviewTarget {
	file?: string;
}

const DIFF_TARGET: ReviewTarget = {};

/**
 * A file the user named, made absolute against the shell's directory. A POSIX
 * absolute path is kept as typed, because it may name a file on an SSH remote.
 */
function fileTarget(file: string, json?: boolean): ReviewTarget {
	const trimmed = (file ?? '').trim();
	if (!trimmed) failCommand('A file path is required', json);
	return { file: resolveAgentCwdArg(trimmed) };
}

/** What a target is called in output: the file, else the repository. */
function targetLabel(target: ReviewTarget, result: DiffReviewCommandResult, sessionId: string) {
	return target.file ? (result.file ?? target.file) : (result.cwd ?? sessionId);
}

/** Send one review verb and hand back the desktop's answer. */
async function sendDiffReview(
	request: DiffReviewCommandRequest,
	json?: boolean
): Promise<DiffReviewCommandResult> {
	let result: DiffReviewCommandResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<DiffReviewCommandResult>(
				{ type: 'diff_review_command', ...request },
				'diff_review_command_result',
				DIFF_REVIEW_TIMEOUT_MS
			)
		);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (!result.success) failCommand(result.error || 'Review command failed', json);
	return result;
}

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, ' / ');
}

function describe(comment: DiffReviewCommentSummary): string {
	const flag = comment.outdated ? '  [outdated, will not be sent]' : '';
	return `  ${comment.id}  ${comment.location}${flag}\n      ${oneLine(comment.body)}`;
}

async function listReview(target: ReviewTarget, options: DiffReviewOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview({ action: 'list', sessionId, ...target }, options.json);
	const comments = result.comments ?? [];
	if (options.json) {
		const where = target.file ? { file: result.file } : { cwd: result.cwd };
		console.log(JSON.stringify({ success: true, sessionId, ...where, comments }, null, 2));
		return;
	}
	const label = targetLabel(target, result, sessionId);
	if (comments.length === 0) {
		console.log(`No pending review comments for ${label}.`);
		return;
	}
	console.log(`Pending review comments for ${label} (${comments.length}):`);
	for (const comment of comments) console.log(describe(comment));
}

/** `maestro-cli diff-review list -a <agent>` - the comments waiting to be sent. */
export async function diffReviewList(options: DiffReviewOptions): Promise<void> {
	return listReview(DIFF_TARGET, options);
}

/** `maestro-cli file-review list <file> -a <agent>` - the comments waiting to be sent. */
export async function fileReviewList(file: string, options: DiffReviewOptions): Promise<void> {
	return listReview(fileTarget(file, options.json), options);
}

/**
 * `maestro-cli diff-review add <path> <lines> <comment> -a <agent>` - pin a
 * comment to `path:lines` of the agent's current diff. `lines` is `12` or
 * `12-14`; `--side old` numbers them in the previous version (removed lines).
 */
export async function diffReviewAdd(
	path: string,
	lines: string,
	comment: string,
	options: DiffReviewAddOptions
): Promise<void> {
	const span = parseLineSpan(lines ?? '');
	if (!span) failCommand(`Invalid line span '${lines}': use 12 or 12-14`, options.json);
	const side = options.side ?? 'new';
	if (side !== 'old' && side !== 'new') {
		failCommand(`Invalid --side '${side}': use old or new`, options.json);
	}
	const body = (comment ?? '').trim();
	if (!body) failCommand('A review comment needs some text', options.json);
	await addComment(
		DIFF_TARGET,
		{ path: path.trim(), side, startLine: span!.startLine, endLine: span!.endLine, body },
		options
	);
}

/**
 * `maestro-cli file-review add <file> <lines> <comment> -a <agent>` - pin a
 * comment to lines of a file, as "Comment on line" in the File Preview does.
 * `lines` is `12` or `12-14`; the lines are quoted from the file on disk.
 */
export async function fileReviewAdd(
	file: string,
	lines: string,
	comment: string,
	options: DiffReviewOptions
): Promise<void> {
	const span = parseLineSpan(lines ?? '');
	if (!span) failCommand(`Invalid line span '${lines}': use 12 or 12-14`, options.json);
	const body = (comment ?? '').trim();
	if (!body) failCommand('A review comment needs some text', options.json);
	const target = fileTarget(file, options.json);
	await addComment(target, { startLine: span!.startLine, endLine: span!.endLine, body }, options);
}

async function addComment(
	target: ReviewTarget,
	fields: Pick<DiffReviewCommandRequest, 'path' | 'side' | 'startLine' | 'endLine' | 'body'>,
	options: DiffReviewOptions
): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview(
		{ action: 'add', sessionId, ...target, ...fields },
		options.json
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, comment: result.comment }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(
		formatSuccess(`Comment added on ${result.comment?.location ?? fields.path ?? target.file}`)
	);
	if (result.comment) console.log(`  Comment: ${result.comment.id}`);
}

/** Resolve a comment id or unique prefix against the pending list. */
async function resolveCommentId(
	sessionId: string,
	target: ReviewTarget,
	wanted: string,
	json?: boolean
): Promise<string> {
	const listed = await sendDiffReview({ action: 'list', sessionId, ...target }, json);
	const comments = listed.comments ?? [];
	const exact = comments.find((c) => c.id === wanted);
	const matches = exact ? [exact] : comments.filter((c) => c.id.startsWith(wanted));
	if (matches.length > 1) {
		failCommand(`Ambiguous comment id '${wanted}' (${matches.length} matches)`, json);
	}
	// An id that matches nothing is still sent: the desktop says it is gone.
	return matches[0]?.id ?? wanted;
}

/**
 * `maestro-cli diff-review edit <comment-id> <comment> -a <agent>` - reword a
 * pending comment in place, keeping its id and the lines it is pinned to.
 * Accepts a unique id prefix.
 */
export async function diffReviewEdit(
	commentId: string,
	comment: string,
	options: DiffReviewOptions
): Promise<void> {
	return editComment(DIFF_TARGET, commentId, comment, options);
}

/** `maestro-cli file-review edit <file> <comment-id> <comment> -a <agent>`. */
export async function fileReviewEdit(
	file: string,
	commentId: string,
	comment: string,
	options: DiffReviewOptions
): Promise<void> {
	return editComment(fileTarget(file, options.json), commentId, comment, options);
}

async function editComment(
	target: ReviewTarget,
	commentId: string,
	comment: string,
	options: DiffReviewOptions
): Promise<void> {
	const wanted = (commentId ?? '').trim();
	if (!wanted) failCommand('A comment id is required', options.json);
	const body = (comment ?? '').trim();
	if (!body) failCommand('A review comment needs some text', options.json);
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const id = await resolveCommentId(sessionId, target, wanted, options.json);
	const result = await sendDiffReview(
		{ action: 'edit', sessionId, ...target, commentId: id, body },
		options.json
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, comment: result.comment }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Updated comment on ${result.comment?.location ?? id}`));
}

/** `maestro-cli diff-review remove <comment-id> -a <agent>`. Accepts a unique id prefix. */
export async function diffReviewRemove(
	commentId: string,
	options: DiffReviewOptions
): Promise<void> {
	return removeComment(DIFF_TARGET, commentId, options);
}

/** `maestro-cli file-review remove <file> <comment-id> -a <agent>`. Accepts a unique id prefix. */
export async function fileReviewRemove(
	file: string,
	commentId: string,
	options: DiffReviewOptions
): Promise<void> {
	return removeComment(fileTarget(file, options.json), commentId, options);
}

async function removeComment(
	target: ReviewTarget,
	commentId: string,
	options: DiffReviewOptions
): Promise<void> {
	const wanted = (commentId ?? '').trim();
	if (!wanted) failCommand('A comment id is required', options.json);
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const id = await resolveCommentId(sessionId, target, wanted, options.json);
	const result = await sendDiffReview(
		{ action: 'remove', sessionId, ...target, commentId: id },
		options.json
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, comment: result.comment }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Removed comment on ${result.comment?.location ?? wanted}`));
}

/** `maestro-cli diff-review clear -a <agent>` - discard the whole pending review. */
export async function diffReviewClear(options: DiffReviewOptions): Promise<void> {
	return clearReview(DIFF_TARGET, options);
}

/** `maestro-cli file-review clear <file> -a <agent>` - discard the file's pending review. */
export async function fileReviewClear(file: string, options: DiffReviewOptions): Promise<void> {
	return clearReview(fileTarget(file, options.json), options);
}

async function clearReview(target: ReviewTarget, options: DiffReviewOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview({ action: 'clear', sessionId, ...target }, options.json);
	const cleared = result.cleared ?? 0;
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, cleared }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Discarded ${cleared} review comment${cleared === 1 ? '' : 's'}`));
}

/**
 * `maestro-cli diff-review send -a <agent>` - send every current comment as one
 * prompt, queued behind the agent's running turn. `--compose` puts it in the
 * agent's message box instead. Outdated comments stay pending and are listed.
 *
 * Background by default, as an agent calling this is not the human looking at
 * the screen; `--focus` takes the user to the agent the way the button does.
 */
export async function diffReviewSend(options: DiffReviewSendOptions): Promise<void> {
	return sendReview(DIFF_TARGET, options);
}

/**
 * `maestro-cli file-review send <file> -a <agent>` - send the file's current
 * comments as one prompt. Same delivery and placement rules as `diff-review send`.
 */
export async function fileReviewSend(file: string, options: DiffReviewSendOptions): Promise<void> {
	return sendReview(fileTarget(file, options.json), options);
}

async function sendReview(target: ReviewTarget, options: DiffReviewSendOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview(
		{
			action: 'send',
			sessionId,
			...target,
			...(options.compose ? { compose: true } : {}),
			background: resolveBackgroundFlag(
				options,
				target.file ? 'file-review-send' : 'diff-review-send'
			),
		},
		options.json
	);
	const delivered = result.delivered ?? [];
	const outdated = result.outdated ?? [];
	if (options.json) {
		console.log(
			JSON.stringify(
				{ success: true, sessionId, delivered, outdated, prompt: result.prompt },
				null,
				2
			)
		);
		return;
	}
	if (isQuiet()) return;
	const n = `${delivered.length} comment${delivered.length === 1 ? '' : 's'}`;
	console.log(
		formatSuccess(
			options.compose
				? `Review (${n}) placed in ${sessionId}'s message box`
				: `Review (${n}) queued for ${sessionId}`
		)
	);
	if (outdated.length > 0) {
		console.log(`Not sent, lines changed since they were written (${outdated.length}):`);
		for (const comment of outdated) console.log(describe(comment));
	}
}
