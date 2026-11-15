// Diff review commands - the CLI half of the Git Diff viewer's review comments.
// A comment is pinned to lines of the agent's current `git diff`; `send` hands
// every current comment to the agent as one prompt, each with its path:lines
// and the hunk it was left on, through the same code the viewer's Send Review
// button runs.
//
// Every verb rides the one `diff_review_command` message. The pending comments
// are held by the desktop renderer (the viewer draws them), so these fail with
// the usual "not running" error when the app is down.

import { failCommand, resolveAgentOrFail } from '../services/session-command';
import { withMaestroClient } from '../services/maestro-client';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
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
 * `add`, `list` and `send` run `git diff` on the desktop side (over SSH for a
 * remote agent) before answering, so allow more than the 10s default.
 */
const DIFF_REVIEW_TIMEOUT_MS = 35_000;

/** Send one diff review verb and hand back the desktop's answer. */
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
	if (!result.success) failCommand(result.error || 'Diff review command failed', json);
	return result;
}

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, ' / ');
}

function describe(comment: DiffReviewCommentSummary): string {
	const flag = comment.outdated ? '  [outdated, will not be sent]' : '';
	return `  ${comment.id}  ${comment.location}${flag}\n      ${oneLine(comment.body)}`;
}

/** `maestro-cli diff-review list -a <agent>` - the comments waiting to be sent. */
export async function diffReviewList(options: DiffReviewOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview({ action: 'list', sessionId }, options.json);
	const comments = result.comments ?? [];
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, cwd: result.cwd, comments }, null, 2));
		return;
	}
	if (comments.length === 0) {
		console.log(`No pending review comments for ${result.cwd ?? sessionId}.`);
		return;
	}
	console.log(`Pending review comments for ${result.cwd ?? sessionId} (${comments.length}):`);
	for (const comment of comments) console.log(describe(comment));
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
	const sessionId = resolveAgentOrFail(options.agent, options.json);

	const result = await sendDiffReview(
		{
			action: 'add',
			sessionId,
			path: path.trim(),
			startLine: span!.startLine,
			endLine: span!.endLine,
			side,
			body,
		},
		options.json
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, comment: result.comment }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(formatSuccess(`Comment added on ${result.comment?.location ?? path}`));
	if (result.comment) console.log(`  Comment: ${result.comment.id}`);
}

/** `maestro-cli diff-review remove <comment-id> -a <agent>`. Accepts a unique id prefix. */
export async function diffReviewRemove(
	commentId: string,
	options: DiffReviewOptions
): Promise<void> {
	const wanted = (commentId ?? '').trim();
	if (!wanted) failCommand('A comment id is required', options.json);
	const sessionId = resolveAgentOrFail(options.agent, options.json);

	const listed = await sendDiffReview({ action: 'list', sessionId }, options.json);
	const comments = listed.comments ?? [];
	const exact = comments.find((c) => c.id === wanted);
	const matches = exact ? [exact] : comments.filter((c) => c.id.startsWith(wanted));
	if (matches.length > 1) {
		failCommand(`Ambiguous comment id '${wanted}' (${matches.length} matches)`, options.json);
	}
	const result = await sendDiffReview(
		{ action: 'remove', sessionId, commentId: matches[0]?.id ?? wanted },
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
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview({ action: 'clear', sessionId }, options.json);
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
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const result = await sendDiffReview(
		{
			action: 'send',
			sessionId,
			...(options.compose ? { compose: true } : {}),
			background: resolveBackgroundFlag(options, 'diff-review-send'),
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
