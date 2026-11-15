/**
 * Stats Database Internal Types
 *
 * These types are specific to the stats database implementation.
 * Shared types (QueryEvent, AutoRunSession, etc.) remain in src/shared/stats-types.ts.
 */

import type { SqliteMigration } from '../utils/sqlite-migrations';

/**
 * Result of a database integrity check
 */
export interface IntegrityCheckResult {
	/** Whether the database passed the integrity check */
	ok: boolean;
	/** Error messages from the integrity check (empty if ok is true) */
	errors: string[];
}

/**
 * Result of a database backup operation
 */
export interface BackupResult {
	/** Whether the backup succeeded */
	success: boolean;
	/** Path to the backup file (if success is true) */
	backupPath?: string;
	/** Error message (if success is false) */
	error?: string;
}

/**
 * Result of corruption recovery
 */
export interface CorruptionRecoveryResult {
	/** Whether recovery was performed */
	recovered: boolean;
	/** Path to the backup used for restoration (if restored from backup) */
	backupPath?: string;
	/** Whether database was restored from a backup (vs creating fresh) */
	restoredFromBackup?: boolean;
	/** Error during recovery (if any) */
	error?: string;
	/** Where the damaged database file was moved, when the move succeeded */
	corruptedPath?: string;
}

/**
 * What opening the stats database had to do, reported once to the renderer so
 * a reset is never silent: the dashboard would otherwise just show less
 * history with no explanation.
 */
export interface StatsInitializationResult {
	/** A usable database is open. */
	success: boolean;
	/** The damaged database was replaced (by a backup or a fresh file). */
	wasReset: boolean;
	/** Where the damaged database file was kept, when it could be moved aside. */
	backupPath?: string;
	/** Recovery error, when recovery itself failed. */
	error?: string;
	/** Plain-language notice for the toast. */
	userMessage?: string;
}

/**
 * Represents a single database migration. The shape is the shared runner's, so
 * a stats migration and any other database's migration are the same thing.
 */
export type Migration = SqliteMigration;

/**
 * Record of an applied migration stored in the migrations table
 */
export interface MigrationRecord {
	version: number;
	description: string;
	appliedAt: number;
	status: 'success' | 'failed';
	errorMessage?: string;
}
