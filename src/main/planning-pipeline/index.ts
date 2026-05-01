/**
 * index.ts
 *
 * Barrel re-exports for the Planning Pipeline runtime primitives.
 *
 * Public surface:
 *   - PipelineEventBus + PipelineEventHandler + PipelineEventUnsubscribe
 *   - PipelineTriggerRegistry + TriggerHandler + TriggerKey + buildTriggerKey
 *   - PipelineDispatcher
 *   - createPipelineRuntime + PipelineRuntime
 */

export { PipelineEventBus } from './event-bus';
export type { PipelineEventHandler, PipelineEventUnsubscribe } from './event-bus';

export { PipelineTriggerRegistry, buildTriggerKey } from './trigger-registry';
export type { TriggerHandler, TriggerKey } from './trigger-registry';

export { PipelineDispatcher } from './dispatcher';

export { createPipelineRuntime } from './runtime';
export type { PipelineRuntime } from './runtime';
