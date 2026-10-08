/**
 * @file types.test.ts
 * @description Tests for the Board card validator, focused on card priority:
 * `normal` is the default and is never serialized, `high`/`low` round-trip, a
 * junk value degrades to the default rather than rejecting the card, and the
 * dispatch rank is ordered high > normal > low. Also locks the status/outcome
 * enums (including the `review` state) and the per-card PR-on-done opt-in.
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import {
	cardPriorityRank,
	validateBoardCard,
	CARD_PRIORITIES,
	CARD_RUN_OUTCOMES,
	CARD_STATUSES,
	type BoardCard,
} from '../../../shared/board/types';

const NOW = '2026-07-10T00:00:00.000Z';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'c1',
		title: 'A card',
		body: '',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo',
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe('validateBoardCard priority', () => {
	it('keeps high and low', () => {
		expect(validateBoardCard(raw({ priority: 'high' }))?.priority).toBe('high');
		expect(validateBoardCard(raw({ priority: 'low' }))?.priority).toBe('low');
	});

	it('drops an explicit normal so the default is never serialized', () => {
		const card = validateBoardCard(raw({ priority: 'normal' }));
		expect(card).not.toBeNull();
		expect('priority' in card!).toBe(false);
	});

	it('drops a junk priority instead of rejecting the whole card', () => {
		const card = validateBoardCard(raw({ priority: 'URGENT!!' }));
		expect(card?.id).toBe('c1');
		expect(card?.priority).toBeUndefined();
	});

	it('round-trips through YAML for high/low and stays absent for normal', () => {
		const high = validateBoardCard(raw({ priority: 'high' }))!;
		const normal = validateBoardCard(raw({ priority: 'normal' }))!;

		const reloadedHigh = validateBoardCard(yaml.load(yaml.dump(high)));
		const reloadedNormal = validateBoardCard(yaml.load(yaml.dump(normal)));

		expect(reloadedHigh?.priority).toBe('high');
		expect(reloadedNormal?.priority).toBeUndefined();
		// The serialized form of a normal card carries no `priority:` key at all,
		// so existing board.yaml files are untouched until a card is prioritized.
		expect(yaml.dump(normal)).not.toContain('priority');
	});
});

describe('validateBoardCard heldByUser', () => {
	it('round-trips a user hold through YAML so a stopped card stays stopped', () => {
		// The validator rebuilds the card from a whitelist, so a flag it does not
		// copy is silently dropped on the next save. Losing this one would let the
		// dispatcher re-promote a card the user stopped (AB1).
		const held = validateBoardCard(raw({ heldByUser: true }))!;
		expect(held.heldByUser).toBe(true);

		const reloaded = validateBoardCard(yaml.load(yaml.dump(held)));
		expect(reloaded?.heldByUser).toBe(true);
	});

	it('never serializes the not-held default, including a junk value', () => {
		const plain = validateBoardCard(raw())!;
		expect('heldByUser' in plain).toBe(false);
		expect(yaml.dump(plain)).not.toContain('heldByUser');

		// Anything that is not exactly `true` means not held, and the card is kept.
		expect(validateBoardCard(raw({ heldByUser: false }))?.heldByUser).toBeUndefined();
		expect(validateBoardCard(raw({ heldByUser: 'yes' }))?.id).toBe('c1');
		expect(validateBoardCard(raw({ heldByUser: 'yes' }))?.heldByUser).toBeUndefined();
	});
});

describe('cardPriorityRank', () => {
	it('orders high above normal above low, defaulting an absent priority', () => {
		const rank = (priority?: BoardCard['priority']) => cardPriorityRank({ priority });
		expect(rank('high')).toBeGreaterThan(rank(undefined));
		expect(rank(undefined)).toBe(rank('normal'));
		expect(rank('normal')).toBeGreaterThan(rank('low'));
	});

	it('exposes the priorities highest-first', () => {
		expect(CARD_PRIORITIES).toEqual(['high', 'normal', 'low']);
	});
});

describe('validateCardRun outcomes', () => {
	it('accepts every known outcome, including canceled, and drops unknown ones', () => {
		for (const outcome of CARD_RUN_OUTCOMES) {
			const card = validateBoardCard(raw({ runs: [{ attempt: 1, startedAt: NOW, outcome }] }));
			expect(card?.runs?.[0].outcome).toBe(outcome);
		}
		const junk = validateBoardCard(raw({ runs: [{ attempt: 1, startedAt: NOW, outcome: 'huh' }] }));
		expect(junk?.runs?.[0].outcome).toBeUndefined();
	});
});

describe('validateCardRun worktree fields (Phase 4)', () => {
	it('round-trips the worktree path and branch of an isolated attempt', () => {
		const card = validateBoardCard(
			raw({
				runs: [
					{
						attempt: 1,
						startedAt: NOW,
						outcome: 'done',
						worktreePath: '/repos/worktrees/board/1a2b3c4d/5e6f7a8b',
						worktreeBranch: 'board/1a2b3c4d/5e6f7a8b',
					},
				],
			})
		);
		const reloaded = validateBoardCard(yaml.load(yaml.dump(card)));
		expect(reloaded?.runs?.[0]).toMatchObject({
			worktreePath: '/repos/worktrees/board/1a2b3c4d/5e6f7a8b',
			worktreeBranch: 'board/1a2b3c4d/5e6f7a8b',
		});
	});

	it('drops blank or non-string worktree fields instead of rejecting the run', () => {
		const card = validateBoardCard(
			raw({ runs: [{ attempt: 1, startedAt: NOW, worktreePath: '   ', worktreeBranch: 42 }] })
		);
		expect(card?.runs?.[0].attempt).toBe(1);
		expect(card?.runs?.[0].worktreePath).toBeUndefined();
		expect(card?.runs?.[0].worktreeBranch).toBeUndefined();
	});
});

describe('status and outcome enums', () => {
	it('lists every card status, with review parked between running and blocked', () => {
		// Column order in BoardModal follows this list, so the position matters:
		// Review sits after Running and before Blocked.
		expect(CARD_STATUSES).toEqual([
			'triage',
			'todo',
			'ready',
			'running',
			'review',
			'blocked',
			'done',
		]);
	});

	it('lists every run outcome, including review', () => {
		// A run that hands off to a human records `review`, not `done` - the audit
		// trail must not claim the card finished on its own.
		expect(CARD_RUN_OUTCOMES).toEqual([
			'done',
			'review',
			'blocked',
			'error',
			'reclaimed',
			'canceled',
		]);
	});

	it('accepts a card persisted in the review status', () => {
		const card = validateBoardCard(raw({ status: 'review' }));
		expect(card?.status).toBe('review');
	});

	it('round-trips a review card and its review run through YAML', () => {
		const card = validateBoardCard(
			raw({
				status: 'review',
				runs: [{ attempt: 1, startedAt: NOW, outcome: 'review', summary: 'needs a human eye' }],
			})
		)!;
		const reloaded = validateBoardCard(yaml.load(yaml.dump(card)));
		expect(reloaded?.status).toBe('review');
		expect(reloaded?.runs?.[0]).toMatchObject({ outcome: 'review', summary: 'needs a human eye' });
	});
});

describe('validateBoardCard prOnDone (per-card PR opt-in)', () => {
	it('stays absent when the card never opted in, so existing files are untouched', () => {
		const card = validateBoardCard(raw())!;
		expect('prOnDone' in card).toBe(false);
		expect(yaml.dump(card)).not.toContain('prOnDone');
	});

	it('round-trips an explicit target branch', () => {
		const card = validateBoardCard(raw({ prOnDone: { targetBranch: 'develop' } }))!;
		const reloaded = validateBoardCard(yaml.load(yaml.dump(card)));
		expect(reloaded?.prOnDone).toEqual({ targetBranch: 'develop' });
	});

	it('keeps an empty object, which means "resolve the repo default branch at PR time"', () => {
		const card = validateBoardCard(raw({ prOnDone: {} }))!;
		expect(card.prOnDone).toEqual({});
		expect(validateBoardCard(yaml.load(yaml.dump(card)))?.prOnDone).toEqual({});
	});

	it('drops a blank or non-string target branch but keeps the opt-in on', () => {
		expect(validateBoardCard(raw({ prOnDone: { targetBranch: '   ' } }))?.prOnDone).toEqual({});
		expect(validateBoardCard(raw({ prOnDone: { targetBranch: 42 } }))?.prOnDone).toEqual({});
	});

	it('disarms the opt-in for a non-object value rather than silently arming a PR', () => {
		for (const bogus of [true, 'yes', 42, ['develop'], null]) {
			const card = validateBoardCard(raw({ prOnDone: bogus }));
			expect(card?.id).toBe('c1');
			expect(card?.prOnDone).toBeUndefined();
		}
	});
});

describe('validateCardRun prUrl', () => {
	it('round-trips the PR url stamped on a completed run', () => {
		const card = validateBoardCard(
			raw({
				runs: [
					{
						attempt: 1,
						startedAt: NOW,
						outcome: 'done',
						worktreeBranch: 'board/1a2b3c4d/5e6f7a8b',
						prUrl: 'https://github.com/acme/repo/pull/42',
					},
				],
			})
		)!;
		const reloaded = validateBoardCard(yaml.load(yaml.dump(card)));
		expect(reloaded?.runs?.[0].prUrl).toBe('https://github.com/acme/repo/pull/42');
	});

	it('drops a blank or non-string prUrl instead of rejecting the run', () => {
		const card = validateBoardCard(
			raw({
				runs: [
					{ attempt: 1, startedAt: NOW, prUrl: '   ' },
					{ attempt: 2, startedAt: NOW, prUrl: 42 },
				],
			})
		);
		expect(card?.runs?.map((r) => r.attempt)).toEqual([1, 2]);
		expect(card?.runs?.[0].prUrl).toBeUndefined();
		expect(card?.runs?.[1].prUrl).toBeUndefined();
	});
});

describe('validateCardRun prError', () => {
	it('round-trips the failure reason recorded on a run', () => {
		const card = validateBoardCard(
			raw({
				runs: [
					{
						attempt: 1,
						startedAt: NOW,
						outcome: 'done',
						worktreeBranch: 'board/1a2b3c4d/5e6f7a8b',
						prError: 'Failed to push branch: permission denied',
					},
				],
			})
		)!;
		const reloaded = validateBoardCard(yaml.load(yaml.dump(card)));
		expect(reloaded?.runs?.[0].prError).toBe('Failed to push branch: permission denied');
	});

	it('drops a blank or non-string prError instead of rejecting the run', () => {
		const card = validateBoardCard(
			raw({
				runs: [
					{ attempt: 1, startedAt: NOW, prError: '   ' },
					{ attempt: 2, startedAt: NOW, prError: 42 },
				],
			})
		);
		expect(card?.runs?.map((r) => r.attempt)).toEqual([1, 2]);
		expect(card?.runs?.[0].prError).toBeUndefined();
		expect(card?.runs?.[1].prError).toBeUndefined();
	});
});
