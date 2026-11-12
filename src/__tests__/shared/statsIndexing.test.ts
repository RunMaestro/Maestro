import { describe, expect, it } from 'vitest';
import {
	STATS_INDEXING_ETA_MIN_ELAPSED_MS,
	STATS_INDEXING_VISIBLE_AFTER_MS,
	STATS_INDEXING_VISIBLE_MIN_FILES,
	STATS_INDEXING_VISIBLE_MIN_REMAINING_MS,
	estimateRemainingMs,
	shouldSurfaceIndexingJob,
	statsIndexingExplanation,
	statsIndexingTitle,
	summarizeStatsIndexing,
	visibleIndexingJobs,
	type StatsIndexingJob,
} from '../../shared/statsIndexing';

const job = (overrides: Partial<StatsIndexingJob> = {}): StatsIndexingJob => ({
	id: 'global-stats',
	label: 'Usage totals',
	reason: 'index',
	doneFiles: 0,
	totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES,
	doneBytes: 0,
	totalBytes: 1000,
	startedAt: 0,
	updatedAt: 0,
	surfaced: true,
	...overrides,
});

describe('visibleIndexingJobs', () => {
	it('shows only the jobs main has surfaced', () => {
		const quiet = job({ surfaced: undefined });
		const shown = job({ id: 'session-index' });
		expect(visibleIndexingJobs({ jobs: [quiet, shown] })).toEqual([shown]);
		expect(summarizeStatsIndexing({ jobs: [quiet] }, 0)).toBeNull();
	});
});

describe('shouldSurfaceIndexingJob', () => {
	const after = STATS_INDEXING_VISIBLE_AFTER_MS;

	it('hides a scan too small to be worth a modal, however slow', () => {
		const small = job({ totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES - 1, surfaced: undefined });
		expect(shouldSurfaceIndexingJob(small, after * 10)).toBe(false);
	});

	it('stays silent through the first seconds of any scan', () => {
		// Many files, barely started: a cache upgrade, but it has not run long yet.
		const big = job({ totalFiles: 40_000, doneBytes: 1, totalBytes: 1000, surfaced: undefined });
		expect(shouldSurfaceIndexingJob(big, after - 1)).toBe(false);
	});

	it('leaves a scan that is about to finish alone', () => {
		// 90% done after the silent window: well under the remaining-time cut.
		const nearlyDone = job({ doneBytes: 900, totalBytes: 1000, surfaced: undefined });
		expect(shouldSurfaceIndexingJob(nearlyDone, after)).toBe(false);
		expect(shouldSurfaceIndexingJob(job({ doneBytes: 1000, surfaced: undefined }), after)).toBe(
			false
		);
	});

	it('shows a scan projected to run on', () => {
		// 20% in the silent window -> 4x as long again left.
		const slow = job({ doneBytes: 200, totalBytes: 1000, surfaced: undefined });
		expect(after * 4).toBeGreaterThanOrEqual(STATS_INDEXING_VISIBLE_MIN_REMAINING_MS);
		expect(shouldSurfaceIndexingJob(slow, after)).toBe(true);
	});

	it('shows a scan too slow to project yet', () => {
		// Under 5% done after ten seconds is itself a long scan.
		const crawling = job({ doneBytes: 10, totalBytes: 1000, surfaced: undefined });
		expect(shouldSurfaceIndexingJob(crawling, after)).toBe(true);
	});
});

describe('summarizeStatsIndexing', () => {
	it('returns null when nothing is scanning', () => {
		expect(summarizeStatsIndexing({ jobs: [] }, 0)).toBeNull();
	});

	it('folds every visible job into one bar, measured by bytes', () => {
		const summary = summarizeStatsIndexing(
			{
				jobs: [
					// Most files done but few bytes: a byte bar does not overstate it.
					job({ doneFiles: 24, doneBytes: 100, totalBytes: 1000 }),
					job({ id: 'session-index', label: 'Session list', doneBytes: 0, totalBytes: 1000 }),
				],
			},
			0
		)!;
		expect(summary.fraction).toBeCloseTo(0.05);
		expect(summary.doneFiles).toBe(24);
		expect(summary.totalFiles).toBe(STATS_INDEXING_VISIBLE_MIN_FILES * 2);
		expect(summary.labels).toEqual(['Usage totals', 'Session list']);
	});

	it('falls back to file counts when no sizes are known', () => {
		const summary = summarizeStatsIndexing(
			{ jobs: [job({ totalBytes: 0, doneFiles: 5, totalFiles: 50 })] },
			0
		)!;
		expect(summary.fraction).toBeCloseTo(0.1);
	});

	it('reports an upgrade when any job is upgrading', () => {
		const summary = summarizeStatsIndexing(
			{ jobs: [job(), job({ id: 'project-stats', reason: 'upgrade' })] },
			0
		)!;
		expect(summary.reason).toBe('upgrade');
	});

	it('times the ETA from the earliest job', () => {
		const summary = summarizeStatsIndexing(
			{
				jobs: [
					job({ startedAt: 0, doneBytes: 250, totalBytes: 1000 }),
					job({ id: 'b', startedAt: 5000, doneBytes: 250, totalBytes: 1000 }),
				],
			},
			10_000
		)!;
		// 25% done in 10s -> 30s left.
		expect(summary.etaMs).toBeCloseTo(30_000);
	});
});

describe('estimateRemainingMs', () => {
	it('withholds an estimate until the pace is knowable', () => {
		expect(estimateRemainingMs(0.01, 60_000)).toBeUndefined();
		expect(estimateRemainingMs(0.5, STATS_INDEXING_ETA_MIN_ELAPSED_MS - 1)).toBeUndefined();
	});

	it('projects the remaining time at the pace so far', () => {
		expect(estimateRemainingMs(0.5, 10_000)).toBe(10_000);
		expect(estimateRemainingMs(1, 10_000)).toBe(0);
	});
});

describe('copy', () => {
	it('names an upgrade and a first index differently', () => {
		expect(statsIndexingTitle('upgrade')).toBe('Upgrading usage data');
		expect(statsIndexingTitle('index')).toBe('Indexing session history');
		expect(statsIndexingExplanation('upgrade')).toMatch(/kept if you quit/);
	});
});
