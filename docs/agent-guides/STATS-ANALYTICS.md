<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Stats and Analytics System

The stats system tracks AI interaction metrics using a SQLite database with a singleton access pattern, migration-based schema evolution, and a comprehensive aggregation layer powering the Usage Dashboard.

## Architecture Overview

```text
Renderer (Usage Dashboard)        Main Process
+-----------------------+         +---------------------------+
| UsageDashboardModal   |  IPC    | IPC Handlers (stats.ts)   |
| SummaryCards          | ------> | getStatsDB() singleton    |
| ActivityHeatmap       |         | StatsDB class             |
| AgentUsageChart       |         |   +-- query-events.ts     |
| PeakHoursChart        |         |   +-- auto-run.ts         |
| SessionStats          |         |   +-- session-lifecycle.ts |
| ...charts...          | <------ |   +-- aggregations.ts     |
+-----------------------+ stats:  |   +-- data-management.ts  |
                         updated  +---------------------------+
                                          |
                                    +-----v-----+
                                    | stats.db   |  (SQLite, WAL mode)
                                    +-----------+
```

## SQLite Database

### Location

```text
{userData}/stats.db
```

Uses WAL (Write-Ahead Logging) journal mode for better concurrent access.

### Tables

#### `query_events` (Migration v1)

Tracks individual AI query/response cycles:

| Column            | Type             | Description                                                                      |
| ----------------- | ---------------- | -------------------------------------------------------------------------------- |
| `id`              | TEXT PK          | UUID                                                                             |
| `session_id`      | TEXT NOT NULL    | Maestro session ID                                                               |
| `agent_type`      | TEXT NOT NULL    | Agent type (e.g. `claude-code`)                                                  |
| `source`          | TEXT NOT NULL    | `'user'` or `'auto'` (Auto Run)                                                  |
| `start_time`      | INTEGER NOT NULL | Unix timestamp (ms)                                                              |
| `duration`        | INTEGER NOT NULL | Duration in ms                                                                   |
| `project_path`    | TEXT             | Normalized project path                                                          |
| `tab_id`          | TEXT             | AI tab that issued the query                                                     |
| `is_remote`       | INTEGER          | SSH remote flag (added in v2)                                                    |
| `is_worktree`     | INTEGER          | Worktree agent flag (v5)                                                         |
| `user_name`       | TEXT             | Web Login sender (v12)                                                           |
| `run_on_endpoint` | TEXT             | Run on source the turn launched on: saved endpoint id, or `maestro-server` (v20) |
| `run_on_model`    | TEXT             | The model that source ran, written WITH `run_on_endpoint` (v20)                  |
| `routed_tier`     | TEXT             | Tier Auto's router chose: `low`, `medium` or `high` (v20)                        |

`user_name` is the Web Login account that SENT the turn, and NULL means "nobody
was signed in" - a turn typed at the desktop, which is every turn while Web
Login is off. It is stamped by `stats:record-query` from what the spawn noted
(`resolveTurnActor`), never from the acting user at write time: the row is
written by the desktop renderer's exit listener even for a turn a browser sent.

The three v20 columns are the Models tab's only record of where an agent turn ran, and
`turnModelStatsFields({ runOn, auto })` in `src/shared/autoTurn.ts` shapes them for both writers of the
row (the renderer's exit listener and the Auto Run spawn). They are frozen at SEND from the tab's
`turnRunOnSource` and `turnAuto` stamps, never read from the live agent record, so a Run on target edited
mid-turn does not refile the turn. `run_on_endpoint` and `run_on_model` are written together or not at
all, and `routed_tier` is bound only when it is one of the three levels. NULL in all three means the turn
ran on the provider's own cloud, which is what the Models tab compares everything else against.
`routed_tier` is the router's ANSWER, not the launch: a session Auto kept on its model records the tier
and the place it stayed. `query_events` has one writer, the renderer, so a Cue run and a headless
`maestro-cli send` write no row on any model and are not counted there.

**Indexes**: `start_time`, `agent_type`, `source`, `session_id`, `project_path`, `is_remote`, `is_worktree`, `user_name`, compound `(start_time, agent_type)`, `(start_time, project_path)`, `(start_time, source)`

Note there is deliberately **no index on `tab_id` and no aggregation that groups by it**. The one consumer, the Usage Dashboard's per-tab breakdown (`UsageDashboard/TabBreakdown.tsx`), groups client-side over the rows `AgentDetailModal` has already fetched for a single agent via `getStats('all', { sessionId })`. That set is one agent's events, not the whole table, so it stays cheap and needs no new IPC. Reach for a real index only if something ever needs to query by tab across all agents.

#### `auto_run_sessions` (Migration v1)

Tracks complete Auto Run batch processing runs:

| Column            | Type             | Description                            |
| ----------------- | ---------------- | -------------------------------------- |
| `id`              | TEXT PK          | UUID                                   |
| `session_id`      | TEXT NOT NULL    | Maestro session ID                     |
| `agent_type`      | TEXT NOT NULL    | Agent type                             |
| `document_path`   | TEXT             | Path to Auto Run document              |
| `start_time`      | INTEGER NOT NULL | Unix timestamp (ms)                    |
| `duration`        | INTEGER NOT NULL | Duration in ms (updated on completion) |
| `tasks_total`     | INTEGER          | Total tasks in document                |
| `tasks_completed` | INTEGER          | Tasks completed (updated on end)       |
| `project_path`    | TEXT             | Project path                           |

**Indexes**: `start_time`

#### `auto_run_tasks` (Migration v1)

Tracks individual tasks within an Auto Run session:

| Column                | Type             | Description                        |
| --------------------- | ---------------- | ---------------------------------- |
| `id`                  | TEXT PK          | UUID                               |
| `auto_run_session_id` | TEXT NOT NULL FK | References `auto_run_sessions(id)` |
| `session_id`          | TEXT NOT NULL    | Maestro session ID                 |
| `agent_type`          | TEXT NOT NULL    | Agent type                         |
| `task_index`          | INTEGER NOT NULL | Task position in document          |
| `task_content`        | TEXT             | Task text content                  |
| `start_time`          | INTEGER NOT NULL | Unix timestamp (ms)                |
| `duration`            | INTEGER NOT NULL | Duration in ms                     |
| `success`             | INTEGER NOT NULL | 0 or 1                             |

**Indexes**: `auto_run_session_id`, `start_time`

#### `wizard_runs` (Migration v11, `active_ms` v13)

One row per Auto Run wizard conversation, powering the Wizard section of the dashboard's Auto Run tab:

| Column         | Type             | Description                                                |
| -------------- | ---------------- | ---------------------------------------------------------- |
| `id`           | TEXT PK          | UUID                                                       |
| `session_id`   | TEXT NOT NULL    | Maestro agent id (`'onboarding'` for the first-run wizard) |
| `agent_type`   | TEXT NOT NULL    | Agent type                                                 |
| `surface`      | TEXT NOT NULL    | `'inline'` (the `/wizard` command) or `'onboarding'`       |
| `mode`         | TEXT NOT NULL    | `'new'` or `'iterate'`                                     |
| `outcome`      | TEXT NOT NULL    | `'in-progress'`, `'generated'`, or `'abandoned'`           |
| `started_at`   | INTEGER NOT NULL | Unix timestamp (ms) the wizard opened                      |
| `ended_at`     | INTEGER NOT NULL | Unix timestamp (ms) of LAST ACTIVITY, not close            |
| `exchanges`    | INTEGER NOT NULL | User messages sent during the conversation                 |
| `documents`    | INTEGER NOT NULL | Auto Run documents produced                                |
| `tasks`        | INTEGER NOT NULL | Task checkboxes across those documents                     |
| `project_path` | TEXT             | Project path                                               |
| `active_ms`    | INTEGER          | Time actually spent in the wizard (v13; NULL = not timed)  |

**Indexes**: `started_at`, compound `(surface, started_at)`

Unlike every other table here, a row is written **repeatedly** - once per milestone (opened, each
exchange, documents written, closed), always under the same `id`, via `INSERT OR REPLACE`. The reason
is that the payoff (documents) and the close are separated by however long the user reads the result,
and many runs are never closed at all, so a single write at the end would lose whole runs.

Time spent is `active_ms`, never `ended_at - started_at`. A wizard tab can sit open for days, and the
open-to-close window once logged 26 hours for a 9-message run. `active_ms` is accrued gap by gap
between milestones: a gap while the agent works (a turn or a document generation) counts in full up
to 60 minutes, and a gap while the wizard waits on the user counts at most 5 minutes. Rows from before
v13 stay NULL rather than being backfilled from the window, and the dashboard leaves them out of time
totals. The renderer side of that state machine is `src/renderer/services/wizardStats.ts`.

#### `session_lifecycle` (Migration v3)

Tracks session creation and closure for duration analytics:

| Column         | Type                 | Description                       |
| -------------- | -------------------- | --------------------------------- |
| `id`           | TEXT PK              | UUID                              |
| `session_id`   | TEXT NOT NULL UNIQUE | Maestro session ID                |
| `agent_type`   | TEXT NOT NULL        | Agent type                        |
| `project_path` | TEXT                 | Project path                      |
| `created_at`   | INTEGER NOT NULL     | Creation timestamp (ms)           |
| `closed_at`    | INTEGER              | Closure timestamp (ms)            |
| `duration`     | INTEGER              | Computed `closed_at - created_at` |
| `is_remote`    | INTEGER              | SSH remote flag                   |

**Indexes**: `created_at`, `agent_type`

#### `local_model_runs` (Migration v15, rebuilt v20)

One row per run that reached a model other than a provider's own. Written by the task router
(`src/main/stats/local-model-runs.ts`) and, for System One, by `recordSystemOneDecision()`:

| Column        | Type             | Description                                                                                 |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `id`          | TEXT PK          | UUID                                                                                        |
| `task_id`     | TEXT NOT NULL    | Local Models task (`agent:<verb>` for a request an agent sent System One)                   |
| `source_type` | TEXT NOT NULL    | `'local'`, `'endpoint'`, `'server'` or `'system-one'` (CHECK, widened v20)                  |
| `model_id`    | TEXT NOT NULL    | Catalog id, the server's model name, or the model a System One engine named                 |
| `endpoint_id` | TEXT             | Saved endpoint id, or the System One engine id. NULL for `local` and `server`               |
| `started_at`  | INTEGER NOT NULL | Unix timestamp (ms)                                                                         |
| `duration_ms` | INTEGER NOT NULL | Duration in ms. A failed run's duration is its timeout, so latency reads answered runs only |
| `outcome`     | TEXT NOT NULL    | `'ok'`, `'error'` or `'cancelled'`                                                          |
| `error_code`  | TEXT             | Classified failure (`timeout`, `network`, ...), NULL on success                             |
| `tokens_in`   | INTEGER          | Tokens read, when the source reports them                                                   |
| `tokens_out`  | INTEGER          | Tokens written, when the source reports them                                                |
| `agent_id`    | TEXT             | Agent the run was for, NULL when the caller knew none (v20)                                 |

**Indexes**: `started_at`, compound `(task_id, started_at)`, compound `(agent_id, started_at)`

`server` is one source however a run reached the Maestro model server: a task assigned to the
`maestro-server` endpoint, and a task assigned to a local model the running server already holds. A
`system-one` row exists for retention: `s1_decisions` is pruned at 30 days and the dashboard's ranges go
to all time. A decision answered from the cache, with no engine chosen, or decided by a local router
leaves no run, because the local model's own run is already filed under its real source.

Rows written before v20 are not relabeled. A run on the model server recorded earlier stays
`endpoint` with `endpoint_id = 'maestro-server'`, and `modelUsageRunSource()` in
`src/shared/local-models/model-usage.ts` reads that as the server.

The v20 migration rebuilds the table, because SQLite cannot alter a CHECK constraint. `rebuildLocalModelRuns`
creates `local_model_runs_rebuild`, copies every row by named column, compares the two row counts and
throws on a mismatch, drops the old table, renames the new one into place and recreates the indexes, all
inside the runner's one transaction. `CREATE_LOCAL_MODEL_RUNS_SQL` is the current shape, so a fresh database
has nothing to rebuild.

#### `proxy_requests` (Migration v16; `routed_to` v17, provider counts v21, telemetry v22)

One row per model request the Maestro token proxy carried that held a message list. Written by
`recordProxyRequest()` (`src/main/stats/proxy-requests.ts`) from `proxyRequestFromLog()`:

| Column                                                                      | Type             | Description                                                                                      |
| --------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `id`                                                                        | TEXT PK          | UUID                                                                                             |
| `agent_id`                                                                  | TEXT             | Agent the base URL named, NULL for a launch outside the app                                      |
| `route`, `kind`                                                             | TEXT NOT NULL    | Route prefix (`anthropic`, `openai`, `chatgpt`) and the API the request spoke                    |
| `mode`                                                                      | TEXT NOT NULL    | `'passthrough'` or `'compress'` (CHECK). Both compress modes are stored as `compress`            |
| `started_at`, `duration_ms`                                                 | INTEGER NOT NULL | Unix timestamp (ms) and end-to-end duration                                                      |
| `status`                                                                    | INTEGER NOT NULL | HTTP status sent to the client, 0 when none was                                                  |
| `outcome`                                                                   | TEXT NOT NULL    | `completed`, `client-aborted` or `upstream-failed`                                               |
| `request_bytes`, `sent_bytes`, `response_bytes`                             | INTEGER NOT NULL | Body bytes received, sent on, and returned                                                       |
| `original_tokens`, `sent_tokens`                                            | INTEGER          | Estimates (characters / 4). NULL unless the proxy read the body                                  |
| `added_latency_ms`                                                          | INTEGER          | Time the request was held. NULL is unknown, left out of means and percentiles                    |
| `blocks_compressed`, `cache_hits`                                           | INTEGER NOT NULL | Blocks sent shortened; verdicts reused from Maestro's cache (not provider prompt-cache use)      |
| `compressor_counts`, `new_blocks`                                           | TEXT (JSON)      | Per-compressor counts; blocks shortened for the first time in this request                       |
| `skip_reason`                                                               | TEXT             | Why a compress mode body went out unread. Open text; `TOKEN_PROXY_SKIP_REASONS` for this build   |
| `routed_to`                                                                 | TEXT             | Local Models target a background request was sent to (v17)                                       |
| `provider_input_tokens`, `provider_cache_read_tokens`                       | INTEGER          | What the provider counted (v21). NULL when the answer named none                                 |
| `provider_cache_write_tokens`, `provider_output_tokens`                     | INTEGER          | A class the answer did not name is stored as 0; reportedness says which were given               |
| `effective_mode`                                                            | TEXT             | The mode in force: `passthrough`, `compress` or `compress-early` (v22)                           |
| `blocks_protected`                                                          | INTEGER          | Left out because the result is recent or carries the cache breakpoint (v22)                      |
| `blocks_vetoed_failed`, `blocks_vetoed_recovery`, `blocks_vetoed_retrieval` | INTEGER          | Left out because the result failed, was a recovery command's output, or was retrieved text (v22) |
| `blocks_candidates`, `blocks_below_threshold`                               | INTEGER          | Blocks eligible for a verdict; those under the size threshold (v22)                              |
| `blocks_kept`, `blocks_store_failed`, `blocks_model_failed`                 | INTEGER          | Kept whole; left alone because the cache failed; model summary failed (v22)                      |
| `provider_input_reportedness`, `provider_cache_read_reportedness`           | TEXT             | `reported`, `derived`, `not-applicable` or `unreported` for each provider count (v22)            |
| `provider_cache_write_reportedness`, `provider_output_reportedness`         | TEXT             | The same, for cache writes and output (v22)                                                      |

**Indexes**: `started_at`, compound `(agent_id, started_at)`

The fourteen v22 columns are `ProxyRequest.effectiveMode`, `blockCounts` (one column per count, the
three vetoes included) and `providerUsageReportedness` (one column per class). **NULL is unknown,
never zero.** The migration adds them bare: no DEFAULT, no CHECK, no index and no backfill, so a row
written before v22 is unknown in all fourteen. `effective_mode` is deliberately not filled from `mode`
(a stored `compress` is `compress` or `compress-early`) or from the agent's current setting, which
may have changed since the request. The nine counts are written together or not at all, so
`COUNT(blocks_candidates)` is the number of requests with counts; a counted request that found
nothing holds 0, and `SUM` over rows that hold none is NULL, not 0. The text columns are open like
`skip_reason`: a reader treats a value it does not recognize as unknown. A provider token column with
no `*_reportedness` was written before reportedness was tracked and reads as `legacy` through
`proxyProviderClassReading()`.

**Who fills them.** `proxyRequestFromLog()` in `src/main/local-models/proxy/request-stats.ts` maps a
request log entry to a row and `recordProxyRequest()` writes it; `recordTokenProxyRequest()` runs the
mapping inside its guard, after the statistics gate, so no fault of the mapping can reach the
server's close handler.

- `effective_mode` is the log entry's own `mode`, stated for every recorded request, passthrough
  included.
- The nine counts come from the compressor's `CompressRequestStats` (`protected` is counted by
  `compressRequestBody()`: per tool result, its text spans minus its eligible ones, so it is 0 in
  early mode). They exist only for a request the proxy read, shortened as the row says and forwarded
  as the compressor decided. A passthrough request, a request a background target answered and a
  request forwarded as it arrived (any `skip_reason`) have none. Counts that break
  `proxyBlockCountsProblem()` are not stored and are reported once, to the log and to Sentry.
- **A request forwarded as it arrived credits no reduction in any column**, including a failure
  after the compressor had returned: `blocks_compressed` and `cache_hits` are 0, there are no
  `new_blocks` or `compressor_counts`, and `sent_tokens` equals `original_tokens` when the original
  is known. How long the request was held stays, as a measure of time and not of savings. The
  server's catch path drops the attempt from its log for the same reason.
- The four `*_reportedness` columns come from the provider's answer, through
  `createProviderUsageReader()` (`src/main/local-models/proxy/response-usage.ts`), which records how
  each class got its number: `reported` (the answer named it, a named zero included), `derived`
  (OpenAI's uncached input, its prompt total minus its cached tokens, which needs both),
  `not-applicable` (OpenAI has no cache-write class) or `unreported` (the answer did not name it, and
  the token column holds a default 0 that says nothing). An OpenAI prompt total with no cache detail
  is stored as neither uncached input nor a cache read. The mapping writes the four with the four
  provider tokens or not at all, and an answer that names no class leaves all eight NULL.
- The INSERT is built from one typed column map, and the telemetry column names come from
  `ADD_PROXY_REQUEST_TELEMETRY_COLUMNS`, so a column added to the schema must be supplied by the
  writer to compile. `proxy-requests-telemetry.test.ts` checks that a row which states everything
  fills every column of the real table.

#### `_migrations`

Migration tracking table:

| Column          | Type             | Description                |
| --------------- | ---------------- | -------------------------- |
| `version`       | INTEGER PK       | Migration version number   |
| `description`   | TEXT NOT NULL    | Human-readable description |
| `applied_at`    | INTEGER NOT NULL | Application timestamp (ms) |
| `status`        | TEXT NOT NULL    | `'success'` or `'failed'`  |
| `error_message` | TEXT             | Error details if failed    |

#### `_meta`

Internal key-value storage (e.g., last VACUUM timestamp):

| Column  | Type          | Description   |
| ------- | ------------- | ------------- |
| `key`   | TEXT PK       | Setting key   |
| `value` | TEXT NOT NULL | Setting value |

## Singleton Pattern

The `StatsDB` instance is managed via `src/main/stats/singleton.ts`:

```typescript
// Get or create the singleton instance
const db = getStatsDB();

// Initialize on app startup (inside app.whenReady)
initializeStatsDB();

// Close on app shutdown (inside quit handler)
closeStatsDB();
```

The singleton is lazy-initialized on first call to `getStatsDB()`. The `StatsDB` class constructor sets the database path to `{userData}/stats.db`. The `initialize()` method handles:

1. Directory creation
2. Corruption detection and recovery (integrity check, backup restore)
3. WAL mode enablement
4. Migration execution
5. Daily backup creation (keeps 7 days)
6. Weekly VACUUM scheduling (only if DB exceeds 100MB)

## Migration System

Defined in `src/main/stats/migrations.ts`. Migrations are sequential and recorded in the `_migrations` table. The current schema version is stored in SQLite's `user_version` pragma.

| Version | Description                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| v1      | Initial schema: `query_events`, `auto_run_sessions`, `auto_run_tasks`                                                |
| v2      | Add `is_remote` column to `query_events` for SSH tracking                                                            |
| v3      | Add `session_lifecycle` table                                                                                        |
| v4      | Add compound indexes on `query_events` for dashboard performance                                                     |
| v5      | Add `is_worktree` column to `query_events` and `session_lifecycle`                                                   |
| v6      | Add `image_annotations` table                                                                                        |
| v7      | Add `shortcut_usage_daily` table                                                                                     |
| v8      | Add `multi_window_usage_daily` table                                                                                 |
| v9      | Add per-turn token and cost columns to `query_events`                                                                |
| v10     | Add `resilience_events` table                                                                                        |
| v11     | Add `wizard_runs` table                                                                                              |
| v12     | Add `user_name` column to `query_events` for Web Login attribution                                                   |
| v13     | Add `active_ms` column to `wizard_runs`                                                                              |
| v14     | Add `kind` column to `auto_run_sessions`                                                                             |
| v15     | Add `local_model_runs` table for Local Models task router runs                                                       |
| v16     | Add `proxy_requests` table for the Maestro token proxy                                                               |
| v17     | Add `routed_to` column to `proxy_requests`                                                                           |
| v18     | Add `s1_decisions` table for the System One decision ledger                                                          |
| v19     | Add `tab_id` and `cached` columns to `s1_decisions`                                                                  |
| v20     | Rebuild `local_model_runs` (wider `source_type`, `agent_id`); add Run on and `routed_tier` columns to `query_events` |
| v21     | Add the provider's token counts (`provider_*_tokens`) to `proxy_requests`                                            |
| v22     | Add `effective_mode`, block counts and provider reportedness to `proxy_requests`                                     |

To add a new migration:

1. Create a `migrateVN()` function in `migrations.ts`
2. Add it to the `getMigrations()` array
3. Update `STATS_DB_VERSION` in `src/shared/stats-types.ts`
4. A column added to a table an earlier migration created goes into that table's `CREATE` statement in
   `schema.ts` too, because a fresh database runs the old migration with the current definition. The new
   body adds a column only when `hasColumn()` says it is missing, and the entry declares `isApplied`, so a
   database another branch stamped past your version still gets it.

## Shared Types

Defined in `src/shared/stats-types.ts` (used by both main process and renderer):

### Event Types

```typescript
interface QueryEvent {
	id: string;
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
	isRemote?: boolean;
}

interface AutoRunSession {
	id: string;
	sessionId: string;
	agentType: string;
	documentPath?: string;
	startTime: number;
	duration: number;
	tasksTotal?: number;
	tasksCompleted?: number;
	projectPath?: string;
}

interface AutoRunTask {
	id: string;
	autoRunSessionId: string;
	sessionId: string;
	agentType: string;
	taskIndex: number;
	taskContent?: string;
	startTime: number;
	duration: number;
	success: boolean;
}

interface SessionLifecycleEvent {
	id: string;
	sessionId: string;
	agentType: string;
	projectPath?: string;
	createdAt: number;
	closedAt?: number;
	duration?: number;
	isRemote?: boolean;
}
```

### Query Types

```typescript
type StatsTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

interface StatsFilters {
	agentType?: string;
	source?: 'user' | 'auto';
	projectPath?: string;
	sessionId?: string;
}
```

### Aggregation Type

```typescript
interface StatsAggregation {
	totalQueries: number;
	totalDuration: number;
	avgDuration: number;
	byAgent: Record<string, { count: number; duration: number }>;
	bySource: { user: number; auto: number };
	byDay: Array<{ date: string; count: number; duration: number }>;
	byLocation: { local: number; remote: number };
	byHour: Array<{ hour: number; count: number; duration: number }>;
	totalSessions: number;
	sessionsByAgent: Record<string, number>;
	sessionsByDay: Array<{ date: string; count: number }>;
	avgSessionDuration: number;
	byAgentByDay: Record<string, Array<{ date: string; count: number; duration: number }>>;
	bySessionByDay: Record<string, Array<{ date: string; count: number; duration: number }>>;
}
```

### Token Proxy Telemetry Types

`ProxyRequest` is one `proxy_requests` row. The telemetry contract adds optional facts that older rows do not have. **Absent means unknown, never zero.**

| Field                       | Meaning                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                      | Whether the proxy read and shortened the body. Both compress modes are stored as `compress` (the column and its CHECK constraint are unchanged).                                                                                                                                                                 |
| `effectiveMode`             | The mode in force: `passthrough`, `compress` or `compress-early`. Absent on a row written before it existed. Never inferred from the agent's current setting.                                                                                                                                                    |
| `blockCounts`               | What compress mode did with each block of tool-result text: `protected`, `vetoed` (`failed`, `recovery`, `retrieval`), `candidates`, `belowThreshold`, `kept`, `storeFailed`, `modelFailed`. Counts only.                                                                                                        |
| `skipReason`                | Why the body was forwarded unread. One of `TOKEN_PROXY_SKIP_REASONS`.                                                                                                                                                                                                                                            |
| `cacheHits`                 | Verdict reuse from Maestro's compression cache. Not provider prompt-cache usage (`providerCacheReadTokens`).                                                                                                                                                                                                     |
| `providerUsageReportedness` | How each provider count got its number: `reported`, `derived`, `not-applicable` or `unreported`, per class (`input`, `cacheRead`, `cacheWrite`, `output`). Absent on a row written before it was tracked: its provider numbers are `legacy` (unknown), not reported. Read it with `proxyProviderClassReading()`. |

Stored by migration v22 (see the `proxy_requests` table above): `effectiveMode` is `effective_mode`, `blockCounts` is
the nine `blocks_*` columns, and `providerUsageReportedness` is the four `provider_*_reportedness` columns. A row
that predates v22 is NULL in all of them.

A figure drawn from rows is one of three kinds (`ProxyEvidenceKind`): `measured`, `estimate` (characters / 4: `originalTokens`, `sentTokens`) or `opportunity` (never stored). The kinds are never added into one savings number. Build figures with `proxyFigure()` and total them only with `addProxyFigures()`; see "How sure a token proxy figure is" in [CANONICAL-UTILITIES.md](CANONICAL-UTILITIES.md).

## IPC Handlers

Registered in `src/main/ipc/handlers/stats.ts`. All handlers check `statsCollectionEnabled` in settings before recording data.

### Recording

| Handler                        | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `stats:record-query`           | Insert a `QueryEvent`. Broadcasts `stats:updated` to renderer.          |
| `stats:start-autorun`          | Insert an `AutoRunSession` with `duration: 0`. Returns the ID.          |
| `stats:end-autorun`            | Update an `AutoRunSession` with final `duration` and `tasksCompleted`.  |
| `stats:record-task`            | Insert an `AutoRunTask` for a completed task within an Auto Run.        |
| `stats:record-session-created` | Insert a `SessionLifecycleEvent` (session launched).                    |
| `stats:record-session-closed`  | Update `SessionLifecycleEvent` with `closedAt` and computed `duration`. |

### Querying

| Handler                        | Description                                                            |
| ------------------------------ | ---------------------------------------------------------------------- |
| `stats:get-stats`              | Get `QueryEvent[]` with time range and optional filters                |
| `stats:get-autorun-sessions`   | Get `AutoRunSession[]` within a time range                             |
| `stats:get-autorun-tasks`      | Get `AutoRunTask[]` for a specific Auto Run session                    |
| `stats:get-aggregation`        | Get `StatsAggregation` for a time range (used by dashboard)            |
| `stats:get-session-lifecycle`  | Get `SessionLifecycleEvent[]` within a time range                      |
| `stats:get-earliest-timestamp` | Get the earliest recorded event timestamp (used for "all time" ranges) |
| `stats:get-model-usage`        | Get the `ModelUsage` record for a range (the Models tab; see below)    |

### Data Management

| Handler                             | Description                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `stats:export`                      | Export every stats table, token usage, and Cue runs for a range as JSON or a CSV zip |
| `stats:clear-old-data`              | Delete records older than N days (transactional across all tables)                   |
| `stats:get-database-size`           | Get the database file size in bytes                                                  |
| `stats:get-initialization-result`   | Get the result of the one-shot DB initialization (used by the settings health panel) |
| `stats:clear-initialization-result` | Clear the cached initialization result                                               |

### Model usage (`getModelUsage`)

What every model other than a provider's own did over a range. One record, one aggregation, three readers:
the Usage Dashboard's **Models** tab, `maestro-cli stats models`, and the WS message `get_model_usage`.

| Layer       | Symbol                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregation | `getModelUsage(db, range, names)` in `src/main/stats/model-usage.ts` (`StatsDB.getModelUsage`)                                                              |
| Service     | `readModelUsage(range)` in `src/main/local-models/model-usage.ts`                                                                                           |
| Types       | `ModelUsage` and the naming rules in `src/shared/local-models/model-usage.ts`                                                                               |
| IPC / WS    | `stats:get-model-usage`, `window.maestro.stats.getModelUsage(range)`, `get_model_usage` answered as `model_usage`                                           |
| CLI         | `maestro-cli stats models [--range day\|week\|month\|quarter\|year\|all] [--json]`                                                                          |
| Renderer    | `useModelUsage(range)` in `src/renderer/hooks/stats/useModelUsage.ts`, drawn by `<ModelUsageStats>` in `src/renderer/components/UsageDashboard/ModelUsage/` |

`readModelUsage` is the one function the IPC channel and the WS message both call. It checks the range
with `isStatsTimeRange()` (no range reads the week) and hands the aggregation the names only the app
knows: the saved endpoints, the OpenJev URL and agent names. The record has six blocks:

| Block       | Reads                                                | Holds                                                                  |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `totals`    | the other blocks                                     | requests, tokens, errors, and the on-this-machine share                |
| `sources`   | `local_model_runs`, `query_events`, `proxy_requests` | one row per source: kind, location, units, tokens, errors, latency     |
| `byTask`    | `local_model_runs`                                   | per task, with where each ran                                          |
| `byAgent`   | `local_model_runs`, `query_events`                   | any agent that used another model; the tab shows `turns > 0` as Run on |
| `systemOne` | `s1_decisions`, `query_events`                       | outcome split per task and engine, Auto's `routedTiers`, `coversRange` |
| `proxy`     | `proxy_requests`                                     | requests, tokens saved and added latency, marked as an estimate        |

Rules a new reader of the record needs:

- **Each table is scanned once.** SQLite has no percentile function, so each scan is `ORDER BY` its duration
  column and every distribution (per source, task, agent and System One task) is sliced from that one pass
  with `percentilesFromSorted()`. Do not add a second query for a new percentile.
- **Three units, kept apart.** A source counts `runs` (one model call), `turns` (one agent turn) and `routed`
  (one background request the proxy sent to a Local Models target). `requests` is their sum, so never
  divide tokens by it. `modelUsageSourceLatency()` names the unit a latency is in: a request when the source
  answered model calls, a turn only when it has none on record.
- **Latency is answered work only.** A failed run's duration is its timeout.
- **A provider's own cloud is a source kind** (`provider:<agent type>`) from `query_events` rows with no Run on
  source. `errors` is always 0 there, because `query_events` records no outcome, and cache tokens are
  `cachedTokensIn`, never folded into `tokensIn`.
- **`onDevice` is three-valued.** The in-process engine and the model server are `true`. An endpoint is
  `true` only when its URL is loopback. An endpoint that was removed, or OpenJev with no URL, is `null`
  (shown as Unknown, never as remote) and `totals.onDeviceRequests` does not count it.
- **The System One block reads the 30-day ledger.** `coversRange` is false for quarter, year and all, and the
  tab says so. `routedTiers` comes from `query_events` and covers the whole range.
- **There is no cost per source.** `systemOne.costUsd` is the only cost. There is no per-day block: a trend
  chart adds a `byDay` to `ModelUsage`, not a second query.
- **A WS failure replies under its own type with `success: false` and the request id.** `ctx.sendError`
  sends an `error` message with no id, which the CLI client cannot match, so it would wait out its timeout.

The tab renders above the dashboard's "no query yet" gate, with Tokens and Shortcuts, because a housekeeping
run on a local model leaves no `query_events` row. `getSectionsForViewMode('models')` returns `[]` like Cue:
the blocks come from the panel's own fetch, not the shared aggregation.

### Broadcast

When data is recorded, `stats:updated` is sent to the renderer via `mainWindow.webContents.send()`. The dashboard components listen for this event to trigger a refresh.

## Query Patterns

### Aggregation Queries

The `getAggregatedStats()` function in `src/main/stats/aggregations.ts` decomposes the aggregation into focused sub-queries:

| Sub-query             | SQL Pattern                                                  | Purpose                    |
| --------------------- | ------------------------------------------------------------ | -------------------------- |
| `queryTotals`         | `COUNT(*), SUM(duration)`                                    | Total queries and duration |
| `queryByAgent`        | `GROUP BY agent_type`                                        | Breakdown by agent         |
| `queryBySource`       | `GROUP BY source`                                            | User vs Auto Run split     |
| `queryByLocation`     | `GROUP BY is_remote`                                         | Local vs SSH remote        |
| `queryByDay`          | `GROUP BY date(start_time/1000, 'unixepoch', 'localtime')`   | Daily counts               |
| `queryByAgentByDay`   | `GROUP BY agent_type, date(...)`                             | Per-agent daily counts     |
| `queryByHour`         | `GROUP BY strftime('%H', ...)`                               | Hourly distribution        |
| `querySessionStats`   | `COUNT(DISTINCT session_id)`, `AVG(duration)` from lifecycle | Session metrics            |
| `queryBySessionByDay` | `GROUP BY session_id, date(...)`                             | Per-session daily counts   |

All sub-queries filter by `start_time >= ?` using `getTimeRangeStart(range)` which converts the `StatsTimeRange` enum to a millisecond timestamp.

### Statement Caching

The `StatementCache` class (in `utils.ts`) caches prepared statements per SQL string to avoid re-preparing on every call. Caches are cleared when the database is closed.

### Performance Monitoring

Optional performance metrics track timing for each sub-query:

- Enabled via `setPerformanceLoggingEnabled(true)`
- Logs warnings when aggregation exceeds `PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD`
- Last 100 metrics retained for analysis

## Integrity and Recovery

### Corruption Detection

On startup, the database runs `PRAGMA integrity_check`. If corruption is detected:

1. The corrupted database is moved to `stats.db.corrupted.{timestamp}`
2. Available backups are tested for integrity
3. The most recent valid backup is restored
4. If no backup is valid, a fresh database is created

### Backup System

- **Daily backups**: Created on startup if none exists for today (`stats.db.daily.YYYY-MM-DD`). Last 7 days retained.
- **On-demand backups**: Via `backupDatabase()` (`stats.db.backup.{timestamp}`)
- **Safe backup copy**: Runs `PRAGMA wal_checkpoint(TRUNCATE)` before copying to ensure all WAL content is flushed

### VACUUM

- Runs weekly (tracked via `_meta` table `last_vacuum_at` key)
- Only triggers if database exceeds 100MB
- Logs before/after size and bytes freed

## Usage Dashboard Components

Located in `src/renderer/components/UsageDashboard/`:

| Component                       | Purpose                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `UsageDashboardModal.tsx`       | Top-level modal with time range selector and tab layout     |
| `SummaryCards.tsx`              | Top-level KPI cards (total queries, avg duration, sessions) |
| `ActivityHeatmap.tsx`           | Calendar heatmap of daily activity                          |
| `AgentUsageChart.tsx`           | Bar/line chart comparing queries per agent over time        |
| `AgentComparisonChart.tsx`      | Side-by-side agent comparison                               |
| `AgentEfficiencyChart.tsx`      | Duration efficiency by agent                                |
| `PeakHoursChart.tsx`            | Hourly distribution of queries                              |
| `DurationTrendsChart.tsx`       | Duration trends over time                                   |
| `SourceDistributionChart.tsx`   | User vs Auto Run pie chart                                  |
| `LocationDistributionChart.tsx` | Local vs SSH remote distribution                            |
| `WeekdayComparisonChart.tsx`    | Weekday activity comparison                                 |
| `TasksByHourChart.tsx`          | Auto Run tasks by hour                                      |
| `AutoRunStats.tsx`              | Auto Run session statistics and details                     |
| `WizardStats.tsx`               | Auto Run wizard usage: time, runs, documents, tasks         |
| `MetricCard.tsx`                | Shared labeled single-number tile for those metric rows     |
| `LongestAutoRunsTable.tsx`      | Table of longest Auto Run sessions                          |
| `SessionStats.tsx`              | Session lifecycle statistics                                |
| `ChartErrorBoundary.tsx`        | Error boundary for individual charts                        |
| `ChartSkeletons.tsx`            | Loading skeletons for chart placeholders                    |
| `EmptyState.tsx`                | Empty state when no data exists                             |
| `UsageDashboardFooter.tsx`      | Status bar: range label, per-tab summary, Esc hint          |
| `footerSummary.ts`              | All footer summary copy, as pure builders (see below)       |
| `useFooterSummary.ts`           | Store letting a panel publish its own footer line           |

### Range-Scoped vs Lifetime Token Totals

Two different numbers answer "how many tokens did this cost", and putting the
wrong one under the dashboard's range selector is a bug that looks like a frozen
counter:

| Source                             | Scope                        | Helper                                           |
| ---------------------------------- | ---------------------------- | ------------------------------------------------ |
| `Session.usageStats`               | Lifetime, per agent, in-hand | `aggregateUsage()` in `src/shared/usageStats.ts` |
| `StatsAggregation.bySessionTokens` | The selected time range      | `aggregateRangeUsage()` in the same module       |

`usageStats` is a counter that only ever grows, so it **cannot** move when the
range selector does. The Overview tab's Tokens and Cost cards were summing it,
and reported the same figure on This Week as on This Year while every other card
on the tab changed (issue #1399). Anything rendered under a range selector reads
`bySessionTokens` through `aggregateRangeUsage()`; the per-agent detail modal,
which has no range at all, legitimately keeps the lifetime figure.

One catch `aggregateRangeUsage` handles so callers do not have to: the stats DB
records provider-REPORTED cost per turn and nothing else, so an agent on a
provider that prices nothing itself stores zero. Pass the optional
`modelForSession` resolver and those sessions fall back to the same rate-table
estimate `resolveUsageCost` applies to a live agent, with `costEstimated` set so
the UI can mark the figure `~`.

### Footer Summaries (per-tab status line)

The footer's center slot states what the current tab is actually showing:
`24 of 84 agents`, `126 runs · 12 pipelines · 8 failed`, `3 accounts · peak
window 87%`. Every string is built by a pure function in `footerSummary.ts` -
do NOT inline a new one at a call site, or the separator, pluralization, and
tone drift across tabs within a release.

The rule is **whoever owns the data writes the summary**:

| Owner                                         | Tabs                                                               | How                                                        |
| --------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `UsageDashboardModal` (holds the aggregation) | `overview`, `agent-overview`, `activity`, `tokens`                 | `buildModalOwnedFooterSummary()` -> `fallbackSummary` prop |
| The panel (fetches or filters for itself)     | `agents`, `groups`, `autorun`, `cue`, `shortcuts`, both quota tabs | `usePublishFooterSummary(tab, buildXSummary(...))`         |

A published summary always beats the modal's fallback, because the panel knows
about filter state and fetches the modal cannot see.

Two traps the implementation already handles - do not "simplify" them away:

- **Summaries are keyed by tab, not stored as one current value.** React mounts
  the incoming panel before unmounting the outgoing one, so a single-slot store
  would let the outgoing panel's cleanup erase the line the new tab just wrote.
- **It is a Zustand store, not a React context, on purpose.** A provider has to
  wrap the modal's whole body, and re-indenting that file is what turns a
  main -> rc merge into hand-resolution work (`rc` has split
  `UsageDashboardModal` into a directory).
- **`usePublishFooterSummary` must be called above any early return.** Panels
  with loading/error/empty branches (`CueStats`, `AutoRunStats`) bail early, and
  a hook cannot sit behind a return - the bailing panel is exactly the one that
  needs to clear its stale line. Pass `null` while loading.

`FooterSummaryTab` includes `'tokens'`, which this branch has no tab for; the
split dashboard on `rc` does, so the case is carried here to make that port a
copy rather than a rewrite.

## Module Organization

All stats code is in `src/main/stats/`:

| File                   | Purpose                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `index.ts`             | Module barrel - re-exports all public APIs                                                    |
| `stats-db.ts`          | Core `StatsDB` class: lifecycle, integrity, VACUUM, backup/restore                            |
| `singleton.ts`         | Singleton instance management and performance metrics API                                     |
| `schema.ts`            | SQL table/index definitions and `runStatements()` utility                                     |
| `migrations.ts`        | Migration registry and execution engine                                                       |
| `types.ts`             | Internal types (IntegrityCheckResult, BackupResult, Migration, etc.)                          |
| `query-events.ts`      | QueryEvent CRUD with statement caching                                                        |
| `auto-run.ts`          | AutoRunSession and AutoRunTask CRUD                                                           |
| `session-lifecycle.ts` | SessionLifecycleEvent CRUD                                                                    |
| `aggregations.ts`      | Aggregation sub-queries and orchestrator                                                      |
| `data-management.ts`   | Data cleanup (transactional) and CSV export                                                   |
| `row-mappers.ts`       | SQLite row to TypeScript object mappers                                                       |
| `utils.ts`             | Shared utilities (ID generation, time range, path normalization, StatementCache, PerfMetrics) |

## Key Source Files

| File                                      | Purpose                       |
| ----------------------------------------- | ----------------------------- |
| `src/main/stats/stats-db.ts`              | Core database class           |
| `src/main/stats/singleton.ts`             | Singleton + performance API   |
| `src/main/stats/schema.ts`                | SQL definitions               |
| `src/main/stats/migrations.ts`            | Schema evolution              |
| `src/main/stats/aggregations.ts`          | Dashboard aggregation queries |
| `src/main/stats/query-events.ts`          | Query event CRUD              |
| `src/main/stats/session-lifecycle.ts`     | Session lifecycle CRUD        |
| `src/main/stats/data-management.ts`       | Cleanup and CSV export        |
| `src/main/ipc/handlers/stats.ts`          | IPC handler registration      |
| `src/shared/stats-types.ts`               | Shared type definitions       |
| `src/renderer/components/UsageDashboard/` | Dashboard UI components       |
