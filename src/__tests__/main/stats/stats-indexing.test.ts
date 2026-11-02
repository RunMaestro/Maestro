import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	STATS_INDEXING_BROADCAST_INTERVAL_MS,
	beginStatsIndexing,
	getStatsIndexingState,
	resetStatsIndexingForTest,
	setStatsIndexingBroadcaster,
	withStatsIndexing,
} from '../../../main/stats/stats-indexing';
import {
	STATS_INDEXING_VISIBLE_AFTER_MS,
	STATS_INDEXING_VISIBLE_MIN_FILES,
} from '../../../shared/statsIndexing';

describe('stats indexing registry', () => {
	const broadcast = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		resetStatsIndexingForTest();
		broadcast.mockReset();
		setStatsIndexingBroadcaster(broadcast);
	});

	afterEach(() => {
		resetStatsIndexingForTest();
		vi.useRealTimers();
	});

	it('aggregates every participant of a group into one job', () => {
		const a = beginStatsIndexing({ id: 'session-index', label: 'Sessions', reason: 'index' });
		const b = beginStatsIndexing({ id: 'session-index', label: 'Sessions', reason: 'index' });
		a.addWork(10, 1000);
		b.addWork(5, 500);
		a.advance(2, 200);

		const [job] = getStatsIndexingState().jobs;
		expect(getStatsIndexingState().jobs).toHaveLength(1);
		expect(job).toMatchObject({ totalFiles: 15, totalBytes: 1500, doneFiles: 2, doneBytes: 200 });
	});

	it('ends the group only when its last participant ends', () => {
		const a = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		const b = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		a.end();
		expect(getStatsIndexingState().jobs).toHaveLength(1);
		b.end();
		expect(getStatsIndexingState().jobs).toEqual([]);
	});

	it('promotes the group to an upgrade when any participant is upgrading', () => {
		beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		beginStatsIndexing({ id: 'g', label: 'G', reason: 'upgrade' });
		expect(getStatsIndexingState().jobs[0].reason).toBe('upgrade');
	});

	it('never reports more done than declared', () => {
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		handle.addWork(1, 10);
		handle.advance(3, 99);
		expect(getStatsIndexingState().jobs[0]).toMatchObject({ doneFiles: 1, doneBytes: 10 });
	});

	it('ignores calls on a handle after it has ended', () => {
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		const other = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		handle.end();
		handle.addWork(100, 100);
		handle.end();
		expect(getStatsIndexingState().jobs[0].totalFiles).toBe(0);
		other.end();
		expect(getStatsIndexingState().jobs).toEqual([]);
	});

	it('coalesces progress pushes once surfaced, and pushes the end at once', () => {
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		handle.addWork(STATS_INDEXING_VISIBLE_MIN_FILES, 1000);
		handle.advance(1, 10);
		vi.advanceTimersByTime(STATS_INDEXING_VISIBLE_AFTER_MS);
		// The reveal check: 1% done after the silent window is a slow scan.
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast.mock.calls[0][0].jobs[0].surfaced).toBe(true);

		handle.advance(1, 10);
		handle.advance(1, 10);
		expect(broadcast).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(STATS_INDEXING_BROADCAST_INTERVAL_MS);
		expect(broadcast).toHaveBeenCalledTimes(2);
		expect(broadcast.mock.calls[1][0].jobs[0].doneFiles).toBe(3);

		handle.end();
		expect(broadcast).toHaveBeenCalledTimes(3);
		expect(broadcast.mock.calls[2][0]).toEqual({ jobs: [] });
	});

	it('never shows a large scan that finishes quickly', () => {
		// Opening a dashboard on a big history: hundreds of changed transcripts,
		// parsed in a few seconds. That is not worth a modal.
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		handle.addWork(500, 5000);
		for (let i = 0; i < 500; i++) {
			handle.advance(1, 10);
			vi.advanceTimersByTime(10);
		}
		handle.end();
		vi.advanceTimersByTime(STATS_INDEXING_VISIBLE_AFTER_MS);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it('keeps a surfaced scan showing when its projected time left drops', () => {
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'upgrade' });
		handle.addWork(100, 1000);
		handle.advance(1, 10);
		vi.advanceTimersByTime(STATS_INDEXING_VISIBLE_AFTER_MS);
		expect(getStatsIndexingState().jobs[0].surfaced).toBe(true);

		// A burst of small files: nearly done, well under the remaining-time cut.
		handle.advance(98, 980);
		vi.advanceTimersByTime(STATS_INDEXING_BROADCAST_INTERVAL_MS);
		const last = broadcast.mock.calls.at(-1)![0];
		expect(last.jobs[0]).toMatchObject({ surfaced: true, doneFiles: 99 });
		handle.end();
	});

	it('stays silent for a scan too small to show', () => {
		const handle = beginStatsIndexing({ id: 'g', label: 'G', reason: 'index' });
		handle.addWork(STATS_INDEXING_VISIBLE_MIN_FILES - 1, 10);
		handle.advance(1, 1);
		vi.advanceTimersByTime(STATS_INDEXING_VISIBLE_AFTER_MS);
		// Not pushed, but still readable on request (the CLI asks directly).
		expect(getStatsIndexingState().jobs).toHaveLength(1);
		handle.end();
		expect(broadcast).not.toHaveBeenCalled();
	});

	it('withStatsIndexing ends the participant even when the work throws', async () => {
		await expect(
			withStatsIndexing({ id: 'g', label: 'G', reason: 'index' }, async (progress) => {
				progress.addWork(30, 30);
				throw new Error('scan failed');
			})
		).rejects.toThrow('scan failed');
		expect(getStatsIndexingState().jobs).toEqual([]);
	});
});
