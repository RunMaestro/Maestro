import { describe, it, expect, beforeEach } from 'vitest';
import { diffReviewKey, useDiffReviewStore } from '../../../renderer/stores/diffReviewStore';
import { selectReviewComments } from '../../../renderer/stores/reviewCommentStore';
import type { DiffComment } from '../../../renderer/utils/diffReviewComments';

function comment(id: string, body = 'note'): DiffComment {
	return {
		id,
		file: 'a.ts',
		side: 'new',
		startLine: 1,
		endLine: 1,
		changeKeys: ['I1'],
		context: '@@ -0,0 +1 @@\n+x',
		body,
	};
}

describe('diffReviewStore', () => {
	beforeEach(() => useDiffReviewStore.setState({ commentsByKey: {}, draftsByKey: {} }));

	it('keeps comments per repo through add, update, and remove', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.addComment('/repo', comment('2'));
		store.addComment('/other', comment('3'));
		store.updateComment('/repo', '1', 'edited');
		store.removeComment('/repo', '2');

		const state = useDiffReviewStore.getState();
		expect(selectReviewComments('/repo')(state).map((c) => [c.id, c.body])).toEqual([
			['1', 'edited'],
		]);
		expect(selectReviewComments('/other')(state)).toHaveLength(1);
	});

	it('forgets a repo once its last comment is gone, and returns a stable empty list', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.clearComments('/repo');
		const state = useDiffReviewStore.getState();
		expect(state.commentsByKey).toEqual({});
		expect(selectReviewComments('/repo')(state)).toBe(selectReviewComments('/nope')(state));
	});

	it('removeComments drops only the named ones (what a send delivered)', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.addComment('/repo', comment('2'));
		store.removeComments('/repo', ['1']);
		expect(selectReviewComments('/repo')(useDiffReviewStore.getState()).map((c) => c.id)).toEqual([
			'2',
		]);
	});

	it('keys a remote repo by its SSH remote too, so two hosts never share a review', () => {
		expect(diffReviewKey('/home/u/p')).toBe('/home/u/p');
		expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p', 'host-b'));
		expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p'));
	});

	it('parks one comment box per repo and hands it back once', () => {
		const store = useDiffReviewStore.getState();
		const draft = { anchor: comment('x'), initialBody: '', body: 'half' };
		store.parkDraft('/repo', draft);
		expect(useDiffReviewStore.getState().takeDraft('/repo')).toEqual(draft);
		expect(useDiffReviewStore.getState().takeDraft('/repo')).toBeUndefined();
	});

	it('discarding a review also forgets its parked box', () => {
		const store = useDiffReviewStore.getState();
		store.parkDraft('/repo', { anchor: comment('x'), initialBody: '', body: 'half' });
		store.clearComments('/repo');
		expect(useDiffReviewStore.getState().draftsByKey).toEqual({});
	});
});
