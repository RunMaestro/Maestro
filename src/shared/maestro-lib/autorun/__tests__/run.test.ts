import { describe, expect, it } from 'vitest';
import {
	AUTO_RUN_TAIL_LINES,
	EMPTY_AUTO_RUN,
	hasAutoRun,
	isAutoRunActive,
	isHitlGatePause,
	parseAutoRunProgress,
	reduceAutoRun,
	runElapsedMs,
	runUsageTotals,
	validateAutoRunLaunch,
	validateGoalRunLaunch,
	type AutoRunProgress,
	type AutoRunRun,
	type AutoRunRunEvent,
} from '../..';
import type { UsageStats } from '../../../types';

const wire = (fields: Record<string, unknown> = {}) => ({
	isRunning: true,
	totalTasks: 5,
	completedTasks: 1,
	currentTaskIndex: 1,
	...fields,
});

const progress = (fields: Record<string, unknown> = {}): AutoRunProgress => {
	const parsed = parseAutoRunProgress(wire(fields));
	if (!parsed) throw new Error('did not parse');
	return parsed;
};

const usage = (fields: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0,
	contextWindow: 0,
	...fields,
});

const replay = (events: AutoRunRunEvent[], from: AutoRunRun = EMPTY_AUTO_RUN): AutoRunRun =>
	events.reduce(reduceAutoRun, from);

describe('parseAutoRunProgress', () => {
	it('reads the counts across every document and falls back to the current ones', () => {
		expect(
			parseAutoRunProgress(
				wire({
					documents: ['a', 'b', 7],
					currentDocumentIndex: 1,
					currentDocTasksTotal: 3,
					currentDocTasksCompleted: 2,
					totalTasksAcrossAllDocs: 8,
					completedTasksAcrossAllDocs: 4,
					loopEnabled: true,
					loopIteration: 2,
					startTime: 1000,
					worktreeBranch: 'feat',
				})
			)
		).toEqual({
			isRunning: true,
			isStopping: false,
			documents: ['a', 'b'],
			currentDocumentIndex: 1,
			currentDocTasksTotal: 3,
			currentDocTasksDone: 2,
			tasksTotal: 8,
			tasksDone: 4,
			loopEnabled: true,
			loopIteration: 2,
			startTime: 1000,
			worktreeBranch: 'feat',
		});
		expect(progress()).toMatchObject({ tasksTotal: 5, tasksDone: 1, documents: [] });
	});

	it('says no run for null and for anything that is not an object', () => {
		expect(parseAutoRunProgress(null)).toBeNull();
		expect(parseAutoRunProgress('running')).toBeNull();
		expect(parseAutoRunProgress([wire()])).toBeNull();
	});

	it('carries an error pause with its task and document', () => {
		const parsed = progress({
			errorPaused: true,
			errorMessage: 'Rate limited',
			errorType: 'rate_limit',
			errorRecoverable: true,
			errorTaskDescription: 'Write the tests',
			errorDocumentIndex: 2,
		});
		expect(parsed.pause).toEqual({
			message: 'Rate limited',
			type: 'rate_limit',
			recoverable: true,
			taskDescription: 'Write the tests',
			documentIndex: 2,
		});
		expect(isHitlGatePause(parsed)).toBe(false);
	});

	it('builds a pause from the flag alone, and knows a gate by its error type', () => {
		expect(progress({ errorPaused: true }).pause).toMatchObject({
			message: 'The run is paused.',
			type: 'unknown',
			recoverable: false,
		});
		const gate = progress({
			errorPaused: true,
			errorMessage: 'Approve the design',
			errorType: 'hitl_gate',
		});
		expect(isHitlGatePause(gate)).toBe(true);
		expect(isHitlGatePause(null)).toBe(false);
	});

	it('reads goal progress only for a goal run', () => {
		expect(progress().goal).toBeUndefined();
		expect(
			progress({ goalMode: true, goalProgress: 40, goalRationale: 'Tests pass', goalIteration: 3 })
				.goal
		).toEqual({ percent: 40, rationale: 'Tests pass', iteration: 3 });
	});
});

describe('the run tracker', () => {
	it('starts the clock at the host start time, else at the first frame', () => {
		const hosted = replay([{ kind: 'state', at: 5000, state: progress({ startTime: 1000 }) }]);
		expect(hosted.startedAt).toBe(1000);
		expect(runElapsedMs(hosted, 4000)).toBe(3000);

		const unhosted = replay([{ kind: 'state', at: 5000, state: progress() }]);
		expect(unhosted.startedAt).toBe(5000);
		expect(runElapsedMs(unhosted, 9000)).toBe(4000);
		expect(runElapsedMs(EMPTY_AUTO_RUN, 9000)).toBe(0);
	});

	it('leaves paused time out of the clock, whether the pause is open or closed', () => {
		const paused = progress({ errorPaused: true, errorMessage: 'Boom' });
		const running = progress();
		const open = replay([
			{ kind: 'state', at: 1000, state: running },
			{ kind: 'state', at: 4000, state: paused },
		]);
		// 3s of work, then paused: the clock holds at 3s however long the wait.
		expect(runElapsedMs(open, 4000)).toBe(3000);
		expect(runElapsedMs(open, 60_000)).toBe(3000);

		const closed = replay(
			[
				{ kind: 'state', at: 10_000, state: paused },
				{ kind: 'state', at: 20_000, state: running },
			],
			open
		);
		// Started at 1s, paused from 4s to 20s (16s out): 3s of work at 20s, and 8s five seconds later.
		expect(runElapsedMs(closed, 20_000)).toBe(3000);
		expect(runElapsedMs(closed, 25_000)).toBe(8000);
	});

	it('does not open a second pause for a repeated paused frame', () => {
		const paused = progress({ errorPaused: true, errorMessage: 'Boom' });
		const run = replay([
			{ kind: 'state', at: 1000, state: progress() },
			{ kind: 'state', at: 2000, state: paused },
			{ kind: 'state', at: 3000, state: paused },
			{ kind: 'state', at: 12_000, state: progress() },
		]);
		expect(run.pausedMs).toBe(10_000);
	});

	it('ends on the first stopped frame, freezes the clock, and keeps the last counts', () => {
		const run = replay([
			{ kind: 'state', at: 0, state: progress({ startTime: 0 }) },
			{ kind: 'state', at: 8000, state: progress({ isRunning: false, completedTasks: 5 }) },
			{ kind: 'state', at: 9000, state: null },
		]);
		expect(run.endedAt).toBe(8000);
		expect(runElapsedMs(run, 999_999)).toBe(8000);
		expect(run.progress).toMatchObject({ isRunning: false, tasksDone: 5 });
		expect(isAutoRunActive(run)).toBe(false);
		expect(hasAutoRun(run)).toBe(true);
	});

	it('closes a pause that was open when the run ended', () => {
		const run = replay([
			{ kind: 'state', at: 0, state: progress({ startTime: 0 }) },
			{ kind: 'state', at: 2000, state: progress({ errorPaused: true, errorMessage: 'x' }) },
			{ kind: 'state', at: 9000, state: null },
		]);
		expect(runElapsedMs(run, 50_000)).toBe(2000);
	});

	it('never ends a run it did not see start', () => {
		const run = replay([{ kind: 'state', at: 1000, state: null }]);
		expect(run).toEqual(EMPTY_AUTO_RUN);
		expect(hasAutoRun(run)).toBe(false);
		expect(isAutoRunActive(run)).toBe(false);
	});

	it('starts fresh when a running frame follows an ended run', () => {
		const first = replay([
			{ kind: 'state', at: 0, state: progress({ startTime: 0 }) },
			{ kind: 'output', at: 1, processId: 'p1', text: 'old line' },
			{ kind: 'usage', at: 2, processId: 'p1', usage: usage({ totalCostUsd: 1 }) },
			{ kind: 'state', at: 3000, state: null },
		]);
		const second = replay([{ kind: 'state', at: 7000, state: progress() }], first);
		expect(second.endedAt).toBeUndefined();
		expect(second.startedAt).toBe(7000);
		expect(second.tail).toEqual([]);
		expect(runUsageTotals(second).costUsd).toBe(0);
		expect(isAutoRunActive(second)).toBe(true);
	});

	it('keeps the latest usage report per process and sums across processes', () => {
		const run = replay([
			{ kind: 'state', at: 0, state: progress() },
			{
				kind: 'usage',
				at: 1,
				processId: 'a-batch-1',
				usage: usage({ inputTokens: 100, outputTokens: 10, totalCostUsd: 0.1 }),
			},
			{
				kind: 'usage',
				at: 2,
				processId: 'a-batch-1',
				usage: usage({
					inputTokens: 300,
					outputTokens: 40,
					cacheReadInputTokens: 50,
					totalCostUsd: 0.25,
				}),
			},
			{
				kind: 'usage',
				at: 3,
				processId: 'a-batch-2',
				usage: usage({ inputTokens: 20, outputTokens: 5, totalCostUsd: 0.05 }),
			},
		]);
		const totals = runUsageTotals(run);
		expect(totals).toMatchObject({ inputTokens: 320, outputTokens: 45, cacheReadTokens: 50 });
		expect(totals.costUsd).toBeCloseTo(0.3);
	});

	it('tails output by line, drops ANSI and blank lines, and caps the buffer', () => {
		const run = replay([
			{
				kind: 'output',
				at: 1,
				processId: 'p',
				text: '\u001b[32mDone\u001b[0m\r\n\r\nNext step\r\n',
			},
			{ kind: 'output', at: 2, processId: 'p', text: '   ' },
		]);
		expect(run.tail).toEqual(['Done', 'Next step']);

		const many = replay(
			Array.from({ length: AUTO_RUN_TAIL_LINES + 30 }, (_, i) => ({
				kind: 'output' as const,
				at: i,
				processId: 'p',
				text: `line ${i}`,
			}))
		);
		expect(many.tail).toHaveLength(AUTO_RUN_TAIL_LINES);
		expect(many.tail[0]).toBe('line 30');
		expect(many.tail.at(-1)).toBe(`line ${AUTO_RUN_TAIL_LINES + 29}`);
	});
});

describe('validateAutoRunLaunch', () => {
	it('needs a document, with a file on each', () => {
		expect(validateAutoRunLaunch({ documents: [] })).toEqual({
			ok: false,
			reason: 'Pick at least one document.',
		});
		expect(validateAutoRunLaunch({ documents: [{ file: '  ' }] })).toMatchObject({ ok: false });
	});

	it('keeps run order and trims the optional strings away when blank', () => {
		expect(
			validateAutoRunLaunch({
				documents: [{ file: '/p/b.md', resetOnCompletion: true }, { file: '/p/a.md' }],
				loop: true,
				maxLoops: 3,
				model: '  ',
				effort: ' high ',
			})
		).toEqual({
			ok: true,
			value: {
				documents: [{ file: '/p/b.md', resetOnCompletion: true }, { file: '/p/a.md' }],
				loop: true,
				maxLoops: 3,
				effort: 'high',
			},
		});
	});

	it('ignores the loop cap unless the run loops, and refuses a bad one', () => {
		const result = validateAutoRunLaunch({ documents: [{ file: '/p/a.md' }], maxLoops: 4 });
		expect(result).toEqual({ ok: true, value: { documents: [{ file: '/p/a.md' }] } });
		expect(
			validateAutoRunLaunch({ documents: [{ file: '/p/a.md' }], loop: true, maxLoops: 0 })
		).toMatchObject({ ok: false, reason: 'Max loops must be a whole number of 1 or more.' });
		expect(
			validateAutoRunLaunch({ documents: [{ file: '/p/a.md' }], loop: true, maxLoops: 1.5 })
		).toMatchObject({ ok: false });
	});
});

describe('validateGoalRunLaunch', () => {
	it('needs a goal', () => {
		expect(validateGoalRunLaunch({ goal: '   ' })).toEqual({
			ok: false,
			reason: 'Say what the run should achieve.',
		});
	});

	it('keeps a null cap, because no cap is an answer', () => {
		expect(validateGoalRunLaunch({ goal: ' Ship it ', maxIterations: null })).toEqual({
			ok: true,
			value: { goal: 'Ship it', maxIterations: null },
		});
		expect(validateGoalRunLaunch({ goal: 'Ship it' })).toEqual({
			ok: true,
			value: { goal: 'Ship it' },
		});
	});

	it('refuses a cap that is not a whole number of 1 or more', () => {
		for (const maxIterations of [0, -2, 2.5]) {
			expect(validateGoalRunLaunch({ goal: 'g', maxIterations })).toMatchObject({
				ok: false,
				reason: 'The iteration cap must be a whole number of 1 or more.',
			});
		}
		expect(
			validateGoalRunLaunch({
				goal: 'g',
				exitCriteria: ' done when green ',
				maxIterations: 5,
				model: 'm',
			})
		).toEqual({
			ok: true,
			value: { goal: 'g', exitCriteria: 'done when green', maxIterations: 5, model: 'm' },
		});
	});
});
