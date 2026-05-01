/**
 * dispatcher.ts
 *
 * Wires `PipelineEventBus` → `PipelineTriggerRegistry`.
 *
 * The dispatcher subscribes to the bus and forwards every published event to
 * the registry's `dispatch` method.  It is intentionally thin — no logic lives
 * here beyond the subscription wiring itself.
 *
 * Lifecycle:
 *   - `start()` — subscribes to the bus (idempotent; calling twice is a no-op).
 *   - `stop()`  — unsubscribes from the bus (idempotent; safe to call before start).
 *
 * @see src/main/planning-pipeline/runtime.ts — factory that owns instances of all three
 */

import type { PipelineEventBus, PipelineEventUnsubscribe } from './event-bus';
import type { PipelineTriggerRegistry } from './trigger-registry';

/**
 * Thin coordinator that keeps the bus and registry in sync.
 *
 * Usage:
 *   const dispatcher = new PipelineDispatcher(bus, registry);
 *   dispatcher.start();   // begin forwarding events
 *   // ... later ...
 *   dispatcher.stop();    // stop forwarding
 */
export class PipelineDispatcher {
	private unsubscribe: PipelineEventUnsubscribe | null = null;

	constructor(
		private readonly bus: PipelineEventBus,
		private readonly registry: PipelineTriggerRegistry
	) {}

	/**
	 * Subscribes to the bus and forwards all events to the trigger registry.
	 *
	 * Idempotent — calling `start()` while already started is a no-op.
	 */
	start(): void {
		if (this.unsubscribe !== null) {
			return;
		}
		this.unsubscribe = this.bus.subscribe((event) => this.registry.dispatch(event));
	}

	/**
	 * Unsubscribes from the bus, halting event forwarding.
	 *
	 * Idempotent — safe to call before `start()` or multiple times.
	 */
	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** Returns `true` if the dispatcher is currently subscribed to the bus. */
	get isRunning(): boolean {
		return this.unsubscribe !== null;
	}
}
