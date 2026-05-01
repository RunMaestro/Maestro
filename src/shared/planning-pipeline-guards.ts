/**
 * planning-pipeline-guards.ts
 *
 * Pure-function guard layer for the Planning Pipeline stage machine.
 *
 * Responsibilities:
 *   1. Detect which pipeline stage a work item is currently in by inspecting
 *      its GitHub label set (`detectCurrentStage`).
 *   2. Validate that a requested stage transition is permitted and produce the
 *      minimal label-mutation plan needed to apply it (`planStageTransition`).
 *   3. Convenience wrapper that returns the full new label set after the
 *      transition is applied (`applyStageTransition`).
 *
 * Invariants enforced:
 *   - At most ONE pipeline label may be present at a time.  If multiple are
 *     found (operator error), `planStageTransition` strips ALL of them and
 *     applies only the target label.
 *   - The only valid transition FROM the "no pipeline label" state is TO
 *     the 'idea' stage (initial onramp).
 *   - All other from→to pairs are validated against the combined
 *     PIPELINE_TRANSITIONS + PIPELINE_FAILURE_TRANSITIONS tables from
 *     planning-pipeline-types.ts.
 *
 * This file is intentionally side-effect-free.  No I/O, no IPC, no
 * main-process imports.  The runtime engine (#246) consumes these guards.
 *
 * @see src/shared/planning-pipeline-types.ts — stage vocabulary and transition tables
 */

import {
	PIPELINE_LABEL_BY_STAGE,
	isValidTransition,
	InvalidPipelineTransitionError,
	type AnyPipelineStage,
} from './planning-pipeline-types';

// ---------------------------------------------------------------------------
// Derived reverse-lookup: label → stage
// ---------------------------------------------------------------------------

/**
 * Reverse map built from PIPELINE_LABEL_BY_STAGE so we can go from a GitHub
 * label string back to its canonical AnyPipelineStage in O(1).
 */
const STAGE_BY_PIPELINE_LABEL: ReadonlyMap<string, AnyPipelineStage> = new Map(
	(Object.entries(PIPELINE_LABEL_BY_STAGE) as [AnyPipelineStage, string][]).map(
		([stage, label]) => [label, stage]
	)
);

// ---------------------------------------------------------------------------
// Public: isPipelineLabel
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given label string is one of the canonical pipeline
 * stage labels (i.e. it appears as a value in `PIPELINE_LABEL_BY_STAGE`).
 *
 * Used internally by all guard functions to partition a label set into
 * "pipeline" and "non-pipeline" subsets.
 */
export function isPipelineLabel(label: string): boolean {
	return STAGE_BY_PIPELINE_LABEL.has(label);
}

// ---------------------------------------------------------------------------
// Public: detectCurrentStage
// ---------------------------------------------------------------------------

/**
 * Inspects a work item's label set and returns the pipeline stage it is
 * currently in, or `null` if no pipeline label is present.
 *
 * **Multiple-label edge case:** If the label set contains more than one
 * pipeline label (operator error — e.g. a manual edit applied two labels),
 * this function returns the FIRST matching label encountered when iterating
 * through the provided array.  The caller should not rely on any particular
 * ordering when the item is in this invalid state.  `planStageTransition`
 * will always strip ALL pipeline labels before applying the target, so the
 * multi-label invariant violation is self-healing on the next transition.
 *
 * @param labels - The full set of GitHub labels currently on the work item.
 * @returns The current `AnyPipelineStage`, or `null` if none found.
 */
export function detectCurrentStage(labels: readonly string[]): AnyPipelineStage | null {
	for (const label of labels) {
		const stage = STAGE_BY_PIPELINE_LABEL.get(label);
		if (stage !== undefined) {
			return stage;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Public: StageTransitionPlan interface
// ---------------------------------------------------------------------------

/**
 * The minimal label-mutation plan required to move a work item from its
 * current stage to `to`.
 *
 * Consumers apply this plan by:
 *   1. Removing every label in `remove` from the item's label set.
 *   2. Adding every label in `add` to the item's label set.
 *
 * `from` and `to` are provided for audit logging and event emission.
 */
export interface StageTransitionPlan {
	/** Labels to add to the work item. */
	add: string[];
	/** Labels to remove from the work item. */
	remove: string[];
	/** The pipeline stage the item was in before this transition (null = no pipeline label yet). */
	from: AnyPipelineStage | null;
	/** The pipeline stage the item will be in after this transition. */
	to: AnyPipelineStage;
}

// ---------------------------------------------------------------------------
// Public: planStageTransition
// ---------------------------------------------------------------------------

/**
 * Validates a requested stage transition and returns the label-mutation plan
 * to apply it.
 *
 * Throws `InvalidPipelineTransitionError` if:
 *   - `from` is a non-null pipeline stage AND the `from → target` edge is not
 *     listed in the combined transition tables.
 *   - `from` is `null` (no current pipeline label) AND `target` is not `'idea'`.
 *
 * The returned plan always strips ALL pipeline-prefixed labels currently on
 * the item (not just the detected current one), ensuring the one-pipeline-
 * label-at-a-time invariant is restored even if the item was in an invalid
 * multi-label state.
 *
 * @param currentLabels - Full label set currently on the work item.
 * @param target        - The pipeline stage to transition to.
 * @returns             - `StageTransitionPlan` with `add` / `remove` arrays.
 * @throws              - `InvalidPipelineTransitionError` on a disallowed transition.
 */
export function planStageTransition(
	currentLabels: readonly string[],
	target: AnyPipelineStage
): StageTransitionPlan {
	const from = detectCurrentStage(currentLabels);

	// Validate the transition.
	if (from === null) {
		// No existing pipeline label — only 'idea' is permitted as the entry point.
		if (target !== 'idea') {
			throw new InvalidPipelineTransitionError(
				// Use a sentinel cast: the error class requires AnyPipelineStage for
				// 'from', but we need to convey "null origin" in the message.  We
				// surface this as a custom message while keeping the typed fields
				// consistent by using 'idea' as the nearest meaningful "from" boundary.
				'idea' as AnyPipelineStage,
				target,
				`Invalid pipeline transition: item has no current pipeline stage — only 'idea' is permitted as the first stage (requested: '${target}')`
			);
		}
	} else if (!isValidTransition(from, target)) {
		throw new InvalidPipelineTransitionError(from, target);
	}

	// Collect all pipeline labels currently on the item so we strip every one
	// (handles the multi-label edge case).
	const remove = currentLabels.filter(isPipelineLabel);
	const add = [PIPELINE_LABEL_BY_STAGE[target]];

	return { add, remove, from, to: target };
}

// ---------------------------------------------------------------------------
// Public: applyStageTransition
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: validates the transition, computes the plan, and
 * returns the new label set with the plan applied.
 *
 * Non-pipeline labels are preserved unchanged.
 *
 * @param currentLabels - Full label set currently on the work item.
 * @param target        - The pipeline stage to transition to.
 * @returns             - New label set as a readonly array.
 * @throws              - `InvalidPipelineTransitionError` on a disallowed transition.
 */
export function applyStageTransition(
	currentLabels: readonly string[],
	target: AnyPipelineStage
): readonly string[] {
	const plan = planStageTransition(currentLabels, target);
	const removeSet = new Set(plan.remove);
	return [...currentLabels.filter((l) => !removeSet.has(l)), ...plan.add];
}
