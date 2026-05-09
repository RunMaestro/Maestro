import { describe, it, expect } from 'vitest';
import { buildFinalSummary } from '../../../../renderer/hooks/batch/internal/batchFinalSummary';

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
});
