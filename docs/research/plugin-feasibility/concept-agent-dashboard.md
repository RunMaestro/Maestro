---
type: research
title: "Plugin Concept: Agent Dashboard Widget"
created: 2026-02-18
tags:
  - plugin
  - concept
  - dashboard
related:
  - "[[extension-points]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-notifications]]"
  - "[[concept-external-integration]]"
---

# Plugin Concept: Agent Dashboard Widget

A real-time dashboard plugin that displays live metrics for all active agents: token usage, cost, context window utilization, tool executions, and process states.

---

## API Mapping

### Required APIs (All Verified)

| API Call | Exists | Location | Purpose |
|----------|--------|----------|---------|
| `window.maestro.process.getActiveProcesses()` | Yes | `preload/process.ts:176` | Snapshot of all running processes (sessionId, toolType, pid, cwd, startTime) |
| `window.maestro.process.onUsage(cb)` | Yes | `preload/process.ts:407` | Real-time token/cost/context updates per agent response |
| `window.maestro.process.onData(cb)` | Yes | `preload/process.ts:184` | Raw agent output stream |
| `window.maestro.process.onToolExecution(cb)` | Yes | `preload/process.ts:236` | Tool call events (name, state, timestamp) |

### Supplementary APIs (Useful, Not Required)

| API Call | Purpose |
|----------|---------|
| `window.maestro.process.onExit(cb)` | Detect agent completion/crash |
| `window.maestro.process.onAgentError(cb)` | Error state monitoring |
| `window.maestro.process.onThinkingChunk(cb)` | Thinking activity indicator |
| `window.maestro.stats.getAggregation(range)` | Historical usage data (tokens by agent, by day) |
| `window.maestro.stats.onStatsUpdate(cb)` | Refresh trigger when stats DB changes |

---

## Data Available

### From `ActiveProcess`

```typescript
interface ActiveProcess {
    sessionId: string;       // Agent identifier
    toolType: string;        // Agent type (claude-code, codex, etc.)
    pid: number;             // OS process ID
    cwd: string;             // Working directory
    isTerminal: boolean;     // Terminal vs AI process
    isBatchMode: boolean;    // Auto Run mode flag
    startTime: number;       // Epoch ms
    command?: string;        // Spawned command
    args?: string[];         // Spawn args
}
```

### From `UsageStats` (per `onUsage` event)

```typescript
interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    contextWindow: number;          // Context window utilization (0-1 range or absolute)
    reasoningTokens?: number;       // Codex o3/o4-mini only
}
```

### From `ToolExecutionEvent` (per `onToolExecution` event)

```typescript
interface ToolExecutionEvent {
    toolName: string;       // e.g., "Read", "Write", "Bash", "Glob"
    state?: unknown;        // Tool-specific state
    timestamp: number;      // Epoch ms
}
```

### From `StatsAggregation` (historical)

```typescript
interface StatsAggregation {
    totalQueries: number;
    totalDuration: number;
    avgDuration: number;
    byAgent: Record<string, { count: number; duration: number }>;
    bySource: { user: number; auto: number };
    byDay: Array<{ date: string; count: number; duration: number }>;
}
```

---

## Read-Only Assessment

**Yes, this plugin can work as purely read-only.** Every API it needs is either a subscription (returns data, no side effects) or a read-only query. No write operations are required:

- `getActiveProcesses()` — read-only snapshot
- `onUsage()` — passive event subscription
- `onData()` — passive event subscription
- `onToolExecution()` — passive event subscription
- `getAggregation()` — read-only database query
- `onStatsUpdate()` — passive notification

The plugin never needs to call `spawn()`, `write()`, `kill()`, or any other mutating API.

---

## UI Surface Options

### Option A: Right Panel Tab

**Pros:**
- Natural home — sits alongside Files, History, Auto Run tabs
- Always accessible without obscuring the main workspace
- Consistent with existing UI patterns

**Cons:**
- `RightPanelTab` is a static union type (`'files' | 'history' | 'autorun'`) — requires type extension
- Tab rendering is hardcoded in `RightPanel.tsx` as a static array `['files', 'history', 'autorun'].map(...)`
- Content rendering uses conditional branches, not a registry
- Minimum width of 384px may constrain dashboard layout

**Required changes (Gap #5, #10 from [[extension-points]]):**
1. Extend `RightPanelTab` to accept plugin-registered tab IDs (e.g., `plugin:${string}` pattern)
2. Refactor `RightPanel.tsx` tab rendering to use a registry instead of hardcoded array
3. Add a content rendering hook/slot for plugin-provided React components

### Option B: Floating Modal/Panel

**Pros:**
- No changes to `RightPanelTab` or `RightPanel.tsx` required
- Can be arbitrarily sized and positioned
- Layer Stack system already supports custom priorities
- Prior art: Usage Dashboard (priority 540), Process Monitor (priority 550) are similar concepts

**Cons:**
- Obscures workspace when open
- Not "always visible" — user must open/close
- Adds yet another modal to the layer stack

**Required changes:**
1. Reserve a modal priority for plugin panels (e.g., 300–399 range per Gap #4)
2. Plugin needs to register a keyboard shortcut or command palette entry to toggle visibility

### Option C: Hybrid — Modal That Docks

Start as a floating panel (quick to implement), graduate to a dockable Right Panel tab once the tab registration infrastructure (Gap #5, #10) is built.

### Recommendation

**Option B (floating modal) for v1, with Option A as a v2 upgrade.** Rationale:
- The floating modal approach requires zero changes to core RightPanel infrastructure
- Usage Dashboard and Process Monitor already prove this pattern works
- The Right Panel tab registration system (Gap #5, #10) is a larger infrastructure project that benefits all UI plugins, not just the dashboard — it should be built generically, not as a one-off for this concept

---

## Feasibility Verdict

### Rating: **Trivial**

This is the simplest plugin concept of all. Every API it needs already exists and is accessible from the renderer process. No new infrastructure is required for a basic implementation.

### Required New Infrastructure

| Infrastructure | Needed For | Complexity |
|----------------|-----------|------------|
| Plugin manifest + loader | Loading the plugin | Medium (shared across all plugins) |
| Plugin UI registration | Mounting the React component | Medium (shared across all plugins) |
| Sandboxed API surface | Restricting to read-only APIs | Medium (shared across all plugins) |

### Infrastructure NOT Required (Unlike Other Concepts)

- No middleware/interception layer (it's purely observational)
- No plugin-scoped storage (it derives state from live events + stats queries)
- No main-process component (all APIs are available via preload bridge)
- No new IPC handlers (existing process and stats APIs suffice)

### Implementation Sketch

A minimal dashboard plugin would:

1. On mount: call `getActiveProcesses()` for initial state
2. Subscribe to `onUsage()`, `onToolExecution()`, `onData()`, `onExit()`, `onAgentError()`
3. Maintain internal state: per-session token totals, tool execution counts, error counts
4. Render: agent cards with live metrics, cost ticker, context window bars
5. Optionally query `getAggregation('day')` for historical sparklines
6. On unmount: call all unsubscribe functions

The only architectural decision is the UI surface (floating modal vs Right Panel tab), and the floating modal approach has zero core dependencies.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Event volume overwhelms plugin renderer | Low | Medium | Debounce/throttle updates, batch state changes |
| No session-scoped filtering (Gap #7) | Certain | Low | Plugin filters events by sessionId internally; trivial |
| `onUsage` reports deltas not cumulatives for some agents | Medium | Low | Plugin maintains running totals per session |
| Context window value semantics vary by agent | Medium | Low | Normalize per agent type; document expected ranges |
