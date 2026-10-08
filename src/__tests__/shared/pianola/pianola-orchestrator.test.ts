/**
 * @file pianola-orchestrator.test.ts
 * @description Tests for the pure Pianola orchestration engine: DAG-driven
 * dispatch, concurrency capping, completion/failure settling, blocked cascade,
 * agent/dispatch retry, persistence, and prevStates carry-across.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	initialOrchestratorState,
	runOrchestratorIteration,
	type OrchestratorDeps,
	type OrchestratorState,
} from '../../../shared/pianola/pianola-orchestrator';
import type { AgentRunState } from '../../../shared/pianola/pianola-completion-detector';
import type { PianolaPlan, PianolaTask } from '../../../shared/pianola/pianola-tasks';
import type { PianolaMessage } from '../../../shared/pianola/types';

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

let seq = 0;
function msg(role: PianolaMessage['role'], content: string): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	};
}

/**
 * Build orchestrator deps wired to simple in-memory fakes. `runStates` maps a task
 * id to the run state getRunState should return for it; `messages` maps a task id
 * to its recent transcript tail. Both default to a working ('busy') agent with no
 * output, so an unconfigured running task stays running.
 */
function makeDeps(
	config: {
		runStates?: Record<string, AgentRunState>;
		messages?: Record<string, readonly PianolaMessage[]>;
		ensureAgent?: OrchestratorDeps['ensureAgent'];
		dispatch?: OrchestratorDeps['dispatch'];
		notify?: OrchestratorDeps['notify'];
	} = {}
): OrchestratorDeps {
	const runStates = config.runStates ?? {};
	const messages = config.messages ?? {};
	return {
		getRunState: vi.fn(async (t: PianolaTask) => runStates[t.id] ?? 'busy'),
		getRecentMessages: vi.fn(async (t: PianolaTask) => messages[t.id] ?? []),
		ensureAgent:
			config.ensureAgent ??
			vi.fn(async (t: PianolaTask) => ({
				agentId: t.agentId ?? `agent-${t.id}`,
				agentType: t.agentType ?? 'claude-code',
			})),
		dispatch: config.dispatch ?? vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
		persist: vi.fn(),
		log: vi.fn(),
		notify: config.notify,
	};
}

function statusOf(state: OrchestratorState, id: string): string | undefined {
	return state.plan.tasks.find((t) => t.id === id)?.status;
}

describe('runOrchestratorIteration - linear A->B->C', () => {
	it('runs to completion across iterations, respecting dependency order', async () => {
		const p = plan([
			task({ id: 'A', dependsOn: [] }),
			task({ id: 'B', dependsOn: ['A'] }),
			task({ id: 'C', dependsOn: ['B'] }),
		]);
		let state = initialOrchestratorState(p);

		// Iteration 1: only A is ready, so only A is dispatched.
		let deps = makeDeps();
		let r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.dispatchedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(statusOf(r.state, 'B')).toBe('pending');
		expect(statusOf(r.state, 'C')).toBe('pending');
		expect(r.done).toBe(false);
		state = r.state;

		// Iteration 2: A completes (busy -> idle); B becomes ready and dispatches.
		deps = makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'A done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['A']);
		expect(r.dispatchedTaskIds).toEqual(['B']);
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(statusOf(r.state, 'B')).toBe('running');
		expect(statusOf(r.state, 'C')).toBe('pending');
		state = r.state;

		// Iteration 3: B completes; C dispatches.
		deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'B done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['B']);
		expect(r.dispatchedTaskIds).toEqual(['C']);
		expect(statusOf(r.state, 'C')).toBe('running');
		expect(r.done).toBe(false);
		state = r.state;

		// Iteration 4: C completes; plan is done.
		deps = makeDeps({ runStates: { C: 'idle' }, messages: { C: [msg('assistant', 'C done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['C']);
		expect(statusOf(r.state, 'C')).toBe('done');
		expect(r.done).toBe(true);
		expect(r.progress.complete).toBe(true);
		expect(r.progress.done).toBe(3);
	});

	it('does not dispatch B before A is done', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const state = initialOrchestratorState(p);
		// A is still busy after iteration 1.
		const r1 = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		// A still busy: it stays running, B stays pending.
		const r2 = await runOrchestratorIteration(r1.state, makeDeps(), { concurrencyLimit: 5 });
		expect(statusOf(r2.state, 'A')).toBe('running');
		expect(statusOf(r2.state, 'B')).toBe('pending');
		expect(r2.dispatchedTaskIds).toEqual([]);
	});
});

describe('runOrchestratorIteration - concurrency', () => {
	it('caps simultaneous running tasks at concurrencyLimit', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
		const state = initialOrchestratorState(p);
		const deps = makeDeps();
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
		expect(r.dispatchedTaskIds).toHaveLength(2);
		expect(r.progress.running).toBe(2);
		expect(r.progress.pending).toBe(1);
		// dispatch was called exactly twice, never for the third task this tick.
		expect(deps.dispatch).toHaveBeenCalledTimes(2);
	});

	it('fills a freed slot on the next iteration as running tasks complete', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: A and B run, C waits.
		let r = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 2 });
		expect(r.dispatchedTaskIds).toHaveLength(2);
		state = r.state;

		// Iteration 2: A completes, freeing a slot; C dispatches; B keeps running.
		const deps = makeDeps({
			runStates: { A: 'idle', B: 'busy' },
			messages: { A: [msg('assistant', 'A done.')] },
		});
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
		expect(r.completedTaskIds).toEqual(['A']);
		expect(r.dispatchedTaskIds).toEqual(['C']);
		expect(r.progress.running).toBe(2);
	});
});

describe('runOrchestratorIteration - failure and blocking', () => {
	it('marks a task failed, fires notify, and blocks its dependents', async () => {
		const p = plan([
			task({ id: 'A', status: 'running', agentId: 'agent-A' }),
			task({ id: 'B', dependsOn: ['A'] }),
			task({ id: 'C', dependsOn: ['B'] }),
		]);
		const state = initialOrchestratorState(p);
		const notify = vi.fn(async () => {});
		// A enters error state -> failed.
		const deps = makeDeps({ runStates: { A: 'error' }, notify });
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });

		expect(r.failedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('failed');
		// Dependents cascade to blocked.
		expect(statusOf(r.state, 'B')).toBe('blocked');
		expect(statusOf(r.state, 'C')).toBe('blocked');
		// Notify fired once with the failed task.
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith({
			kind: 'task_failed',
			task: expect.objectContaining({ id: 'A', status: 'failed' }),
		});
		// Plan is complete: nothing left that can run.
		expect(r.done).toBe(true);
		expect(r.progress.failed).toBe(1);
		expect(r.progress.blocked).toBe(2);
	});

	it('captures the failure reason as the task error', async () => {
		const p = plan([task({ id: 'A', status: 'running', agentId: 'agent-A' })]);
		const state = initialOrchestratorState(p);
		const deps = makeDeps({
			runStates: { A: 'idle' },
			messages: { A: [msg('error', 'fatal error: build broke')] },
		});
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('failed');
		const failed = r.state.plan.tasks.find((t) => t.id === 'A');
		expect(failed?.error).toBeTruthy();
	});

	it('does not throw when notify rejects', async () => {
		const p = plan([task({ id: 'A', status: 'running', agentId: 'agent-A' })]);
		const state = initialOrchestratorState(p);
		const notify = vi.fn(async () => {
			throw new Error('toast backend down');
		});
		const deps = makeDeps({ runStates: { A: 'error' }, notify });
		const r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('failed');
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

describe('runOrchestratorIteration - agent and dispatch failures', () => {
	it('leaves a task pending when ensureAgent errors, then dispatches once it succeeds', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: ensureAgent fails -> A stays pending, dispatch never called.
		const failingEnsure = vi.fn(async () => ({ error: 'no capacity' }));
		const dispatch1 = vi.fn(async () => ({ success: true, tabId: 'tab-1' }));
		let r = await runOrchestratorIteration(
			state,
			makeDeps({ ensureAgent: failingEnsure, dispatch: dispatch1 }),
			{ concurrencyLimit: 5 }
		);
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(r.dispatchedTaskIds).toEqual([]);
		expect(dispatch1).not.toHaveBeenCalled();
		state = r.state;

		// Iteration 2: ensureAgent succeeds -> A dispatches.
		r = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(r.dispatchedTaskIds).toEqual(['A']);
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentType).toBe('claude-code');
	});

	it('leaves a task pending when dispatch fails without permanently consuming a slot', async () => {
		// A's dispatch fails; B should still take the slot in the same iteration.
		const p = plan([task({ id: 'A' }), task({ id: 'B' })]);
		const state = initialOrchestratorState(p);
		const dispatch = vi.fn(async (t: PianolaTask) =>
			t.id === 'A' ? { success: false, error: 'agent busy' } : { success: true, tabId: 'tab-B' }
		);
		const r = await runOrchestratorIteration(state, makeDeps({ dispatch }), {
			concurrencyLimit: 1,
		});
		// A failed to dispatch (stays pending), B consumed the single slot.
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(statusOf(r.state, 'B')).toBe('running');
		expect(r.dispatchedTaskIds).toEqual(['B']);
		expect(r.progress.running).toBe(1);
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentType).toBe('claude-code');
	});

	it('retries a dispatch failure on the next iteration', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);
		let attempt = 0;
		const dispatch = vi.fn(async () => {
			attempt += 1;
			return attempt === 1
				? { success: false, error: 'transient' }
				: { success: true, tabId: 'tab-1' };
		});
		// First tick: dispatch fails, A stays pending.
		let r = await runOrchestratorIteration(state, makeDeps({ dispatch }), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('pending');
		state = r.state;
		// Second tick: same dispatch fake now succeeds.
		r = await runOrchestratorIteration(state, makeDeps({ dispatch }), { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('running');
	});
});

describe('runOrchestratorIteration - persistence and progress', () => {
	it('calls persist once per iteration with the updated plan', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const deps = makeDeps();
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(deps.persist).toHaveBeenCalledTimes(1);
		// persist receives the final plan for this iteration (A now running).
		expect(deps.persist).toHaveBeenCalledWith(r.state.plan);
		expect(statusOf(r.state, 'A')).toBe('running');
	});

	it('flips done true only when all tasks are terminal or blocked', async () => {
		const p = plan([task({ id: 'A', status: 'done' }), task({ id: 'B', status: 'running' })]);
		const state = initialOrchestratorState(p);
		// B still busy: not done.
		const r1 = await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(r1.done).toBe(false);
		// B completes: now done.
		const deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'ok')] } });
		const r2 = await runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
		expect(r2.done).toBe(true);
	});

	it('does not mutate the input state or plan', async () => {
		const p = plan([task({ id: 'A' })]);
		const state = initialOrchestratorState(p);
		const snapshot = JSON.parse(JSON.stringify(state));
		await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
		expect(state).toEqual(snapshot);
	});
});

describe('runOrchestratorIteration - prevStates carry-across', () => {
	it('detects a busy->idle transition using prevStates from the prior iteration', async () => {
		const p = plan([task({ id: 'A' })]);
		let state = initialOrchestratorState(p);

		// Iteration 1: A dispatched. It is seeded 'connecting' (its just-spun-up
		// state) so the next poll has a working state to compare against.
		let r = await runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
			concurrencyLimit: 5,
		});
		expect(r.state.prevStates.A).toBe('connecting');
		expect(statusOf(r.state, 'A')).toBe('running');
		state = r.state;

		// Iteration 2: A now idle. The carried prev state ('connecting') makes this a
		// working->idle transition, so the task is detected done.
		r = await runOrchestratorIteration(
			state,
			makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'finished')] } }),
			{ concurrencyLimit: 5 }
		);
		expect(r.completedTaskIds).toEqual(['A']);
		expect(statusOf(r.state, 'A')).toBe('done');
	});

	it('only carries forward run states observed this iteration', async () => {
		const p = plan([task({ id: 'A', status: 'running' }), task({ id: 'B', status: 'done' })]);
		const state: OrchestratorState = {
			plan: p,
			prevStates: { A: 'busy', B: 'idle' },
		};
		const r = await runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
			concurrencyLimit: 5,
		});
		// Only A is polled (running), so prevStates holds A only; B's stale entry drops.
		expect(r.state.prevStates).toEqual({ A: 'busy' });
	});
});

describe('runOrchestratorIteration - dispatch failure does not leak agents', () => {
	it('persists the bound agent on a failed dispatch so the retry reuses it', async () => {
		const p = plan([task({ id: 'A' })]);
		let created = 0;
		const ensureAgent: OrchestratorDeps['ensureAgent'] = vi.fn(async (t: PianolaTask) => {
			if (t.agentId) return { agentId: t.agentId };
			created += 1;
			return { agentId: `created-${created}` };
		});
		let failNext = true;
		const dispatch: OrchestratorDeps['dispatch'] = vi.fn(async () => {
			if (failNext) {
				failNext = false;
				return { success: false, error: 'transient' };
			}
			return { success: true, tabId: 'tab-1' };
		});

		let state = initialOrchestratorState(p);
		let r = await runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
			concurrencyLimit: 1,
		});
		expect(statusOf(r.state, 'A')).toBe('pending');
		expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentId).toBe('created-1');
		state = r.state;

		r = await runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
			concurrencyLimit: 1,
		});
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(created).toBe(1);
	});
});
