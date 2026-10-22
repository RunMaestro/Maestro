/**
 * The engine's pause transitions: a classified agent error, a HITL gate, a graceful stop, and
 * the run clock. Each one runs against the same document under the policies that differ.
 */

import { describe, expect, it } from 'vitest';
import type { AgentError, Playbook } from '../../../types';
import type { GoalRunConfig } from '../../../goalDriven/types';
import type { AutoRunDeps, AutoRunResolution } from '../engine-types';
import { CLI_AUTORUN_POLICY, DESKTOP_AUTORUN_POLICY } from '../policy';
import { createRunController, type RunController } from '../run-control';
import { runGoal } from '../run-goal';
import { runPlaybook } from '../run-playbook';
import { collect, createFakeDeps, session, tickFirstTask, type FakeDeps } from './fake-deps';

const playbook = (overrides: Partial<Playbook> = {}): Playbook => ({
	id: 'pb-1',
	name: 'Test Playbook',
	createdAt: 0,
	updatedAt: 0,
	prompt: 'Do the task',
	documents: [{ filename: 'tasks', resetOnCompletion: false }],
	loopEnabled: false,
	...overrides,
});

const agentError = (type: AgentError['type'] = 'network_error'): AgentError => ({
	type,
	message: 'The connection dropped',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 0,
});

const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

const GATE = '<!-- MAESTRO:HITL reason="Add the key" -->';

interface Harness {
	fake: FakeDeps;
	controller: RunController;
	/** Each pause the engine parked on, in order. */
	pauses: Array<{ kind: string; document?: string; iteration?: number }>;
	/** Answer the next pauses, in order, the moment the engine parks. A function can edit state first. */
	answers: Array<AutoRunResolution | 'stop' | (() => AutoRunResolution | 'stop')>;
	/** A manual clock, so pause length is exact. */
	time: { now: number };
}

/** Fake deps wired with a controller that answers each pause from `answers`, synchronously. */
function harness(
	docs: Record<string, string>,
	policy = DESKTOP_AUTORUN_POLICY,
	autoResume = policy.autoResume
): Harness {
	const fake = createFakeDeps(docs);
	const time = { now: 1_700_000_000_000 };
	fake.deps.clock = { now: () => time.now };
	const controller = createRunController({ clock: fake.deps.clock, autoResume });
	const h: Harness = { fake, controller, pauses: [], answers: [], time };
	const deps: AutoRunDeps = fake.deps;
	deps.policy = policy;
	deps.controller = {
		stopRequested: () => controller.stopRequested(),
		pausedMs: () => controller.pausedMs(),
		awaitResolution: (pause) => {
			h.pauses.push({
				kind: pause.kind,
				document: pause.document,
				iteration: pause.kind === 'error' ? pause.iteration : undefined,
			});
			const waiting = controller.awaitResolution(pause);
			const next = h.answers.shift();
			const answer = typeof next === 'function' ? next() : next;
			if (answer === 'stop') controller.requestStop();
			else if (answer) controller.resolve(answer);
			return waiting;
		},
	};
	return h;
}

const run = (h: Harness, overrides: Partial<Playbook> = {}) =>
	collect(runPlaybook(session(), playbook(overrides), '/p', { skipSynopsis: true }, h.fake.deps));

/** A turn that fails with a classified error the first time and ticks the task after. */
const failOnce = (h: Harness, error = agentError()) => {
	let failed = false;
	h.fake.onTurn = (request, f) => {
		if (request.purpose !== 'task' || !request.document) return { success: true, response: 'ok' };
		if (!failed) {
			failed = true;
			return { success: false, error: error.message, agentError: error };
		}
		f.docs.set(request.document, tickFirstTask(f.docs.get(request.document) ?? ''));
		return { success: true, response: 'done', agentSessionId: 'prov' };
	};
};

describe('error pause (playbook)', () => {
	it('parks on a classified error, writes the error row, and re-dispatches on resume', async () => {
		const h = harness({ tasks: '- [ ] one\n- [ ] two\n' });
		failOnce(h);
		h.answers = ['resume'];

		const events = await run(h);

		expect(types(events)).toEqual([
			'start',
			'document_start',
			'task_start',
			'task_complete',
			'paused',
			'resumed',
			'task_start',
			'task_complete',
			'task_start',
			'task_complete',
			'document_complete',
			'complete',
		]);
		expect(events.find((e) => e.type === 'paused')).toMatchObject({
			kind: 'error',
			document: 'tasks',
			documentIndex: 0,
		});
		expect(events.find((e) => e.type === 'resumed')).toMatchObject({
			resolution: 'resume',
			auto: false,
		});
		const errorRow = h.fake.history.find((e) => e.summary.startsWith('Auto Run error:'));
		expect(errorRow).toMatchObject({
			summary: 'Auto Run error: Connection Error (tasks)',
			success: false,
		});
		expect(errorRow?.completedTaskCount).toBeUndefined();
		expect(h.fake.docs.get('tasks')).toBe('- [x] one\n- [x] two\n');
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 2,
		});
	});

	it('leaves the failed document on skip and goes on to the next one', async () => {
		const h = harness({ first: '- [ ] a\n- [ ] b\n', second: '- [ ] c\n' });
		let failed = false;
		h.fake.onTurn = (request, f) => {
			if (request.purpose !== 'task' || !request.document) return { success: true };
			if (request.document === 'first' && !failed) {
				failed = true;
				return { success: false, agentError: agentError('auth_expired') };
			}
			f.docs.set(request.document, tickFirstTask(f.docs.get(request.document) ?? ''));
			return { success: true, response: 'done', agentSessionId: 'p' };
		};
		h.answers = ['skip'];

		const events = await run(h, {
			documents: [
				{ filename: 'first', resetOnCompletion: false },
				{ filename: 'second', resetOnCompletion: false },
			],
		});

		expect(h.fake.docs.get('first')).toBe('- [ ] a\n- [ ] b\n');
		expect(h.fake.docs.get('second')).toBe('- [x] c\n');
		const completed = events.filter((e) => e.type === 'document_complete');
		expect(completed.map((e) => e.document)).toEqual(['second']);
		expect(events.find((e) => e.type === 'resumed')).toMatchObject({ resolution: 'skip' });
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
	});

	it('ends the run on abort with a stopped summary that bounds the run', async () => {
		const h = harness({ tasks: '- [ ] one\n- [ ] two\n' });
		failOnce(h);
		h.answers = ['abort'];

		const events = await run(h);

		expect(h.fake.requests.filter((r) => r.purpose === 'task')).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: false, stopped: true });
		expect(h.fake.history.at(-1)?.summary).toBe('Auto Run stopped: aborted by operator');
		expect(h.fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('answers abort on a graceful stop that arrives while paused', async () => {
		const h = harness({ tasks: '- [ ] one\n' });
		failOnce(h);
		h.answers = ['stop'];

		const events = await run(h);

		expect(events.find((e) => e.type === 'resumed')).toMatchObject({ resolution: 'abort' });
		expect(events.at(-1)).toMatchObject({ stopped: true });
	});

	it('does not pause under the CLI policy: the failed task is recorded and the run goes on', async () => {
		const h = harness({ tasks: '- [ ] one\n' }, CLI_AUTORUN_POLICY);
		failOnce(h);

		const events = await run(h);

		expect(events.some((e) => e.type === 'paused')).toBe(false);
		expect(h.pauses).toHaveLength(0);
		expect(h.fake.history.some((e) => e.summary.startsWith('Auto Run error:'))).toBe(false);
		expect(events.find((e) => e.type === 'task_complete')).toMatchObject({ success: false });
	});

	it('does not pause without a controller, whatever the policy says', async () => {
		const h = harness({ tasks: '- [ ] one\n' });
		failOnce(h);
		h.fake.deps.controller = undefined;

		const events = await run(h);

		expect(events.some((e) => e.type === 'paused')).toBe(false);
	});

	it('still honors a halt marker the failing turn wrote, before it pauses', async () => {
		const h = harness({ tasks: '- [ ] one\n- [ ] two\n' });
		h.fake.onTurn = (_request, f) => {
			f.docs.set('tasks', `${f.docs.get('tasks')}\n<!-- maestro:halt: out of credit -->\n`);
			return { success: false, agentError: agentError('rate_limited') };
		};

		const events = await run(h);

		expect(events.some((e) => e.type === 'paused')).toBe(false);
		expect(events.at(-1)).toMatchObject({ halted: true, haltReason: 'out of credit' });
	});

	it('lets the stall decision stand when a watchdog killed the failing turn', async () => {
		const h = harness({ first: '- [ ] a\n', second: '- [ ] b\n' });
		h.fake.onTurn = (request, f) => {
			if (request.purpose !== 'task' || !request.document) return { success: true };
			if (request.document === 'first') {
				return {
					success: false,
					errorKind: 'watchdog-stalled',
					agentError: agentError('agent_crashed'),
				};
			}
			f.docs.set('second', tickFirstTask(f.docs.get('second') ?? ''));
			return { success: true, response: 'done', agentSessionId: 'p' };
		};
		h.answers = ['resume'];

		const events = await run(h, {
			documents: [
				{ filename: 'first', resetOnCompletion: false },
				{ filename: 'second', resetOnCompletion: false },
			],
		});

		// One dispatch only: the watchdog trips the stall at once, so resume does not retry it.
		expect(h.fake.requests.filter((r) => r.document === 'first')).toHaveLength(1);
		expect(events.find((e) => e.type === 'document_stalled')).toMatchObject({
			document: 'first',
			reason: 'agent hung or exceeded its time budget',
		});
		expect(h.fake.docs.get('second')).toBe('- [x] b\n');
	});

	it('fires the auto-resume timer for an unanswered error and says so', async () => {
		const timers: Array<() => void> = [];
		const fake = createFakeDeps({ tasks: '- [ ] one\n' });
		const controller = createRunController({
			clock: fake.deps.clock,
			autoResume: { delayMs: 300_000, maxAttempts: 5 },
			setTimer: (fn) => timers.push(fn),
			clearTimer: () => undefined,
		});
		fake.deps.policy = DESKTOP_AUTORUN_POLICY;
		fake.deps.controller = {
			stopRequested: () => controller.stopRequested(),
			pausedMs: () => controller.pausedMs(),
			awaitResolution: (pause) => {
				const waiting = controller.awaitResolution(pause);
				timers[0]();
				return waiting;
			},
		};
		const h: Harness = { fake, controller, pauses: [], answers: [], time: { now: 0 } };
		failOnce(h);

		const events = await run(h);

		expect(events.find((e) => e.type === 'resumed')).toMatchObject({
			resolution: 'resume',
			auto: true,
		});
		expect(events.at(-1)).toMatchObject({ success: true, totalTasksCompleted: 1 });
	});
});

describe('HITL gate (playbook)', () => {
	const gated = `${GATE}\n- [ ] one\n- [ ] two\n`;

	it('parks before the first dispatch, writes the human step on resume, and never re-pauses on it', async () => {
		const h = harness({ tasks: gated });
		h.answers = ['resume'];

		const events = await run(h);

		expect(h.pauses).toEqual([{ kind: 'gate', document: 'tasks', iteration: undefined }]);
		expect(types(events)).toEqual([
			'start',
			'document_start',
			'paused',
			'resumed',
			'gate_acknowledged',
			'task_start',
			'task_complete',
			'task_start',
			'task_complete',
			'document_complete',
			'complete',
		]);
		expect(events.find((e) => e.type === 'paused')).toMatchObject({
			kind: 'gate',
			gate: { reason: 'Add the key', line: 1 },
		});
		expect(events.find((e) => e.type === 'gate_acknowledged')).toMatchObject({ written: true });
		expect(h.fake.docs.get('tasks')).toContain('- [x] Human step done: Add the key');
		expect(h.fake.history.some((e) => e.summary.startsWith('Auto Run error:'))).toBe(false);
		expect(events.at(-1)).toMatchObject({ success: true });
	});

	it('writes nothing when the person already ticked the box while the run was parked', async () => {
		const h = harness({ tasks: gated });
		h.answers = [
			() => {
				h.fake.docs.set('tasks', `${GATE}\n- [x] Key added by hand\n- [ ] one\n- [ ] two\n`);
				return 'resume';
			},
		];

		const events = await run(h);

		expect(events.find((e) => e.type === 'gate_acknowledged')).toMatchObject({ written: false });
		expect(h.fake.docs.get('tasks')).not.toContain('Human step done');
		expect(h.pauses).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ success: true, totalTasksCompleted: 2 });
	});

	it('checks before every dispatch, so a gate in the middle of a document parks the run there', async () => {
		const h = harness({ tasks: `- [ ] one\n${GATE}\n- [ ] two\n` });
		h.answers = ['resume'];

		const events = await run(h);

		expect(types(events)).toEqual([
			'start',
			'document_start',
			'task_start',
			'task_complete',
			'paused',
			'resumed',
			'gate_acknowledged',
			'task_start',
			'task_complete',
			'document_complete',
			'complete',
		]);
		expect(h.fake.requests.filter((r) => r.purpose === 'task')).toHaveLength(2);
	});

	it('leaves the document on skip without completing it', async () => {
		const h = harness({ gate: gated, after: '- [ ] z\n' });
		h.answers = ['skip'];

		const events = await run(h, {
			documents: [
				{ filename: 'gate', resetOnCompletion: false },
				{ filename: 'after', resetOnCompletion: false },
			],
		});

		expect(h.fake.docs.get('gate')).toBe(gated);
		expect(h.fake.docs.get('after')).toBe('- [x] z\n');
		expect(events.filter((e) => e.type === 'document_complete').map((e) => e.document)).toEqual([
			'after',
		]);
	});

	it('ends the run on abort', async () => {
		const h = harness({ tasks: gated });
		h.answers = ['abort'];

		const events = await run(h);

		expect(h.fake.requests).toHaveLength(0);
		expect(events.at(-1)).toMatchObject({ stopped: true, success: false });
		expect(h.fake.history.at(-1)?.summary).toBe('Auto Run stopped: aborted by operator');
	});

	it('under the CLI policy reports the gate and moves on, mid-document included', async () => {
		const h = harness(
			{ tasks: `- [ ] one\n${GATE}\n- [ ] two\n`, next: '- [ ] z\n' },
			CLI_AUTORUN_POLICY
		);

		const events = await run(h, {
			documents: [
				{ filename: 'tasks', resetOnCompletion: false },
				{ filename: 'next', resetOnCompletion: false },
			],
		});

		expect(h.pauses).toHaveLength(0);
		expect(events.find((e) => e.type === 'document_gated')).toMatchObject({
			document: 'tasks',
			reason: 'Add the key',
			line: 2,
		});
		expect(h.fake.docs.get('tasks')).toBe(`- [x] one\n${GATE}\n- [ ] two\n`);
		expect(h.fake.docs.get('next')).toBe('- [x] z\n');
	});
});

describe('graceful stop (playbook)', () => {
	it('stops after the task in flight and records a stopped run', async () => {
		const h = harness({ tasks: '- [ ] one\n- [ ] two\n- [ ] three\n' });
		h.fake.onTurn = (request, f) => {
			if (request.purpose !== 'task' || !request.document) return { success: true };
			f.docs.set(request.document, tickFirstTask(f.docs.get(request.document) ?? ''));
			h.controller.requestStop();
			return { success: true, response: 'done', agentSessionId: 'p' };
		};

		const events = await run(h);

		expect(h.fake.requests.filter((r) => r.purpose === 'task')).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: false,
			stopped: true,
			totalTasksCompleted: 1,
		});
		expect(h.fake.history.at(-1)?.summary).toBe('Auto Run stopped: by operator');
		expect(h.fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('stops before the first document when the request came before the run started', async () => {
		const h = harness({ tasks: '- [ ] one\n' });
		h.controller.requestStop();

		const events = await run(h);

		expect(h.fake.requests).toHaveLength(0);
		expect(events.at(-1)).toMatchObject({ stopped: true });
	});
});

describe('run clock (playbook)', () => {
	it('leaves paused time out of the total and out of the loop that held it', async () => {
		const h = harness({ tasks: '- [ ] one\n- [ ] two\n' });
		let failed = false;
		h.fake.onTurn = (request, f) => {
			if (request.purpose !== 'task' || !request.document) return { success: true };
			h.time.now += 1_000;
			if (!failed) {
				failed = true;
				return { success: false, agentError: agentError() };
			}
			f.docs.set(request.document, tickFirstTask(f.docs.get(request.document) ?? ''));
			return { success: true, response: 'done', agentSessionId: 'p' };
		};
		// The run sits parked for ten minutes before anyone answers.
		h.answers = [
			() => {
				h.time.now += 600_000;
				return 'resume';
			},
		];

		const events = await run(h, { loopEnabled: true, maxLoops: 1 });

		const complete = events.at(-1) as unknown as { totalElapsedMs: number };
		// Three dispatches of one second each, plus the engine's own sub-second clock reads.
		expect(complete.totalElapsedMs).toBeGreaterThanOrEqual(3_000);
		expect(complete.totalElapsedMs).toBeLessThan(60_000);
		expect(h.controller.pausedMs()).toBe(600_000);
		const finalLoop = h.fake.history.find((e) => e.summary.startsWith('Loop 1 (final)'));
		expect(finalLoop?.elapsedTimeMs).toBeLessThan(60_000);
	});
});

describe('goal run pauses', () => {
	const goal = (overrides: Partial<GoalRunConfig> = {}): GoalRunConfig => ({
		goal: 'Ship the feature',
		exitCriteria: 'All tests pass',
		maxIterations: 5,
		...overrides,
	});

	/** The first iteration fails with a classified error; every later one completes the goal. */
	const failFirstIteration = (h: Harness) => {
		let iterations = 0;
		h.fake.onTurn = (request) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'note' };
			iterations++;
			if (iterations === 1) return { success: false, error: 'down', agentError: agentError() };
			return {
				success: true,
				response: '<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->\nDone',
				agentSessionId: 'prov',
			};
		};
	};

	const runGoalWith = (h: Harness) => collect(runGoal(session(), goal(), {}, h.fake.deps));

	it('retries the same iteration on resume and records only the iteration that finished', async () => {
		const h = harness({});
		failFirstIteration(h);
		h.answers = ['resume'];

		const events = await runGoalWith(h);

		expect(types(events)).toEqual([
			'goal_start',
			'goal_iteration_start',
			'paused',
			'resumed',
			'goal_iteration_start',
			'goal_iteration_complete',
			'goal_complete',
		]);
		const starts = events.filter((e) => e.type === 'goal_iteration_start');
		expect(starts.map((e) => e.iteration)).toEqual([1, 1]);
		expect(events.at(-1)).toMatchObject({ success: true, exitReason: 'completed', iterations: 1 });
		expect(h.fake.history.map((e) => e.summary)).toEqual([
			'Goal-Driven Auto Run started',
			'Auto Run error: Connection Error (goal iteration 1)',
			'Goal progress: 100% - done',
			'Goal completed (100%)',
		]);
	});

	it.each(['skip', 'abort'] as const)('ends the run stopped on %s', async (answer) => {
		const h = harness({});
		failFirstIteration(h);
		h.answers = [answer];

		const events = await runGoalWith(h);

		expect(events.at(-1)).toMatchObject({
			type: 'goal_complete',
			success: false,
			exitReason: 'stopped-by-user',
			iterations: 1,
		});
		expect(events.some((e) => e.type === 'goal_iteration_complete')).toBe(false);
	});

	it('does not pause under the CLI policy: the failed iteration is recorded', async () => {
		const h = harness({}, CLI_AUTORUN_POLICY);
		failFirstIteration(h);

		const events = await runGoalWith(h);

		expect(events.some((e) => e.type === 'paused')).toBe(false);
		expect(events.find((e) => e.type === 'goal_iteration_complete')).toMatchObject({
			iteration: 1,
			success: false,
		});
	});

	it('stops between iterations on a graceful stop request', async () => {
		const h = harness({});
		h.fake.onTurn = (request) => {
			if (request.purpose === 'goal-handoff') return { success: true, response: 'note' };
			h.controller.requestStop();
			return {
				success: true,
				response: '<!-- maestro:progress 30 | going -->\nWorking',
				agentSessionId: 'prov',
			};
		};

		const events = await runGoalWith(h);

		expect(events.filter((e) => e.type === 'goal_iteration_start')).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			exitReason: 'stopped-by-user',
			exitDetail: 'Stopped by the operator after iteration 1.',
		});
	});

	it('leaves paused time out of the goal run total', async () => {
		const h = harness({});
		failFirstIteration(h);
		h.answers = [
			() => {
				h.time.now += 900_000;
				return 'resume';
			},
		];

		const events = await runGoalWith(h);

		expect((events.at(-1) as unknown as { totalElapsedMs: number }).totalElapsedMs).toBeLessThan(
			60_000
		);
		expect(h.controller.pausedMs()).toBe(900_000);
	});
});
