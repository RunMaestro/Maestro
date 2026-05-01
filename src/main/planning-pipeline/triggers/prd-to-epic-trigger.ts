/**
 * prd-to-epic-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions
 * `prd-finalized → epic-decomposed` inside the Planning Pipeline.
 *
 * Responsibility: call `DeliveryPlannerService.convertPrdToEpic()` with the
 * PRD's work item ID so the service can create the resulting epic in the
 * Work Graph.  All errors are logged but not re-thrown — the registry already
 * isolates handler failures; this is belt-and-suspenders.
 *
 * Registration is intentionally deferred to a later wiring task so this
 * module can be imported and tested without touching main-process startup.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts  — registry contract
 * @see src/main/delivery-planner/planner-service.ts    — convertPrdToEpic
 * @see src/shared/delivery-planner-types.ts            — DeliveryPlannerDecomposePrdRequest
 */

import { logger } from '../../utils/logger';
import type { WorkGraphActor, WorkItem } from '../../../shared/work-graph-types';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent } from '../../../shared/planning-pipeline-types';
import type { ConvertPrdToEpicInput } from '../../delivery-planner/planner-service';

// ---------------------------------------------------------------------------
// Dependency interface — keeps this module decoupled from the concrete service
// ---------------------------------------------------------------------------

/**
 * Minimal planner service surface required by this trigger.
 *
 * Using a structural interface rather than importing `DeliveryPlannerService`
 * directly keeps the coupling shallow and makes tests trivial to write.
 */
export interface PrdToEpicPlannerService {
	convertPrdToEpic(input: ConvertPrdToEpicInput): Promise<WorkItem>;
}

/**
 * Optional actor provider.  When supplied, the actor is threaded through to
 * `convertPrdToEpic` so Work Graph audit trails reflect the pipeline system.
 */
export type GetActor = () => WorkGraphActor | undefined;

export interface PrdToEpicTriggerDeps {
	plannerService: PrdToEpicPlannerService;
	/** If omitted, the system actor `{ id: 'planning-pipeline' }` is used. */
	getActor?: GetActor;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: WorkGraphActor = { type: 'system', id: 'planning-pipeline' };

/**
 * Creates the `prd-finalized → epic-decomposed` trigger handler.
 *
 * The handler is a no-op for any other `(fromStage, toStage)` pair — this
 * guard is belt-and-suspenders because the registry only calls handlers
 * registered under the matching key.
 */
export function createPrdToEpicTrigger(deps: PrdToEpicTriggerDeps): TriggerHandler {
	const { plannerService, getActor } = deps;

	return async function prdToEpicTriggerHandler(event: PipelineStageEvent): Promise<void> {
		// Guard: only act on the exact transition this handler was built for.
		if (event.fromStage !== 'prd-finalized' || event.toStage !== 'epic-decomposed') {
			return;
		}

		const actor = getActor?.() ?? SYSTEM_ACTOR;

		try {
			await plannerService.convertPrdToEpic({
				prdId: event.workItemId,
				actor,
			});
		} catch (err) {
			logger.error(
				'prdToEpicTrigger: convertPrdToEpic failed — PRD remains at prd-finalized for retry',
				'PipelineTrigger',
				{
					error: err instanceof Error ? err.message : String(err),
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				}
			);
			// Intentionally not re-throwing: the registry already isolates handler
			// failures.  Swallowing here ensures the caller's Promise resolves even
			// if the planner service is unavailable or the LLM errors out.
		}
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `prd-finalized → epic-decomposed` trigger on `registry`.
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerPrdToEpicTrigger(
	registry: PipelineTriggerRegistry,
	deps: PrdToEpicTriggerDeps
): void {
	registry.register('prd-finalized', 'epic-decomposed', createPrdToEpicTrigger(deps));
}
