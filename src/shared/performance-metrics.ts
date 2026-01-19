/**
 * Performance Metrics Logging Utility
 *
 * Provides optional performance tracking for debugging and optimization.
 * Disabled by default - must be explicitly enabled via settings.
 *
 * Usage:
 * ```typescript
 * // Main process:
 * const perf = new PerformanceMetrics('StatsDB', logger.debug);
 * perf.mark('query_start');
 * // ... do work ...
 * perf.measure('query_duration', 'query_start');
 *
 * // Renderer process:
 * const perf = new PerformanceMetrics('DocumentGraph', console.debug);
 * const startTime = perf.start();
 * // ... do work ...
 * perf.end(startTime, 'buildGraph');
 * ```
 *
 * All metrics are logged at debug level and only when enabled.
 * Enable via settings: performanceMetricsEnabled: true
 */

/**
 * Performance metric entry recorded during operations
 */
export interface PerformanceMetric {
	/** Name of the metric/operation */
	name: string;
	/** Duration in milliseconds */
	durationMs: number;
	/** Timestamp when the metric was recorded */
	timestamp: number;
	/** Context/component that recorded the metric */
	context: string;
	/** Optional additional details */
	details?: Record<string, unknown>;
}

/**
 * Logger function type for outputting performance metrics
 */
export type PerformanceLogger = (message: string, context?: string, data?: unknown) => void;

/**
 * Performance metrics collector and logger.
 *
 * This class provides a simple API for measuring and logging performance
 * metrics during operations. It's designed to have minimal overhead when
 * disabled, and provide detailed timing information when enabled.
 *
 * Key design decisions:
 * - Uses high-resolution timing (performance.now() in browser, process.hrtime() in Node)
 * - All metrics are logged at debug level to avoid noise in production
 * - Can be globally enabled/disabled via the `enabled` flag
 * - Supports both mark-and-measure pattern and simple start/end pattern
 */
export class PerformanceMetrics {
	/** Context name for logging (e.g., 'StatsDB', 'DocumentGraph') */
	private context: string;

	/** Logger function to output metrics */
	private log: PerformanceLogger;

	/** Whether performance logging is enabled */
	private enabled: boolean;

	/** Named marks for mark-and-measure pattern */
	private marks: Map<string, number> = new Map();

	/** Collected metrics (kept in memory for debugging) */
	private metrics: PerformanceMetric[] = [];

	/** Maximum number of metrics to keep in memory */
	private maxMetrics = 100;

	/**
	 * Create a new performance metrics collector.
	 *
	 * @param context - Name of the component/module for logging context
	 * @param log - Logger function to output metrics (defaults to console.debug)
	 * @param enabled - Whether to enable metrics logging (defaults to false)
	 */
	constructor(context: string, log: PerformanceLogger = console.debug, enabled = false) {
		this.context = context;
		this.log = log;
		this.enabled = enabled;
	}

	/**
	 * Enable or disable performance metrics logging.
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * Check if performance metrics logging is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Get the current high-resolution timestamp.
	 * Uses performance.now() for sub-millisecond precision.
	 *
	 * @returns Timestamp in milliseconds
	 */
	now(): number {
		// Use performance.now() for high-resolution timing if available
		if (typeof performance !== 'undefined' && performance.now) {
			return performance.now();
		}
		// Fallback to Date.now() (less precise but works everywhere)
		return Date.now();
	}

	/**
	 * Start a timing measurement.
	 * Returns the start time which should be passed to end().
	 *
	 * @returns Start timestamp for passing to end()
	 */
	start(): number {
		return this.now();
	}

	/**
	 * End a timing measurement and log the result.
	 *
	 * @param startTime - Start timestamp from start()
	 * @param name - Name of the operation being measured
	 * @param details - Optional additional details to log
	 * @returns Duration in milliseconds
	 */
	end(startTime: number, name: string, details?: Record<string, unknown>): number {
		const endTime = this.now();
		const durationMs = endTime - startTime;

		if (this.enabled) {
			this.recordMetric(name, durationMs, details);
		}

		return durationMs;
	}

	/**
	 * Create a named mark for later measurement.
	 * Use with measure() for complex timing scenarios.
	 *
	 * @param name - Unique name for this mark
	 */
	mark(name: string): void {
		if (this.enabled) {
			this.marks.set(name, this.now());
		}
	}

	/**
	 * Measure the time between a mark and now, or between two marks.
	 *
	 * @param name - Name for this measurement
	 * @param startMark - Name of the start mark
	 * @param endMark - Optional name of the end mark (defaults to now)
	 * @param details - Optional additional details to log
	 * @returns Duration in milliseconds, or 0 if marks not found
	 */
	measure(
		name: string,
		startMark: string,
		endMark?: string,
		details?: Record<string, unknown>
	): number {
		if (!this.enabled) {
			return 0;
		}

		const startTime = this.marks.get(startMark);
		if (startTime === undefined) {
			this.log(`Performance mark not found: ${startMark}`, `[${this.context}]`);
			return 0;
		}

		const endTime = endMark ? this.marks.get(endMark) : this.now();
		if (endTime === undefined) {
			this.log(`Performance mark not found: ${endMark}`, `[${this.context}]`);
			return 0;
		}

		const durationMs = endTime - startTime;
		this.recordMetric(name, durationMs, details);

		return durationMs;
	}

	/**
	 * Clear a named mark to free memory.
	 *
	 * @param name - Name of the mark to clear
	 */
	clearMark(name: string): void {
		this.marks.delete(name);
	}

	/**
	 * Clear all marks.
	 */
	clearMarks(): void {
		this.marks.clear();
	}

	/**
	 * Record a metric with the given name and duration.
	 * Internal method called by end() and measure().
	 *
	 * @param name - Name of the metric
	 * @param durationMs - Duration in milliseconds
	 * @param details - Optional additional details
	 */
	private recordMetric(name: string, durationMs: number, details?: Record<string, unknown>): void {
		const metric: PerformanceMetric = {
			name,
			durationMs,
			timestamp: Date.now(),
			context: this.context,
			details,
		};

		// Store metric in memory
		this.metrics.push(metric);

		// Trim if over limit
		if (this.metrics.length > this.maxMetrics) {
			this.metrics = this.metrics.slice(-this.maxMetrics);
		}

		// Log the metric
		const formattedDuration = durationMs.toFixed(2);
		const detailsStr = details ? ` ${JSON.stringify(details)}` : '';
		this.log(`[PERF] ${name}: ${formattedDuration}ms${detailsStr}`, `[${this.context}]`);
	}

	/**
	 * Get all recorded metrics.
	 *
	 * @returns Array of recorded metrics
	 */
	getMetrics(): PerformanceMetric[] {
		return [...this.metrics];
	}

	/**
	 * Get metrics filtered by name pattern.
	 *
	 * @param pattern - Name pattern to filter by (supports simple glob with *)
	 * @returns Filtered metrics
	 */
	getMetricsByName(pattern: string): PerformanceMetric[] {
		const regex = new RegExp(pattern.replace(/\*/g, '.*'));
		return this.metrics.filter((m) => regex.test(m.name));
	}

	/**
	 * Get the average duration for metrics matching a name pattern.
	 *
	 * @param pattern - Name pattern to filter by
	 * @returns Average duration in milliseconds, or 0 if no matches
	 */
	getAverageDuration(pattern: string): number {
		const matching = this.getMetricsByName(pattern);
		if (matching.length === 0) return 0;

		const total = matching.reduce((sum, m) => sum + m.durationMs, 0);
		return total / matching.length;
	}

	/**
	 * Clear all recorded metrics.
	 */
	clearMetrics(): void {
		this.metrics = [];
	}

	/**
	 * Create a timed wrapper for an async function.
	 * Automatically measures the execution time and logs it.
	 *
	 * @param name - Name for the timing measurement
	 * @param fn - Async function to time
	 * @param details - Optional details to include in the log
	 * @returns Wrapped function that times execution
	 */
	timeAsync<T>(name: string, fn: () => Promise<T>, details?: Record<string, unknown>): Promise<T> {
		const startTime = this.start();
		return fn().finally(() => {
			this.end(startTime, name, details);
		});
	}

	/**
	 * Create a timed wrapper for a sync function.
	 * Automatically measures the execution time and logs it.
	 *
	 * @param name - Name for the timing measurement
	 * @param fn - Sync function to time
	 * @param details - Optional details to include in the log
	 * @returns Result of the function
	 */
	timeSync<T>(name: string, fn: () => T, details?: Record<string, unknown>): T {
		const startTime = this.start();
		try {
			return fn();
		} finally {
			this.end(startTime, name, details);
		}
	}
}

/**
 * Create a no-op performance metrics instance.
 * Useful for testing or when performance logging is not needed.
 */
export function createNoOpMetrics(): PerformanceMetrics {
	return new PerformanceMetrics('noop', () => {}, false);
}

/**
 * Format duration for display.
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted string (e.g., "123.45ms" or "1.23s")
 */
export function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs.toFixed(2)}ms`;
	}
	return `${(durationMs / 1000).toFixed(2)}s`;
}

/**
 * Performance thresholds for common operations.
 * Used for logging warnings when operations exceed expected durations.
 */
export const PERFORMANCE_THRESHOLDS = {
	/** Dashboard data load should be under 200ms */
	DASHBOARD_LOAD: 200,
	/** Individual SQL query should be under 50ms */
	SQL_QUERY: 50,
	/** Graph build should be under 1000ms for <100 nodes */
	GRAPH_BUILD_SMALL: 1000,
	/** Graph build should be under 3000ms for <500 nodes */
	GRAPH_BUILD_LARGE: 3000,
	/** Layout algorithm should complete under 500ms */
	LAYOUT_ALGORITHM: 500,
	/** React render should be under 16ms for 60fps */
	REACT_RENDER: 16,
} as const;
