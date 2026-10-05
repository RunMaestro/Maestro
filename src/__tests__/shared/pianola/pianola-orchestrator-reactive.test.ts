/**
 * @file pianola-orchestrator-reactive.test.ts
 * @description Tests for the F8 reactive loop inside runOrchestratorIteration:
 * the reactiveEnabled master gate (supervisor parity when off, ISC-8.13), the
 * ledger-driven settle of a running task to needs_review on open critical/high
 * findings (ISC-8.4), the green-task merge-once-then-done path with no repeat
 * merge (ISC-8.14), and the bounded auto-fix cycle that escalates a task to
 * failed after MAX_FIX_ATTEMPTS (ISC-8.8). The non-reactive engine (DAG dispatch,
 * concurrency, blocked cascade, persistence) is covered in pianola-orchestrator.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	initialOrchestratorState,
	runOrchestratorIteration,
	type OrchestratorDeps,
	type OrchestratorState,
	type PianolaTaskLedger,
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

interface ReactiveConfig {
	runStates?: Record<string, AgentRunState>;
	messages?: Record<string, readonly PianolaMessage[]>;
	reactiveEnabled?: OrchestratorDeps['reactiveEnabled'];
	getRunLedger?: OrchestratorDeps['getRunLedger'];
	dispatchFix?: OrchestratorDeps['dispatchFix'];
	requestMerge?: OrchestratorDeps['requestMerge'];
	notify?: OrchestratorDeps['notify'];
}

/**
 * Deps with the reactive-loop side effects injectable. Defaults: a running task
 * is observed idle (so a working->idle transition settles it), no transcript
 * (no failure marker), and NO reactive gate wired unless the test wires one.
 */
function makeReactiveDeps(config: ReactiveConfig = {}): OrchestratorDeps {
	const runStates = config.runStates ?? {};
	const messages = config.messages ?? {};
	return {
		getRunState: vi.fn(async (t: PianolaTask) => runStates[t.id] ?? 'idle'),
		getRecentMessages: vi.fn(async (t: PianolaTask) => messages[t.id] ?? []),
		ensureAgent: vi.fn(async (t: PianolaTask) => ({
			agentId: t.agentId ?? `agent-${t.id}`,
			agentType: 'claude-code',
		})),
		dispatch: vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
		persist: vi.fn(),
		log: vi.fn(),
		notify: config.notify,
		reactiveEnabled: config.reactiveEnabled,
		getRunLedger: config.getRunLedger,
		dispatchFix: config.dispatchFix,
		requestMerge: config.requestMerge,
	};
}

function statusOf(state: OrchestratorState, id: string): string | undefined {
	return state.plan.tasks.find((t) => t.id === id)?.status;
}

function taskOf(state: OrchestratorState, id: string): PianolaTask | undefined {
	return state.plan.tasks.find((t) => t.id === id);
}

/** A running task observed working last tick, so getRunState 'idle' this tick settles it. */
function runningState(t: PianolaTask): OrchestratorState {
	return { plan: plan([t]), prevStates: { [t.id]: 'busy' } };
}

// ---------------------------------------------------------------------------
// ISC-8.13 - reactiveEnabled master gate: supervisor parity when off/absent
// ---------------------------------------------------------------------------

describe('reactiveEnabled gate (ISC-8.13)', () => {
	it('leaves a needs_review task untouched when reactiveEnabled returns false', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review' })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => false,
			// A fully-green ledger AND open-finding ledger would BOTH trigger action
			// if the gate were open; with it closed, neither dep may fire.
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			dispatchFix,
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf(r.state, 'A')).toBe('needs_review');
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(requestMerge).not.toHaveBeenCalled();
		expect(r.completedTaskIds).toEqual([]);
	});

	it('leaves a needs_review task untouched when reactiveEnabled is absent', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review' })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const deps = makeReactiveDeps({
			// reactiveEnabled omitted entirely.
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			dispatchFix,
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf(r.state, 'A')).toBe('needs_review');
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(requestMerge).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// ISC-8.14 - green task merges once then settles done; never re-merges
// ---------------------------------------------------------------------------

describe('green task merge + settle (ISC-8.14)', () => {
	it('requests a merge once, settles to done, and does not re-merge next iteration', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const ledger: PianolaTaskLedger = { openFindings: 0, checksPassed: true, runId: 'r-A' };
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			requestMerge,
		});

		// Iteration 1: green -> merge requested once, task settles to done.
		const r1 = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(requestMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), ledger);
		expect(statusOf(r1.state, 'A')).toBe('done');
		expect(r1.completedTaskIds).toEqual(['A']);

		// Iteration 2: the task is now terminal (done); the needs_review filter
		// skips it, so NO second merge is requested - proves the no-repeat-merge fix.
		const r2 = await runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(statusOf(r2.state, 'A')).toBe('done');
		expect(r2.completedTaskIds).toEqual([]);
	});

	it('settles to done even when the merge is not performed (recorded, never re-attempted)', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: false, error: 'not mergeable' }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
			requestMerge,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).toHaveBeenCalledTimes(1);
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
	});

	it('does not treat a task with open findings as green (no merge)', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const requestMerge = vi.fn(async () => ({ merged: true }));
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			// checks pass but a finding is still open -> NOT fully green.
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: true, runId: 'r-A' })),
			requestMerge,
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(requestMerge).not.toHaveBeenCalled();
		// Falls through to the fix cycle instead.
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf(r.state, 'A')).toBe('fixing');
	});
});

// ---------------------------------------------------------------------------
// ISC-8.8 - bounded auto-fix: dispatch, increment, escalate at the cap
// ---------------------------------------------------------------------------

describe('bounded auto-fix cycle (ISC-8.8)', () => {
	it('dispatches a fix for an open-findings task, moving it to fixing and incrementing fixAttempts', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
		const ledger: PianolaTaskLedger = { openFindings: 2, checksPassed: false, runId: 'r-A' };
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(dispatchFix).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), ledger);
		expect(statusOf(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(1);
	});

	it('leaves the task in needs_review (no increment) when the fix dispatch fails', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 1 })]);
		const dispatchFix = vi.fn(async () => ({ success: false, error: 'agent busy' }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf(r.state, 'A')).toBe('needs_review');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(1);
	});

	it('still dispatches a fix at fixAttempts 2 (just under the cap)', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 2 })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(dispatchFix).toHaveBeenCalledTimes(1);
		expect(statusOf(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);
	});

	it('escalates a still-needs_review task to failed at the cap, dispatching no further fix', async () => {
		const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 3 })]);
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const notify = vi.fn(async () => {});
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
			dispatchFix,
			notify,
		});
		const r = await runOrchestratorIteration(initialOrchestratorState(p), deps, {
			concurrencyLimit: 5,
		});
		expect(statusOf(r.state, 'A')).toBe('failed');
		expect(r.failedTaskIds).toEqual(['A']);
		expect(taskOf(r.state, 'A')?.error).toMatch(/fix loop exhausted/i);
		// The cap is a hard stop: no fix is dispatched for a task at the limit.
		expect(dispatchFix).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('accumulates fixAttempts across iterations and escalates on the fourth review', async () => {
		// Drive the real fixing<->needs_review cycle: each tick the fix agent is
		// seen going working->idle (prevStates seeded 'busy'), the ledger still has
		// open findings, so the task re-enters needs_review and the counter climbs.
		const ledger: PianolaTaskLedger = {
			openCriticalOrHighFindings: 1,
			openFindings: 1,
			checksPassed: false,
			runId: 'r-A',
		};
		const dispatchFix = vi.fn(async () => ({ success: true }));
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ledger),
			dispatchFix,
		});

		// Start already fixing (attempt 1 in flight), observed busy last tick.
		let state: OrchestratorState = {
			plan: plan([task({ id: 'A', status: 'fixing', runId: 'r-A', fixAttempts: 1 })]),
			prevStates: { A: 'busy' },
		};

		// Tick 1: fix finishes -> ledger not green -> needs_review -> dispatch fix (attempt 2).
		let r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(2);

		// Tick 2: same cycle -> attempt 3. Re-seed 'busy' (fix agent ran again).
		state = { plan: r.state.plan, prevStates: { A: 'busy' } };
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);

		// Tick 3: fix finishes, task re-enters needs_review at attempts 3 -> escalate.
		state = { plan: r.state.plan, prevStates: { A: 'busy' } };
		r = await runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('failed');
		expect(r.failedTaskIds).toEqual(['A']);

		// Exactly two more fix dispatches happened (attempts 2 and 3); the fourth
		// review escalated instead of dispatching a fifth.
		expect(dispatchFix).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// ISC-8.4 - a running task settles on its ledger, not busy->idle alone
// ---------------------------------------------------------------------------

describe('ledger-driven settle of a running task (ISC-8.4)', () => {
	it('routes a completed run with open critical/high findings to needs_review, not done', async () => {
		const t = task({ id: 'A', status: 'running', runId: 'r-A' });
		// reactiveEnabled OFF so the settled needs_review is not swept into the fix
		// cycle in the same tick - isolates the poll-time ledger gate.
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({ openCriticalOrHighFindings: 2, runId: 'r-A' })),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('needs_review');
		expect(r.completedTaskIds).toEqual([]);
		expect(taskOf(r.state, 'A')?.runId).toBe('r-A');
	});

	it('routes a completed run with failing checks to needs_review, not done', async () => {
		const t = task({ id: 'A', status: 'running', runId: 'r-A' });
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({
				openCriticalOrHighFindings: 0,
				checksPassed: false,
				runId: 'r-A',
			})),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('needs_review');
		expect(r.completedTaskIds).toEqual([]);
	});

	it('settles a completed run with a clean ledger to done', async () => {
		const t = task({ id: 'A', status: 'running', runId: 'r-A' });
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			getRunLedger: vi.fn(async () => ({
				openCriticalOrHighFindings: 0,
				checksPassed: true,
				runId: 'r-A',
			})),
		});
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
		expect(taskOf(r.state, 'A')?.runId).toBe('r-A');
	});

	it('settles to done when no ledger reader is wired (falls back to busy->idle)', async () => {
		const t = task({ id: 'A', status: 'running' });
		const deps = makeReactiveDeps({ runStates: { A: 'idle' } }); // no getRunLedger
		const r = await runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
		expect(statusOf(r.state, 'A')).toBe('done');
		expect(r.completedTaskIds).toEqual(['A']);
	});
});

describe('fix runs shorter than one poll interval', () => {
	const msg = (role: PianolaMessage['role'], content: string, i: number): PianolaMessage => ({
		id: `m${i}`,
		role,
		source: 'test',
		content,
		timestamp: new Date(1_700_000_000_000 + i).toISOString(),
	});

	it('records the last message id when a fix is dispatched', async () => {
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			messages: { A: [msg('user', 'task', 0), msg('assistant', 'done', 1)] },
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ runId: 'r-A', checksPassed: false, openFindings: 0 })),
			dispatchFix: vi.fn(async () => ({ success: true })),
		});
		const r = await runOrchestratorIteration(
			{ plan: plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]), prevStates: {} },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(r.state, 'A')).toBe('fixing');
		expect(taskOf(r.state, 'A')?.dispatchedMessageId).toBe('m1');
	});

	it('settles a fixing task that replied and went idle without ever being seen busy', async () => {
		// The fix agent started and finished between two polls. Rule 6 of the
		// detector sees only "idle, no transition"; the new reply is the completion.
		const validate = vi.fn(async () => ({ verdict: 'verified' as const, reason: 'ok' }));
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			messages: {
				A: [
					msg('user', 'task', 0),
					msg('assistant', 'done', 1),
					msg('user', 'fix', 2),
					msg('assistant', 'fixed', 3),
				],
			},
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ runId: 'r-A', checksPassed: true, openFindings: 0 })),
		});
		deps.validate = validate;
		const r = await runOrchestratorIteration(
			{
				plan: plan([
					task({
						id: 'A',
						status: 'fixing',
						runId: 'r-A',
						fixAttempts: 1,
						dispatchedMessageId: 'm2',
						validation: { command: ['true'], target: '/w' },
					}),
				]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(validate).toHaveBeenCalledOnce();
		expect(statusOf(r.state, 'A')).toBe('done');
	});

	it('keeps waiting while no reply has arrived since the fix was sent', async () => {
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			messages: { A: [msg('user', 'task', 0), msg('assistant', 'done', 1), msg('user', 'fix', 2)] },
			reactiveEnabled: () => true,
		});
		const r = await runOrchestratorIteration(
			{
				plan: plan([
					task({
						id: 'A',
						status: 'fixing',
						runId: 'r-A',
						fixAttempts: 1,
						dispatchedMessageId: 'm2',
					}),
				]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(r.state, 'A')).toBe('fixing');
	});
});

describe('outcome detection is scoped to the current dispatch', () => {
	const msg = (role: PianolaMessage['role'], content: string, i: number): PianolaMessage => ({
		id: `m${i}`,
		role,
		source: 'test',
		content,
		timestamp: new Date(1_700_000_000_000 + i).toISOString(),
	});

	it('ignores a failure marker from an earlier mission on the same agent tab', async () => {
		// The agent's tab holds every mission it ever ran. A traceback from last week's
		// task must not fail today's task, which replied cleanly after its dispatch.
		const deps = makeReactiveDeps({
			runStates: { A: 'idle' },
			messages: {
				A: [
					msg('user', 'old task', 0),
					msg('assistant', 'Traceback (most recent call last): boom', 1),
					msg('user', 'new task', 2),
					msg('assistant', 'Implemented on branch x; tests pass.', 3),
				],
			},
		});
		const r = await runOrchestratorIteration(
			{
				plan: plan([task({ id: 'A', status: 'running', dispatchedMessageId: 'm2' })]),
				prevStates: { A: 'busy' },
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(r.state, 'A')).toBe('done');
	});

	it('records where the transcript stood when a fresh task is dispatched', async () => {
		const deps = makeReactiveDeps({
			messages: {
				A: [msg('user', 'old', 0), msg('assistant', 'done', 1), msg('user', 'new task', 2)],
			},
		});
		const r = await runOrchestratorIteration(
			{ plan: plan([task({ id: 'A', status: 'pending' })]), prevStates: {} },
			deps,
			{ concurrencyLimit: 1 }
		);
		expect(statusOf(r.state, 'A')).toBe('running');
		expect(taskOf(r.state, 'A')?.dispatchedMessageId).toBe('m2');
	});
});

describe('program charter fix attempts', () => {
	it.each([
		[1, 1, 'failed', 1],
		[5, 3, 'fixing', 4],
	] as const)(
		'uses maxAttempts=%s after %s fixes',
		async (maxAttempts, attempts, status, nextAttempts) => {
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ({ checksPassed: false, runId: 'r-A' })),
				dispatchFix: vi.fn(async () => ({ success: true })),
			});
			deps.getProgramCharter = vi.fn(() => ({ validationRequired: false, maxAttempts }));
			const result = await runOrchestratorIteration(
				{
					plan: plan([task({ id: 'A', status: 'fixing', fixAttempts: attempts })], {
						programId: 'program-1',
					}),
					prevStates: { A: 'busy' },
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			expect(statusOf(result.state, 'A')).toBe(status);
			expect(taskOf(result.state, 'A')?.fixAttempts).toBe(nextAttempts);
			expect(deps.dispatchFix).toHaveBeenCalledTimes(status === 'failed' ? 0 : 1);
		}
	);
});

describe('rolling transcript history', () => {
	const message = (id: number, role: PianolaMessage['role'] = 'assistant'): PianolaMessage => ({
		id: `m${id}`,
		role,
		source: 'test',
		content: 'work completed',
		timestamp: new Date(id).toISOString(),
	});
	it('detects a fix reply after twenty old messages even when the history tail stays at twelve', async () => {
		const history = Array.from({ length: 20 }, (_, i) => message(i));
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ runId: 'r-A', checksPassed: false })),
			dispatchFix: vi.fn(async () => {
				history.push(message(20, 'user'));
				return { success: true };
			}),
		});
		deps.getRecentMessages = vi.fn(async () => history.slice(-12));
		const first = await runOrchestratorIteration(
			{
				plan: plan([task({ id: 'A', status: 'needs_review' })]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		history.push(message(21));
		deps.getRunLedger = vi.fn(async () => ({ runId: 'r-A', checksPassed: true }));
		const second = await runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
		expect(statusOf(second.state, 'A')).toBe('done');
	});

	it('refreshes the dispatch boundary instead of counting a cached old reply as a fix reply', async () => {
		let history = [message(0, 'user'), message(1)];
		const cached = history;
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ checksPassed: false })),
			dispatchFix: vi.fn(async () => {
				history = [...history, message(2, 'user')];
				return { success: true };
			}),
		});
		deps.getRecentMessages = vi.fn(async (_task, options) => (options?.fresh ? history : cached));
		const first = await runOrchestratorIteration(
			{
				plan: plan([task({ id: 'A', status: 'needs_review' })]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		// Ordinary polling now returns the refreshed cache, still with no fix reply.
		deps.getRecentMessages = vi.fn(async () => history);
		const second = await runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
		expect(statusOf(second.state, 'A')).toBe('fixing');
	});

	it('does not swallow a fix reply that arrives before the fresh boundary read', async () => {
		const history = [message(0, 'user'), message(1)];
		const deps = makeReactiveDeps({
			reactiveEnabled: () => true,
			getRunLedger: vi.fn(async () => ({ checksPassed: false })),
			dispatchFix: vi.fn(async () => {
				history.push(message(2, 'user'), message(3));
				return { success: true };
			}),
		});
		deps.getRecentMessages = vi.fn(async () => [...history]);
		const first = await runOrchestratorIteration(
			{
				plan: plan([task({ id: 'A', status: 'needs_review' })]),
				prevStates: {},
			},
			deps,
			{ concurrencyLimit: 1 }
		);
		deps.getRunLedger = vi.fn(async () => ({ checksPassed: true }));
		const second = await runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
		expect(statusOf(second.state, 'A')).toBe('done');
	});
});
