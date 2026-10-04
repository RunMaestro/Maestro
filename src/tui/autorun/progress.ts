/**
 * What the Auto Run progress screen says (AR-6) and what it lets a person do
 * about it (AR-7), as pure functions of a run folded by the library's
 * `reduceAutoRun`. The screen (`ProgressView.tsx`) only lays these out, and the
 * App routes its keys to `submitRunControl`.
 */

import {
	formatCost,
	formatElapsedTimeColon,
	formatTokensCompact,
	isAutoRunActive,
	isHitlGatePause,
	runElapsedMs,
	runUsageTotals,
	type AgentRecord,
	type AutoRunRun,
	type ClientResult,
	type MaestroClient,
} from '../../shared/maestro-lib';

const EMPTY: AutoRunRun = { progress: null, pausedMs: 0, usageByProcess: {}, tail: [] };

export type RunStatus = 'none' | 'running' | 'stopping' | 'paused' | 'gate' | 'finished';

export interface RunSummary {
	status: RunStatus;
	/** One line: what the run is doing right now. */
	headline: string;
	/** `Document 2 of 3: name`. Absent for a goal run and before the host says. */
	documentLine?: string;
	/** `Task 4 of 9`, or the goal's percent. */
	taskLine?: string;
	/** `Loop 2`, when the run loops. */
	loopLine?: string;
	/** What a pause or gate waits on. */
	pauseLine?: string;
	/** Work time, paused time left out. */
	clock: string;
	/** `12.4K in, 3.1K out`. */
	tokens: string;
	cost: string;
}

export function runStatusOf(run: AutoRunRun | undefined): RunStatus {
	if (!run || run.startedAt === undefined) return 'none';
	if (!isAutoRunActive(run)) return 'finished';
	if (isHitlGatePause(run.progress)) return 'gate';
	if (run.progress?.pause) return 'paused';
	return run.progress?.isStopping ? 'stopping' : 'running';
}

function headlineFor(status: RunStatus, run: AutoRunRun): string {
	const goal = run.progress?.goal;
	switch (status) {
		case 'none':
			return 'No run for this agent.';
		case 'running':
			return goal ? 'Pursuing the goal' : 'Running';
		case 'stopping':
			return 'Stopping after the current task';
		case 'gate':
			return 'Waiting for you';
		case 'paused':
			return 'Paused on an error';
		case 'finished':
			return run.progress && run.progress.tasksDone >= run.progress.tasksTotal && !goal
				? 'Finished'
				: 'Ended';
	}
}

function taskLineFor(run: AutoRunRun): string | undefined {
	const progress = run.progress;
	if (!progress) return undefined;
	if (progress.goal) {
		const { percent, iteration } = progress.goal;
		const parts = [
			iteration !== undefined ? `Iteration ${iteration}` : undefined,
			percent !== undefined ? `${Math.round(percent)}% toward the goal` : undefined,
		].filter(Boolean);
		return parts.length > 0 ? parts.join(', ') : undefined;
	}
	if (progress.tasksTotal === 0) return undefined;
	const doc =
		progress.currentDocTasksTotal > 0
			? ` (${progress.currentDocTasksDone}/${progress.currentDocTasksTotal} in this document)`
			: '';
	return `Task ${progress.tasksDone}/${progress.tasksTotal} done${doc}`;
}

/** Everything the screen prints, for the run at `now`. */
export function describeRun(run: AutoRunRun | undefined, now: number): RunSummary {
	const status = runStatusOf(run);
	if (!run || status === 'none') {
		return {
			status,
			headline: headlineFor(status, EMPTY),
			clock: '0:00',
			tokens: '0',
			cost: '$0.00',
		};
	}
	const progress = run.progress;
	const totals = runUsageTotals(run);
	const documentName =
		progress && progress.documents.length > 0
			? progress.documents[Math.min(progress.currentDocumentIndex, progress.documents.length - 1)]
			: undefined;
	const pause = progress?.pause;
	return {
		status,
		headline: headlineFor(status, run),
		...(documentName && progress
			? {
					documentLine: `Document ${Math.min(progress.currentDocumentIndex + 1, progress.documents.length)} of ${progress.documents.length}: ${documentName}`,
				}
			: {}),
		...(taskLineFor(run) ? { taskLine: taskLineFor(run) } : {}),
		...(progress?.loopEnabled ? { loopLine: `Loop ${progress.loopIteration + 1}` } : {}),
		...(pause
			? {
					pauseLine: pause.taskDescription
						? `${pause.message} (${pause.taskDescription})`
						: pause.message,
				}
			: {}),
		clock: formatElapsedTimeColon(Math.floor(runElapsedMs(run, now) / 1000)),
		tokens: `${formatTokensCompact(totals.inputTokens)} in, ${formatTokensCompact(totals.outputTokens)} out`,
		cost: formatCost(totals.costUsd),
	};
}

export type RunControl = 'stop' | 'resume' | 'skip' | 'abort';

export interface RunControlOffer {
	control: RunControl;
	label: string;
}

/**
 * The controls that mean something now. A run going can be stopped; a parked run
 * can be resumed, skipped past, or ended. A gate has no failing document to skip,
 * so it offers its answer (Approve) and the two ways out.
 */
export function availableRunControls(run: AutoRunRun | undefined): RunControlOffer[] {
	switch (runStatusOf(run)) {
		case 'running':
			return [{ control: 'stop', label: 'Stop after this task' }];
		case 'gate':
			return [
				{ control: 'resume', label: 'Approve and continue' },
				{ control: 'abort', label: 'Abort the run' },
				{ control: 'stop', label: 'Stop' },
			];
		case 'paused':
			return [
				{ control: 'resume', label: 'Resume' },
				{ control: 'skip', label: 'Skip this document' },
				{ control: 'abort', label: 'Abort the run' },
				{ control: 'stop', label: 'Stop' },
			];
		default:
			return [];
	}
}

/** Why a control means nothing now, for one line; undefined when the run offers it. */
export function controlRefusal(
	run: AutoRunRun | undefined,
	control: RunControl
): string | undefined {
	if (availableRunControls(run).some((offer) => offer.control === control)) return undefined;
	switch (runStatusOf(run)) {
		case 'none':
		case 'finished':
			return 'No run is going.';
		case 'stopping':
			return 'The run is already stopping.';
		default:
			return control === 'stop'
				? 'The run cannot be stopped now.'
				: 'The run is not paused, so there is nothing to ' + control + '.';
	}
}

const DONE_MESSAGES: Record<RunControl, (agent: AgentRecord) => string> = {
	stop: (agent) => `Asked ${agent.name} to stop after the current task.`,
	resume: () => 'Resumed the run.',
	skip: () => 'Skipping the failing document.',
	abort: () => 'Aborted the run.',
};

/** Sends one control to the window that owns the run. `ok` means it was delivered, not that it landed. */
export async function submitRunControl(
	client: MaestroClient,
	agent: AgentRecord,
	control: RunControl
): Promise<ClientResult<string>> {
	const sent = await client.autoRun[control](agent.id);
	return sent.ok ? { ok: true, value: DONE_MESSAGES[control](agent) } : sent;
}

/** The newest `rows` lines of output, oldest first. */
export function tailRows(run: AutoRunRun | undefined, rows: number): string[] {
	if (!run || rows <= 0) return [];
	return run.tail.slice(-rows);
}
