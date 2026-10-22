/**
 * Auto Run progress math: how far along a run is, and when it will finish.
 *
 * One module so the progress bar, the percent readout and the ETA cannot
 * disagree about what "done" means. Pure and import-free, so any surface that
 * draws an Auto Run (desktop card, web-desktop mirror, CLI) can share it.
 */

/** The run-state fields progress is derived from (a structural subset of `BatchRunState`). */
export interface AutoRunProgressInput {
	goalMode?: boolean;
	goalProgress?: number;
	totalTasksAcrossAllDocs: number;
	completedTasksAcrossAllDocs: number;
	/** Legacy single-document counters, used only when the cross-document totals are empty. */
	totalTasks: number;
	completedTasks: number;
}

/**
 * Percent complete, 0-100 (unrounded). Goal mode reports the agent's own
 * self-assessed percent; task runs report checked tasks over all tasks, which
 * grows when a reset-on-completion document puts its tasks back.
 */
export function autoRunProgressPercent(state: AutoRunProgressInput): number {
	if (state.goalMode) return clampPercent(state.goalProgress ?? 0);
	if (state.totalTasksAcrossAllDocs > 0) {
		return clampPercent((state.completedTasksAcrossAllDocs / state.totalTasksAcrossAllDocs) * 100);
	}
	if (state.totalTasks > 0) {
		return clampPercent((state.completedTasks / state.totalTasks) * 100);
	}
	return 0;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

/**
 * Tasks this run must complete before an ETA is shown. The first task of a run
 * routinely includes setup the rest do not, so an average over one or two
 * tasks swings by hours.
 */
export const AUTO_RUN_ETA_MIN_TASKS = 3;

export interface AutoRunEtaInput {
	goalMode?: boolean;
	totalTasksAcrossAllDocs: number;
	completedTasksAcrossAllDocs: number;
	/**
	 * Checked tasks the documents already held when the run started. They count
	 * toward percent complete but took no time in this run, so they must not
	 * count toward its pace. Absent on state from an older build, in which case
	 * the pace is unknowable and no ETA is given.
	 */
	initialCompletedTasks?: number;
	/** Active run time so far: sleep and paused spans excluded. */
	activeElapsedMs: number;
}

export type AutoRunEtaUnavailableReason =
	/** Goal runs have no task list to count down. */
	| 'goal'
	/** The run carries no baseline, so its pace cannot be separated from pre-checked tasks. */
	| 'no-baseline'
	/** Fewer than `AUTO_RUN_ETA_MIN_TASKS` tasks have completed in this run. */
	| 'warming-up';

export type AutoRunEta =
	| {
			available: true;
			/** Average active time per task completed in this run. */
			msPerTask: number;
			remainingTasks: number;
			/** Projected active time left at the current pace. */
			remainingMs: number;
	  }
	| { available: false; reason: AutoRunEtaUnavailableReason; tasksUntilEstimate?: number };

/**
 * Projects the time left in a task run from its own pace so far: remaining
 * tasks times the average active time per task completed in THIS run.
 *
 * The estimate is only as good as the task list. Totals grow when a reset
 * document re-arms its tasks, and a looping run only knows the tasks of its
 * current pass, so callers should present the result as approximate.
 */
export function estimateAutoRunEta(input: AutoRunEtaInput): AutoRunEta {
	if (input.goalMode) return { available: false, reason: 'goal' };
	if (input.initialCompletedTasks === undefined) {
		return { available: false, reason: 'no-baseline' };
	}

	const doneThisRun = Math.max(0, input.completedTasksAcrossAllDocs - input.initialCompletedTasks);
	if (doneThisRun < AUTO_RUN_ETA_MIN_TASKS || input.activeElapsedMs <= 0) {
		return {
			available: false,
			reason: 'warming-up',
			tasksUntilEstimate: Math.max(1, AUTO_RUN_ETA_MIN_TASKS - doneThisRun),
		};
	}

	const msPerTask = input.activeElapsedMs / doneThisRun;
	const remainingTasks = Math.max(
		0,
		input.totalTasksAcrossAllDocs - input.completedTasksAcrossAllDocs
	);
	return {
		available: true,
		msPerTask,
		remainingTasks,
		remainingMs: remainingTasks * msPerTask,
	};
}
