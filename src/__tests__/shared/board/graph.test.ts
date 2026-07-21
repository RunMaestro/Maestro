/**
 * @file graph.test.ts
 * @description Tests for the Board DAG helpers: eligibility, blockers, and
 * cycle detection. These are the functions the Phase 3 dispatcher relies on,
 * so they are exercised thoroughly here.
 */

import { describe, it, expect } from 'vitest';
import { getEligibleCards, getBlockers, hasCycle } from '../../../shared/board/graph';
import type { Board, BoardCard, CardStatus } from '../../../shared/board/types';

function card(overrides: Partial<BoardCard> & { id: string }): BoardCard {
	return {
		title: `Card ${overrides.id}`,
		body: '',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo' as CardStatus,
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		...overrides,
	};
}

function board(cards: BoardCard[]): Board {
	return { id: 'b1', name: 'Test board', cards };
}

describe('getEligibleCards', () => {
	it('returns todo cards with no parents', () => {
		const b = board([card({ id: 'a' }), card({ id: 'b' })]);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('excludes a card whose parent is not done', () => {
		const b = board([card({ id: 'a', status: 'todo' }), card({ id: 'c', parents: ['a'] })]);
		// a is eligible (no parents), c is not (a not done).
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['a']);
	});

	it('includes a card once every parent is done', () => {
		const b = board([
			card({ id: 'a', status: 'done' }),
			card({ id: 'b', status: 'done' }),
			card({ id: 'c', parents: ['a', 'b'] }),
		]);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['c']);
	});

	it('excludes a card when only some parents are done', () => {
		const b = board([
			card({ id: 'a', status: 'done' }),
			card({ id: 'b', status: 'running' }),
			card({ id: 'c', parents: ['a', 'b'] }),
		]);
		expect(getEligibleCards(b)).toEqual([]);
	});

	it('only considers todo cards, not ready/running/blocked/done/triage', () => {
		const statuses: CardStatus[] = ['ready', 'running', 'blocked', 'done', 'triage'];
		const b = board(statuses.map((s, i) => card({ id: `x${i}`, status: s })));
		expect(getEligibleCards(b)).toEqual([]);
	});

	it('treats a missing parent id as a blocker (not eligible)', () => {
		const b = board([card({ id: 'c', parents: ['ghost'] })]);
		expect(getEligibleCards(b)).toEqual([]);
	});

	it('preserves board card order in the result', () => {
		const b = board([card({ id: 'z' }), card({ id: 'a' }), card({ id: 'm' })]);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['z', 'a', 'm']);
	});
});

describe('getBlockers', () => {
	it('returns an empty array when all parents are done', () => {
		const b = board([card({ id: 'a', status: 'done' }), card({ id: 'c', parents: ['a'] })]);
		const c = b.cards.find((x) => x.id === 'c')!;
		expect(getBlockers(c, b)).toEqual([]);
	});

	it('returns only the not-done parents, in order', () => {
		const b = board([
			card({ id: 'a', status: 'done' }),
			card({ id: 'b', status: 'todo' }),
			card({ id: 'c', parents: ['a', 'b'] }),
		]);
		const c = b.cards.find((x) => x.id === 'c')!;
		expect(getBlockers(c, b)).toEqual(['b']);
	});

	it('counts a missing parent id as a blocker', () => {
		const b = board([
			card({ id: 'c', parents: ['ghost', 'a'] }),
			card({ id: 'a', status: 'done' }),
		]);
		const c = b.cards.find((x) => x.id === 'c')!;
		expect(getBlockers(c, b)).toEqual(['ghost']);
	});
});

describe('hasCycle', () => {
	it('returns false for an acyclic DAG', () => {
		const b = board([
			card({ id: 'a' }),
			card({ id: 'b' }),
			card({ id: 'c', parents: ['a', 'b'] }),
			card({ id: 'd', parents: ['c'] }),
		]);
		expect(hasCycle(b)).toBe(false);
	});

	it('detects a direct two-node cycle', () => {
		const b = board([card({ id: 'a', parents: ['b'] }), card({ id: 'b', parents: ['a'] })]);
		expect(hasCycle(b)).toBe(true);
	});

	it('detects a longer cycle', () => {
		const b = board([
			card({ id: 'a', parents: ['c'] }),
			card({ id: 'b', parents: ['a'] }),
			card({ id: 'c', parents: ['b'] }),
		]);
		expect(hasCycle(b)).toBe(true);
	});

	it('detects a self-parent as a cycle', () => {
		const b = board([card({ id: 'a', parents: ['a'] })]);
		expect(hasCycle(b)).toBe(true);
	});

	it('ignores dangling parent ids (missing dependency, not a cycle)', () => {
		const b = board([card({ id: 'a', parents: ['ghost'] })]);
		expect(hasCycle(b)).toBe(false);
	});

	it('returns false for an empty board', () => {
		expect(hasCycle(board([]))).toBe(false);
	});

	it('detects a cycle in a diamond graph with a back-edge', () => {
		const b = board([
			card({ id: 'a', parents: ['d'] }), // back-edge creating the cycle
			card({ id: 'b', parents: ['a'] }),
			card({ id: 'c', parents: ['a'] }),
			card({ id: 'd', parents: ['b', 'c'] }),
		]);
		expect(hasCycle(b)).toBe(true);
	});

	it('handles a diamond DAG without false positives', () => {
		const b = board([
			card({ id: 'a' }),
			card({ id: 'b', parents: ['a'] }),
			card({ id: 'c', parents: ['a'] }),
			card({ id: 'd', parents: ['b', 'c'] }),
		]);
		expect(hasCycle(b)).toBe(false);
	});
});

describe('eligibility after a parent is deleted', () => {
	it('a dangling parent id permanently blocks the child (why deleteCard must detach)', () => {
		// This is the failure mode `deleteCard`'s referential integrity prevents:
		// if the deleted id is left in `parents`, the child is never eligible and
		// nothing in the UI explains why.
		const b = board([card({ id: 'child', status: 'todo', parents: ['deleted'] })]);
		expect(getBlockers(b.cards[0], b)).toEqual(['deleted']);
		expect(getEligibleCards(b)).toEqual([]);
	});

	it('becomes eligible once the dangling parent is spliced out', () => {
		const b = board([card({ id: 'child', status: 'todo', parents: [] })]);
		expect(getBlockers(b.cards[0], b)).toEqual([]);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['child']);
	});

	it('stays blocked by an adopted grandparent that is not done yet', () => {
		// A -> (B deleted, C adopts A). C must still wait for A.
		const b = board([
			card({ id: 'a', status: 'todo' }),
			card({ id: 'c', status: 'todo', parents: ['a'] }),
		]);
		expect(getBlockers(b.cards[1], b)).toEqual(['a']);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['a']);
	});

	it('runs once the adopted grandparent is done', () => {
		const b = board([
			card({ id: 'a', status: 'done' }),
			card({ id: 'c', status: 'todo', parents: ['a'] }),
		]);
		expect(getBlockers(b.cards[1], b)).toEqual([]);
		expect(getEligibleCards(b).map((c) => c.id)).toEqual(['c']);
	});
});
