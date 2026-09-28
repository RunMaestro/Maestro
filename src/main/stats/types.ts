/**
 * Stats Database Internal Types
 *
 * These types are specific to the stats database implementation.
 * Shared types (QueryEvent, AutoRunSession, etc.) remain in src/shared/stats-types.ts.
 */

import type Database from 'better-sqlite3';

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
}

/**
 * Represents a single database migration
 */
export interface Migration {
	/** Version number (must be sequential starting from 1) */
	version: number;
	/** Human-readable description of the migration */
	description: string;
	/** Function to apply the migration */
	up: (db: Database.Database) => void;
	/**
	 * Whether the migration's schema is actually present. When set, a database
	 * whose user_version already covers this migration but lacks its schema gets
	 * `up` re-applied, so `up` must be idempotent.
	 */
	isApplied?: (db: Database.Database) => boolean;
}

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
