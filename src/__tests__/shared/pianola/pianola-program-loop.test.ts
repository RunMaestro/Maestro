import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
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
	wake: vi.fn(async (_agentId: string, _prompt: string) => ({ success: true, tabId: 'fresh-tab' })),
	ensureOrchestrate: vi.fn(),
	ensureWatch: vi.fn(),
	prompt: (kind: string, vars: Record<string, string>) => kind + ': ' + JSON.stringify(vars),
});

describe('program loop', () => {
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
	it('leaves paused programs alone', async () => {
		const state = blank();
		state.program = { ...program, status: 'paused' };
		const io = deps();
		expect((await runProgramLoopTick(state, io)).reason).toContain('paused');
		expect(io.wake).not.toHaveBeenCalled();
	});
	it('logs target registration and wake, but not identical consecutive no-ops', async () => {
		const state = blank();
		state.plans = [plan];
		const io = deps();
		const registered = await runProgramLoopTick(state, io);
		expect(registered.acted).toBe(true);
		expect(shouldLogProgramLoopDecision(undefined, registered)).toBe(true);
		state.targets = [{ id: 'o', kind: 'orchestrate', planId: 'plan', enabled: true, createdAt: 1 }];
		const firstNoOp = await runProgramLoopTick(state, io);
		expect(shouldLogProgramLoopDecision(registered.memo, firstNoOp)).toBe(true);
		state.memo = { ...firstNoOp.memo, lastLoggedReason: firstNoOp.reason };
		const repeat = await runProgramLoopTick(state, io);
		const wake = await runProgramLoopTick(blank(), deps());
		expect(
			shouldLogProgramLoopDecision({ notifiedTaskIds: [], lastLoggedReason: wake.reason }, wake)
		).toBe(true);
		expect(shouldLogProgramLoopDecision(state.memo, repeat)).toBe(false);
	});
	it('renders a usable Windows-root handoff plan example with role ids and no dispatch instruction', async () => {
		const state = blank();
		state.program = {
			...program,
			roles: { ...program.roles, engineer: { name: 'Engineer', agentId: 'eng-id' } },
		};
		const io = deps();
		io.prompt = (kind, vars) => {
			const template = fs.readFileSync(
				path.resolve(__dirname, '../../../prompts/pianola-program-loop', kind + '.md'),
				'utf8'
			);
			return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => vars[key] ?? '');
		};
		await runProgramLoopTick(state, io);
		const prompt = io.wake.mock.calls[0][1];
		const example = prompt.split('```json\n')[1]?.split('\n```')[0];
		const sample = JSON.parse(example ?? '') as {
			programId: string;
			tasks: {
				cwd: string;
				agentId: string;
				validation: { target: string; command: string[]; artifacts: string[] };
			}[];
		};
		expect(sample.programId).toBe('product');
		expect(sample.tasks[0].cwd).toBe(program.root);
		expect(sample.tasks[0].validation.target).toBe(program.root);
		expect(prompt).toContain('engineer: Engineer (eng-id)');
		expect(prompt).toContain('pianola plan set --file');
		expect(prompt).toContain('Do not dispatch any agent yourself');
	});
});
