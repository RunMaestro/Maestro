/**
 * trigger-registry.ts
 *
 * Registry of trigger handlers keyed by (fromStage, toStage) pairs.
 *
 * Design decisions:
 *   - `fromStage` may be `null` to match items whose initial transition
 *     produces no "from" stage (e.g. the very first label application that
 *     moves a raw item into 'idea').
 *   - Multiple handlers per key are supported and run in registration order.
 *   - Failures in one handler are isolated: the remaining handlers for the
 *     same event still run.
 *   - `dispatch` is async and awaits all matched handlers so callers can wait
 *     for all side effects to settle.
 *
 * @see src/main/planning-pipeline/event-bus.ts      — publishes the events
 * @see src/main/planning-pipeline/dispatcher.ts     — wires bus → registry
 * @see src/shared/planning-pipeline-types.ts        — AnyPipelineStage, PipelineStageEvent
 */

import { logger } from '../utils/logger';
import type { AnyPipelineStage, PipelineStageEvent } from '../../shared/planning-pipeline-types';

/**
 * A function invoked when a work item transitions from `fromStage` → `toStage`.
 *
 * Returning a Promise is optional — the dispatcher awaits it either way.
 */
export type TriggerHandler = (event: PipelineStageEvent) => void | Promise<void>;

/**
 * Opaque key identifying a registered trigger.
 * Format: `"<fromStage|null>→<toStage>"`.
 * Returned by `register()` so the caller can `unregister()` later.
 */
export type TriggerKey = string;

interface TriggerEntry {
	key: TriggerKey;
	handler: TriggerHandler;
}

/**
 * Builds the lookup key for a (fromStage, toStage) pair.
 * Exported for use in tests.
 */
export function buildTriggerKey(from: AnyPipelineStage | null, to: AnyPipelineStage): TriggerKey {
	return `${from ?? 'null'}→${to}`;
}

/**
 * Registry of pipeline trigger handlers.
 *
 * Usage:
 *   const registry = new PipelineTriggerRegistry();
 *   const key = registry.register('prd-finalized', 'epic-decomposed', handler);
 *   await registry.dispatch(event);
 *   registry.unregister(key);
 */
export class PipelineTriggerRegistry {
	/**
	 * Map from `TriggerKey` to ordered list of handlers.
	 *
	 * We store all entries in a flat list under each key so registration order
	 * is preserved and we can have multiple handlers per key.
	 */
	private readonly entries = new Map<TriggerKey, TriggerEntry[]>();

	/**
	 * Registers a handler for the `from → to` transition.
	 *
	 * @param from - The stage the item is transitioning FROM, or `null` to match
	 *               items entering the pipeline for the first time (no prior stage).
	 * @param to   - The stage the item is transitioning TO.
	 * @param handler - The function to invoke when the transition occurs.
	 * @returns A `TriggerKey` that can be passed to `unregister()` to cancel.
	 *
	 * Note: registering the same `(from, to, handler)` triple multiple times
	 * results in multiple calls — handlers are NOT deduplicated.
	 */
	register(
		from: AnyPipelineStage | null,
		to: AnyPipelineStage,
		handler: TriggerHandler
	): TriggerKey {
		const key = buildTriggerKey(from, to);
		const entry: TriggerEntry = { key, handler };
		const existing = this.entries.get(key);
		if (existing) {
			existing.push(entry);
		} else {
			this.entries.set(key, [entry]);
		}
		return key;
	}

	/**
	 * Removes all handlers registered under `key`.
	 *
	 * Silently does nothing if the key is not registered.
	 */
	unregister(key: TriggerKey): void {
		this.entries.delete(key);
	}

	/**
	 * Returns all handlers whose key matches `(from, to)`.
	 *
	 * Returns an empty array if no handlers are registered for the pair.
	 */
	getHandlersFor(from: AnyPipelineStage | null, to: AnyPipelineStage): TriggerHandler[] {
		const key = buildTriggerKey(from, to);
		return (this.entries.get(key) ?? []).map((e) => e.handler);
	}

	/**
	 * Runs every handler that matches the event's `(fromStage, toStage)` pair.
	 *
	 * - Handlers run sequentially in registration order.
	 * - A handler that throws is logged and skipped; subsequent handlers still run.
	 * - The promise resolves only after all matched handlers have settled.
	 */
	async dispatch(event: PipelineStageEvent): Promise<void> {
		const handlers = this.getHandlersFor(event.fromStage, event.toStage);
		for (const handler of handlers) {
			try {
				await handler(event);
			} catch (err) {
				logger.error('PipelineTriggerRegistry: trigger handler threw', 'PipelineTrigger', {
					error: err instanceof Error ? err.message : String(err),
					workItemId: event.workItemId,
					fromStage: event.fromStage,
					toStage: event.toStage,
				});
			}
		}
	}

	/** Returns the total number of registered entries (across all keys). */
	get size(): number {
		let count = 0;
		for (const list of this.entries.values()) {
			count += list.length;
		}
		return count;
	}
}
