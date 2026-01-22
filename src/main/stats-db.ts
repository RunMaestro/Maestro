/**
 * Stats Database Service
 *
 * SQLite-based storage for tracking all AI interactions across Maestro.
 * Uses better-sqlite3 for synchronous, fast database operations.
 *
 * Database location: ~/Library/Application Support/Maestro/stats.db
 * (platform-appropriate path resolved via app.getPath('userData'))
 *
 * ## Migration System
 *
 * This module uses a versioned migration system to manage schema changes:
 *
 * 1. **Version Tracking**: Uses SQLite's `user_version` pragma for fast version checks
 * 2. **Migrations Table**: Stores detailed migration history with timestamps and status
 * 3. **Sequential Execution**: Migrations run in order, skipping already-applied ones
 *
 * ### Adding New Migrations
 *
 * To add a new migration:
 * 1. Create a new migration function following the pattern: `migrateVN()`
 * 2. Add it to the `MIGRATIONS` array with version number and description
 * 3. Update `STATS_DB_VERSION` in `../shared/stats-types.ts`
 *
 * Example:
 * ```typescript
 * // In MIGRATIONS array:
 * { version: 2, description: 'Add token_count column', up: () => this.migrateV2() }
 *
 * // Migration function:
 * private migrateV2(): void {
 *   this.db.prepare('ALTER TABLE query_events ADD COLUMN token_count INTEGER').run();
 * }
 * ```
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { logger } from './utils/logger';
import {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
	StatsAggregation,
} from '../shared/stats-types';
import { PerformanceMetrics, PERFORMANCE_THRESHOLDS } from '../shared/performance-metrics';

const LOG_CONTEXT = '[StatsDB]';

/**
 * Performance metrics logger for StatsDB operations.
 *
 * Disabled by default - enable via setPerformanceLoggingEnabled(true).
 * Logs at debug level through the main process logger.
 */
const perfMetrics = new PerformanceMetrics(
	'StatsDB',
	(message, context) => logger.debug(message, context ?? LOG_CONTEXT),
	false // Disabled by default - enable for debugging
);

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
	/** Path to the backup of the corrupted database */
	backupPath?: string;
	/** Error during recovery (if any) */
	error?: string;
}

// ============================================================================
// Migration System Types
// ============================================================================

/**
 * Represents a single database migration
 */
export interface Migration {
	/** Version number (must be sequential starting from 1) */
	version: number;
	/** Human-readable description of the migration */
	description: string;
	/** Function to apply the migration */
	up: () => void;
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

/**
 * SQL for creating the migrations tracking table
 */
const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
    error_message TEXT
  )
`;

/**
 * Generate a unique ID for database entries
 */
function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get timestamp for start of time range
 */
function getTimeRangeStart(range: StatsTimeRange): number {
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;

	switch (range) {
		case 'day':
			return now - day;
		case 'week':
			return now - 7 * day;
		case 'month':
			return now - 30 * day;
		case 'year':
			return now - 365 * day;
		case 'all':
			return 0;
	}
}

/**
 * Normalize file paths to use forward slashes consistently across platforms.
 *
 * This ensures that paths stored in the database use a consistent format
 * regardless of the operating system, enabling cross-platform data portability
 * and consistent filtering by project path.
 *
 * - Converts Windows-style backslashes to forward slashes
 * - Preserves UNC paths (\\server\share → //server/share)
 * - Handles null/undefined by returning null
 *
 * @param filePath - The file path to normalize (may be Windows or Unix style)
 * @returns The normalized path with forward slashes, or null if input is null/undefined
 */
export function normalizePath(filePath: string | null | undefined): string | null {
	if (filePath == null) {
		return null;
	}
	// Replace all backslashes with forward slashes
	return filePath.replace(/\\/g, '/');
}

/**
 * SQL for creating query_events table
 */
const CREATE_QUERY_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS query_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('user', 'auto')),
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    project_path TEXT,
    tab_id TEXT
  )
`;

const CREATE_QUERY_EVENTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_query_start_time ON query_events(start_time);
  CREATE INDEX IF NOT EXISTS idx_query_agent_type ON query_events(agent_type);
  CREATE INDEX IF NOT EXISTS idx_query_source ON query_events(source);
  CREATE INDEX IF NOT EXISTS idx_query_session ON query_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_query_project_path ON query_events(project_path);
  CREATE INDEX IF NOT EXISTS idx_query_agent_time ON query_events(agent_type, start_time)
`;

/**
 * SQL for creating auto_run_sessions table
 */
const CREATE_AUTO_RUN_SESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS auto_run_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    document_path TEXT,
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    tasks_total INTEGER,
    tasks_completed INTEGER,
    project_path TEXT
  )
`;

const CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auto_session_start ON auto_run_sessions(start_time)
`;

/**
 * SQL for creating auto_run_tasks table
 */
const CREATE_AUTO_RUN_TASKS_SQL = `
  CREATE TABLE IF NOT EXISTS auto_run_tasks (
    id TEXT PRIMARY KEY,
    auto_run_session_id TEXT NOT NULL REFERENCES auto_run_sessions(id),
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    task_index INTEGER NOT NULL,
    task_content TEXT,
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    success INTEGER NOT NULL CHECK(success IN (0, 1))
  )
`;

const CREATE_AUTO_RUN_TASKS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_task_auto_session ON auto_run_tasks(auto_run_session_id);
  CREATE INDEX IF NOT EXISTS idx_task_start ON auto_run_tasks(start_time)
`;

/**
 * SQL for creating session_lifecycle table
 */
const CREATE_SESSION_LIFECYCLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_lifecycle (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    agent_type TEXT NOT NULL,
    project_path TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    duration INTEGER,
    is_remote INTEGER
  )
`;

const CREATE_SESSION_LIFECYCLE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_created_at ON session_lifecycle(created_at);
  CREATE INDEX IF NOT EXISTS idx_session_agent_type ON session_lifecycle(agent_type)
`;

/**
 * StatsDB manages the SQLite database for usage statistics.
 * Implements singleton pattern for database connection management.
 */
export class StatsDB {
	private db: Database.Database | null = null;
	private dbPath: string;
	private initialized = false;

	/**
	 * Registry of all database migrations.
	 * Migrations must be sequential starting from version 1.
	 * Each migration is run exactly once and recorded in the _migrations table.
	 */
	private getMigrations(): Migration[] {
		return [
			{
				version: 1,
				description: 'Initial schema: query_events, auto_run_sessions, auto_run_tasks tables',
				up: () => this.migrateV1(),
			},
			{
				version: 2,
				description: 'Add is_remote column to query_events for tracking SSH sessions',
				up: () => this.migrateV2(),
			},
			{
				version: 3,
				description: 'Add session_lifecycle table for tracking session creation and closure',
				up: () => this.migrateV3(),
			},
		];
	}

	constructor() {
		this.dbPath = path.join(app.getPath('userData'), 'stats.db');
	}

	/**
	 * Initialize the database - create file, tables, and indexes.
	 * Also runs VACUUM if the database exceeds 100MB to maintain performance.
	 *
	 * If the database is corrupted, this method will:
	 * 1. Backup the corrupted database file
	 * 2. Delete the corrupted file and any associated WAL/SHM files
	 * 3. Create a fresh database
	 *
	 * The backup is preserved for potential manual recovery with specialized tools.
	 */
	initialize(): void {
		if (this.initialized) {
			return;
		}

		try {
			// Ensure the directory exists
			const dir = path.dirname(this.dbPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Check if database file exists
			const dbExists = fs.existsSync(this.dbPath);

			if (dbExists) {
				// Open with corruption handling for existing databases
				const db = this.openWithCorruptionHandling();
				if (!db) {
					throw new Error('Failed to open or recover database');
				}
				this.db = db;
			} else {
				// Create new database
				this.db = new Database(this.dbPath);
			}

			// Enable WAL mode for better concurrent access
			this.db.pragma('journal_mode = WAL');

			// Run migrations
			this.runMigrations();

			this.initialized = true;
			logger.info(`Stats database initialized at ${this.dbPath}`, LOG_CONTEXT);

			// Schedule VACUUM to run weekly instead of on every startup
			// This avoids blocking the main process during initialization
			this.vacuumIfNeededWeekly();
		} catch (error) {
			logger.error(`Failed to initialize stats database: ${error}`, LOG_CONTEXT);
			throw error;
		}
	}

	// ============================================================================
	// Migration System
	// ============================================================================

	/**
	 * Run all pending database migrations.
	 *
	 * The migration system:
	 * 1. Creates the _migrations table if it doesn't exist
	 * 2. Gets the current schema version from user_version pragma
	 * 3. Runs each pending migration in a transaction
	 * 4. Records each migration in the _migrations table
	 * 5. Updates the user_version pragma
	 *
	 * If a migration fails, it is recorded as 'failed' with an error message,
	 * and the error is re-thrown to prevent the app from starting with an
	 * inconsistent database state.
	 */
	private runMigrations(): void {
		if (!this.db) throw new Error('Database not initialized');

		// Create migrations table (this is the only table created outside the migration system)
		this.db.prepare(CREATE_MIGRATIONS_TABLE_SQL).run();

		// Get current version (0 if fresh database)
		const versionResult = this.db.pragma('user_version') as Array<{ user_version: number }>;
		const currentVersion = versionResult[0]?.user_version ?? 0;

		const migrations = this.getMigrations();
		const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

		if (pendingMigrations.length === 0) {
			logger.debug(`Database is up to date (version ${currentVersion})`, LOG_CONTEXT);
			return;
		}

		// Sort by version to ensure sequential execution
		pendingMigrations.sort((a, b) => a.version - b.version);

		logger.info(
			`Running ${pendingMigrations.length} pending migration(s) (current version: ${currentVersion})`,
			LOG_CONTEXT
		);

		for (const migration of pendingMigrations) {
			this.applyMigration(migration);
		}
	}

	/**
	 * Apply a single migration within a transaction.
	 * Records the migration in the _migrations table with success/failure status.
	 */
	private applyMigration(migration: Migration): void {
		if (!this.db) throw new Error('Database not initialized');

		const startTime = Date.now();
		logger.info(`Applying migration v${migration.version}: ${migration.description}`, LOG_CONTEXT);

		try {
			// Run migration in a transaction for atomicity
			const runMigration = this.db.transaction(() => {
				// Execute the migration
				migration.up();

				// Record success in _migrations table
				this.db!.prepare(
					`
          INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
          VALUES (?, ?, ?, 'success', NULL)
        `
				).run(migration.version, migration.description, Date.now());

				// Update user_version pragma
				this.db!.pragma(`user_version = ${migration.version}`);
			});

			runMigration();

			const duration = Date.now() - startTime;
			logger.info(`Migration v${migration.version} completed in ${duration}ms`, LOG_CONTEXT);
		} catch (error) {
			// Record failure in _migrations table (outside transaction since it was rolled back)
			const errorMessage = error instanceof Error ? error.message : String(error);

			this.db
				.prepare(
					`
        INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
        VALUES (?, ?, ?, 'failed', ?)
      `
				)
				.run(migration.version, migration.description, Date.now(), errorMessage);

			logger.error(`Migration v${migration.version} failed: ${errorMessage}`, LOG_CONTEXT);

			// Re-throw to prevent app from starting with inconsistent state
			throw error;
		}
	}

	/**
	 * Get the list of applied migrations from the _migrations table.
	 * Useful for debugging and diagnostics.
	 */
	getMigrationHistory(): MigrationRecord[] {
		if (!this.db) throw new Error('Database not initialized');

		// Check if _migrations table exists
		const tableExists = this.db
			.prepare(
				`
      SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'
    `
			)
			.get();

		if (!tableExists) {
			return [];
		}

		const rows = this.db
			.prepare(
				`
      SELECT version, description, applied_at, status, error_message
      FROM _migrations
      ORDER BY version ASC
    `
			)
			.all() as Array<{
			version: number;
			description: string;
			applied_at: number;
			status: 'success' | 'failed';
			error_message: string | null;
		}>;

		return rows.map((row) => ({
			version: row.version,
			description: row.description,
			appliedAt: row.applied_at,
			status: row.status,
			errorMessage: row.error_message ?? undefined,
		}));
	}

	/**
	 * Get the current database schema version.
	 */
	getCurrentVersion(): number {
		if (!this.db) throw new Error('Database not initialized');

		const versionResult = this.db.pragma('user_version') as Array<{ user_version: number }>;
		return versionResult[0]?.user_version ?? 0;
	}

	/**
	 * Get the target version (highest version in migrations registry).
	 */
	getTargetVersion(): number {
		const migrations = this.getMigrations();
		if (migrations.length === 0) return 0;
		return Math.max(...migrations.map((m) => m.version));
	}

	/**
	 * Check if any migrations are pending.
	 */
	hasPendingMigrations(): boolean {
		return this.getCurrentVersion() < this.getTargetVersion();
	}

	// ============================================================================
	// Individual Migration Functions
	// ============================================================================

	/**
	 * Migration v1: Initial schema creation
	 *
	 * Creates the core tables for tracking AI interactions:
	 * - query_events: Individual AI query/response cycles
	 * - auto_run_sessions: Batch processing runs
	 * - auto_run_tasks: Individual tasks within batch runs
	 */
	private migrateV1(): void {
		if (!this.db) throw new Error('Database not initialized');

		// Create query_events table and indexes
		this.db.prepare(CREATE_QUERY_EVENTS_SQL).run();
		for (const indexSql of CREATE_QUERY_EVENTS_INDEXES_SQL.split(';').filter((s) => s.trim())) {
			this.db.prepare(indexSql).run();
		}

		// Create auto_run_sessions table and indexes
		this.db.prepare(CREATE_AUTO_RUN_SESSIONS_SQL).run();
		for (const indexSql of CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL.split(';').filter((s) =>
			s.trim()
		)) {
			this.db.prepare(indexSql).run();
		}

		// Create auto_run_tasks table and indexes
		this.db.prepare(CREATE_AUTO_RUN_TASKS_SQL).run();
		for (const indexSql of CREATE_AUTO_RUN_TASKS_INDEXES_SQL.split(';').filter((s) => s.trim())) {
			this.db.prepare(indexSql).run();
		}

		logger.debug('Created stats database tables and indexes', LOG_CONTEXT);
	}

	/**
	 * Migration v2: Add is_remote column for SSH session tracking
	 *
	 * Adds a new column to track whether queries were executed on remote SSH sessions
	 * vs local sessions. This enables usage analytics broken down by session location.
	 */
	private migrateV2(): void {
		if (!this.db) throw new Error('Database not initialized');

		// Add is_remote column (0 = local, 1 = remote, NULL = unknown/legacy data)
		this.db.prepare('ALTER TABLE query_events ADD COLUMN is_remote INTEGER').run();

		// Add index for efficient filtering by location
		this.db
			.prepare('CREATE INDEX IF NOT EXISTS idx_query_is_remote ON query_events(is_remote)')
			.run();

		logger.debug('Added is_remote column to query_events table', LOG_CONTEXT);
	}

	/**
	 * Migration v3: Add session_lifecycle table for tracking session creation and closure
	 *
	 * This enables tracking of unique sessions launched over time, session duration,
	 * and session lifecycle metrics in the Usage Dashboard.
	 */
	private migrateV3(): void {
		if (!this.db) throw new Error('Database not initialized');

		// Create session_lifecycle table
		this.db.prepare(CREATE_SESSION_LIFECYCLE_SQL).run();

		// Create indexes
		for (const indexSql of CREATE_SESSION_LIFECYCLE_INDEXES_SQL.split(';').filter((s) =>
			s.trim()
		)) {
			this.db.prepare(indexSql).run();
		}

		logger.debug('Created session_lifecycle table', LOG_CONTEXT);
	}

	// ============================================================================
	// Database Lifecycle
	// ============================================================================

	/**
	 * Close the database connection
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
			this.initialized = false;
			logger.info('Stats database closed', LOG_CONTEXT);
		}
	}

	/**
	 * Check if database is initialized and ready
	 */
	isReady(): boolean {
		return this.initialized && this.db !== null;
	}

	/**
	 * Get the database file path
	 */
	getDbPath(): string {
		return this.dbPath;
	}

	/**
	 * Get the database file size in bytes.
	 * Returns 0 if the file doesn't exist or can't be read.
	 */
	getDatabaseSize(): number {
		try {
			const stats = fs.statSync(this.dbPath);
			return stats.size;
		} catch {
			return 0;
		}
	}

	/**
	 * Run VACUUM on the database to reclaim unused space and optimize structure.
	 *
	 * VACUUM rebuilds the database file, repacking it into a minimal amount of disk space.
	 * This is useful after many deletes or updates that leave fragmented space.
	 *
	 * Note: VACUUM requires exclusive access and may take a few seconds for large databases.
	 * It also temporarily requires up to 2x the database size in disk space.
	 *
	 * @returns Object with success status, bytes freed, and any error message
	 */
	vacuum(): { success: boolean; bytesFreed: number; error?: string } {
		if (!this.db) {
			return { success: false, bytesFreed: 0, error: 'Database not initialized' };
		}

		try {
			const sizeBefore = this.getDatabaseSize();
			logger.info(
				`Starting VACUUM (current size: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB)`,
				LOG_CONTEXT
			);

			// Use prepare().run() for VACUUM - consistent with better-sqlite3 patterns
			this.db.prepare('VACUUM').run();

			const sizeAfter = this.getDatabaseSize();
			const bytesFreed = sizeBefore - sizeAfter;

			logger.info(
				`VACUUM completed: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB → ${(sizeAfter / 1024 / 1024).toFixed(2)} MB (freed ${(bytesFreed / 1024 / 1024).toFixed(2)} MB)`,
				LOG_CONTEXT
			);

			return { success: true, bytesFreed };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`VACUUM failed: ${errorMessage}`, LOG_CONTEXT);
			return { success: false, bytesFreed: 0, error: errorMessage };
		}
	}

	/**
	 * Conditionally vacuum the database if it exceeds a size threshold.
	 *
	 * This method is designed to be called on app startup to maintain database health.
	 * It only runs VACUUM if the database exceeds the specified threshold (default: 100MB),
	 * avoiding unnecessary work for smaller databases.
	 *
	 * @param thresholdBytes - Size threshold in bytes (default: 100MB = 104857600 bytes)
	 * @returns Object with vacuumed flag, database size, and vacuum result if performed
	 */
	vacuumIfNeeded(thresholdBytes: number = 100 * 1024 * 1024): {
		vacuumed: boolean;
		databaseSize: number;
		result?: { success: boolean; bytesFreed: number; error?: string };
	} {
		const databaseSize = this.getDatabaseSize();

		if (databaseSize < thresholdBytes) {
			logger.debug(
				`Database size (${(databaseSize / 1024 / 1024).toFixed(2)} MB) below vacuum threshold (${(thresholdBytes / 1024 / 1024).toFixed(2)} MB), skipping VACUUM`,
				LOG_CONTEXT
			);
			return { vacuumed: false, databaseSize };
		}

		logger.info(
			`Database size (${(databaseSize / 1024 / 1024).toFixed(2)} MB) exceeds vacuum threshold (${(thresholdBytes / 1024 / 1024).toFixed(2)} MB), running VACUUM`,
			LOG_CONTEXT
		);

		const result = this.vacuum();
		return { vacuumed: true, databaseSize, result };
	}

	/**
	 * Run VACUUM only if it hasn't been run in the last 7 days.
	 *
	 * This avoids blocking startup on every app launch. The last vacuum timestamp
	 * is stored in a separate file alongside the database.
	 *
	 * @param intervalMs - Minimum time between vacuums (default: 7 days)
	 */
	private vacuumIfNeededWeekly(intervalMs: number = 7 * 24 * 60 * 60 * 1000): void {
		const vacuumTimestampPath = path.join(path.dirname(this.dbPath), 'stats-vacuum-timestamp');

		try {
			// Check when we last ran VACUUM
			let lastVacuum = 0;
			if (fs.existsSync(vacuumTimestampPath)) {
				const content = fs.readFileSync(vacuumTimestampPath, 'utf-8').trim();
				lastVacuum = parseInt(content, 10) || 0;
			}

			const now = Date.now();
			const timeSinceLastVacuum = now - lastVacuum;

			if (timeSinceLastVacuum < intervalMs) {
				const daysRemaining = ((intervalMs - timeSinceLastVacuum) / (24 * 60 * 60 * 1000)).toFixed(
					1
				);
				logger.debug(
					`Skipping VACUUM (last run ${((now - lastVacuum) / (24 * 60 * 60 * 1000)).toFixed(1)} days ago, next in ${daysRemaining} days)`,
					LOG_CONTEXT
				);
				return;
			}

			// Run VACUUM if database is large enough
			const result = this.vacuumIfNeeded();

			if (result.vacuumed) {
				// Update timestamp only if we actually ran VACUUM
				fs.writeFileSync(vacuumTimestampPath, String(now), 'utf-8');
				logger.info('Updated VACUUM timestamp for weekly scheduling', LOG_CONTEXT);
			}
		} catch (error) {
			// Non-fatal - log and continue
			logger.warn(`Failed to check/update VACUUM schedule: ${error}`, LOG_CONTEXT);
		}
	}

	// ============================================================================
	// Database Integrity & Corruption Handling
	// ============================================================================

	/**
	 * Check the integrity of the database using SQLite's PRAGMA integrity_check.
	 *
	 * This runs a full integrity check on the database, verifying that:
	 * - All pages are accessible
	 * - All indexes are properly formed
	 * - All constraints are satisfied
	 *
	 * For large databases this may take a few seconds.
	 *
	 * @returns Object with ok flag and any error messages
	 */
	checkIntegrity(): IntegrityCheckResult {
		if (!this.db) {
			return { ok: false, errors: ['Database not initialized'] };
		}

		try {
			// PRAGMA integrity_check returns 'ok' if the database is valid,
			// otherwise it returns a list of error messages
			const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;

			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return { ok: true, errors: [] };
			}

			// Collect all error messages
			const errors = result.map((row) => row.integrity_check);
			return { ok: false, errors };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { ok: false, errors: [errorMessage] };
		}
	}

	/**
	 * Create a backup of the current database file.
	 *
	 * The backup is created with a timestamp suffix to avoid overwriting previous backups.
	 * Format: stats.db.backup.{timestamp}
	 *
	 * @returns Object with success flag, backup path, and any error message
	 */
	backupDatabase(): BackupResult {
		try {
			// Check if the database file exists
			if (!fs.existsSync(this.dbPath)) {
				return { success: false, error: 'Database file does not exist' };
			}

			// Generate backup path with timestamp
			const timestamp = Date.now();
			const backupPath = `${this.dbPath}.backup.${timestamp}`;

			// Copy the database file
			fs.copyFileSync(this.dbPath, backupPath);

			logger.info(`Created database backup at ${backupPath}`, LOG_CONTEXT);
			return { success: true, backupPath };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to create database backup: ${errorMessage}`, LOG_CONTEXT);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Handle a corrupted database by backing it up and recreating a fresh database.
	 *
	 * This is the nuclear option when the database is unrecoverable:
	 * 1. Close the current database connection
	 * 2. Backup the corrupted database file
	 * 3. Delete the corrupted database file
	 * 4. Create a fresh database
	 *
	 * Note: This will result in loss of historical data, but preserves a backup
	 * that could potentially be recovered with specialized SQLite tools.
	 *
	 * @returns Object with recovery status, backup path, and any error
	 */
	private recoverFromCorruption(): CorruptionRecoveryResult {
		logger.warn('Attempting to recover from database corruption...', LOG_CONTEXT);

		try {
			// Close current connection if open
			if (this.db) {
				try {
					this.db.close();
				} catch {
					// Ignore errors closing corrupted database
				}
				this.db = null;
				this.initialized = false;
			}

			// Backup the corrupted database
			const backupResult = this.backupDatabase();
			if (!backupResult.success) {
				// If backup fails but file exists, try to rename it
				if (fs.existsSync(this.dbPath)) {
					const timestamp = Date.now();
					const emergencyBackupPath = `${this.dbPath}.corrupted.${timestamp}`;
					try {
						fs.renameSync(this.dbPath, emergencyBackupPath);
						logger.warn(`Emergency backup created at ${emergencyBackupPath}`, LOG_CONTEXT);
					} catch {
						// If we can't even rename, just delete and lose the data
						logger.error('Failed to backup corrupted database, data will be lost', LOG_CONTEXT);
						fs.unlinkSync(this.dbPath);
					}
				}
			}

			// Delete WAL and SHM files if they exist (they're associated with the corrupted db)
			const walPath = `${this.dbPath}-wal`;
			const shmPath = `${this.dbPath}-shm`;
			if (fs.existsSync(walPath)) {
				fs.unlinkSync(walPath);
			}
			if (fs.existsSync(shmPath)) {
				fs.unlinkSync(shmPath);
			}

			// Delete the main database file if it still exists
			if (fs.existsSync(this.dbPath)) {
				fs.unlinkSync(this.dbPath);
			}

			logger.info('Corrupted database removed, will create fresh database', LOG_CONTEXT);

			return {
				recovered: true,
				backupPath: backupResult.backupPath,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to recover from database corruption: ${errorMessage}`, LOG_CONTEXT);
			return {
				recovered: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Attempt to open and validate a database, handling corruption if detected.
	 *
	 * This method:
	 * 1. Tries to open the database file
	 * 2. Runs a quick integrity check
	 * 3. If corrupted, backs up and recreates the database
	 * 4. Returns whether the database is now usable
	 *
	 * @returns Database instance if successful, null if unrecoverable
	 */
	private openWithCorruptionHandling(): Database.Database | null {
		// First attempt: try to open normally
		try {
			const db = new Database(this.dbPath);

			// Quick integrity check on the existing database
			const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
			if (result.length === 1 && result[0].integrity_check === 'ok') {
				return db;
			}

			// Database is corrupted
			const errors = result.map((row) => row.integrity_check);
			logger.error(`Database integrity check failed: ${errors.join(', ')}`, LOG_CONTEXT);

			// Close before recovery
			db.close();
		} catch (error) {
			// Failed to open database - likely severely corrupted or locked
			logger.error(`Failed to open database: ${error}`, LOG_CONTEXT);
		}

		// Recovery attempt
		const recoveryResult = this.recoverFromCorruption();
		if (!recoveryResult.recovered) {
			logger.error('Database corruption recovery failed', LOG_CONTEXT);
			return null;
		}

		// Second attempt: create fresh database
		try {
			const db = new Database(this.dbPath);
			logger.info('Fresh database created after corruption recovery', LOG_CONTEXT);
			return db;
		} catch (error) {
			logger.error(`Failed to create fresh database after recovery: ${error}`, LOG_CONTEXT);
			return null;
		}
	}

	// ============================================================================
	// Query Events
	// ============================================================================

	/**
	 * Insert a new query event
	 */
	insertQueryEvent(event: Omit<QueryEvent, 'id'>): string {
		if (!this.db) throw new Error('Database not initialized');

		const id = generateId();
		const stmt = this.db.prepare(`
      INSERT INTO query_events (id, session_id, agent_type, source, start_time, duration, project_path, tab_id, is_remote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		stmt.run(
			id,
			event.sessionId,
			event.agentType,
			event.source,
			event.startTime,
			event.duration,
			normalizePath(event.projectPath),
			event.tabId ?? null,
			event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null
		);

		logger.debug(`Inserted query event ${id}`, LOG_CONTEXT);
		return id;
	}

	/**
	 * Get query events within a time range with optional filters
	 */
	getQueryEvents(range: StatsTimeRange, filters?: StatsFilters): QueryEvent[] {
		if (!this.db) throw new Error('Database not initialized');

		const startTime = getTimeRangeStart(range);
		let sql = 'SELECT * FROM query_events WHERE start_time >= ?';
		const params: (string | number)[] = [startTime];

		if (filters?.agentType) {
			sql += ' AND agent_type = ?';
			params.push(filters.agentType);
		}
		if (filters?.source) {
			sql += ' AND source = ?';
			params.push(filters.source);
		}
		if (filters?.projectPath) {
			sql += ' AND project_path = ?';
			// Normalize filter path to match stored format
			params.push(normalizePath(filters.projectPath) ?? '');
		}
		if (filters?.sessionId) {
			sql += ' AND session_id = ?';
			params.push(filters.sessionId);
		}

		sql += ' ORDER BY start_time DESC';

		const stmt = this.db.prepare(sql);
		const rows = stmt.all(...params) as Array<{
			id: string;
			session_id: string;
			agent_type: string;
			source: 'user' | 'auto';
			start_time: number;
			duration: number;
			project_path: string | null;
			tab_id: string | null;
			is_remote: number | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			agentType: row.agent_type,
			source: row.source,
			startTime: row.start_time,
			duration: row.duration,
			projectPath: row.project_path ?? undefined,
			tabId: row.tab_id ?? undefined,
			isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
		}));
	}

	// ============================================================================
	// Auto Run Sessions
	// ============================================================================

	/**
	 * Insert a new Auto Run session
	 */
	insertAutoRunSession(session: Omit<AutoRunSession, 'id'>): string {
		if (!this.db) throw new Error('Database not initialized');

		const id = generateId();
		const stmt = this.db.prepare(`
      INSERT INTO auto_run_sessions (id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		stmt.run(
			id,
			session.sessionId,
			session.agentType,
			normalizePath(session.documentPath),
			session.startTime,
			session.duration,
			session.tasksTotal ?? null,
			session.tasksCompleted ?? null,
			normalizePath(session.projectPath)
		);

		logger.debug(`Inserted Auto Run session ${id}`, LOG_CONTEXT);
		return id;
	}

	/**
	 * Update an existing Auto Run session (e.g., when it completes)
	 */
	updateAutoRunSession(id: string, updates: Partial<AutoRunSession>): boolean {
		if (!this.db) throw new Error('Database not initialized');

		const setClauses: string[] = [];
		const params: (string | number | null)[] = [];

		if (updates.duration !== undefined) {
			setClauses.push('duration = ?');
			params.push(updates.duration);
		}
		if (updates.tasksTotal !== undefined) {
			setClauses.push('tasks_total = ?');
			params.push(updates.tasksTotal ?? null);
		}
		if (updates.tasksCompleted !== undefined) {
			setClauses.push('tasks_completed = ?');
			params.push(updates.tasksCompleted ?? null);
		}
		if (updates.documentPath !== undefined) {
			setClauses.push('document_path = ?');
			params.push(normalizePath(updates.documentPath));
		}

		if (setClauses.length === 0) {
			return false;
		}

		params.push(id);
		const sql = `UPDATE auto_run_sessions SET ${setClauses.join(', ')} WHERE id = ?`;
		const stmt = this.db.prepare(sql);
		const result = stmt.run(...params);

		logger.debug(`Updated Auto Run session ${id}`, LOG_CONTEXT);
		return result.changes > 0;
	}

	/**
	 * Get Auto Run sessions within a time range
	 */
	getAutoRunSessions(range: StatsTimeRange): AutoRunSession[] {
		if (!this.db) throw new Error('Database not initialized');

		const startTime = getTimeRangeStart(range);
		const stmt = this.db.prepare(`
      SELECT * FROM auto_run_sessions
      WHERE start_time >= ?
      ORDER BY start_time DESC
    `);

		const rows = stmt.all(startTime) as Array<{
			id: string;
			session_id: string;
			agent_type: string;
			document_path: string | null;
			start_time: number;
			duration: number;
			tasks_total: number | null;
			tasks_completed: number | null;
			project_path: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			agentType: row.agent_type,
			documentPath: row.document_path ?? undefined,
			startTime: row.start_time,
			duration: row.duration,
			tasksTotal: row.tasks_total ?? undefined,
			tasksCompleted: row.tasks_completed ?? undefined,
			projectPath: row.project_path ?? undefined,
		}));
	}

	// ============================================================================
	// Auto Run Tasks
	// ============================================================================

	/**
	 * Insert a new Auto Run task
	 */
	insertAutoRunTask(task: Omit<AutoRunTask, 'id'>): string {
		if (!this.db) throw new Error('Database not initialized');

		const id = generateId();
		const stmt = this.db.prepare(`
      INSERT INTO auto_run_tasks (id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		stmt.run(
			id,
			task.autoRunSessionId,
			task.sessionId,
			task.agentType,
			task.taskIndex,
			task.taskContent ?? null,
			task.startTime,
			task.duration,
			task.success ? 1 : 0
		);

		logger.debug(`Inserted Auto Run task ${id}`, LOG_CONTEXT);
		return id;
	}

	/**
	 * Get all tasks for a specific Auto Run session
	 */
	getAutoRunTasks(autoRunSessionId: string): AutoRunTask[] {
		if (!this.db) throw new Error('Database not initialized');

		const stmt = this.db.prepare(`
      SELECT * FROM auto_run_tasks
      WHERE auto_run_session_id = ?
      ORDER BY task_index ASC
    `);

		const rows = stmt.all(autoRunSessionId) as Array<{
			id: string;
			auto_run_session_id: string;
			session_id: string;
			agent_type: string;
			task_index: number;
			task_content: string | null;
			start_time: number;
			duration: number;
			success: number;
		}>;

		return rows.map((row) => ({
			id: row.id,
			autoRunSessionId: row.auto_run_session_id,
			sessionId: row.session_id,
			agentType: row.agent_type,
			taskIndex: row.task_index,
			taskContent: row.task_content ?? undefined,
			startTime: row.start_time,
			duration: row.duration,
			success: row.success === 1,
		}));
	}

	// ============================================================================
	// Session Lifecycle
	// ============================================================================

	/**
	 * Record a session being created (launched)
	 */
	recordSessionCreated(event: Omit<SessionLifecycleEvent, 'id' | 'closedAt' | 'duration'>): string {
		if (!this.db) throw new Error('Database not initialized');

		const id = generateId();
		const stmt = this.db.prepare(`
      INSERT INTO session_lifecycle (id, session_id, agent_type, project_path, created_at, is_remote)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

		stmt.run(
			id,
			event.sessionId,
			event.agentType,
			normalizePath(event.projectPath),
			event.createdAt,
			event.isRemote !== undefined ? (event.isRemote ? 1 : 0) : null
		);

		logger.debug(`Recorded session created: ${event.sessionId}`, LOG_CONTEXT);
		return id;
	}

	/**
	 * Record a session being closed
	 */
	recordSessionClosed(sessionId: string, closedAt: number): boolean {
		if (!this.db) throw new Error('Database not initialized');

		// Get the session's created_at time to calculate duration
		const session = this.db
			.prepare(
				`
      SELECT created_at FROM session_lifecycle WHERE session_id = ?
    `
			)
			.get(sessionId) as { created_at: number } | undefined;

		if (!session) {
			logger.debug(`Session not found for closure: ${sessionId}`, LOG_CONTEXT);
			return false;
		}

		const duration = closedAt - session.created_at;

		const stmt = this.db.prepare(`
      UPDATE session_lifecycle
      SET closed_at = ?, duration = ?
      WHERE session_id = ?
    `);

		const result = stmt.run(closedAt, duration, sessionId);
		logger.debug(`Recorded session closed: ${sessionId}, duration: ${duration}ms`, LOG_CONTEXT);
		return result.changes > 0;
	}

	/**
	 * Get session lifecycle events within a time range
	 */
	getSessionLifecycleEvents(range: StatsTimeRange): SessionLifecycleEvent[] {
		if (!this.db) throw new Error('Database not initialized');

		const startTime = getTimeRangeStart(range);
		const stmt = this.db.prepare(`
      SELECT * FROM session_lifecycle
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `);

		const rows = stmt.all(startTime) as Array<{
			id: string;
			session_id: string;
			agent_type: string;
			project_path: string | null;
			created_at: number;
			closed_at: number | null;
			duration: number | null;
			is_remote: number | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			agentType: row.agent_type,
			projectPath: row.project_path ?? undefined,
			createdAt: row.created_at,
			closedAt: row.closed_at ?? undefined,
			duration: row.duration ?? undefined,
			isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
		}));
	}

	// ============================================================================
	// Aggregations
	// ============================================================================

	/**
	 * Get aggregated statistics for a time range
	 */
	getAggregatedStats(range: StatsTimeRange): StatsAggregation {
		if (!this.db) throw new Error('Database not initialized');

		const perfStart = perfMetrics.start();
		const startTime = getTimeRangeStart(range);

		// Total queries and duration
		const totalsStart = perfMetrics.start();
		const totalsStmt = this.db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(duration), 0) as total_duration
      FROM query_events
      WHERE start_time >= ?
    `);
		const totals = totalsStmt.get(startTime) as { count: number; total_duration: number };
		perfMetrics.end(totalsStart, 'getAggregatedStats:totals', { range });

		// By agent type
		const byAgentStart = perfMetrics.start();
		const byAgentStmt = this.db.prepare(`
      SELECT agent_type, COUNT(*) as count, SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY agent_type
    `);
		const byAgentRows = byAgentStmt.all(startTime) as Array<{
			agent_type: string;
			count: number;
			duration: number;
		}>;
		const byAgent: Record<string, { count: number; duration: number }> = {};
		for (const row of byAgentRows) {
			byAgent[row.agent_type] = { count: row.count, duration: row.duration };
		}
		perfMetrics.end(byAgentStart, 'getAggregatedStats:byAgent', {
			range,
			agentCount: byAgentRows.length,
		});

		// By source (user vs auto)
		const bySourceStart = perfMetrics.start();
		const bySourceStmt = this.db.prepare(`
      SELECT source, COUNT(*) as count
      FROM query_events
      WHERE start_time >= ?
      GROUP BY source
    `);
		const bySourceRows = bySourceStmt.all(startTime) as Array<{
			source: 'user' | 'auto';
			count: number;
		}>;
		const bySource = { user: 0, auto: 0 };
		for (const row of bySourceRows) {
			bySource[row.source] = row.count;
		}
		perfMetrics.end(bySourceStart, 'getAggregatedStats:bySource', { range });

		// By location (local vs remote SSH)
		const byLocationStart = perfMetrics.start();
		const byLocationStmt = this.db.prepare(`
      SELECT is_remote, COUNT(*) as count
      FROM query_events
      WHERE start_time >= ?
      GROUP BY is_remote
    `);
		const byLocationRows = byLocationStmt.all(startTime) as Array<{
			is_remote: number | null;
			count: number;
		}>;
		const byLocation = { local: 0, remote: 0 };
		for (const row of byLocationRows) {
			if (row.is_remote === 1) {
				byLocation.remote = row.count;
			} else {
				// Treat NULL (legacy data) and 0 as local
				byLocation.local += row.count;
			}
		}
		perfMetrics.end(byLocationStart, 'getAggregatedStats:byLocation', { range });

		// By day (for charts)
		const byDayStart = perfMetrics.start();
		const byDayStmt = this.db.prepare(`
      SELECT date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `);
		const byDayRows = byDayStmt.all(startTime) as Array<{
			date: string;
			count: number;
			duration: number;
		}>;
		perfMetrics.end(byDayStart, 'getAggregatedStats:byDay', { range, dayCount: byDayRows.length });

		// By agent by day (for provider usage chart)
		const byAgentByDayStart = perfMetrics.start();
		const byAgentByDayStmt = this.db.prepare(`
      SELECT agent_type,
             date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY agent_type, date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY agent_type, date ASC
    `);
		const byAgentByDayRows = byAgentByDayStmt.all(startTime) as Array<{
			agent_type: string;
			date: string;
			count: number;
			duration: number;
		}>;
		// Group by agent type
		const byAgentByDay: Record<
			string,
			Array<{ date: string; count: number; duration: number }>
		> = {};
		for (const row of byAgentByDayRows) {
			if (!byAgentByDay[row.agent_type]) {
				byAgentByDay[row.agent_type] = [];
			}
			byAgentByDay[row.agent_type].push({
				date: row.date,
				count: row.count,
				duration: row.duration,
			});
		}
		perfMetrics.end(byAgentByDayStart, 'getAggregatedStats:byAgentByDay', { range });

		// By hour (for peak hours chart)
		const byHourStart = perfMetrics.start();
		const byHourStmt = this.db.prepare(`
      SELECT CAST(strftime('%H', start_time / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `);
		const byHourRows = byHourStmt.all(startTime) as Array<{
			hour: number;
			count: number;
			duration: number;
		}>;
		perfMetrics.end(byHourStart, 'getAggregatedStats:byHour', { range });

		// Session stats (counting unique session IDs from query_events, which includes tab GUIDs)
		const sessionsStart = perfMetrics.start();

		// Total unique sessions with queries (counts tabs that have had at least one query)
		const sessionTotalsStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM query_events
      WHERE start_time >= ?
    `);
		const sessionTotals = sessionTotalsStmt.get(startTime) as { count: number };

		// Average session duration from lifecycle table (for sessions that have been closed)
		const avgSessionDurationStmt = this.db.prepare(`
      SELECT COALESCE(AVG(duration), 0) as avg_duration
      FROM session_lifecycle
      WHERE created_at >= ? AND duration IS NOT NULL
    `);
		const avgSessionDurationResult = avgSessionDurationStmt.get(startTime) as {
			avg_duration: number;
		};

		// Sessions by agent type
		const sessionsByAgentStmt = this.db.prepare(`
      SELECT agent_type, COUNT(*) as count
      FROM session_lifecycle
      WHERE created_at >= ?
      GROUP BY agent_type
    `);
		const sessionsByAgentRows = sessionsByAgentStmt.all(startTime) as Array<{
			agent_type: string;
			count: number;
		}>;
		const sessionsByAgent: Record<string, number> = {};
		for (const row of sessionsByAgentRows) {
			sessionsByAgent[row.agent_type] = row.count;
		}

		// Sessions by day
		const sessionsByDayStmt = this.db.prepare(`
      SELECT date(created_at / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count
      FROM session_lifecycle
      WHERE created_at >= ?
      GROUP BY date(created_at / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `);
		const sessionsByDayRows = sessionsByDayStmt.all(startTime) as Array<{
			date: string;
			count: number;
		}>;

		perfMetrics.end(sessionsStart, 'getAggregatedStats:sessions', {
			range,
			sessionCount: sessionTotals.count,
		});

		// By session by day (for agent usage chart - shows each Maestro session's usage over time)
		const bySessionByDayStart = perfMetrics.start();
		const bySessionByDayStmt = this.db.prepare(`
      SELECT session_id,
             date(start_time / 1000, 'unixepoch', 'localtime') as date,
             COUNT(*) as count,
             SUM(duration) as duration
      FROM query_events
      WHERE start_time >= ?
      GROUP BY session_id, date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY session_id, date ASC
    `);
		const bySessionByDayRows = bySessionByDayStmt.all(startTime) as Array<{
			session_id: string;
			date: string;
			count: number;
			duration: number;
		}>;
		const bySessionByDay: Record<
			string,
			Array<{ date: string; count: number; duration: number }>
		> = {};
		for (const row of bySessionByDayRows) {
			if (!bySessionByDay[row.session_id]) {
				bySessionByDay[row.session_id] = [];
			}
			bySessionByDay[row.session_id].push({
				date: row.date,
				count: row.count,
				duration: row.duration,
			});
		}
		perfMetrics.end(bySessionByDayStart, 'getAggregatedStats:bySessionByDay', { range });

		const totalDuration = perfMetrics.end(perfStart, 'getAggregatedStats:total', {
			range,
			totalQueries: totals.count,
		});

		// Log warning if the aggregation is slow
		if (totalDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
			logger.warn(
				`getAggregatedStats took ${totalDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
				LOG_CONTEXT,
				{ range, totalQueries: totals.count }
			);
		}

		return {
			totalQueries: totals.count,
			totalDuration: totals.total_duration,
			avgDuration: totals.count > 0 ? Math.round(totals.total_duration / totals.count) : 0,
			byAgent,
			bySource,
			byDay: byDayRows,
			byLocation,
			byHour: byHourRows,
			totalSessions: sessionTotals.count,
			sessionsByAgent,
			sessionsByDay: sessionsByDayRows,
			avgSessionDuration: Math.round(avgSessionDurationResult.avg_duration),
			byAgentByDay,
			bySessionByDay,
		};
	}

	// ============================================================================
	// Data Management
	// ============================================================================

	/**
	 * Clear old data from the database.
	 *
	 * Deletes query_events, auto_run_sessions, auto_run_tasks, and session_lifecycle
	 * records that are older than the specified number of days. This is useful for
	 * managing database size and removing stale historical data.
	 *
	 * @param olderThanDays - Delete records older than this many days (e.g., 30, 90, 180, 365)
	 * @returns Object with success status, number of records deleted from each table, and any error
	 */
	clearOldData(olderThanDays: number): {
		success: boolean;
		deletedQueryEvents: number;
		deletedAutoRunSessions: number;
		deletedAutoRunTasks: number;
		deletedSessionLifecycle: number;
		error?: string;
	} {
		if (!this.db) {
			return {
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
				deletedSessionLifecycle: 0,
				error: 'Database not initialized',
			};
		}

		if (olderThanDays <= 0) {
			return {
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
				deletedSessionLifecycle: 0,
				error: 'olderThanDays must be greater than 0',
			};
		}

		try {
			const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

			logger.info(
				`Clearing stats data older than ${olderThanDays} days (before ${new Date(cutoffTime).toISOString()})`,
				LOG_CONTEXT
			);

			// Get IDs of auto_run_sessions to be deleted (for cascading to tasks)
			const sessionsToDelete = this.db
				.prepare('SELECT id FROM auto_run_sessions WHERE start_time < ?')
				.all(cutoffTime) as Array<{ id: string }>;
			const sessionIds = sessionsToDelete.map((row) => row.id);

			// Delete auto_run_tasks for the sessions being deleted
			let deletedTasks = 0;
			if (sessionIds.length > 0) {
				// SQLite doesn't support array binding, so we use a subquery
				const tasksResult = this.db
					.prepare(
						'DELETE FROM auto_run_tasks WHERE auto_run_session_id IN (SELECT id FROM auto_run_sessions WHERE start_time < ?)'
					)
					.run(cutoffTime);
				deletedTasks = tasksResult.changes;
			}

			// Delete auto_run_sessions
			const sessionsResult = this.db
				.prepare('DELETE FROM auto_run_sessions WHERE start_time < ?')
				.run(cutoffTime);
			const deletedSessions = sessionsResult.changes;

			// Delete query_events
			const eventsResult = this.db
				.prepare('DELETE FROM query_events WHERE start_time < ?')
				.run(cutoffTime);
			const deletedEvents = eventsResult.changes;

			// Delete session_lifecycle
			const lifecycleResult = this.db
				.prepare('DELETE FROM session_lifecycle WHERE created_at < ?')
				.run(cutoffTime);
			const deletedLifecycle = lifecycleResult.changes;

			const totalDeleted = deletedEvents + deletedSessions + deletedTasks + deletedLifecycle;
			logger.info(
				`Cleared ${totalDeleted} old stats records (${deletedEvents} query events, ${deletedSessions} auto-run sessions, ${deletedTasks} auto-run tasks, ${deletedLifecycle} session lifecycle)`,
				LOG_CONTEXT
			);

			return {
				success: true,
				deletedQueryEvents: deletedEvents,
				deletedAutoRunSessions: deletedSessions,
				deletedAutoRunTasks: deletedTasks,
				deletedSessionLifecycle: deletedLifecycle,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to clear old stats data: ${errorMessage}`, LOG_CONTEXT);
			return {
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
				deletedSessionLifecycle: 0,
				error: errorMessage,
			};
		}
	}

	// ============================================================================
	// Export
	// ============================================================================

	/**
	 * Export query events to CSV format
	 */
	exportToCsv(range: StatsTimeRange): string {
		const events = this.getQueryEvents(range);

		const headers = [
			'id',
			'sessionId',
			'agentType',
			'source',
			'startTime',
			'duration',
			'projectPath',
			'tabId',
		];
		const rows = events.map((e) => [
			e.id,
			e.sessionId,
			e.agentType,
			e.source,
			new Date(e.startTime).toISOString(),
			e.duration.toString(),
			e.projectPath ?? '',
			e.tabId ?? '',
		]);

		const csvContent = [
			headers.join(','),
			...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
		].join('\n');

		return csvContent;
	}
}

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
export function initializeStatsDB(): void {
	const db = getStatsDB();
	db.initialize();
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
 *
 * @returns true if performance metrics are being logged
 */
export function isPerformanceLoggingEnabled(): boolean {
	return perfMetrics.isEnabled();
}

/**
 * Get collected performance metrics for analysis.
 *
 * Returns the last 100 recorded metrics (when enabled).
 * Useful for debugging and performance analysis.
 *
 * @returns Array of performance metric entries
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
