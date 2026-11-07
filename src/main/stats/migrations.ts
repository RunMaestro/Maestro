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
	CREATE_QUERY_EVENTS_SQL,
	CREATE_QUERY_EVENTS_INDEXES_SQL,
	CREATE_AUTO_RUN_SESSIONS_SQL,
	CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL,
	CREATE_AUTO_RUN_TASKS_SQL,
	CREATE_AUTO_RUN_TASKS_INDEXES_SQL,
	CREATE_SESSION_LIFECYCLE_SQL,
	CREATE_SESSION_LIFECYCLE_INDEXES_SQL,
	CREATE_COMPOUND_INDEXES_SQL,
	CREATE_IMAGE_ANNOTATIONS_SQL,
	CREATE_IMAGE_ANNOTATIONS_INDEXES_SQL,
	CREATE_SHORTCUT_USAGE_DAILY_SQL,
	CREATE_MULTI_WINDOW_USAGE_DAILY_SQL,
	ADD_QUERY_EVENT_TOKEN_COLUMNS,
	CREATE_RESILIENCE_EVENTS_SQL,
	CREATE_RESILIENCE_EVENTS_INDEXES_SQL,
	CREATE_WIZARD_RUNS_SQL,
	CREATE_WIZARD_RUNS_INDEXES_SQL,
	ADD_AUTO_RUN_SESSION_KIND_COLUMN_SQL,
	CREATE_LOCAL_MODEL_RUNS_SQL,
	CREATE_LOCAL_MODEL_RUNS_INDEXES_SQL,
	CREATE_PROXY_REQUESTS_SQL,
	CREATE_PROXY_REQUESTS_INDEXES_SQL,
	ADD_PROXY_REQUEST_ROUTED_TO_COLUMN_SQL,
	CREATE_S1_DECISIONS_SQL,
	CREATE_S1_DECISIONS_INDEXES_SQL,
	ADD_S1_DECISION_TAB_ID_COLUMN_SQL,
	ADD_S1_DECISION_CACHED_COLUMN_SQL,
	ADD_QUERY_EVENT_MODEL_COLUMNS,
	CREATE_LOCAL_MODEL_RUNS_AGENT_INDEX_SQL,
	CREATE_LOCAL_MODEL_RUNS_REBUILD_SQL,
	LOCAL_MODEL_RUNS_REBUILD_TABLE,
	LOCAL_MODEL_RUNS_V15_COLUMNS,
	runStatements,
} from './schema';
import { LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';
import { runSqliteMigrations, sqliteUserVersion } from '../utils/sqlite-migrations';

// ============================================================================
// Migration Registry
// ============================================================================

/**
 * Registry of all database migrations.
 * Migrations must be sequential starting from version 1.
 */
function getMigrations(): Migration[] {
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
			description: 'Add compound indexes on query_events for dashboard query performance',
			up: (db) => migrateV4(db),
		},
		{
			version: 5,
			description:
				'Add is_worktree column to query_events and session_lifecycle for worktree analytics',
			up: (db) => migrateV5(db),
		},
		{
			version: 6,
			description: 'Add image_annotations table for tracking image annotation events',
			up: (db) => migrateV6(db),
		},
		{
			version: 7,
			description: 'Add shortcut_usage_daily table for tracking keyboard shortcut firings per day',
			up: (db) => migrateV7(db),
		},
		{
			// v8 onwards declare `isApplied` because rc and main assign DIFFERENT
			// migrations to these numbers (main's v8 is the token columns, rc's is
			// multi_window_usage_daily). user_version is a bare number, so an install
			// that last ran the other branch can already sit at version 8+ without
			// ever having run this body, and every write touching the missing schema
			// then fails (MAESTRO-113/114). Each guard must test the schema THIS
			// migration creates - the numbers differ per branch, so a guard that
			// drifts onto its neighbour reports a table as present because an
			// unrelated one is.
			version: 8,
			description:
				'Add multi_window_usage_daily table for tracking windows opened and peak concurrent windows per day',
			up: (db) => migrateV8(db),
			isApplied: (db) => hasTable(db, 'multi_window_usage_daily'),
		},
		{
			version: 9,
			description: 'Add per-turn token and cost columns to query_events for cost attribution',
			up: (db) => migrateV9(db),
			isApplied: (db) =>
				ADD_QUERY_EVENT_TOKEN_COLUMNS.every((column) => hasColumn(db, 'query_events', column)),
		},
		{
			version: 10,
			description: 'Add resilience_events table for Agent Resilience outage tracking',
			up: (db) => migrateV10(db),
			isApplied: (db) => hasTable(db, 'resilience_events'),
		},
		{
			version: 11,
			description: 'Add wizard_runs table for Auto Run wizard usage tracking',
			up: (db) => migrateV11(db),
			isApplied: (db) => hasTable(db, 'wizard_runs'),
		},
		{
			version: 12,
			description: 'Add user_name column to query_events for Web Login turn attribution',
			up: (db) => migrateV12(db),
		},
		{
			// main numbers this v11; on rc wizard_runs is v11 and v12 is Web Login's
			// user_name column. The body is guarded by hasColumn, so renumbering is safe.
			version: 13,
			description: 'Add active_ms column to wizard_runs so wizard time excludes idle tabs',
			up: (db) => migrateV13(db),
			isApplied: (db) => hasColumn(db, 'wizard_runs', 'active_ms'),
		},
		{
			version: 14,
			description: 'Add kind column to auto_run_sessions for goal-driven vs spec-driven split',
			up: (db) => migrateV14(db),
		},
		{
			version: 15,
			description: 'Add local_model_runs table for Local Models task router runs',
			up: (db) => migrateV15(db),
			isApplied: (db) => hasTable(db, 'local_model_runs'),
		},
		{
			version: 16,
			description: 'Add proxy_requests table for the Maestro token proxy',
			up: (db) => migrateV16(db),
			isApplied: (db) => hasTable(db, 'proxy_requests'),
		},
		{
			version: 17,
			description: 'Add routed_to column to proxy_requests for background request routing',
			up: (db) => migrateV17(db),
			isApplied: (db) => hasColumn(db, 'proxy_requests', 'routed_to'),
		},
		{
			version: 18,
			description: 'Add s1_decisions table for the System One decision ledger',
			up: (db) => migrateV18(db),
			isApplied: (db) => hasTable(db, 's1_decisions'),
		},
		{
			version: 19,
			description: 'Add tab_id and cached columns to s1_decisions for agent requests',
			up: (db) => migrateV19(db),
			isApplied: (db) =>
				hasColumn(db, 's1_decisions', 'tab_id') && hasColumn(db, 's1_decisions', 'cached'),
		},
		{
			version: 20,
			description:
				'Widen local_model_runs.source_type, add its agent_id, and add Run on and routed tier columns to query_events',
			up: (db) => migrateV20(db),
			isApplied: (db) =>
				localModelRunsIsCurrent(db) &&
				ADD_QUERY_EVENT_MODEL_COLUMNS.every((column) => hasColumn(db, 'query_events', column)),
		},
	];
}

// ============================================================================
// Migration Execution
// ============================================================================

/**
 * Run all pending database migrations.
 *
 * The bookkeeping (the _migrations table, user_version, the repair of a version
 * number that covers a migration whose schema is missing, one transaction per
 * migration) is the shared runner's; this module owns only the stats schema.
 */
export function runMigrations(db: Database.Database): void {
	runSqliteMigrations(db, getMigrations(), LOG_CONTEXT);
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
	return sqliteUserVersion(db);
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
 * Migration v4: Add compound indexes for dashboard query performance
 */
function migrateV4(db: Database.Database): void {
	runStatements(db, CREATE_COMPOUND_INDEXES_SQL);

	logger.debug('Added compound indexes on query_events', LOG_CONTEXT);
}

/**
 * Migration v5: Add is_worktree column to query_events and session_lifecycle.
 *
 * Uses PRAGMA table_info to check whether the column already exists before
 * issuing ALTER TABLE - this lets the migration be safely re-applied if a
 * previous run partially completed before being recorded.
 */
function migrateV5(db: Database.Database): void {
	if (!hasColumn(db, 'query_events', 'is_worktree')) {
		db.prepare('ALTER TABLE query_events ADD COLUMN is_worktree INTEGER DEFAULT 0').run();
	}
	db.prepare('CREATE INDEX IF NOT EXISTS idx_query_is_worktree ON query_events(is_worktree)').run();

	if (!hasColumn(db, 'session_lifecycle', 'is_worktree')) {
		db.prepare('ALTER TABLE session_lifecycle ADD COLUMN is_worktree INTEGER DEFAULT 0').run();
	}

	logger.debug(
		'Added is_worktree column to query_events and session_lifecycle tables',
		LOG_CONTEXT
	);
}

/**
 * Migration v6: Add image_annotations table for tracking annotation events.
 */
function migrateV6(db: Database.Database): void {
	db.prepare(CREATE_IMAGE_ANNOTATIONS_SQL).run();
	runStatements(db, CREATE_IMAGE_ANNOTATIONS_INDEXES_SQL);

	logger.debug('Created image_annotations table', LOG_CONTEXT);
}

/**
 * Migration v7: Add shortcut_usage_daily table.
 *
 * Per-day rolled-up counter - one row per local-date with the total number of
 * keyboard shortcuts fired. The renderer increments via UPSERT so the table
 * stays bounded (one row per day across the lifetime of the app).
 */
function migrateV7(db: Database.Database): void {
	db.prepare(CREATE_SHORTCUT_USAGE_DAILY_SQL).run();

	logger.debug('Created shortcut_usage_daily table', LOG_CONTEXT);
}

/**
 * Migration v8: Add multi_window_usage_daily table.
 *
 * Per-day rolled-up counters for multi-window usage telemetry - one row per
 * local-date with the number of secondary windows opened and the peak number of
 * windows open concurrently that day. The main process UPSERTs on each window
 * open so the table stays bounded (one row per day). Aggregate counters only.
 */
function migrateV8(db: Database.Database): void {
	db.prepare(CREATE_MULTI_WINDOW_USAGE_DAILY_SQL).run();

	logger.debug('Created multi_window_usage_daily table', LOG_CONTEXT);
}

/**
 * Migration v9: Add per-turn token and cost columns to query_events.
 *
 * Columns stay nullable with no default so a historical row reads as "unknown"
 * rather than "zero tokens" - see ADD_QUERY_EVENT_TOKEN_COLUMNS. Guarded by
 * hasColumn for the same reason as v5: a partially-applied run must be safe to
 * repeat.
 *
 * `cost_usd` is REAL; the token columns are INTEGER.
 */
function migrateV9(db: Database.Database): void {
	for (const column of ADD_QUERY_EVENT_TOKEN_COLUMNS) {
		if (hasColumn(db, 'query_events', column)) continue;
		const type = column === 'cost_usd' ? 'REAL' : 'INTEGER';
		db.prepare(`ALTER TABLE query_events ADD COLUMN ${column} ${type}`).run();
	}

	logger.debug('Added token and cost columns to query_events table', LOG_CONTEXT);
}

/**
 * Migration v10: resilience_events - one row per resolved Agent Resilience
 * outage, powering the Usage Dashboard's "outages survived" view.
 *
 * This lands on rc as v10 rather than main's v9: rc already numbers its
 * query_events token-columns migration 9, and the two installs must not
 * disagree about what a version means. The body is idempotent, so renumbering
 * is safe.
 */
function migrateV10(db: Database.Database): void {
	runStatements(db, CREATE_RESILIENCE_EVENTS_SQL);
	runStatements(db, CREATE_RESILIENCE_EVENTS_INDEXES_SQL);
	logger.debug('Created resilience_events table', LOG_CONTEXT);
}

/**
 * Migration v11: wizard_runs - one row per Auto Run wizard conversation,
 * powering the Usage Dashboard's "Wizard" section on the Auto Run tab.
 *
 * This lands on rc as v11 rather than main's v10, for the same reason the
 * resilience_events migration above is v10 there: rc already numbers its
 * query_events token-columns migration 9. The body is idempotent, so
 * renumbering is safe.
 */
function migrateV11(db: Database.Database): void {
	runStatements(db, CREATE_WIZARD_RUNS_SQL);
	runStatements(db, CREATE_WIZARD_RUNS_INDEXES_SQL);
	logger.debug('Created wizard_runs table', LOG_CONTEXT);
}

/**
 * Migration v12: Add user_name to query_events for Web Login turn attribution.
 *
 * Nullable with no default, like the v9 token columns: NULL means "nobody was
 * signed in for this turn" (the desktop, or Web Login switched off), which is a
 * different fact from an account named the empty string. Guarded by hasColumn
 * for the same reason as v5 - a partially applied run must be safe to repeat.
 */
function migrateV12(db: Database.Database): void {
	if (!hasColumn(db, 'query_events', 'user_name')) {
		db.prepare('ALTER TABLE query_events ADD COLUMN user_name TEXT').run();
	}
	db.prepare('CREATE INDEX IF NOT EXISTS idx_query_user_name ON query_events(user_name)').run();

	logger.debug('Added user_name column to query_events table', LOG_CONTEXT);
}

/**
 * Migration v13: wizard_runs.active_ms - time actually spent in the wizard.
 * Rows from before it stay NULL ("not measured") rather than being backfilled
 * from `ended_at - started_at`, which is the open-to-close wall clock this
 * column exists to replace. The dashboard leaves NULL rows out of time totals.
 */
function migrateV13(db: Database.Database): void {
	if (!hasColumn(db, 'wizard_runs', 'active_ms')) {
		db.prepare('ALTER TABLE wizard_runs ADD COLUMN active_ms INTEGER').run();
	}
	logger.debug('Added active_ms column to wizard_runs', LOG_CONTEXT);
}

/**
 * Migration v14: `kind` column on auto_run_sessions ('goal-driven' |
 * 'spec-driven'), so the Usage Dashboard can split Auto Run time by engine.
 *
 * Additive with a DEFAULT, so every existing row reads back as spec-driven with
 * its other fields untouched. Guarded by hasColumn for the same reason as v5.
 */
function migrateV14(db: Database.Database): void {
	if (!hasColumn(db, 'auto_run_sessions', 'kind')) {
		db.prepare(ADD_AUTO_RUN_SESSION_KIND_COLUMN_SQL).run();
	}
	logger.debug('Added kind column to auto_run_sessions table', LOG_CONTEXT);
}

/**
 * Migration v15: local_model_runs - one row per Local Models task run that
 * reached a model (local or endpoint), so the Usage Dashboard can show what
 * housekeeping ran where, how long it took, and what failed.
 *
 * Declares `isApplied` like v8 onwards: if rc lands a different v15 first, an
 * install stamped 15 by that build still gets this table.
 */
function migrateV15(db: Database.Database): void {
	runStatements(db, CREATE_LOCAL_MODEL_RUNS_SQL);
	runStatements(db, CREATE_LOCAL_MODEL_RUNS_INDEXES_SQL);
	logger.debug('Created local_model_runs table', LOG_CONTEXT);
}

/**
 * Migration v16: proxy_requests - one row per model request the Maestro token
 * proxy carried, so the Local Models tab can show what it saved and what it
 * cost in latency. Declares `isApplied` for the same reason v15 does.
 */
function migrateV16(db: Database.Database): void {
	runStatements(db, CREATE_PROXY_REQUESTS_SQL);
	runStatements(db, CREATE_PROXY_REQUESTS_INDEXES_SQL);
	logger.debug('Created proxy_requests table', LOG_CONTEXT);
}

/**
 * Migration v17: proxy_requests.routed_to - the Local Models target a
 * background request was sent to in place of the provider. A table created by
 * v16 at this version already has the column, so the body is guarded; it
 * declares `isApplied` so a database stamped 17 by another branch still gets it.
 */
function migrateV17(db: Database.Database): void {
	if (!hasColumn(db, 'proxy_requests', 'routed_to')) {
		db.prepare(ADD_PROXY_REQUEST_ROUTED_TO_COLUMN_SQL).run();
	}
	logger.debug('Added routed_to column to proxy_requests', LOG_CONTEXT);
}

/**
 * Migration v18: s1_decisions - one row per task run that was handed to a
 * System One engine, so the ledger can show what was decided and what happened
 * when no answer came. Declares `isApplied` for the same reason v15 does.
 */
function migrateV18(db: Database.Database): void {
	runStatements(db, CREATE_S1_DECISIONS_SQL);
	runStatements(db, CREATE_S1_DECISIONS_INDEXES_SQL);
	logger.debug('Created s1_decisions table', LOG_CONTEXT);
}

/**
 * Migration v19: s1_decisions.tab_id and s1_decisions.cached - the AI tab an
 * agent's own request came from, and whether it was answered from the answer
 * cache. A table created by v18 at this version already has both, so each is
 * guarded; it declares `isApplied` for the same reason v17 does.
 */
function migrateV19(db: Database.Database): void {
	if (!hasColumn(db, 's1_decisions', 'tab_id')) {
		db.prepare(ADD_S1_DECISION_TAB_ID_COLUMN_SQL).run();
	}
	if (!hasColumn(db, 's1_decisions', 'cached')) {
		db.prepare(ADD_S1_DECISION_CACHED_COLUMN_SQL).run();
	}
	logger.debug('Added tab_id and cached columns to s1_decisions', LOG_CONTEXT);
}

/**
 * Migration v20: what the Usage Dashboard's Models tab needs and nothing
 * recorded.
 *
 *   - `local_model_runs.source_type` gains `server` (a run the Maestro model
 *     server answered) and `system-one` (a request sent to a remote System One
 *     engine), and the table gains a nullable `agent_id`.
 *   - `query_events` gains `run_on_endpoint`, `run_on_model` and `routed_tier`:
 *     where an agent turn's model ran, and the tier Auto's router chose.
 *
 * Every step is guarded, so the body is safe to repeat, and it declares
 * `isApplied` for the same reason v15 does.
 */
function migrateV20(db: Database.Database): void {
	rebuildLocalModelRuns(db);
	db.prepare(CREATE_LOCAL_MODEL_RUNS_AGENT_INDEX_SQL).run();

	for (const column of ADD_QUERY_EVENT_MODEL_COLUMNS) {
		if (hasColumn(db, 'query_events', column)) continue;
		db.prepare(`ALTER TABLE query_events ADD COLUMN ${column} TEXT`).run();
	}

	logger.debug(
		'Rebuilt local_model_runs and added model columns to query_events table',
		LOG_CONTEXT
	);
}

/**
 * Whether `local_model_runs` has the v20 shape: the `agent_id` column, and a
 * `source_type` CHECK that names `system-one`. A CHECK cannot be read through a
 * pragma, so the test is on the table's stored definition.
 */
function localModelRunsIsCurrent(db: Database.Database): boolean {
	if (!hasColumn(db, 'local_model_runs', 'agent_id')) return false;
	const row = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = 'local_model_runs'")
		.get() as { sql: string } | undefined;
	return !!row?.sql.includes("'system-one'");
}

/**
 * Give `local_model_runs` its v20 shape without losing a row.
 *
 * SQLite cannot alter a CHECK constraint, so this is the table rebuild its
 * documentation prescribes: create the new table beside the old one, copy
 * every row, drop the old table, rename the new one into place, and put the
 * indexes back (a dropped table takes its indexes with it). The migration
 * runner holds one transaction around all of it, so a failure at any step
 * leaves the old table exactly as it was.
 *
 * The row counts are compared before the old table is dropped. The copy has no
 * WHERE clause and every old `source_type` satisfies the wider CHECK, so they
 * cannot differ; if they ever do, the migration fails rather than drop data.
 */
function rebuildLocalModelRuns(db: Database.Database): void {
	if (!hasTable(db, 'local_model_runs')) {
		// Stamped past v15 by a build that never created it: there is nothing to copy.
		runStatements(db, CREATE_LOCAL_MODEL_RUNS_SQL);
		runStatements(db, CREATE_LOCAL_MODEL_RUNS_INDEXES_SQL);
		return;
	}
	if (localModelRunsIsCurrent(db)) return;

	// A table that already carries `agent_id` under the old CHECK keeps its values.
	const columns = [
		...LOCAL_MODEL_RUNS_V15_COLUMNS,
		...(hasColumn(db, 'local_model_runs', 'agent_id') ? ['agent_id'] : []),
	].join(', ');

	db.prepare(`DROP TABLE IF EXISTS ${LOCAL_MODEL_RUNS_REBUILD_TABLE}`).run();
	db.prepare(CREATE_LOCAL_MODEL_RUNS_REBUILD_SQL).run();
	db.prepare(
		`INSERT INTO ${LOCAL_MODEL_RUNS_REBUILD_TABLE} (${columns}) SELECT ${columns} FROM local_model_runs`
	).run();

	const before = countRows(db, 'local_model_runs');
	const after = countRows(db, LOCAL_MODEL_RUNS_REBUILD_TABLE);
	if (before !== after) {
		throw new Error(
			`local_model_runs rebuild copied ${after} of ${before} rows; the table was left as it was.`
		);
	}

	db.prepare('DROP TABLE local_model_runs').run();
	db.prepare(`ALTER TABLE ${LOCAL_MODEL_RUNS_REBUILD_TABLE} RENAME TO local_model_runs`).run();
	runStatements(db, CREATE_LOCAL_MODEL_RUNS_INDEXES_SQL);

	logger.info(`Rebuilt local_model_runs with ${after} row(s) carried over`, LOG_CONTEXT);
}

function countRows(db: Database.Database, table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

/**
 * Check whether a column exists on a table using SQLite's PRAGMA table_info.
 */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
	const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }> | undefined;
	return Array.isArray(rows) && rows.some((row) => row.name === column);
}

/**
 * Check whether a table exists.
 */
function hasTable(db: Database.Database, table: string): boolean {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}
