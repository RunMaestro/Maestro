import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLoopSummaryEntry } from '../../../../renderer/hooks/batch/internal/batchLoopSummary';

describe('createLoopSummaryEntry', () => {
	const FIXED_NOW = 1_700_000_000_000;

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
			loopStartTime: FIXED_NOW - 90_000,
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
		expect(entry.elapsedTimeMs).toBe(90_000);
	});

	it('marks the (final) variant in the prefix when isFinal=true', () => {
		const entry = createLoopSummaryEntry({
			loopIteration: 2,
			loopTasksCompleted: 1,
			loopStartTime: FIXED_NOW - 1000,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW - 5000,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
			loopStartTime: FIXED_NOW,
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
