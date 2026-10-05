import { describe, expect, it } from 'vitest';
import {
	buildAutoRunSummaryEntry,
	buildFinalLoopEntry,
	buildGoalFinalEntry,
	buildGoalStartEntry,
	buildLoopEntry,
	buildTaskHistoryEntry,
	goalExitReasonLabel,
	summaryUsageStats,
} from '../history-entries';

const agent = { id: 'agent-1', cwd: '/work' };

describe('Auto Run History rows', () => {
	it('reports no usage until something was spent', () => {
		expect(summaryUsageStats(0, 0, 0)).toBeUndefined();
		expect(summaryUsageStats(10, 5, 0.25)).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			totalCostUsd: 0.25,
			contextWindow: 0,
		});
	});

	it('stamps a task row with its checkbox count and the agent it ran for', () => {
		const row = buildTaskHistoryEntry(agent, {
			now: 5,
			summary: 's',
			fullResponse: 'f',
			success: true,
			elapsedMs: 9,
			completedTaskCount: 2,
		});
		expect(row).toMatchObject({
			type: 'AUTO',
			timestamp: 5,
			sessionId: 'agent-1',
			projectPath: '/work',
			completedTaskCount: 2,
			elapsedTimeMs: 9,
		});
	});

	it('words the run summary so it stays a run boundary', () => {
		const totals = {
			totalCompletedTasks: 4,
			totalElapsedMs: 1000,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCost: 0,
		};
		expect(buildAutoRunSummaryEntry(agent, 1, totals, 2).summary).toBe(
			'Auto Run completed: 4 tasks in 2 loops'
		);
		expect(buildAutoRunSummaryEntry(agent, 1, totals, 1, 'halted: why').summary).toBe(
			'Auto Run halted: why'
		);
		expect(buildAutoRunSummaryEntry(agent, 1, totals, 1).summary).toBe(
			'Auto Run completed: 4 tasks in 1 loop'
		);
	});

	it('names the exit reason on the final loop row and pluralizes the task count', () => {
		const row = buildFinalLoopEntry(
			agent,
			1,
			3,
			{ tasksCompleted: 1, elapsedMs: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
			'All tasks completed'
		);
		expect(row.summary).toBe('Loop 3 (final) completed: 1 task accomplished');
		expect(row.fullResponse).toContain('- **Exit Reason:** All tasks completed');
		expect(row.usageStats).toBeUndefined();
	});

	it('writes the between-loop row without a body', () => {
		const row = buildLoopEntry(agent, 1, 1, 2, 10, undefined);
		expect(row.summary).toBe('Loop 1 completed: 2 tasks accomplished');
		expect(row.fullResponse).toBeUndefined();
	});

	it('labels each goal exit and marks only completion as success', () => {
		expect(goalExitReasonLabel('deadlock')).toBe('Goal run deadlocked');
		const base = {
			exitDetail: 'why',
			finalProgress: 40,
			iterations: 2,
			totalElapsedMs: 0,
			goal: 'g',
		};
		expect(buildGoalFinalEntry(agent, 1, { ...base, exitReason: 'completed' }).success).toBe(true);
		const stalled = buildGoalFinalEntry(agent, 1, { ...base, exitReason: 'stalled' });
		expect(stalled.success).toBe(false);
		expect(stalled.summary).toBe('Goal run stalled (40%)');
	});

	it('records the goal and its limit on the start row', () => {
		const row = buildGoalStartEntry(agent, 0, {
			goal: 'g',
			exitCriteria: '  ',
			maxIterations: null,
		});
		expect(row.fullResponse).toContain('- **Exit Criteria:** _(none specified)_');
		expect(row.fullResponse).toContain('- **Iteration Limit:** Infinite');
	});
});
