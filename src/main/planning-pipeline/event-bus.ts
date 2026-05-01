/**
 * event-bus.ts
 *
 * In-process event bus for Planning Pipeline stage events.
 *
 * Design decisions:
 *   - Uses a plain subscriber array instead of Node's EventEmitter to keep the
 *     contract strongly typed and avoid pulling in the `events` module.
 *   - `publish` is async and awaits every handler so callers can reliably
 *     `await publish(event)` and know all side effects have settled — useful
 *     for deterministic tests.
 *   - Handler errors are caught, logged, and swallowed so a buggy subscriber
 *     never prevents other subscribers from receiving the event.
 *
 * @see src/main/planning-pipeline/trigger-registry.ts — consumer of this bus
 */

import { logger } from '../utils/logger';
import type { PipelineStageEvent } from '../../shared/planning-pipeline-types';

/** A subscriber that handles pipeline stage events. */
export type PipelineEventHandler = (event: PipelineStageEvent) => void | Promise<void>;

/** Cancels a subscription when called. */
export type PipelineEventUnsubscribe = () => void;

/**
 * Simple in-process event bus for `PipelineStageEvent`.
 *
 * Usage:
 *   const bus = new PipelineEventBus();
 *   const unsub = bus.subscribe(async (event) => { ... });
 *   await bus.publish(event);   // awaits all handlers
 *   unsub();                    // stop receiving events
 */
export class PipelineEventBus {
	private readonly handlers = new Set<PipelineEventHandler>();

	/**
	 * Registers a handler that will be called for every published event.
	 *
	 * @returns An unsubscribe function — call it to stop receiving events.
	 */
	subscribe(handler: PipelineEventHandler): PipelineEventUnsubscribe {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	/**
	 * Publishes an event to all current subscribers.
	 *
	 * - Awaits every handler sequentially so tests can `await publish(event)`
	 *   and observe side effects synchronously.
	 * - Handler errors are swallowed: a single failing handler does NOT prevent
	 *   subsequent handlers from running and does NOT propagate to the caller.
	 */
	async publish(event: PipelineStageEvent): Promise<void> {
		for (const handler of Array.from(this.handlers)) {
			try {
				await handler(event);
			} catch (err) {
				logger.error('PipelineEventBus: handler threw an error', 'PipelineBus', {
					error: err instanceof Error ? err.message : String(err),
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				});
			}
		}
	}

	/** Returns the number of active subscribers. Useful for testing. */
	get subscriberCount(): number {
		return this.handlers.size;
	}
}
