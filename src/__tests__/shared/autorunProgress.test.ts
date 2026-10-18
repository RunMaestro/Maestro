import { describe, it, expect } from 'vitest';
import {
	AUTO_RUN_ETA_MIN_TASKS,
	autoRunProgressPercent,
	estimateAutoRunEta,
} from '../../shared/autorunProgress';

const MIN = 60_000;

describe('autoRunProgressPercent', () => {
	const base = {
		totalTasksAcrossAllDocs: 0,
		completedTasksAcrossAllDocs: 0,
		totalTasks: 0,
		completedTasks: 0,
	};

	it('uses the cross-document totals', () => {
		expect(
			autoRunProgressPercent({
				...base,
				totalTasksAcrossAllDocs: 111,
				completedTasksAcrossAllDocs: 78,
			})
		).toBeCloseTo(70.27, 1);
	});

	it('falls back to the legacy single-document counters', () => {
		expect(autoRunProgressPercent({ ...base, totalTasks: 10, completedTasks: 5 })).toBe(50);
	});

	it('reports the goal percent in goal mode, clamped to 0-100', () => {
		expect(autoRunProgressPercent({ ...base, goalMode: true, goalProgress: 42 })).toBe(42);
		expect(autoRunProgressPercent({ ...base, goalMode: true, goalProgress: 140 })).toBe(100);
		expect(autoRunProgressPercent({ ...base, goalMode: true })).toBe(0);
	});

	it('is 0 when there are no tasks', () => {
		expect(autoRunProgressPercent(base)).toBe(0);
	});
});

describe('estimateAutoRunEta', () => {
	it('projects remaining time from the pace of tasks completed in this run', () => {
		const eta = estimateAutoRunEta({
			totalTasksAcrossAllDocs: 111,
			completedTasksAcrossAllDocs: 78,
			initialCompletedTasks: 0,
			activeElapsedMs: 78 * 14 * MIN,
		});

		expect(eta).toEqual({
			available: true,
			msPerTask: 14 * MIN,
			remainingTasks: 33,
			remainingMs: 33 * 14 * MIN,
		});
	});

	it('excludes tasks that were already checked when the run started from the pace', () => {
		// 10 pre-checked + 5 done in 50 minutes: pace is 10m/task, not 50/15.
		const eta = estimateAutoRunEta({
			totalTasksAcrossAllDocs: 20,
			completedTasksAcrossAllDocs: 15,
			initialCompletedTasks: 10,
			activeElapsedMs: 50 * MIN,
		});

		expect(eta.available && eta.msPerTask).toBe(10 * MIN);
		expect(eta.available && eta.remainingMs).toBe(50 * MIN);
	});

	it(`waits for ${AUTO_RUN_ETA_MIN_TASKS} tasks before estimating`, () => {
		expect(
			estimateAutoRunEta({
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 1,
				initialCompletedTasks: 0,
				activeElapsedMs: 5 * MIN,
			})
		).toEqual({ available: false, reason: 'warming-up', tasksUntilEstimate: 2 });
	});

	it('gives no estimate for a goal run', () => {
		expect(
			estimateAutoRunEta({
				goalMode: true,
				totalTasksAcrossAllDocs: 100,
				completedTasksAcrossAllDocs: 40,
				initialCompletedTasks: 0,
				activeElapsedMs: 60 * MIN,
			})
		).toEqual({ available: false, reason: 'goal' });
	});

	it('gives no estimate when the run carries no baseline (state from an older build)', () => {
		expect(
			estimateAutoRunEta({
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 8,
				activeElapsedMs: 60 * MIN,
			})
		).toEqual({ available: false, reason: 'no-baseline' });
	});

	it('reports zero remaining once every task is checked', () => {
		const eta = estimateAutoRunEta({
			totalTasksAcrossAllDocs: 5,
			completedTasksAcrossAllDocs: 5,
			initialCompletedTasks: 0,
			activeElapsedMs: 25 * MIN,
		});
		expect(eta.available && eta.remainingMs).toBe(0);
	});
});
