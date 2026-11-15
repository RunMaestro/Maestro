/**
 * diffReviewStore - review comments left in the Git Diff viewer and not yet
 * sent (issue #1475).
 *
 * The viewer is a VIEW over this store, not the owner of the review. Comments
 * are keyed by repo (`diffReviewKey`: the path, plus the SSH remote it lives
 * on, so two hosts with the same path never share a review), so switching file tabs inside the viewer, or closing
 * it with an Escape pressed out of habit, does not throw away a half-written
 * review: reopening the diff for the same repo shows them again. They leave the
 * store only when the review is sent or the user discards it.
 *
 * Memory only. A review is a few minutes of work against a diff that will not
 * look the same after a restart, so there is nothing worth persisting.
 */

import { create } from 'zustand';
import type { DiffComment, DiffCommentAnchor } from '../utils/diffReviewComments';

/**
 * A comment box that was open, with text in it, when the viewer closed. Put
 * back on its lines when the diff for the same repository is opened again.
 */
export interface DiffCommentDraft {
	anchor: DiffCommentAnchor;
	/** Set when the box was editing a saved comment. */
	id?: string;
	/** What the box opened with (the saved text, for an edit). */
	initialBody: string;
	/** What was typed. */
	body: string;
}

interface DiffReviewState {
	commentsByRepo: Record<string, DiffComment[]>;
	draftsByRepo: Record<string, DiffCommentDraft>;
}

interface DiffReviewActions {
	addComment: (repo: string, comment: DiffComment) => void;
	updateComment: (repo: string, id: string, body: string) => void;
	removeComment: (repo: string, id: string) => void;
	/** Forget these comments (the ones a review just delivered). */
	removeComments: (repo: string, ids: readonly string[]) => void;
	/** Forget every comment for this repo (discarded). */
	clearComments: (repo: string) => void;
	/** Keep the open comment box for this repo while the viewer is closed. */
	parkDraft: (repo: string, draft: DiffCommentDraft) => void;
	/** Hand back (and forget) the parked comment box for this repo, if any. */
	takeDraft: (repo: string) => DiffCommentDraft | undefined;
}

export type DiffReviewStore = DiffReviewState & DiffReviewActions;

const NO_COMMENTS: DiffComment[] = [];

/**
 * The key one repository's review is stored under. A local repo is its path;
 * a remote one is prefixed with its SSH remote id, because the same path on two
 * hosts is two different repositories.
 */
export function diffReviewKey(cwd: string, sshRemoteId?: string | null): string {
	return sshRemoteId ? `ssh:${sshRemoteId}|${cwd}` : cwd;
}

function withRepo(
	state: DiffReviewState,
	repo: string,
	next: DiffComment[]
): Pick<DiffReviewState, 'commentsByRepo'> {
	const commentsByRepo = { ...state.commentsByRepo };
	if (next.length === 0) delete commentsByRepo[repo];
	else commentsByRepo[repo] = next;
	return { commentsByRepo };
}

export const useDiffReviewStore = create<DiffReviewStore>()((set, get) => ({
	commentsByRepo: {},
	draftsByRepo: {},

	addComment: (repo, comment) =>
		set((state) => withRepo(state, repo, [...(state.commentsByRepo[repo] ?? []), comment])),

	updateComment: (repo, id, body) =>
		set((state) =>
			withRepo(
				state,
				repo,
				(state.commentsByRepo[repo] ?? []).map((c) => (c.id === id ? { ...c, body } : c))
			)
		),

	removeComment: (repo, id) =>
		set((state) =>
			withRepo(
				state,
				repo,
				(state.commentsByRepo[repo] ?? []).filter((c) => c.id !== id)
			)
		),

	removeComments: (repo, ids) =>
		set((state) =>
			withRepo(
				state,
				repo,
				(state.commentsByRepo[repo] ?? []).filter((c) => !ids.includes(c.id))
			)
		),

	clearComments: (repo) =>
		set((state) => {
			const { [repo]: _dropped, ...draftsByRepo } = state.draftsByRepo;
			return { ...withRepo(state, repo, []), draftsByRepo };
		}),

	parkDraft: (repo, draft) =>
		set((state) => ({ draftsByRepo: { ...state.draftsByRepo, [repo]: draft } })),

	takeDraft: (repo) => {
		const draft = get().draftsByRepo[repo];
		if (draft) {
			set((state) => {
				const { [repo]: _taken, ...draftsByRepo } = state.draftsByRepo;
				return { draftsByRepo };
			});
		}
		return draft;
	},
}));

/** The pending comments for one repo. Stable empty array when there are none. */
export const selectRepoComments =
	(repo: string) =>
	(state: DiffReviewStore): DiffComment[] =>
		state.commentsByRepo[repo] ?? NO_COMMENTS;
