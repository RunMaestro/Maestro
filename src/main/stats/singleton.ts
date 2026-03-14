/**
 * Stats Database Singleton Management & Performance Metrics API
 *
 * Provides the global StatsDB instance and performance monitoring utilities.
 */

import { StatsDB } from './stats-db';
import { perfMetrics, LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';

// ============================================================================
// Singleton Instance
// ============================================================================

let statsDbInstance: StatsDB | null = null;

/**
 * Get the singleton StatsDB instance
 */
export function getStatsDB(): StatsDB {
	if (!statsDbInstance) {
		statsDbInstance = new StatsDB();
	}
	return statsDbInstance;
}

/**
 * Initialize the stats database (call on app ready)
 */
export async function initializeStatsDB(): Promise<void> {
	const db = getStatsDB();
	await db.initialize();
}

/**
 * Close the stats database (call on app quit)
 */
export function closeStatsDB(): void {
	if (statsDbInstance) {
		statsDbInstance.close();
		statsDbInstance = null;
	}
}

// ============================================================================
// Performance Metrics API
// ============================================================================

/**
 * Enable or disable performance metrics logging for StatsDB operations.
 *
 * When enabled, detailed timing information is logged at debug level for:
 * - Database queries (getAggregatedStats, getQueryEvents, etc.)
 * - Individual SQL operations (totals, byAgent, bySource, byDay queries)
 *
 * Performance warnings are always logged (even when metrics are disabled)
 * when operations exceed defined thresholds.
 *
 * @param enabled - Whether to enable performance metrics logging
 */
export function setPerformanceLoggingEnabled(enabled: boolean): void {
	perfMetrics.setEnabled(enabled);
	logger.info(`Performance metrics logging ${enabled ? 'enabled' : 'disabled'}`, LOG_CONTEXT);
}

/**
 * Check if performance metrics logging is currently enabled.
 */
export function isPerformanceLoggingEnabled(): boolean {
	return perfMetrics.isEnabled();
}

/**
 * Get collected performance metrics for analysis.
 *
 * Returns the last 100 recorded metrics (when enabled).
 */
export function getPerformanceMetrics() {
	return perfMetrics.getMetrics();
}

/**
 * Clear collected performance metrics.
 */
export function clearPerformanceMetrics(): void {
	perfMetrics.clearMetrics();
}
