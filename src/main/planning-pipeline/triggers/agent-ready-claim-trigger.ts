/**
 * agent-ready-claim-trigger.ts
 *
 * Concrete trigger handler that fires when a work item transitions INTO
 * `agent-ready` inside the Planning Pipeline.
 *
 * Responsibility: delegate to `AgentDispatchEngine.runAutoPickup()` so that
 * an idle, capable agent can claim the newly-eligible work item.  This trigger
 * is the event-driven bridge that turns Work Graph `agent-ready` state into
 * running execution without introducing a second polling loop — the same
 * `runAutoPickup` path used by the fleet-readiness event handler is invoked
 * here on the stage-transition event-driven path.
 *
 * Registration scope: because `PIPELINE_TRANSITIONS` defines exactly one
 * permitted predecessor for `agent-ready` (namely `tasks-decomposed`), this
 * module registers a single `(tasks-decomposed, agent-ready)` handler.
 *
 * The `null → agent-ready` path is explicitly excluded: `planStageTransition`
 * in planning-pipeline-guards.ts only permits `null → idea` as the initial
 * onramp, so items cannot enter the pipeline directly as `agent-ready`.
 * Registering a null-origin handler would therefore be dead code and is
 * intentionally omitted.
 *
 * Errors from the dispatch engine are logged and swallowed — the registry
 * already isolates handler failures; this is belt-and-suspenders.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts   — registry contract
 * @see src/main/agent-dispatch/dispatch-engine.ts       — runAutoPickup
 * @see src/shared/planning-pipeline-types.ts            — PIPELINE_TRANSITIONS
 */

import { logger } from '../../utils/logger';
import { PIPELINE_TRANSITIONS } from '../../../shared/planning-pipeline-types';
import type { PipelineTriggerRegistry, TriggerHandler } from '../trigger-registry';
import type { PipelineStageEvent, PipelineStage } from '../../../shared/planning-pipeline-types';
import type { AutoPickupRunResult } from '../../agent-dispatch/dispatch-engine';

// ---------------------------------------------------------------------------
// Dependency interface — keeps this module decoupled from the concrete engine
// ---------------------------------------------------------------------------

/**
 * Minimal dispatch engine surface required by this trigger.
 *
 * Using a structural interface rather than importing `AgentDispatchEngine`
 * directly keeps the coupling shallow and makes tests trivial to write.
 * The return type mirrors `AutoPickupRunResult` from dispatch-engine.ts.
 */
export interface AgentReadyClaimEngine {
	runAutoPickup(): Promise<AutoPickupRunResult>;
}

export interface AgentReadyClaimTriggerDeps {
	dispatchEngine: AgentReadyClaimEngine;
}

// ---------------------------------------------------------------------------
// Derived: predecessors for 'agent-ready' from the forward transition table
// ---------------------------------------------------------------------------

/**
 * All `PipelineStage` values whose forward-transition list includes
 * `'agent-ready'`.
 *
 * Derived at module-load time from `PIPELINE_TRANSITIONS` so the set stays
 * automatically correct if the transition table ever gains additional edges.
 * At time of writing this resolves to `['tasks-decomposed']`.
 */
export const AGENT_READY_PREDECESSORS: PipelineStage[] = (
	Object.entries(PIPELINE_TRANSITIONS) as [PipelineStage, string[]][]
).reduce<PipelineStage[]>((acc, [from, targets]) => {
	if (targets.includes('agent-ready')) {
		acc.push(from);
	}
	return acc;
}, []);

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a trigger handler that fires when a work item transitions INTO
 * `agent-ready` from any permitted predecessor stage.
 *
 * The handler is a no-op when `event.toStage !== 'agent-ready'` — this guard
 * is belt-and-suspenders because the registry only invokes handlers under the
 * matching `(fromStage, toStage)` key.
 */
export function createAgentReadyClaimTrigger(deps: AgentReadyClaimTriggerDeps): TriggerHandler {
	const { dispatchEngine } = deps;

	return async function agentReadyClaimTriggerHandler(event: PipelineStageEvent): Promise<void> {
		// Guard: only act on transitions that land on agent-ready.
		if (event.toStage !== 'agent-ready') {
			return;
		}

		try {
			await dispatchEngine.runAutoPickup();
		} catch (err) {
			logger.error(
				'agentReadyClaimTrigger: runAutoPickup failed — item remains agent-ready for next pickup cycle',
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
			// if the dispatch engine is unavailable or the fleet is empty.
		}
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Registers the `* → agent-ready` trigger on `registry` for every predecessor
 * stage enumerated in `AGENT_READY_PREDECESSORS` (derived from
 * `PIPELINE_TRANSITIONS`).
 *
 * At time of writing this registers exactly one handler:
 *   `(tasks-decomposed, agent-ready)`
 *
 * The `null → agent-ready` origin is NOT registered because
 * `planStageTransition` explicitly rejects it — items entering the pipeline
 * must start at `'idea'`.
 *
 * Intended to be called once during application startup (or test setup).
 * The registry does not deduplicate handlers, so calling this more than once
 * will register the handler multiple times — callers are responsible for
 * ensuring single-call semantics at the wiring layer.
 */
export function registerAgentReadyClaimTrigger(
	registry: PipelineTriggerRegistry,
	deps: AgentReadyClaimTriggerDeps
): void {
	const handler = createAgentReadyClaimTrigger(deps);
	for (const from of AGENT_READY_PREDECESSORS) {
		registry.register(from, 'agent-ready', handler);
	}
}
