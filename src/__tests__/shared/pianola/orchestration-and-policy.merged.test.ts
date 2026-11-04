// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/pianola/pianola-orchestrator.test.ts
// Source: src/__tests__/shared/pianola/pianola-orchestrator-reactive.test.ts
// Source: src/__tests__/shared/pianola/pianola-policy.test.ts
// Source: src/__tests__/shared/pianola/pianola-synthesis.test.ts
// Source: src/__tests__/shared/pianola/supervisor-storage.test.ts
// Source: src/__tests__/shared/pianola/decision-log.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
	initialOrchestratorState as s1_initialOrchestratorState,
	runOrchestratorIteration as s1_runOrchestratorIteration,
	type OrchestratorDeps as S1_OrchestratorDeps,
	type OrchestratorState as S1_OrchestratorState,
} from '../../../shared/pianola/pianola-orchestrator';
import type { AgentRunState as S1_AgentRunState } from '../../../shared/pianola/pianola-completion-detector';
import type {
	PianolaPlan as S1_PianolaPlan,
	PianolaTask as S1_PianolaTask,
} from '../../../shared/pianola/pianola-tasks';
import type { PianolaMessage as S1_PianolaMessage } from '../../../shared/pianola/types';
import {
	initialOrchestratorState as s2_initialOrchestratorState,
	runOrchestratorIteration as s2_runOrchestratorIteration,
	type OrchestratorDeps as S2_OrchestratorDeps,
	type OrchestratorState as S2_OrchestratorState,
	type PianolaTaskLedger,
} from '../../../shared/pianola/pianola-orchestrator';
import type { AgentRunState as S2_AgentRunState } from '../../../shared/pianola/pianola-completion-detector';
import type {
	PianolaPlan as S2_PianolaPlan,
	PianolaTask as S2_PianolaTask,
} from '../../../shared/pianola/pianola-tasks';
import type { PianolaMessage as S2_PianolaMessage } from '../../../shared/pianola/types';
import {
	decide,
	selectRule,
	ruleAppliesToScope,
	ruleMatchesClassification,
	hasNarrowingPredicate,
	matchHasNarrowingPredicate,
} from '../../../shared/pianola/pianola-policy';
import type {
	PianolaClassification,
	PianolaRisk as S3_PianolaRisk,
	PianolaRule as S3_PianolaRule,
	PianolaSignalKind as S3_PianolaSignalKind,
} from '../../../shared/pianola/types';
import * as s4_fs from 'fs';
import * as s4_path from 'path';
import * as s4_os from 'os';
import { canonicalJson } from '../../../shared/canonicalJson';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	validatePianolaSuggestionsFile,
	isValidHumanDecisionEvidence,
} from '../../../shared/pianola/storage';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import {
	synthesizeSuggestions,
	reconcileSuggestionEvidence,
	SUGGESTION_MIN_SAMPLES,
} from '../../../shared/pianola/pianola-synthesis';
import type { DecisionPair, ReplyPolarity } from '../../../shared/pianola/transcript-mining';
import type { PianolaSuggestionsFile } from '../../../shared/pianola/storage';
import {
	validatePianolaRule,
	pianolaCandidateEvidenceFingerprint,
} from '../../../shared/pianola/storage';
import type {
	PianolaRisk as S4_PianolaRisk,
	PianolaSignalKind as S4_PianolaSignalKind,
	PianolaRule as S4_PianolaRule,
} from '../../../shared/pianola/types';
import {
	validatePianolaSupervisorFile,
	validatePianolaSupervisedTarget,
	type PianolaSupervisedTarget,
} from '../../../shared/pianola/storage';
import * as s6_fs from 'fs';
import * as s6_os from 'os';
import * as s6_path from 'path';
import { compactDecisionLog, appendDecisionLine } from '../../../shared/pianola/decision-log';
import { PIANOLA_DECISION_RECORD_MAX_BYTES } from '../../../shared/pianola/storage';
// Source: src/__tests__/shared/pianola/pianola-orchestrator.test.ts
describe('', () => {
	function task(overrides: Partial<S1_PianolaTask> = {}): S1_PianolaTask {
		return {
			id: 't1',
			title: 'Task 1',
			prompt: 'Do the thing.',
			dependsOn: [],
			status: 'pending',
			...overrides,
		};
	}
	function plan(tasks: S1_PianolaTask[], overrides: Partial<S1_PianolaPlan> = {}): S1_PianolaPlan {
		return {
			id: 'plan-1',
			title: 'Plan 1',
			createdAt: 1000,
			tasks,
			...overrides,
		};
	}
	let seq = 0;
	function msg(role: S1_PianolaMessage['role'], content: string): S1_PianolaMessage {
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
			runStates?: Record<string, S1_AgentRunState>;
			messages?: Record<string, readonly S1_PianolaMessage[]>;
			ensureAgent?: S1_OrchestratorDeps['ensureAgent'];
			dispatch?: S1_OrchestratorDeps['dispatch'];
			persist?: S1_OrchestratorDeps['persist'];
			notify?: S1_OrchestratorDeps['notify'];
		} = {}
	): S1_OrchestratorDeps {
		const runStates = config.runStates ?? {};
		const messages = config.messages ?? {};
		return {
			getRunState: vi.fn(async (t: S1_PianolaTask) => runStates[t.id] ?? 'busy'),
			getRecentMessages: vi.fn(async (t: S1_PianolaTask) => messages[t.id] ?? []),
			ensureAgent:
				config.ensureAgent ??
				vi.fn(async (t: S1_PianolaTask) => ({
					agentId: t.agentId ?? `agent-${t.id}`,
					agentType: t.agentType ?? 'claude-code',
				})),
			dispatch: config.dispatch ?? vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
			persist: config.persist ?? vi.fn(),
			log: vi.fn(),
			notify: config.notify,
		};
	}
	function statusOf(state: S1_OrchestratorState, id: string): string | undefined {
		return state.plan.tasks.find((t) => t.id === id)?.status;
	}
	describe('runOrchestratorIteration - linear A->B->C', () => {
		it('runs to completion across iterations, respecting dependency order', async () => {
			const p = plan([
				task({ id: 'A', dependsOn: [] }),
				task({ id: 'B', dependsOn: ['A'] }),
				task({ id: 'C', dependsOn: ['B'] }),
			]);
			let state = s1_initialOrchestratorState(p);
			// Iteration 1: only A is ready, so only A is dispatched.
			let deps = makeDeps();
			let r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(r.dispatchedTaskIds).toEqual(['A']);
			expect(statusOf(r.state, 'A')).toBe('running');
			expect(statusOf(r.state, 'B')).toBe('pending');
			expect(statusOf(r.state, 'C')).toBe('pending');
			expect(r.done).toBe(false);
			state = r.state;
			state = (await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
			// Iteration 2: A completes (busy -> idle); B becomes ready and dispatches.
			deps = makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'A done.')] } });
			r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(r.completedTaskIds).toEqual(['A']);
			expect(r.dispatchedTaskIds).toEqual(['B']);
			expect(statusOf(r.state, 'A')).toBe('done');
			expect(statusOf(r.state, 'B')).toBe('running');
			expect(statusOf(r.state, 'C')).toBe('pending');
			state = r.state;
			state = (await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
			// Iteration 3: B completes; C dispatches.
			deps = makeDeps({ runStates: { B: 'idle' }, messages: { B: [msg('assistant', 'B done.')] } });
			r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(r.completedTaskIds).toEqual(['B']);
			expect(r.dispatchedTaskIds).toEqual(['C']);
			expect(statusOf(r.state, 'C')).toBe('running');
			expect(r.done).toBe(false);
			state = r.state;
			state = (await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
			// Iteration 4: C completes; plan is done.
			deps = makeDeps({ runStates: { C: 'idle' }, messages: { C: [msg('assistant', 'C done.')] } });
			r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(r.completedTaskIds).toEqual(['C']);
			expect(statusOf(r.state, 'C')).toBe('done');
			expect(r.done).toBe(true);
			expect(r.progress.complete).toBe(true);
			expect(r.progress.done).toBe(3);
		});
		it('does not dispatch B before A is done', async () => {
			const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
			const state = s1_initialOrchestratorState(p);
			// A is still busy after iteration 1.
			const r1 = await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
			// A still busy: it stays running, B stays pending.
			const r2 = await s1_runOrchestratorIteration(r1.state, makeDeps(), { concurrencyLimit: 5 });
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
			const result = await s1_runOrchestratorIteration(s1_initialOrchestratorState(p), deps, {
				concurrencyLimit: 3,
			});
			expect(result.dispatchedTaskIds).toEqual(['A']);
			maxConcurrent = 5;
			const capped = await s1_runOrchestratorIteration(result.state, deps, { concurrencyLimit: 1 });
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
			const result = await s1_runOrchestratorIteration(s1_initialOrchestratorState(p), deps, {
				concurrencyLimit: 3,
			});
			expect(deps.dispatch).not.toHaveBeenCalled();
			expect(result.state.plan.tasks[1]).toMatchObject({ status: 'pending', agentId: 'bound' });
		});
		it('caps simultaneous running tasks at concurrencyLimit', async () => {
			const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
			const state = s1_initialOrchestratorState(p);
			const deps = makeDeps();
			const r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
			expect(r.dispatchedTaskIds).toHaveLength(2);
			expect(r.progress.running).toBe(2);
			expect(r.progress.pending).toBe(1);
			// dispatch was called exactly twice, never for the third task this tick.
			expect(deps.dispatch).toHaveBeenCalledTimes(2);
		});
		it('fills a freed slot on the next iteration as running tasks complete', async () => {
			const p = plan([task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })]);
			let state = s1_initialOrchestratorState(p);
			// Iteration 1: A and B run, C waits.
			let r = await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 2 });
			expect(r.dispatchedTaskIds).toHaveLength(2);
			state = r.state;
			state = (await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 2 })).state;
			// Iteration 2: A completes, freeing a slot; C dispatches; B keeps running.
			const deps = makeDeps({
				runStates: { A: 'idle', B: 'busy' },
				messages: { A: [msg('assistant', 'A done.')] },
			});
			r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 2 });
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
			const state = s1_initialOrchestratorState(p);
			const notify = vi.fn(async () => {});
			// A enters error state -> failed.
			const deps = makeDeps({ runStates: { A: 'error' }, notify });
			const r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
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
			const state = s1_initialOrchestratorState(p);
			const deps = makeDeps({
				runStates: { A: 'idle' },
				messages: { A: [msg('error', 'fatal error: build broke')] },
			});
			const r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('failed');
			const failed = r.state.plan.tasks.find((t) => t.id === 'A');
			expect(failed?.error).toBeTruthy();
		});
		it('does not throw when notify rejects', async () => {
			const p = plan([task({ id: 'A', status: 'running', agentId: 'agent-A' })]);
			const state = s1_initialOrchestratorState(p);
			const notify = vi.fn(async () => {
				throw new Error('toast backend down');
			});
			const deps = makeDeps({ runStates: { A: 'error' }, notify });
			const r = await s1_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('failed');
			expect(notify).toHaveBeenCalledTimes(1);
		});
	});
	describe('runOrchestratorIteration - agent and dispatch failures', () => {
		it('leaves a task pending when ensureAgent errors, then dispatches once it succeeds', async () => {
			const p = plan([task({ id: 'A' })]);
			let state = s1_initialOrchestratorState(p);
			// Iteration 1: ensureAgent fails -> A stays pending, dispatch never called.
			const failingEnsure = vi.fn(async () => ({ error: 'no capacity' }));
			const dispatch1 = vi.fn(async () => ({ success: true, tabId: 'tab-1' }));
			let r = await s1_runOrchestratorIteration(
				state,
				makeDeps({ ensureAgent: failingEnsure, dispatch: dispatch1 }),
				{ concurrencyLimit: 5 }
			);
			expect(statusOf(r.state, 'A')).toBe('pending');
			expect(r.dispatchedTaskIds).toEqual([]);
			expect(dispatch1).not.toHaveBeenCalled();
			state = r.state;
			// Iteration 2: ensureAgent succeeds -> A dispatches.
			r = await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('running');
			expect(r.dispatchedTaskIds).toEqual(['A']);
			expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentType).toBe('claude-code');
		});
		it('leaves a task pending when dispatch fails without permanently consuming a slot', async () => {
			// A's dispatch fails; B should still take the slot in the same iteration.
			const p = plan([task({ id: 'A' }), task({ id: 'B' })]);
			const state = s1_initialOrchestratorState(p);
			const dispatch = vi.fn(async (t: S1_PianolaTask) =>
				t.id === 'A' ? { success: false, error: 'agent busy' } : { success: true, tabId: 'tab-B' }
			);
			const r = await s1_runOrchestratorIteration(state, makeDeps({ dispatch }), {
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
			let state = s1_initialOrchestratorState(p);
			let attempt = 0;
			const dispatch = vi.fn(async () => {
				attempt += 1;
				return attempt === 1
					? { success: false, error: 'transient' }
					: { success: true, tabId: 'tab-1' };
			});
			// First tick: dispatch fails, A stays pending.
			let r = await s1_runOrchestratorIteration(state, makeDeps({ dispatch }), {
				concurrencyLimit: 5,
			});
			expect(statusOf(r.state, 'A')).toBe('pending');
			state = r.state;
			// Second tick: same dispatch fake now succeeds.
			r = await s1_runOrchestratorIteration(state, makeDeps({ dispatch }), { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('running');
		});
	});
	describe('runOrchestratorIteration - persistence and progress', () => {
		it('persists the claim and confirmed receipt before the final plan', async () => {
			const p = plan([task({ id: 'A' }), task({ id: 'B', dependsOn: ['A'] })]);
			const deps = makeDeps();
			const r = await s1_runOrchestratorIteration(s1_initialOrchestratorState(p), deps, {
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
			const state = s1_initialOrchestratorState(p);
			// B still busy: not done.
			const r1 = await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
			expect(r1.done).toBe(false);
			// B completes: now done.
			const deps = makeDeps({
				runStates: { B: 'idle' },
				messages: { B: [msg('assistant', 'ok')] },
			});
			const r2 = await s1_runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
			expect(r2.done).toBe(true);
		});
		it('does not mutate the input state or plan', async () => {
			const p = plan([task({ id: 'A' })]);
			const state = s1_initialOrchestratorState(p);
			const snapshot = JSON.parse(JSON.stringify(state));
			await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 });
			expect(state).toEqual(snapshot);
		});
	});
	describe('runOrchestratorIteration - prevStates carry-across', () => {
		it('detects a busy->idle transition using prevStates from the prior iteration', async () => {
			const p = plan([task({ id: 'A' })]);
			let state = s1_initialOrchestratorState(p);
			// Dispatch records delivery without inventing a process state.
			let r = await s1_runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
				concurrencyLimit: 5,
			});
			expect(r.state.prevStates.A).toBeUndefined();
			expect(statusOf(r.state, 'A')).toBe('running');
			state = r.state;
			state = (await s1_runOrchestratorIteration(state, makeDeps(), { concurrencyLimit: 5 })).state;
			// A real busy observation followed by idle can settle the legacy adapter.
			r = await s1_runOrchestratorIteration(
				state,
				makeDeps({ runStates: { A: 'idle' }, messages: { A: [msg('assistant', 'finished')] } }),
				{ concurrencyLimit: 5 }
			);
			expect(r.completedTaskIds).toEqual(['A']);
			expect(statusOf(r.state, 'A')).toBe('done');
		});
		it('only carries forward run states observed this iteration', async () => {
			const p = plan([task({ id: 'A', status: 'running' }), task({ id: 'B', status: 'done' })]);
			const state: S1_OrchestratorState = {
				plan: p,
				prevStates: { A: 'busy', B: 'idle' },
			};
			const r = await s1_runOrchestratorIteration(state, makeDeps({ runStates: { A: 'busy' } }), {
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
			const result = await s1_runOrchestratorIteration(
				s1_initialOrchestratorState(plan([task()])),
				deps,
				{
					concurrencyLimit: 1,
				}
			);
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
			const ensureAgent: S1_OrchestratorDeps['ensureAgent'] = vi.fn(async (t: S1_PianolaTask) => {
				if (t.agentId) return { agentId: t.agentId };
				created += 1;
				return { agentId: `created-${created}` };
			});
			let failNext = true;
			const dispatch: S1_OrchestratorDeps['dispatch'] = vi.fn(async () => {
				if (failNext) {
					failNext = false;
					return { success: false, error: 'transient' };
				}
				return { success: true, tabId: 'tab-1' };
			});
			let state = s1_initialOrchestratorState(p);
			let r = await s1_runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
				concurrencyLimit: 1,
			});
			expect(statusOf(r.state, 'A')).toBe('pending');
			expect(r.state.plan.tasks.find((t) => t.id === 'A')?.agentId).toBe('created-1');
			state = r.state;
			r = await s1_runOrchestratorIteration(state, makeDeps({ ensureAgent, dispatch }), {
				concurrencyLimit: 1,
			});
			expect(statusOf(r.state, 'A')).toBe('running');
			expect(created).toBe(1);
		});
		it('persists the claim and accepted dispatch before starting the next task', async () => {
			const persisted: S1_PianolaPlan[] = [];
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
			await s1_runOrchestratorIteration(
				s1_initialOrchestratorState(plan([task({ id: 'A' }), task({ id: 'B' })])),
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
				const result = await s1_runOrchestratorIteration(
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
			const first = await s1_runOrchestratorIteration(
				{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
				deps,
				{ concurrencyLimit: 1 }
			);
			const second = await s1_runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
			expect(statusOf(second.state, 't1')).toBe('needs_review');
			expect(deps.requestMerge).not.toHaveBeenCalled();
			deps.getRunLedger = vi.fn(async () => ({ checksPassed: false }));
			await s1_runOrchestratorIteration(second.state, deps, { concurrencyLimit: 1 });
			expect(deps.dispatchFix).not.toHaveBeenCalled();
		});
		it('routes a failed verdict to review even without a ledger reader', async () => {
			const deps = makeDeps({ runStates: { t1: 'idle' } });
			deps.validate = vi.fn(async () => ({ verdict: 'failed', reason: 'assertion failed' }));
			const result = await s1_runOrchestratorIteration(
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
			const result = await s1_runOrchestratorIteration(
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
			const result = await s1_runOrchestratorIteration(
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
			const first = await s1_runOrchestratorIteration(initial, deps, { concurrencyLimit: 1 });
			expect(statusOf(first.state, 't1')).toBe('fixing');
			expect(deps.dispatchFix).toHaveBeenCalledTimes(1);
			const second = await s1_runOrchestratorIteration(
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
			const first = await s1_runOrchestratorIteration(
				{ plan: plan([task({ status: 'running', validation })]), prevStates: { t1: 'busy' } },
				deps,
				{ concurrencyLimit: 1 }
			);
			expect(statusOf(first.state, 't1')).toBe('running');
			const second = await s1_runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
			expect(statusOf(second.state, 't1')).toBe('needs_review');
			expect(second.state.plan.tasks[0].error).toBe('bubblewrap unavailable');
		});
		it('does not re-settle a fixing task on an idle tick after an unknown validation', async () => {
			// The fix agent has been dispatched but not started yet: idle must not count as done,
			// or every tick would burn a fix attempt without any fix run being observed.
			const deps = makeDeps({ runStates: { t1: 'idle' } });
			deps.validate = vi.fn(async () => ({ verdict: 'failed', reason: 'exit 1' }));
			const result = await s1_runOrchestratorIteration(
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
			await s1_runOrchestratorIteration(
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
				const result = await s1_runOrchestratorIteration(
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
});
// Source: src/__tests__/shared/pianola/pianola-orchestrator-reactive.test.ts
describe('', () => {
	function task(overrides: Partial<S2_PianolaTask> = {}): S2_PianolaTask {
		return {
			id: 't1',
			title: 'Task 1',
			prompt: 'Do the thing.',
			dependsOn: [],
			status: 'pending',
			...overrides,
		};
	}
	function plan(tasks: S2_PianolaTask[], overrides: Partial<S2_PianolaPlan> = {}): S2_PianolaPlan {
		return {
			id: 'plan-1',
			title: 'Plan 1',
			createdAt: 1000,
			tasks,
			...overrides,
		};
	}
	interface ReactiveConfig {
		runStates?: Record<string, S2_AgentRunState>;
		messages?: Record<string, readonly S2_PianolaMessage[]>;
		reactiveEnabled?: S2_OrchestratorDeps['reactiveEnabled'];
		getRunLedger?: S2_OrchestratorDeps['getRunLedger'];
		dispatchFix?: S2_OrchestratorDeps['dispatchFix'];
		requestMerge?: S2_OrchestratorDeps['requestMerge'];
		notify?: S2_OrchestratorDeps['notify'];
	}
	/**
	 * Deps with the reactive-loop side effects injectable. Defaults: a running task
	 * is observed idle (so a working->idle transition settles it), no transcript
	 * (no failure marker), and NO reactive gate wired unless the test wires one.
	 */
	function makeReactiveDeps(config: ReactiveConfig = {}): S2_OrchestratorDeps {
		const runStates = config.runStates ?? {};
		const messages = config.messages ?? {};
		return {
			getRunState: vi.fn(async (t: S2_PianolaTask) => runStates[t.id] ?? 'idle'),
			getRecentMessages: vi.fn(async (t: S2_PianolaTask) => messages[t.id] ?? []),
			ensureAgent: vi.fn(async (t: S2_PianolaTask) => ({
				agentId: t.agentId ?? `agent-${t.id}`,
				agentType: 'claude-code',
			})),
			dispatch: vi.fn(async () => ({ success: true, tabId: 'tab-1' })),
			persist: vi.fn(),
			log: vi.fn(),
			notify: config.notify,
			reactiveEnabled: config.reactiveEnabled,
			getRunLedger: config.getRunLedger,
			dispatchFix: config.dispatchFix
				? vi.fn(async (task, ledger) => {
						const result = await config.dispatchFix!(task, ledger);
						return result.success ? { ...result, tabId: result.tabId ?? 'fix-tab' } : result;
					})
				: undefined,
			requestMerge: config.requestMerge,
		};
	}
	function statusOf(state: S2_OrchestratorState, id: string): string | undefined {
		return state.plan.tasks.find((t) => t.id === id)?.status;
	}
	function taskOf(state: S2_OrchestratorState, id: string): S2_PianolaTask | undefined {
		return state.plan.tasks.find((t) => t.id === id);
	}
	/** A running task observed working last tick, so getRunState 'idle' this tick settles it. */
	function runningState(t: S2_PianolaTask): S2_OrchestratorState {
		return { plan: plan([t]), prevStates: { [t.id]: 'busy' } };
	}
	// ---------------------------------------------------------------------------
	// ISC-8.13 - reactiveEnabled master gate: supervisor parity when off/absent
	// ---------------------------------------------------------------------------
	describe('reactiveEnabled gate (ISC-8.13)', () => {
		it('leaves a needs_review task untouched when reactiveEnabled returns false', async () => {
			const p = plan([task({ id: 'A', status: 'needs_review' })]);
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const requestMerge = vi.fn(async () => ({ merged: true }));
			const deps = makeReactiveDeps({
				reactiveEnabled: () => false,
				// A fully-green ledger AND open-finding ledger would BOTH trigger action
				// if the gate were open; with it closed, neither dep may fire.
				getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
				dispatchFix,
				requestMerge,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
				concurrencyLimit: 5,
			});
			expect(statusOf(r.state, 'A')).toBe('needs_review');
			expect(dispatchFix).not.toHaveBeenCalled();
			expect(requestMerge).not.toHaveBeenCalled();
			expect(r.completedTaskIds).toEqual([]);
		});
		it('leaves a needs_review task untouched when reactiveEnabled is absent', async () => {
			const p = plan([task({ id: 'A', status: 'needs_review' })]);
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const requestMerge = vi.fn(async () => ({ merged: true }));
			const deps = makeReactiveDeps({
				// reactiveEnabled omitted entirely.
				getRunLedger: vi.fn(async () => ({ openFindings: 0, checksPassed: true, runId: 'r-A' })),
				dispatchFix,
				requestMerge,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
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
			const r1 = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
				concurrencyLimit: 5,
			});
			expect(requestMerge).toHaveBeenCalledTimes(1);
			expect(requestMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), ledger);
			expect(statusOf(r1.state, 'A')).toBe('done');
			expect(r1.completedTaskIds).toEqual(['A']);
			// Iteration 2: the task is now terminal (done); the needs_review filter
			// skips it, so NO second merge is requested - proves the no-repeat-merge fix.
			const r2 = await s2_runOrchestratorIteration(r1.state, deps, { concurrencyLimit: 5 });
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
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
				concurrencyLimit: 5,
			});
			expect(requestMerge).toHaveBeenCalledTimes(1);
			expect(statusOf(r.state, 'A')).toBe('done');
			expect(r.completedTaskIds).toEqual(['A']);
		});
		it('does not treat a task with open findings as green (no merge)', async () => {
			const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A' })]);
			const requestMerge = vi.fn(async () => ({ merged: true }));
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				// checks pass but a finding is still open -> NOT fully green.
				getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: true, runId: 'r-A' })),
				requestMerge,
				dispatchFix,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
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
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ledger),
				dispatchFix,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
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
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
				concurrencyLimit: 5,
			});
			expect(dispatchFix).toHaveBeenCalledTimes(1);
			expect(statusOf(r.state, 'A')).toBe('needs_review');
			expect(taskOf(r.state, 'A')?.fixAttempts).toBe(1);
		});
		it.each([undefined, 'unconfirmed-fix-tab'])(
			'holds an uncertain failed repair without redelivery or stale acceptance (tab: %s)',
			async (tabId) => {
				const ledger: PianolaTaskLedger = {
					runId: 'acceptance-A',
					openFindings: 1,
					checksPassed: false,
				};
				const dispatchFix = vi.fn(async () => ({
					success: false,
					deliveryUncertain: true,
					tabId,
					error: 'repair response lost after possible delivery',
				}));
				const requestMerge = vi.fn(async () => ({ merged: true }));
				const deps = makeReactiveDeps({
					reactiveEnabled: () => true,
					getRunLedger: vi.fn(async (entry) =>
						entry.id === 'A' ? ledger : { openFindings: 1, checksPassed: false }
					),
					dispatchFix,
					requestMerge,
				});
				const p = plan([
					task({
						id: 'A',
						status: 'needs_review',
						runId: 'acceptance-A',
						tabId: 'old-tab',
						executionRunId: 'old-execution',
						fixAttempts: 1,
					}),
					task({ id: 'B', status: 'needs_review' }),
					task({ id: 'child', dependsOn: ['A'] }),
					task({ id: 'independent' }),
				]);
				const first = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
					concurrencyLimit: 1,
				});
				expect(taskOf(first.state, 'A')).toMatchObject({
					status: 'needs_review',
					holdReason: 'delivery_uncertain',
					runId: 'acceptance-A',
					fixAttempts: 2,
				});
				expect(taskOf(first.state, 'A')?.tabId).toBeUndefined();
				expect(taskOf(first.state, 'A')?.executionRunId).toBeUndefined();
				expect(deps.persist).toHaveBeenNthCalledWith(
					1,
					expect.objectContaining({
						tasks: expect.arrayContaining([
							expect.objectContaining({
								id: 'A',
								status: 'fixing',
								tabId: undefined,
								executionRunId: undefined,
								fixAttempts: 2,
							}),
						]),
					})
				);
				// The still-failing ledger must not trigger a second repair, even when a
				// restarted controller has lost all in-memory observations.
				const retry = await s2_runOrchestratorIteration(
					s2_initialOrchestratorState(first.state.plan),
					deps,
					{ concurrencyLimit: 1 }
				);
				expect(taskOf(retry.state, 'A')).toEqual(taskOf(first.state, 'A'));
				expect(dispatchFix).toHaveBeenCalledTimes(1);
				expect(deps.dispatch).not.toHaveBeenCalled();
				// Even an old green ledger cannot approve an unidentified repair.
				ledger.openFindings = 0;
				ledger.checksPassed = true;
				const next = await s2_runOrchestratorIteration(
					s2_initialOrchestratorState(retry.state.plan),
					deps,
					{
						concurrencyLimit: 1,
					}
				);
				expect(taskOf(next.state, 'A')).toEqual(taskOf(first.state, 'A'));
				expect(statusOf(next.state, 'child')).toBe('pending');
				expect(statusOf(next.state, 'independent')).toBe('pending');
				expect(dispatchFix).toHaveBeenCalledTimes(1);
				expect(deps.dispatch).not.toHaveBeenCalled();
				expect(first.completedTaskIds).toEqual([]);
				expect(next.completedTaskIds).not.toContain('A');
				expect(next.failedTaskIds).toEqual([]);
				expect(statusOf(next.state, 'B')).toBe('needs_review');
				expect(requestMerge).not.toHaveBeenCalled();
			}
		);
		it('still dispatches a fix at fixAttempts 2 (just under the cap)', async () => {
			const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 2 })]);
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
				dispatchFix,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
				concurrencyLimit: 5,
			});
			expect(dispatchFix).toHaveBeenCalledTimes(1);
			expect(statusOf(r.state, 'A')).toBe('fixing');
			expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);
		});
		it('escalates a still-needs_review task to failed at the cap, dispatching no further fix', async () => {
			const p = plan([task({ id: 'A', status: 'needs_review', runId: 'r-A', fixAttempts: 3 })]);
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const notify = vi.fn(async () => {});
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ({ openFindings: 1, checksPassed: false, runId: 'r-A' })),
				dispatchFix,
				notify,
			});
			const r = await s2_runOrchestratorIteration(s2_initialOrchestratorState(p), deps, {
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
			const dispatchFix = vi.fn(async () => ({ success: true, tabId: 'fix-tab' }));
			const deps = makeReactiveDeps({
				runStates: { A: 'idle' },
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ledger),
				dispatchFix,
			});
			// Start already fixing (attempt 1 in flight), observed busy last tick.
			let state: S2_OrchestratorState = {
				plan: plan([task({ id: 'A', status: 'fixing', runId: 'r-A', fixAttempts: 1 })]),
				prevStates: { A: 'busy' },
			};
			// Tick 1: fix finishes -> ledger not green -> needs_review -> dispatch fix (attempt 2).
			let r = await s2_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('fixing');
			expect(taskOf(r.state, 'A')?.fixAttempts).toBe(2);
			// Tick 2: same cycle -> attempt 3. Re-seed 'busy' (fix agent ran again).
			state = { plan: r.state.plan, prevStates: { A: 'busy' } };
			r = await s2_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('fixing');
			expect(taskOf(r.state, 'A')?.fixAttempts).toBe(3);
			// Tick 3: fix finishes, task re-enters needs_review at attempts 3 -> escalate.
			state = { plan: r.state.plan, prevStates: { A: 'busy' } };
			r = await s2_runOrchestratorIteration(state, deps, { concurrencyLimit: 5 });
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
			const r = await s2_runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
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
			const r = await s2_runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
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
			const r = await s2_runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('done');
			expect(r.completedTaskIds).toEqual(['A']);
			expect(taskOf(r.state, 'A')?.runId).toBe('r-A');
		});
		it('settles to done when no ledger reader is wired (falls back to busy->idle)', async () => {
			const t = task({ id: 'A', status: 'running' });
			const deps = makeReactiveDeps({ runStates: { A: 'idle' } }); // no getRunLedger
			const r = await s2_runOrchestratorIteration(runningState(t), deps, { concurrencyLimit: 5 });
			expect(statusOf(r.state, 'A')).toBe('done');
			expect(r.completedTaskIds).toEqual(['A']);
		});
	});
	describe('fix runs shorter than one poll interval', () => {
		const msg = (
			role: S2_PianolaMessage['role'],
			content: string,
			i: number
		): S2_PianolaMessage => ({
			id: `m${i}`,
			role,
			source: 'test',
			content,
			timestamp: new Date(1700000000000 + i).toISOString(),
		});
		it('records the last message id when a fix is dispatched', async () => {
			const deps = makeReactiveDeps({
				runStates: { A: 'idle' },
				messages: { A: [msg('user', 'task', 0), msg('assistant', 'done', 1)] },
				reactiveEnabled: () => true,
				getRunLedger: vi.fn(async () => ({ runId: 'r-A', checksPassed: false, openFindings: 0 })),
				dispatchFix: vi.fn(async () => ({ success: true })),
			});
			const r = await s2_runOrchestratorIteration(
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
			const r = await s2_runOrchestratorIteration(
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
				messages: {
					A: [msg('user', 'task', 0), msg('assistant', 'done', 1), msg('user', 'fix', 2)],
				},
				reactiveEnabled: () => true,
			});
			const r = await s2_runOrchestratorIteration(
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
		const msg = (
			role: S2_PianolaMessage['role'],
			content: string,
			i: number
		): S2_PianolaMessage => ({
			id: `m${i}`,
			role,
			source: 'test',
			content,
			timestamp: new Date(1700000000000 + i).toISOString(),
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
			const r = await s2_runOrchestratorIteration(
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
			const r = await s2_runOrchestratorIteration(
				{ plan: plan([task({ id: 'A', status: 'pending' })]), prevStates: {} },
				deps,
				{ concurrencyLimit: 1 }
			);
			expect(statusOf(r.state, 'A')).toBe('running');
			expect(taskOf(r.state, 'A')?.dispatchedMessageId).toBe('m2');
		});
	});
	describe('program charter fix attempts', () => {
		it('caps fixes with the latest charter after history awaits', async () => {
			const deps = makeReactiveDeps({
				reactiveEnabled: () => true,
				runStates: { A: 'busy' },
				getRunLedger: async () => ({ checksPassed: false, runId: 'r-B' }),
				dispatchFix: vi.fn(async () => ({ success: true })),
			});
			let maxConcurrent = 2;
			deps.getProgramCharter = () => ({ validationRequired: false, maxAttempts: 2, maxConcurrent });
			deps.getRecentMessages = vi.fn(async (_task, options) => {
				if (options?.fresh) maxConcurrent = 1;
				return [];
			});
			const state = s2_initialOrchestratorState(
				plan([task({ id: 'A', status: 'running' }), task({ id: 'B', status: 'needs_review' })], {
					programId: 'product',
				})
			);
			const result = await s2_runOrchestratorIteration(state, deps, { concurrencyLimit: 3 });
			expect(deps.dispatchFix).not.toHaveBeenCalled();
			expect(statusOf(result.state, 'B')).toBe('needs_review');
		});
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
				const result = await s2_runOrchestratorIteration(
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
		const message = (
			id: number,
			role: S2_PianolaMessage['role'] = 'assistant'
		): S2_PianolaMessage => ({
			id: `m${id}`,
			role,
			source: 'test',
			content: 'work completed',
			timestamp: new Date(id).toISOString(),
		});
		describe('pre-dispatch boundaries', () => {
			it.each(['initial', 'fix'] as const)(
				'does not consume old failure output when the %s prompt has not appeared yet',
				async (kind) => {
					const history = [
						message(0, 'user'),
						{ ...message(1), content: 'Traceback (most recent call last): old failure' },
					];
					const deps = makeReactiveDeps({
						reactiveEnabled: () => true,
						getRunLedger: vi.fn(async () => ({ checksPassed: false })),
						dispatchFix: vi.fn(async () => ({ success: true })),
					});
					deps.getRecentMessages = vi.fn(async () => [...history]);
					const first = await s2_runOrchestratorIteration(
						{
							plan: plan([task({ id: 'A', status: kind === 'fix' ? 'needs_review' : 'pending' })]),
							prevStates: {},
						},
						deps,
						{ concurrencyLimit: 1 }
					);
					expect(taskOf(first.state, 'A')?.dispatchedMessageId).toBe('m1');
					const second = await s2_runOrchestratorIteration(first.state, deps, {
						concurrencyLimit: 1,
					});
					expect(statusOf(second.state, 'A')).toBe(kind === 'fix' ? 'fixing' : 'running');
				}
			);
			it('clears unknown attempts and stale working state when dispatching a fix', async () => {
				const deps = makeReactiveDeps({
					reactiveEnabled: () => true,
					getRunLedger: vi.fn(async () => ({ checksPassed: false })),
					dispatchFix: vi.fn(async () => ({ success: true })),
				});
				const first = await s2_runOrchestratorIteration(
					{
						plan: plan([task({ id: 'A', status: 'needs_review', validationUnknownAttempts: 1 })]),
						prevStates: { A: 'busy' },
					},
					deps,
					{ concurrencyLimit: 1 }
				);
				expect(taskOf(first.state, 'A')?.validationUnknownAttempts).toBe(0);
				const second = await s2_runOrchestratorIteration(first.state, deps, {
					concurrencyLimit: 1,
				});
				expect(taskOf(second.state, 'A')?.fixAttempts).toBe(1);
				expect(deps.dispatchFix).toHaveBeenCalledOnce();
			});
			it('reads the exact ensured tab before dispatch, not a post-dispatch snapshot', async () => {
				const history = [message(0, 'user'), message(1)];
				const deps = makeReactiveDeps();
				deps.ensureAgent = vi.fn(async () => ({ agentId: 'agent-A', tabId: 'tab-A' }));
				deps.getRecentMessages = vi.fn(async (task) => {
					expect(task.tabId).toBe('tab-A');
					return [...history];
				});
				deps.dispatch = vi.fn(async (task) => {
					expect(task.tabId).toBe('tab-A');
					expect(deps.getRecentMessages).toHaveBeenCalledOnce();
					history.push(message(2, 'user'), message(3));
					return { success: true, tabId: 'tab-A' };
				});
				const first = await s2_runOrchestratorIteration(
					s2_initialOrchestratorState(plan([task({ id: 'A' })])),
					deps,
					{ concurrencyLimit: 1 }
				);
				expect(taskOf(first.state, 'A')?.dispatchedMessageId).toBe('m1');
				const second = await s2_runOrchestratorIteration(first.state, deps, {
					concurrencyLimit: 1,
				});
				expect(statusOf(second.state, 'A')).toBe('done');
			});
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
			const first = await s2_runOrchestratorIteration(
				{
					plan: plan([task({ id: 'A', status: 'needs_review' })]),
					prevStates: {},
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			history.push(message(21));
			deps.getRunLedger = vi.fn(async () => ({ runId: 'r-A', checksPassed: true }));
			const second = await s2_runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
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
			const first = await s2_runOrchestratorIteration(
				{
					plan: plan([task({ id: 'A', status: 'needs_review' })]),
					prevStates: {},
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			// Ordinary polling now returns the refreshed cache, still with no fix reply.
			deps.getRecentMessages = vi.fn(async () => history);
			const second = await s2_runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
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
			const first = await s2_runOrchestratorIteration(
				{
					plan: plan([task({ id: 'A', status: 'needs_review' })]),
					prevStates: {},
				},
				deps,
				{ concurrencyLimit: 1 }
			);
			deps.getRunLedger = vi.fn(async () => ({ checksPassed: true }));
			const second = await s2_runOrchestratorIteration(first.state, deps, { concurrencyLimit: 1 });
			expect(statusOf(second.state, 'A')).toBe('done');
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-policy.test.ts
describe('', () => {
	function classification(
		overrides: Partial<PianolaClassification> & {
			kind: S3_PianolaSignalKind;
			risk: S3_PianolaRisk;
		}
	): PianolaClassification {
		return {
			topic: 'should i use tabs',
			confidence: 'medium',
			evidence: { messageId: 'm1', reason: 'test', structured: false },
			...overrides,
		};
	}
	let ruleSeq = 0;
	function rule(overrides: Partial<S3_PianolaRule>): S3_PianolaRule {
		ruleSeq += 1;
		return {
			id: `r${ruleSeq}`,
			enabled: true,
			scope: 'global',
			match: {},
			action: 'auto_answer',
			answer: 'Use tabs.',
			priority: 100,
			createdAt: ruleSeq,
			updatedAt: ruleSeq,
			...overrides,
		};
	}
	describe('decide - safety defaults', () => {
		it('ignores a none classification', () => {
			const d = decide(classification({ kind: 'none', risk: 'low' }), [rule({})]);
			expect(d.action).toBe('ignore');
			expect(d.matchedRuleId).toBeNull();
		});
		it('escalates when no rule matches', () => {
			const d = decide(classification({ kind: 'question', risk: 'low' }), []);
			expect(d.action).toBe('escalate');
			expect(d.matchedRuleId).toBeNull();
		});
		it('never auto-answers a high-risk prompt even if a rule says to', () => {
			const r = rule({ match: { maxRisk: 'high' }, action: 'auto_answer', answer: 'go' });
			const d = decide(classification({ kind: 'question', risk: 'high' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.matchedRuleId).toBe(r.id);
			expect(d.reason).toContain('high-risk');
		});
		it('never lets an ignore rule suppress a high-risk prompt', () => {
			// Regression: high-risk override must run before rule actions, so a broad
			// ignore rule cannot silence the most important alerts.
			const r = rule({ action: 'ignore', match: {} });
			const d = decide(classification({ kind: 'blocked', risk: 'high' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.reason).toContain('high-risk');
		});
	});
	describe('decide - rule actions', () => {
		it('auto-answers a low-risk prompt matched by a rule', () => {
			const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'Use tabs.' });
			const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
			expect(d).toMatchObject({ action: 'auto_answer', answer: 'Use tabs.', matchedRuleId: r.id });
		});
		it('escalates an auto-answer rule that has no narrowing predicate (too broad)', () => {
			const r = rule({ match: {}, action: 'auto_answer', answer: 'sure' });
			const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.reason).toContain('narrowing predicate');
		});
		it('escalates when matched auto-answer rule has no answer text', () => {
			const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: '   ' });
			const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.reason).toContain('no answer');
		});
		it('honors an explicit escalate rule', () => {
			const r = rule({ action: 'escalate' });
			const d = decide(classification({ kind: 'question', risk: 'low' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.matchedRuleId).toBe(r.id);
		});
		it('honors an explicit ignore rule for a non-high-risk prompt', () => {
			const r = rule({ action: 'ignore', match: { maxRisk: 'low' } });
			const d = decide(classification({ kind: 'blocked', risk: 'low' }), [r]);
			expect(d.action).toBe('ignore');
			expect(d.matchedRuleId).toBe(r.id);
		});
	});
	describe('matchHasNarrowingPredicate', () => {
		it('treats maxRisk, kinds, or topicIncludes as narrowing', () => {
			expect(matchHasNarrowingPredicate({ maxRisk: 'low' })).toBe(true);
			expect(matchHasNarrowingPredicate({ kinds: ['question'] })).toBe(true);
			expect(matchHasNarrowingPredicate({ topicIncludes: ['naming'] })).toBe(true);
		});
		it('treats an empty match as not narrowing', () => {
			expect(matchHasNarrowingPredicate({})).toBe(false);
			expect(matchHasNarrowingPredicate({ kinds: [], topicIncludes: [] })).toBe(false);
		});
		it('hasNarrowingPredicate delegates to the match check', () => {
			expect(hasNarrowingPredicate(rule({ match: { maxRisk: 'low' } }))).toBe(true);
			expect(hasNarrowingPredicate(rule({ match: {} }))).toBe(false);
		});
	});
	describe('rule matching', () => {
		it('respects maxRisk', () => {
			const r = rule({ match: { maxRisk: 'low' } });
			expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
				true
			);
			expect(
				ruleMatchesClassification(r, classification({ kind: 'question', risk: 'medium' }))
			).toBe(false);
		});
		it('respects kinds filter', () => {
			const r = rule({ match: { kinds: ['blocked'] } });
			expect(ruleMatchesClassification(r, classification({ kind: 'blocked', risk: 'low' }))).toBe(
				true
			);
			expect(ruleMatchesClassification(r, classification({ kind: 'question', risk: 'low' }))).toBe(
				false
			);
		});
		it('respects topicIncludes (case-insensitive)', () => {
			const r = rule({ match: { topicIncludes: ['TABS'] } });
			expect(
				ruleMatchesClassification(
					r,
					classification({ kind: 'question', risk: 'low', topic: 'should i use tabs' })
				)
			).toBe(true);
			expect(
				ruleMatchesClassification(
					r,
					classification({ kind: 'question', risk: 'low', topic: 'rename the module' })
				)
			).toBe(false);
		});
	});
	describe('scope filtering', () => {
		it('global rules always apply', () => {
			expect(ruleAppliesToScope(rule({ scope: 'global' }), {})).toBe(true);
		});
		it('project rules apply only for the matching project path', () => {
			const r = rule({ scope: 'project', scopeId: '/repo/a' });
			expect(ruleAppliesToScope(r, { projectPath: '/repo/a' })).toBe(true);
			expect(ruleAppliesToScope(r, { projectPath: '/repo/b' })).toBe(false);
			expect(ruleAppliesToScope(r, {})).toBe(false);
		});
		it('tab rules apply only for the matching tab id', () => {
			const r = rule({ scope: 'tab', scopeId: 'tab-1' });
			expect(ruleAppliesToScope(r, { tabId: 'tab-1' })).toBe(true);
			expect(ruleAppliesToScope(r, { tabId: 'tab-2' })).toBe(false);
		});
	});
	describe('selectRule precedence', () => {
		it('picks the lowest priority number among matches', () => {
			const low = rule({ priority: 10, answer: 'low-pri-wins' });
			const high = rule({ priority: 50, answer: 'high-pri' });
			const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [high, low], {});
			expect(picked?.id).toBe(low.id);
		});
		it('skips disabled and out-of-scope rules', () => {
			const disabled = rule({ priority: 1, enabled: false });
			const wrongScope = rule({ priority: 2, scope: 'project', scopeId: '/other' });
			const ok = rule({ priority: 3 });
			const picked = selectRule(classification({ kind: 'question', risk: 'low' }), [
				disabled,
				wrongScope,
				ok,
			]);
			expect(picked?.id).toBe(ok.id);
		});
	});
	describe('decide - confidence gating', () => {
		it('escalates instead of auto-answering a low-confidence classification', () => {
			const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
			const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'low' }), [r]);
			expect(d.action).toBe('escalate');
			expect(d.reason).toContain('low-confidence');
		});
		it('still auto-answers a medium-confidence classification matched by a rule', () => {
			const r = rule({ match: { maxRisk: 'low' }, action: 'auto_answer', answer: 'go' });
			const d = decide(classification({ kind: 'question', risk: 'low', confidence: 'medium' }), [
				r,
			]);
			expect(d.action).toBe('auto_answer');
		});
	});
	describe('scope normalization case-sensitivity', () => {
		const originalPlatform = process.platform;
		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});
		it('folds case on Windows (case-insensitive filesystem)', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			const r = rule({ scope: 'project', scopeId: 'C:/Repo/App' });
			expect(ruleAppliesToScope(r, { projectPath: 'c:/repo/app' })).toBe(true);
		});
		it('does NOT fold case off Windows (case-sensitive filesystem)', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			const r = rule({ scope: 'project', scopeId: '/repo/App' });
			expect(ruleAppliesToScope(r, { projectPath: '/repo/app' })).toBe(false);
			expect(ruleAppliesToScope(r, { projectPath: '/repo/App' })).toBe(true);
		});
	});
});
// Source: src/__tests__/shared/pianola/pianola-synthesis.test.ts
describe('', () => {
	function pair(
		kind: S4_PianolaSignalKind,
		risk: S4_PianolaRisk,
		polarity: ReplyPolarity,
		i = 0
	): DecisionPair {
		const value = createMockNativeDecisionPair(`${kind}-${risk}-${i}`);
		value.classification.kind = kind;
		value.classification.risk = risk;
		value.polarity = polarity;
		value.reply = polarity === 'affirmative' ? value.reply : 'No, stop.';
		value.evidence!.answer = value.reply;
		return value;
	}
	function manyPairs(
		kind: S4_PianolaSignalKind,
		risk: S4_PianolaRisk,
		count: number,
		affirmative: number
	): DecisionPair[] {
		const out: DecisionPair[] = [];
		for (let i = 0; i < count; i++) {
			out.push(pair(kind, risk, i < affirmative ? 'affirmative' : 'other', i));
		}
		return out;
	}
	describe('synthesizeSuggestions', () => {
		it('proposes a low-risk auto_answer rule for a consistently approved exact scoped question', () => {
			const pairs = manyPairs('question', 'low', SUGGESTION_MIN_SAMPLES, SUGGESTION_MIN_SAMPLES);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals).toHaveLength(1);
			expect(proposals[0].action).toBe('auto_answer');
			expect(proposals[0].match.kinds).toEqual(['question']);
			expect(proposals[0].match.maxRisk).toBe('low');
		});
		it('every proposal is valid per validatePianolaRule', () => {
			const pairs = manyPairs('question', 'low', 10, 10);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals.length).toBeGreaterThan(0);
			for (const p of proposals) {
				expect(validatePianolaRule(p)).not.toBeNull();
			}
		});
		it('does not propose below the sample threshold', () => {
			const pairs = manyPairs(
				'question',
				'low',
				SUGGESTION_MIN_SAMPLES - 1,
				SUGGESTION_MIN_SAMPLES - 1
			);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals).toHaveLength(0);
		});
		it('does not propose when approvals are inconsistent', () => {
			// 10 samples, only 5 affirmative (50%) - below the ratio.
			const pairs = manyPairs('question', 'low', 10, 5);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals).toHaveLength(0);
		});
		it('never proposes an auto_answer for medium or high risk', () => {
			const pairs = [
				...manyPairs('question', 'medium', 20, 20),
				...manyPairs('blocked', 'high', 20, 20),
			];
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals).toHaveLength(0);
		});
		it('does not duplicate an accepted rule for the same exact scoped answer', () => {
			const existing: S4_PianolaRule = {
				id: 'r1',
				enabled: true,
				scope: 'agent',
				scopeId: 'fixture-agent',
				match: {
					kinds: ['question'],
					maxRisk: 'low',
					exactQuestion: 'Should I run `git status`?',
					groupId: 'fixture-group',
				},
				action: 'auto_answer',
				answer: 'Yes, run git status.',
				priority: 1,
				createdAt: 1,
				updatedAt: 1,
			};
			const pairs = manyPairs('question', 'low', 10, 10);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
			expect(proposals).toHaveLength(0);
		});
		it('builds a profile diff against the existing profile', () => {
			const pairs = manyPairs('question', 'low', 6, 6);
			const { profileDiff } = synthesizeSuggestions({
				pairs,
				existingRules: [],
				existingProfile: 'old profile',
				now: 1,
			});
			expect(profileDiff.before).toBe('old profile');
			expect(profileDiff.after.length).toBeGreaterThan(0);
			expect(profileDiff.changed).toBe(true);
		});
		it('reports no profile change for an empty corpus', () => {
			const { profileDiff, proposals } = synthesizeSuggestions({
				pairs: [],
				existingRules: [],
				now: 1,
			});
			expect(proposals).toHaveLength(0);
			expect(profileDiff.changed).toBe(false);
		});
	});
	describe('synthesizeSuggestions - safety scoping', () => {
		it('never proposes for the blocked kind (only question)', () => {
			const pairs = manyPairs('blocked', 'low', 50, 50);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [], now: 1 });
			expect(proposals).toHaveLength(0);
		});
		it('does not let a global kinds-only rule erase a narrower proposal', () => {
			const existing: S4_PianolaRule = {
				id: 'r-no-maxrisk',
				enabled: true,
				scope: 'global',
				match: { kinds: ['question'] },
				action: 'auto_answer',
				answer: 'sure',
				priority: 1,
				createdAt: 1,
				updatedAt: 1,
			};
			const pairs = manyPairs('question', 'low', 10, 10);
			const { proposals } = synthesizeSuggestions({ pairs, existingRules: [existing], now: 1 });
			expect(proposals).toHaveLength(1);
		});
	});
	describe('R08 independent human evidence and durable conflict projection', () => {
		it.each([
			'May I merge this PR?',
			'May I grant write access?',
			'Should I send this email?',
			'Should I deploy to production?',
		])('never turns repeated single-action permission for %s into a learned rule', (ask) => {
			const pairs = manyPairs('question', 'low', 3, 3);
			for (const sample of pairs) {
				sample.ask = sample.evidence!.question = sample.classification.questionText = ask;
			}
			expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
		});
		it.each(['duplicate ask', 'duplicate answer', 'unknown', 'rule', 'Mira'])(
			'does not promote two humans plus %s to three independent decisions',
			(variant) => {
				const pairs = manyPairs('question', 'low', 3, 3);
				if (variant === 'duplicate ask') pairs[2] = structuredClone(pairs[0]);
				if (variant === 'duplicate answer')
					pairs[2].evidence!.answerMessageId = pairs[0].evidence!.answerMessageId;
				if (variant === 'unknown') delete pairs[2].evidence;
				if (variant === 'rule' || variant === 'Mira')
					Object.assign(pairs[2].evidence!, { principal: variant, sourceKind: variant });
				expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
			}
		);
		it.each(['agent', 'group', 'question', 'conditions'])(
			'does not pool unrelated yes answers across %s boundaries',
			(variant) => {
				const pairs = manyPairs('question', 'low', 3, 3);
				const last = pairs[2];
				if (variant === 'agent') last.evidence!.agentId = 'another-agent';
				if (variant === 'group') last.evidence!.groupId = 'another-group';
				if (variant === 'conditions') last.evidence!.conditions = ['only after backup'];
				if (variant === 'question') {
					last.ask = 'Should I run `git diff`?';
					last.evidence!.question = last.ask;
					last.classification.questionText = last.ask;
				}
				expect(synthesizeSuggestions({ pairs, existingRules: [] }).candidates).toEqual([]);
			}
		);
		it('retains exact independent links and boundaries with an order/time stable fingerprint', () => {
			const pairs = manyPairs('question', 'low', 3, 3);
			const candidate = synthesizeSuggestions({ pairs, existingRules: [], now: 1 }).candidates[0];
			expect(candidate.sampleCount).toBe(3);
			expect(candidate.evidence).toEqual(pairs.map((sample) => sample.evidence));
			expect(candidate.conditions).toEqual([pairs[0].ask]);
			expect(candidate.exclusions).toEqual([
				'medium/high risk',
				'low confidence',
				'different question',
				'outside native scope/group',
			]);
			expect(candidate.rule).toMatchObject({
				enabled: false,
				scope: 'agent',
				scopeId: 'fixture-agent',
				match: { exactQuestion: pairs[0].ask, groupId: 'fixture-group' },
			});
			const reordered = synthesizeSuggestions({
				pairs: [...pairs].reverse(),
				existingRules: [],
				now: 999,
			}).candidates[0];
			expect(reordered.evidenceFingerprint).toBe(candidate.evidenceFingerprint);
			const changed = synthesizeSuggestions({
				pairs: [...pairs, pair('question', 'low', 'affirmative', 4)],
				existingRules: [],
			}).candidates[0];
			expect(changed.id).toBe(candidate.id);
			expect(changed.evidenceFingerprint).not.toBe(candidate.evidenceFingerprint);
		});
		it.each([
			'source answer',
			'source risk',
			'source conditions',
			'later contradiction',
			'other agent',
			'other group',
			'other conditions',
			'earlier contradiction',
			'unknown',
			'unchanged edited approval',
			'failed activation',
		])('projects review for %s only when accepted evidence is affected', (variant) => {
			const originals = manyPairs('question', 'low', 3, 3);
			const candidate = synthesizeSuggestions({ pairs: originals, existingRules: [], now: 1 })
				.candidates[0];
			const approvedAt = Date.parse('2026-10-28T00:01:00.000Z');
			const rule = { ...candidate.rule, enabled: true, updatedAt: approvedAt };
			if (variant === 'unchanged edited approval') rule.answer = 'No, wait for review.';
			const file: PianolaSuggestionsFile = {
				generatedAt: 1,
				pairCount: 3,
				proposals: [],
				candidates: [],
				proposedProfile: '',
				previousProfile: '',
				approvals: [
					{
						sourceKind: 'native-human-review',
						principal: 'chris',
						actorId: 'desktop',
						candidate,
						rule,
						approvedAt,
						edited: variant === 'unchanged edited approval',
					},
				],
			};
			const snapshots = structuredClone(originals);
			if (variant.startsWith('source')) {
				const corrected = structuredClone(originals[0]);
				if (variant === 'source answer') {
					corrected.reply = corrected.evidence!.answer = 'No, stop.';
					corrected.polarity = 'negative';
				}
				if (variant === 'source risk') corrected.classification.risk = 'high';
				if (variant === 'source conditions') corrected.evidence!.conditions = ['after review'];
				snapshots.push(corrected);
			} else if (!['unchanged edited approval', 'failed activation'].includes(variant)) {
				const later = pair('question', 'low', 'negative', 10);
				later.repliedAt = later.evidence!.answeredAt = '2026-10-28T00:02:00.000Z';
				if (variant === 'other agent') later.evidence!.agentId = 'another-agent';
				if (variant === 'other group') later.evidence!.groupId = 'another-group';
				if (variant === 'other conditions') later.evidence!.conditions = ['after review'];
				if (variant === 'earlier contradiction')
					later.repliedAt = later.evidence!.answeredAt = '2026-10-28T00:00:30.000Z';
				if (variant === 'unknown') delete later.evidence;
				snapshots.push(later);
			}
			const live = variant === 'failed activation' ? [] : [structuredClone(rule)];
			const before = structuredClone(live);
			const result = reconcileSuggestionEvidence(file, snapshots, live, approvedAt + 1000);
			const requiresReview = variant.startsWith('source') || variant === 'later contradiction';
			expect(result.conflicts).toHaveLength(requiresReview ? 1 : 0);
			if (requiresReview) {
				expect(result.conflicts![0]).toMatchObject({
					ruleId: rule.id,
					evidenceFingerprint: candidate.evidenceFingerprint,
					approvedAt,
					status: 'needs_review',
					nextActor: 'human',
					reason: variant.startsWith('source') ? 'source_corrected' : 'contradictory_decision',
				});
				expect(result.conflicts![0].evidence).toEqual([snapshots.at(-1)!.evidence]);
				expect(result.conflicts![0].nextAction).toContain('Owner');
			}
			expect(live).toEqual(before);
			expect(result.approvals).toEqual(file.approvals);
		});
	});
	describe('owner compatibility provenance', () => {
		it('preserves the legacy fingerprint when only generated description changes', () => {
			const pairs = manyPairs('question', 'low', 3, 3);
			const candidate = synthesizeSuggestions({ pairs, existingRules: [], now: 1 }).candidates[0];
			const copy = structuredClone(candidate);
			copy.rule.description = 'Neutral generated description';
			expect(pianolaCandidateEvidenceFingerprint(copy)).toBe(candidate.evidenceFingerprint);
			expect(candidate.evidenceFingerprint).toBe(
				canonicalJson({
					id: candidate.id,
					scope: candidate.rule.scope,
					scopeId: candidate.rule.scopeId,
					match: candidate.rule.match,
					action: candidate.action,
					conditions: candidate.conditions,
					exclusions: candidate.exclusions,
					answer: candidate.rule.answer,
					evidence: candidate.evidence.map((source) => canonicalJson(source)).sort(),
				})
			);
			expect(synthesizeSuggestions({ pairs, existingRules: [], now: 2 }).candidates[0].id).toBe(
				candidate.id
			);
		});
		it.each(['chris', 'owner'])(
			'accepts %s evidence without changing its spelling',
			(principal) => {
				const pairs = manyPairs('question', 'low', 3, 3);
				for (const value of pairs) Object.assign(value.evidence!, { principal });
				const candidate = synthesizeSuggestions({ pairs, existingRules: [] }).candidates[0];
				expect(candidate.evidence.map((source) => source.principal)).toEqual([
					principal,
					principal,
					principal,
				]);
				expect(candidate.evidenceFingerprint).toBe(pianolaCandidateEvidenceFingerprint(candidate));
			}
		);
		it('treats a principal change for the same ask as conflicting source evidence', () => {
			const pairs = manyPairs('question', 'low', 3, 3);
			const changed = structuredClone(pairs[0]);
			Object.assign(changed.evidence!, { principal: 'owner' });
			expect(
				synthesizeSuggestions({ pairs: [...pairs, changed], existingRules: [] }).candidates
			).toEqual([]);
		});
	});
	describe('durable legacy review compatibility', () => {
		it('preserves legacy receipts and rejects attribution replacement at the actual store seam', () => {
			const directory = s4_fs.mkdtempSync(s4_path.join(s4_os.tmpdir(), 'owner-review-'));
			try {
				const store = createPianolaFsStore({
					resolveDir: () => directory,
					indent: 2,
					trailingNewline: true,
				});
				const candidate = synthesizeSuggestions({
					pairs: manyPairs('question', 'low', 3, 3),
					existingRules: [],
					now: 1,
				}).candidates[0];
				const rejection = {
					sourceKind: 'native-human-review' as const,
					principal: 'chris' as const,
					actorId: 'desktop',
					candidateId: candidate.id,
					evidenceFingerprint: candidate.evidenceFingerprint,
					candidate,
					rejectedAt: 2,
				};
				const file: PianolaSuggestionsFile = {
					generatedAt: 1,
					pairCount: 3,
					proposals: [candidate.rule],
					candidates: [candidate],
					proposedProfile: '',
					previousProfile: '',
					rejections: [rejection],
				};
				store.writeSuggestions(file);
				const restarted = createPianolaFsStore({
					resolveDir: () => directory,
					indent: 2,
					trailingNewline: true,
				});
				expect(restarted.readSuggestions().rejections).toEqual([rejection]);
				expect(restarted.writeSuggestions({ ...file, rejections: [] }).candidates).toEqual([]);
				const forged = { ...rejection, actorId: 'another-actor' };
				try {
					restarted.writeSuggestions({ ...file, rejections: [forged] });
				} catch {
					/* rejection is also fail closed */
				}
				expect(restarted.readSuggestions().rejections).toEqual([rejection]);
			} finally {
				s4_fs.rmSync(directory, { recursive: true, force: true });
			}
		});
		it.each(['chris', 'owner'])('retains %s review and raw source provenance', (principal) => {
			const candidate = synthesizeSuggestions({
				pairs: manyPairs('question', 'low', 3, 3),
				existingRules: [],
				now: 1,
			}).candidates[0];
			const approval = {
				sourceKind: 'native-human-review',
				principal,
				actorId: 'desktop',
				candidate,
				rule: { ...candidate.rule, enabled: true, answer: 'Edited answer' },
				approvedAt: 2,
				edited: true,
			};
			const rejection = {
				sourceKind: 'native-human-review',
				principal,
				actorId: 'desktop',
				candidateId: candidate.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				candidate,
				rejectedAt: 3,
			};
			const conflict = {
				ruleId: candidate.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				approvedAt: 2,
				detectedAt: 4,
				reason: 'source_corrected',
				status: 'needs_review',
				nextActor: 'human',
				nextAction: 'Review',
				evidence: [candidate.evidence[0]],
			};
			const result = validatePianolaSuggestionsFile({
				approvals: [approval],
				rejections: [rejection],
				conflicts: [conflict],
			});
			expect(result.approvals).toEqual([approval]);
			expect(result.rejections).toEqual([rejection]);
			expect(result.conflicts).toEqual([conflict]);
		});
		it('rejects arbitrary evidence principals', () => {
			const evidence = { ...createMockNativeDecisionPair().evidence!, principal: 'someone' };
			expect(isValidHumanDecisionEvidence(evidence)).toBe(false);
		});
		it('does not replace an approval principal on the same durable key', () => {
			const directory = s4_fs.mkdtempSync(s4_path.join(s4_os.tmpdir(), 'owner-approval-'));
			try {
				const store = createPianolaFsStore({
					resolveDir: () => directory,
					indent: 2,
					trailingNewline: true,
				});
				const candidate = synthesizeSuggestions({
					pairs: manyPairs('question', 'low', 3, 3),
					existingRules: [],
					now: 1,
				}).candidates[0];
				const approval = {
					sourceKind: 'native-human-review' as const,
					principal: 'chris' as const,
					actorId: 'desktop',
					candidate,
					rule: { ...candidate.rule, enabled: true },
					approvedAt: 2,
					edited: false,
				};
				const file: PianolaSuggestionsFile = {
					generatedAt: 1,
					pairCount: 3,
					proposals: [],
					proposedProfile: '',
					previousProfile: '',
					approvals: [approval],
				};
				store.writeSuggestions(file);
				const altered = structuredClone(file) as unknown as {
					approvals: Array<Record<string, unknown>>;
				};
				altered.approvals[0].principal = 'owner';
				try {
					store.writeSuggestions(altered as unknown as PianolaSuggestionsFile);
				} catch {
					/* rejection is fail closed */
				}
				expect(store.readSuggestions().approvals).toEqual([approval]);
			} finally {
				s4_fs.rmSync(directory, { recursive: true, force: true });
			}
		});
		it.each(['approvals', 'rejections'] as const)(
			'rejects unknown principals in otherwise valid %s',
			(kind) => {
				const candidate = synthesizeSuggestions({
					pairs: manyPairs('question', 'low', 3, 3),
					existingRules: [],
					now: 1,
				}).candidates[0];
				const receipt = {
					sourceKind: 'native-human-review',
					principal: 'owner',
					actorId: 'desktop',
					candidate,
					...(kind === 'approvals'
						? { rule: { ...candidate.rule, enabled: true }, approvedAt: 2, edited: false }
						: {
								candidateId: candidate.id,
								evidenceFingerprint: candidate.evidenceFingerprint,
								rejectedAt: 2,
							}),
				};
				expect(validatePianolaSuggestionsFile({ [kind]: [receipt] })[kind]).toHaveLength(1);
				expect(() =>
					validatePianolaSuggestionsFile({ [kind]: [{ ...receipt, principal: 'someone' }] })
				).toThrow(
					kind === 'approvals' ? 'InvalidSuggestionApproval' : 'InvalidSuggestionRejection'
				);
			}
		);
	});
});
// Source: src/__tests__/shared/pianola/supervisor-storage.test.ts
describe('', () => {
	function validWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'w1',
			kind: 'watch',
			enabled: true,
			createdAt: 1,
			tabId: 'tab-1',
			agentId: 'agent-1',
			...overrides,
		};
	}
	function validOrchestrate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'o1',
			kind: 'orchestrate',
			enabled: true,
			createdAt: 2,
			planId: 'plan-1',
			...overrides,
		};
	}
	describe('validatePianolaSupervisorFile', () => {
		it('accepts well-formed watch and orchestrate targets', () => {
			const result = validatePianolaSupervisorFile({
				targets: [validWatch(), validOrchestrate()],
			});
			expect(result.targets).toHaveLength(2);
			const [watch, orchestrate] = result.targets;
			expect(watch).toMatchObject({
				id: 'w1',
				kind: 'watch',
				tabId: 'tab-1',
				agentId: 'agent-1',
			});
			expect(orchestrate).toMatchObject({ id: 'o1', kind: 'orchestrate', planId: 'plan-1' });
		});
		it('keeps optional intervalSeconds and concurrency when present and numeric', () => {
			const result = validatePianolaSupervisorFile({
				targets: [
					validWatch({ intervalSeconds: 10 }),
					validOrchestrate({ intervalSeconds: 7, concurrency: 4 }),
				],
			});
			expect(result.targets[0].intervalSeconds).toBe(10);
			expect(result.targets[1].intervalSeconds).toBe(7);
			expect(result.targets[1].concurrency).toBe(4);
		});
		it('drops a watch target missing tabId or agentId', () => {
			const result = validatePianolaSupervisorFile({
				targets: [
					validWatch({ tabId: undefined }),
					validWatch({ id: 'w2', agentId: undefined }),
					validWatch({ id: 'w3' }),
				],
			});
			// Only the fully-specified watch survives.
			expect(result.targets).toHaveLength(1);
			expect(result.targets[0].id).toBe('w3');
		});
		it('drops an orchestrate target missing planId', () => {
			const result = validatePianolaSupervisorFile({
				targets: [validOrchestrate({ planId: undefined }), validOrchestrate({ id: 'o2' })],
			});
			expect(result.targets).toHaveLength(1);
			expect(result.targets[0].id).toBe('o2');
		});
		it('drops targets with an invalid kind, enabled, createdAt, or empty id', () => {
			const result = validatePianolaSupervisorFile({
				targets: [
					validWatch({ kind: 'nonsense' }),
					validWatch({ id: 'w2', enabled: 'yes' }),
					validWatch({ id: 'w3', createdAt: 'soon' }),
					validWatch({ id: '' }),
				],
			});
			expect(result.targets).toHaveLength(0);
		});
		it('returns a well-formed empty object for junk input', () => {
			expect(validatePianolaSupervisorFile(null)).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile(undefined)).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile('nope')).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile(42)).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile([])).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile({})).toEqual({ targets: [] });
			expect(validatePianolaSupervisorFile({ targets: 'not-an-array' })).toEqual({
				targets: [],
			});
			expect(validatePianolaSupervisorFile({ targets: [1, 'x', null, {}] })).toEqual({
				targets: [],
			});
		});
	});
	describe('validatePianolaSupervisedTarget', () => {
		it('returns the typed target for valid input', () => {
			const target = validatePianolaSupervisedTarget(validWatch());
			const expected: PianolaSupervisedTarget = {
				id: 'w1',
				kind: 'watch',
				enabled: true,
				createdAt: 1,
				tabId: 'tab-1',
				agentId: 'agent-1',
			};
			expect(target).toEqual(expected);
		});
		it('returns null for a non-finite numeric field', () => {
			expect(validatePianolaSupervisedTarget(validWatch({ createdAt: Number.NaN }))).toBeNull();
			expect(
				validatePianolaSupervisedTarget(validOrchestrate({ concurrency: Number.POSITIVE_INFINITY }))
			).toBeNull();
		});
		it('keeps a non-negative idleHours and drops a negative or non-numeric one', () => {
			expect(validatePianolaSupervisedTarget(validWatch({ idleHours: 0 }))?.idleHours).toBe(0);
			expect(validatePianolaSupervisedTarget(validWatch({ idleHours: 2.5 }))?.idleHours).toBe(2.5);
			expect(validatePianolaSupervisedTarget(validWatch({ idleHours: -1 }))).toBeNull();
			expect(validatePianolaSupervisedTarget(validWatch({ idleHours: '6' }))).toBeNull();
		});
		it('returns null when an optional field is present but the wrong type', () => {
			expect(validatePianolaSupervisedTarget(validWatch({ intervalSeconds: '5' }))).toBeNull();
			expect(validatePianolaSupervisedTarget(validOrchestrate({ planId: 123 }))).toBeNull();
		});
	});
});
// Source: src/__tests__/shared/pianola/decision-log.test.ts
describe('', () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = s6_fs.mkdtempSync(s6_path.join(s6_os.tmpdir(), 'maestro-declog-'));
		file = s6_path.join(dir, 'pianola-decisions.jsonl');
	});
	afterEach(() => s6_fs.rmSync(dir, { recursive: true, force: true }));
	/** A valid JSON-object line, comfortably over the 50-byte record floor. */
	function jsonLine(i: number): string {
		return `${JSON.stringify({ id: `rec-${String(i).padStart(5, '0')}`, pad: 'x'.repeat(50) })}\n`;
	}
	function writeLines(count: number): void {
		for (let i = 0; i < count; i += 1) appendDecisionLine(file, jsonLine(i));
	}
	function nonEmptyLines(): string[] {
		return s6_fs
			.readFileSync(file, 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
	}
	describe('compactDecisionLog', () => {
		it('trims to maxRecords on the record-count trigger (file under the byte cap)', () => {
			writeLines(25);
			expect(s6_fs.statSync(file).size).toBeLessThan(1000000);
			compactDecisionLog(file, 10, 1000000);
			const lines = nonEmptyLines();
			expect(lines.length).toBe(10);
			// Oldest dropped, newest kept.
			expect(lines.some((l) => l.includes('rec-00024'))).toBe(true);
			expect(lines.some((l) => l.includes('rec-00000'))).toBe(false);
		});
		it('leaves a file already within both caps unchanged', () => {
			writeLines(8);
			const before = s6_fs.readFileSync(file, 'utf-8');
			compactDecisionLog(file, 10, 1000000);
			expect(s6_fs.readFileSync(file, 'utf-8')).toBe(before);
		});
		it('does not leave a .lock behind after compaction', () => {
			writeLines(25);
			compactDecisionLog(file, 10, 1000000);
			expect(s6_fs.existsSync(`${file}.lock`)).toBe(false);
		});
		it('honors BOTH caps under a tiny byte budget', () => {
			writeLines(25);
			const byteCap = 200;
			compactDecisionLog(file, 10, byteCap);
			const lines = nonEmptyLines();
			expect(lines.length).toBeGreaterThanOrEqual(1);
			expect(lines.length).toBeLessThanOrEqual(10);
			expect(s6_fs.statSync(file).size).toBeLessThanOrEqual(byteCap);
		});
	});
	/** A record line whose serialized byte length exceeds the per-record cap. */
	function oversizedLine(): string {
		const answer = 'x'.repeat(PIANOLA_DECISION_RECORD_MAX_BYTES);
		return `${JSON.stringify({ id: 'huge', answer })}\n`;
	}
	describe('appendDecisionLine - per-record byte cap', () => {
		it('appends a normal within-cap record', () => {
			appendDecisionLine(file, jsonLine(0));
			expect(nonEmptyLines().length).toBe(1);
		});
		it('drops a single record over the per-record byte cap (never written)', () => {
			appendDecisionLine(file, oversizedLine());
			expect(s6_fs.existsSync(file)).toBe(false);
		});
		it('keeps small records around a dropped oversized one', () => {
			appendDecisionLine(file, jsonLine(1));
			appendDecisionLine(file, oversizedLine());
			appendDecisionLine(file, jsonLine(2));
			const lines = nonEmptyLines();
			expect(lines.length).toBe(2);
			expect(lines.some((l) => l.includes('huge'))).toBe(false);
			expect(lines.some((l) => l.includes('rec-00001'))).toBe(true);
			expect(lines.some((l) => l.includes('rec-00002'))).toBe(true);
		});
	});
});
