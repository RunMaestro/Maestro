import { describe, expect, it, vi } from 'vitest';
import {
	runProgramLoopTick,
	shouldLogProgramLoopDecision,
	type ProgramLoopState,
} from '../../../shared/pianola/pianola-program-loop';
const now = '2026-10-02T12:00:00.000Z';
const program = {
	id: 'product',
	title: 'Product',
	root: 'C:\\product',
	leadAgentId: 'lead',
	roles: { lead: { name: 'Lead', agentId: 'lead' } },
	charter: { maxConcurrent: 2, maxAttempts: 3, validationRequired: true },
	status: 'active' as const,
	createdAt: 1,
	updatedAt: 1,
};
const plan = {
	id: 'plan',
	programId: 'product',
	title: 'Launch',
	createdAt: 1,
	tasks: [
		{ id: 'task', title: 'Ship', prompt: 'Ship it', dependsOn: [], status: 'running' as const },
	],
};
const blank = (): ProgramLoopState => ({
	program,
	plans: [],
	asks: [],
	brief: { generatedAt: now, needsMe: [], inFlight: [], verified: [], programs: [] },
	targets: [],
	leadSession: { tabId: 'lead-tab', state: 'idle' },
	memo: { notifiedTaskIds: [] },
	now,
});
const deps = () => ({
	findWake: vi.fn(
		async (_agentId: string, _wakeId: string) =>
			undefined as { success: true; tabId: string } | undefined
	),
	wake: vi.fn(async (_agentId: string, _prompt: string) => ({ success: true, tabId: 'fresh-tab' })),
	ensureOrchestrate: vi.fn(),
	ensureWatch: vi.fn(),
	persistMemo: vi.fn((_memo: ProgramLoopState['memo']) => {}),
	prompt: (kind: string, vars: Record<string, string>) => kind + ': ' + JSON.stringify(vars),
});

describe('program loop', () => {
	it('persists a task wake and watch intent before a failed watch registration', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'needs_review' }] }];
		state.targets = [{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1 }];
		const io = deps();
		io.persistMemo.mockImplementation((memo) => {
			state.memo = JSON.parse(JSON.stringify(memo));
		});
		io.wake.mockImplementationOnce(async () => {
			expect(state.memo.notifiedTaskIds).toEqual([]);
			expect(state.memo.pendingWake?.taskKey).toBe('plan:task');
			return { success: true, tabId: 'fresh-tab' };
		});
		io.ensureWatch.mockImplementationOnce(() => {
			throw new Error('Watch write failed');
		});
		await expect(runProgramLoopTick(state, io)).rejects.toThrow('Watch write failed');
		expect(state.memo.notifiedTaskIds).toEqual(['plan:task']);
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(1);
		expect(io.ensureWatch).toHaveBeenCalledTimes(2);
	});
	it('rolls back a persisted task reservation when wake throws or reports failure', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'needs_review' }] }];
		state.targets = [{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1 }];
		const io = deps();
		io.persistMemo.mockImplementation((memo) => {
			state.memo = JSON.parse(JSON.stringify(memo));
		});
		io.wake.mockImplementationOnce(async () => {
			expect(state.memo.notifiedTaskIds).toEqual([]);
			throw new Error('Dispatch failed');
		});
		await expect(runProgramLoopTick(state, io)).rejects.toThrow('Dispatch failed');
		expect(state.memo.notifiedTaskIds).toEqual([]);
		io.wake.mockResolvedValueOnce({ success: false, tabId: '' });
		await runProgramLoopTick(state, io);
		expect(state.memo.notifiedTaskIds).toEqual([]);
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(3);
	});
	it('notifies terminal failed tasks before handing off their completed plan', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'failed' }] }];
		const io = deps();
		const first = await runProgramLoopTick(state, io);
		expect(first.memo.notifiedTaskIds).toEqual(['plan:task']);
		expect(io.wake).toHaveBeenCalledWith('lead', expect.stringContaining('task-needs-attention'));
		state.memo = JSON.parse(JSON.stringify(first.memo));
		await runProgramLoopTick(state, io);
		expect(
			io.wake.mock.calls.filter(([, prompt]) => prompt.includes('task-needs-attention'))
		).toHaveLength(1);
	});
	it('does not resurrect manually disabled plan or lead-watch targets', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'needs_review' }] }];
		state.targets = [
			{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: false, createdAt: 1 },
			{ id: 'w', kind: 'watch', agentId: 'lead', tabId: 'old', enabled: false, createdAt: 1 },
		];
		const io = deps();
		await runProgramLoopTick(state, io);
		expect(io.ensureOrchestrate).not.toHaveBeenCalled();
		expect(io.ensureWatch).not.toHaveBeenCalled();
	});
	it('ensures an active plan is supervised and notifies a review task once', async () => {
		const state = blank();
		state.plans = [
			{
				...plan,
				tasks: [{ ...plan.tasks[0], status: 'needs_review', error: 'Validation failed' }],
			},
		];
		const io = deps();
		const first = await runProgramLoopTick(state, io);
		expect(io.ensureOrchestrate).toHaveBeenCalledWith(state.plans[0], 2);
		expect(io.wake).toHaveBeenCalledWith('lead', expect.stringContaining('Validation failed'));
		expect(io.ensureWatch).toHaveBeenCalledWith('lead', 'fresh-tab');
		expect(first.memo.notifiedTaskIds).toEqual(['plan:task']);
		state.memo = first.memo;
		state.targets = [
			{ id: 'orchestrate', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1 },
		];
		state.targets[0] = { ...state.targets[0], concurrency: program.charter.maxConcurrent };
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(1);
		expect(io.ensureOrchestrate).toHaveBeenCalledTimes(1);
	});
	it('never wakes a busy lead, but keeps the plan supervised', async () => {
		const state = blank();
		state.plans = [plan];
		state.leadSession = { tabId: 'lead-tab', state: 'busy' };
		const io = deps();
		await runProgramLoopTick(state, io);
		expect(io.ensureOrchestrate).toHaveBeenCalledOnce();
		expect(io.wake).not.toHaveBeenCalled();
	});
	it('reports a completed plan once, with verified task titles', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'done' }] }];
		state.brief.verified.push({
			planId: 'plan',
			planTitle: 'Launch',
			taskId: 'task',
			taskTitle: 'Ship',
			checkName: 'test',
			completedAt: now,
		});
		const io = deps();
		const first = await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledWith('lead', expect.stringContaining('Verified: Ship'));
		expect(first.memo.lastHandoffPlanId).toBe('plan');
		state.memo = first.memo;
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(1);
	});
	it('backs off idle handoffs for 60 minutes, then wakes again', async () => {
		const state = blank();
		const io = deps();
		const first = await runProgramLoopTick(state, io);
		expect(first.memo.lastWakeReason).toBe('idle');
		state.memo = first.memo;
		state.now = '2026-10-02T12:59:59.000Z';
		expect((await runProgramLoopTick(state, io)).reason).toContain('idle backoff');
		state.now = '2026-10-02T13:00:00.000Z';
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(2);
	});
	it('leaves paused programs alone, including an active plan', async () => {
		const state = blank();
		state.program = { ...program, status: 'paused' };
		state.plans = [plan];
		const io = deps();
		expect((await runProgramLoopTick(state, io)).reason).toContain('paused');
		expect(io.wake).not.toHaveBeenCalled();
		expect(io.ensureOrchestrate).not.toHaveBeenCalled();
		expect(io.ensureWatch).not.toHaveBeenCalled();
	});
	it('rebinds the lead watch when a later wake opens a new tab', async () => {
		const state = blank();
		const io = deps();
		const first = await runProgramLoopTick(state, io);
		state.memo = first.memo;
		state.targets = [
			{
				id: 'watch',
				kind: 'watch',
				agentId: 'lead',
				tabId: 'fresh-tab',
				enabled: true,
				createdAt: 1,
			},
		];
		state.now = '2026-10-02T13:00:00.000Z';
		io.wake.mockResolvedValueOnce({ success: true, tabId: 'next-tab' });
		await runProgramLoopTick(state, io);
		expect(io.ensureWatch).toHaveBeenNthCalledWith(2, 'lead', 'next-tab');
	});
	it('logs target registration and wake, but not identical consecutive no-ops', async () => {
		const state = blank();
		state.plans = [plan];
		const io = deps();
		const registered = await runProgramLoopTick(state, io);
		expect(registered.acted).toBe(true);
		expect(shouldLogProgramLoopDecision(undefined, registered)).toBe(true);
		state.targets = [
			{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1, concurrency: 2 },
		];
		const firstNoOp = await runProgramLoopTick(state, io);
		expect(shouldLogProgramLoopDecision(registered.memo, firstNoOp)).toBe(false);
		state.memo = { ...firstNoOp.memo, lastLoggedReason: firstNoOp.reason };
		const repeat = await runProgramLoopTick(state, io);
		const wake = await runProgramLoopTick(blank(), deps());
		expect(
			shouldLogProgramLoopDecision({ notifiedTaskIds: [], lastLoggedReason: wake.reason }, wake)
		).toBe(true);
		expect(shouldLogProgramLoopDecision(state.memo, repeat)).toBe(false);
	});
	it('retries an interrupted pre-dispatch intent without losing task attention', async () => {
		const state = blank();
		state.plans = [{ ...plan, tasks: [{ ...plan.tasks[0], status: 'needs_review' }] }];
		const io = deps();
		io.persistMemo.mockImplementation((memo) => {
			state.memo = structuredClone(memo);
		});
		io.persistMemo.mockImplementationOnce((memo) => {
			state.memo = structuredClone(memo);
			throw new Error('interrupted');
		});
		await expect(runProgramLoopTick(state, io)).rejects.toThrow('interrupted');
		expect(state.memo.notifiedTaskIds).toEqual([]);
		const pendingId = state.memo.pendingWake!.id;
		await runProgramLoopTick(state, io);
		expect(io.findWake).toHaveBeenCalledWith('lead', pendingId);
		expect(io.wake).toHaveBeenCalledTimes(1);
		expect(state.memo.notifiedTaskIds).toEqual(['plan:task']);
	});
	it('reconciles an accepted wake after interruption rather than dispatching twice', async () => {
		const state = blank();
		const io = deps();
		io.persistMemo.mockImplementation((memo) => {
			state.memo = structuredClone(memo);
		});
		io.wake.mockRejectedValueOnce(new Error('lost acknowledgement'));
		await expect(runProgramLoopTick(state, io)).rejects.toThrow('lost acknowledgement');
		io.findWake.mockResolvedValueOnce({ success: true, tabId: 'accepted-tab' });
		state.leadSession = { tabId: 'accepted-tab', state: 'busy' };
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(1);
		expect(io.ensureWatch).toHaveBeenCalledWith('lead', 'accepted-tab');
		expect(state.memo.pendingWake).toBeUndefined();
	});
	it('delivers founder choice and note once on the next safe wake, including during an active plan', async () => {
		const state = blank();
		state.plans = [plan];
		state.targets = [
			{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1, concurrency: 2 },
		];
		state.asks = [
			{
				id: 'choice',
				title: 'Choose provider',
				detail: 'Stripe or Adyen?',
				severity: 'high',
				status: 'resolved',
				programId: 'product',
				agentId: 'engineer',
				dedupeKey: 'engineer:product',
				createdAt: now,
				updatedAt: now,
				resolution: { option: 'Stripe', note: 'Use test mode', resolvedAt: now },
			},
		];
		const io = deps();
		state.leadSession = { tabId: 'lead-tab', state: 'busy' };
		await runProgramLoopTick(state, io);
		expect(io.wake).not.toHaveBeenCalled();
		state.leadSession.state = 'idle';
		const first = await runProgramLoopTick(state, io);
		expect(io.wake.mock.calls[0][1]).toContain('Stripe');
		expect(io.wake.mock.calls[0][1]).toContain('Use test mode');
		state.memo = first.memo;
		await runProgramLoopTick(state, io);
		expect(io.wake).toHaveBeenCalledTimes(1);
	});
	it('updates a live orchestrator after the concurrency charter is lowered', async () => {
		const state = blank();
		state.plans = [plan];
		state.program = { ...program, charter: { ...program.charter, maxConcurrent: 1 } };
		state.targets = [
			{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1, concurrency: 3 },
		];
		const io = deps();
		await runProgramLoopTick(state, io);
		expect(io.ensureOrchestrate).toHaveBeenCalledWith(plan, 1);
		expect(io.wake).not.toHaveBeenCalled();
	});
});
