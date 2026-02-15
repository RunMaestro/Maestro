/**
 * Stats Database Migration System
 *
 * Manages schema evolution through versioned, sequential migrations.
 * Each migration runs exactly once and is recorded in the _migrations table.
 *
 * ### Adding New Migrations
 *
 * 1. Create a new `migrateVN()` function
 * 2. Add it to the `getMigrations()` array with version number and description
 * 3. Update `STATS_DB_VERSION` in `../../shared/stats-types.ts`
 */

import type Database from 'better-sqlite3';
import type { Migration, MigrationRecord } from './types';
import { mapMigrationRecordRow, type MigrationRecordRow } from './row-mappers';
import {
	CREATE_MIGRATIONS_TABLE_SQL,
	CREATE_QUERY_EVENTS_SQL,
	CREATE_QUERY_EVENTS_INDEXES_SQL,
	CREATE_AUTO_RUN_SESSIONS_SQL,
	CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL,
	CREATE_AUTO_RUN_TASKS_SQL,
	CREATE_AUTO_RUN_TASKS_INDEXES_SQL,
	CREATE_SESSION_LIFECYCLE_SQL,
	CREATE_SESSION_LIFECYCLE_INDEXES_SQL,
	runStatements,
} from './schema';
import { LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';

// ============================================================================
// Migration Registry
// ============================================================================

/**
 * Registry of all database migrations.
 * Migrations must be sequential starting from version 1.
 */
export function getMigrations(): Migration[] {
	return [
		{
			version: 1,
			description: 'Initial schema: query_events, auto_run_sessions, auto_run_tasks tables',
			up: (db) => migrateV1(db),
		},
		{
			version: 2,
			description: 'Add is_remote column to query_events for tracking SSH sessions',
			up: (db) => migrateV2(db),
		},
		{
			version: 3,
			description: 'Add session_lifecycle table for tracking session creation and closure',
			up: (db) => migrateV3(db),
		},
		{
			version: 4,
			description: 'Add compound indexes for time-range + column queries',
			up: (db) => migrateV4(db),
		},
		{
			version: 5,
			description: 'Fix compound index column order: equality columns before range columns',
			up: (db) => migrateV5(db),
		},
	];
}

// ============================================================================
// Migration Execution
// ============================================================================

/**
 * Run all pending database migrations.
 *
 * 1. Creates the _migrations table if it doesn't exist
 * 2. Gets the current schema version from user_version pragma
 * 3. Runs each pending migration in a transaction
 * 4. Records each migration in the _migrations table
 * 5. Updates the user_version pragma
 */
export function runMigrations(db: Database.Database): void {
	// Create migrations table (the only table created outside the migration system)
	db.prepare(CREATE_MIGRATIONS_TABLE_SQL).run();

	// Get current version (0 if fresh database)
	const versionResult = db.pragma('user_version') as Array<{ user_version: number }>;
	const currentVersion = versionResult[0]?.user_version ?? 0;

	const migrations = getMigrations();
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
		applyMigration(db, migration);
	}
}

/**
 * Apply a single migration within a transaction.
 * Records the migration in the _migrations table with success/failure status.
 */
function applyMigration(db: Database.Database, migration: Migration): void {
	const startTime = Date.now();
	logger.info(`Applying migration v${migration.version}: ${migration.description}`, LOG_CONTEXT);

	try {
		const runMigrationTxn = db.transaction(() => {
			migration.up(db);

			db.prepare(
				`
        INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
        VALUES (?, ?, ?, 'success', NULL)
      `
			).run(migration.version, migration.description, Date.now());

			db.pragma(`user_version = ${migration.version}`);
		});

		runMigrationTxn();

		const duration = Date.now() - startTime;
		logger.info(`Migration v${migration.version} completed in ${duration}ms`, LOG_CONTEXT);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		db.prepare(
			`
      INSERT OR REPLACE INTO _migrations (version, description, applied_at, status, error_message)
      VALUES (?, ?, ?, 'failed', ?)
    `
		).run(migration.version, migration.description, Date.now(), errorMessage);

		logger.error(`Migration v${migration.version} failed: ${errorMessage}`, LOG_CONTEXT);
		throw error;
	}
}

// ============================================================================
// Migration Queries
// ============================================================================

/**
 * Get the list of applied migrations from the _migrations table.
 */
export function getMigrationHistory(db: Database.Database): MigrationRecord[] {
	const tableExists = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
		.get();

	if (!tableExists) {
		return [];
	}

	const rows = db
		.prepare(
			`
      SELECT version, description, applied_at, status, error_message
      FROM _migrations
      ORDER BY version ASC
    `
		)
		.all() as MigrationRecordRow[];

	return rows.map(mapMigrationRecordRow);
}

/**
 * Get the current database schema version.
 */
export function getCurrentVersion(db: Database.Database): number {
	const versionResult = db.pragma('user_version') as Array<{ user_version: number }>;
	return versionResult[0]?.user_version ?? 0;
}

/**
 * Get the target version (highest version in migrations registry).
 */
export function getTargetVersion(): number {
	const migrations = getMigrations();
	if (migrations.length === 0) return 0;
	return Math.max(...migrations.map((m) => m.version));
}

/**
 * Check if any migrations are pending.
 */
export function hasPendingMigrations(db: Database.Database): boolean {
	return getCurrentVersion(db) < getTargetVersion();
}

// ============================================================================
// Individual Migration Functions
// ============================================================================

/**
 * Migration v1: Initial schema creation
 */
function migrateV1(db: Database.Database): void {
	db.prepare(CREATE_QUERY_EVENTS_SQL).run();
	runStatements(db, CREATE_QUERY_EVENTS_INDEXES_SQL);

	db.prepare(CREATE_AUTO_RUN_SESSIONS_SQL).run();
	runStatements(db, CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL);

	db.prepare(CREATE_AUTO_RUN_TASKS_SQL).run();
	runStatements(db, CREATE_AUTO_RUN_TASKS_INDEXES_SQL);

	logger.debug('Created stats database tables and indexes', LOG_CONTEXT);
}

/**
 * Migration v2: Add is_remote column for SSH session tracking
 */
function migrateV2(db: Database.Database): void {
	db.prepare('ALTER TABLE query_events ADD COLUMN is_remote INTEGER').run();
	db.prepare('CREATE INDEX IF NOT EXISTS idx_query_is_remote ON query_events(is_remote)').run();

	logger.debug('Added is_remote column to query_events table', LOG_CONTEXT);
}

/**
 * Migration v3: Add session_lifecycle table
 */
function migrateV3(db: Database.Database): void {
	db.prepare(CREATE_SESSION_LIFECYCLE_SQL).run();
	runStatements(db, CREATE_SESSION_LIFECYCLE_INDEXES_SQL);

	logger.debug('Created session_lifecycle table', LOG_CONTEXT);
}

/**
 * Migration v4: Add compound indexes for time-range queries
 *
 * Most aggregation queries filter by start_time/created_at first, then group by
 * agent_type, source, or project_path. Compound indexes with the time column
 * leading allow SQLite to use a single index scan for both the range filter
 * and the grouping/filtering.
 */
function migrateV4(db: Database.Database): void {
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_query_time_agent ON query_events(start_time, agent_type)'
	).run();
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_query_time_source ON query_events(start_time, source)'
	).run();
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_query_time_project ON query_events(start_time, project_path)'
	).run();
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_session_time_agent ON session_lifecycle(created_at, agent_type)'
	).run();

	logger.debug('Added compound indexes for time-range queries', LOG_CONTEXT);
}

/**
 * Migration v5: Fix compound index column order for source and project_path queries
 *
 * SQLite's B-tree index optimization requires equality predicates to precede
 * range predicates. The v4 indexes (start_time, source) and (start_time, project_path)
 * were not used by the query planner because start_time is a range predicate.
 * Reversing the column order to (source, start_time) and (project_path, start_time)
 * allows SQLite to use equality on the leading column, then range on start_time.
 */
function migrateV5(db: Database.Database): void {
	// Drop the v4 indexes with incorrect column order
	db.prepare('DROP INDEX IF EXISTS idx_query_time_source').run();
	db.prepare('DROP INDEX IF EXISTS idx_query_time_project').run();

	// Create replacement indexes with equality column leading
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_query_source_time ON query_events(source, start_time)'
	).run();
	db.prepare(
		'CREATE INDEX IF NOT EXISTS idx_query_project_time ON query_events(project_path, start_time)'
	).run();

	logger.debug('Fixed compound index column order for source and project_path queries', LOG_CONTEXT);
}
