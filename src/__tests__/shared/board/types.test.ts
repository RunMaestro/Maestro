/**
 * @file types.test.ts
 * @description Tests for the Board card validator, focused on card priority:
 * `normal` is the default and is never serialized, `high`/`low` round-trip, a
 * junk value degrades to the default rather than rejecting the card, and the
 * dispatch rank is ordered high > normal > low.
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import {
	cardPriorityRank,
	validateBoardCard,
	CARD_PRIORITIES,
	CARD_RUN_OUTCOMES,
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
