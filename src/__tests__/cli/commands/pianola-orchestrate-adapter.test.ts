import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../shared/agent-run';
import type { PianolaPlan, PianolaTask } from '../../../shared/pianola/pianola-tasks';

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	send: vi.fn(),
	disconnect: vi.fn(),
	dispatch: vi.fn(),
	readPlan: vi.fn(),
	savePlan: vi.fn(),
	getRun: vi.fn(),
	readRuns: vi.fn(),
	upsertRun: vi.fn(),
	appendEvent: vi.fn(),
	findActive: vi.fn(),
	settings: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: (...args: unknown[]) => mocks.settings(...args),
	resolveAgentId: (id: string) => id,
	readLiveSessions: () => [],
	readGroups: () => [],
}));
vi.mock('../../../cli/services/pianola-store', () => ({
	getPianolaPlan: mocks.readPlan,
	upsertPianolaPlan: mocks.savePlan,
	readPianolaPlans: () => [],
}));
vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: async (action: (client: unknown) => unknown) =>
		action({ sendCommand: mocks.send }),
	MaestroClient: class {
		connect = mocks.connect;
		sendCommand = mocks.send;
		disconnect = mocks.disconnect;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: mocks.dispatch }));
vi.mock('../../../cli/services/agent-run-store', () => ({
	getAgentRun: mocks.getRun,
	readAgentRuns: mocks.readRuns,
	upsertAgentRun: mocks.upsertRun,
	appendAgentRunEvent: mocks.appendEvent,
	findActiveRunBySession: mocks.findActive,
}));
import { AgentRunCaptureService } from '../../../main/agent-run/capture-service';
import { pianolaOrchestrate } from '../../../cli/commands/pianola-orchestrate';

const worker: PianolaTask = {
	id: 'worker',
	title: 'Worker',
	prompt: 'do work',
	dependsOn: [],
	status: 'pending',
	agentId: 'agent',
	agentType: 'codex',
};
const child: PianolaTask = {
	id: 'child',
	title: 'Child',
	prompt: 'follow up',
	dependsOn: ['worker'],
	status: 'pending',
	agentId: 'child-agent',
	agentType: 'codex',
};
let plan: PianolaPlan;
let entries: Array<Record<string, unknown>>;
let messages: Array<Record<string, unknown>>;
let runs: AgentRun[];
function captured(status: AgentRun['status'] = 'completed'): AgentRun {
	return {
		id: 'captured',
		sessionId: 'agent-ai-tab',
		tabId: 'tab',
		provider: 'codex',
		createdAt: 1,
		updatedAt: 2,
		status,
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		metadata: status === 'completed' ? { completedAt: 2, exitCode: 0 } : {},
	};
}
async function tick() {
	await pianolaOrchestrate(plan.id, { once: true });
}
function startBound(extra: Partial<PianolaTask> = {}) {
	plan.tasks[0] = { ...worker, status: 'running', tabId: 'tab', ...extra };
}

describe('Pianola real CLI adapter and orchestration engine', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.settings.mockReturnValue({ pianola: true });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		plan = { id: 'adapter', title: 'Adapter', createdAt: 1, tasks: [{ ...worker }, { ...child }] };
		entries = [
			{ tabId: 'tab', sessionId: 'tab', agentId: 'agent', toolType: 'codex', state: 'idle' },
		];
		messages = [];
		runs = [];
		mocks.readPlan.mockImplementation(() => plan);
		mocks.savePlan.mockImplementation((next) => {
			plan = next;
		});
		mocks.readRuns.mockImplementation(() => runs);
		mocks.getRun.mockImplementation((id) => runs.find((run) => run.id === id));
		mocks.findActive.mockImplementation((id) =>
			runs.find((run) => run.sessionId === id && run.status === 'running')
		);
		mocks.upsertRun.mockImplementation((run) => {
			runs = [...runs.filter((r) => r.id !== run.id), run];
			return run;
		});
		mocks.appendEvent.mockImplementation((event) => event);
		mocks.dispatch.mockResolvedValue({ success: true, sessionId: 'tab', tabId: 'tab' });
		mocks.send.mockImplementation(async (command) => {
			if (command.type === 'list_desktop_sessions') return { success: true, sessions: entries };
			if (command.type === 'get_session_history')
				return { success: true, agentId: 'agent', messages };
			return { success: true };
		});
	});
	it('dispatches into a new background tab and rejects success without its confirmed identity', async () => {
		mocks.dispatch.mockResolvedValue({ success: true, sessionId: null });
		await tick();
		expect(mocks.dispatch).toHaveBeenCalledWith(
			'agent',
			'do work',
			expect.objectContaining({ newTab: true, background: true })
		);
		expect(plan.tasks[0].status).toBe('needs_review');
		await tick();
		expect(plan.tasks[1].status).toBe('pending');
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
	});
	it('never completes a queued dispatch from idle, even across controller restart', async () => {
		mocks.dispatch.mockResolvedValue({
			success: true,
			sessionId: 'tab',
			queued: true,
			itemId: 'queue-item',
		});
		await tick();
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('running');
		expect(plan.tasks[1].status).toBe('pending');
	});
	it('recognises a fast completed capture without sampling busy and binds the actual run', async () => {
		startBound();
		runs = [captured()];
		messages = [
			{
				id: 'answer',
				role: 'assistant',
				content: 'Completed the work.',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'running', runId: 'captured' });
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'done', runId: 'captured' });
		expect(plan.tasks[1].status).toBe('running');
	});
	it('waits for transcript delivery after a process exit, then observes a late task failure', async () => {
		startBound();
		runs = [captured()];
		await tick();
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('running');
		expect(plan.tasks[1].status).toBe('pending');
		messages = [
			{
				id: 'answer',
				role: 'assistant',
				content: 'Task failed: done-when',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
	});
	it('does not accept a vanished tab or a run belonging to another worker', async () => {
		startBound({ runId: 'captured' });
		runs = [captured()];
		entries = [];
		messages = [
			{ id: 'answer', role: 'assistant', content: 'Done.', timestamp: '2026-10-30T00:00:00Z' },
		];
		await tick();
		expect(plan.tasks[0].status).not.toBe('done');
		expect(plan.tasks[1].status).toBe('pending');
	});
	it.each(['failed', 'cancelled'] as const)(
		'keeps structured %s distinct from success',
		async (status) => {
			startBound({ runId: 'captured' });
			runs = [captured(status)];
			await tick();
			expect(plan.tasks[0].status).toBe('failed');
			expect(plan.tasks[1].status).toBe('blocked');
		}
	);
	it('does not release a queued worker during multiple ticks of the same controller', async () => {
		vi.useFakeTimers();
		try {
			mocks.settings.mockImplementation(() => ({ pianola: mocks.savePlan.mock.calls.length < 3 }));
			mocks.dispatch.mockResolvedValue({ success: true, sessionId: 'tab', queued: true });
			const running = pianolaOrchestrate(plan.id, { interval: '5' });
			await vi.advanceTimersByTimeAsync(15_000);
			await running;
			expect(plan.tasks[0].status).toBe('running');
			expect(plan.tasks[1].status).toBe('pending');
			expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('integrates an actual capture service quick spawn/exit receipt with recovery', async () => {
		startBound();
		const capture = new AgentRunCaptureService({
			getAgentRun: mocks.getRun,
			findActiveRunBySession: mocks.findActive,
			upsertAgentRun: mocks.upsertRun,
			appendAgentRunEvent: mocks.appendEvent,
			now: () => 10,
		});
		const run = capture.captureSpawn({
			sessionId: 'agent-ai-tab',
			tabId: 'tab',
			toolType: 'codex',
			cwd: '/project',
		})!;
		await capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 0 });
		messages = [
			{ id: 'final', role: 'assistant', content: 'Delivered.', timestamp: '2026-10-30T00:00:00Z' },
		];
		await tick();
		expect(plan.tasks[0]).toMatchObject({
			status: 'running',
			runId: run.id,
			executionRunId: run.id,
		});
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'done', runId: run.id });
	});

	it.each(['missing', 'pending', 'running', 'failed', 'skipped'] as const)(
		'holds explicit required check when %s and releases only after its late pass',
		async (status) => {
			startBound({ requiredChecks: ['acceptance'] });
			const run = captured();
			run.checks = status === 'missing' ? [] : [{ name: 'acceptance', status }];
			runs = [run];
			messages = [
				{
					id: 'final',
					role: 'assistant',
					content: 'Delivered.',
					timestamp: '2026-10-30T00:00:00Z',
				},
			];
			await tick();
			await tick();
			expect(plan.tasks[0]).toMatchObject({ status: 'needs_review', runId: 'captured' });
			expect(plan.tasks[1].status).toBe('pending');
			expect(runs.find((entry) => entry.id === 'captured')?.status).toBe('needs_review');
			runs = runs.map((entry) =>
				entry.id === 'captured'
					? { ...entry, checks: [{ name: 'acceptance', status: 'passed' }] }
					: entry
			);
			await tick();
			expect(plan.tasks[0].status).toBe('done');
			expect(plan.tasks[1].status).toBe('running');
		}
	);

	it('uses the active task.runId for acceptance even when the deterministic projection is green', async () => {
		startBound({ runId: 'actual', requiredChecks: ['acceptance'] });
		runs = [
			{ ...captured(), id: 'actual', checks: [{ name: 'acceptance', status: 'failed' }] },
			{
				...captured(),
				id: 'pianola:adapter:worker',
				checks: [{ name: 'acceptance', status: 'passed' }],
			},
		];
		messages = [
			{ id: 'final', role: 'assistant', content: 'Delivered.', timestamp: '2026-10-30T00:00:00Z' },
		];
		await tick();
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'needs_review', runId: 'actual' });
		expect(plan.tasks[1].status).toBe('pending');
	});

	it('rechecks late failing evidence on a previously done task before admitting its dependent', async () => {
		startBound({ status: 'done', runId: 'captured', requiredChecks: ['acceptance'] });
		runs = [{ ...captured(), checks: [{ name: 'acceptance', status: 'failed' }] }];
		await tick();
		expect(plan.tasks[0].status).toBe('needs_review');
		expect(plan.tasks[1].status).toBe('pending');
	});

	it('preserves a waiting question, then resumes and waits for a successful settled answer', async () => {
		startBound();
		runs = [captured('running')];
		entries[0].state = 'busy';
		await tick();
		entries[0].state = 'idle';
		messages = [
			{
				id: 'question',
				role: 'assistant',
				content: 'Which file should I edit?',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0].status).toBe('running');
		expect(plan.tasks[1].status).toBe('pending');
		runs = [captured()];
		messages = [
			{
				id: 'final',
				role: 'assistant',
				content: 'Completed the selected file.',
				timestamp: '2026-10-30T00:00:01Z',
			},
		];
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('done');
	});

	it('fails a structured provider refusal even with neutral output and an exit-zero receipt', async () => {
		startBound();
		runs = [
			{
				...captured(),
				metadata: {
					completedAt: 2,
					exitCode: 0,
					agentError: { type: 'auth_expired', message: 'Login required' },
				},
			},
		];
		messages = [
			{
				id: 'neutral',
				role: 'assistant',
				content: 'See your account.',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
	});

	it('recognises the unstructured quota fallback without granting a dependent', async () => {
		startBound();
		runs = [captured()];
		messages = [
			{
				id: 'quota',
				role: 'assistant',
				content: 'Free usage limit reached',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
	});

	it('uses final capture text instead of an earlier renderer success snapshot', async () => {
		startBound();
		runs = [
			{
				...captured(),
				metadata: {
					completedAt: 2,
					exitCode: 0,
					answerTail: 'Task failed: done-when',
					answerCaptured: true,
					outcome: 'completed',
				},
			},
		];
		messages = [
			{
				id: 'partial',
				role: 'assistant',
				content: 'Working successfully.',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
	});

	it('accepts an authoritative final answer even before the renderer transcript arrives', async () => {
		startBound();
		runs = [
			{
				...captured(),
				metadata: {
					completedAt: 2,
					exitCode: 0,
					answerTail: 'Delivered the requested files.',
					answerCaptured: true,
					outcome: 'completed',
				},
			},
		];
		await tick();
		expect(plan.tasks[0]).toMatchObject({
			status: 'done',
			runId: 'captured',
			executionRunId: 'captured',
		});
		expect(plan.tasks[1].status).toBe('running');
	});

	it('never borrows another tab capture or interprets an unknown snapshot as idle', async () => {
		startBound();
		runs = [{ ...captured(), sessionId: 'agent-ai-another-tab', tabId: 'another-tab' }];
		messages = [
			{ id: 'old', role: 'assistant', content: 'Done.', timestamp: '2026-10-30T00:00:00Z' },
		];
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('running');
		entries[0].state = 'unknown';
		await tick();
		expect(plan.tasks[0].status).toBe('running');
		expect(plan.tasks[1].status).toBe('pending');
	});

	it('keeps a fresh queued repair separate from the old successful process receipt', async () => {
		mocks.settings.mockImplementation((key) =>
			key === 'pianolaAutoFixEnabled' ? true : { pianola: true, autopilot: true }
		);
		startBound({ status: 'needs_review', runId: 'captured', requiredChecks: ['acceptance'] });
		runs = [
			{ ...captured(), status: 'needs_review', checks: [{ name: 'acceptance', status: 'failed' }] },
		];
		mocks.dispatch.mockResolvedValue({ success: true, tabId: 'fix-tab', queued: true });
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'fixing', runId: 'captured', tabId: 'fix-tab' });
		entries.push({
			tabId: 'fix-tab',
			sessionId: 'fix-tab',
			agentId: 'agent',
			toolType: 'codex',
			state: 'idle',
		});
		messages = [
			{
				id: 'old',
				role: 'assistant',
				content: 'Previous run delivered.',
				timestamp: '2026-10-30T00:00:00Z',
			},
		];
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('fixing');
		expect(plan.tasks[1].status).toBe('pending');
		runs = [
			...runs.map((run) =>
				run.id === 'captured'
					? { ...run, checks: [{ name: 'acceptance', status: 'passed' as const }] }
					: run
			),
			{
				...captured(),
				id: 'repair-capture',
				tabId: 'fix-tab',
				sessionId: 'agent-ai-fix-tab',
				metadata: { completedAt: 3, exitCode: 0, answerTail: 'Repaired and checked.' },
			},
		];
		await tick();
		expect(plan.tasks[0]).toMatchObject({
			status: 'done',
			runId: 'captured',
			executionRunId: 'repair-capture',
		});
		expect(runs.find((run) => run.id === 'captured')?.tabId).toBe('tab');
	});

	it.each(['tabId', 'sessionId'] as const)(
		'holds an uncertain failed repair with a %s response identity across controller restarts',
		async (identity) => {
			mocks.settings.mockImplementation((key) =>
				key === 'pianolaAutoFixEnabled' ? true : { pianola: true }
			);
			startBound({
				status: 'needs_review',
				runId: 'captured',
				executionRunId: 'captured',
				requiredChecks: ['acceptance'],
				fixAttempts: 1,
			});
			plan.tasks.push({ ...child, id: 'independent', dependsOn: [] });
			runs = [
				{
					...captured(),
					status: 'needs_review',
					checks: [{ name: 'acceptance', status: 'failed' }],
				},
			];
			// The dispatch contract can carry an identity without confirming delivery.
			mocks.dispatch.mockResolvedValue({
				success: false,
				[identity]: 'unconfirmed-fix-tab',
				code: 'COMMAND_FAILED',
				error: 'repair acknowledgement lost',
			});
			await pianolaOrchestrate(plan.id, { once: true, concurrency: '1' });
			expect(plan.tasks[0]).toMatchObject({
				status: 'needs_review',
				holdReason: 'delivery_uncertain',
				runId: 'captured',
				fixAttempts: 2,
			});
			expect(plan.tasks[0].tabId).toBeUndefined();
			expect(plan.tasks[0].executionRunId).toBeUndefined();
			const held = { ...plan.tasks[0] };
			await pianolaOrchestrate(plan.id, { once: true, concurrency: '1' });
			expect(plan.tasks[0]).toEqual(held);
			// A late pass on the old acceptance ledger cannot identify the repair.
			runs = runs.map((run) => ({
				...run,
				checks: [{ name: 'acceptance', status: 'passed' }],
			}));
			await pianolaOrchestrate(plan.id, { once: true, concurrency: '1' });
			expect(plan.tasks[0]).toEqual(held);
			expect(plan.tasks[1].status).toBe('pending');
			expect(plan.tasks[2].status).toBe('pending');
			expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
				'agent',
				expect.stringContaining('captured'),
				{ newTab: true, background: true }
			);
		}
	);

	it('retains an ambiguous delivery claim after a lost dispatch response and does not retry it', async () => {
		mocks.dispatch.mockRejectedValueOnce(new Error('lost dispatch response'));
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'running', agentId: 'agent' });
		expect(plan.tasks[0].tabId).toBeUndefined();
		await tick();
		await tick();
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		expect(plan.tasks[1].status).toBe('pending');
	});
	it.each(['acknowledged-without-id', 'lost-response'] as const)(
		'composes real runDispatch certainty mapping for %s without redelivery',
		async (scenario) => {
			const actual = await vi.importActual<typeof import('../../../cli/commands/dispatch')>(
				'../../../cli/commands/dispatch'
			);
			mocks.dispatch.mockImplementation(actual.runDispatch);
			mocks.send.mockImplementation(async (command) => {
				if (command.type === 'new_ai_tab_with_prompt') {
					if (scenario === 'lost-response') throw new Error('socket closed after delivery');
					return { success: true };
				}
				return { success: true, sessions: entries, messages: [] };
			});
			await tick();
			await tick();
			await tick();
			expect(mocks.send).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'new_ai_tab_with_prompt', background: true }),
				'new_ai_tab_with_prompt_result'
			);
			expect(plan.tasks[0].status).toBe('needs_review');
			expect(plan.tasks[1].status).toBe('pending');
			expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		}
	);

	it('allows retry after a real, explicit desktop refusal confirms no delivery', async () => {
		const actual = await vi.importActual<typeof import('../../../cli/commands/dispatch')>(
			'../../../cli/commands/dispatch'
		);
		mocks.dispatch.mockImplementation(actual.runDispatch);
		mocks.send.mockResolvedValue({ success: false, error: 'No renderer available' });
		await tick();
		expect(plan.tasks[0].status).toBe('pending');
	});
	it('cannot approve an unaddressable delivery from a preexisting green acceptance ledger', async () => {
		plan.tasks[0] = { ...worker, runId: 'captured', requiredChecks: ['acceptance'] };
		runs = [{ ...captured(), checks: [{ name: 'acceptance', status: 'passed' }] }];
		mocks.dispatch.mockResolvedValue({
			success: false,
			code: 'NEW_TAB_NO_ID',
			error: 'Missing id after delivery',
		});
		await tick();
		await tick();
		expect(plan.tasks[0].status).toBe('needs_review');
		expect(plan.tasks[1].status).toBe('pending');
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
	});
	it('does not lose a structured failure when the transcript adapter is unavailable', async () => {
		startBound();
		runs = [captured('failed')];
		mocks.send.mockImplementation(async (command) => {
			if (command.type === 'get_session_history') throw new Error('Transcript unavailable');
			return { success: true, sessions: entries };
		});
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
		expect(mocks.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'get_session_history' }),
			expect.anything()
		);
	});
	it('revokes a stale done task when late structured failure arrives before a dependent starts', async () => {
		startBound({ status: 'done', runId: 'captured', executionRunId: 'captured' });
		runs = [captured('failed')];
		await tick();
		expect(plan.tasks[0].status).toBe('failed');
		expect(plan.tasks[1].status).toBe('blocked');
	});
	it('releases a late checks-only hold on a legacy task after its evidence passes with repairs off', async () => {
		startBound({ status: 'done', runId: 'captured', executionRunId: 'captured' });
		runs = [{ ...captured(), checks: [{ name: 'legacy-check', status: 'failed' }] }];
		await tick();
		expect(plan.tasks[0]).toMatchObject({ status: 'needs_review', holdReason: 'acceptance' });
		expect(plan.tasks[1].status).toBe('pending');
		runs = runs.map((run) => ({ ...run, checks: [{ name: 'legacy-check', status: 'passed' }] }));
		await tick();
		expect(plan.tasks[0].status).toBe('done');
		expect(plan.tasks[1].status).toBe('running');
	});
	it.each(['running', 'fixing'] as const)(
		'follows a genuine same-tab continuation for a %s task after a watcher answers a question',
		async (status) => {
			startBound({ status });
			if (status === 'fixing') {
				plan.tasks[0].runId = 'acceptance-ledger';
				runs = [
					{ ...captured(), id: 'acceptance-ledger', sessionId: 'other-ai-tab', tabId: 'other-tab' },
				];
			}
			let now = 10;
			const capture = new AgentRunCaptureService({
				getAgentRun: mocks.getRun,
				findActiveRunBySession: mocks.findActive,
				upsertAgentRun: mocks.upsertRun,
				appendAgentRunEvent: mocks.appendEvent,
				now: () => now++,
			});
			const question = capture.captureSpawn({
				sessionId: 'agent-ai-tab',
				tabId: 'tab',
				toolType: 'codex',
				cwd: '/project',
			})!;
			await capture.captureExit({
				sessionId: 'agent-ai-tab',
				exitCode: 0,
				settlement: {
					outcome: 'completed',
					answerCaptured: true,
					answerTail: 'Which file should I edit?',
				},
			});
			await tick();
			expect(plan.tasks[0]).toMatchObject({
				status,
				runId: status === 'fixing' ? 'acceptance-ledger' : question.id,
				executionRunId: question.id,
			});
			const continuation = capture.captureSpawn({
				sessionId: 'agent-ai-tab',
				tabId: 'tab',
				toolType: 'codex',
				cwd: '/project',
			})!;
			await capture.captureExit({
				sessionId: 'agent-ai-tab',
				exitCode: 0,
				settlement: {
					outcome: 'completed',
					answerCaptured: true,
					answerTail: 'Completed the selected file.',
				},
			});
			await tick();
			expect(plan.tasks[0]).toMatchObject({
				status: 'done',
				runId: status === 'fixing' ? 'acceptance-ledger' : continuation.id,
				executionRunId: continuation.id,
			});
			expect(plan.tasks[1].status).toBe('running');
		}
	);

	it('clears stale physical identities before a reset task crosses the dispatch boundary', async () => {
		plan.tasks[0] = {
			...worker,
			tabId: 'tab',
			runId: 'captured',
			executionRunId: 'captured',
			completionCursor: 'old-answer',
		};
		runs = [
			{
				...captured(),
				metadata: { completedAt: 2, exitCode: 0, answerTail: 'Previous task succeeded.' },
			},
		];
		mocks.dispatch.mockRejectedValueOnce(new Error('lost response'));
		await tick();
		expect(plan.tasks[0].tabId).toBeUndefined();
		expect(plan.tasks[0].executionRunId).toBeUndefined();
		expect(plan.tasks[0].runId).toBeUndefined();
		await tick();
		await tick();
		expect(plan.tasks[0].status).not.toBe('done');
		expect(plan.tasks[1].status).toBe('pending');
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
	});

	it('reserves concurrency for uncertain deliveries across ticks', async () => {
		plan.tasks[1].dependsOn = [];
		mocks.dispatch.mockResolvedValue({
			success: false,
			code: 'COMMAND_FAILED',
			error: 'lost response after delivery',
		});
		await pianolaOrchestrate(plan.id, { once: true, concurrency: '1' });
		await pianolaOrchestrate(plan.id, { once: true, concurrency: '1' });
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		expect(plan.tasks[1].status).toBe('pending');
	});
	it.each([
		['done', 'busy', true],
		['done', 'busy', false],
		['done', 'failed', true],
		['done', 'failed', false],
		['needs_review', 'busy', true],
		['needs_review', 'busy', false],
		['needs_review', 'failed', true],
		['needs_review', 'failed', false],
	] as const)(
		'keeps the %s task pinned when a later same-tab run is %s (checks: %s)',
		async (status, laterState, hasChecks) => {
			startBound();
			let now = 10;
			const capture = new AgentRunCaptureService({
				getAgentRun: mocks.getRun,
				findActiveRunBySession: mocks.findActive,
				upsertAgentRun: mocks.upsertRun,
				appendAgentRunEvent: mocks.appendEvent,
				now: () => now++,
			});
			const original = capture.captureSpawn({
				sessionId: 'agent-ai-tab',
				tabId: 'tab',
				toolType: 'codex',
				cwd: '/project',
			})!;
			await capture.captureExit({
				sessionId: 'agent-ai-tab',
				exitCode: 0,
				settlement: {
					outcome: 'completed',
					answerCaptured: true,
					answerTail: 'Delivered the original task.',
				},
			});
			runs = runs.map((run) => ({
				...run,
				checks: hasChecks ? [{ name: 'acceptance', status: 'passed' }] : [],
			}));
			plan.tasks[0] = {
				...plan.tasks[0],
				status,
				runId: original.id,
				executionRunId: original.id,
				...(status === 'needs_review' ? { holdReason: 'acceptance' } : {}),
			};
			capture.captureSpawn({
				sessionId: 'agent-ai-tab',
				tabId: 'tab',
				toolType: 'codex',
				cwd: '/project',
			});
			if (laterState === 'failed')
				await capture.captureExit({ sessionId: 'agent-ai-tab', exitCode: 1 });
			await tick();
			expect(plan.tasks[0]).toMatchObject({
				status: 'done',
				runId: original.id,
				executionRunId: original.id,
			});
			expect(plan.tasks[1].status).toBe('running');
		}
	);

	it.each([false, true])(
		'releases a resolved late finding without inventing checks (repairs enabled: %s)',
		async (repairsEnabled) => {
			startBound({ status: 'done', runId: 'captured', executionRunId: 'captured' });
			runs = [
				{
					...captured(),
					reviews: [
						{ severity: 'high', category: 'review', message: 'Needs correction', status: 'open' },
					],
				},
			];
			await tick();
			expect(plan.tasks[0]).toMatchObject({ status: 'needs_review', holdReason: 'acceptance' });
			expect(runs.find((run) => run.id === 'captured')?.status).toBe('needs_review');
			expect(plan.tasks[1].status).toBe('pending');
			runs = runs.map((run) => ({
				...run,
				reviews: run.reviews.map((review) => ({ ...review, status: 'fixed' })),
			}));
			mocks.settings.mockImplementation((key) =>
				key === 'pianolaAutoFixEnabled'
					? repairsEnabled
					: { pianola: true, autopilot: repairsEnabled }
			);
			await tick();
			expect(plan.tasks[0].status).toBe('done');
			expect(plan.tasks[1].status).toBe('running');
			expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		}
	);
});
