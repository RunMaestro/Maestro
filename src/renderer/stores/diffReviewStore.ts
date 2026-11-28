/**
 * diffReviewStore - review comments left in the Git Diff viewer and not yet
 * sent (issue #1475).
 *
 * Comments are keyed by repo (`diffReviewKey`: the path, plus the SSH remote
 * it lives on, so two hosts with the same path never share a review), so
 * switching file tabs inside the viewer, or closing it with an Escape pressed
 * out of habit, does not throw away a half-written review: reopening the diff
 * for the same repo shows them again.
 *
 * The store's shape and rules are shared with the File Preview's review
 * (`fileReviewStore`); see `reviewCommentStore.ts`.
 */

import type { DiffComment, DiffCommentAnchor } from '../utils/diffReviewComments';
import {
	createReviewCommentStore,
	type ReviewCommentDraft,
	type ReviewCommentStore,
} from './reviewCommentStore';

/** A Git Diff comment box parked while the viewer is closed. */
export type DiffCommentDraft = ReviewCommentDraft<DiffCommentAnchor>;

export type DiffReviewStore = ReviewCommentStore<DiffComment, DiffCommentAnchor>;

/**
 * The key one repository's review is stored under. A local repo is its path;
 * a remote one is prefixed with its SSH remote id, because the same path on two
 * hosts is two different repositories.
 */
export function diffReviewKey(cwd: string, sshRemoteId?: string | null): string {
	return sshRemoteId ? `ssh:${sshRemoteId}|${cwd}` : cwd;
}

export const useDiffReviewStore = createReviewCommentStore<DiffComment, DiffCommentAnchor>();
