/**
 * @file pianola-orchestrate.test.ts
 * @description Tests for the Pianola orchestrate CLI loop. The key invariant: a
 * transient iteration error (e.g. a WS sendCommand timeout that rejects out of
 * runOrchestratorIteration) is logged and the run KEEPS GOING - it must not tear
 * down the whole orchestration. Mirrors the watcher's per-iteration try/catch.
 * The orchestration engine and the WebSocket client are mocked.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentRun } from '../../../shared/agent-run';
import type {
	OrchestratorState,
	OrchestratorDeps,
} from '../../../shared/pianola/pianola-orchestrator';
import type { PianolaPlan, PianolaPlanProgress } from '../../../shared/pianola/pianola-tasks';

const {
	connectMock,
	sendCommandMock,
	disconnectMock,
	runIterationMock,
	upsertAgentRunMock,
	appendAgentRunEventMock,
	getAgentRunMock,
	findActiveRunBySessionMock,
} = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendCommandMock: vi.fn(),
	disconnectMock: vi.fn(),
	runIterationMock: vi.fn(),
	upsertAgentRunMock: vi.fn(),
	appendAgentRunEventMock: vi.fn(),
	getAgentRunMock: vi.fn(),
	findActiveRunBySessionMock: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaPlans: vi.fn(() => []),
	getPianolaPlan: vi.fn(),
	upsertPianolaPlan: vi.fn(),
	updatePianolaPlans: vi.fn((update: (plans: PianolaPlan[]) => PianolaPlan[]) =>
		update(readPianolaPlans())
	),
	readPianolaPrograms: vi.fn(() => []),
	withPianolaPlanLock: vi.fn((_id: string, operation: () => Promise<unknown>) => operation()),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connectMock;
		sendCommand = sendCommandMock;
		disconnect = disconnectMock;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: vi.fn() }));
vi.mock('../../../shared/pianola/pianola-orchestrator', () => ({
	runOrchestratorIteration: runIterationMock,
	initialOrchestratorState: (plan: PianolaPlan): OrchestratorState => ({ plan, prevStates: {} }),
}));
vi.mock('../../../cli/services/agent-run-store', () => ({
	upsertAgentRun: upsertAgentRunMock,
	appendAgentRunEvent: appendAgentRunEventMock,
	getAgentRun: getAgentRunMock,
	findActiveRunBySession: findActiveRunBySessionMock,
}));

import {
	pianolaOrchestrate,
	pianolaPlanSet,
	pianolaPlanRevise,
	pianolaValidate,
	sandboxLaunchOptions,
	resolveExistingPianolaAgentType,
	resolvePianolaSandboxRunner,
} from '../../../cli/commands/pianola-orchestrate';
import { readSettingValue } from '../../../cli/services/storage';
import {
	getPianolaPlan,
	readPianolaPlans,
	upsertPianolaPlan,
	updatePianolaPlans,
	readPianolaPrograms,
} from '../../../cli/services/pianola-store';
import { runDispatch } from '../../../cli/commands/dispatch';

const PLAN: PianolaPlan = { id: 'plan-1', title: 'P', createdAt: 1, tasks: [] };

const DONE_PROGRESS: PianolaPlanProgress = {
	total: 0,
	pending: 0,
	running: 0,
	done: 0,
	failed: 0,
	blocked: 0,
	skipped: 0,
	complete: true,
};

function doneResult(state: OrchestratorState) {
	return {
		state,
		progress: DONE_PROGRESS,
		completedTaskIds: [],
		failedTaskIds: [],
		dispatchedTaskIds: [],
		done: true,
	};
}

describe('pianolaOrchestrate - iteration error resilience', () => {
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		connectMock.mockResolvedValue(undefined);
		disconnectMock.mockReturnValue(undefined);
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		vi.mocked(getPianolaPlan).mockReturnValue(PLAN);
		getAgentRunMock.mockReturnValue(undefined);
		findActiveRunBySessionMock.mockReturnValue(undefined);
		upsertAgentRunMock.mockImplementation((run) => run);
		appendAgentRunEventMock.mockImplementation((event) => event);
	});

	it('dispatches the persisted founder revision instead of its startup snapshot', async () => {
		const { runOrchestratorIteration: actualIteration } = await vi.importActual<
			typeof import('../../../shared/pianola/pianola-orchestrator')
		>('../../../shared/pianola/pianola-orchestrator');
		const completed = {
			id: 'done',
			title: 'Done',
			prompt: 'Done',
			status: 'done' as const,
			dependsOn: [],
		};
		const original: PianolaPlan = {
			...PLAN,
			tasks: [
				completed,
				{
					id: 'reviewed',
					title: 'Answer',
					prompt: 'Old prompt',
					status: 'needs_review',
					dependsOn: ['done'],
					agentId: 'engineer',
				},
			],
		};
		const revised: PianolaPlan = {
			...original,
			tasks: [completed, { ...original.tasks[1], status: 'pending', prompt: 'Founder correction' }],
		};
		vi.mocked(getPianolaPlan).mockReturnValueOnce(original).mockReturnValue(revised);
		sendCommandMock.mockImplementation(async (command) =>
			command.type === 'list_desktop_sessions'
				? {
						sessions: [
							{
								agentId: 'engineer',
								sessionId: 'tab',
								tabId: 'tab',
								toolType: 'codex',
								state: 'idle',
								active: true,
							},
						],
					}
				: { success: true, messages: [] }
		);
		vi.mocked(runDispatch).mockResolvedValue({ success: true, sessionId: 'tab' });
		runIterationMock.mockImplementation(actualIteration);
		let persisted: PianolaPlan | undefined;
		vi.mocked(upsertPianolaPlan).mockImplementationOnce((value) => {
			persisted = value;
			return [value];
		});
		await pianolaOrchestrate(PLAN.id, { once: true });
		expect(runDispatch).toHaveBeenCalledWith('engineer', 'Founder correction', { tab: 'tab' });
		expect(persisted?.tasks[0]).toEqual(completed);
		expect(persisted?.tasks[1]).toMatchObject({ prompt: 'Founder correction', status: 'running' });
	});

	it('does not start direct orchestration for a paused program', async () => {
		vi.mocked(getPianolaPlan).mockReturnValue({ ...PLAN, programId: 'p' });
		runIterationMock.mockImplementation(async (state: OrchestratorState) => doneResult(state));
		vi.mocked(readPianolaPrograms).mockReturnValue([
			{ id: 'p', status: 'paused', charter: { validationRequired: false, maxAttempts: 3 } },
		] as never);
		await pianolaOrchestrate('plan-1', { once: true });
		expect(connectMock).not.toHaveBeenCalled();
		expect(runIterationMock).not.toHaveBeenCalled();
	});
	it('honors a program pause before side effects inside an already-started tick', async () => {
		let paused = false;
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		vi.mocked(getPianolaPlan).mockReturnValue({ ...PLAN, programId: 'p' });
		vi.mocked(readPianolaPrograms).mockImplementation(
			() =>
				[
					{
						id: 'p',
						status: paused ? 'paused' : 'active',
						charter: { validationRequired: false, maxAttempts: 3 },
					},
				] as never
		);
		runIterationMock.mockImplementation(
			async (state: OrchestratorState, deps: OrchestratorDeps) => {
				paused = true;
				const task = {
					id: 't',
					title: 'T',
					prompt: 'p',
					dependsOn: [],
					status: 'pending' as const,
					agentId: 'agent-1',
					tabId: 'tab-1',
				};
				expect(await deps.ensureAgent(task)).toHaveProperty('error');
				expect((await deps.dispatch(task, 'agent-1')).success).toBe(false);
				expect((await deps.dispatchFix!(task, { checksPassed: false })).success).toBe(false);
				return doneResult(state);
			}
		);
		await pianolaOrchestrate('plan-1', { once: true });
		expect(errorSpy).not.toHaveBeenCalled();
		expect(runDispatch).not.toHaveBeenCalled();
	});
	it('pins boundary reads, initial dispatch, and fix dispatch to the same active tab', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		sendCommandMock.mockImplementation(async (command) =>
			command.type === 'list_desktop_sessions'
				? {
						sessions: [
							{
								agentId: 'agent-1',
								sessionId: 'other-tab',
								tabId: 'other-tab',
								toolType: 'codex',
								state: 'idle',
								active: false,
							},
							{
								agentId: 'agent-1',
								sessionId: 'target-tab',
								tabId: 'target-tab',
								toolType: 'claude-code',
								state: 'idle',
								active: true,
							},
						],
					}
				: { success: true, messages: [] }
		);
		vi.mocked(runDispatch).mockResolvedValue({ success: true, sessionId: 'target-tab' });
		runIterationMock.mockImplementation(
			async (state: OrchestratorState, deps: OrchestratorDeps) => {
				const task = {
					id: 't',
					title: 'T',
					prompt: 'p',
					dependsOn: [],
					status: 'pending' as const,
					agentId: 'agent-1',
				};
				const agent = await deps.ensureAgent(task);
				expect(agent).toMatchObject({
					agentId: 'agent-1',
					tabId: 'target-tab',
					agentType: 'claude-code',
				});
				if ('error' in agent) throw new Error(agent.error);
				const bound = { ...task, tabId: agent.tabId };
				await deps.getRecentMessages(bound, { fresh: true });
				await deps.dispatch(bound, 'agent-1');
				await deps.dispatchFix!(bound, { runId: 'run-1', checksPassed: false });
				expect(runDispatch).toHaveBeenNthCalledWith(1, 'agent-1', 'p', { tab: 'target-tab' });
				expect(runDispatch).toHaveBeenNthCalledWith(2, 'agent-1', expect.any(String), {
					tab: 'target-tab',
				});
				return doneResult(state);
			}
		);
		await pianolaOrchestrate('plan-1', { once: true });
		expect(errorSpy).not.toHaveBeenCalled();
	});
	it('surfaces runner configuration changes during an iteration instead of swallowing them', async () => {
		const oldExitCode = process.exitCode;
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : []
			);
			runIterationMock.mockImplementation(
				async (_state: OrchestratorState, deps: OrchestratorDeps) => {
					await deps.validate!({
						id: 't',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						cwd: '/work',
						validation: { command: ['true'], target: '/work' },
					});
					throw new Error('unreachable');
				}
			);
			const log = vi.spyOn(console, 'log');
			await pianolaOrchestrate('plan-1', { once: true, json: true });
			expect(
				log.mock.calls.some(([line]) => String(line).includes('PIANOLA_SANDBOX_CONFIGURATION'))
			).toBe(true);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = oldExitCode;
		}
	});
	it('does not treat a failed history response as an empty pre-dispatch transcript', async () => {
		sendCommandMock.mockResolvedValue({ success: false, error: 'history unavailable' });
		runIterationMock.mockImplementation(
			async (state: OrchestratorState, deps: OrchestratorDeps) => {
				await expect(
					deps.getRecentMessages(
						{ id: 't', title: 'T', prompt: 'p', dependsOn: [], status: 'running', tabId: 'tab-1' },
						{ fresh: true }
					)
				).rejects.toThrow('history unavailable');
				return doneResult(state);
			}
		);
		await pianolaOrchestrate('plan-1', { once: true });
		expect(errorSpy).not.toHaveBeenCalled();
	});
	it('logs a thrown iteration and keeps running until the plan completes', async () => {
		let calls = 0;
		runIterationMock.mockImplementation(async (state: OrchestratorState) => {
			calls += 1;
			if (calls === 1) throw new Error('ws timeout');
			return doneResult(state);
		});

		// interval '1' is the 1s minimum; the first tick throws, the loop logs and
		// sleeps, then the second tick completes the plan - proving the error did
		// not end the run.
		await pianolaOrchestrate('plan-1', { interval: '1' });

		expect(runIterationMock).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('iteration error: ws timeout'));
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it('still completes cleanly when the first iteration succeeds (happy path intact)', async () => {
		runIterationMock.mockImplementation(async (state: OrchestratorState) => doneResult(state));
		await pianolaOrchestrate('plan-1', {});
		expect(runIterationMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it('records dispatched Pianola tasks into the AgentRun ledger', async () => {
		const plan: PianolaPlan = {
			id: 'plan-2',
			title: 'Ship',
			createdAt: 100,
			tasks: [
				{ id: 'task-1', title: 'Build', prompt: 'build it', dependsOn: [], status: 'pending' },
			],
		};
		const runningPlan: PianolaPlan = {
			...plan,
			tasks: [
				{
					...plan.tasks[0],
					status: 'running',
					agentId: 'agent-1',
					agentType: 'claude-code',
					tabId: 'tab-1',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(plan);
		runIterationMock.mockResolvedValue({
			state: { plan: runningPlan, prevStates: { 'task-1': 'connecting' } },
			progress: { ...DONE_PROGRESS, total: 1, pending: 0, running: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: ['task-1'],
			done: false,
		});

		await pianolaOrchestrate('plan-2', { once: true });

		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'pianola:plan-2:task-1',
				provider: 'claude-code',
				status: 'running',
				agentId: 'agent-1',
				tabId: 'tab-1',
				prompt: 'build it',
				source: 'pianola:plan-2',
			})
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'pianola:plan-2:task-1',
				type: 'pianola.dispatched',
				status: 'running',
			})
		);
	});

	it('mirrors an engine-side needs_review task onto the run via the guarded producer (ISC-5.8)', async () => {
		// The engine routed task-1 to needs_review with a bound runId; the store's
		// run carries an open finding, so markNeedsReview must transition it.
		const reviewPlan: PianolaPlan = {
			id: 'plan-3',
			title: 'Review',
			createdAt: 100,
			tasks: [
				{
					id: 'task-1',
					title: 'Build',
					prompt: 'build it',
					dependsOn: [],
					status: 'needs_review',
					runId: 'run-nr',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(reviewPlan);
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-nr'
				? {
						id: 'run-nr',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'running',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [{ severity: 'high', category: 'security', message: 'issue', status: 'open' }],
					}
				: undefined
		);
		runIterationMock.mockImplementation(async () => ({
			state: { plan: reviewPlan, prevStates: {} },
			progress: { ...DONE_PROGRESS, total: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: [],
			done: true,
		}));

		await pianolaOrchestrate('plan-3', { once: true });

		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-nr', status: 'needs_review' })
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'run-nr', type: 'status_change', status: 'needs_review' })
		);
	});

	it('leaves the run alone when a needs_review task has no open findings (ISC-5.8 anti)', async () => {
		const reviewPlan: PianolaPlan = {
			id: 'plan-4',
			title: 'CleanReview',
			createdAt: 100,
			tasks: [
				{
					id: 'task-1',
					title: 'Build',
					prompt: 'build it',
					dependsOn: [],
					status: 'needs_review',
					runId: 'run-clean',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(reviewPlan);
		// Run exists but carries ZERO open findings (checks-only needs_review):
		// the guarded producer must refuse to park it in needs_review.
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-clean'
				? {
						id: 'run-clean',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'running',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [],
					}
				: undefined
		);
		runIterationMock.mockImplementation(async () => ({
			state: { plan: reviewPlan, prevStates: {} },
			progress: { ...DONE_PROGRESS, total: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: [],
			done: true,
		}));

		await pianolaOrchestrate('plan-4', { once: true });

		expect(upsertAgentRunMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'needs_review' })
		);
	});

	it('marks the run fixing through the producer when dispatchFix really dispatches (ISC-5.9)', async () => {
		// Autopilot on so the CLI's dispatchFix dep acts.
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		vi.mocked(runDispatch).mockResolvedValue({ success: true } as never);
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-fx'
				? {
						id: 'run-fx',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'needs_review',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [{ severity: 'high', category: 'security', message: 'issue', status: 'open' }],
					}
				: undefined
		);
		// Capture the deps the CLI hands the engine, then drive dispatchFix directly.
		let capturedDeps: Record<string, unknown> | undefined;
		runIterationMock.mockImplementation(async (state: OrchestratorState, deps: unknown) => {
			capturedDeps = deps as Record<string, unknown>;
			return doneResult(state);
		});

		await pianolaOrchestrate('plan-1', { once: true });
		const dispatchFix = capturedDeps?.dispatchFix as (
			task: unknown,
			ledger: unknown
		) => Promise<{ success: boolean }>;
		expect(dispatchFix).toBeTypeOf('function');

		const res = await dispatchFix(
			{
				id: 'task-1',
				title: 'Build',
				prompt: 'p',
				dependsOn: [],
				status: 'needs_review',
				agentId: 'agent-1',
				tabId: 'tab-1',
				fixAttempts: 0,
			},
			{ runId: 'run-fx', openFindings: 1, checksPassed: false }
		);

		expect(res.success).toBe(true);
		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-fx', status: 'fixing' })
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'run-fx',
				type: 'status_change',
				status: 'fixing',
				data: expect.objectContaining({ fixAgentId: 'agent-1' }),
			})
		);
	});

	it('writes no fixing status when the fix dispatch fails (ISC-5.9 anti)', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		vi.mocked(runDispatch).mockResolvedValue({ success: false, error: 'agent busy' } as never);
		let capturedDeps: Record<string, unknown> | undefined;
		runIterationMock.mockImplementation(async (state: OrchestratorState, deps: unknown) => {
			capturedDeps = deps as Record<string, unknown>;
			return doneResult(state);
		});

		await pianolaOrchestrate('plan-1', { once: true });
		const dispatchFix = capturedDeps?.dispatchFix as (
			task: unknown,
			ledger: unknown
		) => Promise<{ success: boolean }>;

		const res = await dispatchFix(
			{
				id: 'task-1',
				title: 'Build',
				tabId: 'tab-1',
				prompt: 'p',
				dependsOn: [],
				status: 'needs_review',
				agentId: 'agent-1',
			},
			{ runId: 'run-fx', openFindings: 1, checksPassed: false }
		);

		expect(res.success).toBe(false);
		expect(upsertAgentRunMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'fixing' })
		);
	});

	it('invalidates cached history after a fix dispatch and honors explicit fresh boundary reads', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		let history = [
			{
				id: 'old',
				role: 'assistant',
				source: 'ai',
				content: 'old reply',
				timestamp: new Date(0).toISOString(),
			},
		];
		sendCommandMock.mockImplementation(async (command) =>
			command.type === 'get_session_history' ? { messages: history } : { sessions: [] }
		);
		vi.mocked(runDispatch).mockImplementation(async () => {
			history = [
				...history,
				{
					id: 'fix',
					role: 'user',
					source: 'user',
					content: 'fix request',
					timestamp: new Date(1).toISOString(),
				},
			];
			return { success: true } as never;
		});
		runIterationMock.mockImplementation(
			async (state: OrchestratorState, deps: OrchestratorDeps) => {
				const task = {
					id: 't',
					title: 'T',
					prompt: 'p',
					dependsOn: [],
					status: 'needs_review' as const,
					agentId: 'agent-1',
					tabId: 'tab-1',
				};
				expect((await deps.getRecentMessages(task)).at(-1)?.id).toBe('old');
				await deps.dispatchFix!(task, {});
				expect((await deps.getRecentMessages(task)).at(-1)?.id).toBe('fix');
				history = [
					...history,
					{
						id: 'reply',
						role: 'assistant',
						source: 'ai',
						content: 'fixed',
						timestamp: new Date(2).toISOString(),
					},
				];
				expect((await deps.getRecentMessages(task, { fresh: true })).at(-1)?.id).toBe('reply');
				return doneResult(state);
			}
		);
		await pianolaOrchestrate('plan-1', { once: true });
	});

	it('does not require runner configuration when the program disables automatic validation', async () => {
		vi.mocked(readSettingValue).mockImplementation((key) =>
			key === 'encoreFeatures' ? { pianola: true } : []
		);
		vi.mocked(getPianolaPlan).mockReturnValue({
			...PLAN,
			programId: 'program-1',
			tasks: [
				{
					id: 't',
					title: 'T',
					prompt: 'p',
					dependsOn: [],
					status: 'running',
					cwd: '/work',
					validation: { command: ['true'], target: '/work' },
				},
			],
		});
		vi.mocked(readPianolaPrograms).mockReturnValueOnce([
			{ id: 'program-1', charter: { validationRequired: false } },
		] as never);
		runIterationMock.mockImplementation(async (state: OrchestratorState) => doneResult(state));
		await pianolaOrchestrate('plan-1', { once: true });
		expect(runIterationMock).toHaveBeenCalledOnce();
	});
});

describe('resolveExistingPianolaAgentType', () => {
	it('uses the live desktop session to backfill agentType for legacy agent-bound tasks', () => {
		expect(
			resolveExistingPianolaAgentType({ agentId: 'session-1' }, [
				{
					tabId: 'tab-1',
					sessionId: 'session-1',
					agentId: 'left-bar-owner',
					toolType: 'claude-code',
					state: 'idle',
				},
			])
		).toBe('claude-code');
	});

	it('keeps the stored task agentType ahead of live-session inference', () => {
		expect(
			resolveExistingPianolaAgentType({ agentId: 'session-1', agentType: 'codex' }, [
				{
					tabId: 'tab-1',
					sessionId: 'session-1',
					agentId: 'left-bar-owner',
					toolType: 'claude-code',
					state: 'idle',
				},
			])
		).toBe('codex');
	});
});

describe('pianola validate CLI', () => {
	it.each([true, false])(
		'passes the declared trusted root to the runner (program=%s)',
		async (withProgram) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-root-'));
			const runner = path.join(dir, 'runner.cjs');
			const argvFile = path.join(dir, 'argv.txt');
			const oldExitCode = process.exitCode;
			let run: AgentRun | undefined;
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			try {
				fs.writeFileSync(
					runner,
					'require("fs").writeFileSync(' +
						JSON.stringify(argvFile) +
						', JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({observed:true,returncode:0,stdout:"",stderr:"",timedOut:false,error:null}));'
				);
				vi.mocked(readSettingValue).mockImplementation((key) =>
					key === 'encoreFeatures' ? { pianola: true } : [process.execPath, runner]
				);
				vi.mocked(readPianolaPrograms).mockReturnValue([
					{ id: 'product', root: 'C:/approved' },
				] as never);
				vi.mocked(getPianolaPlan).mockReturnValue({
					...PLAN,
					...(withProgram ? { programId: 'product' } : {}),
					tasks: [
						{
							id: 't',
							title: 'T',
							prompt: 'p',
							dependsOn: [],
							status: 'running',
							cwd: '/standalone-root',
							validation: { command: ['true'], target: '/standalone-root/project' },
						},
					],
				});
				getAgentRunMock.mockImplementation(() => run);
				upsertAgentRunMock.mockImplementation((next: AgentRun) => {
					run = next;
					return next;
				});
				await pianolaValidate('plan-1', 't', { json: true });
				const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
				expect(argv[argv.indexOf('--trusted-root') + 1]).toBe(
					withProgram ? '/mnt/c/approved' : '/standalone-root'
				);
				expect(JSON.parse(log.mock.calls.at(-1)![0]).verdict).toBe('verified');
			} finally {
				process.exitCode = oldExitCode;
				log.mockRestore();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);
	it('fails closed without a standalone cwd instead of using validation.target as its authority', async () => {
		const oldExitCode = process.exitCode;
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		let run: AgentRun | undefined;
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : []
			);
			vi.mocked(getPianolaPlan).mockReturnValue({
				...PLAN,
				tasks: [
					{
						id: 't',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						validation: { command: ['true'], target: '/home/dev' },
					},
				],
			});
			getAgentRunMock.mockImplementation(() => run);
			upsertAgentRunMock.mockImplementation((next: AgentRun) => {
				run = next;
				return next;
			});
			await pianolaValidate('plan-1', 't', { json: true });
			const result = JSON.parse(log.mock.calls.at(-1)![0]);
			expect(result.verdict).toBe('failed');
			expect(result.reason).toContain('trusted-root policy');
			expect(process.exitCode).toBe(2);
		} finally {
			process.exitCode = oldExitCode;
			log.mockRestore();
		}
	});
	it('executes a configured runner, replaces its check and sets verdict exit codes', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-runner-'));
		const runner = path.join(dir, 'runner.cjs');
		let run: AgentRun | undefined;
		const oldExitCode = process.exitCode;
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : [process.execPath, runner]
			);
			vi.mocked(getPianolaPlan).mockReturnValue({
				...PLAN,
				tasks: [
					{
						id: 'task-1',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						cwd: 'C:/work',
						validation: { command: ['sh', '-c', 'true'], target: 'C:\\work', artifacts: [] },
					},
				],
			});
			getAgentRunMock.mockImplementation(() => run);
			upsertAgentRunMock.mockImplementation((next: AgentRun) => {
				run = next;
				return next;
			});
			for (const [rc, verdict, exitCode] of [
				[0, 'verified', 0],
				[1, 'failed', 2],
				[127, 'unknown', 3],
			] as const) {
				fs.writeFileSync(
					runner,
					'console.log(JSON.stringify({observed:true,returncode:' +
						rc +
						',stdout:process.argv.slice(2).join(" "),stderr:' +
						(rc === 127 ? '"not found"' : '""') +
						',timedOut:false,error:null}))'
				);
				await pianolaValidate('plan-1', 'task-1', { json: true });
				const result = JSON.parse(log.mock.lastCall![0] as string);
				expect(result.verdict).toBe(verdict);
				expect(result.runId).toBeDefined();
				expect(result.check.name).toBe('independent-validation');
				expect(result.check.status).toBe(
					verdict === 'unknown' ? 'error' : verdict === 'failed' ? 'failed' : 'passed'
				);
				expect(run?.checks).toHaveLength(1);
				expect(process.exitCode).toBe(exitCode);
			}
		} finally {
			process.exitCode = oldExitCode;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resolves root-relative artifacts to absolute sandbox paths before calling the runner', async () => {
		// Leads list artifacts the way they appear in a repo; the runner compares absolute paths.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-runner-'));
		const runner = path.join(dir, 'runner.cjs');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const oldExitCode = process.exitCode;
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : [process.execPath, runner]
			);
			vi.mocked(getPianolaPlan).mockReturnValue({
				...PLAN,
				tasks: [
					{
						id: 'task-1',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						cwd: 'C:/Users/x/forex-go',
						validation: {
							command: ['go', 'test', './...'],
							target: 'C:\\Users\\x\\forex-go',
							artifacts: ['internal/live/service.go', '/mnt/c/Users/x/forex-go/go.mod'],
						},
					},
				],
			});
			let run: AgentRun | undefined;
			getAgentRunMock.mockImplementation(() => run);
			upsertAgentRunMock.mockImplementation((next: AgentRun) => {
				run = next;
				return next;
			});
			const argvFile = path.join(dir, 'argv.txt');
			fs.writeFileSync(
				runner,
				'require("fs").writeFileSync(' +
					JSON.stringify(argvFile) +
					', process.argv.slice(2).join(" "));' +
					'console.log(JSON.stringify({observed:true,returncode:0,stdout:"",stderr:"",timedOut:false,error:null}))'
			);
			await pianolaValidate('plan-1', 'task-1', { json: true });
			const result = JSON.parse(log.mock.lastCall![0] as string);
			expect(result.verdict).toBe('verified');
			const argv = fs.readFileSync(argvFile, 'utf8');
			expect(argv).toContain('--artifact /mnt/c/Users/x/forex-go/internal/live/service.go');
			expect(argv).toContain('--artifact /mnt/c/Users/x/forex-go/go.mod');
		} finally {
			process.exitCode = oldExitCode;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('pianola plan set', () => {
	it('checks program exclusivity against the locked transaction snapshot', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-plan-transaction-'));
		const file = path.join(dir, 'plan.json');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('exit');
		}) as never);
		const competitor: PianolaPlan = {
			...PLAN,
			id: 'competitor',
			programId: 'product',
			tasks: [{ id: 'a', title: 'A', prompt: 'p', dependsOn: [], status: 'pending' }],
		};
		let saved = [competitor];
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		vi.mocked(readPianolaPlans).mockReturnValue([]);
		vi.mocked(updatePianolaPlans).mockImplementationOnce((update) => (saved = update(saved)));
		fs.writeFileSync(file, JSON.stringify({ ...competitor, id: 'new' }));
		try {
			expect(() => pianolaPlanSet({ file, json: true })).toThrow('exit');
			expect(JSON.parse(log.mock.lastCall![0] as string)).toMatchObject({ success: false });
			expect(saved).toEqual([competitor]);
			expect(saved.some((plan) => plan.id === 'new')).toBe(false);
			expect(updatePianolaPlans).toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			log.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it('refuses to overwrite a plan whose tasks have already started', () => {
		// A lead that reuses an earlier plan id would erase the run history and verified rows
		// hanging off it; the new outcome has to get a new id.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-plan-'));
		const file = path.join(dir, 'plan.json');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('exit');
		}) as never);
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : undefined
			);
			vi.mocked(readPianolaPlans).mockReturnValue([
				{
					...PLAN,
					id: 'fx-next',
					tasks: [{ id: 'a', title: 'A', prompt: 'p', dependsOn: [], status: 'done' }],
				},
			]);
			fs.writeFileSync(
				file,
				JSON.stringify({
					id: 'fx-next',
					title: 'Second outcome',
					createdAt: 2,
					tasks: [{ id: 'b', title: 'B', prompt: 'p', dependsOn: [], status: 'pending' }],
				})
			);
			expect(() => pianolaPlanSet({ file, json: true })).toThrow('exit');
			expect(JSON.parse(log.mock.lastCall![0] as string).error).toContain('already started');
			expect(upsertPianolaPlan).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			log.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('pianola plan revise', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
	});
	it('commits the correction from the transaction snapshot and preserves other plans', async () => {
		const completed = {
			id: 'done',
			title: 'Done',
			prompt: 'Done',
			status: 'done' as const,
			dependsOn: [],
			runId: 'verified',
		};
		const original: PianolaPlan = {
			...PLAN,
			tasks: [
				completed,
				{
					id: 'reviewed',
					title: 'Answer',
					prompt: 'Old prompt',
					status: 'needs_review',
					dependsOn: ['done'],
					agentId: 'engineer',
					validation: { command: ['true'], target: '/product' },
				},
			],
		};
		const other = { ...PLAN, id: 'other' };
		let saved = [original, other];
		vi.mocked(readPianolaPlans).mockReturnValue([]);
		vi.mocked(updatePianolaPlans).mockImplementationOnce((update) => (saved = update(saved)));
		await pianolaPlanRevise(PLAN.id, 'reviewed', { prompt: 'Founder correction', json: true });
		expect(saved[0]).toEqual({
			...original,
			tasks: [completed, { ...original.tasks[1], prompt: 'Founder correction', status: 'pending' }],
		});
		expect(saved[1]).toEqual(other);
	});
	it('rejects reopening a terminal plan when another plan owns the product', async () => {
		const original: PianolaPlan = {
			...PLAN,
			programId: 'product',
			tasks: [{ id: 'failed', title: 'Failed', prompt: 'Old', dependsOn: [], status: 'failed' }],
		};
		const competitor: PianolaPlan = {
			...original,
			id: 'competitor',
			tasks: [{ ...original.tasks[0], status: 'pending' }],
		};
		let saved = [original, competitor];
		vi.mocked(updatePianolaPlans).mockImplementationOnce((update) => (saved = update(saved)));
		const exitCode = process.exitCode;
		try {
			await pianolaPlanRevise(PLAN.id, 'failed', { prompt: 'Correction', json: true });
			expect(process.exitCode).toBe(1);
			expect(saved).toEqual([original, competitor]);
		} finally {
			process.exitCode = exitCode;
		}
	});
});

describe.runIf(process.platform === 'win32')('real WSL oracle argument boundary', () => {
	it.each([
		{ mode: 'exec', prefix: ['--exec'] },
		{ mode: 'short exec', prefix: ['-e'] },
		{ mode: 'no shell', prefix: ['--shell-type', 'none'] },
		{ mode: 'default shell', prefix: ['--'] },
		{ mode: 'login shell', prefix: ['--shell-type', 'login', '--'] },
	])(
		'preserves quotes, whitespace, and metacharacters through $mode',
		async ({ prefix }, context) => {
			const { spawnSync } =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const probe = spawnSync('wsl.exe', ['--exec', 'python3', '-c', 'pass'], {
				encoding: 'utf8',
				timeout: 10000,
				windowsHide: true,
			});
			if (probe.status !== 0) context.skip(probe.stderr || 'WSL Python is unavailable');
			const expected = ["it's", '^(A|B)$', 'space with words', 'double" quote', 'Unicode café'];
			const launch = sandboxLaunchOptions('wsl.exe', expected, [
				...prefix,
				'python3',
				'-c',
				'import json,sys; print(json.dumps(sys.argv[1:]))',
			]);
			const result = spawnSync('wsl.exe', launch.args, {
				encoding: 'utf8',
				timeout: 10000,
				windowsHide: true,
				windowsVerbatimArguments: launch.windowsVerbatimArguments,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(expected);
		}
	);
});

describe('portable default sandbox runner', () => {
	it('names the override when the installed runner is absent', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-no-runner-'));
		try {
			expect(() => resolvePianolaSandboxRunner(dir)).toThrow('pianola.sandboxRunner');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports invalid runner configuration without recording an unknown oracle verdict', async () => {
		const oldExitCode = process.exitCode;
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : []
			);
			vi.mocked(getPianolaPlan).mockReturnValue({
				...PLAN,
				tasks: [
					{
						id: 't',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						cwd: '/work',
						validation: { command: ['true'], target: '/work' },
					},
				],
			});
			appendAgentRunEventMock.mockClear();
			await pianolaValidate('plan-1', 't', { json: true });
			const result = JSON.parse(log.mock.lastCall![0] as string);
			expect(result).toMatchObject({ success: false, code: 'PIANOLA_SANDBOX_CONFIGURATION' });
			expect(result.error).toContain('pianola.sandboxRunner');
			expect(result.verdict).toBeUndefined();
			expect(appendAgentRunEventMock).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = oldExitCode;
			log.mockRestore();
		}
	});
});

describe('sandbox launcher wall-clock ceiling', () => {
	it('kills a runner that never exits and reports an unknown observation', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-hung-'));
		const runner = path.join(dir, 'runner.cjs');
		const pidFile = path.join(dir, 'pid.txt');
		const oldExitCode = process.exitCode;
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		let run: AgentRun | undefined;
		try {
			fs.writeFileSync(
				runner,
				`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`
			);
			vi.mocked(readSettingValue).mockImplementation((key) =>
				key === 'encoreFeatures' ? { pianola: true } : [process.execPath, runner]
			);
			vi.mocked(getPianolaPlan).mockReturnValue({
				...PLAN,
				tasks: [
					{
						id: 't',
						title: 'T',
						prompt: 'p',
						dependsOn: [],
						status: 'running',
						cwd: '/work',
						validation: { command: ['true'], target: '/work', timeoutSeconds: 1 },
					},
				],
			});
			getAgentRunMock.mockImplementation(() => run);
			upsertAgentRunMock.mockImplementation((next: AgentRun) => {
				run = next;
				return next;
			});
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const pending = pianolaValidate('plan-1', 't', { json: true });
			await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
			const pid = Number(fs.readFileSync(pidFile, 'utf8'));
			await vi.advanceTimersByTimeAsync(61_000);
			await pending;
			const result = JSON.parse(log.mock.lastCall![0] as string);
			expect(result.verdict).toBe('unknown');
			expect(result.reason).toContain('Sandbox launcher exceeded wall-clock ceiling of 61s');
			expect(result.check.status).toBe('error');
			expect(process.exitCode).toBe(3);
			vi.useRealTimers();
			await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
		} finally {
			vi.useRealTimers();
			process.exitCode = oldExitCode;
			log.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
