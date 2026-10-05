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
	readPianolaPrograms: vi.fn(() => []),
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
	pianolaValidate,
	quoteForPosixShell,
	resolveExistingPianolaAgentType,
	resolvePianolaSandboxRunner,
	sandboxSpawnArgs,
} from '../../../cli/commands/pianola-orchestrate';
import { readSettingValue } from '../../../cli/services/storage';
import {
	getPianolaPlan,
	readPianolaPlans,
	upsertPianolaPlan,
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

describe('sandbox launcher arguments', () => {
	it('single-quotes every argument when the runner is reached through wsl.exe', () => {
		// wsl.exe hands its argv to bash -c; an unquoted Go -run regex breaks that shell.
		const args = ['--', 'go', 'test', '-run', '^(A|B)$', "it's"];
		expect(
			sandboxSpawnArgs('wsl.exe', args, [
				'--',
				'python3',
				'/mnt/c/Program Files/Maestro/sandbox_runner.py',
			])
		).toEqual([
			'--',
			"'python3'",
			"'/mnt/c/Program Files/Maestro/sandbox_runner.py'",
			...args.map(quoteForPosixShell),
		]);
		expect(sandboxSpawnArgs('wsl.exe', args)).toEqual([
			"'--'",
			"'go'",
			"'test'",
			"'-run'",
			"'^(A|B)$'",
			"'it'\\''s'",
		]);
		expect(sandboxSpawnArgs('C:\\Windows\\System32\\wsl.exe', ['x'])).toEqual(["'x'"]);
	});
	it('passes arguments through untouched for a direct runner', () => {
		expect(sandboxSpawnArgs('python3', ['-run', '^(A|B)$'])).toEqual(['-run', '^(A|B)$']);
	});
	it('escapes embedded single quotes for a POSIX shell', () => {
		expect(quoteForPosixShell("a'b")).toBe("'a'\\''b'");
	});
});

describe('portable default sandbox runner', () => {
	it.each(['linux', 'darwin', 'win32'] as const)(
		'resolves a repository runner from the installed CLI on %s',
		(platform) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-default-'));
			try {
				const runner = path.join(dir, 'scripts/pianola-sandbox/sandbox_runner.py');
				fs.mkdirSync(path.dirname(runner), { recursive: true });
				fs.writeFileSync(runner, '');
				const prefix = resolvePianolaSandboxRunner(path.join(dir, 'dist/cli'), platform);
				expect(prefix).toEqual(
					platform === 'win32'
						? [
								'wsl.exe',
								'--',
								'python3',
								runner
									.replace(/^([a-z]):[\\/]/i, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
									.replace(/\\/g, '/'),
							]
						: ['python3', runner]
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);

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
