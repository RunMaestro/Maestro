/**
 * Cue Metrics — in-process counter aggregation for engine observability.
 *
 * Zero I/O per increment. Snapshot is plain-JSON so it can ride the IPC wire
 * unchanged. Each subsystem receives only the keys it needs via the typed
 * `increment(key, by?)` method — no shared mutable state leaks.
 *
 * Reset on engine stop so re-enable starts fresh.
 */

export interface CueMetrics {
	runsStarted: number;
	runsCompleted: number;
	runsFailed: number;
	runsTimedOut: number;
	runsStopped: number;
	eventsDropped: number;
	queueRestored: number;
	fanInTimeouts: number;
	fanInCompletions: number;
	githubPollErrors: number;
	rateLimitBackoffs: number;
	configReloads: number;
	pathTraversalsBlocked: number;
	heartbeatFailures: number;
	/** Engine start time in ms since epoch. Useful for per-minute rate calc in UI. */
	startedAt: number;
}

/** Counter keys (everything except startedAt). */
export type CueMetricKey = keyof Omit<CueMetrics, 'startedAt'>;

export interface CueMetricsCollector {
	snapshot(): CueMetrics;
	increment(key: CueMetricKey, by?: number): void;
	reset(): void;
}

function zero(): CueMetrics {
	return {
		runsStarted: 0,
		runsCompleted: 0,
		runsFailed: 0,
		runsTimedOut: 0,
		runsStopped: 0,
		eventsDropped: 0,
		queueRestored: 0,
		fanInTimeouts: 0,
		fanInCompletions: 0,
		githubPollErrors: 0,
		rateLimitBackoffs: 0,
		configReloads: 0,
		pathTraversalsBlocked: 0,
		heartbeatFailures: 0,
		startedAt: Date.now(),
	};
}

export function createCueMetrics(): CueMetricsCollector {
	let state = zero();

	return {
		snapshot(): CueMetrics {
			return { ...state };
		},
		increment(key, by = 1): void {
			state[key] += by;
		},
		reset(): void {
			state = zero();
		},
	};
}
