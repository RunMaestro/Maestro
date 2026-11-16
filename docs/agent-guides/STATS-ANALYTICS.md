<!-- Verified 2026-11-14 against main (Usage Dashboard overhaul) -->

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
| RadialActivityChart   |         |   +-- auto-run.ts         |
| SessionStats          |         |   +-- session-lifecycle.ts |
| ...charts...          | <------ |   +-- aggregations.ts     |
+-----------------------+ stats:  |   +-- usage-export.ts     |
                         updated  +---------------------------+
                         (table)
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

| Column         | Type             | Description                     |
| -------------- | ---------------- | ------------------------------- |
| `id`           | TEXT PK          | UUID                            |
| `session_id`   | TEXT NOT NULL    | Maestro agent id (no tab part)  |
| `agent_type`   | TEXT NOT NULL    | Agent type (e.g. `claude-code`) |
| `source`       | TEXT NOT NULL    | `'user'` or `'auto'` (Auto Run) |
| `start_time`   | INTEGER NOT NULL | Unix timestamp (ms)             |
| `duration`     | INTEGER NOT NULL | Duration in ms                  |
| `project_path` | TEXT             | Normalized project path         |
| `tab_id`       | TEXT             | AI tab that issued the query    |
| `is_remote`    | INTEGER          | SSH remote flag (added in v2)   |
| `is_worktree`  | INTEGER          | Worktree agent flag (v5)        |
| `user_name`    | TEXT             | Web Login sender (v12)          |

`user_name` is the Web Login account that SENT the turn, and NULL means "nobody
was signed in" - a turn typed at the desktop, which is every turn while Web
Login is off. It is stamped by `stats:record-query` from what the spawn noted
(`resolveTurnActor`), never from the acting user at write time: the row is
written by the desktop renderer's exit listener even for a turn a browser sent.

**Indexes**: `start_time`, `agent_type`, `source`, `session_id`, `project_path`, `is_remote`, `is_worktree`, `user_name`, compound `(start_time, agent_type)`, `(start_time, project_path)`, `(start_time, source)`, `(start_time, session_id)` (v14)

`session_id` is the Maestro agent id (`Session.id`), never a tab or process id,
so `COUNT(DISTINCT session_id)` is "agents with a query", which is what
`StatsAggregation.totalSessions` reports.

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

Tracks when an agent was created and deleted. Its one dashboard reader is the
Agent Overview's Agents Over Time chart (`AgentCountTrendChart`, via
`stats:get-session-lifecycle`), the only record of an agent that no longer
exists. The aggregation does not read it:

| Column         | Type                 | Description                       |
| -------------- | -------------------- | --------------------------------- |
| `id`           | TEXT PK              | UUID                              |
| `session_id`   | TEXT NOT NULL UNIQUE | Maestro agent id                  |
| `agent_type`   | TEXT NOT NULL        | Agent type                        |
| `project_path` | TEXT                 | Project path                      |
| `created_at`   | INTEGER NOT NULL     | Creation timestamp (ms)           |
| `closed_at`    | INTEGER              | Closure timestamp (ms)            |
| `duration`     | INTEGER              | Computed `closed_at - created_at` |
| `is_remote`    | INTEGER              | SSH remote flag                   |

**Indexes**: `created_at`, `agent_type`

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
2. Corruption detection and recovery (integrity check, backup restore), recorded
   for the renderer's one-shot notice (see Integrity and Recovery)
3. WAL mode enablement
4. Migration execution
5. Daily backup creation (keeps 7 days)
6. Weekly VACUUM scheduling (only if DB exceeds 100MB)

## Migration System

Defined in `src/main/stats/migrations.ts`. Migrations are sequential and recorded in the `_migrations` table. The current schema version is stored in SQLite's `user_version` pragma.

| Version | Description                                                           |
| ------- | --------------------------------------------------------------------- |
| v1      | Initial schema: `query_events`, `auto_run_sessions`, `auto_run_tasks` |
| v2      | Add `is_remote` column to `query_events` for SSH tracking             |
| v3      | Add `session_lifecycle` table                                         |
| v4      | Add compound indexes on `query_events` for dashboard performance      |
| v5      | Add `is_worktree` column to `query_events` and `session_lifecycle`    |
| v6      | Add `image_annotations` table                                         |
| v7      | Add `shortcut_usage_daily` table                                      |
| v8      | Add `multi_window_usage_daily` table                                  |
| v9      | Add per-turn token and cost columns to `query_events`                 |
| v10     | Add `resilience_events` table                                         |
| v11     | Add `wizard_runs` table                                               |
| v12     | Add `user_name` column to `query_events` for Web Login attribution    |
| v13     | Add `active_ms` column to `wizard_runs`                               |
| v14     | Add `shortcut_usage_by_id` and the `(start_time, session_id)` index   |
| v15     | Add `token_speed_hourly` (token speed timed off the live stream)      |

To add a new migration:

1. Create a `migrateVN()` function in `migrations.ts`
2. Add it to the `getMigrations()` array
3. Update `STATS_DB_VERSION` in `src/shared/stats-types.ts`

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

`StatsAggregation` is the contract between `aggregations.ts` and every dashboard
panel. The fields that are easy to misread:

```typescript
interface StatsAggregation {
	totalQueries: number;
	totalDuration: number;
	avgDuration: number;
	queryDurationPercentiles: DurationPercentiles;
	queryDurationPercentilesByAgent: Record<string, DurationPercentiles>;
	autoRunTaskDurationPercentiles: DurationPercentiles;
	byAgent: Record<string, { count: number; duration: number }>;
	bySource: { user: number; auto: number };
	// GAP-FILLED: one row per local day from window.startYmd to window.endYmd
	byDay: Array<{ date: string; count: number; duration: number }>;
	// Sparse: (local day, hour) cells with at least one query
	byDayHour: Array<{ date: string; hour: number; count: number; duration: number }>;
	// The range's first local day (All Time: day of the first query, or today) and today
	window: { startYmd: string; endYmd: string };
	earliestQueryAt: number | null; // first query ever, any range
	streak: { current: number; longest: number }; // over ALL history, not the range
	byLocation: { local: number; remote: number };
	byHour: Array<{ hour: number; count: number; duration: number }>; // sparse
	totalSessions: number; // distinct AGENTS with at least one query in range
	byAgentByDay: Record<string, Array<{ date: string; count: number; duration: number }>>; // sparse
	bySessionByDay: Record<string, Array<{ date: string; count: number; duration: number }>>; // sparse
	bySessionSource: Record<string, { user: number; auto: number }>;
	bySessionLastQuery: Record<string, number>;
	bySessionTokens: Record<string, SessionTokenTotals>; // agents with no priced row omitted
	worktreeQueries: number;
	parentQueries: number;
	// Per provider, from the is_worktree flag on each row (NULL counts as parent)
	byAgentWorktree: Record<string, { worktree: Slice; parent: Slice }>;
	imageAnnotations: number;
	prompts: PromptCadence; // interactive turns only, same calendar window
}
```

Per-entity day series (`byAgentByDay`, `bySessionByDay`) stay sparse. To draw one
on a time axis, fill it over `window` with `fillDaySeries()` /
`localDaysBetween()` from `src/shared/daySeries.ts`; never plot sparse rows by
index, which squeezes idle days out of the chart.

Every bounded range is CALENDAR-ALIGNED: `getTimeRangeStart()` in
`src/shared/statsTimeRange.ts` returns local midnight N-1 days before today
(`STATS_RANGE_DAYS`), so "Last 7 days" is seven whole local days, today included,
and every day bucket is a full day. There is no retention: All Time is
everything since the stats database was created (or last reset after
corruption), and `earliestQueryAt` says when that was.

## IPC Handlers

Registered in `src/main/ipc/handlers/stats.ts`. Every handler that STARTS a
record checks `statsCollectionEnabled` and records nothing when it is off.
Handlers that only finish an existing record (`stats:end-autorun`,
`stats:record-session-closed`) do not check it: a run or agent that began while
collection was on must still be closed, or it would be left with a zero
duration forever.

### Recording

| Handler                         | Description                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `stats:record-query`            | Buffer a `QueryEvent` (see Broadcast for when it is announced).         |
| `stats:start-autorun`           | Insert an `AutoRunSession` with `duration: 0`. Returns the ID.          |
| `stats:end-autorun`             | Update an `AutoRunSession` with final `duration` and `tasksCompleted`.  |
| `stats:record-task`             | Insert an `AutoRunTask` for a completed task within an Auto Run.        |
| `stats:record-session-created`  | Insert a `SessionLifecycleEvent` (session launched).                    |
| `stats:record-session-closed`   | Update `SessionLifecycleEvent` with `closedAt` and computed `duration`. |
| `stats:record-resilience`       | Insert a resolved Agent Resilience outage.                              |
| `stats:record-wizard-run`       | Upsert one Auto Run wizard run (every milestone).                       |
| `stats:record-shortcut-usage`   | Bump the day's (and the shortcut's) firing counter.                     |
| `stats:record-image-annotation` | Insert an image annotation save.                                        |

### Querying

| Handler                       | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `stats:get-stats`             | Get `QueryEvent[]` with time range and optional filters     |
| `stats:get-autorun-sessions`  | Get `AutoRunSession[]` within a time range                  |
| `stats:get-autorun-tasks`     | Get `AutoRunTask[]` for a specific Auto Run session         |
| `stats:get-aggregation`       | Get `StatsAggregation` for a time range (used by dashboard) |
| `stats:get-session-lifecycle` | Get `SessionLifecycleEvent[]` within a time range           |

The first query ever recorded is `StatsAggregation.earliestQueryAt`; there is no
separate read for it.

### Data Management

| Handler                             | Description                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `stats:export`                      | Export every stats table, token usage, and Cue runs for a range as JSON or a CSV zip |
| `stats:get-database-size`           | Get the database file size in bytes                                                  |
| `stats:get-initialization-result`   | What opening the DB had to do to a damaged file (null when it opened cleanly)        |
| `stats:clear-initialization-result` | Forget that result once the renderer has shown it                                    |

There is no cleanup handler: nothing prunes the stats database. The export logic
lives in `usage-export.ts` (shared with `maestro-cli stats-export`), and the
delegation merge in `usage-dashboard-reads.ts`.

### Broadcast

Every write broadcasts `stats:updated` with the `StatsTable` it touched as the
event argument (`'query_events'`, `'auto_run'`, `'session_lifecycle'`,
`'shortcut_usage'`, `'image_annotations'`, `'wizard_runs'`, `'resilience'`), to
EVERY window (`BrowserWindow.getAllWindows()`, since any window can open the
dashboard) and to web-desktop bridge clients.

Query events are buffered (`query-events-buffer.ts`, flushed every 500ms or 50
events), so `stats:record-query` does not broadcast. The buffer's flush listener
announces `'query_events'` once the batch is COMMITTED, so a panel refetching on
the event reads the new rows instead of racing the flush timer.

On the renderer side, `useDashboardResource(key, fetcher, operation, { tables })`
refetches only for the tables a panel reads and collapses a burst into one
trailing refetch (`DASHBOARD_RESOURCE_DEBOUNCE_MS`).

## Query Patterns

### Aggregation Queries

`getAggregatedStats()` in `src/main/stats/aggregations.ts` runs a handful of
grouped passes and rolls each up in JS:

| Pass              | SQL shape                                                                  | Feeds                                                                                                        |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| bounds            | `MIN(start_time)` overall and for `source != 'auto'`                       | `earliestQueryAt`, All Time `window`, prompt window                                                          |
| activity cube     | `GROUP BY` local day, hour, provider, source, remote, worktree             | totals, `byAgent`, `bySource`, `byLocation`, `byDay`, `byDayHour`, `byHour`, `byAgentByDay`, worktree splits |
| per agent         | `GROUP BY session_id`, local day, source (+ token sums, `MAX(start_time)`) | `totalSessions`, `bySessionByDay`, `bySessionSource`, `bySessionLastQuery`, `bySessionTokens`                |
| query percentiles | `ROW_NUMBER() OVER (...)` overall and per provider                         | `queryDurationPercentiles*` (only the rows at a percentile rank come back)                                   |
| task percentiles  | same, over `auto_run_tasks`                                                | `autoRunTaskDurationPercentiles`                                                                             |
| prompt times      | `start_time` of non-auto rows in the window (one column)                   | `prompts` (gaps between prompts need raw timestamps)                                                         |
| active days       | `SELECT DISTINCT` local day, all history (skipped for All Time)            | `streak`                                                                                                     |
| image annotations | `COUNT(*)`                                                                 | `imageAnnotations`                                                                                           |

Every range-scoped pass binds `start_time >= getTimeRangeStart(range)`. The
percentile SQL picks the same ranks `percentileOfSorted()` does
(`min(n - 1, floor(p / 100 * n))`), and the JS side hands them to
`percentilesFromSorted()` in a sparse array, so the index rule lives in one
place.

### Memo

The result is memoized per range in the main process and reused until the
database changes or the local day rolls over. The key is
`total_changes()` (moves on every write through this connection: the query
buffer flush, Auto Run, everything) plus `PRAGMA data_version` (moves when
another connection commits, such as a repair script) plus today's date. A new
connection (startup, corruption recovery) or `StatsDB.close()` drops it. The
all-history streak is cached once per key and shared by every range.

### Statement Caching

The `StatementCache` class (in `utils.ts`) caches prepared statements per SQL string to avoid re-preparing on every call. Caches are cleared when the database is closed; the aggregation's cache also clears itself when it sees a different connection.

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
5. `StatsDB.getInitializationResult()` records what happened (`describeRecovery()`
   builds the message). The renderer's lifecycle-owner window reads it through
   `stats:get-initialization-result` on startup, shows a sticky "Usage Statistics
   Reset" toast, and clears it, so a reset is never silent.

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

| Component                       | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `UsageDashboardModal.tsx`       | Top-level modal with time range selector and tab layout    |
| `SummaryCards.tsx`              | Overview KPI cards (agents, queries, tokens, streak, ...)  |
| `ActivityHeatmap.tsx`           | Calendar heatmap of daily activity                         |
| `AgentUsageChart.tsx`           | Bar/line chart comparing queries per agent over time       |
| `AgentComparisonChart.tsx`      | Side-by-side agent comparison                              |
| `RadialActivityChart.tsx`       | Hour-of-day and day-of-week polar charts                   |
| `DurationTrendsChart.tsx`       | Duration trends over time                                  |
| `SourceDistributionChart.tsx`   | User vs Auto Run pie chart                                 |
| `LocationDistributionChart.tsx` | Local vs SSH remote distribution                           |
| `TasksByHourChart.tsx`          | Auto Run tasks by hour                                     |
| `AutoRunStats.tsx`              | Auto Run session statistics and details                    |
| `WizardStats.tsx`               | Auto Run wizard usage: time, runs, documents, tasks        |
| `LongestAutoRunsTable.tsx`      | Table of longest Auto Run sessions                         |
| `SessionStats.tsx`              | Agent Overview fleet statistics (Agent Statistics section) |
| `AgentCountTrendChart.tsx`      | Agents Over Time (reads `session_lifecycle`)               |
| `DashboardPanelState.tsx`       | Shared loading / error / empty wrapper for a panel         |
| `useDashboardResource.ts`       | Cached panel fetch, refetched per `stats:updated` table    |
| `ChartErrorBoundary.tsx`        | Error boundary for individual charts                       |
| `ChartSkeletons.tsx`            | Loading skeletons for chart placeholders                   |
| `EmptyState.tsx`                | Empty state when no data exists                            |
| `UsageDashboardFooter.tsx`      | Status bar: range label, per-tab summary, Esc hint         |
| `footerSummary.ts`              | All footer summary copy, as pure builders (see below)      |
| `useFooterSummary.ts`           | Store letting a panel publish its own footer line          |

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
and reported the same figure on Last 7 Days as on Last 365 Days while every other card
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

| File                       | Purpose                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `index.ts`                 | Module barrel - re-exports all public APIs                                                    |
| `stats-db.ts`              | Core `StatsDB` class: lifecycle, integrity, VACUUM, backup/restore                            |
| `singleton.ts`             | Singleton instance management and performance metrics API                                     |
| `schema.ts`                | SQL table/index definitions and `runStatements()` utility                                     |
| `migrations.ts`            | Migration registry and execution engine                                                       |
| `types.ts`                 | Internal types (IntegrityCheckResult, BackupResult, Migration, etc.)                          |
| `query-events.ts`          | QueryEvent CRUD with statement caching                                                        |
| `auto-run.ts`              | AutoRunSession and AutoRunTask CRUD                                                           |
| `session-lifecycle.ts`     | SessionLifecycleEvent CRUD                                                                    |
| `aggregations.ts`          | Grouped aggregation passes, rollups, streak, and the per-range memo                           |
| `query-events-buffer.ts`   | Batched query-event writes and the post-commit flush listener                                 |
| `usage-export.ts`          | Dashboard export (JSON or CSV zip), shared by IPC and the CLI                                 |
| `usage-dashboard-reads.ts` | Reads shared by the IPC handlers and the CLI (delegation, Cue, quota)                         |
| `row-mappers.ts`           | SQLite row to TypeScript object mappers                                                       |
| `utils.ts`                 | Shared utilities (ID generation, time range, path normalization, StatementCache, PerfMetrics) |

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
| `src/main/stats/usage-export.ts`          | Dashboard export              |
| `src/shared/statsTimeRange.ts`            | Calendar-aligned range starts |
| `src/shared/daySeries.ts`                 | Gap-filling day series        |
| `src/main/ipc/handlers/stats.ts`          | IPC handler registration      |
| `src/shared/stats-types.ts`               | Shared type definitions       |
| `src/renderer/components/UsageDashboard/` | Dashboard UI components       |
