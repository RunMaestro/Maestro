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

| Column         | Type             | Description                     |
| -------------- | ---------------- | ------------------------------- |
| `id`           | TEXT PK          | UUID                            |
| `session_id`   | TEXT NOT NULL    | Maestro session ID              |
| `agent_type`   | TEXT NOT NULL    | Agent type (e.g. `claude-code`) |
| `source`       | TEXT NOT NULL    | `'user'` or `'auto'` (Auto Run) |
| `start_time`   | INTEGER NOT NULL | Unix timestamp (ms)             |
| `duration`     | INTEGER NOT NULL | Duration in ms                  |
| `project_path` | TEXT             | Normalized project path         |
| `tab_id`       | TEXT             | Tab identifier                  |
| `is_remote`    | INTEGER          | SSH remote flag (added in v2)   |

**Indexes**: `start_time`, `agent_type`, `source`, `session_id`, `project_path`, `is_remote`, compound `(start_time, agent_type)`, `(start_time, project_path)`, `(start_time, source)`

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

| Version | Description                                                           |
| ------- | --------------------------------------------------------------------- |
| v1      | Initial schema: `query_events`, `auto_run_sessions`, `auto_run_tasks` |
| v2      | Add `is_remote` column to `query_events` for SSH tracking             |
| v3      | Add `session_lifecycle` table                                         |
| v4      | Add compound indexes on `query_events` for dashboard performance      |

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

### Data Management

| Handler                             | Description                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `stats:export-csv`                  | Export query events to CSV for a time range                                          |
| `stats:clear-old-data`              | Delete records older than N days (transactional across all tables)                   |
| `stats:get-database-size`           | Get the database file size in bytes                                                  |
| `stats:get-initialization-result`   | Get the result of the one-shot DB initialization (used by the settings health panel) |
| `stats:clear-initialization-result` | Clear the cached initialization result                                               |

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
| `LongestAutoRunsTable.tsx`      | Table of longest Auto Run sessions                          |
| `SessionStats.tsx`              | Session lifecycle statistics                                |
| `ChartErrorBoundary.tsx`        | Error boundary for individual charts                        |
| `ChartSkeletons.tsx`            | Loading skeletons for chart placeholders                    |
| `EmptyState.tsx`                | Empty state when no data exists                             |

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
