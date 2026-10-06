/**
 * @file pianola-tasks.test.ts
 * @description Tests for the pure Pianola task-DAG module: validation, cycle
 * detection, readiness, status transitions, blocked propagation, and progress.
 */

import { describe, it, expect } from 'vitest';
import {
	isTerminalStatus,
	findPlanCycle,
	validatePlan,
	computeReadyTasks,
	markTaskStatus,
	propagateBlocked,
	planProgress,
	type PianolaPlan,
	type PianolaTask,
	type PianolaTaskStatus,
} from '../../../shared/pianola/pianola-tasks';

function task(overrides: Partial<PianolaTask> = {}): PianolaTask {
	return {
		id: 't1',
		title: 'Task 1',
		prompt: 'Do the thing.',
		dependsOn: [],
		status: 'pending',
		...overrides,
	};
}

function plan(tasks: PianolaTask[], overrides: Partial<PianolaPlan> = {}): PianolaPlan {
	return {
		id: 'plan-1',
		title: 'Plan 1',
		createdAt: 1000,
		tasks,
		...overrides,
	};
}

/** Build a raw (untrusted-shaped) plan object for validatePlan. */
function rawPlan(
	tasks: unknown[],
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return { id: 'plan-1', title: 'Plan 1', createdAt: 1000, tasks, ...overrides };
}

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 't1',
		title: 'Task 1',
		prompt: 'Do the thing.',
		dependsOn: [],
		status: 'pending',
		...overrides,
	};
}

describe('isTerminalStatus', () => {
	it.each<[PianolaTaskStatus, boolean]>([
		['done', true],
		['failed', true],
		['skipped', true],
		['pending', false],
		['running', false],
		['blocked', false],
	])('%s -> %s', (status, expected) => {
		expect(isTerminalStatus(status)).toBe(expected);
	});
});

describe('validatePlan', () => {
	it('accepts a good linear plan', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([
				rawTask({ id: 'a', dependsOn: [] }),
				rawTask({ id: 'b', dependsOn: ['a'] }),
				rawTask({ id: 'c', dependsOn: ['b'] }),
			])
		);
		expect(errors).toEqual([]);
		expect(result).not.toBeNull();
		expect(result?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
	});

	it('accepts a diamond DAG', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([
				rawTask({ id: 'a', dependsOn: [] }),
				rawTask({ id: 'b', dependsOn: ['a'] }),
				rawTask({ id: 'c', dependsOn: ['a'] }),
				rawTask({ id: 'd', dependsOn: ['b', 'c'] }),
			])
		);
		expect(errors).toEqual([]);
		expect(result?.tasks).toHaveLength(4);
	});

	it('preserves valid optional fields and drops absent ones', () => {
		const { plan: result } = validatePlan(
			rawPlan([rawTask({ id: 'a', agentId: 'agent-7', tabId: 'tab-3' })])
		);
		const t = result?.tasks[0];
		expect(t?.agentId).toBe('agent-7');
		expect(t?.tabId).toBe('tab-3');
		expect(t?.agentType).toBeUndefined();
	});

	it('rejects an unknown dependency and reports it', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([rawTask({ id: 'a', dependsOn: ['ghost'] })])
		);
		expect(result).toBeNull();
		expect(errors.some((e) => e.includes('unknown task "ghost"'))).toBe(true);
	});

	it('rejects a self dependency and reports it', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([rawTask({ id: 'a', dependsOn: ['a'] })])
		);
		expect(result).toBeNull();
		expect(errors.some((e) => e.includes('depends on itself'))).toBe(true);
	});

	it('rejects a task with missing/invalid fields', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([rawTask({ id: 'a', title: '', status: 'bogus' })])
		);
		expect(result).toBeNull();
		expect(errors.length).toBeGreaterThan(0);
	});

	it('rejects a cycle and reports the cycle path', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([
				rawTask({ id: 'a', dependsOn: ['c'] }),
				rawTask({ id: 'b', dependsOn: ['a'] }),
				rawTask({ id: 'c', dependsOn: ['b'] }),
			])
		);
		expect(result).toBeNull();
		const cycleError = errors.find((e) => e.includes('dependency cycle'));
		expect(cycleError).toBeDefined();
		// All three nodes appear in the reported cycle.
		expect(cycleError).toContain('a');
		expect(cycleError).toContain('b');
		expect(cycleError).toContain('c');
	});

	it('rejects non-record input', () => {
		expect(validatePlan(null).plan).toBeNull();
		expect(validatePlan('plan').plan).toBeNull();
		expect(validatePlan([]).plan).toBeNull();
	});

	it('rejects missing top-level fields', () => {
		expect(validatePlan(rawPlan([], { id: '' })).plan).toBeNull();
		expect(validatePlan(rawPlan([], { title: undefined })).plan).toBeNull();
		expect(validatePlan(rawPlan([], { createdAt: 'soon' })).plan).toBeNull();
		expect(validatePlan({ id: 'x', title: 'y', createdAt: 1 }).plan).toBeNull(); // tasks not array
	});

	it('rejects duplicate task ids', () => {
		const { plan: result, errors } = validatePlan(
			rawPlan([rawTask({ id: 'a' }), rawTask({ id: 'a' })])
		);
		expect(result).toBeNull();
		expect(errors.some((e) => e.includes('Duplicate task id'))).toBe(true);
	});

	it('accepts an empty task list', () => {
		const { plan: result, errors } = validatePlan(rawPlan([]));
		expect(errors).toEqual([]);
		expect(result?.tasks).toEqual([]);
	});
});

describe('findPlanCycle', () => {
	it('returns null for an acyclic diamond', () => {
		expect(
			findPlanCycle([
				task({ id: 'a', dependsOn: [] }),
				task({ id: 'b', dependsOn: ['a'] }),
				task({ id: 'c', dependsOn: ['a'] }),
				task({ id: 'd', dependsOn: ['b', 'c'] }),
			])
		).toBeNull();
	});

	it('finds a 3-node cycle as an ordered id list', () => {
		const cycle = findPlanCycle([
			task({ id: 'a', dependsOn: ['c'] }),
			task({ id: 'b', dependsOn: ['a'] }),
			task({ id: 'c', dependsOn: ['b'] }),
		]);
		expect(cycle).not.toBeNull();
		expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
		expect(cycle).toHaveLength(3);
	});

	it('does not treat unknown dependency ids as edges', () => {
		expect(
			findPlanCycle([task({ id: 'a', dependsOn: ['ghost'] }), task({ id: 'b', dependsOn: ['a'] })])
		).toBeNull();
	});
});

describe('computeReadyTasks', () => {
	it('returns pending tasks whose deps are all done', () => {
		const p = plan([
			task({ id: 'a', status: 'done', dependsOn: [] }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			task({ id: 'c', status: 'pending', dependsOn: ['b'] }),
		]);
		expect(computeReadyTasks(p).map((t) => t.id)).toEqual(['b']);
	});

	it('treats a task with no deps as ready', () => {
		const p = plan([task({ id: 'a', status: 'pending', dependsOn: [] })]);
		expect(computeReadyTasks(p).map((t) => t.id)).toEqual(['a']);
	});

	it('does not mark a task ready when a dep failed or was skipped', () => {
		const p = plan([
			task({ id: 'a', status: 'failed', dependsOn: [] }),
			task({ id: 'b', status: 'skipped', dependsOn: [] }),
			task({ id: 'c', status: 'pending', dependsOn: ['a'] }),
			task({ id: 'd', status: 'pending', dependsOn: ['b'] }),
		]);
		expect(computeReadyTasks(p)).toEqual([]);
	});

	it('respects a diamond: the join only readies when both arms are done', () => {
		const partial = plan([
			task({ id: 'a', status: 'done', dependsOn: [] }),
			task({ id: 'b', status: 'done', dependsOn: ['a'] }),
			task({ id: 'c', status: 'pending', dependsOn: ['a'] }),
			task({ id: 'd', status: 'pending', dependsOn: ['b', 'c'] }),
		]);
		expect(computeReadyTasks(partial).map((t) => t.id)).toEqual(['c']);

		const ready = plan([
			task({ id: 'a', status: 'done', dependsOn: [] }),
			task({ id: 'b', status: 'done', dependsOn: ['a'] }),
			task({ id: 'c', status: 'done', dependsOn: ['a'] }),
			task({ id: 'd', status: 'pending', dependsOn: ['b', 'c'] }),
		]);
		expect(computeReadyTasks(ready).map((t) => t.id)).toEqual(['d']);
	});
});

describe('markTaskStatus', () => {
	it('returns a new plan and does not mutate the input', () => {
		const original = plan([task({ id: 'a', status: 'pending' })]);
		const next = markTaskStatus(original, 'a', 'running');
		expect(next).not.toBe(original);
		expect(next.tasks).not.toBe(original.tasks);
		expect(original.tasks[0].status).toBe('pending');
		expect(next.tasks[0].status).toBe('running');
	});

	it('merges the optional patch fields', () => {
		const original = plan([task({ id: 'a', status: 'pending' })]);
		const next = markTaskStatus(original, 'a', 'running', { tabId: 'tab-1', agentId: 'agent-9' });
		expect(next.tasks[0]).toMatchObject({
			status: 'running',
			tabId: 'tab-1',
			agentId: 'agent-9',
		});
		// Original untouched.
		expect(original.tasks[0].tabId).toBeUndefined();
	});

	it('records an error via the patch on failure', () => {
		const original = plan([task({ id: 'a', status: 'running' })]);
		const next = markTaskStatus(original, 'a', 'failed', { error: 'boom' });
		expect(next.tasks[0].status).toBe('failed');
		expect(next.tasks[0].error).toBe('boom');
	});

	it('is a no-op clone when the task id is not found', () => {
		const original = plan([task({ id: 'a', status: 'pending' })]);
		const next = markTaskStatus(original, 'missing', 'done');
		expect(next).not.toBe(original);
		expect(next.tasks.map((t) => t.status)).toEqual(['pending']);
	});
});

describe('propagateBlocked', () => {
	it('blocks a pending task whose direct dependency failed', () => {
		const p = plan([
			task({ id: 'a', status: 'failed', dependsOn: [] }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
		]);
		const next = propagateBlocked(p);
		expect(next.tasks.find((t) => t.id === 'b')?.status).toBe('blocked');
	});

	it('cascades through a chain to a fixed point', () => {
		const p = plan([
			task({ id: 'a', status: 'failed', dependsOn: [] }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
			task({ id: 'c', status: 'pending', dependsOn: ['b'] }),
			task({ id: 'd', status: 'pending', dependsOn: ['c'] }),
		]);
		const next = propagateBlocked(p);
		expect(next.tasks.map((t) => t.status)).toEqual(['failed', 'blocked', 'blocked', 'blocked']);
	});

	it('blocks via a skipped dependency too', () => {
		const p = plan([
			task({ id: 'a', status: 'skipped', dependsOn: [] }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
		]);
		expect(propagateBlocked(p).tasks.find((t) => t.id === 'b')?.status).toBe('blocked');
	});

	it('does not block a running task or a terminal task', () => {
		const p = plan([
			task({ id: 'a', status: 'failed', dependsOn: [] }),
			task({ id: 'b', status: 'running', dependsOn: ['a'] }),
			task({ id: 'c', status: 'done', dependsOn: ['a'] }),
		]);
		const next = propagateBlocked(p);
		expect(next.tasks.find((t) => t.id === 'b')?.status).toBe('running');
		expect(next.tasks.find((t) => t.id === 'c')?.status).toBe('done');
	});

	it('leaves a healthy plan untouched and does not mutate input', () => {
		const p = plan([
			task({ id: 'a', status: 'done', dependsOn: [] }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
		]);
		const next = propagateBlocked(p);
		expect(next.tasks.map((t) => t.status)).toEqual(['done', 'pending']);
		expect(p.tasks[1].status).toBe('pending');
	});
});

describe('planProgress', () => {
	it('counts tasks by status', () => {
		const p = plan([
			task({ id: 'a', status: 'done' }),
			task({ id: 'b', status: 'running' }),
			task({ id: 'c', status: 'pending' }),
			task({ id: 'd', status: 'failed' }),
			task({ id: 'e', status: 'blocked' }),
			task({ id: 'f', status: 'skipped' }),
		]);
		expect(planProgress(p)).toEqual({
			total: 6,
			pending: 1,
			running: 1,
			needs_review: 0,
			fixing: 0,
			done: 1,
			failed: 1,
			blocked: 1,
			skipped: 1,
			complete: false,
		});
	});

	it('is not complete while a task can still run', () => {
		const p = plan([
			task({ id: 'a', status: 'done' }),
			task({ id: 'b', status: 'pending', dependsOn: ['a'] }),
		]);
		expect(planProgress(p).complete).toBe(false);
	});

	it('is complete when every task is terminal or blocked', () => {
		const p = plan([
			task({ id: 'a', status: 'done' }),
			task({ id: 'b', status: 'failed' }),
			task({ id: 'c', status: 'skipped' }),
			task({ id: 'd', status: 'blocked' }),
		]);
		expect(planProgress(p).complete).toBe(true);
	});

	it('treats an empty plan as complete', () => {
		expect(planProgress(plan([])).complete).toBe(true);
	});
});
