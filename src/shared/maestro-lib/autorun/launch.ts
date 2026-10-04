/**
 * What a person configures to start an Auto Run (AR-4, AR-5), and the rules
 * both kinds of run share before anything is sent.
 *
 * Spec-driven: documents in run order, loop, reset on completion, an optional
 * model and effort for this run only. Goal-driven: a goal, exit criteria, and an
 * iteration cap (the fields of `GoalRunConfig`, `src/shared/goalDriven/types.ts`). The host
 * validates again; checking here turns a mistake into a line beside the field
 * instead of a round trip and a refusal.
 */

/** The cap the desktop's goal panel starts at when "Infinite" is turned off. */
export const DEFAULT_GOAL_MAX_ITERATIONS = 10;

export interface AutoRunDocumentChoice {
	/**
	 * The document's absolute path, as `maestro-cli` sends it. The host works out
	 * the name under the agent's Auto Run folder; a bare name for a document in a
	 * subfolder would lose the folder.
	 */
	file: string;
	/** Revert this document's tasks to unchecked when the run finishes it. */
	resetOnCompletion?: boolean;
}

export interface AutoRunLaunchInput {
	/** Run order: the first document runs first. */
	documents: AutoRunDocumentChoice[];
	loop?: boolean;
	/** With `loop`: stop after this many passes. `null` or absent loops until stopped. */
	maxLoops?: number | null;
	/** This run only. Absent uses the agent's model, and a `MAESTRO:MODEL` marker may still apply. */
	model?: string;
	effort?: string;
}

export interface GoalRunLaunchInput {
	goal: string;
	exitCriteria?: string;
	/** `null` runs until the goal is met, a deadlock, a stall, or the engine's hard cap. */
	maxIterations?: number | null;
	model?: string;
	effort?: string;
}

export type LaunchValidation<T> = { ok: true; value: T } | { ok: false; reason: string };

const blankToUndefined = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
};

function positiveInteger(value: number | null | undefined, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return Number.isInteger(value) && value >= 1
		? undefined
		: `${field} must be a whole number of 1 or more.`;
}

/** Trims, drops blanks, and refuses what the host would refuse. */
export function validateAutoRunLaunch(
	input: AutoRunLaunchInput
): LaunchValidation<AutoRunLaunchInput> {
	if (input.documents.length === 0) return { ok: false, reason: 'Pick at least one document.' };
	for (const document of input.documents) {
		if (typeof document.file !== 'string' || document.file.trim() === '') {
			return { ok: false, reason: 'A document has no file.' };
		}
	}
	const loopProblem = positiveInteger(input.maxLoops, 'Max loops');
	if (loopProblem) return { ok: false, reason: loopProblem };
	const model = blankToUndefined(input.model);
	const effort = blankToUndefined(input.effort);
	return {
		ok: true,
		value: {
			documents: input.documents.map((document) => ({
				file: document.file,
				...(document.resetOnCompletion ? { resetOnCompletion: true } : {}),
			})),
			...(input.loop ? { loop: true } : {}),
			...(input.loop && typeof input.maxLoops === 'number' ? { maxLoops: input.maxLoops } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
		},
	};
}

export function validateGoalRunLaunch(
	input: GoalRunLaunchInput
): LaunchValidation<GoalRunLaunchInput> {
	const goal = input.goal.trim();
	if (!goal) return { ok: false, reason: 'Say what the run should achieve.' };
	const capProblem = positiveInteger(input.maxIterations, 'The iteration cap');
	if (capProblem) return { ok: false, reason: capProblem };
	const exitCriteria = blankToUndefined(input.exitCriteria);
	const model = blankToUndefined(input.model);
	const effort = blankToUndefined(input.effort);
	return {
		ok: true,
		value: {
			goal,
			...(exitCriteria ? { exitCriteria } : {}),
			// `null` is a real answer (no cap), so it survives; only an absent cap is left out.
			...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
		},
	};
}
