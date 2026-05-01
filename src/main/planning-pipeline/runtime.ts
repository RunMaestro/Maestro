/**
 * runtime.ts
 *
 * Factory that creates and starts the Planning Pipeline runtime — bus,
 * registry, and dispatcher — in a single call.
 *
 * Consumers receive a handle that exposes the three components and a `stop()`
 * convenience method that shuts down the dispatcher cleanly.
 *
 * Usage:
 *   const runtime = createPipelineRuntime();
 *   runtime.registry.register('prd-finalized', 'epic-decomposed', myHandler);
 *   // ... when shutting down ...
 *   runtime.stop();
 *
 * @see src/main/planning-pipeline/event-bus.ts
 * @see src/main/planning-pipeline/trigger-registry.ts
 * @see src/main/planning-pipeline/dispatcher.ts
 */

import { PipelineEventBus } from './event-bus';
import { PipelineTriggerRegistry } from './trigger-registry';
import { PipelineDispatcher } from './dispatcher';

export interface PipelineRuntime {
	/** The event bus — publish events here. */
	readonly bus: PipelineEventBus;
	/** The trigger registry — register handlers here before publishing. */
	readonly registry: PipelineTriggerRegistry;
	/** The dispatcher — wires bus to registry; already started. */
	readonly dispatcher: PipelineDispatcher;
	/** Convenience method: stops the dispatcher cleanly. */
	stop(): void;
}

/**
 * Constructs and starts the pipeline runtime.
 *
 * The dispatcher is started immediately so handlers registered on the
 * registry will receive events from the moment this function returns.
 *
 * Register all trigger handlers on `runtime.registry` before publishing
 * any events to `runtime.bus` to avoid missing the first events.
 */
export function createPipelineRuntime(): PipelineRuntime {
	const bus = new PipelineEventBus();
	const registry = new PipelineTriggerRegistry();
	const dispatcher = new PipelineDispatcher(bus, registry);
	dispatcher.start();

	return {
		bus,
		registry,
		dispatcher,
		stop(): void {
			dispatcher.stop();
		},
	};
}
