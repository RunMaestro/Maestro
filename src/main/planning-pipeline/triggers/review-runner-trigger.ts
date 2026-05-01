/**
 * review-runner-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions INTO
 * `needs-review` inside the Planning Pipeline.
 *
 * Responsibility: invoke a `ReviewerLauncher` to spin up a Sonnet-powered
 * reviewer agent that will inspect the PR diff, run broader validation, and
 * post a `review-approved` or `needs-fix` outcome.  The trigger itself is
 * intentionally narrow — it calls the launcher and forwards the result to an
 * optional callback.  Actual agent-spawning logic lives in a future task that
 * wires `ReviewerLauncher` to `agent-spawner.ts` / the dispatch engine.
 *
 * Registration scope: `needs-review` can be reached from:
 *   - `runner-active`  (PIPELINE_TRANSITIONS — normal happy path)
 *   - `fix-active`     (PIPELINE_FAILURE_TRANSITIONS — retry loop)
 *
 * Both are derived at module-load time from the transition tables so the set
 * stays correct automatically if the tables gain additional edges.
 *
 * Error contract:
 *   - Launcher errors are caught, logged, and reported via `onLaunchResult`
 *     with `{ launched: false, reason: '<error message>' }`.  They are NEVER
 *     re-thrown — the registry already isolates handler failures; swallowing
 *     here provides belt-and-suspenders and ensures `onLaunchResult` is always
 *     called so the caller can react to silent failures.
 *   - `onLaunchResult` errors are caught and logged but do not affect the
 *     overall handler resolution.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts  — registry contract
 * @see src/shared/planning-pipeline-types.ts           — PIPELINE_TRANSITIONS,
 *                                                        PIPELINE_FAILURE_TRANSITIONS
 */

import { logger } from '../../utils/logger';
import {
	PIPELINE_TRANSITIONS,
	PIPELINE_FAILURE_TRANSITIONS,
} from '../../../shared/planning-pipeline-types';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent, AnyPipelineStage } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// ReviewerLauncher — narrow injectable interface
// ---------------------------------------------------------------------------

/**
 * Arguments forwarded to the reviewer launcher.
 *
 * `prNumber` is optional — early pipeline items may not yet have a GitHub PR.
 */
export interface ReviewerLaunchArgs {
	/** Work Graph item ID whose review is being initiated. */
	workItemId: string;
	/** PR number on GitHub, if available. */
	prNumber?: number;
	/** The stage the item was in immediately before `needs-review`. */
	fromStage: string;
}

/**
 * Result returned by `ReviewerLauncher.launchReviewer`.
 */
export interface ReviewerLaunchResult {
	/** `true` when a reviewer agent was successfully spawned. */
	launched: boolean;
	/** Provider session ID of the spawned reviewer, if launched. */
	sessionId?: string;
	/** Human-readable reason when `launched` is `false` or an error occurred. */
	reason?: string;
}

/**
 * Minimal interface for launching a reviewer agent.
 *
 * Concrete implementations will be wired in a future task on top of
 * `agent-spawner.ts` or the existing dispatch engine.  The interface is
 * intentionally narrow so the trigger can be tested without any real
 * agent-spawning infrastructure present.
 */
export interface ReviewerLauncher {
	launchReviewer(args: ReviewerLaunchArgs): Promise<ReviewerLaunchResult>;
}

// ---------------------------------------------------------------------------
// Dependency interface — narrow and stub-able in tests
// ---------------------------------------------------------------------------

export interface ReviewRunnerTriggerDeps {
	launcher: ReviewerLauncher;
	/**
	 * Optional callback invoked with the launch result after every trigger run.
	 *
	 * Callers use this to, for example, update Work Graph state, emit dashboard
	 * events, or schedule follow-up actions once the reviewer is running.
	 *
	 * If omitted, results are only logged.
	 * Errors thrown inside `onLaunchResult` are caught and logged but do not
	 * propagate — the trigger always resolves cleanly.
	 */
	onLaunchResult?: (result: {
		workItemId: string;
		launched: boolean;
		sessionId?: string;
		reason?: string;
	}) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Derived: all predecessors that can reach 'needs-review'
// ---------------------------------------------------------------------------

/**
 * All `AnyPipelineStage` values whose forward-transition list includes
 * `'needs-review'`, derived at module-load time from both
 * `PIPELINE_TRANSITIONS` and `PIPELINE_FAILURE_TRANSITIONS`.
 *
 * At time of writing this resolves to `['runner-active', 'fix-active']`.
 */
export const NEEDS_REVIEW_PREDECESSORS: AnyPipelineStage[] = [
	...(Object.entries(PIPELINE_TRANSITIONS) as [AnyPipelineStage, AnyPipelineStage[]][]),
	...(Object.entries(PIPELINE_FAILURE_TRANSITIONS) as [AnyPipelineStage, AnyPipelineStage[]][]),
].reduce<AnyPipelineStage[]>((acc, [from, targets]) => {
	if (targets.includes('needs-review')) {
		acc.push(from);
	}
	return acc;
}, []);

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a trigger handler that fires when a work item transitions INTO
 * `needs-review` from any permitted predecessor stage.
 *
 * The handler is a no-op when `event.toStage !== 'needs-review'` — this guard
 * is belt-and-suspenders because the registry only invokes handlers under the
 * matching `(fromStage, toStage)` key.
 */
export function createReviewRunnerTrigger(deps: ReviewRunnerTriggerDeps): TriggerHandler {
	const { launcher, onLaunchResult } = deps;

	return async function reviewRunnerTriggerHandler(event: PipelineStageEvent): Promise<void> {
		// Guard: only act on transitions that land on needs-review.
		if (event.toStage !== 'needs-review') {
			return;
		}

		let launchResult: ReviewerLaunchResult;

		try {
			launchResult = await launcher.launchReviewer({
				workItemId: event.workItemId,
				fromStage: event.fromStage,
			});

			if (launchResult.launched) {
				logger.info('reviewRunnerTrigger: reviewer agent launched', 'PipelineTrigger', {
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					sessionId: launchResult.sessionId,
				});
			} else {
				logger.warn('reviewRunnerTrigger: launcher declined to spawn reviewer', 'PipelineTrigger', {
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					reason: launchResult.reason,
				});
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			logger.error(
				'reviewRunnerTrigger: launcher threw an unexpected error — review agent not spawned',
				'PipelineTrigger',
				{
					error: errorMessage,
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				}
			);

			launchResult = { launched: false, reason: errorMessage };
		}

		// Deliver the result to the caller regardless of launched/not-launched.
		if (onLaunchResult) {
			try {
				await onLaunchResult({
					workItemId: event.workItemId,
					launched: launchResult.launched,
					sessionId: launchResult.sessionId,
					reason: launchResult.reason,
				});
			} catch (callbackErr) {
				logger.error(
					'reviewRunnerTrigger: onLaunchResult callback threw — result delivery failed',
					'PipelineTrigger',
					{
						error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
						workItemId: event.workItemId,
						launched: launchResult.launched,
					}
				);
				// Intentionally not re-throwing: the callback error must not mask the
				// launch result or cause the handler to reject.
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `* → needs-review` trigger on `registry` for every predecessor
 * stage enumerated in `NEEDS_REVIEW_PREDECESSORS` (derived from both
 * `PIPELINE_TRANSITIONS` and `PIPELINE_FAILURE_TRANSITIONS`).
 *
 * At time of writing this registers exactly two handlers:
 *   `(runner-active, needs-review)`
 *   `(fix-active,    needs-review)`
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerReviewRunnerTrigger(
	registry: PipelineTriggerRegistry,
	deps: ReviewRunnerTriggerDeps
): void {
	const handler = createReviewRunnerTrigger(deps);
	for (const from of NEEDS_REVIEW_PREDECESSORS) {
		registry.register(from, 'needs-review', handler);
	}
}
