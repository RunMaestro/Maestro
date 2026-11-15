import { describe, it, expect, beforeEach } from 'vitest';
import {
	diffReviewKey,
	useDiffReviewStore,
	selectRepoComments,
} from '../../../renderer/stores/diffReviewStore';
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
	beforeEach(() => useDiffReviewStore.setState({ commentsByRepo: {} }));

	it('keeps comments per repo through add, update, and remove', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.addComment('/repo', comment('2'));
		store.addComment('/other', comment('3'));
		store.updateComment('/repo', '1', 'edited');
		store.removeComment('/repo', '2');

		const state = useDiffReviewStore.getState();
		expect(selectRepoComments('/repo')(state).map((c) => [c.id, c.body])).toEqual([
			['1', 'edited'],
		]);
		expect(selectRepoComments('/other')(state)).toHaveLength(1);
	});

	it('forgets a repo once its last comment is gone, and returns a stable empty list', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.clearComments('/repo');
		const state = useDiffReviewStore.getState();
		expect(state.commentsByRepo).toEqual({});
		expect(selectRepoComments('/repo')(state)).toBe(selectRepoComments('/nope')(state));
	});

	it('removeComments drops only the named ones (what a send delivered)', () => {
		const store = useDiffReviewStore.getState();
		store.addComment('/repo', comment('1'));
		store.addComment('/repo', comment('2'));
		store.removeComments('/repo', ['1']);
		expect(selectRepoComments('/repo')(useDiffReviewStore.getState()).map((c) => c.id)).toEqual([
			'2',
		]);
	});

	it('keys a remote repo by its SSH remote too, so two hosts never share a review', () => {
		expect(diffReviewKey('/home/u/p')).toBe('/home/u/p');
		expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p', 'host-b'));
		expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p'));
	});
});
