/**
 * What a client learns about a running Auto Run (AR-6, AR-7).
 *
 * The run itself lives in one desktop window; everything another client sees is
 * the flattened `AutoRunBroadcastState` the host pushes as `autorun_state`
 * (`src/shared/autoRunBroadcast.ts`). This reads that wire shape defensively
 * into one record a screen can draw, so a frame from a host built before a
 * field existed degrades to less detail instead of a crash.
 */

import type { AutoRunBroadcastState } from '../../autoRunBroadcast';

/** The error type the engine raises when a task waits on a person (a HITL gate). */
export const HITL_GATE_ERROR_TYPE = 'hitl_gate';

/** Why a run is parked. Recoverable errors can resume; a gate resumes by being answered. */
export interface AutoRunPause {
	message: string;
	type: string;
	recoverable: boolean;
	/** The task that failed or is gated, when the host says. */
	taskDescription?: string;
	/** The document it happened in (0-based index into `documents`). */
	documentIndex?: number;
}

export interface AutoRunGoalProgress {
	/** Latest self-reported progress toward the goal, 0 to 100. */
	percent?: number;
	rationale?: string;
	/** 1-based. */
	iteration?: number;
}

export interface AutoRunProgress {
	isRunning: boolean;
	isStopping: boolean;
	/** Document filenames in run order. Empty for a goal run. */
	documents: string[];
	/** 0-based. */
	currentDocumentIndex: number;
	currentDocTasksTotal: number;
	currentDocTasksDone: number;
	/** Across every document in the run. */
	tasksTotal: number;
	tasksDone: number;
	loopEnabled: boolean;
	/** 0 is the first pass. */
	loopIteration: number;
	/** Epoch ms the owning window started the run, when it says. */
	startTime?: number;
	worktreeBranch?: string;
	/** Set while the run waits on an error or a gate. */
	pause?: AutoRunPause;
	/** Present for a goal-driven run. */
	goal?: AutoRunGoalProgress;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asNumber = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Reads one `autorun_state` payload. `null` means no run: the host sends `null`
 * when it clears the state, and a payload that is not an object says nothing.
 */
export function parseAutoRunProgress(raw: unknown): AutoRunProgress | null {
	if (!isObject(raw)) return null;
	const wire = raw as Partial<AutoRunBroadcastState> & Record<string, unknown>;
	const documents = Array.isArray(wire.documents)
		? wire.documents.filter((name): name is string => typeof name === 'string')
		: [];
	const totalTasks = asNumber(wire.totalTasks) ?? 0;
	const completedTasks = asNumber(wire.completedTasks) ?? 0;
	const tasksTotal = asNumber(wire.totalTasksAcrossAllDocs) ?? totalTasks;
	const tasksDone = asNumber(wire.completedTasksAcrossAllDocs) ?? completedTasks;
	const pauseMessage = asString(wire.errorMessage);

	const goalMode = wire.goalMode === true;
	const goalPercent = asNumber(wire.goalProgress);
	const goalIteration = asNumber(wire.goalIteration);
	const goalRationale = asString(wire.goalRationale);

	return {
		isRunning: wire.isRunning === true,
		isStopping: wire.isStopping === true,
		documents,
		currentDocumentIndex: asNumber(wire.currentDocumentIndex) ?? 0,
		currentDocTasksTotal: asNumber(wire.currentDocTasksTotal) ?? 0,
		currentDocTasksDone: asNumber(wire.currentDocTasksCompleted) ?? 0,
		tasksTotal,
		tasksDone,
		loopEnabled: wire.loopEnabled === true,
		loopIteration: asNumber(wire.loopIteration) ?? 0,
		...(asNumber(wire.startTime) !== undefined ? { startTime: asNumber(wire.startTime) } : {}),
		...(asString(wire.worktreeBranch) ? { worktreeBranch: asString(wire.worktreeBranch) } : {}),
		// A paused run with no message still needs the controls, so the flag alone builds a pause.
		...(wire.errorPaused === true || pauseMessage
			? {
					pause: {
						message: pauseMessage ?? 'The run is paused.',
						type: asString(wire.errorType) ?? 'unknown',
						recoverable: wire.errorRecoverable === true,
						...(asString(wire.errorTaskDescription)
							? { taskDescription: asString(wire.errorTaskDescription) }
							: {}),
						...(asNumber(wire.errorDocumentIndex) !== undefined
							? { documentIndex: asNumber(wire.errorDocumentIndex) }
							: {}),
					},
				}
			: {}),
		...(goalMode
			? {
					goal: {
						...(goalPercent !== undefined ? { percent: goalPercent } : {}),
						...(goalRationale ? { rationale: goalRationale } : {}),
						...(goalIteration !== undefined ? { iteration: goalIteration } : {}),
					},
				}
			: {}),
	};
}

/** The run is parked at a human-in-the-loop gate: Resume answers it. */
export function isHitlGatePause(progress: AutoRunProgress | null | undefined): boolean {
	return progress?.pause?.type === HITL_GATE_ERROR_TYPE;
}
