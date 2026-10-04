import { describe, expect, it } from 'vitest';
import {
	EMPTY_AUTO_RUN,
	parseAutoRunProgress,
	reduceAutoRun,
	type AgentRecord,
	type AutoRunRun,
} from '../../shared/maestro-lib';
import {
	backspaceLaunch,
	cycleLaunchField,
	initialLaunchForm,
	launchFields,
	launchRequestOf,
	moveLaunchFocus,
	submitLaunch,
	typeIntoLaunch,
	type LaunchFormState,
} from '../autorun/launchForm';
import {
	availableRunControls,
	controlRefusal,
	describeRun,
	runStatusOf,
	submitRunControl,
	tailRows,
} from '../autorun/progress';
import { createFakeClient } from './fakeClient';
import { RECORDED_RUN_POINTS, recordedRun, recordedRunUntil } from './fixtures/autoRunReplay';

const BASE = 1_800_000_000_000;
const sec = (seconds: number) => BASE + seconds * 1000;

const agent = (extra: Partial<AgentRecord> = {}): AgentRecord => ({
	id: 'a1',
	name: 'Alpha',
	toolType: 'claude-code',
	cwd: '/work/alpha',
	...extra,
});

const replayRun = (until: number): AutoRunRun =>
	recordedRunUntil(BASE, until).reduce(reduceAutoRun, EMPTY_AUTO_RUN);

const DOCS = [
	{ name: 'second', file: '/work/alpha/.maestro/playbooks/second.md' },
	{ name: 'sub/first', file: '/work/alpha/.maestro/playbooks/sub/first.md' },
];

describe('the launch form', () => {
	const lookups = { models: ['opus', 'sonnet'] };

	it('offers loop, reset, model and effort for a spec run, and the loop count only while looping', () => {
		const form = initialLaunchForm('spec', agent(), DOCS);
		expect(launchFields(form, agent(), lookups).map((field) => field.id)).toEqual([
			'loop',
			'reset',
			'model',
			'effort',
		]);
		const looping = cycleLaunchField(form, launchFields(form, agent(), lookups), 1);
		expect(looping.values.loop).toBe(true);
		expect(launchFields(looping, agent(), lookups).map((field) => field.id)).toEqual([
			'loop',
			'maxLoops',
			'reset',
			'model',
			'effort',
		]);
	});

	it('offers goal, exit criteria, and a cap for a goal run, opening on the goal', () => {
		const form = initialLaunchForm('goal', agent());
		expect(form.focus).toBe('goal');
		expect(form.documents).toEqual([]);
		expect(launchFields(form, agent(), lookups).map((field) => field.id)).toEqual([
			'goal',
			'exitCriteria',
			'maxIterations',
			'model',
			'effort',
		]);
		expect(form.values.maxIterations).toBe('10');
	});

	it('makes model a choice when the provider reports models, else a text box', () => {
		const form = initialLaunchForm('spec', agent(), DOCS);
		const model = (models: string[]) =>
			launchFields(form, agent(), { models }).find((field) => field.id === 'model');
		expect(model(['opus'])).toMatchObject({ kind: 'choice', options: ['', 'opus'] });
		expect(model([])).toMatchObject({ kind: 'text' });
	});

	it('moves focus, stopping at the ends', () => {
		const form = initialLaunchForm('spec', agent(), DOCS);
		const fields = launchFields(form, agent(), lookups);
		const down = moveLaunchFocus(form, fields, 1);
		expect(down.focus).toBe('reset');
		expect(moveLaunchFocus(moveLaunchFocus(down, fields, 5), fields, 1).focus).toBe('effort');
		expect(moveLaunchFocus(form, fields, -1).focus).toBe('loop');
	});

	it('types into a text box, keeps a count to digits, and a space steps a toggle or choice', () => {
		let form: LaunchFormState = initialLaunchForm('goal', agent());
		const fields = () => launchFields(form, agent(), lookups);
		form = typeIntoLaunch(form, fields(), 'Fix the build');
		expect(form.values.goal).toBe('Fix the build');
		form = backspaceLaunch(form, fields());
		expect(form.values.goal).toBe('Fix the buil');

		form = { ...form, focus: 'maxIterations' };
		form = typeIntoLaunch(form, fields(), 'a5b');
		expect(form.values.maxIterations).toBe('105');
		form = backspaceLaunch(backspaceLaunch(backspaceLaunch(form, fields()), fields()), fields());
		expect(form.values.maxIterations).toBe('');

		form = { ...form, focus: 'model' };
		form = typeIntoLaunch(form, fields(), ' ');
		expect(form.values.model).toBe('opus');
		form = typeIntoLaunch(form, fields(), 'x');
		expect(form.values.model).toBe('opus');
		form = cycleLaunchField(form, fields(), -1);
		expect(form.values.model).toBe('');
		// Back past the first option wraps to the last.
		expect(cycleLaunchField(form, fields(), -1).values.model).toBe('sonnet');
	});

	it('builds a spec request in picked order with the per-run overrides', () => {
		let form = initialLaunchForm('spec', agent(), DOCS);
		form = {
			...form,
			values: {
				...form.values,
				loop: true,
				maxLoops: '3',
				reset: true,
				model: 'opus',
				effort: ' high ',
			},
		};
		expect(launchRequestOf(form)).toEqual({
			ok: true,
			value: {
				mode: 'spec',
				input: {
					documents: [
						{ file: DOCS[0].file, resetOnCompletion: true },
						{ file: DOCS[1].file, resetOnCompletion: true },
					],
					loop: true,
					maxLoops: 3,
					model: 'opus',
					effort: 'high',
				},
			},
		});
	});

	it('builds a goal request, where an empty cap means no cap', () => {
		let form = initialLaunchForm('goal', agent());
		form = {
			...form,
			values: { ...form.values, goal: ' Ship it ', maxIterations: '', exitCriteria: 'CI green' },
		};
		expect(launchRequestOf(form)).toEqual({
			ok: true,
			value: {
				mode: 'goal',
				input: { goal: 'Ship it', exitCriteria: 'CI green', maxIterations: null },
			},
		});
	});

	it('says what to fix: no goal, a zero cap, no documents', () => {
		const goal = initialLaunchForm('goal', agent());
		expect(launchRequestOf(goal)).toEqual({
			ok: false,
			reason: 'Say what the run should achieve.',
		});
		expect(
			launchRequestOf({ ...goal, values: { ...goal.values, goal: 'g', maxIterations: '0' } })
		).toEqual({ ok: false, reason: 'The iteration cap must be a whole number of 1 or more.' });
		expect(launchRequestOf(initialLaunchForm('spec', agent(), []))).toEqual({
			ok: false,
			reason: 'Pick at least one document.',
		});
	});

	it('starts a spec run through the client, first giving the agent the folder it was shown', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const result = await submitLaunch(
			fake.client,
			agent(),
			initialLaunchForm('spec', agent(), DOCS)
		);
		expect(result).toEqual({
			ok: true,
			value: { message: 'Started 2 documents on Alpha.' },
		});
		expect(fake.requests.map((request) => request.method)).toEqual([
			'agents.update',
			'autoRun.launch',
		]);
		expect(fake.requests[0].args).toEqual([
			'a1',
			{ autoRunFolderPath: '/work/alpha/.maestro/playbooks' },
		]);
		expect(fake.requests[1].args).toEqual([
			'a1',
			{ documents: [{ file: DOCS[0].file }, { file: DOCS[1].file }] },
		]);
	});

	it('leaves an agent that already has a folder alone', async () => {
		const own = agent({ autoRunFolderPath: '/elsewhere' });
		const fake = createFakeClient({ agents: [own] });
		await submitLaunch(fake.client, own, initialLaunchForm('spec', own, DOCS.slice(0, 1)));
		expect(fake.requests.map((request) => request.method)).toEqual(['autoRun.launch']);
	});

	it('starts a goal run, and sends nothing for a form that does not check out', async () => {
		const fake = createFakeClient({ agents: [agent()] });
		const goal = initialLaunchForm('goal', agent());
		expect(await submitLaunch(fake.client, agent(), goal)).toMatchObject({
			ok: false,
			error: { code: 'invalid' },
		});
		expect(fake.requests).toEqual([]);

		const result = await submitLaunch(fake.client, agent(), {
			...goal,
			values: { ...goal.values, goal: 'Make it green' },
		});
		expect(result).toEqual({ ok: true, value: { message: 'Started a goal run on Alpha.' } });
		expect(fake.requests).toEqual([
			{ method: 'autoRun.launchGoal', args: ['a1', { goal: 'Make it green', maxIterations: 10 }] },
		]);
	});

	it('hands back the host refusal, and does not call a refused folder write a start', async () => {
		const fake = createFakeClient({
			agents: [agent()],
			failures: { 'agents.update': 'rejected' },
		});
		const result = await submitLaunch(
			fake.client,
			agent(),
			initialLaunchForm('spec', agent(), DOCS)
		);
		expect(result).toMatchObject({ ok: false, error: { code: 'rejected' } });
		expect(fake.requests.map((request) => request.method)).toEqual(['agents.update']);
	});
});

describe('the progress summary, replaying a recorded run', () => {
	it('says nothing is running before the first state', () => {
		expect(describeRun(undefined, BASE)).toMatchObject({
			status: 'none',
			headline: 'No run for this agent.',
		});
		expect(availableRunControls(undefined)).toEqual([]);
	});

	it('shows the current document and task, the clock, tokens, and cost mid-run', () => {
		const run = replayRun(RECORDED_RUN_POINTS.firstTaskDone + 5);
		const summary = describeRun(run, sec(RECORDED_RUN_POINTS.firstTaskDone + 5));
		expect(summary).toMatchObject({
			status: 'running',
			headline: 'Running',
			documentLine: 'Document 1 of 2: phase-1',
			taskLine: 'Task 1/5 done (1/2 in this document)',
			clock: '0:45',
			tokens: '1.5K in, 300 out',
			cost: '$0.06',
		});
		expect(summary.pauseLine).toBeUndefined();
		expect(availableRunControls(run).map((offer) => offer.control)).toEqual(['stop']);
	});

	it('holds the clock while paused and offers resume, skip, abort, and stop', () => {
		const run = replayRun(RECORDED_RUN_POINTS.paused + 30);
		const at = (seconds: number) => describeRun(run, sec(seconds));
		expect(at(RECORDED_RUN_POINTS.paused + 30)).toMatchObject({
			status: 'paused',
			headline: 'Paused on an error',
			pauseLine: 'Rate limited by the provider (Write the tests)',
			clock: '1:10',
		});
		// Half a minute later the clock has not moved.
		expect(at(RECORDED_RUN_POINTS.paused + 600).clock).toBe('1:10');
		expect(availableRunControls(run).map((offer) => offer.control)).toEqual([
			'resume',
			'skip',
			'abort',
			'stop',
		]);
	});

	it('resumes the clock after the pause and moves to the next document', () => {
		const run = replayRun(RECORDED_RUN_POINTS.secondDocument + 10);
		const summary = describeRun(run, sec(RECORDED_RUN_POINTS.secondDocument + 10));
		expect(summary).toMatchObject({
			status: 'running',
			documentLine: 'Document 2 of 2: phase-2',
			taskLine: 'Task 2/5 done (0/3 in this document)',
			// 170s of wall time, 60s of it paused.
			clock: '1:50',
		});
	});

	it('ends with the whole run summed: work time without the pause, usage across both processes', () => {
		const run = recordedRun(BASE).reduce(reduceAutoRun, EMPTY_AUTO_RUN);
		expect(runStatusOf(run)).toBe('finished');
		expect(describeRun(run, sec(9999))).toMatchObject({
			status: 'finished',
			headline: 'Finished',
			taskLine: 'Task 5/5 done (3/3 in this document)',
			clock: '2:40',
			tokens: '2.3K in, 450 out',
			cost: '$0.09',
		});
		expect(availableRunControls(run)).toEqual([]);
		expect(tailRows(run, 2)).toEqual(['Task one is done.', 'Ran npm test']);
		expect(tailRows(run, 99)).toEqual([
			'Read src/index.ts',
			'Edited src/index.ts',
			'Task one is done.',
			'Ran npm test',
		]);
		expect(tailRows(run, 0)).toEqual([]);
	});

	it('offers approve, abort and stop at a human gate, and no skip', () => {
		const gate = reduceAutoRun(EMPTY_AUTO_RUN, {
			kind: 'state',
			at: sec(1),
			state: parseAutoRunProgress({
				isRunning: true,
				totalTasks: 2,
				completedTasks: 0,
				currentTaskIndex: 0,
				errorPaused: true,
				errorType: 'hitl_gate',
				errorMessage: 'Review the design',
			}),
		});
		expect(runStatusOf(gate)).toBe('gate');
		expect(describeRun(gate, sec(2))).toMatchObject({
			headline: 'Waiting for you',
			pauseLine: 'Review the design',
		});
		expect(availableRunControls(gate)).toEqual([
			{ control: 'resume', label: 'Approve and continue' },
			{ control: 'abort', label: 'Abort the run' },
			{ control: 'stop', label: 'Stop' },
		]);
	});

	it('shows a goal run by iteration and percent', () => {
		const run = reduceAutoRun(EMPTY_AUTO_RUN, {
			kind: 'state',
			at: sec(1),
			state: parseAutoRunProgress({
				isRunning: true,
				totalTasks: 0,
				completedTasks: 0,
				currentTaskIndex: 0,
				goalMode: true,
				goalProgress: 40.4,
				goalIteration: 3,
			}),
		});
		expect(describeRun(run, sec(2))).toMatchObject({
			headline: 'Pursuing the goal',
			taskLine: 'Iteration 3, 40% toward the goal',
		});
	});

	it('shows a stopping run as stopping, with nothing left to press', () => {
		const run = reduceAutoRun(EMPTY_AUTO_RUN, {
			kind: 'state',
			at: sec(1),
			state: parseAutoRunProgress({
				isRunning: true,
				isStopping: true,
				totalTasks: 2,
				completedTasks: 0,
				currentTaskIndex: 0,
			}),
		});
		expect(describeRun(run, sec(2)).headline).toBe('Stopping after the current task');
		expect(availableRunControls(run)).toEqual([]);
		expect(controlRefusal(run, 'stop')).toBe('The run is already stopping.');
	});
});

describe('run controls', () => {
	const running = replayRun(50);
	const paused = replayRun(RECORDED_RUN_POINTS.paused + 5);

	it('refuses a control the run does not offer, saying why', () => {
		expect(controlRefusal(running, 'stop')).toBeUndefined();
		expect(controlRefusal(running, 'resume')).toBe(
			'The run is not paused, so there is nothing to resume.'
		);
		expect(controlRefusal(paused, 'skip')).toBeUndefined();
		expect(controlRefusal(undefined, 'stop')).toBe('No run is going.');
		expect(controlRefusal(replayRun(300), 'abort')).toBe('No run is going.');
	});

	it.each([
		['stop', 'autoRun.stop', 'Asked Alpha to stop after the current task.'],
		['resume', 'autoRun.resume', 'Resumed the run.'],
		['skip', 'autoRun.skip', 'Skipping the failing document.'],
		['abort', 'autoRun.abort', 'Aborted the run.'],
	] as const)('%s calls %s and says it went', async (control, method, message) => {
		const fake = createFakeClient({ agents: [agent()] });
		expect(await submitRunControl(fake.client, agent(), control)).toEqual({
			ok: true,
			value: message,
		});
		expect(fake.requests).toEqual([{ method, args: ['a1'] }]);
	});

	it('passes the host refusal through', async () => {
		const fake = createFakeClient({ agents: [agent()], failures: { 'autoRun.stop': 'host-lost' } });
		expect(await submitRunControl(fake.client, agent(), 'stop')).toMatchObject({
			ok: false,
			error: { code: 'host-lost' },
		});
	});
});
