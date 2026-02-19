---
type: research
title: "Plugin Concept: AI Auditor"
created: 2026-02-18
tags:
  - plugin
  - concept
  - auditor
related:
  - "[[extension-points]]"
  - "[[concept-agent-dashboard]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-notifications]]"
  - "[[concept-external-integration]]"
---

# Plugin Concept: AI Auditor

A passive monitoring plugin that logs all agent actions (tool executions, file operations, shell commands), flags risky operations in real time, and provides a searchable audit trail. Unlike the [[concept-agent-guardrails|Guardrails]] concept, the Auditor is strictly observational — it never blocks or kills agents.

---

## Event Subscriptions Needed

### Primary Events

| Event | API | Data Available | Auditor Use |
|-------|-----|---------------|-------------|
| `process:tool-execution` | `window.maestro.process.onToolExecution(cb)` | `toolName`, `state` (status, input, output), `timestamp` | Core audit log: what tool was used, what arguments were passed, when |
| `process:data` | `window.maestro.process.onData(cb)` | `sessionId`, raw output string | Parse agent output for file paths, commands, and context when tool-execution data is insufficient |
| `process:exit` | `window.maestro.process.onExit(cb)` | `sessionId`, exit code | Session lifecycle boundary; flag non-zero exits as incidents |

### Supplementary Events

| Event | API | Auditor Use |
|-------|-----|-------------|
| `agent:error` | `window.maestro.process.onAgentError(cb)` | Log error events (type, message, recoverability, raw stderr) |
| `process:usage` | `window.maestro.process.onUsage(cb)` | Track cumulative token spend per session for budget alerting |
| `process:stderr` | `window.maestro.process.onStderr(cb)` | Capture error output that may indicate failed dangerous operations |
| `process:thinking-chunk` | `window.maestro.process.onThinkingChunk(cb)` | Optional: log reasoning traces for post-hoc analysis |

All events are verified to exist in `src/main/preload/process.ts` and are exposed via `window.maestro.process.*`.

---

## ToolExecution Data Model

From `src/main/process-manager/types.ts`:

```typescript
interface ToolExecution {
    toolName: string;    // e.g., "Read", "Write", "Bash", "Glob", "Edit"
    state: unknown;      // Agent-specific; see below
    timestamp: number;   // Epoch ms
}
```

### State Structure by Agent

The `state` field varies by agent type, but follows common patterns:

| Agent | State Fields | Notes |
|-------|-------------|-------|
| **Claude Code** | `{ status: 'running', input: unknown }` | Tool use blocks from mixed content; only emitted at start, not completion |
| **Codex** | `{ status: 'running' \| 'completed', input?: Record<string, unknown>, output?: string }` | Dual events: running (with input) then completed (with output) |
| **OpenCode** | `{ status, input?, output?, title?, metadata?, time? }` | Richest state model; includes timing and metadata |
| **Factory Droid** | — | Does not currently emit tool-execution events |

### Tool Names Observed

Tool names come from the underlying agent's tool system. Common examples:
- **File operations**: `Read`, `Write`, `Edit`, `Glob`
- **Shell execution**: `Bash`, `bash`, `shell`
- **Search/navigation**: `Grep`, `Search`, `ListFiles`
- **Agent-specific**: varies by provider

---

## Risky Operation Detection

The auditor can flag risky operations by analyzing `toolName` and `state.input` from tool-execution events. This is a pattern-matching problem, not a data availability problem.

### Detection Rules (Examples)

| Risk Category | Detection Signal | Confidence |
|---------------|-----------------|------------|
| **Destructive file operations** | `toolName` = "Bash" + `state.input` matches `rm -rf`, `rm -r`, `git clean -f` | High — input args are available in state |
| **Force pushes** | `toolName` = "Bash" + `state.input` matches `git push --force`, `git push -f` | High |
| **Broad glob patterns** | `toolName` = "Bash" + `state.input` matches `find . -delete`, `rm *`, `rm -rf /` | High |
| **Credential access** | `toolName` = "Read"/"Edit" + `state.input` path matches `.env`, `credentials.*`, `*.pem` | Medium — depends on state containing file path |
| **Package modification** | `toolName` = "Bash" + `state.input` matches `npm install`, `pip install` | Medium — may be legitimate |
| **Database operations** | `toolName` = "Bash" + `state.input` matches `DROP TABLE`, `DELETE FROM`, `TRUNCATE` | High |
| **System modifications** | `toolName` = "Bash" + `state.input` matches `chmod`, `chown`, `sudo` | Medium |
| **Network operations** | `toolName` = "Bash" + `state.input` matches `curl`, `wget`, `ssh` | Low — often legitimate |

### Detection Limitations

1. **Claude Code's `state.input` is typed as `unknown`** — the input structure varies. File paths may be embedded differently than in Codex/OpenCode.
2. **Factory Droid does not emit tool-execution events** — the auditor has no visibility into its actions. This is a known gap.
3. **Raw `process:data` parsing is fragile** — agent output formats change between versions. Tool-execution events are the preferred detection path.
4. **No output/completion event from Claude Code** — only the "running" state is emitted, so the auditor cannot confirm whether an operation succeeded or failed via tool-execution alone. `process:data` can supplement.

---

## Storage Needs

### Requirements

The auditor needs persistent storage for:
1. **Audit log entries** — timestamped records of tool executions, risk flags, session metadata
2. **Configuration** — custom risk rules, severity thresholds, notification preferences
3. **Aggregate statistics** — risk event counts by category, session, time period

### Recommended Approach: Plugin-Scoped JSON/SQLite in `userData/plugins/<id>/`

| Option | Pros | Cons |
|--------|------|------|
| **JSON files** | Simple, no dependencies, human-readable | Poor query performance for large logs; no concurrent write safety |
| **SQLite** | Fast queries, indexes, aggregation; proven in Maestro (stats-db.ts) | Requires `better-sqlite3` or similar; main-process only |
| **In-memory + periodic flush** | Fastest; no I/O during operation | Data loss on crash; limited history |

**Recommendation: SQLite via a main-process plugin component.** Rationale:
- Maestro already uses `better-sqlite3` for `stats-db.ts` — the dependency exists
- Audit logs grow unboundedly; SQLite handles this with minimal overhead
- Time-range queries, aggregations, and search are first-class in SQL
- The main process can handle writes without blocking the renderer

### Storage API Gap

Currently, there is **no plugin-scoped storage API** (Gap #8 from [[extension-points]]). Plugins have no sanctioned way to:
- Get a writable directory path under `userData`
- Create or open a SQLite database
- Read/write JSON configuration files

This gap must be addressed before the Auditor can persist data. The required API surface is small:

```typescript
// Proposed plugin storage API
interface PluginStorageApi {
    getDataPath(): string;                      // Returns userData/plugins/<pluginId>/
    readJSON<T>(filename: string): Promise<T>;
    writeJSON(filename: string, data: unknown): Promise<void>;
    openDatabase(filename: string): Database;   // SQLite handle (main-process only)
}
```

---

## Can It Flag Risky Ops from Tool Execution Data?

**Yes, with caveats.**

### What Works Well

1. **Tool name matching** — `toolName` is a reliable string across all agents that emit tool-execution events. "Bash", "Write", "Edit", "Read" are consistent.
2. **Input argument inspection** — for Codex and OpenCode, `state.input` is a structured object with clear fields (command text, file paths, etc.). Pattern matching against these is straightforward.
3. **Timestamp correlation** — events have millisecond timestamps, enabling timeline reconstruction and session-scoped grouping.
4. **Exit code monitoring** — `process:exit` with non-zero codes flags failures, while `agent:error` provides structured error details.

### What Requires Workarounds

1. **Claude Code's `state.input` is untyped** — the auditor must handle `unknown` gracefully, attempting to extract command/path strings from whatever structure is present.
2. **No output/result events from Claude Code** — the auditor only sees intent (tool invoked with input), not outcome (succeeded/failed). Supplement with `process:data` parsing for critical rules.
3. **Factory Droid blindspot** — no tool-execution events. The auditor could fall back to `process:data` (raw output parsing), but this is fragile.

### Confidence Assessment

| Agent | Detection Confidence | Notes |
|-------|---------------------|-------|
| **Codex** | High | Structured state with status, input, output |
| **OpenCode** | High | Richest state model with metadata |
| **Claude Code** | Medium | Input available but untyped; no completion events |
| **Factory Droid** | Low | No tool-execution events at all |

---

## Feasibility Verdict

### Rating: **Moderate**

The core monitoring capability is straightforward — all the event subscriptions exist and provide rich data. The complexity comes from two infrastructure gaps: plugin-scoped storage (required for persistence) and the uneven tool-execution data model across agents.

### Required New Infrastructure

| Infrastructure | Needed For | Complexity | Shared? |
|----------------|-----------|------------|---------|
| Plugin manifest + loader | Loading the plugin | Medium | Yes — all plugins need this |
| Plugin UI registration | Mounting audit log viewer component | Medium | Yes — all UI plugins need this |
| Sandboxed API surface | Restricting to read-only process APIs + storage | Medium | Yes — all plugins need this |
| **Plugin-scoped storage API** | Persisting audit logs and config | Medium | Yes — Auditor + Guardrails need this |
| **Main-process plugin component** | SQLite access for audit database | Medium | Partial — only plugins needing main-process access |

### Infrastructure NOT Required

- No middleware/interception layer (the Auditor only observes, never blocks)
- No new IPC handlers for events (all process events already forward to renderer)
- No process control APIs beyond what exists (no kill/interrupt needed)

### Implementation Sketch

A minimal AI Auditor plugin would:

1. **Renderer component** (audit log viewer):
   - On mount: subscribe to `onToolExecution()`, `onExit()`, `onAgentError()`, `onData()`, `onUsage()`
   - Filter events by sessionId for the active agent or show all
   - Apply risk detection rules to each tool-execution event
   - Display a live-updating log with severity-colored entries
   - On unmount: call all unsubscribe functions

2. **Main-process component** (audit storage):
   - Open SQLite database at `userData/plugins/ai-auditor/audit.db`
   - Create tables: `audit_log` (id, sessionId, toolName, state, riskLevel, timestamp), `risk_rules` (pattern, severity)
   - Expose IPC handlers: `auditor:log-event`, `auditor:query-log`, `auditor:get-risk-summary`

3. **Risk engine** (shared logic):
   - Pattern-match `toolName` + `state.input` against configurable risk rules
   - Assign severity levels: info, warning, critical
   - Emit flagged events to both renderer (for live display) and storage (for persistence)

### Comparison to Agent Dashboard

The Auditor is moderately harder than the [[concept-agent-dashboard|Dashboard]] because:
- Dashboard is **purely renderer-side**; Auditor needs a **main-process component** for SQLite
- Dashboard derives state from **live events only**; Auditor must **persist** an unbounded audit trail
- Dashboard needs no **risk detection logic**; Auditor needs a **pattern matching engine** (albeit simple)
- Dashboard works identically across agents; Auditor must handle **agent-specific state formats**

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| High event volume overwhelms storage writes | Medium | Medium | Batch inserts, write-ahead log, periodic flush instead of per-event writes |
| Agent-specific `state.input` formats break rules | Medium | Medium | Defensive parsing; type-narrowing utilities per agent; regression tests |
| Factory Droid has no tool-execution events | Certain | Low | Document limitation; raw output parsing as fallback; file issue for Factory Droid parser |
| Claude Code changes output format | Low | Medium | Version-pinned parsers; integration tests against known output samples |
| Audit log grows without bound | Certain | Low | Configurable retention policy (auto-prune entries older than N days); matches `stats.clearOldData()` pattern |
| Plugin storage API not designed yet | Certain | High | This is the primary blocker — must be resolved in the plugin infrastructure phase before Auditor can ship |
