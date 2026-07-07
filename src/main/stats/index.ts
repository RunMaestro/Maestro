/**
 * Stats Module
 *
 * Consolidated module for all stats database functionality:
 * - SQLite database lifecycle and integrity management
 * - Migration system for schema evolution
 * - CRUD operations for query events, auto-run sessions/tasks, and session lifecycle
 * - Aggregated statistics for the Usage Dashboard
 * - Data management (cleanup, CSV export)
 * - Singleton instance management
 * - Performance metrics API
 *
 * Usage:
 * ```typescript
 * import { getStatsDB, initializeStatsDB, closeStatsDB } from './stats';
 * import type { StatsDB } from './stats';
 * ```
 */

// ============ Types ============
export type {
	IntegrityCheckResult,
	BackupResult,
	CorruptionRecoveryResult,
	Migration,
	MigrationRecord,
} from './types';

// ============ Utilities ============
export { normalizePath } from './utils';

// ============ Core Database ============
export { StatsDB } from './stats-db';

// ============ Singleton & Lifecycle ============
export { getStatsDB, initializeStatsDB, closeStatsDB } from './singleton';

// ============ Multi-Window Telemetry ============
export {
	wireMultiWindowTelemetry,
	type MultiWindowTelemetryDependencies,
} from './multi-window-telemetry';

// ============ Performance Metrics API ============
export {
	setPerformanceLoggingEnabled,
	isPerformanceLoggingEnabled,
	getPerformanceMetrics,
	clearPerformanceMetrics,
} from './singleton';
