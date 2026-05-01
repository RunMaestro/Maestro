/**
 * serialized-merge-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions INTO
 * `fork-merged` inside the Planning Pipeline.
 *
 * Responsibility: invoke a `MergeRunner` to perform the actual PR merge and
 * emit the result via the optional `onMergeResult` callback.  Crucially, merge
 * calls are *serialized* — only one merge runs at a time even if multiple
 * `review-approved → fork-merged` events fire concurrently.  This matches the
 * lesson learned from the Symphony autonomous loop where parallel merges caused
 * extended conflict storms (30+ minutes of remediation).
 *
 * Serialization design:
 *   A private `Promise<void>` chain field is maintained inside the factory
 *   closure.  When a new event arrives the trigger enqueues a new unit of work
 *   that `await`s the previous chain before calling `runner.runMerge`.  If the
 *   previous unit threw, the error is caught so the chain continues.  The
 *   overall handler resolves immediately (fire-and-forget from the bus's
 *   perspective); the enqueued work settles asynchronously and emits
 *   `onMergeResult` when done.
 *
 * Registration scope: `fork-merged` can only be reached from `review-approved`
 * (per `PIPELINE_TRANSITIONS`).  Both the predecessors and the target stage are
 * derived at module-load time so the set stays correct automatically if the
 * transition table gains additional edges.
 *
 * Error contract:
 *   - Runner errors are caught, logged, and reported via `onMergeResult` with
 *     `{ merged: false, reason: '<error message>' }`.  They are NEVER
 *     re-thrown — the registry already isolates handler failures; swallowing
 *     here provides belt-and-suspenders and ensures the serialization chain
 *     survives individual runner failures.
 *   - `onMergeResult` errors are caught and logged but do not affect the
 *     overall chain or the handler resolution.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts  — registry contract
 * @see src/shared/planning-pipeline-types.ts           — PIPELINE_TRANSITIONS
 */

import { logger } from '../../utils/logger';
import { PIPELINE_TRANSITIONS } from '../../../shared/planning-pipeline-types';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent, PipelineStage } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// MergeRunner — narrow injectable interface
// ---------------------------------------------------------------------------

/**
 * Result returned by a single merge run.
 */
export interface MergeRunResult {
	/** `true` when the PR was successfully merged. */
	merged: boolean;
	/** The merge commit SHA, if the merge succeeded. */
	sha?: string;
	/** Human-readable reason when `merged` is `false` or an error occurred. */
	reason?: string;
}

/**
 * Minimal interface for running a PR merge.
 *
 * Concrete implementations will be wired in a future task on top of
 * `gh pr merge` calls, conflict detection, and base-drift checks.  The
 * interface is intentionally narrow so the trigger can be tested without any
 * real tooling present.
 */
export interface MergeRunner {
	runMerge(args: { workItemId: string; prNumber?: number }): Promise<MergeRunResult>;
}

// ---------------------------------------------------------------------------
// Dependency interface — narrow and stub-able in tests
// ---------------------------------------------------------------------------

export interface SerializedMergeTriggerDeps {
	runner: MergeRunner;
	/**
	 * Optional callback invoked with the merge result after every run (success
	 * or failure).
	 *
	 * Callers use this to, for example, update Work Graph stage to
	 * `fork-merged`, close the linked GitHub issue, or emit dashboard events.
	 *
	 * If omitted, results are only logged.
	 * Errors thrown inside `onMergeResult` are caught and logged but do not
	 * propagate — the trigger always resolves cleanly.
	 */
	onMergeResult?: (result: {
		workItemId: string;
		merged: boolean;
		sha?: string;
		reason?: string;
	}) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Derived: all predecessors that can reach 'fork-merged'
// ---------------------------------------------------------------------------

/**
 * All `PipelineStage` values whose forward-transition list includes
 * `'fork-merged'`, derived at module-load time from `PIPELINE_TRANSITIONS`.
 *
 * At time of writing this resolves to `['review-approved']`.
 */
export const FORK_MERGED_PREDECESSORS: PipelineStage[] = (
	Object.entries(PIPELINE_TRANSITIONS) as [PipelineStage, string[]][]
).reduce<PipelineStage[]>((acc, [from, targets]) => {
	if (targets.includes('fork-merged')) {
		acc.push(from);
	}
	return acc;
}, []);

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a trigger handler that fires when a work item transitions INTO
 * `fork-merged` from any permitted predecessor stage.
 *
 * The returned handler is **fire-and-forget** from the event bus's perspective:
 * it enqueues the merge work and resolves immediately.  The actual
 * `runner.runMerge` call and `onMergeResult` delivery happen asynchronously,
 * serialized behind any in-progress merge from a prior event.
 *
 * The handler is a no-op when `event.toStage !== 'fork-merged'` — this guard
 * is belt-and-suspenders because the registry only invokes handlers under the
 * matching `(fromStage, toStage)` key.
 */
export function createSerializedMergeTrigger(deps: SerializedMergeTriggerDeps): TriggerHandler {
	const { runner, onMergeResult } = deps;

	// Serialization chain: new merges append themselves to this Promise so
	// they only start after the preceding merge has completed (or failed).
	// Using a resolved Promise as the initial value means the first merge
	// starts immediately.
	let mergeChain: Promise<void> = Promise.resolve();

	return function serializedMergeTriggerHandler(event: PipelineStageEvent): void {
		// Guard: only act on transitions that land on fork-merged.
		if (event.toStage !== 'fork-merged') {
			return;
		}

		// Capture the current tail of the chain and extend it with this merge
		// operation.  The handler itself returns void (fire-and-forget).
		const previousChain = mergeChain;

		mergeChain = (async () => {
			// Wait for the previous merge to finish before starting this one.
			// Errors from prior links are already swallowed below; this await
			// should always resolve.
			await previousChain;

			let mergeResult: MergeRunResult;

			try {
				mergeResult = await runner.runMerge({ workItemId: event.workItemId });

				if (mergeResult.merged) {
					logger.info('serializedMergeTrigger: PR merged successfully', 'PipelineTrigger', {
						workItemId: event.workItemId,
						sha: mergeResult.sha,
					});
				} else {
					logger.warn('serializedMergeTrigger: runner declined to merge PR', 'PipelineTrigger', {
						workItemId: event.workItemId,
						reason: mergeResult.reason,
					});
				}
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				logger.error(
					'serializedMergeTrigger: runner threw an unexpected error — merge not performed',
					'PipelineTrigger',
					{
						error: errorMessage,
						workItemId: event.workItemId,
						fromStage: event.fromStage,
						toStage: event.toStage,
					}
				);

				mergeResult = { merged: false, reason: errorMessage };
			}

			// Deliver the result to the caller regardless of merged/not-merged.
			if (onMergeResult) {
				try {
					await onMergeResult({
						workItemId: event.workItemId,
						merged: mergeResult.merged,
						sha: mergeResult.sha,
						reason: mergeResult.reason,
					});
				} catch (callbackErr) {
					logger.error(
						'serializedMergeTrigger: onMergeResult callback threw — result delivery failed',
						'PipelineTrigger',
						{
							error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
							workItemId: event.workItemId,
							merged: mergeResult.merged,
						}
					);
					// Intentionally not re-throwing: the callback error must not break
					// the serialization chain or prevent subsequent merges from running.
				}
			}
		})().catch((unexpectedErr) => {
			// Last-resort catch: the inner async IIFE should never reject because all
			// errors are handled above.  This catch prevents an unhandled rejection
			// from poisoning the chain in case of an unforeseen code path.
			logger.error(
				'serializedMergeTrigger: unexpected rejection escaped the merge chain — chain reset',
				'PipelineTrigger',
				{
					error: unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr),
					workItemId: event.workItemId,
				}
			);
		});
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `* → fork-merged` trigger on `registry` for every predecessor
 * stage enumerated in `FORK_MERGED_PREDECESSORS` (derived from
 * `PIPELINE_TRANSITIONS`).
 *
 * At time of writing this registers exactly one handler:
 *   `(review-approved, fork-merged)`
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerSerializedMergeTrigger(
	registry: PipelineTriggerRegistry,
	deps: SerializedMergeTriggerDeps
): void {
	const handler = createSerializedMergeTrigger(deps);
	for (const from of FORK_MERGED_PREDECESSORS) {
		registry.register(from, 'fork-merged', handler);
	}
}
