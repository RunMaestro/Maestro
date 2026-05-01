/**
 * pr-quality-gate-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions
 * `runner-active → needs-review` inside the Planning Pipeline.
 *
 * Responsibility: invoke a `QualityGateChecker` that runs a focused set of
 * read-only validation checks (TypeScript compile, conflict-marker scan, basic
 * build sanity, etc.) and surface the result via the optional `onCheckResult`
 * callback.  Actual checker implementations are out of scope for this module —
 * they will be wired in later tasks (e.g. gh CLI calls, npm script runners).
 * This module owns only the trigger shell, the narrow checker interface, and
 * the error-swallowing contract.
 *
 * Error contract:
 *   - Checker errors are caught, logged, and reported via `onCheckResult` with
 *     `{ passed: false, failures: ['<error message>'] }`.  They are NEVER
 *     re-thrown — the registry already isolates handler failures; swallowing
 *     here provides belt-and-suspenders and ensures `onCheckResult` is always
 *     called so the caller can react to silent gate failures.
 *   - `onCheckResult` errors are caught and logged but do not affect the
 *     overall handler resolution.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts  — registry contract
 * @see src/shared/planning-pipeline-types.ts           — PipelineStageEvent
 */

import { logger } from '../../utils/logger';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// QualityGateChecker — narrow interface, stubbed in tests
// ---------------------------------------------------------------------------

/**
 * Result returned by a quality gate check run.
 */
export interface QualityGateCheckResult {
	/** `true` when all checks passed; `false` when one or more failed. */
	passed: boolean;
	/**
	 * Human-readable descriptions of each failing check.
	 * Empty array when `passed` is `true`.
	 */
	failures: string[];
}

/**
 * Minimal interface for running quality gate checks.
 *
 * Concrete implementations are injected at wiring time and will typically
 * shell out to `tsc --noEmit`, conflict-marker grep, ESLint, etc.
 * The interface is intentionally narrow so the trigger can be tested without
 * any real tooling present.
 */
export interface QualityGateChecker {
	runChecks(args: { workItemId: string; prNumber?: number }): Promise<QualityGateCheckResult>;
}

// ---------------------------------------------------------------------------
// onCheckResult callback shape
// ---------------------------------------------------------------------------

/**
 * Payload delivered to `onCheckResult` after every gate run (pass or fail).
 */
export interface QualityGateCheckResultPayload {
	workItemId: string;
	passed: boolean;
	failures: string[];
}

// ---------------------------------------------------------------------------
// Dependency interface — narrow and stub-able in tests
// ---------------------------------------------------------------------------

export interface PrQualityGateTriggerDeps {
	checker: QualityGateChecker;
	/**
	 * Optional callback invoked with the gate result after each run.
	 *
	 * Callers use this to, for example, flip the work item's GitHub label back
	 * to `needs-fix` when `passed` is `false`, or to update dashboard state.
	 *
	 * If omitted, results are only logged.
	 * Errors thrown inside `onCheckResult` are caught and logged but do not
	 * propagate — the trigger always resolves cleanly.
	 */
	onCheckResult?: (result: QualityGateCheckResultPayload) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates the `runner-active → needs-review` trigger handler.
 *
 * The handler is a no-op for any other `(fromStage, toStage)` pair — this
 * guard is belt-and-suspenders because the registry only calls handlers
 * registered under the matching key.
 */
export function createPrQualityGateTrigger(deps: PrQualityGateTriggerDeps): TriggerHandler {
	const { checker, onCheckResult } = deps;

	return async function prQualityGateTriggerHandler(event: PipelineStageEvent): Promise<void> {
		// Guard: only act on the exact transition this handler was built for.
		if (event.fromStage !== 'runner-active' || event.toStage !== 'needs-review') {
			return;
		}

		let result: QualityGateCheckResultPayload;

		try {
			const checkResult = await checker.runChecks({ workItemId: event.workItemId });

			result = {
				workItemId: event.workItemId,
				passed: checkResult.passed,
				failures: checkResult.failures,
			};

			if (checkResult.passed) {
				logger.info('prQualityGateTrigger: quality gate passed', 'PipelineTrigger', {
					workItemId: event.workItemId,
				});
			} else {
				logger.warn('prQualityGateTrigger: quality gate failed', 'PipelineTrigger', {
					workItemId: event.workItemId,
					failures: checkResult.failures,
				});
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			logger.error(
				'prQualityGateTrigger: checker threw an unexpected error — treating as gate failure',
				'PipelineTrigger',
				{
					error: errorMessage,
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				}
			);

			result = {
				workItemId: event.workItemId,
				passed: false,
				failures: [errorMessage],
			};
		}

		// Deliver the result to the caller regardless of pass/fail.
		if (onCheckResult) {
			try {
				await onCheckResult(result);
			} catch (callbackErr) {
				logger.error(
					'prQualityGateTrigger: onCheckResult callback threw — result delivery failed',
					'PipelineTrigger',
					{
						error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
						workItemId: event.workItemId,
						passed: result.passed,
					}
				);
				// Intentionally not re-throwing: the callback error must not mask the
				// gate result or cause the handler to reject.
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `runner-active → needs-review` trigger on `registry`.
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerPrQualityGateTrigger(
	registry: PipelineTriggerRegistry,
	deps: PrQualityGateTriggerDeps
): void {
	registry.register('runner-active', 'needs-review', createPrQualityGateTrigger(deps));
}
