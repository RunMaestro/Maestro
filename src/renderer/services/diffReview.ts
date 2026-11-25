/**
 * diffReview - hand a review left in the Git Diff viewer to the agent the diff
 * was taken for (issue #1475), and the CLI half of the same thing
 * (`maestro-cli diff-review`).
 *
 * `deliverDiffReview` is the one place a review leaves the store: it drops the
 * comments the current diff has outdated, formats the rest, hands them to one
 * of the two ways out in `reviewDelivery.ts` (queue it, or put it in the
 * composer), and forgets only what was delivered. The viewer's buttons and the
 * CLI's `send` both go through it.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { diffReviewKey, useDiffReviewStore } from '../stores/diffReviewStore';
import {
	canReceiveReview,
	deliverPendingReview,
	type ReviewDeliveryMode,
	type ReviewDeliveryResult,
} from './reviewDelivery';
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

/** Which of the two ways out a delivery takes. */
export type DiffReviewDeliveryMode = ReviewDeliveryMode;

export type DiffReviewDeliveryResult = ReviewDeliveryResult<DiffComment>;

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
	const comments = useDiffReviewStore.getState().commentsByKey[key] ?? [];
	// The diff is taken where the agent's git view points (its terminal's cwd in
	// terminal mode); the agent itself runs in its own cwd. Name the repo when
	// those differ, so relative paths cannot land in the wrong one.
	const agentCwd = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.cwd;
	const repoDir = agentCwd !== undefined && !isSameDirectory(cwd, agentCwd) ? cwd : undefined;
	return deliverPendingReview({
		sessionId,
		comments,
		outdatedIds: findOutdatedComments(comments, files),
		formatPrompt: (current) => formatDiffReviewPrompt(current, { repoDir }),
		forget: (ids) => useDiffReviewStore.getState().removeComments(key, ids),
		mode,
		background,
	});
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
	if (!canReceiveReview(session)) {
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
		const comments = useDiffReviewStore.getState().commentsByKey[repo.key] ?? [];
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
			const pending = () =>
				(useDiffReviewStore.getState().commentsByKey[repo.key] ?? []).find(
					(c) => c.id === request.commentId
				);
			const missing = { success: false, error: `No pending comment ${request.commentId}` };
			if (!pending()) return missing;
			const files = await loadFiles();
			// Read it again: the viewer may have sent or removed it while git diff
			// ran, and an edit to a comment that is gone must not report success.
			const existing = pending();
			if (!existing) return missing;
			// The tray does not edit an outdated comment either: its lines are gone,
			// so there is nothing to re-word it against.
			if (findOutdatedComments([existing], files).size > 0) {
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
			const existing = (store.commentsByKey[repo.key] ?? []).find(
				(c) => c.id === request.commentId
			);
			if (!existing) return { success: false, error: `No pending comment ${request.commentId}` };
			store.removeComment(repo.key, existing.id);
			return { success: true, cwd: repo.cwd, comment: summarize(existing, false) };
		}

		case 'clear': {
			const count = (store.commentsByKey[repo.key] ?? []).length;
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
