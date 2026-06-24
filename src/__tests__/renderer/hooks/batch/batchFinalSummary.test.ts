import { describe, it, expect } from 'vitest';
import {
	aggregateAutoRunHistoryTotals,
	buildFinalSummary,
	mergeFinalSummaryTotals,
} from '../../../../renderer/hooks/batch/internal/batchFinalSummary';

const docs = (...names: string[]) => names.map((filename) => ({ filename }));

describe('buildFinalSummary', () => {
	const baseParams = {
		wasStopped: false,
		totalCompletedTasks: 0,
		totalElapsedMs: 0,
		stalledDocuments: new Map<string, string>(),
		documents: docs('a.md'),
		loopEnabled: false,
		loopIteration: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCost: 0,
	};

	it('reports "stopped" status when wasStopped=true regardless of stalls', () => {
		const result = buildFinalSummary({
			...baseParams,
			wasStopped: true,
			totalCompletedTasks: 3,
			totalElapsedMs: 60_000,
		});

		expect(result.statusText).toBe('stopped');
		expect(result.summary.startsWith('Auto Run stopped:')).toBe(true);
		expect(result.details).toContain('Status:** Stopped by user');
		expect(result.isSuccess).toBe(false);
	});

	it('reports "stalled" when every document stalled', () => {
		const stalled = new Map<string, string>([
			['a.md', '3 consecutive runs'],
			['b.md', '3 consecutive runs'],
		]);
		const result = buildFinalSummary({
			...baseParams,
			documents: docs('a.md', 'b.md'),
			stalledDocuments: stalled,
			totalCompletedTasks: 0,
			totalElapsedMs: 30_000,
		});

		expect(result.statusText).toBe('stalled');
		expect(result.summary).toContain('(2 stalled)');
		expect(result.details).toContain('Status:** Stalled - All 2 document(s)');
		expect(result.details).toContain('**Stalled Documents**');
		expect(result.isSuccess).toBe(false);
	});

	it('reports "completed with stalls" when some docs stalled but not all', () => {
		const stalled = new Map<string, string>([['a.md', 'reason']]);
		const result = buildFinalSummary({
			...baseParams,
			documents: docs('a.md', 'b.md', 'c.md'),
			stalledDocuments: stalled,
			totalCompletedTasks: 5,
			totalElapsedMs: 90_000,
		});

		expect(result.statusText).toBe('completed with stalls');
		expect(result.summary).toContain('(1 stalled)');
		expect(result.details).toContain('Status:** Completed with 1 stalled document(s)');
		expect(result.isSuccess).toBe(true);
	});

	it('reports "completed" cleanly when nothing stalled and not stopped', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 7,
			totalElapsedMs: 45_000,
		});

		expect(result.statusText).toBe('completed');
		expect(result.summary).toContain('Auto Run completed: 7 tasks in');
		expect(result.details).toContain('Status:** Completed');
		expect(result.details).not.toContain('**Stalled Documents**');
		expect(result.isSuccess).toBe(true);
	});

	it('omits the Total Tokens line when both token counts are 0', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.details).not.toContain('Total Tokens');
	});

	it('emits the Total Tokens line when token counts are non-zero', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
			totalInputTokens: 1234,
			totalOutputTokens: 567,
		});
		expect(result.details).toContain('Total Tokens:** 1,801 (1,234 in / 567 out)');
	});

	it('omits the Total Cost line when totalCost is 0', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.details).not.toContain('Total Cost');
	});

	it('emits the Total Cost line when totalCost > 0, formatted to 4 decimals', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
			totalCost: 1.23456789,
		});
		expect(result.details).toContain('Total Cost:** $1.2346');
	});

	it('omits the Loops Completed line when loopEnabled=false', () => {
		const result = buildFinalSummary({
			...baseParams,
			loopEnabled: false,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.details).not.toContain('Loops Completed');
	});

	it('emits "Loops Completed: N" with N = loopIteration + 1 when looped', () => {
		const result = buildFinalSummary({
			...baseParams,
			loopEnabled: true,
			loopIteration: 2,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.details).toContain('Loops Completed:** 3');
	});

	it('uses singular "task" for exactly 1 completed task in the summary line', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.summary).toContain('1 task in');
	});

	it('always includes an Achievement Progress section', () => {
		const result = buildFinalSummary({
			...baseParams,
			totalCompletedTasks: 1,
			totalElapsedMs: 1000,
		});
		expect(result.details).toContain('**Achievement Progress**');
	});

	it('lists each stalled document with its reason in the stalled section', () => {
		const stalled = new Map<string, string>([
			['plan.md', '3 consecutive runs with no progress'],
			['todo.md', 'watchdog timeout'],
		]);
		const result = buildFinalSummary({
			...baseParams,
			documents: docs('plan.md', 'todo.md', 'extra.md'),
			stalledDocuments: stalled,
			totalCompletedTasks: 2,
			totalElapsedMs: 1000,
		});
		expect(result.details).toContain('- **plan.md**: 3 consecutive runs with no progress');
		expect(result.details).toContain('- **todo.md**: watchdog timeout');
	});

	it('aggregates persisted Auto Run task history after the previous final summary', () => {
		const totals = aggregateAutoRunHistoryTotals([
			{
				type: 'AUTO',
				timestamp: 1,
				summary: 'first old task',
				elapsedTimeMs: 100,
				usageStats: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 2,
				summary: 'Auto Run completed: 1 task in 0:00',
			},
			{
				type: 'AUTO',
				timestamp: 3,
				summary: 'Loop 1 completed: 2 tasks accomplished',
				elapsedTimeMs: 1000,
				usageStats: {
					inputTokens: 999,
					outputTokens: 999,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 99,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 4,
				summary: 'current task one',
				elapsedTimeMs: 200,
				usageStats: {
					inputTokens: 20,
					outputTokens: 7,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.02,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 5,
				summary: 'current task two',
				completedTaskCount: 3,
				elapsedTimeMs: 300,
				usageStats: {
					inputTokens: 30,
					outputTokens: 8,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.03,
					contextWindow: 0,
				},
			},
		]);

		expect(totals).toEqual({
			totalCompletedTasks: 4,
			totalElapsedMs: 500,
			totalInputTokens: 50,
			totalOutputTokens: 15,
			totalCost: 0.05,
			entryCount: 2,
		});
	});

	it('falls back to one completed task for older Auto Run task history rows', () => {
		const totals = aggregateAutoRunHistoryTotals([
			{
				type: 'AUTO',
				timestamp: 1,
				summary: 'older task row without completedTaskCount',
				elapsedTimeMs: 100,
			},
		]);

		expect(totals?.totalCompletedTasks).toBe(1);
	});

	it('excludes Auto Run and goal-run control history from persisted task totals', () => {
		const totals = aggregateAutoRunHistoryTotals([
			{
				type: 'AUTO',
				timestamp: 1,
				summary: 'Auto Run started in worktree',
				elapsedTimeMs: 1000,
				usageStats: {
					inputTokens: 1000,
					outputTokens: 1000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 99,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 2,
				summary: 'Goal-Driven Auto Run started',
				elapsedTimeMs: 1000,
			},
			{
				type: 'AUTO',
				timestamp: 3,
				summary: 'Goal progress: 40% - implemented storage',
				elapsedTimeMs: 1000,
				usageStats: {
					inputTokens: 1000,
					outputTokens: 1000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 99,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 4,
				summary: 'Goal run stopped by user (40%)',
				elapsedTimeMs: 1000,
			},
			{
				type: 'AUTO',
				timestamp: 5,
				summary: 'Auto Run error: Rate limited (plan.md)',
				elapsedTimeMs: 1000,
				usageStats: {
					inputTokens: 1000,
					outputTokens: 1000,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 99,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 6,
				summary: 'implemented current task',
				elapsedTimeMs: 250,
				usageStats: {
					inputTokens: 25,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.04,
					contextWindow: 0,
				},
			},
		]);

		expect(totals).toEqual({
			totalCompletedTasks: 1,
			totalElapsedMs: 250,
			totalInputTokens: 25,
			totalOutputTokens: 10,
			totalCost: 0.04,
			entryCount: 1,
		});
	});

	it('keeps real task rows whose summary reads like a control phrase (completedTaskCount set)', () => {
		const totals = aggregateAutoRunHistoryTotals([
			{
				// A genuine task whose model-written summary happens to start with a
				// reserved control prefix. completedTaskCount marks it as real work, so
				// it must not be misclassified as a control/delimiter row and dropped.
				type: 'AUTO',
				timestamp: 1,
				summary: 'PR created: wired up the new endpoint',
				completedTaskCount: 2,
				elapsedTimeMs: 250,
				usageStats: {
					inputTokens: 25,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.04,
					contextWindow: 0,
				},
			},
		]);

		expect(totals).toEqual({
			totalCompletedTasks: 2,
			totalElapsedMs: 250,
			totalInputTokens: 25,
			totalOutputTokens: 10,
			totalCost: 0.04,
			entryCount: 1,
		});
	});

	it('does not treat a task row with completedTaskCount as the previous-run boundary', () => {
		// A "...completed:" task row carrying completedTaskCount must not be read as
		// the final-summary delimiter, otherwise later rows would be split off the run.
		const totals = aggregateAutoRunHistoryTotals([
			{
				type: 'AUTO',
				timestamp: 1,
				summary: 'Auto Run completed: rewrote the parser',
				completedTaskCount: 1,
				elapsedTimeMs: 100,
			},
			{
				type: 'AUTO',
				timestamp: 2,
				summary: 'second task',
				completedTaskCount: 1,
				elapsedTimeMs: 100,
			},
		]);

		expect(totals?.totalCompletedTasks).toBe(2);
		expect(totals?.entryCount).toBe(2);
	});

	it('merges final summary totals using persisted history as an upper-bound source', () => {
		const merged = mergeFinalSummaryTotals(
			{
				totalCompletedTasks: 1,
				totalElapsedMs: 100,
				totalInputTokens: 10,
				totalOutputTokens: 5,
				totalCost: 0.01,
			},
			{
				totalCompletedTasks: 3,
				totalElapsedMs: 1000,
				totalInputTokens: 100,
				totalOutputTokens: 50,
				totalCost: 0.2,
				entryCount: 3,
			}
		);

		expect(merged).toEqual({
			totalCompletedTasks: 3,
			totalElapsedMs: 1000,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCost: 0.2,
		});
	});
});
