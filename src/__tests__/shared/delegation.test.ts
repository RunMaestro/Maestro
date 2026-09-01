/**
 * Tests for the delegation model (src/shared/delegation.ts).
 *
 * The score drives a milestone track that persists what it unlocks, so the
 * boundary rules matter more than the arithmetic: a score that rounds UP to a
 * milestone must not unlock it, and a stored mark must never exceed a real one.
 */

import { describe, it, expect } from 'vitest';
import {
	DELEGATION_MILESTONES,
	delegatedMs,
	delegatedMsToReach,
	delegationPercent,
	delegationPercentByCount,
	emptyDelegationTotals,
	highestMilestoneReached,
	nextMilestone,
	normalizeUnlockedMilestone,
	sumDelegationDays,
	trackedCount,
	trackedMs,
	type DelegationTotals,
} from '../../shared/delegation';

function totals(
	interactive: [number, number],
	autoRun: [number, number],
	cue: [number, number]
): DelegationTotals {
	return {
		interactive: { count: interactive[0], durationMs: interactive[1] },
		autoRun: { count: autoRun[0], durationMs: autoRun[1] },
		cue: { count: cue[0], durationMs: cue[1] },
	};
}

describe('delegation totals', () => {
	it('treats Auto Run and Cue together as delegated time', () => {
		const t = totals([10, 1000], [2, 3000], [1, 6000]);
		expect(delegatedMs(t)).toBe(9000);
		expect(trackedMs(t)).toBe(10000);
		expect(delegationPercent(t)).toBe(90);
	});

	it('reports zero rather than NaN when nothing is tracked', () => {
		expect(delegationPercent(emptyDelegationTotals())).toBe(0);
		expect(delegationPercentByCount(emptyDelegationTotals())).toBe(0);
		expect(trackedMs(emptyDelegationTotals())).toBe(0);
	});

	it('scores time and turn count separately', () => {
		// Many short interactive turns against a couple of long delegated ones:
		// the whole reason the headline score is time-based.
		const t = totals([100, 100_000], [2, 900_000], [0, 0]);
		expect(Math.round(delegationPercent(t))).toBe(90);
		expect(Math.round(delegationPercentByCount(t))).toBe(2);
		expect(trackedCount(t)).toBe(102);
	});

	it('sums a per-day series back into one split', () => {
		const summed = sumDelegationDays([
			{
				date: '2026-01-01',
				interactive: { count: 1, durationMs: 100 },
				autoRun: { count: 2, durationMs: 200 },
				cue: { count: 3, durationMs: 300 },
			},
			{
				date: '2026-01-02',
				interactive: { count: 4, durationMs: 400 },
				autoRun: { count: 0, durationMs: 0 },
				cue: { count: 1, durationMs: 50 },
			},
		]);
		expect(summed.interactive).toEqual({ count: 5, durationMs: 500 });
		expect(summed.autoRun).toEqual({ count: 2, durationMs: 200 });
		expect(summed.cue).toEqual({ count: 4, durationMs: 350 });
	});
});

describe('milestones', () => {
	it('exposes the four marks in ascending order', () => {
		expect([...DELEGATION_MILESTONES]).toEqual([25, 50, 75, 100]);
	});

	it('does not unlock a milestone the raw score has not reached', () => {
		// 74.6% renders as "75%" but has not earned the 75 mark.
		expect(highestMilestoneReached(74.6)).toBe(50);
		expect(highestMilestoneReached(75)).toBe(75);
		expect(highestMilestoneReached(0)).toBe(0);
		expect(highestMilestoneReached(100)).toBe(100);
	});

	it('names the next mark, and nothing beyond 100', () => {
		expect(nextMilestone(0)).toBe(25);
		expect(nextMilestone(25)).toBe(50);
		expect(nextMilestone(99.9)).toBe(100);
		expect(nextMilestone(100)).toBeNull();
	});

	it('rounds a stored high-water mark down to a real milestone', () => {
		expect(normalizeUnlockedMilestone(75)).toBe(75);
		expect(normalizeUnlockedMilestone(80)).toBe(75);
		expect(normalizeUnlockedMilestone(120)).toBe(100);
		expect(normalizeUnlockedMilestone(-5)).toBe(0);
		expect(normalizeUnlockedMilestone('75')).toBe(0);
		expect(normalizeUnlockedMilestone(undefined)).toBe(0);
		expect(normalizeUnlockedMilestone(Number.NaN)).toBe(0);
	});
});

describe('delegatedMsToReach', () => {
	it('accounts for the target growing the denominator too', () => {
		// 1h interactive, 0 delegated. Reaching 50% needs another 1h delegated,
		// not 30 minutes - the added time counts on both sides of the ratio.
		const t = totals([1, 3_600_000], [0, 0], [0, 0]);
		expect(delegatedMsToReach(t, 50)).toBe(3_600_000);
		expect(delegatedMsToReach(t, 25)).toBe(1_200_000);
	});

	it('returns zero once the target is already met', () => {
		const t = totals([1, 1000], [1, 9000], [0, 0]);
		expect(delegatedMsToReach(t, 50)).toBe(0);
		expect(delegatedMsToReach(t, 75)).toBe(0);
	});

	it('reports 100% as unreachable while interactive time is on record', () => {
		const t = totals([1, 1000], [1, 9000], [0, 0]);
		expect(delegatedMsToReach(t, 100)).toBe(Infinity);
		expect(delegatedMsToReach(totals([0, 0], [1, 9000], [0, 0]), 100)).toBe(0);
	});
});
