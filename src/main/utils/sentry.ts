/**
 * Sentry utilities for error reporting in the main process.
 *
 * These utilities lazily load Sentry to avoid module initialization issues
 * that can occur when importing @sentry/electron/main before app.whenReady().
 */

import { logger } from './logger';
import { setMaestroLibErrorReporter } from '../../shared/maestro-lib/host';
import {
	agentInventoryTags,
	summarizeAgentInventory,
	summarizeWorkReasons,
	workContextTags,
} from '../../shared/sentryContext';

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
interface SentryModule {
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
	setTags: (tags: Record<string, string>) => void;
	setContext: (name: string, context: Record<string, unknown> | null) => void;
}

/** Cached Sentry module reference */
let sentryModule: SentryModule | null = null;

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
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.captureException(error, { extra });
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
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.captureMessage(message, { level, extra });
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
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.addBreadcrumb({
			category,
			message,
			level,
			data,
		});
	} catch {
		// Sentry not available - silently ignore
	}
}

/** Where scope tags go once Sentry is initialized. */
export interface SentryScopeTagSink {
	setTags: (tags: Record<string, string>) => void;
}

/** The last value of every scope tag, whether or not it has been delivered yet. */
const scopeTags: Record<string, string> = {};
let scopeTagSink: SentryScopeTagSink | null = null;

/**
 * Record context tags (Auto Run active, agent counts, ...) on the Sentry scope.
 *
 * Only tags whose value changed reach Sentry, so callers can report on every
 * state transition without per-event work. Values set before Sentry has been
 * initialized (it loads asynchronously, and not at all when crash reporting is
 * off or the build carries no DSN) are held and delivered by
 * `attachSentryScopeTags`. Nothing here imports Sentry, so a build that never
 * initializes it never loads it on this path either.
 *
 * The scope is also what `@sentry/electron` persists for native crashes, so a
 * minidump found on the next launch carries the values from the moment of the
 * crash.
 */
export function setSentryScopeTags(tags: Record<string, string>): void {
	const changed: Record<string, string> = {};
	let hasChange = false;
	for (const [key, value] of Object.entries(tags)) {
		if (scopeTags[key] === value) continue;
		scopeTags[key] = value;
		changed[key] = value;
		hasChange = true;
	}
	if (!hasChange || !scopeTagSink) return;
	try {
		scopeTagSink.setTags(changed);
	} catch {
		// Context is best-effort: a failing scope write must never break the
		// state transition that reported it.
	}
}

/**
 * Connect the initialized Sentry scope and deliver every tag recorded so far.
 * Called once from the Sentry init block in `src/main/index.ts`.
 */
export function attachSentryScopeTags(sink: SentryScopeTagSink): void {
	scopeTagSink = sink;
	if (Object.keys(scopeTags).length > 0) {
		sink.setTags({ ...scopeTags });
	}
}

/**
 * Report the configured agents (count + agent type ids) to the Sentry scope.
 * Called at startup and after every sessions write; a no-op unless the count
 * or the set of provider types changed.
 */
export function noteSentryAgentInventory(sessions: ReadonlyArray<{ toolType?: unknown }>): void {
	setSentryScopeTags(agentInventoryTags(summarizeAgentInventory(sessions)));
}

/**
 * Report background work in flight (Auto Run, busy agents, Cue, group chat),
 * derived from the power manager's block reasons.
 */
export function noteSentryWorkReasons(reasons: Iterable<string>): void {
	setSentryScopeTags(workContextTags(summarizeWorkReasons(reasons)));
}

/** Test-only: forget recorded tags and detach the sink. */
export function resetSentryScopeTagsForTests(): void {
	for (const key of Object.keys(scopeTags)) delete scopeTags[key];
	scopeTagSink = null;
}

/**
 * Set tags and a named context on the main-process scope.
 *
 * Unlike a breadcrumb or a captured event, this outlives a native crash:
 * @sentry/electron persists the main scope to disk as it changes and applies
 * the last persisted scope to the minidump it uploads on the next launch. So
 * whatever is set here describes the process at the moment it died.
 */
export async function setScopeContext(
	tags: Record<string, string>,
	contextName: string,
	context: Record<string, unknown>
): Promise<void> {
	try {
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.setTags(tags);
		sentryModule.setContext(contextName, context);
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

// maestro-lib reports through its host (src/shared/maestro-lib/host.ts).
// Registered where these reporters are defined, so any process that loads them
// has the library's crash reports go to the same place as its own.
setMaestroLibErrorReporter({ captureException, captureMessage });
