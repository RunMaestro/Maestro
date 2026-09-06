/**
 * Stats Database Schema
 *
 * SQL definitions for all tables and indexes, plus helper utilities
 * for executing multi-statement SQL strings.
 */

import type Database from 'better-sqlite3';

// ============================================================================
// Migrations Infrastructure
// ============================================================================

export const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
    error_message TEXT
  )
`;

// ============================================================================
// Metadata Table (for internal key-value storage like vacuum timestamps)
// ============================================================================

export const CREATE_META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

// ============================================================================
// Query Events (Migration v1)
// ============================================================================

export const CREATE_QUERY_EVENTS_SQL = `
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

export const CREATE_QUERY_EVENTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_query_start_time ON query_events(start_time);
  CREATE INDEX IF NOT EXISTS idx_query_agent_type ON query_events(agent_type);
  CREATE INDEX IF NOT EXISTS idx_query_source ON query_events(source);
  CREATE INDEX IF NOT EXISTS idx_query_session ON query_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_query_project_path ON query_events(project_path);
  CREATE INDEX IF NOT EXISTS idx_query_time_agent ON query_events(start_time, agent_type);
  CREATE INDEX IF NOT EXISTS idx_query_time_project ON query_events(start_time, project_path);
  CREATE INDEX IF NOT EXISTS idx_query_time_source ON query_events(start_time, source)
`;

// ============================================================================
// Query Event Token Columns (Migration v8)
// ============================================================================

/**
 * Per-turn token and cost columns on `query_events`.
 *
 * Nullable with no default on purpose: NULL means "this turn predates token
 * recording, or the provider reported nothing", which is a different fact from
 * a genuine zero. Defaulting to 0 would make every historical row look like a
 * free turn and silently understate cost-per-agent averages.
 */
export const ADD_QUERY_EVENT_TOKEN_COLUMNS = [
	'input_tokens',
	'output_tokens',
	'cache_read_tokens',
	'cache_creation_tokens',
	'cost_usd',
] as const;

// ============================================================================
// Auto Run Sessions (Migration v1)
// ============================================================================

export const CREATE_AUTO_RUN_SESSIONS_SQL = `
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

export const CREATE_AUTO_RUN_SESSIONS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auto_session_start ON auto_run_sessions(start_time)
`;

// ============================================================================
// Auto Run Tasks (Migration v1)
// ============================================================================

export const CREATE_AUTO_RUN_TASKS_SQL = `
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

export const CREATE_AUTO_RUN_TASKS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_task_auto_session ON auto_run_tasks(auto_run_session_id);
  CREATE INDEX IF NOT EXISTS idx_task_start ON auto_run_tasks(start_time)
`;

// ============================================================================
// Session Lifecycle (Migration v3)
// ============================================================================

export const CREATE_SESSION_LIFECYCLE_SQL = `
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

export const CREATE_SESSION_LIFECYCLE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_session_created_at ON session_lifecycle(created_at);
  CREATE INDEX IF NOT EXISTS idx_session_agent_type ON session_lifecycle(agent_type)
`;

// ============================================================================
// Image Annotations (Migration v6)
// ============================================================================

export const CREATE_IMAGE_ANNOTATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS image_annotations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )
`;

export const CREATE_IMAGE_ANNOTATIONS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_image_annotations_created_at ON image_annotations(created_at)
`;

// ============================================================================
// Shortcut Usage Daily (Migration v7)
// ============================================================================

export const CREATE_SHORTCUT_USAGE_DAILY_SQL = `
  CREATE TABLE IF NOT EXISTS shortcut_usage_daily (
    date TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  )
`;

// ============================================================================
// Multi-Window Usage Daily (Migration v8)
// ============================================================================
export const CREATE_MULTI_WINDOW_USAGE_DAILY_SQL = `
  CREATE TABLE IF NOT EXISTS multi_window_usage_daily (
    date TEXT PRIMARY KEY,
    windows_opened INTEGER NOT NULL DEFAULT 0,
    peak_concurrent INTEGER NOT NULL DEFAULT 0
  )
`;

// ============================================================================
// Resilience Events (Migration v10)
// ============================================================================

/**
 * One row per RESOLVED Agent Resilience outage (recovered or stopped by the
 * user) - never per retry attempt, and never while a countdown is live, so an
 * app quit mid-outage simply records nothing rather than a phantom row.
 *
 * `waited_ms` is derivable (resolved_at - started_at) but the split columns
 * keep range queries index-friendly.
 */
export const CREATE_RESILIENCE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS resilience_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK(strategy IN ('availability', 'token-exhaustion')),
    outcome TEXT NOT NULL CHECK(outcome IN ('recovered', 'stopped')),
    started_at INTEGER NOT NULL,
    resolved_at INTEGER NOT NULL,
    retries INTEGER NOT NULL
  )
`;

export const CREATE_RESILIENCE_EVENTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_resilience_started ON resilience_events(started_at);
  CREATE INDEX IF NOT EXISTS idx_resilience_strategy ON resilience_events(strategy, started_at)
`;

// ============================================================================
// Compound Indexes (Migration v4)
// ============================================================================

export const CREATE_COMPOUND_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_query_time_agent ON query_events(start_time, agent_type);
  CREATE INDEX IF NOT EXISTS idx_query_time_project ON query_events(start_time, project_path);
  CREATE INDEX IF NOT EXISTS idx_query_time_source ON query_events(start_time, source)
`;

// ============================================================================
// Utilities
// ============================================================================

/**
 * Execute a multi-statement SQL string by splitting on semicolons.
 *
 * Useful for running multiple CREATE INDEX statements defined in a single string.
 */
export function runStatements(db: Database.Database, multiStatementSql: string): void {
	for (const sql of multiStatementSql.split(';').filter((s) => s.trim())) {
		db.prepare(sql).run();
	}
}
