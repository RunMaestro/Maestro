import { describe, expect, it } from 'vitest';
import {
	STATS_INDEXING_ETA_MIN_ELAPSED_MS,
	STATS_INDEXING_VISIBLE_MIN_FILES,
	estimateRemainingMs,
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
	...overrides,
});

describe('visibleIndexingJobs', () => {
	it('hides a scan too small to be worth a modal', () => {
		const small = job({ totalFiles: STATS_INDEXING_VISIBLE_MIN_FILES - 1 });
		expect(visibleIndexingJobs({ jobs: [small] })).toEqual([]);
		expect(summarizeStatsIndexing({ jobs: [small] }, 0)).toBeNull();
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
