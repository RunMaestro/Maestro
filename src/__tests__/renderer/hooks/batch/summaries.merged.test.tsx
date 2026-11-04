// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/batch/batchFinalSummary.test.ts
// Source: src/__tests__/renderer/hooks/batch/batchFlushState.test.ts
// Source: src/__tests__/renderer/hooks/batch/batchLoopSummary.test.ts
// Source: src/__tests__/renderer/hooks/batch/batchProgressPoll.test.ts
// Source: src/__tests__/renderer/hooks/batch/batchUtilsHitl.test.ts
// Source: src/__tests__/renderer/hooks/batch/batchUtilsHumanSteps.test.ts
// Source: src/__tests__/renderer/hooks/batch/playbookAutoName.test.ts
// Source: src/__tests__/renderer/hooks/batch/useBatchSelectors.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	aggregateAutoRunHistoryTotals,
	buildFinalSummary,
	mergeFinalSummaryTotals,
} from '../../../../renderer/hooks/batch/internal/batchFinalSummary';
import {
	claimFlushState,
	type AutoRunFlushState,
	type AutoRunFlushStateRefs,
} from '../../../../renderer/hooks/batch/internal/batchFlushState';
import { createLoopSummaryEntry } from '../../../../renderer/hooks/batch/internal/batchLoopSummary';
import { createProgressPoll } from '../../../../renderer/hooks/batch/internal/batchProgressPoll';
import type { Session, BatchRunState as S4_BatchRunState } from '../../../../renderer/types';
import { findPendingHitlGate } from '../../../../renderer/hooks/batch/batchUtils';
import { findHumanOnlyTasks } from '../../../../renderer/hooks/batch/batchUtils';
import {
	autoPlaybookName,
	extractPlaybookCodename,
} from '../../../../renderer/hooks/batch/usePlaybookManagement';
import { act, renderHook } from '@testing-library/react';
import { useBatchSelectors } from '../../../../renderer/hooks/batch/internal/useBatchSelectors';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState as S8_BatchRunState } from '../../../../renderer/types';
// Source: src/__tests__/renderer/hooks/batch/batchFinalSummary.test.ts
describe('', () => {
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
				totalElapsedMs: 60000,
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
				totalElapsedMs: 30000,
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
				totalElapsedMs: 90000,
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
				totalElapsedMs: 45000,
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
		it('treats the CLI operator-stop summary as the previous-run boundary', () => {
			const totals = aggregateAutoRunHistoryTotals([
				{
					type: 'AUTO',
					timestamp: 1,
					summary: 'first task',
					completedTaskCount: 1,
					elapsedTimeMs: 100,
				},
				{
					type: 'AUTO',
					timestamp: 2,
					summary: 'Auto Run stopped: by operator',
					elapsedTimeMs: 200,
				},
				{
					type: 'AUTO',
					timestamp: 3,
					summary: 'second task',
					completedTaskCount: 2,
					elapsedTimeMs: 150,
				},
			]);
			expect(totals?.totalCompletedTasks).toBe(2);
			expect(totals?.entryCount).toBe(1);
		});
		it('excludes the CLI goal-run final summaries from task totals', () => {
			const totals = aggregateAutoRunHistoryTotals([
				{
					type: 'AUTO',
					timestamp: 1,
					summary: 'Goal run stopped (40%)',
					elapsedTimeMs: 100,
				},
				{
					type: 'AUTO',
					timestamp: 2,
					summary: 'Goal run deadlocked (60%)',
					elapsedTimeMs: 100,
				},
				{
					type: 'AUTO',
					timestamp: 3,
					summary: 'Goal run hit iteration limit (80%)',
					elapsedTimeMs: 100,
				},
			]);
			expect(totals).toBeNull();
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
});
// Source: src/__tests__/renderer/hooks/batch/batchFlushState.test.ts
describe('', () => {
	const makeFlushState = (overrides: Partial<AutoRunFlushState> = {}): AutoRunFlushState => ({
		statsAutoRunId: 'stats-1',
		sessionName: 'demo',
		projectPath: '/repo',
		getCompletedTasks: () => 0,
		getTotalTasks: () => 0,
		getInputTokens: () => 0,
		getOutputTokens: () => 0,
		getTotalCost: () => 0,
		getDocumentsProcessed: () => 0,
		...overrides,
	});
	const makeRefs = (initial: Record<string, AutoRunFlushState> = {}): AutoRunFlushStateRefs => ({
		current: { ...initial },
	});
	describe('claimFlushState', () => {
		it('returns the entry for the requested session and deletes it from the ref', () => {
			const refs = makeRefs({ a: makeFlushState({ sessionName: 'a' }) });
			const claimed = claimFlushState(refs, 'a');
			expect(claimed?.sessionName).toBe('a');
			expect(refs.current.a).toBeUndefined();
		});
		it('returns null when no entry exists for the session', () => {
			const refs = makeRefs();
			expect(claimFlushState(refs, 'missing')).toBeNull();
		});
		it('a second claim for the same session returns null (idempotent delete)', () => {
			const refs = makeRefs({ a: makeFlushState() });
			expect(claimFlushState(refs, 'a')).not.toBeNull();
			expect(claimFlushState(refs, 'a')).toBeNull();
		});
		it('only deletes the targeted session - other entries are preserved', () => {
			const refs = makeRefs({
				a: makeFlushState({ sessionName: 'a' }),
				b: makeFlushState({ sessionName: 'b' }),
			});
			claimFlushState(refs, 'a');
			expect(refs.current.a).toBeUndefined();
			expect(refs.current.b?.sessionName).toBe('b');
		});
		it('safe to call on an empty ref bag', () => {
			const refs = makeRefs();
			expect(() => claimFlushState(refs, 'whatever')).not.toThrow();
			expect(claimFlushState(refs, 'whatever')).toBeNull();
		});
		it('arbitrates kill-vs-natural-completion: only one path observes the entry', () => {
			const refs = makeRefs({ session: makeFlushState({ sessionName: 'session' }) });
			// Simulate the kill path winning: it claims first.
			const killClaim = claimFlushState(refs, 'session');
			// The natural-completion path then runs; it must see null and skip the
			// duplicate flush.
			const naturalClaim = claimFlushState(refs, 'session');
			expect(killClaim).not.toBeNull();
			expect(naturalClaim).toBeNull();
			// Reverse ordering - natural completion wins.
			const refs2 = makeRefs({ s: makeFlushState({ sessionName: 's' }) });
			const naturalFirst = claimFlushState(refs2, 's');
			const killSecond = claimFlushState(refs2, 's');
			expect(naturalFirst).not.toBeNull();
			expect(killSecond).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/batchLoopSummary.test.ts
describe('', () => {
	describe('createLoopSummaryEntry', () => {
		const FIXED_NOW = 1700000000000;
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(FIXED_NOW);
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it('builds an in-progress (non-final) summary with the right prefix', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 4,
				loopSpan: { startedAt: FIXED_NOW - 90000, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/repo',
				sessionId: 'session-1',
				isFinal: false,
			});
			expect(entry.summary).toBe('Loop 1 completed: 4 tasks accomplished');
			expect(entry.fullResponse).toContain('**Loop 1 Summary**');
			expect(entry.success).toBe(true);
			expect(entry.elapsedTimeMs).toBe(90000);
		});
		it('marks the (final) variant in the prefix when isFinal=true', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 2,
				loopTasksCompleted: 1,
				loopSpan: { startedAt: FIXED_NOW - 1000, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/repo',
				sessionId: 's',
				isFinal: true,
			});
			expect(entry.summary).toBe('Loop 3 (final) completed: 1 task accomplished');
			expect(entry.fullResponse).toContain('**Loop 3 (final) Summary**');
		});
		it('uses singular "task" for exactly 1 completed task', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 1,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.summary).toBe('Loop 1 completed: 1 task accomplished');
		});
		it('uses plural "tasks" for 0 completed tasks', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 0,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.summary).toBe('Loop 1 completed: 0 tasks accomplished');
		});
		it('omits token + cost lines when both are zero, and skips the usageStats field', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 2,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.fullResponse).not.toContain('Tokens:');
			expect(entry.fullResponse).not.toContain('Cost:');
			expect(entry.usageStats).toBeUndefined();
		});
		it('emits token + cost lines + usageStats when tokens > 0', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 3,
				loopSpan: { startedAt: FIXED_NOW - 5000, sleptMsAtStart: 0 },
				loopTotalInputTokens: 1000,
				loopTotalOutputTokens: 500,
				loopTotalCost: 0.0123,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.fullResponse).toContain('Tokens:** 1,500 (1,000 in / 500 out)');
			expect(entry.fullResponse).toContain('Cost:** $0.0123');
			expect(entry.usageStats).toEqual({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.0123,
				contextWindow: 0,
			});
		});
		it('omits the cost line but keeps usageStats when cost is zero with non-zero tokens', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 1,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 100,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.fullResponse).toContain('Tokens:** 100 (100 in / 0 out)');
			expect(entry.fullResponse).not.toContain('Cost:');
			expect(entry.usageStats?.totalCostUsd).toBe(0);
		});
		it('appends an Exit Reason line when one is supplied', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 1,
				loopTasksCompleted: 0,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: true,
				exitReason: 'Stopped by user',
			});
			expect(entry.fullResponse).toContain('Exit Reason:** Stopped by user');
		});
		it('appends a Tasks Discovered for Next Loop line when tasksDiscoveredForNextLoop is set', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 2,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
				tasksDiscoveredForNextLoop: 7,
			});
			expect(entry.fullResponse).toContain('Tasks Discovered for Next Loop:** 7');
		});
		it('omits the Tasks Discovered line when tasksDiscoveredForNextLoop is undefined', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 2,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/r',
				sessionId: 's',
				isFinal: false,
			});
			expect(entry.fullResponse).not.toContain('Tasks Discovered');
		});
		it('returns an AUTO entry preserving sessionCwd and sessionId on the projectPath/sessionId fields', () => {
			const entry = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 1,
				loopSpan: { startedAt: FIXED_NOW, sleptMsAtStart: 0 },
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/path/to/repo',
				sessionId: 'session-xyz',
				isFinal: false,
			});
			expect(entry.type).toBe('AUTO');
			expect(entry.projectPath).toBe('/path/to/repo');
			expect(entry.sessionId).toBe('session-xyz');
			expect(entry.timestamp).toBe(FIXED_NOW);
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/batchProgressPoll.test.ts
describe('', () => {
	const INTERVAL = 1000;
	const stubReadDoc = vi.fn();
	beforeEach(() => {
		vi.useFakeTimers();
		stubReadDoc.mockReset();
		(
			window as unknown as {
				maestro: unknown;
			}
		).maestro = {
			autorun: {
				readDoc: vi.fn(async () => ({ success: true, content: '' })),
			},
		};
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const makePoll = (overrides: Partial<Parameters<typeof createProgressPoll>[0]> = {}) => {
		const updateBatchState = vi.fn<
			[
				string,
				(prev: Record<string, S4_BatchRunState>) => Record<string, S4_BatchRunState>,
				boolean | undefined,
			],
			void
		>();
		const onUpdateSession = vi.fn();
		const updateTaskCount = vi.fn();
		const documents = [{ filename: 'a' }, { filename: 'b' }];
		const docEntry = { filename: 'a' };
		const poll = createProgressPoll({
			documents,
			docEntry,
			folderPath: '/p',
			sshRemoteId: undefined,
			sessionId: 'sess',
			intervalMs: INTERVAL,
			readDocAndCountTasks: stubReadDoc as never,
			updateBatchState,
			getSessions: () => [] as Session[],
			onUpdateSession,
			updateTaskCount,
			...overrides,
		});
		return { poll, updateBatchState, onUpdateSession, updateTaskCount };
	};
	describe('createProgressPoll', () => {
		it('start() schedules the first tick after intervalMs', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 2, checkedCount: 1, content: '' });
			const { poll, updateBatchState } = makePoll();
			await poll.start();
			expect(updateBatchState).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(stubReadDoc).toHaveBeenCalled();
			// updater receives an empty prev; the inner branch returns prev unchanged when
			// the new totals match the default state - so we only assert the call happened.
			expect(updateBatchState).toHaveBeenCalled();
		});
		it('start() awaits the baseline reads of the OTHER documents before scheduling', async () => {
			// Each document returns 1 unchecked + 1 checked = 2 total each.
			stubReadDoc.mockResolvedValue({ taskCount: 1, checkedCount: 1, content: '' });
			const { poll } = makePoll();
			await poll.start();
			// The baseline read happens for every doc except docEntry (docs has 2 entries).
			expect(stubReadDoc).toHaveBeenCalledWith('/p', 'b', undefined);
		});
		it('stop() cancels the pending tick', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const { poll, updateBatchState } = makePoll();
			await poll.start();
			poll.stop();
			await vi.advanceTimersByTimeAsync(INTERVAL * 2);
			// updateBatchState may have been called once during baseline if any tick had
			// already fired before stop() - but here stop() is called immediately, so no
			// tick should have fired yet.
			expect(updateBatchState).not.toHaveBeenCalled();
		});
		it('updateBatchState is a no-op (returns prev) when the polled totals match prev state', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const { poll, updateBatchState } = makePoll();
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(updateBatchState).toHaveBeenCalled();
			const updater = updateBatchState.mock.calls[0][1];
			const prev = {
				sess: { totalTasksAcrossAllDocs: 0, completedTasksAcrossAllDocs: 0 } as never,
			};
			expect(updater(prev)).toBe(prev);
		});
		it('emits an updated state when the polled totals change', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 5, checkedCount: 3, content: '' });
			const { poll, updateBatchState } = makePoll();
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			const updater = updateBatchState.mock.calls[0][1];
			const prev = {
				sess: {
					totalTasksAcrossAllDocs: 0,
					completedTasksAcrossAllDocs: 0,
					cumulativeTaskTimeMs: 0,
				} as never,
			};
			const next = updater(prev);
			expect(next.sess.totalTasksAcrossAllDocs).toBeGreaterThan(0);
			expect(next.sess.completedTasksAcrossAllDocs).toBeGreaterThan(0);
		});
		it('writes the polled document count into the task-count cache', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 5, checkedCount: 3, content: '' });
			const { poll, updateTaskCount } = makePoll();
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			// completed = checkedCount, total = unchecked + checked.
			expect(updateTaskCount).toHaveBeenCalledWith('a', 3, 8);
		});
		it('does not write the task-count cache for a tick that lost its generation', async () => {
			let resolveRead: ((v: unknown) => void) | undefined;
			stubReadDoc.mockImplementation(
				() =>
					new Promise((res) => {
						resolveRead = res;
					})
			);
			const { poll, updateTaskCount } = makePoll();
			// start() awaits the baseline read of doc 'b' - settle it first.
			const started = poll.start();
			await vi.advanceTimersByTimeAsync(0);
			resolveRead?.({ taskCount: 0, checkedCount: 0, content: '' });
			await started;
			// Let the tick fire and block on its read, then stop before it resolves.
			await vi.advanceTimersByTimeAsync(INTERVAL);
			poll.stop();
			resolveRead?.({ taskCount: 4, checkedCount: 2, content: '' });
			await vi.advanceTimersByTimeAsync(0);
			expect(updateTaskCount).not.toHaveBeenCalled();
		});
		it('refreshes autoRunContent when the user is viewing a document and content changed', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const session = {
				id: 'sess',
				autoRunSelectedFile: 'view',
				autoRunContent: 'old',
				autoRunContentVersion: 0,
			} as unknown as Session;
			const readDoc = vi.fn(async () => ({ success: true, content: 'fresh' }));
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = { autorun: { readDoc } };
			const { poll, onUpdateSession } = makePoll({ getSessions: () => [session] });
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(readDoc).toHaveBeenCalledWith('/p', 'view.md', undefined);
			expect(onUpdateSession).toHaveBeenCalledWith('sess', {
				autoRunContent: 'fresh',
				autoRunContentVersion: 1,
			});
		});
		it('does not call onUpdateSession when the polled content equals current content', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const session = {
				id: 'sess',
				autoRunSelectedFile: 'view',
				autoRunContent: 'same',
				autoRunContentVersion: 1,
			} as unknown as Session;
			const readDoc = vi.fn(async () => ({ success: true, content: 'same' }));
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = { autorun: { readDoc } };
			const { poll, onUpdateSession } = makePoll({ getSessions: () => [session] });
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(onUpdateSession).not.toHaveBeenCalled();
		});
		it('swallows readDocAndCountTasks errors during a tick', async () => {
			stubReadDoc.mockRejectedValueOnce(new Error('boom'));
			const { poll, updateBatchState } = makePoll();
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			// No throw, no update.
			expect(updateBatchState).not.toHaveBeenCalled();
		});
		it('reschedules itself on the next interval after a successful tick', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const { poll } = makePoll();
			await poll.start();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			const callsAfterFirst = stubReadDoc.mock.calls.length;
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(stubReadDoc.mock.calls.length).toBeGreaterThan(callsAfterFirst);
		});
		it('restart() is supported and re-arms a new schedule after stop', async () => {
			stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
			const { poll } = makePoll();
			await poll.start();
			poll.stop();
			await poll.restart();
			await vi.advanceTimersByTimeAsync(INTERVAL);
			expect(stubReadDoc).toHaveBeenCalled();
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/batchUtilsHitl.test.ts
describe('', () => {
	describe('findPendingHitlGate', () => {
		it('returns null when no marker is present', () => {
			const content = ['- [ ] task one', '- [ ] task two'].join('\n');
			expect(findPendingHitlGate(content)).toBeNull();
		});
		it('returns null when there are no tasks at all', () => {
			const content = ['# Heading', '<!-- MAESTRO:HITL reason="orphan" -->'].join('\n');
			expect(findPendingHitlGate(content)).toBeNull();
		});
		it('returns the marker when it precedes the first unchecked task', () => {
			const content = [
				'## Step 5: Review Specification',
				'',
				'<!-- MAESTRO:HITL reason="Spec ready for review" artifact=".maestro/outputs/SPEC.md" -->',
				'',
				'- [ ] Human has reviewed and approved the specification',
			].join('\n');
			const gate = findPendingHitlGate(content);
			expect(gate).not.toBeNull();
			expect(gate?.reason).toBe('Spec ready for review');
			expect(gate?.artifact).toBe('.maestro/outputs/SPEC.md');
		});
		it('returns null when an unchecked task appears before any marker', () => {
			const content = [
				'- [ ] earlier task without gate',
				'<!-- MAESTRO:HITL reason="later gate" -->',
				'- [ ] gated task',
			].join('\n');
			expect(findPendingHitlGate(content)).toBeNull();
		});
		it('treats a checked task as consuming the marker above it', () => {
			const content = [
				'<!-- MAESTRO:HITL reason="already approved" -->',
				'- [x] Human approved',
				'- [ ] follow-up work',
			].join('\n');
			expect(findPendingHitlGate(content)).toBeNull();
		});
		it('repauses on a fresh marker placed after a previously consumed one', () => {
			const content = [
				'<!-- MAESTRO:HITL reason="approved earlier" -->',
				'- [x] Approved spec',
				'<!-- MAESTRO:HITL reason="approve plan" artifact="PLAN.md" -->',
				'- [ ] Approve plan',
			].join('\n');
			const gate = findPendingHitlGate(content);
			expect(gate?.reason).toBe('approve plan');
			expect(gate?.artifact).toBe('PLAN.md');
		});
		it('returns the first marker when multiple appear before an unchecked task', () => {
			const content = [
				'<!-- MAESTRO:HITL reason="first" -->',
				'<!-- MAESTRO:HITL reason="second" -->',
				'- [ ] gated task',
			].join('\n');
			expect(findPendingHitlGate(content)?.reason).toBe('first');
		});
		it('handles missing artifact attribute', () => {
			const content = ['<!-- MAESTRO:HITL reason="just review" -->', '- [ ] approve'].join('\n');
			const gate = findPendingHitlGate(content);
			expect(gate?.reason).toBe('just review');
			expect(gate?.artifact).toBeUndefined();
		});
		it('falls back to a default reason when the attribute is missing', () => {
			const content = ['<!-- MAESTRO:HITL -->', '- [ ] approve'].join('\n');
			const gate = findPendingHitlGate(content);
			expect(gate?.reason).toBe('Human review requested');
		});
		it('ignores markers inside fenced code blocks', () => {
			const content = [
				'```markdown',
				'<!-- MAESTRO:HITL reason="documentation example" -->',
				'```',
				'- [ ] real task without a gate',
			].join('\n');
			expect(findPendingHitlGate(content)).toBeNull();
		});
		it('still detects markers outside fenced code blocks when an example exists inside one', () => {
			const content = [
				'```markdown',
				'<!-- MAESTRO:HITL reason="docs example" -->',
				'- [ ] example unchecked',
				'```',
				'<!-- MAESTRO:HITL reason="real gate" -->',
				'- [ ] real approval',
			].join('\n');
			expect(findPendingHitlGate(content)?.reason).toBe('real gate');
		});
		it('records the 0-indexed line number of the marker', () => {
			const content = [
				'# heading',
				'',
				'<!-- MAESTRO:HITL reason="check line" -->',
				'- [ ] gated',
			].join('\n');
			expect(findPendingHitlGate(content)?.line).toBe(2);
		});
		it('handles CRLF line endings', () => {
			const content = '<!-- MAESTRO:HITL reason="crlf" -->\r\n- [ ] gated\r\n';
			expect(findPendingHitlGate(content)?.reason).toBe('crlf');
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/batchUtilsHumanSteps.test.ts
describe('', () => {
	describe('findHumanOnlyTasks', () => {
		it('returns nothing for a document of machine-executable tasks', () => {
			const content = [
				'# Phase 01',
				'',
				'- [ ] Create `src/auth/LoginForm.tsx` with email and password validation.',
				'- [ ] Run `npm run lint` and `npm test`, then fix any failures.',
				'- [ ] Verify dark mode works: toggle switches themes, preference persists after reload.',
			].join('\n');
			expect(findHumanOnlyTasks(content)).toEqual([]);
		});
		it('flags a manual-action task', () => {
			const content = '- [ ] Manually test the login flow in the browser';
			const found = findHumanOnlyTasks(content);
			expect(found).toHaveLength(1);
			expect(found[0].line).toBe(0);
			expect(found[0].text).toBe('Manually test the login flow in the browser');
			expect(found[0].reason).toContain('manual action');
		});
		it('flags visual verification but not ordinary verification', () => {
			const content = [
				'- [ ] Visually verify the spacing on the settings panel',
				'- [ ] Verify the migration applies cleanly by running `npm run migrate`',
			].join('\n');
			const found = findHumanOnlyTasks(content);
			expect(found).toHaveLength(1);
			expect(found[0].line).toBe(0);
		});
		it('flags a check phrased with "visually" last', () => {
			const content = '- [ ] Compare the before and after screenshots visually';
			expect(findHumanOnlyTasks(content)).toHaveLength(1);
		});
		it('ignores "visually" used to describe UI work an agent writes', () => {
			const content = [
				'- [ ] Render `:codex-file-citation` as a file link. Show the base name as the link text with the full path on hover, and distinguish `purpose="output"` from `purpose="source"` visually.',
				'- [ ] Visually separate the error state from the warning state with the theme danger color.',
				'- [ ] Add a visual indicator for unread tabs.',
			].join('\n');
			expect(findHumanOnlyTasks(content)).toEqual([]);
		});
		it('flags approval gates and waiting on a person', () => {
			const content = [
				'- [ ] Get approval from the team before proceeding',
				'- [ ] Ask the user which database they prefer',
			].join('\n');
			expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([0, 1]);
		});
		it('flags credentials a person must obtain', () => {
			const content = '- [ ] Sign up for a SendGrid account and add the API key to .env';
			expect(findHumanOnlyTasks(content)).toHaveLength(1);
		});
		it('flags a task where a person is the actor', () => {
			const content = '- [ ] The user must confirm the checkout page renders correctly';
			expect(findHumanOnlyTasks(content)).toHaveLength(1);
		});
		it('reports every matching signal for one task', () => {
			const content = '- [ ] Manually walk the flow and get sign-off from the owner';
			const [found] = findHumanOnlyTasks(content);
			expect(found.reason).toContain('manual action');
			expect(found.reason).toContain('approval gate');
		});
		it('ignores checked tasks - they can no longer stall the run', () => {
			const content = '- [x] Manually test the login flow in the browser';
			expect(findHumanOnlyTasks(content)).toEqual([]);
		});
		it('ignores plain bullets, so a trailing manual checklist is safe', () => {
			const content = [
				'- [ ] Add Playwright coverage for the login flow and run `npm run e2e`.',
				'',
				'## Manual Follow-Up (not executed by Auto Run)',
				'',
				'- Manually verify the login screen on a physical iPhone.',
				'- Get design sign-off before launch.',
			].join('\n');
			expect(findHumanOnlyTasks(content)).toEqual([]);
		});
		it('ignores tasks inside fenced code blocks', () => {
			const content = [
				'Do not write tasks like this:',
				'',
				'```markdown',
				'- [ ] Manually test the login flow',
				'```',
				'',
				'- [ ] Add unit tests for `src/auth/session.ts`.',
			].join('\n');
			expect(findHumanOnlyTasks(content)).toEqual([]);
		});
		it('reports 0-indexed line numbers within the document', () => {
			const content = [
				'# Phase 02',
				'',
				'- [ ] Build the checkout flow.',
				'- [ ] Visually confirm the payment step looks right.',
			].join('\n');
			expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([3]);
		});
		it('handles CRLF line endings', () => {
			const content = '# Phase\r\n\r\n- [ ] Manually test the flow\r\n';
			expect(findHumanOnlyTasks(content).map((t) => t.line)).toEqual([2]);
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/playbookAutoName.test.ts
describe('', () => {
	describe('extractPlaybookCodename', () => {
		it('uses the dated folder, minus its date', () => {
			expect(extractPlaybookCodename('2026-09-25-Desktop-Apps/CONTEXT')).toBe('Desktop-Apps');
			expect(extractPlaybookCodename('2026-09-26-Census-Dashboard-V2/CENSUS-V2-02.md')).toBe(
				'Census-Dashboard-V2'
			);
		});
		it('uses a flat file name, minus date and phase number', () => {
			expect(extractPlaybookCodename('Auth-Rewrite-01')).toBe('Auth-Rewrite');
			expect(extractPlaybookCodename('2026-01-02-Auth-Rewrite-03.md')).toBe('Auth-Rewrite');
			expect(extractPlaybookCodename('notes')).toBe('notes');
		});
		it('falls back when nothing is left', () => {
			expect(extractPlaybookCodename('2026-01-02')).toBe('Playbook');
			expect(extractPlaybookCodename('')).toBe('Playbook');
		});
	});
	describe('autoPlaybookName', () => {
		const now = new Date(2026, 8, 6, 23, 30);
		it('stamps the local date', () => {
			expect(autoPlaybookName('2026-09-25-Desktop-Apps/CONTEXT', [], now)).toBe(
				'2026-09-06-Desktop-Apps'
			);
		});
		it('suffixes a name that is already taken', () => {
			const taken = ['2026-09-06-Desktop-Apps', '2026-09-06-Desktop-Apps-2'];
			expect(autoPlaybookName('Desktop-Apps-01', taken, now)).toBe('2026-09-06-Desktop-Apps-3');
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useBatchSelectors.test.ts
describe('', () => {
	const mkState = (over: Partial<S8_BatchRunState> = {}): S8_BatchRunState => ({
		...DEFAULT_BATCH_STATE,
		isRunning: true,
		...over,
	});
	describe('useBatchSelectors', () => {
		beforeEach(() => {
			useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		});
		it('returns DEFAULT_BATCH_STATE for unknown sessions', () => {
			const { result } = renderHook(() => useBatchSelectors());
			expect(result.current.getBatchState('nope')).toEqual(DEFAULT_BATCH_STATE);
		});
		it('exposes batchRunStates from the store reactively', () => {
			const { result } = renderHook(() => useBatchSelectors());
			expect(result.current.batchRunStates).toEqual({});
			act(() => {
				useBatchStore.setState({ batchRunStates: { a: mkState() } });
			});
			expect(result.current.batchRunStates.a?.isRunning).toBe(true);
		});
		it('hasAnyActiveBatch flips true when a session is running', () => {
			const { result } = renderHook(() => useBatchSelectors());
			expect(result.current.hasAnyActiveBatch).toBe(false);
			act(() => {
				useBatchStore.setState({ batchRunStates: { a: mkState() } });
			});
			expect(result.current.hasAnyActiveBatch).toBe(true);
		});
		it('activeBatchSessionIds excludes sessions with errorPaused=true', () => {
			const { result } = renderHook(() => useBatchSelectors());
			act(() => {
				useBatchStore.setState({
					batchRunStates: {
						a: mkState(),
						b: mkState({ errorPaused: true }),
						c: mkState({ isRunning: false }),
					},
				});
			});
			expect(result.current.activeBatchSessionIds).toEqual(['a']);
		});
		it('stoppingBatchSessionIds is the subset of running sessions with isStopping=true', () => {
			const { result } = renderHook(() => useBatchSelectors());
			act(() => {
				useBatchStore.setState({
					batchRunStates: {
						a: mkState(),
						b: mkState({ isStopping: true }),
						c: mkState({ isStopping: true, isRunning: false }),
					},
				});
			});
			expect(result.current.stoppingBatchSessionIds).toEqual(['b']);
		});
		it('customPrompts is reactive to store updates', () => {
			const { result } = renderHook(() => useBatchSelectors());
			expect(result.current.customPrompts).toEqual({});
			act(() => {
				useBatchStore.setState({ customPrompts: { x: 'hello' } });
			});
			expect(result.current.customPrompts.x).toBe('hello');
		});
		it('setCustomPrompt round-trips through the store', () => {
			const { result } = renderHook(() => useBatchSelectors());
			act(() => {
				result.current.setCustomPrompt('s1', 'do the thing');
			});
			expect(useBatchStore.getState().customPrompts.s1).toBe('do the thing');
		});
		it('isolates per-session state across the active/stopping selectors', () => {
			const { result } = renderHook(() => useBatchSelectors());
			act(() => {
				useBatchStore.setState({
					batchRunStates: {
						alpha: mkState(),
						beta: mkState({ isStopping: true }),
						gamma: mkState({ errorPaused: true }),
					},
				});
			});
			expect(result.current.activeBatchSessionIds.sort()).toEqual(['alpha', 'beta']);
			expect(result.current.stoppingBatchSessionIds).toEqual(['beta']);
		});
	});
});
