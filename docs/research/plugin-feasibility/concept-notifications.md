---
type: research
title: "Plugin Concept: Third-Party Notifications"
created: 2026-02-18
tags:
  - plugin
  - concept
  - notifications
related:
  - "[[extension-points]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-dashboard]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-external-integration]]"
---

# Plugin Concept: Third-Party Notifications

A plugin that sends notifications to external services (Slack, Discord, email) when significant events occur: agent completion, failures, auto-run batch completion, budget thresholds, etc. This is a "fan-out" plugin — it subscribes to internal events and pushes outbound HTTP requests to third-party APIs.

---

## Event Subscriptions Needed

### Primary Events

| Event | API | Data Available | Notification Use |
|-------|-----|---------------|-----------------|
| `process:exit` | `window.maestro.process.onExit(cb)` | `sessionId`, exit code | Agent task completion (code 0) or failure (non-zero). Core trigger for "agent finished" notifications |
| `agent:error` | `window.maestro.process.onAgentError(cb)` | `sessionId`, `AgentError { type, message, recoverable, agentId, timestamp, raw? }` | Alert on failures: auth expired, token exhaustion, rate limits, crashes. Include error type and message in notification |
| `process:usage` | `window.maestro.process.onUsage(cb)` | `sessionId`, `UsageStats { inputTokens, outputTokens, cacheRead/Creation, totalCostUsd, contextWindow, reasoningTokens? }` | Budget threshold alerts: "Agent X has spent $Y" when cumulative cost exceeds configured limit |

### Auto-Run Batch Events

| Event Source | Observable? | How | Notification Use |
|-------------|------------|-----|-----------------|
| Batch run completion | **Partially** | No dedicated IPC event. Renderer-side only: `batchRunStates[sessionId].isRunning` transitions `true` → `false` in Zustand store, or `processingState` transitions to `'IDLE'` | "Batch run completed: X/Y tasks done in Z minutes" |
| Batch run started | **Partially** | Zustand store: `START_BATCH` action sets `processingState: 'INITIALIZING'` | "Batch run started with X documents" |
| Batch error/pause | **Partially** | Zustand store: `SET_ERROR` action sets `processingState: 'PAUSED_ERROR'`, populates `error` field | "Batch run paused: error on task X" |
| Loop iteration | **Partially** | Zustand store: `INCREMENT_LOOP` action increments `loopIteration` | "Loop N completed, starting loop N+1" |
| Individual task progress | **Partially** | Zustand store: `UPDATE_PROGRESS` action updates `currentDocTasksCompleted` | Optional: per-task progress (likely too noisy for external notifications) |

### Auto-Run File Changes

| Event | API | Data Available | Notification Use |
|-------|-----|---------------|-----------------|
| `autorun:fileChanged` | `window.maestro.autorun.onFileChanged(cb)` | `{ folderPath, filename, eventType: 'rename' | 'change' }` | Optional: notify when auto-run documents are modified (useful for team awareness) |

### Supplementary Events

| Event | API | Notification Use |
|-------|-----|-----------------|
| `process:tool-execution` | `window.maestro.process.onToolExecution(cb)` | Optional: alert on specific tool executions (e.g., "Agent ran Bash command") — likely too noisy for most users |
| `process:data` | `window.maestro.process.onData(cb)` | Optional: forward agent output snippets — high volume, not recommended for notifications |

---

## Auto-Run State Observability Assessment

### What's Available

The auto-run (batch run) state is managed entirely in the renderer via a Zustand store (`useBatchStore` in `src/renderer/stores/batchStore.ts`). The state model is rich:

```typescript
interface BatchRunState {
  isRunning: boolean;
  isStopping: boolean;
  processingState: 'IDLE' | 'INITIALIZING' | 'RUNNING' | 'STOPPING' | 'PAUSED_ERROR' | 'COMPLETING';
  documents: string[];
  currentDocumentIndex: number;
  totalTasksAcrossAllDocs: number;
  completedTasksAcrossAllDocs: number;
  loopEnabled: boolean;
  loopIteration: number;
  startTime?: number;
  error?: AgentError;
  // ... additional fields
}
```

### Key Finding: No IPC-Level Batch Events

**Batch run lifecycle events are NOT emitted via IPC.** There is no `process:batch-complete`, `autorun:started`, or similar channel. Completion is handled entirely within the renderer:

1. The `useBatchProcessor` hook dispatches `COMPLETE_BATCH` to the Zustand reducer
2. An `onComplete` callback fires with `BatchCompleteInfo { sessionId, sessionName, completedTasks, totalTasks, wasStopped, elapsedTimeMs }`
3. `broadcastAutoRunState(sessionId, null)` is called to notify web/mobile clients
4. The built-in `window.maestro.notification.show()` is called for OS-level completion notifications

### How a Plugin Would Observe Batch State

A renderer-side plugin has two options:

1. **Zustand store subscription** (preferred): `useBatchStore.subscribe(state => ...)` — receives every state update, can detect transitions (RUNNING → IDLE = completion, RUNNING → PAUSED_ERROR = failure)
2. **Polling `getActiveProcesses()`**: Less efficient, doesn't capture batch-level metadata

For a main-process plugin, batch state is **not directly observable**. The plugin would need either:
- A new IPC channel that the renderer fires on batch state transitions (Gap #11 proposal below)
- Or the plugin runs its renderer component, which subscribes to Zustand and forwards relevant events to the main process via IPC

---

## Outbound HTTP Assessment

### Slack Webhooks

| Aspect | Detail |
|--------|--------|
| Protocol | HTTPS POST to `https://hooks.slack.com/services/T.../B.../xxx` |
| Auth | URL contains the token (no headers needed) |
| Payload | JSON: `{ "text": "message", "blocks": [...] }` |
| CORS | **No CORS headers** — Slack webhook endpoints do not send `Access-Control-Allow-Origin` |
| Renderer feasibility | **Blocked by CORS** — `fetch()` from Electron renderer will fail for Slack webhooks |
| Main process feasibility | **Works** — Node.js `fetch()` / `https.request()` has no CORS restrictions |

### Discord Webhooks

| Aspect | Detail |
|--------|--------|
| Protocol | HTTPS POST to `https://discord.com/api/webhooks/<id>/<token>` |
| Auth | URL contains the token |
| Payload | JSON: `{ "content": "message", "embeds": [...] }` |
| CORS | **No CORS headers** for webhook endpoints |
| Renderer feasibility | **Blocked by CORS** |
| Main process feasibility | **Works** |

### Email via SMTP

| Aspect | Detail |
|--------|--------|
| Protocol | SMTP (TCP, not HTTP) |
| Libraries | `nodemailer` or similar |
| Renderer feasibility | **Impossible** — renderer has no TCP socket access |
| Main process feasibility | **Works** — Node.js has full network access; `nodemailer` is a standard dependency |

### Generic Webhooks (Custom URLs)

| Aspect | Detail |
|--------|--------|
| Protocol | HTTPS POST to user-configured URL |
| CORS | **Depends on endpoint** — most internal/self-hosted endpoints don't set CORS headers |
| Renderer feasibility | **Unreliable** — works only if endpoint sends appropriate CORS headers |
| Main process feasibility | **Works** for all endpoints |

### Summary: Main Process Required for HTTP

| Channel | Renderer | Main Process |
|---------|----------|-------------|
| Slack webhook | CORS blocked | Works |
| Discord webhook | CORS blocked | Works |
| Email (SMTP) | Impossible | Works |
| Custom webhook | Unreliable | Works |
| OS notification | Works (existing API) | N/A |

**Conclusion: The notification plugin MUST have a main-process component for outbound HTTP.** The renderer cannot reliably reach third-party webhook endpoints due to CORS restrictions. Electron's renderer runs in a browser-like sandbox where `fetch()` respects CORS policies.

---

## Existing Notification Infrastructure

Maestro already has a `window.maestro.notification` API (`src/main/preload/notifications.ts`):

| Method | Purpose | Plugin Relevance |
|--------|---------|-----------------|
| `show(title, body)` | OS-native notification via `Notification` API | Could be used as a local fallback alongside external notifications |
| `speak(text, command?)` | Execute custom notification command (TTS, logging) | Extensible — a plugin could register a custom command that sends webhooks |
| `stopSpeak(notificationId)` | Stop a running notification command | Process management for long-running commands |
| `onCommandCompleted(handler)` | Subscribe to command completion | Lifecycle management |

This API handles **local** notifications only. The plugin would extend this with **external** (Slack, Discord, email) delivery.

---

## Plugin Architecture: Renderer vs Main Process

### Verdict: Needs Both Renderer AND Main Process Components

```
┌─────────────────────────────────────────────────────────┐
│ RENDERER (event observation + UI)                       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Event Listeners                                  │   │
│  │ • process.onExit()       → agent completion      │   │
│  │ • process.onAgentError() → failure alerts        │   │
│  │ • process.onUsage()      → budget tracking       │   │
│  │ • batchStore.subscribe() → auto-run lifecycle    │   │
│  └──────────────────┬──────────────────────────────┘   │
│                     │ IPC: notifications:send           │
│  ┌──────────────────┴──────────────────────────────┐   │
│  │ Settings UI (configuration panel)                │   │
│  │ • Webhook URLs, channel selections               │   │
│  │ • Event filter checkboxes                        │   │
│  │ • Budget threshold inputs                        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         │
                    IPC bridge
                         │
┌─────────────────────────────────────────────────────────┐
│ MAIN PROCESS (HTTP delivery)                            │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Notification Dispatcher                          │   │
│  │ • Receives structured events via IPC             │   │
│  │ • Formats messages per channel (Slack, Discord)  │   │
│  │ • Sends HTTPS POST (no CORS restrictions)        │   │
│  │ • Handles retries, rate limits, failures         │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Config Storage                                   │   │
│  │ • Webhook URLs, tokens (encrypted at rest)       │   │
│  │ • Per-event notification preferences             │   │
│  │ • Delivery history (last N notifications)        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Why Not Renderer-Only?

1. **CORS blocks outbound webhooks** — the primary purpose of this plugin cannot be achieved from the renderer alone
2. **Credentials should not live in renderer memory** — webhook URLs contain auth tokens; main process is more secure
3. **Retry/queue logic belongs in a persistent process** — the renderer may be in the background or have its view destroyed

### Why Not Main-Process-Only?

1. **Batch state is only in renderer** — the Zustand store with `BatchRunState` is not accessible from the main process. The renderer must observe it and forward events.
2. **Settings UI must render in the app** — configuration needs a React component for webhook URL input, event selection, test buttons
3. **Process events already forward to renderer** — subscribing to `process:exit`, `agent:error`, etc. is easiest from the preload API

---

## Required New Infrastructure

| Infrastructure | Needed For | Complexity | Shared With Other Plugins? |
|----------------|-----------|------------|---------------------------|
| Plugin manifest + loader | Loading the plugin | Medium | Yes — all plugins |
| Plugin UI registration | Settings panel / config component | Medium | Yes — all UI plugins |
| Sandboxed API surface | Restricting renderer access | Medium | Yes — all plugins |
| **Main-process plugin component** | Outbound HTTP dispatch | Medium | Yes — Auditor, Guardrails need this too |
| **Plugin-scoped storage API** (Gap #8) | Persisting webhook configs and delivery history | Medium | Yes — Auditor, Guardrails |
| **Plugin-to-main IPC bridge** | Renderer event listener → main process HTTP dispatch | Low | Partial — any plugin with split architecture |

### Infrastructure NOT Required

- No middleware/interception layer (notifications only observe, never block)
- No new process control APIs (no kill/interrupt needed)
- No modifications to the event pipeline
- No new event channels for process events (all needed events already exist)

### New Gap Identified

| # | Gap | Severity | Blocks |
|---|-----|----------|--------|
| 11 (proposed) | No IPC-level auto-run batch lifecycle events | Medium | Notifications (batch completion), any main-process consumer of batch state |

Currently, batch run completion is only observable in the renderer (Zustand store). For main-process plugins to react to batch completion, either:
- (A) The renderer plugin component subscribes to Zustand and fires a plugin IPC event, or
- (B) Core Maestro emits batch lifecycle events via IPC (cleaner, benefits all main-process consumers)

Option (A) is sufficient for v1; option (B) is the proper long-term solution.

---

## Feasibility Verdict

### Rating: **Moderate**

The notification plugin is architecturally straightforward — all needed events exist, and the delivery mechanism (outbound HTTP) is well-understood. The complexity comes from requiring both renderer and main-process components to bridge event observation with CORS-free HTTP dispatch.

### Comparison to Other Concepts

| Concept | Rating | Renderer-Only? | Main-Process Needed? | New Infra |
|---------|--------|----------------|---------------------|-----------|
| [[concept-agent-dashboard|Dashboard]] | Trivial | Yes | No | Minimal |
| **Notifications** | **Moderate** | **No** | **Yes (HTTP dispatch)** | **Plugin IPC bridge, storage** |
| [[concept-ai-auditor|Auditor]] | Moderate | No | Yes (SQLite) | Storage API |
| [[concept-agent-guardrails|Guardrails]] | Moderate-Hard | No | Yes (process control) | Process control API, storage |

Notifications is slightly easier than the Auditor because:
- No unbounded storage (delivery history can be capped or omitted)
- No pattern-matching engine (just event → message formatting)
- Outbound HTTP is simpler than SQLite schema management

But harder than the Dashboard because:
- Requires a main-process component (CORS)
- Requires credential storage (webhook URLs)
- Requires the renderer ↔ main process bridge for batch events

### Implementation Sketch

A minimal Third-Party Notifications plugin would:

1. **Renderer component** (event observer + settings UI):
   - On mount: subscribe to `onExit()`, `onAgentError()`, `onUsage()`, `batchStore.subscribe()`
   - Detect significant transitions (agent done, error, batch complete, budget exceeded)
   - Forward structured notification payloads to main process via plugin IPC
   - Settings panel: webhook URL inputs, per-event toggles, test button

2. **Main-process component** (HTTP dispatcher):
   - Receive notification payloads via IPC
   - Format for target service (Slack Block Kit, Discord embeds, email HTML)
   - Send HTTPS POST with retry logic (exponential backoff, 3 retries)
   - Log delivery results to plugin storage

3. **Configuration storage** (via plugin storage API):
   - Webhook URLs (encrypted at rest)
   - Enabled channels per event type
   - Budget threshold values
   - Delivery history (last 100 entries, auto-pruned)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Webhook URL contains credentials — leak risk | Medium | High | Store in main process only; never expose in renderer; use Electron's `safeStorage` API for encryption at rest |
| Notification spam from high-frequency events | Medium | Medium | Debounce/throttle: max 1 notification per event type per N seconds; batch completion summary instead of per-task |
| Slack/Discord API rate limits (1 req/sec for Slack) | Medium | Low | Queue with rate limiting; batch multiple events into single message when possible |
| Auto-run batch state not observable from main process | Certain | Medium | v1: renderer subscribes to Zustand, forwards to main; v2: add IPC batch lifecycle events to core |
| Webhook endpoint is unreachable | Medium | Low | Retry with backoff; surface delivery failures in settings UI; don't block agent operations |
| User configures webhook URL incorrectly | Medium | Low | "Test notification" button in settings; validate URL format; show last delivery status |
