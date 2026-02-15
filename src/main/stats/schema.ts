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
// Compound Indexes (Migration v4)
// ============================================================================

export const CREATE_COMPOUND_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_query_time_agent ON query_events(start_time, agent_type);
  CREATE INDEX IF NOT EXISTS idx_query_time_project ON query_events(start_time, project_path);
  CREATE INDEX IF NOT EXISTS idx_query_time_source ON query_events(start_time, source)
`;

// ============================================================================
// Account Usage Windows (Migration v5)
// ============================================================================

export const CREATE_ACCOUNT_USAGE_WINDOWS_SQL = `
  CREATE TABLE IF NOT EXISTS account_usage_windows (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    query_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`;

export const CREATE_ACCOUNT_USAGE_WINDOWS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_account_usage_windows_account ON account_usage_windows(account_id);
  CREATE INDEX IF NOT EXISTS idx_account_usage_windows_time ON account_usage_windows(window_start, window_end)
`;

// ============================================================================
// Account Throttle Events (Migration v5)
// ============================================================================

export const CREATE_ACCOUNT_THROTTLE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS account_throttle_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    session_id TEXT,
    timestamp INTEGER NOT NULL,
    reason TEXT NOT NULL,
    tokens_at_throttle INTEGER DEFAULT 0,
    window_start INTEGER,
    window_end INTEGER
  )
`;

export const CREATE_ACCOUNT_THROTTLE_EVENTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_throttle_events_account ON account_throttle_events(account_id);
  CREATE INDEX IF NOT EXISTS idx_throttle_events_time ON account_throttle_events(timestamp)
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
