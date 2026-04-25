/**
 * Common interface for every Cue trigger source.
 *
 * A trigger source owns the *external* mechanism for one subscription —
 * a setInterval timer, a chokidar watcher, a GitHub poller, etc. — and emits
 * `CueEvent`s through the context-supplied `emit` callback whenever the trigger
 * fires. Each source is responsible for its own start/stop lifecycle so the
 * runtime never has to know whether it owns timers, watchers, or pollers.
 *
 * The runtime keeps an array of `CueTriggerSource` per session and calls
 * `stop()` on each one when the session is torn down. Replaces the previous
 * `state.timers: Timer[]` + `state.watchers: (() => void)[]` parallel arrays.
 */

import type { MainLogLevel } from '../../../shared/logger-types';
import type { SessionInfo } from '../../../shared/types';
import type { CueEvent, CueSubscription } from '../cue-types';
import type { CueSessionRegistry } from '../cue-session-registry';

/**
 * The minimum surface a trigger source must expose. The runtime never calls
 * anything else on a source — keeping the interface tight ensures that adding
 * a new source type is mechanical (define start/stop/nextTriggerAt + register
 * with the factory).
 */
export interface CueTriggerSource {
	/**
	 * Start the source. Must be idempotent — the runtime currently calls
	 * start() exactly once per source instance, but defensive idempotency keeps
	 * the contract simple if that ever changes.
	 */
	start(): void;

	/**
	 * Stop the source and release all underlying resources (clear timers,
	 * close watchers, cancel polls, etc.). Must be idempotent.
	 */
	stop(): void;

	/**
	 * Returns ms-since-epoch of the next expected fire time, or `null` if the
	 * source is not time-based or its next fire is unknown (e.g. file watchers
	 * fire on demand). The query service uses this for the "next trigger" UI
	 * column.
	 */
	nextTriggerAt(): number | null;
}

/**
 * Context passed to every trigger source factory. Sources should treat this
 * as immutable for the lifetime of the source.
 *
 * `emit` is the *post-filter dispatch* callback. Each source is responsible
 * for calling {@link passesFilter} (from `cue-trigger-filter`) before invoking
 * `emit` so that filter logic stays in exactly one place.
 */
export interface CueTriggerSourceContext {
	session: SessionInfo;
	subscription: CueSubscription;
	registry: CueSessionRegistry;
	enabled: () => boolean;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	/**
	 * Dispatch an event for this source's subscription. The runtime wires this
	 * to filter check + state.lastTriggered update + dispatchSubscription.
	 * Sources should call this whenever the trigger fires; they should NOT
	 * touch session state directly.
	 */
	emit: (event: CueEvent) => void;
}
