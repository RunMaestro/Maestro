/**
 * doc-gap-auto-promote-trigger.ts
 *
 * Cross-major trigger: when Living Wiki creates a doc-gap WorkItem on the
 * Work Graph event bus, automatically promote it to a Delivery Planner task —
 * IF the `isAutoPromoteEnabled` feature flag is set.
 *
 * This trigger differs from every other trigger in this directory:
 *   - It does NOT subscribe to PipelineEventBus stage transitions.
 *   - It subscribes directly to the Work Graph event bus (subscribeWorkGraphEvents).
 *   - It fires on `workGraph.item.created` events whose payload carries a
 *     work item tagged `living-wiki-doc-gap`.
 *
 * Auto-promotion is distinct from the manual "Promote" button (issue #162).
 * This module is intentionally NOT wired into main-process startup; that wiring
 * will happen in a later task once the feature flag is connected to a settings
 * entry.
 *
 * Errors from `promoteDocGap` are logged and swallowed — this trigger must
 * never crash the work-graph event pipeline.
 *
 * @see src/main/work-graph/events.ts              — subscribeWorkGraphEvents
 * @see src/main/delivery-planner/planner-service.ts — promoteDocGap
 * @see src/shared/work-graph-types.ts             — WorkGraphBroadcastEnvelope
 */

import { logger } from '../../utils/logger';
import type {
	WorkGraphActor,
	WorkItem,
	WorkGraphBroadcastEnvelope,
} from '../../../shared/work-graph-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_GAP_TAG = 'living-wiki-doc-gap';
const SYSTEM_ACTOR: WorkGraphActor = { type: 'system', id: 'planning-pipeline' };

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

/**
 * Minimal planner service surface required by this trigger.
 *
 * The structural interface keeps coupling shallow and makes tests trivial —
 * no real `DeliveryPlannerService` instance is needed.
 */
export interface DocGapAutoPromotePlannerService {
	promoteDocGap(input: {
		docGapWorkItemId: string;
		actor?: WorkGraphActor;
	}): Promise<{ task: WorkItem; created: boolean }>;
}

/**
 * Work Graph event bus surface required for subscription.
 *
 * Matches the `subscribeWorkGraphEvents` signature exported from
 * `src/main/work-graph/events.ts`.
 */
export interface DocGapAutoPromoteEventBus {
	subscribe(handler: (envelope: WorkGraphBroadcastEnvelope) => void): () => void;
}

/**
 * Injectable dependencies for the doc-gap auto-promote trigger.
 *
 * `isAutoPromoteEnabled` is injectable so unit tests can flip the flag
 * without touching any real settings store.
 */
export interface DocGapAutoPromoteDeps {
	plannerService: DocGapAutoPromotePlannerService;
	/**
	 * If provided, the returned actor is threaded through to `promoteDocGap`
	 * so Work Graph audit trails reflect the pipeline system identity.
	 * When omitted, the system actor `{ type: 'system', id: 'planning-pipeline' }` is used.
	 */
	getActor?: () => WorkGraphActor | undefined;
	/**
	 * Feature flag predicate.  The trigger is a complete no-op when this
	 * returns `false`.  The flag will be connected to a real settings entry
	 * in a follow-up task — for now it defaults to `false` to ensure no
	 * accidental auto-promotion in production.
	 */
	isAutoPromoteEnabled: () => boolean;
}

// ---------------------------------------------------------------------------
// Subscriber factory
// ---------------------------------------------------------------------------

/**
 * Creates a Work Graph event subscriber that auto-promotes doc-gap items.
 *
 * The returned handler is designed to be passed directly to
 * `subscribeWorkGraphEvents` (or the `subscribe` method of any compatible
 * event bus).
 *
 * Guard predicates (in order):
 *   1. Feature flag must be `true`.
 *   2. The operation must be `workGraph.item.created`.
 *   3. The item in the payload must be tagged `living-wiki-doc-gap`.
 *
 * All three conditions must hold or the handler exits immediately.
 */
export function createDocGapAutoPromoteSubscriber(
	deps: DocGapAutoPromoteDeps
): (envelope: WorkGraphBroadcastEnvelope) => void {
	const { plannerService, getActor, isAutoPromoteEnabled } = deps;

	return function docGapAutoPromoteHandler(envelope: WorkGraphBroadcastEnvelope): void {
		// Guard 1: feature flag
		if (!isAutoPromoteEnabled()) {
			return;
		}

		// Guard 2: operation
		if (envelope.operation !== 'workGraph.item.created') {
			return;
		}

		// Guard 3: payload must carry a doc-gap item
		const payload = envelope.payload as { item?: WorkItem } | undefined;
		const item = payload?.item;
		if (!item?.tags?.includes(DOC_GAP_TAG)) {
			return;
		}

		const actor = getActor?.() ?? SYSTEM_ACTOR;

		// Fire-and-forget — errors must not propagate to the event bus caller.
		plannerService
			.promoteDocGap({ docGapWorkItemId: item.id, actor })
			.then(({ created }) => {
				if (created) {
					logger.info('docGapAutoPromote: promoted doc-gap to planner task', 'PipelineTrigger', {
						workItemId: item.id,
					});
				} else {
					logger.info(
						'docGapAutoPromote: doc-gap already promoted — skipped (idempotent)',
						'PipelineTrigger',
						{ workItemId: item.id }
					);
				}
			})
			.catch((err: unknown) => {
				logger.error(
					'docGapAutoPromote: promoteDocGap failed — doc-gap not promoted',
					'PipelineTrigger',
					{
						error: err instanceof Error ? err.message : String(err),
						workItemId: item.id,
					}
				);
			});
	};
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Subscribes the doc-gap auto-promote handler to `eventBus` and returns an
 * unsubscribe function.
 *
 * Typical usage at application startup:
 *
 * ```ts
 * import { subscribeWorkGraphEvents } from '../work-graph/events';
 * import { registerDocGapAutoPromote } from './triggers/doc-gap-auto-promote-trigger';
 *
 * const unsubscribe = registerDocGapAutoPromote(
 *   { subscribe: subscribeWorkGraphEvents },
 *   { plannerService, isAutoPromoteEnabled: () => settings.autoPromoteDocGaps },
 * );
 * // store `unsubscribe` and call it on app shutdown
 * ```
 *
 * Callers are responsible for ensuring single-call semantics — registering
 * more than once will create duplicate handlers.
 */
export function registerDocGapAutoPromote(
	eventBus: DocGapAutoPromoteEventBus,
	deps: DocGapAutoPromoteDeps
): () => void {
	return eventBus.subscribe(createDocGapAutoPromoteSubscriber(deps));
}
