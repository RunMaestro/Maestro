/**
 * reviewCommentStore - the one shape every "pin comments to lines, then send
 * them as one review" surface keeps its pending comments in.
 *
 * Two surfaces use it: the Git Diff viewer (`diffReviewStore`, keyed by repo)
 * and the File Preview (`fileReviewStore`, keyed by agent + file). Each gets
 * its own store instance from {@link createReviewCommentStore}, so the two
 * reviews never mix, while the add / edit / remove / discard / park-a-draft
 * rules are written once.
 *
 * The view is a VIEW over its store, not the owner of the review: closing it,
 * or switching tabs inside it, does not throw away a half-written review.
 * Comments leave the store only when the review is sent or discarded.
 *
 * Memory only. A review is a few minutes of work against text that will not
 * look the same after a restart, so there is nothing worth persisting.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

/** What every review comment has, whatever it is pinned to. */
export interface ReviewCommentBase {
	id: string;
	/** The reviewer's comment. Markdown allowed. */
	body: string;
}

/**
 * A comment box that was open, with text in it, when its view closed. Put back
 * on its lines when the same review is opened again.
 */
export interface ReviewCommentDraft<A> {
	anchor: A;
	/** Set when the box was editing a saved comment. */
	id?: string;
	/** What the box opened with (the saved text, for an edit). */
	initialBody: string;
	/** What was typed. */
	body: string;
}

interface ReviewCommentState<C, A> {
	commentsByKey: Record<string, C[]>;
	draftsByKey: Record<string, ReviewCommentDraft<A>>;
	/**
	 * How many times each review was discarded. An open view watches it so a
	 * discard from elsewhere (the CLI's `clear`) also closes its comment box,
	 * instead of the box being parked again on close.
	 */
	discardsByKey: Record<string, number>;
}

interface ReviewCommentActions<C, A> {
	addComment: (key: string, comment: C) => void;
	updateComment: (key: string, id: string, body: string) => void;
	removeComment: (key: string, id: string) => void;
	/** Forget these comments (the ones a review just delivered). */
	removeComments: (key: string, ids: readonly string[]) => void;
	/** Forget every comment of this review (discarded). */
	clearComments: (key: string) => void;
	/** Keep the open comment box of this review while its view is closed. */
	parkDraft: (key: string, draft: ReviewCommentDraft<A>) => void;
	/** Hand back (and forget) the parked comment box of this review, if any. */
	takeDraft: (key: string) => ReviewCommentDraft<A> | undefined;
}

export type ReviewCommentStore<C extends ReviewCommentBase, A> = ReviewCommentState<C, A> &
	ReviewCommentActions<C, A>;

export type ReviewCommentStoreHook<C extends ReviewCommentBase, A> = UseBoundStore<
	StoreApi<ReviewCommentStore<C, A>>
>;

const NO_COMMENTS: never[] = [];

/** A fresh, empty review store for one kind of comment. */
export function createReviewCommentStore<C extends ReviewCommentBase, A>(): ReviewCommentStoreHook<
	C,
	A
> {
	type State = ReviewCommentState<C, A>;

	const withKey = (state: State, key: string, next: C[]): Pick<State, 'commentsByKey'> => {
		const commentsByKey = { ...state.commentsByKey };
		if (next.length === 0) delete commentsByKey[key];
		else commentsByKey[key] = next;
		return { commentsByKey };
	};

	return create<ReviewCommentStore<C, A>>()((set, get) => ({
		commentsByKey: {},
		draftsByKey: {},
		discardsByKey: {},

		addComment: (key, comment) =>
			set((state) => withKey(state, key, [...(state.commentsByKey[key] ?? []), comment])),

		updateComment: (key, id, body) =>
			set((state) =>
				withKey(
					state,
					key,
					(state.commentsByKey[key] ?? []).map((c) => (c.id === id ? { ...c, body } : c))
				)
			),

		removeComment: (key, id) =>
			set((state) =>
				withKey(
					state,
					key,
					(state.commentsByKey[key] ?? []).filter((c) => c.id !== id)
				)
			),

		removeComments: (key, ids) =>
			set((state) =>
				withKey(
					state,
					key,
					(state.commentsByKey[key] ?? []).filter((c) => !ids.includes(c.id))
				)
			),

		clearComments: (key) =>
			set((state) => {
				const { [key]: _dropped, ...draftsByKey } = state.draftsByKey;
				const discardsByKey = {
					...state.discardsByKey,
					[key]: (state.discardsByKey[key] ?? 0) + 1,
				};
				return { ...withKey(state, key, []), draftsByKey, discardsByKey };
			}),

		parkDraft: (key, draft) =>
			set((state) => ({ draftsByKey: { ...state.draftsByKey, [key]: draft } })),

		takeDraft: (key) => {
			const draft = get().draftsByKey[key];
			if (draft) {
				set((state) => {
					const { [key]: _taken, ...draftsByKey } = state.draftsByKey;
					return { draftsByKey };
				});
			}
			return draft;
		},
	}));
}

/** The pending comments of one review. Stable empty array when there are none. */
export const selectReviewComments =
	(key: string) =>
	<C extends ReviewCommentBase>(state: { commentsByKey: Record<string, C[]> }): C[] =>
		state.commentsByKey[key] ?? (NO_COMMENTS as C[]);
