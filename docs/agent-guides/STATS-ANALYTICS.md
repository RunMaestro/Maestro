---
type: reference
title: Stats & Analytics
created: 2026-05-14
tags:
  - stats
  - analytics
  - storage
  - usage-dashboard
related:
  - '[[AGENT-INFRA]]'
  - '[[CLAUDE-IPC]]'
  - '[[CLAUDE-FEATURES]]'
---

# Stats & Analytics

How Maestro records AI query activity to its local SQLite stats database and
how that data feeds the Usage Dashboard. Read this when you are adding a new
chart, adjusting the ingestion path, or debugging why a session shows up (or
doesn't) in the dashboard.

For the storage-watcher pipeline that powers file-driven ingestion see
[[AGENT-INFRA]]. For the renderer-facing chart catalog see [[CLAUDE-FEATURES]].

---

## The stats DB

**Where it lives:** `src/main/stats/stats-db.ts` (class `StatsDB`). The
underlying SQLite file is `stats.db` under Electron's `userData` directory.
Access is mediated by a process-wide singleton (`getStatsDB()` /
`initializeStatsDB()` / `closeStatsDB()` from `src/main/stats/singleton.ts`),
and CRUD is split across focused modules under `src/main/stats/`:

| Module                 | Responsibility                                                               |
| ---------------------- | ---------------------------------------------------------------------------- |
| `query-events.ts`      | Insert / query individual AI query/response rows                             |
| `auto-run.ts`          | Auto Run session + task lifecycle rows                                       |
| `session-lifecycle.ts` | Created-at / closed-at events for sessions (local vs SSH remote)             |
| `aggregations.ts`      | Dashboard rollups (by agent, by day, by hour, by source, by location)        |
| `migrations.ts`        | Versioned schema migrations (current `STATS_DB_VERSION` is in `stats-types`) |
| `data-management.ts`   | Retention pruning and CSV export                                             |
| `schema.ts`            | Raw `CREATE TABLE` / `CREATE INDEX` SQL                                      |

### Query-event schema

The dashboard's hottest table is `query_events` — one row per AI
query/response cycle. Shape lives in `src/shared/stats-types.ts`:

```typescript
interface QueryEvent {
	id: string;
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto' | 'external-fs';
	startTime: number; // epoch ms
	duration: number; // ms, 0 for external-fs rows
	projectPath?: string;
	tabId?: string;
	isRemote?: boolean; // SSH remote sessions, added in migration v2
}
```

The on-disk schema mirrors the TypeScript shape; see
`CREATE_QUERY_EVENTS_SQL` and `CREATE_QUERY_EVENTS_V5_SQL` in
`src/main/stats/schema.ts`. The `source` CHECK constraint was widened to
include `'external-fs'` in migration v5.

---

## Two ingestion paths

Rows can arrive in `query_events` through two completely separate code paths.
Both ultimately call `insertQueryEventWithRetry` (`src/main/process-listeners/
insertQueryEventWithRetry.ts`) so retry semantics are shared, but the
trigger and the data source differ.

### 1. Process-driven — `stats-listener.ts`

**File:** `src/main/process-listeners/stats-listener.ts`.

For sessions Maestro itself spawned. `ProcessManager` parses the agent's
streamed output, builds a `QueryCompleteData` payload, and emits
`'query-complete'`. The stats listener subscribes, persists the row, and
broadcasts `stats:updated` to the renderer so the dashboard can refresh.

`source` here is either `'user'` (the human pressed Enter) or `'auto'`
(Auto Run / batch). Duration is real because the listener has both the
process start time and the result-message timestamp.

### 2. File-driven — `external-stats-ingester.ts`

**File:** `src/main/process-listeners/external-stats-ingester.ts`.

For sessions Maestro did **not** spawn (a Claude Code run started over SSH
on the same host, the user opening Codex in another terminal, etc.).
`ExternalSessionCoordinator` watches each agent's session-storage
directory (see [[AGENT-INFRA]]) and emits `'append'` / `'create'` events.
The ingester:

1. `fs.stat`s the file, computes the byte delta against an in-memory
   offset table (no whole-file re-reads, no on-disk offset persistence).
2. Reads just the delta with positional `fs.read`.
3. Splits on newlines and feeds each line through the agent's registered
   `AgentOutputParser`. Result messages produce `query_events` rows
   tagged `source: 'external-fs'`.

Duration is `0` for these rows — the parser cannot reconstruct timing
from JSONL alone. `startTime` is the file's most recent activity
timestamp so dashboard time-range filters bucket the row correctly.

Dedup with the process-driven path is handled by the coordinator: it
only forwards file events for sessions whose annotated `source` is
`'external'`, so a session Maestro is already driving locally never
reaches the ingester.

---

## The `source` field on `QueryCompleteData`

Defined in `src/main/process-manager/types.ts`:

```typescript
interface QueryCompleteData {
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto' | 'external-fs';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
}
```

- `'user'` / `'auto'` are emitted on `ProcessManager`'s `'query-complete'`
  event for Maestro-spawned processes.
- `'external-fs'` is synthesized by `ExternalStatsIngester` for
  file-watched sessions. It is **not** emitted on
  `ProcessManager`'s `'query-complete'` event; it only flows directly to
  `db.insertQueryEvent`.

### Filtering by `source` in the Usage Dashboard

`StatsFilters` (`src/shared/stats-types.ts`) exposes a `source` field
accepted by `getQueryEvents()`:

```typescript
interface StatsFilters {
	agentType?: string;
	source?: 'user' | 'auto' | 'external-fs';
	projectPath?: string;
	sessionId?: string;
}
```

Pass it through to scope a dashboard query to a single origin (e.g.,
`source: 'external-fs'` to show only externally-observed activity).

**Aggregation quirk to know about:** `queryBySource()` in
`src/main/stats/aggregations.ts` restricts its grouping to `'user'` and
`'auto'` so the typed result stays a `{ user: number; auto: number }`
pair — the dashboard's source-distribution chart only renders those two
buckets today. `external-fs` rows still contribute to overall totals
(`queryTotals`, by-agent, by-day, etc.); they just don't appear in the
user/auto split. If you add a new chart that needs to call out external
activity, query `query_events` directly with the filter rather than
extending `queryBySource()` past its two-bucket contract.

---

## Adding a new chart that cares about `source`

1. Decide whether the chart wants per-row data (call `getQueryEvents` with
   a `source` filter) or an aggregate (extend `aggregations.ts` with a
   purpose-built query — don't overload `queryBySource`).
2. Surface it via an existing IPC handler under `src/main/ipc/handlers/
stats.ts` if one fits; otherwise add a new one.
3. Render in `src/renderer/components/UsageDashboard/`. Use
   `ChartErrorBoundary` and the existing skeleton patterns — see
   [[CLAUDE-FEATURES]] for the catalog.
