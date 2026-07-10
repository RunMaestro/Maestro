/**
 * Sentry utilities for error reporting in the main process.
 *
 * These utilities lazily load Sentry to avoid module initialization issues
 * that can occur when importing @sentry/electron/main before app.whenReady().
 */

import { logger } from './logger';

/** Sentry severity levels */
export type SentrySeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/** Breadcrumb categories for tracking user actions before crashes */
export type BreadcrumbCategory =
	| 'session'
	| 'agent'
	| 'navigation'
	| 'ui'
	| 'ipc'
	| 'memory'
	| 'file';

/** Sentry module type for crash reporting */
export interface SentryModule {
	captureMessage: (
		message: string,
		captureContext?: { level?: SentrySeverityLevel; extra?: Record<string, unknown> }
	) => string;
	captureException: (
		exception: Error | unknown,
		captureContext?: { level?: SentrySeverityLevel; extra?: Record<string, unknown> }
	) => string;
	addBreadcrumb: (breadcrumb: {
		category?: string;
		message?: string;
		level?: SentrySeverityLevel;
		data?: Record<string, unknown>;
	}) => void;
}

/** Cached Sentry module reference */
let sentryModule: SentryModule | null = null;
let sentryLoadPromise: Promise<SentryModule | null> | null = null;
let sentryEnabled = false;

/**
 * Configure whether Sentry helpers may load and report telemetry.
 *
 * Call this once startup settings and the runtime mode are known. Passing the
 * initialized module lets helpers reuse the startup import without another
 * lookup. Disabled helpers are strict no-ops and never cold-load Sentry from a
 * user interaction path.
 */
export function configureSentry(enabled: boolean, initializedModule?: SentryModule): void {
	sentryEnabled = enabled;
	if (!enabled) {
		sentryModule = null;
		sentryLoadPromise = null;
		return;
	}
	if (initializedModule) {
		sentryModule = initializedModule;
		sentryLoadPromise = Promise.resolve(initializedModule);
	}
}

async function getSentryModule(): Promise<SentryModule | null> {
	if (!sentryEnabled) return null;
	if (sentryModule) return sentryModule;

	if (!sentryLoadPromise) {
		sentryLoadPromise = import('@sentry/electron/main')
			.then((sentry) => {
				if (!sentryEnabled) return null;
				sentryModule = sentry;
				return sentry;
			})
			.catch(() => null);
	}

	return sentryLoadPromise;
}

/**
 * Reports an exception to Sentry from the main process.
 * Lazily loads Sentry to avoid module initialization issues.
 *
 * @param error - The error to report
 * @param extra - Additional context data
 */
export async function captureException(
	error: Error | unknown,
	extra?: Record<string, unknown>
): Promise<void> {
	try {
		const sentry = await getSentryModule();
		if (!sentry) return;
		sentry.captureException(error, { extra });
	} catch {
		// Sentry not available (development mode or initialization failed)
		logger.debug('Sentry not available for exception reporting', '[Sentry]');
	}
}

/**
 * Reports a message to Sentry from the main process.
 * Lazily loads Sentry to avoid module initialization issues.
 *
 * @param message - The message to report
 * @param level - Severity level
 * @param extra - Additional context data
 */
export async function captureMessage(
	message: string,
	level: SentrySeverityLevel = 'error',
	extra?: Record<string, unknown>
): Promise<void> {
	try {
		const sentry = await getSentryModule();
		if (!sentry) return;
		sentry.captureMessage(message, { level, extra });
	} catch {
		// Sentry not available (development mode or initialization failed)
		logger.debug('Sentry not available for message reporting', '[Sentry]');
	}
}

/**
 * Adds a breadcrumb to track user actions for crash diagnostics.
 * Breadcrumbs are recorded and sent with crash reports to help identify
 * what the user was doing before a crash occurred.
 *
 * Use this at key interaction points:
 * - Session switches, creates, deletes
 * - Agent spawns/kills
 * - Heavy UI operations (document graph, large history loads)
 * - File operations
 *
 * @param category - Category of the action (session, agent, navigation, ui, ipc, memory, file)
 * @param message - Brief description of the action
 * @param data - Optional additional context data
 * @param level - Severity level (default: 'info')
 */
export async function addBreadcrumb(
	category: BreadcrumbCategory,
	message: string,
	data?: Record<string, unknown>,
	level: SentrySeverityLevel = 'info'
): Promise<void> {
	try {
		const sentry = await getSentryModule();
		if (!sentry) return;
		sentry.addBreadcrumb({
			category,
			message,
			level,
			data,
		});
	} catch {
		// Sentry not available - silently ignore
	}
}

/**
 * Memory monitoring interval ID for cleanup
 */
let memoryMonitorInterval: NodeJS.Timeout | null = null;

/**
 * Starts periodic memory monitoring that adds breadcrumbs when memory usage is high.
 * This helps diagnose crashes that may be related to memory pressure.
 *
 * @param thresholdMB - Memory threshold in MB above which to log warnings (default: 500MB)
 * @param intervalMs - Check interval in milliseconds (default: 60000 = 1 minute)
 */
export function startMemoryMonitoring(thresholdMB: number = 500, intervalMs: number = 60000): void {
	// Don't start if already running
	if (memoryMonitorInterval) {
		return;
	}

	memoryMonitorInterval = setInterval(async () => {
		const memUsage = process.memoryUsage();
		const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
		const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
		const rssMB = Math.round(memUsage.rss / 1024 / 1024);

		// Always add a breadcrumb with current memory state
		await addBreadcrumb('memory', `Memory: ${heapUsedMB}MB heap, ${rssMB}MB RSS`, {
			heapUsedMB,
			heapTotalMB,
			rssMB,
			externalMB: Math.round(memUsage.external / 1024 / 1024),
		});

		// Log warning if heap usage exceeds threshold
		if (heapUsedMB > thresholdMB) {
			logger.warn(
				`High memory usage: ${heapUsedMB}MB heap (threshold: ${thresholdMB}MB)`,
				'Memory',
				{
					heapUsedMB,
					heapTotalMB,
					rssMB,
				}
			);
			await addBreadcrumb(
				'memory',
				`HIGH MEMORY: ${heapUsedMB}MB exceeds ${thresholdMB}MB threshold`,
				{ heapUsedMB, heapTotalMB, rssMB },
				'warning'
			);
		}
	}, intervalMs);

	logger.info(
		`Memory monitoring started (threshold: ${thresholdMB}MB, interval: ${intervalMs}ms)`,
		'Memory'
	);
}
