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
		persist?: OrchestratorDeps['persist'];
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
		persist: config.persist ?? vi.fn(),
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

		state = (await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
		// Iteration 2: A completes (busy -> idle); B becomes ready and dispatches.
		deps = makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'A done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['A']);
		expect(r.dispatchedTaskIds).toEqual(['B']);
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(statusOf(r.state, 'B')).toBe('running');
		expect(statusOf(r.state, 'C')).toBe('pending');
		state = r.state;

		state = (await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
		// Iteration 3: B completes; C dispatches.
		deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'B done.')] } });
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(r.completedTaskIds).toEqual(['B']);
		expect(r.dispatchedTaskIds).toEqual(['C']);
		expect(statusOf(r.state, 'C')).toBe('running');
		expect(r.done).toBe(false);
		state = r.state;

		state = (await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
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
	it('re-reads the program charter before every dispatch and keeps the CLI cap', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })], {
			programId: 'product',
		});
		let maxConcurrent = 3;
		const deps = makeDeps({
			dispatch: vi.fn(async () => {
				maxConcurrent = 1;
				return { success: true, tabId: 'tab-A' };
			}),
		});
		deps.getProgramCharter = () => ({ maxConcurrent, maxAttempts: 2, validationRequired: false });
		const result = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 3,
		});
		expect(result.dispatchedTaskIds).toEqual(['A']);
		maxConcurrent = 5;
		const capped = await runOrchestratorIteration(result.state, deps, { concurrencyLimit: 1 });
		expect(capped.dispatchedTaskIds).toEqual([]);
	});
	it('honors a lowered charter after an asynchronous agent/history lookup', async () => {
		const p = plan([task({ id: 'A', status: 'running' }), task({ id: 'B' })], {
			programId: 'product',
		});
		let maxConcurrent = 2;
		const deps = makeDeps({
			ensureAgent: async () => {
				maxConcurrent = 1;
				return { agentId: 'bound' };
			},
		});
		deps.getProgramCharter = () => ({ maxConcurrent, maxAttempts: 2, validationRequired: false });
		const result = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 3,
		});
		expect(deps.dispatch).not.toHaveBeenCalled();
		expect(result.state.plan.tasks[1]).toMatchObject({ status: 'pending', agentId: 'bound' });
	});
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

		state = (await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 2 })).state;
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
	it('persists the claim and confirmed receipt before the final plan', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const deps = makeDeps();
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(deps.persist).toHaveBeenCalledTimes(3);
		expect(vi.mocked(deps.persist).mock.calls[0][0].tasks[0]).toMatchObject({
			status: 'running',
			agentId: 'agent-A',
		});
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

		// Dispatch records delivery without inventing a process state.
		let r = await runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
			concurrencyLimit: 5,
		});
		expect(r.state.prevStates.A).toBeUndefined();
		expect(statusOf(r.state, 'A')).toBe('running');
		state = r.state;

		state = (await runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
		// A real busy observation followed by idle can settle the legacy adapter.
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
	it('retains the ensured agent and tab when the pre-dispatch boundary read fails', async () => {
		const deps = makeDeps();
		deps.ensureAgent = vi.fn(async () => ({ agentId: 'created-agent', tabId: 'target-tab' }));
		deps.getRecentMessages = vi.fn(async () => {
			throw new Error('history unavailable');
		});
		const result = await runOrchestratorIteration(initialOrchestratorState(plan([task()])), deps, {
			concurrencyLimit: 1,
		});
		expect(result.state.plan.tasks[0]).toMatchObject({
			status: 'pending',
			agentId: 'created-agent',
			tabId: 'target-tab',
		});
		expect(deps.dispatch).not.toHaveBeenCalled();
		expect(deps.persist).toHaveBeenCalledWith(result.state.plan);
	});
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
	it('persists the claim and accepted dispatch before starting the next task', async () => {
		const persisted: PianolaPlan[] = [];
		let dispatchCalls = 0;
		const deps = makeDeps({
			dispatch: vi.fn(async () => {
				dispatchCalls += 1;
				if (dispatchCalls === 2) expect(persisted).toHaveLength(3);
				return { success: true, tabId: 'tab-1' };
			}),
			persist: vi.fn((plan) => {
				persisted.push(structuredClone(plan));
			}),
		});
		await runOrchestratorIteration(
			initialOrchestratorState(plan([task({ id: 'A' }), task({ id: 'B' })])),
			deps,
			{ concurrencyLimit: 2 }
		);
		expect(persisted).toHaveLength(5);
		expect(persisted[0].tasks.find((task) => task.id === 'A')?.status).toBe('running');
		expect(persisted[1].tasks.find((task) => task.id === 'A')?.status).toBe('running');
		expect(persisted[1].tasks.find((task) => task.id === 'B')?.status).toBe('pending');
		expect(persisted[3].tasks.find((task) => task.id === 'B')?.status).toBe('running');
	});
});

describe('independent oracle settlement', () => {
	const validation = { command: ['sh', '-c', 'true'], target: '/tmp/work' };
	it.each(['verified', 'failed'] as const)(
		'resets transient unknown attempts after %s',
		async (verdict) => {
			const deps = makeDeps({ runStates: { t1: 'idle' } });
			deps.validate = vi.fn(async () => ({ verdict, reason: 'oracle result' }));
			deps.getRunLedger = vi.fn(async () => ({ checksPassed: verdict === 'verified' }));
			const result = await runOrchestratorIteration(
				{
					plan: plan([task({ status: 'running', validation, validationUnknownAttempts: 1 })]),
					prevStates: {},
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			expect(result.state.plan.tasks[0].validationUnknownAttempts).toBe(0);
		}
	);
	it('does not settle an unknown oracle using unrelated passing checks or dispatch candidate fixes', async () => {
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => ({ verdict: 'unknown', reason: 'sandbox unavailable' }));
		deps.getRunLedger = vi.fn(async () => ({ checksPassed: true, openFindings: 0 }));
		deps.reactiveEnabled = () => true;
		deps.dispatchFix = vi.fn(async () => ({ success: true }));
		deps.requestMerge = vi.fn(async () => ({ merged: true }));
		const first = await runOrchestratorIteration(
			{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		const second = await runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
		expect(statusOf(second.state, 't1')).toBe('needs_review');
		expect(deps.requestMerge).not.toHaveBeenCalled();
		deps.getRunLedger = vi.fn(async () => ({ checksPassed: false }));
		await runOrchestratorIteration(second.state, deps, { concurrencyLimit: 1 });
		expect(deps.dispatchFix).not.toHaveBeenCalled();
	});
	it('routes a failed verdict to review even without a ledger reader', async () => {
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => ({ verdict: 'failed', reason: 'assertion failed' }));
		const result = await runOrchestratorIteration(
			{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(result.state, 't1')).toBe('needs_review');
		expect(result.completedTaskIds).toEqual([]);
	});
	it('does not claim required validation passed when no validator is wired', async () => {
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.getProgramCharter = () => ({ validationRequired: true, maxAttempts: 3 });
		deps.getRunLedger = vi.fn(async () => ({ checksPassed: true, openFindings: 0 }));
		deps.reactiveEnabled = () => true;
		const result = await runOrchestratorIteration(
			{
				plan: plan([task({ status: 'running', validation })], { programId: 'p' }),
				prevStates: { t1: 'busy' },
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(result.state, 't1')).toBe('needs_review');
	});
	it('validates before reading the ledger and completes only on green', async () => {
		let checked = false;
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => {
			checked = true;
			return { verdict: 'verified', reason: 'passed' };
		});
		deps.getRunLedger = vi.fn(async () => ({ runId: 'run-1', checksPassed: checked }));
		const result = await runOrchestratorIteration(
			{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(result.state, 't1')).toBe('done');
		expect(deps.validate).toHaveBeenCalledTimes(1);
	});
	it('routes failed checks into a bounded fix cycle', async () => {
		let green = false;
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => {
			green = !green;
			return { verdict: green ? 'failed' : 'verified', reason: 'oracle result' };
		});
		deps.getRunLedger = vi.fn(async () => ({ runId: 'run-1', checksPassed: !green }));
		deps.reactiveEnabled = () => true;
		deps.dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
		const initial = {
			plan: plan([task({ status: 'running', validation })]),
			prevStates: { t1: 'busy' as const },
		};
		const first = await runOrchestratorIteration(initial, deps, { concurrencyLimit: 1 });
		expect(statusOf(first.state, 't1')).toBe('fixing');
		expect(deps.dispatchFix).toHaveBeenCalledTimes(1);
		const second = await runOrchestratorIteration(
			{ ...first.state, prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(second.state, 't1')).toBe('done');
	});
	it('retries unknown once while idle then requests review with its reason', async () => {
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => ({ verdict: 'unknown', reason: 'bubblewrap unavailable' }));
		deps.getRunLedger = vi.fn(async () => ({ runId: 'run-1', checksPassed: false }));
		const first = await runOrchestratorIteration(
			{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(first.state, 't1')).toBe('running');
		const second = await runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
		expect(statusOf(second.state, 't1')).toBe('needs_review');
		expect(second.state.plan.tasks[0].error).toBe('bubblewrap unavailable');
	});
	it('does not re-settle a fixing task on an idle tick after an unknown validation', async () => {
		// The fix agent has been dispatched but not started yet: idle must not count as done,
		// or every tick would burn a fix attempt without any fix run being observed.
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => ({ verdict: 'failed', reason: 'exit 1' }));
		const result = await runOrchestratorIteration(
			{
				plan: plan([
					task({ status: 'fixing', validation, validationUnknownAttempts: 1, fixAttempts: 1 }),
				]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(result.state, 't1')).toBe('fixing');
		expect(deps.validate).not.toHaveBeenCalled();
	});
	it('never invokes validation for a task without a spec', async () => {
		const deps = makeDeps({ runStates: { t1: 'idle' } });
		deps.validate = vi.fn(async () => ({ verdict: 'verified', reason: 'ok' }));
		await runOrchestratorIteration(
			{ plan: plan([task({ status: 'running' })]), prevStates: { t1: 'busy' } },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(deps.validate).not.toHaveBeenCalled();
	});
});

describe('program charter validation requirement', () => {
	it.each([true, false, undefined])(
		'respects validationRequired=%s for a task without an oracle',
		async (validationRequired) => {
			const deps = makeDeps({ runStates: { t1: 'idle' } });
			deps.getProgramCharter = vi.fn(() =>
				validationRequired === undefined ? undefined : { validationRequired, maxAttempts: 3 }
			);
			deps.reactiveEnabled = () => true;
			deps.getRunLedger = vi.fn(async () => ({ checksPassed: true, openFindings: 0 }));
			deps.requestMerge = vi.fn(async () => ({ merged: true }));
			const result = await runOrchestratorIteration(
				{
					plan: plan([task({ status: 'running' })], { programId: 'program-1' }),
					prevStates: { t1: 'busy' },
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			expect(statusOf(result.state, 't1')).toBe(validationRequired ? 'needs_review' : 'done');
			if (validationRequired) {
				expect(result.state.plan.tasks[0].error).toBe(
					'validation required by program charter but task declares none'
				);
				expect(deps.requestMerge).not.toHaveBeenCalled();
			}
		}
	);
});

/**
 * Grok tasks through the generic engine. The engine never names a
 * provider; the agent type comes from ensureAgent and is written onto the
 * task as returned, so these prove Grok is routed, settled, retried, failed,
 * and stopped by the same rules as a sibling, and that a refusal (an
 * unavailable Grok, a required capability Grok lacks) leaves the task pending
 * with no other provider substituted.
 */
describe('runOrchestratorIteration with Grok agents', () => {
	const grokEnsure = (): OrchestratorDeps['ensureAgent'] =>
		vi.fn(async (t: PianolaTask) => ({
			agentId: t.agentId ?? `grok-${t.id}`,
			agentType: t.agentType ?? 'grok',
		}));
	const taskOf = (state: OrchestratorState, id: string) =>
		state.plan.tasks.find((t) => t.id === id);

	it('dispatches a ready task to the Grok agent ensureAgent binds and records its type and tab', async () => {
		const dispatch = vi.fn(async () => ({ success: true, tabId: 'grok-tab-1' }));
		const deps = makeDeps({ ensureAgent: grokEnsure(), dispatch });
		const r = await runOrchestratorIteration(
			initialOrchestratorState(plan([task({ id: 'A' })])),
			deps,
			{
				concurrencyLimit: 2,
			}
		);
		expect(r.dispatchedTaskIds).toEqual(['A']);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), 'grok-A');
		expect(taskOf(r.state, 'A')).toMatchObject({
			status: 'running',
			agentId: 'grok-A',
			agentType: 'grok',
			tabId: 'grok-tab-1',
		});
		expect(deps.log).toHaveBeenCalledWith('[orchestrator] task "A" dispatched to agent "grok-A"');
	});

	it('routes each task to its own provider and caps concurrency across Grok and siblings', async () => {
		const ensureAgent: OrchestratorDeps['ensureAgent'] = vi.fn(async (t: PianolaTask) =>
			t.id === 'C'
				? { agentId: 'claude-C', agentType: 'claude-code' }
				: { agentId: `grok-${t.id}`, agentType: 'grok' }
		);
		const p = plan([task({ id: 'C' }), task({ id: 'G1' }), task({ id: 'G2' })]);
		const r = await runOrchestratorIteration(
			initialOrchestratorState(p),
			makeDeps({ ensureAgent }),
			{
				concurrencyLimit: 2,
			}
		);
		expect(r.dispatchedTaskIds).toEqual(['C', 'G1']);
		expect(taskOf(r.state, 'C')?.agentType).toBe('claude-code');
		expect(taskOf(r.state, 'G1')).toMatchObject({ agentType: 'grok', agentId: 'grok-G1' });
		expect(taskOf(r.state, 'G2')).toMatchObject({ status: 'pending' });
		expect(taskOf(r.state, 'G2')?.agentType).toBeUndefined();
		expect(ensureAgent).toHaveBeenCalledTimes(2);
	});

	it('settles a Grok task done on its working-to-idle transition and dispatches its dependent', async () => {
		const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
		const r1 = await runOrchestratorIteration(
			initialOrchestratorState(p),
			makeDeps({ ensureAgent: grokEnsure() }),
			{ concurrencyLimit: 2 }
		);
		const r2 = await runOrchestratorIteration(
			r1.state,
			makeDeps({
				ensureAgent: grokEnsure(),
				runStates: { A: 'idle' },
				messages: { A: [msg('assistant', 'Grok finished the change.')] },
			}),
			{ concurrencyLimit: 2 }
		);
		expect(r2.completedTaskIds).toEqual(['A']);
		expect(taskOf(r2.state, 'A')).toMatchObject({ status: 'done', agentType: 'grok' });
		expect(taskOf(r2.state, 'B')).toMatchObject({ status: 'running', agentType: 'grok' });
	});

	it('leaves the task pending with no provider bound when Grok is unavailable or lacks a required capability', async () => {
		const refusals = [
			'grok is auth_required',
			'no ready, capable agent for task "A": every candidate is busy, unready, or lacks a required capability',
		];
		for (const error of refusals) {
			const ensureAgent = vi.fn(async () => ({ error }));
			const dispatch = vi.fn(async () => ({ success: true, tabId: 'never' }));
			const deps = makeDeps({ ensureAgent, dispatch });
			const r = await runOrchestratorIteration(
				initialOrchestratorState(plan([task({ id: 'A' })])),
				deps,
				{
					concurrencyLimit: 2,
				}
			);
			expect(dispatch).not.toHaveBeenCalled();
			expect(r.dispatchedTaskIds).toEqual([]);
			expect(taskOf(r.state, 'A')).toEqual(task({ id: 'A' }));
			expect(deps.log).toHaveBeenCalledWith(
				`[orchestrator] task "A" pending (ensureAgent: ${error})`
			);
		}
	});

	it('keeps the Grok binding on a failed dispatch so the retry reuses the same Grok session', async () => {
		const ensureAgent = grokEnsure();
		let calls = 0;
		const dispatch = vi.fn(async () =>
			++calls === 1
				? { success: false, error: 'grok session busy' }
				: { success: true, tabId: 'g-tab' }
		);
		const r1 = await runOrchestratorIteration(
			initialOrchestratorState(plan([task({ id: 'A' })])),
			makeDeps({ ensureAgent, dispatch }),
			{ concurrencyLimit: 1 }
		);
		expect(taskOf(r1.state, 'A')).toMatchObject({
			status: 'pending',
			agentId: 'grok-A',
			agentType: 'grok',
		});
		const r2 = await runOrchestratorIteration(r1.state, makeDeps({ ensureAgent, dispatch }), {
			concurrencyLimit: 1,
		});
		expect(ensureAgent).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'A', agentId: 'grok-A', agentType: 'grok' })
		);
		expect(dispatch).toHaveBeenLastCalledWith(expect.anything(), 'grok-A');
		expect(taskOf(r2.state, 'A')).toMatchObject({
			status: 'running',
			agentType: 'grok',
			tabId: 'g-tab',
		});
	});

	it('fails a Grok task whose agent errors, notifies, blocks dependents, and keeps the binding', async () => {
		const notify = vi.fn(async () => {});
		const p = plan([
			task({ id: 'A', status: 'running', agentId: 'grok-A', agentType: 'grok', tabId: 'g' }),
			task({ id: 'B', dependsOn: ['A'] }),
		]);
		const r = await runOrchestratorIteration(
			initialOrchestratorState(p),
			makeDeps({ ensureAgent: grokEnsure(), runStates: { A: 'error' }, notify }),
			{ concurrencyLimit: 2 }
		);
		expect(r.failedTaskIds).toEqual(['A']);
		expect(taskOf(r.state, 'A')).toMatchObject({
			status: 'failed',
			agentId: 'grok-A',
			agentType: 'grok',
			error: 'agent entered error state',
		});
		expect(taskOf(r.state, 'B')?.status).toBe('blocked');
		expect(notify).toHaveBeenCalledWith({
			kind: 'task_failed',
			task: expect.objectContaining({ id: 'A', agentType: 'grok', status: 'failed' }),
		});
	});

	it('fails, never completes, a Grok turn that was stopped and reported an error before going idle', async () => {
		const p = plan([task({ id: 'A', status: 'running', agentId: 'grok-A', agentType: 'grok' })]);
		const state: OrchestratorState = { plan: p, prevStates: { A: 'busy' } };
		const r = await runOrchestratorIteration(
			state,
			makeDeps({
				runStates: { A: 'idle' },
				messages: {
					A: [msg('assistant', 'Working on it.'), msg('error', 'Grok turn cancelled by the user')],
				},
			}),
			{ concurrencyLimit: 2 }
		);
		expect(r.completedTaskIds).toEqual([]);
		expect(taskOf(r.state, 'A')).toMatchObject({
			status: 'failed',
			agentType: 'grok',
			error: 'failure marker found in recent output',
		});
	});

	it('keeps a Grok task running while it waits on the user and dispatches nothing new into its slot', async () => {
		const p = plan([
			task({ id: 'A', status: 'running', agentId: 'grok-A', agentType: 'grok' }),
			task({ id: 'B' }),
		]);
		const ensureAgent = grokEnsure();
		const r = await runOrchestratorIteration(
			{ plan: p, prevStates: { A: 'busy' } },
			makeDeps({ ensureAgent, runStates: { A: 'waiting_input' } }),
			{ concurrencyLimit: 1 }
		);
		expect(taskOf(r.state, 'A')?.status).toBe('running');
		expect(r.state.prevStates.A).toBe('waiting_input');
		expect(ensureAgent).not.toHaveBeenCalled();
		expect(taskOf(r.state, 'B')?.status).toBe('pending');
	});

	it('dispatches to the Grok session ensureAgent returns when the pinned one is gone, and rebinds the task', async () => {
		const ensureAgent: OrchestratorDeps['ensureAgent'] = vi.fn(async () => ({
			agentId: 'grok-fresh',
			agentType: 'grok',
		}));
		const dispatch = vi.fn(async () => ({ success: true, tabId: 'fresh-tab' }));
		const p = plan([task({ id: 'A', agentId: 'grok-closed', agentType: 'grok' })]);
		const r = await runOrchestratorIteration(
			initialOrchestratorState(p),
			makeDeps({ ensureAgent, dispatch }),
			{ concurrencyLimit: 1 }
		);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), 'grok-fresh');
		expect(taskOf(r.state, 'A')).toMatchObject({
			status: 'running',
			agentId: 'grok-fresh',
			agentType: 'grok',
			tabId: 'fresh-tab',
		});
	});
});
