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

export { CREATE_MIGRATIONS_TABLE_SQL } from '../utils/sqlite-migrations';

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
// Query Event Model Columns (Migration v20)
// ============================================================================

/**
 * Where a turn's model ran, and what Auto's router chose for it, on
 * `query_events` (see `QueryEvent` in shared/stats-types.ts). All TEXT.
 *
 * `run_on_endpoint` and `run_on_model` are the Run on source the turn launched
 * on, set together, and `routed_tier` is the router's tier. Nullable with no
 * default, like the token columns: NULL means a turn on the provider's own
 * model (or one not sent on Auto), and every row from before the columns.
 */
export const ADD_QUERY_EVENT_MODEL_COLUMNS = [
	'run_on_endpoint',
	'run_on_model',
	'routed_tier',
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

/**
 * Auto Run kind column (Migration v14).
 *
 * Unlike the token columns this one DOES default: every row written before it
 * existed came from the document runner or predates goal runs, so reading those
 * rows as `spec-driven` is the truthful answer rather than an invented zero.
 */
export const ADD_AUTO_RUN_SESSION_KIND_COLUMN_SQL = `
  ALTER TABLE auto_run_sessions ADD COLUMN kind TEXT DEFAULT 'spec-driven'
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
// Wizard Runs (Migration v10)
// ============================================================================

/**
 * One row per Auto Run wizard conversation, UPSERTED at every milestone rather
 * than written once at the end (see `WizardRun` in shared/stats-types.ts). A
 * run that is never closed keeps `outcome = 'in-progress'` and still carries
 * accurate exchange/document/task counts.
 *
 * `ended_at` means "last activity", so `ended_at - started_at` is the time
 * spent talking to the wizard whether or not the run was ever closed.
 */
export const CREATE_WIZARD_RUNS_SQL = `
  CREATE TABLE IF NOT EXISTS wizard_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    surface TEXT NOT NULL CHECK(surface IN ('inline', 'onboarding')),
    mode TEXT NOT NULL CHECK(mode IN ('new', 'iterate')),
    outcome TEXT NOT NULL CHECK(outcome IN ('in-progress', 'generated', 'abandoned')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    exchanges INTEGER NOT NULL,
    documents INTEGER NOT NULL,
    tasks INTEGER NOT NULL,
    project_path TEXT,
    active_ms INTEGER
  )
`;

export const CREATE_WIZARD_RUNS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_wizard_started ON wizard_runs(started_at);
  CREATE INDEX IF NOT EXISTS idx_wizard_surface ON wizard_runs(surface, started_at)
`;

// ============================================================================
// Local Model Runs (Migration v15, rebuilt in v20)
// ============================================================================

/**
 * The `local_model_runs` table under a given name. The name is a parameter
 * because SQLite cannot alter a CHECK constraint: migration v20 widens
 * `source_type` by building the table again beside the old one, copying every
 * row, and renaming it into place.
 */
function localModelRunsTableSql(table: string): string {
	return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('local', 'endpoint', 'server', 'system-one')),
    model_id TEXT NOT NULL,
    endpoint_id TEXT,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'error', 'cancelled')),
    error_code TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    agent_id TEXT
  )
`;
}

/**
 * One row per run that reached a model other than a provider's own (see
 * `LocalModelRun` in shared/stats-types.ts). A task that was off, or handed
 * back to its Utility Agent path, ran nothing here and is not recorded.
 *
 * `source_type` says where the model was (`LOCAL_MODEL_RUN_SOURCE_TYPES`), and
 * the other columns read by it:
 *
 *   - `local`      - `model_id` is the catalog id; `endpoint_id` is NULL.
 *   - `server`     - the same, for a run the Maestro model server answered.
 *   - `endpoint`   - `model_id` is the server's model name; `endpoint_id` is the
 *                    saved endpoint's id.
 *   - `system-one` - a request sent to a remote System One engine. `model_id` is
 *                    the model the engine says answered (the engine's id with no
 *                    answer); `endpoint_id` is the engine's id; `task_id` may be
 *                    `agent:<verb>` for a request an agent sent itself.
 *
 * `error_code` is the classified failure (`model-not-installed`, `network`,
 * `timeout`, ...) and NULL on success. `agent_id` is the agent the run was for,
 * and NULL when the caller knew none.
 *
 * Until v20 the CHECK allowed `local` and `endpoint` only, and there was no
 * `agent_id`. A table created at this version already has the current shape.
 */
export const CREATE_LOCAL_MODEL_RUNS_SQL = localModelRunsTableSql('local_model_runs');

/** The name the v20 rebuild gives the new table until it is renamed into place. */
export const LOCAL_MODEL_RUNS_REBUILD_TABLE = 'local_model_runs_rebuild';

export const CREATE_LOCAL_MODEL_RUNS_REBUILD_SQL = localModelRunsTableSql(
	LOCAL_MODEL_RUNS_REBUILD_TABLE
);

/**
 * The columns of the table as v15 created it: what the v20 rebuild copies. They
 * are named one by one so the copy does not depend on column order.
 */
export const LOCAL_MODEL_RUNS_V15_COLUMNS = [
	'id',
	'task_id',
	'source_type',
	'model_id',
	'endpoint_id',
	'started_at',
	'duration_ms',
	'outcome',
	'error_code',
	'tokens_in',
	'tokens_out',
] as const;

export const CREATE_LOCAL_MODEL_RUNS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_local_model_runs_started ON local_model_runs(started_at);
  CREATE INDEX IF NOT EXISTS idx_local_model_runs_task ON local_model_runs(task_id, started_at)
`;

/**
 * Migration v20. Kept apart from the indexes above, which v15 creates: that
 * migration must stay valid against a table that has no `agent_id` yet.
 */
export const CREATE_LOCAL_MODEL_RUNS_AGENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_local_model_runs_agent ON local_model_runs(agent_id, started_at)
`;

// ============================================================================
// Proxy Requests (Migration v16)
// ============================================================================

/**
 * One row per model request the Maestro token proxy carried (see `ProxyRequest`
 * in shared/stats-types.ts). Only requests that hold a message list are
 * recorded.
 *
 * `agent_id` is NULL for a request whose base URL named no agent (a launch
 * outside the desktop app). `original_tokens`, `sent_tokens` and
 * `added_latency_ms` are NULL unless the proxy read the body, which it does
 * only in `compress` mode. `compressor_counts` and `new_blocks` are JSON;
 * `new_blocks` lists only the blocks shortened for the first time in this
 * request, so a block appears in one row however many later requests resend it.
 * `routed_to` (migration v17) is the Local Models target a background request
 * was sent to in place of the provider, and NULL for every other request.
 */
export const CREATE_PROXY_REQUESTS_SQL = `
  CREATE TABLE IF NOT EXISTS proxy_requests (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    route TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('passthrough', 'compress')),
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    request_bytes INTEGER NOT NULL,
    sent_bytes INTEGER NOT NULL,
    response_bytes INTEGER NOT NULL,
    original_tokens INTEGER,
    sent_tokens INTEGER,
    added_latency_ms INTEGER,
    blocks_compressed INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    compressor_counts TEXT,
    new_blocks TEXT,
    skip_reason TEXT,
    routed_to TEXT
  )
`;

/** Migration v17, for a `proxy_requests` table created before the column existed. */
export const ADD_PROXY_REQUEST_ROUTED_TO_COLUMN_SQL = `
  ALTER TABLE proxy_requests ADD COLUMN routed_to TEXT
`;

export const CREATE_PROXY_REQUESTS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_proxy_requests_started ON proxy_requests(started_at);
  CREATE INDEX IF NOT EXISTS idx_proxy_requests_agent ON proxy_requests(agent_id, started_at)
`;

// ============================================================================
// System One Decisions (Migration v18, columns added in v19)
// ============================================================================

/**
 * One row per request that was handed to a System One engine (see
 * `SystemOneDecision` in shared/local-models/system-one-ledger.ts), answered or
 * not. A task whose assignment is not System One ran nothing here and is not
 * recorded.
 *
 * `task_id` is the task that ran, or `agent:<verb>` for a request an agent sent
 * through `maestro-cli s1`; the prefix is what a day's agent spend is summed
 * by. `tab_id` is that agent's AI tab, and `cached` is 1 for a request answered
 * from the answer cache (nothing sent, no tokens, no cost). Both came in v19.
 *
 * `engine` is the engine that was asked, or `off` for a task assigned to System
 * One while no engine was chosen. `outcome` is what the task's fail policy did
 * and `error_code` is why there was no answer (NULL on `ok`), so a timeout is
 * `failed-open` or `failed-closed` with the code `timeout`. `question_ids` and
 * `answers` are JSON; `model`, `answers`, the token counts and `cost_usd` are
 * NULL with no answer. `agent_id` is NULL when the caller knows no agent.
 * `input` is the redacted state and questions, and NULL unless "Keep inputs in
 * the ledger" was on for the run. Rows are pruned after 30 days.
 */
export const CREATE_S1_DECISIONS_SQL = `
  CREATE TABLE IF NOT EXISTS s1_decisions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    question_ids TEXT NOT NULL,
    answers TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'failed-open', 'failed-closed', 'unavailable', 'cancelled')),
    error_code TEXT,
    latency_ms INTEGER NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    agent_id TEXT,
    input TEXT,
    tab_id TEXT,
    cached INTEGER NOT NULL DEFAULT 0
  )
`;

/** Migration v19, for an `s1_decisions` table created before the columns existed. */
export const ADD_S1_DECISION_TAB_ID_COLUMN_SQL = `
  ALTER TABLE s1_decisions ADD COLUMN tab_id TEXT
`;

export const ADD_S1_DECISION_CACHED_COLUMN_SQL = `
  ALTER TABLE s1_decisions ADD COLUMN cached INTEGER NOT NULL DEFAULT 0
`;

export const CREATE_S1_DECISIONS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_s1_decisions_started ON s1_decisions(started_at);
  CREATE INDEX IF NOT EXISTS idx_s1_decisions_task ON s1_decisions(task_id, started_at)
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
