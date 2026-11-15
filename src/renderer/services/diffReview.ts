/**
 * diffReview - hand a review left in the Git Diff viewer to the agent the diff
 * was taken for (issue #1475), and the CLI half of the same thing
 * (`maestro-cli diff-review`).
 *
 * Two ways out, both self-sourcing from the stores so the viewer needs no
 * callbacks threaded through the modal host:
 *
 * - `sendDiffReview` QUEUES the review into the agent's AI tab through
 *   `enqueuePromptForTab`, the path the CLI's `dispatch --queue` and a snooze's
 *   wake prompt use. An idle agent runs it on the queue's next drain and a busy
 *   one when its turn ends, so a review never interrupts work in progress.
 * - `editDiffReviewInComposer` appends the review to that tab's draft through
 *   `insertIntoAgentComposer`, for a user who wants to reword it or add a note
 *   before it goes.
 *
 * `deliverDiffReview` is the one place a review leaves the store: it drops the
 * comments the current diff has outdated, formats the rest, hands them to one
 * of the two, and forgets only what was delivered. The viewer's buttons and the
 * CLI's `send` both go through it.
 *
 * From the viewer both land the user on the tab the review went to: sending a
 * review is asking to watch the agent act on it. A CLI caller passing
 * `--background` gets the same delivery with nothing moved.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { diffReviewKey, useDiffReviewStore } from '../stores/diffReviewStore';
import { enqueuePromptForTab } from './queuedPrompt';
import { insertIntoAgentComposer, resolveComposerTarget } from './quoteIntoComposer';
import { jumpToAgent } from './agentNavigation';
import { gitService } from './git';
import { resolveGitCwd, resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { parseGitDiff, type ParsedFileDiff } from '../utils/gitDiffParser';
import { generateId } from '../utils/ids';
import { isSameDirectory } from '../utils/agentWorkingDirectory';
import {
	anchorForLines,
	findOutdatedComments,
	formatCommentLocation,
	formatDiffReviewPrompt,
	type DiffComment,
} from '../utils/diffReviewComments';
import type {
	DiffReviewCommandRequest,
	DiffReviewCommandResult,
	DiffReviewCommentSummary,
} from '../../shared/diffReviewCommands';

/**
 * Whether an agent can receive a diff review. Terminal-only agents have no
 * conversation to send it to.
 */
export function canReceiveDiffReview(
	session: Pick<Session, 'toolType'> | null | undefined
): boolean {
	return !!session && session.toolType !== 'terminal';
}

/** How a review is handed over, and whether the user is taken to it. */
export interface DiffReviewDeliveryOptions {
	/** Write it and move nothing: no agent or tab switch, no flash. */
	background?: boolean;
}

/**
 * Queue `prompt` for the agent's AI tab and bring that tab on screen (inside
 * its tiled group when it is a pane of one).
 *
 * @returns `false` (and says why in a toast) when the agent or its AI tab no
 * longer exists, so the caller keeps the comments.
 */
export function sendDiffReview(
	sessionId: string,
	prompt: string,
	options: DiffReviewDeliveryOptions = {}
): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const target = session && canReceiveDiffReview(session) ? resolveComposerTarget(session) : null;
	const item = target
		? enqueuePromptForTab({ sessionId, tabId: target.tabId, text: prompt })
		: null;
	if (!session || !target || !item) {
		notifyToast({
			color: 'red',
			title: 'Review Not Sent',
			message: session
				? `${session.name} has no AI tab to receive the review. Your comments are kept.`
				: 'The agent this diff belongs to no longer exists. Your comments are kept.',
		});
		return false;
	}

	if (options.background) return true;
	jumpToAgent(sessionId, { tabId: item.tabId, stayInTiledGroup: true });
	notifyCenterFlash({
		message: `Review sent to ${session.name}`,
		detail: session.state === 'busy' ? 'Queued behind the current turn' : undefined,
		color: 'green',
	});
	return true;
}

/**
 * Put `prompt` in the agent's composer for editing instead of sending it.
 *
 * @returns `false` when there is no AI tab to put it in (the composer helper
 * toasts), so the caller keeps the comments.
 */
export function editDiffReviewInComposer(
	sessionId: string,
	prompt: string,
	options: DiffReviewDeliveryOptions = {}
): boolean {
	if (!prompt.trim()) return false;
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session || !canReceiveDiffReview(session)) {
		notifyToast({
			color: 'red',
			title: 'No Composer to Fill',
			message: 'The agent this diff belongs to cannot take a review. Your comments are kept.',
		});
		return false;
	}
	// The composer only renders for the active agent: switch first, then fill.
	// Land on the tab the review will go to, inside its tiled group if it is a
	// pane of one, so the switch does not undo the user's split.
	if (!options.background && useSessionStore.getState().activeSessionId !== sessionId) {
		const target = resolveComposerTarget(session);
		jumpToAgent(sessionId, target ? { tabId: target.tabId, stayInTiledGroup: true } : {});
	}
	return insertIntoAgentComposer(sessionId, prompt, options);
}

/** Which of the two ways out a delivery takes. */
export type DiffReviewDeliveryMode = 'send' | 'compose';

export type DiffReviewDeliveryResult =
	| { ok: true; delivered: DiffComment[]; outdated: DiffComment[]; prompt: string }
	| { ok: false; error: string; outdated: DiffComment[] };

/**
 * Deliver one repository's pending review against the diff as it is now.
 *
 * Comments the diff has outdated are left in the store, flagged in the tray,
 * and never sent. Only the comments actually delivered are removed, so a
 * failed delivery keeps everything.
 */
export function deliverDiffReview({
	sessionId,
	key,
	cwd,
	files,
	mode,
	background,
}: {
	sessionId: string;
	key: string;
	/** The directory the diff was taken in. */
	cwd: string;
	files: readonly ParsedFileDiff[];
	mode: DiffReviewDeliveryMode;
	background?: boolean;
}): DiffReviewDeliveryResult {
	const comments = useDiffReviewStore.getState().commentsByRepo[key] ?? [];
	const outdatedIds = findOutdatedComments(comments, files);
	const outdated = comments.filter((c) => outdatedIds.has(c.id));
	const current = comments.filter((c) => !outdatedIds.has(c.id) && c.body.trim());
	// The diff is taken where the agent's git view points (its terminal's cwd in
	// terminal mode); the agent itself runs in its own cwd. Name the repo when
	// those differ, so relative paths cannot land in the wrong one.
	const agentCwd = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.cwd;
	const repoDir = agentCwd !== undefined && !isSameDirectory(cwd, agentCwd) ? cwd : undefined;
	const prompt = formatDiffReviewPrompt(current, { repoDir });
	if (!prompt) {
		return {
			ok: false,
			outdated,
			error:
				outdated.length > 0
					? 'Every pending comment is outdated: its lines changed since it was written'
					: 'There are no comments to send',
		};
	}
	const deliver = mode === 'compose' ? editDiffReviewInComposer : sendDiffReview;
	if (!deliver(sessionId, prompt, { background })) {
		return { ok: false, outdated, error: 'The agent has no AI tab to receive the review' };
	}
	useDiffReviewStore.getState().removeComments(
		key,
		current.map((c) => c.id)
	);
	return { ok: true, delivered: current, outdated, prompt };
}

// ============================================================================
// CLI: `maestro-cli diff-review`
// ============================================================================

/**
 * The repository an agent's review is kept under: the same cwd and SSH remote
 * the Git Diff viewer is opened with (`useGitAgentActions.viewDiff`).
 */
function resolveReviewRepo(session: Session): { cwd: string; key: string; sshRemoteId?: string } {
	const cwd = resolveGitCwd(session);
	const sshRemoteId = resolveGitSshRemoteId(session);
	return { cwd, sshRemoteId, key: diffReviewKey(cwd, sshRemoteId) };
}

function summarize(comment: DiffComment, outdated: boolean): DiffReviewCommentSummary {
	return {
		id: comment.id,
		path: comment.path,
		side: comment.side,
		startLine: comment.startLine,
		endLine: comment.endLine,
		location: formatCommentLocation(comment),
		body: comment.body,
		outdated,
	};
}

/**
 * Answer one `diff-review` verb. Every verb reads and writes the same store the
 * viewer draws, so a comment added here appears in an open viewer, and `send`
 * is the viewer's own `deliverDiffReview`.
 */
export async function runRemoteDiffReviewCommand(
	request: DiffReviewCommandRequest
): Promise<DiffReviewCommandResult> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === request.sessionId);
	if (!session) return { success: false, error: `Agent not found: ${request.sessionId}` };
	if (!canReceiveDiffReview(session)) {
		return {
			success: false,
			error: `${session.name} is a terminal agent and cannot take a review`,
		};
	}
	const repo = resolveReviewRepo(session);
	const store = useDiffReviewStore.getState();
	const loadFiles = async () =>
		parseGitDiff((await gitService.getDiff(repo.cwd, undefined, repo.sshRemoteId)).diff);
	const listAgainst = (files: readonly ParsedFileDiff[]) => {
		const comments = useDiffReviewStore.getState().commentsByRepo[repo.key] ?? [];
		const outdated = findOutdatedComments(comments, files);
		return comments.map((c) => summarize(c, outdated.has(c.id)));
	};

	switch (request.action) {
		case 'list':
			return { success: true, cwd: repo.cwd, comments: listAgainst(await loadFiles()) };

		case 'add': {
			const files = await loadFiles();
			const resolved = anchorForLines(
				files,
				request.path!,
				request.side ?? 'new',
				request.startLine!,
				request.endLine ?? request.startLine!
			);
			if (!resolved.ok) return { success: false, error: resolved.error };
			const comment: DiffComment = { ...resolved.anchor, id: generateId(), body: request.body! };
			store.addComment(repo.key, comment);
			return { success: true, cwd: repo.cwd, comment: summarize(comment, false) };
		}

		case 'edit': {
			const existing = (store.commentsByRepo[repo.key] ?? []).find(
				(c) => c.id === request.commentId
			);
			if (!existing) return { success: false, error: `No pending comment ${request.commentId}` };
			// The tray does not edit an outdated comment either: its lines are gone,
			// so there is nothing to re-word it against.
			if (findOutdatedComments([existing], await loadFiles()).size > 0) {
				return {
					success: false,
					error: `${formatCommentLocation(existing)} is outdated (its lines changed); remove it and add a new comment`,
				};
			}
			store.updateComment(repo.key, existing.id, request.body!);
			return {
				success: true,
				cwd: repo.cwd,
				comment: summarize({ ...existing, body: request.body! }, false),
			};
		}

		case 'remove': {
			const existing = (store.commentsByRepo[repo.key] ?? []).find(
				(c) => c.id === request.commentId
			);
			if (!existing) return { success: false, error: `No pending comment ${request.commentId}` };
			store.removeComment(repo.key, existing.id);
			return { success: true, cwd: repo.cwd, comment: summarize(existing, false) };
		}

		case 'clear': {
			const count = (store.commentsByRepo[repo.key] ?? []).length;
			store.clearComments(repo.key);
			return { success: true, cwd: repo.cwd, cleared: count };
		}

		case 'send': {
			const files = await loadFiles();
			const result = deliverDiffReview({
				sessionId: session.id,
				key: repo.key,
				cwd: repo.cwd,
				files,
				mode: request.compose ? 'compose' : 'send',
				background: request.background,
			});
			const outdated = result.outdated.map((c) => summarize(c, true));
			if (!result.ok) return { success: false, error: result.error, outdated };
			return {
				success: true,
				cwd: repo.cwd,
				delivered: result.delivered.map((c) => summarize(c, false)),
				outdated,
				prompt: result.prompt,
			};
		}
	}
}
