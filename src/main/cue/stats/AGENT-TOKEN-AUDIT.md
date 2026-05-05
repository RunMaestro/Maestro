---
type: analysis
title: Agent Token Storage Audit (Cue Dashboard Phase 02)
created: 2026-04-28
tags:
  - cue
  - stats
  - tokens
  - audit
related:
  - '[[CUE-DASHBOARD-02]]'
  - '[[AGENT_SUPPORT]]'
---

# Agent Token Storage Audit

Read-only audit of how token usage data is stored across the five
priority-ordered agents, performed for Phase 02 of the Cue Dashboard work.
The goal is to determine whether a unified `getSessionTokenSummaries()`
accessor is feasible without resorting to stdout parsing or per-agent
forks.

## TL;DR — Verdict

**Workable.** All 5 agents already aggregate token data into a uniform
shape (`AgentSessionInfo`) inside their `listSessions()` implementation:

```ts
inputTokens: number;
outputTokens: number;
cacheReadTokens: number;
cacheCreationTokens: number;
costUsd?: number; // optional
```

(See `src/main/agents/session-storage.ts:45-63`.)

So at the **surface API** the picture is uniform. The catch is that there
is no per-`sessionId` accessor today — every storage exposes
`listSessions(projectPath)` (project-scoped) and a `getSessionPath`
helper, but no `getSessionInfo(projectPath, sessionId)`. To go from a raw
`sessionId` to token totals we need either:

1. `listSessions(projectPath)` + filter by `sessionId`, or
2. A new minimal `getSessionInfoById()` per storage, or
3. A focused token-only re-parse of the session file using existing
   per-agent regex/JSON paths.

None of those triggers a STOP+REPORT — all three are mechanical glue, not
"unified accessor would need >300 LOC". The accessor in Phase 02 task #2
should land cleanly under the size cap.

**No STOP+REPORT condition is triggered:**

- Zero agents have "no token data at all" (cap is ≥ 2 to stop).
- Zero agents require parsing arbitrary stdout (every agent has a
  structured on-disk store the storage classes already parse).
- Shapes are uniform (single `AgentSessionInfo` interface), so the glue
  needed for a unified accessor is well below the 300-LOC threshold.

Proceeding with implementation in the next subtask.

## Per-Agent Findings

### 1. `claude-code` (Active, primary)

- **Storage file:** `src/main/storage/claude-session-storage.ts`
- **On-disk format:** JSONL file at
  `~/.claude/projects/<encoded-project>/<sessionId>.jsonl` (one entry per
  message; `result` entries carry usage; `assistant` entries carry usage
  in `message.usage`).
- **Token field names (raw JSONL):**
  - `input_tokens` → mapped to `inputTokens`
  - `output_tokens` → mapped to `outputTokens`
  - `cache_read_input_tokens` → mapped to `cacheReadTokens`
  - `cache_creation_input_tokens` → mapped to `cacheCreationTokens`
  - **Cost:** computed from token counts via
    `calculateClaudeCost(...)` (model-rate table) → `costUsd` is **always
    populated** (number, not undefined).
- **Aggregation level:** per-message in the file; pre-aggregated to
  per-session totals by `parseSessionContent()`
  (`claude-session-storage.ts:127-189`) using regex matchAll across the
  whole file.
- **Existing accessor:** No `getSessionInfo(sessionId)`. Use
  `getSessionPath(projectPath, sessionId)` (synchronous, returns a path)
  - `parseSessionContent` (private helper) — or call `listSessions` and
    filter.
- **I/O model:** async file read (`fs.readFile` for local,
  `readFileRemote` for SSH). One file per session, files capped at
  `MAX_SESSION_FILE_SIZE`. SSH supported.

### 2. `codex` (Active)

- **Storage file:** `src/main/storage/codex-session-storage.ts`
- **On-disk format:** JSONL file under
  `~/.codex/sessions/...` (path requires async scan — `getSessionPath`
  returns `null`; `findSessionFile()` does a directory walk).
- **Token field names (raw JSONL):**
  - `turn.completed` events: `usage.input_tokens`,
    `usage.output_tokens`, `usage.reasoning_output_tokens` (folded into
    output), `usage.cached_input_tokens` → `cacheReadTokens`.
  - `event_msg` events with `payload.type === 'token_count'`: same
    fields under `payload.info.total_token_usage`.
  - **Cost:** **absent** — Codex doesn't emit cost and the storage
    explicitly omits `costUsd` (`codex-session-storage.ts:440`).
  - **`cacheCreationTokens`:** **always 0** — Codex doesn't report
    cache-creation separately (`codex-session-storage.ts:444`).
- **Aggregation level:** per-event in JSONL (multiple turn events);
  summed to per-session by `parseSessionContent`. Note `event_msg`
  carries `total_token_usage` which is **already cumulative** — naive
  sum of both `turn.completed` and `event_msg` would double-count, but
  the existing parser does the same so we inherit whatever behavior is
  already shipped.
- **Existing accessor:** `getSessionPath` returns `null`. To resolve
  a `sessionId` we'd need either `findSessionFile` (private, async,
  walks the codex sessions dir) or `listSessions(projectPath)` + filter.
- **I/O model:** async file read. SSH supported.

### 3. `opencode` (Active)

- **Storage file:** `src/main/storage/opencode-session-storage.ts`
- **On-disk format:** **Two formats** — modern SQLite database
  (`OPENCODE_DB_PATH`, table `message`, JSON blob in `data` column) and
  legacy JSON files (`<storage>/messages/<sessionId>/...`). The storage
  detects which to use via `sessionExistsInSqlite(sessionId)`.
- **Token field names (parsed JSON blob):**
  - `tokens.input` → `inputTokens`
  - `tokens.output` → `outputTokens`
  - `tokens.cache.read` → `cacheReadTokens`
  - `tokens.cache.write` → `cacheCreationTokens`
  - **Cost:** `cost` field per message → summed into `costUsd`
    (always populated, even if 0).
- **Aggregation level:** per-message; summed to per-session in the
  storage's loaders (sqlite + JSON paths both do the same aggregation).
- **Existing accessor:** No per-session getter, but `sessionExistsInSqlite`
  - a single SQL query against `message` would be cheap. SQLite path is
    fast (sub-ms); JSON path is async file I/O.
- **I/O model:**
  - **SQLite** (modern): synchronous, in-process via better-sqlite3.
  - **JSON files** (legacy): async file reads.
  - **SSH**: file-based, async.

### 4. `factory-droid` (Active)

- **Storage file:** `src/main/storage/factory-droid-session-storage.ts`
- **On-disk format:** Two files per session under
  `~/.factory/sessions/<encoded-project>/`:
  - `<sessionId>.jsonl` — message history.
  - `<sessionId>.settings.json` — metadata, **including pre-aggregated
    `tokenUsage`**.
- **Token field names (`settings.json` → `tokenUsage`):**
  - `inputTokens`, `outputTokens`, `cacheReadTokens`,
    `cacheCreationTokens`, `thinkingTokens` (ignored; not part of our
    schema).
  - **Cost:** **absent** —
    `factory-droid-session-storage.ts:465` explicitly notes "Factory
    Droid doesn't provide cost in settings.json". `costUsd` will be
    undefined.
- **Aggregation level:** **per-session, already cumulative** in
  `settings.json` — easiest of the five. Single small JSON read gives
  totals.
- **Existing accessor:** No `getSessionInfo`. `getSessionPath` returns a
  deterministic path so a tiny "read settings.json directly" helper is
  trivial.
- **I/O model:** async file read; SSH supported.

### 5. `copilot-cli` (Beta)

- **Storage file:** `src/main/storage/copilot-session-storage.ts`
- **On-disk format:** `events.jsonl` per session under the Copilot config
  dir (`~/.copilot/session-state/...`). Path is sessionId-keyed (not
  per-project), with project membership inferred from a sibling
  workspace metadata file.
- **Token field names (parsed events):**
  - Tokens are emitted **only on the `session.shutdown` event**, in
    `data.modelMetrics[<modelId>].usage`:
    - `inputTokens` → `inputTokens`
    - `outputTokens` → `outputTokens`
    - `cacheReadTokens` → `cacheReadTokens`
    - `cacheWriteTokens` → `cacheCreationTokens`
  - **Cost:** **absent**.
- **Aggregation level:** per-shutdown-event (effectively per-session).
  **Sessions still in flight have zero tokens until shutdown.** This is
  a real partial-data case — the `coverage: 'partial'` flag in Phase 02
  task #2 should be used here when an in-flight session is queried.
- **Existing accessor:** `getSessionPath` returns the events.jsonl path
  directly (no project required, sessionId-keyed). Cheap to read.
- **I/O model:** async file read; SSH supported. Files capped at
  `MAX_REMOTE_EVENTS_FILE_SIZE` (100 MB) on remotes.

## Cross-Agent Comparison

| Agent         | Tokens (in/out/cache)    | Cost (`costUsd`) | Per-session pre-aggregated? | Cheapest single-session read | SSH |
| ------------- | ------------------------ | ---------------- | --------------------------- | ---------------------------- | --- |
| claude-code   | yes                      | yes (computed)   | no — full-file regex scan   | known path, full file        | yes |
| codex         | yes (cache-creation = 0) | no               | no — full-file scan         | requires dir scan to find    | yes |
| opencode      | yes                      | yes (data)       | no — sum across messages    | one SQL query (modern)       | yes |
| factory-droid | yes                      | no               | **yes — settings.json**     | tiny settings.json read      | yes |
| copilot-cli   | yes (only at shutdown)   | no               | yes (single event)          | known path, full file        | yes |

## Lookup Chain for `getSessionTokenSummaries(sessionIds)`

`AgentSessionStorage` is keyed by `(projectPath, sessionId)` but the
caller will pass us bare `sessionIds`. To resolve `agentType` and
`projectPath`:

- **Primary lookup:** `session_lifecycle` table
  (`stats/schema.ts:112-123`) — has `session_id` (UNIQUE),
  `agent_type`, `project_path`, `is_remote`. One SQL query per batch.
- **Fallback:** `query_events` table — same fields available, but
  `session_id` is non-unique. Use `MAX(start_time)` to dedupe.
- **OpenCode + Copilot:** `projectPath` is **not strictly required** —
  OpenCode can route by `sessionExistsInSqlite`, and Copilot's
  `getSessionPath` ignores `projectPath`. So even if the lookup misses,
  these two can degrade gracefully.

The accessor will batch by `agentType` (one storage per agent) and use
`Promise.all` per-agent.

## Coverage Mapping for the `coverage` Field

Per Phase 02 task #2:

- `'full'` → all 4 token fields populated, cost where the agent supports
  it. Applies to: `claude-code`, `opencode`, `factory-droid`.
- `'partial'` → some fields are structurally absent. Applies to:
  - `codex` — `cacheCreationTokens` is always 0, no `costUsd`.
  - `copilot-cli` — tokens only after `session.shutdown`; in-flight
    sessions report zero tokens.
- `'unsupported'` → reserved for future agents not in the dispatch
  table. None of the five priority agents currently fall here.

## Risks / Known Gotchas

- **Codex cumulative-vs-incremental ambiguity.** The existing parser
  sums both `turn.completed.usage` and
  `event_msg.payload.info.total_token_usage`. If the latter is
  cumulative across the session, this double-counts. We inherit the
  existing behavior; do **not** "fix" it in Phase 02 — that's a Codex
  parser bug separate from the Cue dashboard work.
- **Copilot in-flight zeroes.** A Cue trigger that fires while a
  Copilot session is still running will see tokens = 0. Mark
  `coverage: 'partial'` so the dashboard can render an "in flight"
  state in Phase 04.
- **OpenCode SQLite contention.** The storage opens the DB read-only
  per-call. For a batch of N OpenCode sessions, batch into one SQL
  query (`WHERE id IN (...)`) rather than N opens.
- **SSH attribution.** Token data is on the remote host. The accessor
  must thread `sshConfig` through (resolvable via the
  `session_lifecycle.is_remote` flag plus the remote-resolver chain).
  Failing loudly when `is_remote` is true and the resolver returns
  nothing — same rule as elsewhere in the codebase.
- **Claude `costUsd` is computed locally** from a model-rate table.
  Drift is possible if the rate table goes stale; for the purposes of
  the Cue dashboard this is acceptable (matches what other Maestro
  surfaces show).

## Implementation Notes for Task #2

Recommended approach for `cue-token-accessor.ts`:

1. Resolve `(agentType, projectPath, sshConfig)` per `sessionId` from
   `session_lifecycle` (single SQL query for the whole batch).
2. Group `sessionIds` by `agentType`.
3. Per-agent strategy:
   - `claude-code`, `factory-droid`: `getSessionPath` + read file
     directly + reuse existing parsing helpers.
   - `opencode`: single SQL `SELECT ... WHERE id IN (...)` against the
     `message` table; group by `session_id`.
   - `codex`: `listSessions(projectPath)` + filter (codex's path
     resolution is async and there's no efficient direct path; the
     audit doc flags this as the most expensive read).
   - `copilot-cli`: `getSessionPath` + read events.jsonl + reuse
     `parseEvents`.
4. In-memory cache keyed by `sessionId` with 30s TTL (per task spec).
5. Return `Map<sessionId, SessionTokenSummary>`. Missing sessions are
   simply absent from the map (per task #3 test spec).

No STOP+REPORT condition triggered — proceeding to Phase 02 task #2.
