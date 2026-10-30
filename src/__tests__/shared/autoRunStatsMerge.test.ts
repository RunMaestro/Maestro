import { describe, expect, it } from 'vitest';
import { mergeAutoRunStats } from '../../shared/autoRunStatsMerge';

const stored = {
	cumulativeTimeMs: 4_869_514_889,
	cueTimeMs: 1_655_880_000,
	longestRunMs: 82_370_665,
	longestRunTimestamp: 1_783_641_600_000,
	totalRuns: 326,
	currentBadgeLevel: 6,
	lastBadgeUnlockLevel: 6,
	lastAcknowledgedBadgeLevel: 6,
	badgeHistory: [
		{ level: 2, unlockedAt: 1_764_668_373_382 },
		{ level: 3, unlockedAt: 1_765_038_054_070 },
	],
};

describe('mergeAutoRunStats', () => {
	// The incident: a Cue credit applied to an unhydrated renderer's zeroed copy.
	it('never lowers a stored total, run count, record, or badge', () => {
		const merged = mergeAutoRunStats(stored, {
			cumulativeTimeMs: 37_920_000,
			cueTimeMs: 37_920_000,
			longestRunMs: 0,
			longestRunTimestamp: 0,
			totalRuns: 0,
			currentBadgeLevel: 3,
			lastBadgeUnlockLevel: 3,
			lastAcknowledgedBadgeLevel: 2,
			badgeHistory: [
				{ level: 1, unlockedAt: 1_792_856_751_137 },
				{ level: 2, unlockedAt: 1_792_858_348_125 },
				{ level: 3, unlockedAt: 1_792_867_736_082 },
			],
		});

		expect(merged).toMatchObject({
			cumulativeTimeMs: stored.cumulativeTimeMs,
			cueTimeMs: stored.cueTimeMs,
			longestRunMs: stored.longestRunMs,
			longestRunTimestamp: stored.longestRunTimestamp,
			totalRuns: 326,
			currentBadgeLevel: 6,
			lastBadgeUnlockLevel: 6,
			lastAcknowledgedBadgeLevel: 6,
		});
		// Union by level, the earliest unlock of each one kept.
		expect(merged.badgeHistory).toEqual([
			{ level: 1, unlockedAt: 1_792_856_751_137 },
			{ level: 2, unlockedAt: 1_764_668_373_382 },
			{ level: 3, unlockedAt: 1_765_038_054_070 },
		]);
	});

	it('takes every counter that grew, and the longest run with its own date', () => {
		const merged = mergeAutoRunStats(stored, {
			...stored,
			cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
			cueTimeMs: stored.cueTimeMs + 60_000,
			longestRunMs: 90_000_000,
			longestRunTimestamp: 1_792_000_000_000,
			totalRuns: 327,
			currentBadgeLevel: 7,
		});

		expect(merged).toMatchObject({
			cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
			cueTimeMs: stored.cueTimeMs + 60_000,
			longestRunMs: 90_000_000,
			longestRunTimestamp: 1_792_000_000_000,
			totalRuns: 327,
			currentBadgeLevel: 7,
		});
	});

	it('keeps the Cue share inside the total', () => {
		const merged = mergeAutoRunStats(
			{ cumulativeTimeMs: 1000, cueTimeMs: 0 },
			{ cumulativeTimeMs: 500, cueTimeMs: 5000 }
		);
		expect(merged.cumulativeTimeMs).toBe(1000);
		expect(merged.cueTimeMs).toBe(1000);
	});

	it('accepts the first write on a fresh install and survives junk', () => {
		const first = mergeAutoRunStats(undefined, { cumulativeTimeMs: 60_000, totalRuns: 1 });
		expect(first).toMatchObject({ cumulativeTimeMs: 60_000, totalRuns: 1, badgeHistory: [] });

		const junk = mergeAutoRunStats(
			{ cumulativeTimeMs: 'x', totalRuns: Number.NaN, badgeHistory: 'nope' },
			{ cumulativeTimeMs: -5, badgeHistory: [null, { level: 0, unlockedAt: 1 }] }
		);
		expect(junk).toMatchObject({ cumulativeTimeMs: 0, totalRuns: 0, badgeHistory: [] });
	});
});
