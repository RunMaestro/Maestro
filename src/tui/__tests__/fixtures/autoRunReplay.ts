import {
	parseAutoRunProgress,
	type AutoRunRunEvent,
	type UsageStats,
} from '../../../shared/maestro-lib';

const usage = (fields: Partial<UsageStats>): UsageStats => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0,
	contextWindow: 200000,
	...fields,
});

/** An `autorun_state` payload as the desktop pushes it, with the fields of a two-document run. */
const wire = (fields: Record<string, unknown>) => ({
	isRunning: true,
	totalTasks: 3,
	completedTasks: 0,
	currentTaskIndex: 0,
	documents: ['phase-1', 'phase-2'],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 2,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 5,
	completedTasksAcrossAllDocs: 0,
	loopEnabled: false,
	loopIteration: 0,
	...fields,
});

const state = (at: number, fields: Record<string, unknown> | null): AutoRunRunEvent => ({
	kind: 'state',
	at,
	state: fields === null ? null : parseAutoRunProgress(wire(fields)),
});

/** Every point of the recorded run, in order, as offsets from its start in seconds. */
export const RECORDED_RUN_POINTS = {
	started: 0,
	firstTaskDone: 40,
	paused: 70,
	resumed: 130,
	secondDocument: 160,
	finished: 220,
} as const;

/**
 * A short run as the bridge delivers it: start, tool lines and an answer,
 * usage reports for two task processes, a rate-limit pause, a resume, and the
 * end. Authored from the broadcast shape (`src/shared/autoRunBroadcast.ts`) and
 * the process stream, not recorded from a desktop, so it carries no user data.
 * Work time at the end: 220s minus the 60s pause.
 */
export function recordedRun(base: number, agentId = 'a1'): AutoRunRunEvent[] {
	const at = (seconds: number) => base + seconds * 1000;
	const p = RECORDED_RUN_POINTS;
	const first = `${agentId}-batch-1`;
	const second = `${agentId}-batch-2`;
	return [
		state(at(p.started), { startTime: at(p.started) }),
		{ kind: 'output', at: at(5), processId: first, text: 'Read src/index.ts' },
		{ kind: 'output', at: at(12), processId: first, text: 'Edited src/index.ts' },
		{
			kind: 'usage',
			at: at(20),
			processId: first,
			usage: usage({ inputTokens: 1000, outputTokens: 200, totalCostUsd: 0.04 }),
		},
		{ kind: 'output', at: at(p.firstTaskDone - 1), processId: first, text: 'Task one is done.' },
		{
			kind: 'usage',
			at: at(p.firstTaskDone - 1),
			processId: first,
			usage: usage({ inputTokens: 1500, outputTokens: 300, totalCostUsd: 0.06 }),
		},
		state(at(p.firstTaskDone), {
			startTime: at(0),
			completedTasks: 1,
			currentTaskIndex: 1,
			currentDocTasksCompleted: 1,
			completedTasksAcrossAllDocs: 1,
		}),
		state(at(p.paused), {
			startTime: at(0),
			completedTasks: 1,
			currentTaskIndex: 1,
			currentDocTasksCompleted: 1,
			completedTasksAcrossAllDocs: 1,
			errorPaused: true,
			errorMessage: 'Rate limited by the provider',
			errorType: 'rate_limit',
			errorRecoverable: true,
			errorTaskDescription: 'Write the tests',
			errorDocumentIndex: 0,
		}),
		state(at(p.resumed), {
			startTime: at(0),
			completedTasks: 1,
			currentTaskIndex: 1,
			currentDocTasksCompleted: 1,
			completedTasksAcrossAllDocs: 1,
		}),
		state(at(p.secondDocument), {
			startTime: at(0),
			completedTasks: 2,
			currentTaskIndex: 0,
			currentDocumentIndex: 1,
			currentDocTasksTotal: 3,
			currentDocTasksCompleted: 0,
			completedTasksAcrossAllDocs: 2,
		}),
		{ kind: 'output', at: at(170), processId: second, text: 'Ran npm test' },
		{
			kind: 'usage',
			at: at(180),
			processId: second,
			usage: usage({ inputTokens: 800, outputTokens: 150, totalCostUsd: 0.03 }),
		},
		state(at(p.finished), {
			isRunning: false,
			startTime: at(0),
			completedTasks: 5,
			currentTaskIndex: 3,
			currentDocumentIndex: 1,
			currentDocTasksTotal: 3,
			currentDocTasksCompleted: 3,
			completedTasksAcrossAllDocs: 5,
		}),
	];
}

/** The same run cut off at an offset: what a screen opened at that moment would show. */
export function recordedRunUntil(base: number, seconds: number, agentId = 'a1'): AutoRunRunEvent[] {
	return recordedRun(base, agentId).filter((event) => event.at <= base + seconds * 1000);
}
