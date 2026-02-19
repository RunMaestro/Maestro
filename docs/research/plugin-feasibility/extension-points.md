---
type: research
title: Existing Extension Points for Plugin System
created: 2026-02-18
tags:
  - plugin
  - architecture
  - feasibility
related:
  - "[[concept-agent-dashboard]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-notifications]]"
  - "[[concept-external-integration]]"
---

# Existing Extension Points for Plugins

This document catalogs all existing architectural extension points in Maestro that a plugin system could leverage. Each section maps a source file to the APIs, events, and patterns it exposes, with assessments of read/write access and plugin consumption feasibility.

---

## 1. ProcessManager Events (`src/main/process-manager/types.ts`)

The `ProcessManager` extends Node's `EventEmitter` and emits typed events defined by `ProcessManagerEvents`. These are the primary real-time data streams a plugin could subscribe to.

### Events

| Event | Signature | Data Exposed | Access |
|-------|-----------|-------------|--------|
| `data` | `(sessionId, data: string)` | Raw agent output text | Read-only |
| `stderr` | `(sessionId, data: string)` | Agent stderr output | Read-only |
| `exit` | `(sessionId, code: number)` | Process exit with code | Read-only |
| `command-exit` | `(sessionId, code: number)` | Shell command exit (non-PTY) | Read-only |
| `usage` | `(sessionId, stats: UsageStats)` | Token counts, cost, context window, reasoning tokens | Read-only |
| `session-id` | `(sessionId, agentSessionId: string)` | Provider session ID assignment | Read-only |
| `agent-error` | `(sessionId, error: AgentError)` | Error type, message, recoverability, raw stderr/stdout | Read-only |
| `thinking-chunk` | `(sessionId, text: string)` | Streaming partial thinking content | Read-only |
| `tool-execution` | `(sessionId, tool: ToolExecution)` | Tool name, state, timestamp | Read-only |
| `slash-commands` | `(sessionId, commands: unknown[])` | Discovered slash commands | Read-only |
| `query-complete` | `(sessionId, data: QueryCompleteData)` | Agent type, source, duration, project path, tab ID | Read-only |

### Key Types

- **`UsageStats`**: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `totalCostUsd`, `contextWindow`, `reasoningTokens?`
- **`ToolExecution`**: `toolName: string`, `state: unknown`, `timestamp: number`
- **`QueryCompleteData`**: `sessionId`, `agentType`, `source` ('user'|'auto'), `startTime`, `duration`, `projectPath?`, `tabId?`
- **`AgentError`**: `type` (AgentErrorType), `message`, `recoverable`, `agentId`, `sessionId?`, `timestamp`, `raw?` (exitCode, stderr, stdout, errorLine)

### Plugin Consumption

All events are **read-only observables**. A plugin could subscribe to any event via the ProcessManager's EventEmitter API in the main process, or via the forwarded IPC events in the renderer. No write access is provided through events — modifying agent behavior requires calling ProcessManager methods directly (`kill()`, `write()`, `interrupt()`).

---

## 2. Process Listener Registration (`src/main/process-listeners/`)

### Pattern

The `setupProcessListeners()` function in `index.ts` is the single orchestration point. It takes a `ProcessManager` instance and a `ProcessListenerDependencies` object, then delegates to focused listener modules:

| Module | Events Handled | Purpose |
|--------|---------------|---------|
| `forwarding-listeners` | `slash-commands`, `thinking-chunk`, `tool-execution`, `stderr`, `command-exit` | Forwards events to renderer via IPC |
| `data-listener` | `data` | Output with group chat buffering + web broadcast |
| `usage-listener` | `usage` | Usage stats with group chat participant/moderator updates |
| `session-id-listener` | `session-id` | Session ID with group chat storage |
| `error-listener` | `agent-error` | Error forwarding |
| `stats-listener` | `query-complete` | Stats database recording |
| `exit-listener` | `exit` | Group chat routing, recovery, synthesis |

### `ProcessListenerDependencies` Interface

This is the dependency injection contract. It provides access to:

- **`getProcessManager()`** — access to ProcessManager
- **`getWebServer()`** — web server for broadcasting
- **`getAgentDetector()`** — agent type detection
- **`safeSend`** — safe IPC send to renderer
- **`powerManager`** — sleep prevention
- **`groupChatEmitters`** — group chat state/message emission
- **`groupChatRouter`** — moderator/agent response routing
- **`groupChatStorage`** — load/update group chats
- **`sessionRecovery`** — session recovery detection
- **`outputBuffer`** — group chat output buffering
- **`outputParser`** — text extraction, session ID parsing
- **`usageAggregator`** — context token calculation
- **`getStatsDB()`** — stats database
- **`debugLog()`** — debug logging
- **`patterns`** — regex patterns for session ID routing
- **`logger`** — structured logging

### Plugin Consumption

A plugin could register as an additional listener module by following the same pattern: a function that takes `(processManager, deps)` and attaches `.on()` handlers. However, there is no formal plugin registration mechanism — currently all listeners are hardcoded in `setupProcessListeners()`. **Gap: Need a plugin listener registration API.**

### Group Chat Session Routing (Prior Art)

The `GROUP_CHAT_PREFIX = 'group-chat-'` constant enables fast string-check routing of events to group chat handlers. This prefix-based routing is excellent prior art for plugin event filtering — plugins could use similar session ID prefix patterns or explicit filter registration.

---

## 3. Preload API Surface (`src/main/preload/index.ts`)

The preload script exposes `window.maestro.*` namespaces via Electron's `contextBridge`. This is the renderer-side API surface. There are **35 namespaces** total:

### Namespace Catalog

| Namespace | Source | Description | Access |
|-----------|--------|-------------|--------|
| `settings` | `settings.ts` | Read/write app settings | Read-write |
| `sessions` | `settings.ts` | Session persistence (load/save) | Read-write |
| `groups` | `settings.ts` | Group persistence | Read-write |
| `process` | `process.ts` | Spawn, write, kill, events | Read-write |
| `agentError` | `settings.ts` | Error state management | Read-write |
| `context` | `context.ts` | Context merge operations | Read-write |
| `web` | `web.ts` | Web interface management | Read-write |
| `git` | `git.ts` | Git operations (status, diff, log, worktrees) | Read-write |
| `fs` | `fs.ts` | Filesystem operations | Read-write |
| `webserver` | `web.ts` | Web server lifecycle | Read-write |
| `live` | `web.ts` | Live session management | Read-write |
| `agents` | `agents.ts` | Agent detection, config | Read (mostly) |
| `dialog` | `system.ts` | OS file/folder dialogs | Read-write |
| `fonts` | `system.ts` | System font listing | Read-only |
| `shells` | `system.ts` | Terminal shell detection | Read-only |
| `shell` | `system.ts` | Open URLs/paths externally | Write-only |
| `tunnel` | `system.ts` | Cloudflare tunnel management | Read-write |
| `sshRemote` | `sshRemote.ts` | SSH remote configuration | Read-write |
| `sync` | `system.ts` | Settings sync (import/export) | Read-write |
| `devtools` | `system.ts` | DevTools toggle | Write-only |
| `power` | `system.ts` | Sleep prevention | Read-write |
| `updates` | `system.ts` | App update management | Read-write |
| `logger` | `logger.ts` | Structured logging | Write-only |
| `claude` | `sessions.ts` | Claude Code sessions (DEPRECATED) | Read-write |
| `agentSessions` | `sessions.ts` | Agent session management | Read-write |
| `tempfile` | `files.ts` | Temp file operations | Read-write |
| `history` | `files.ts` | History entries | Read-write |
| `cli` | `files.ts` | CLI activity tracking | Read-only |
| `speckit` | `commands.ts` | Spec Kit commands | Read-write |
| `openspec` | `commands.ts` | OpenSpec commands | Read-write |
| `notification` | `notifications.ts` | OS notifications, TTS | Write-only |
| `attachments` | `attachments.ts` | Image/file attachments | Read-write |
| `autorun` | `autorun.ts` | Auto Run document management | Read-write |
| `playbooks` | `autorun.ts` | Playbook management | Read-write |
| `marketplace` | `autorun.ts` | Playbook Exchange | Read-only |
| `debug` | `debug.ts` | Debug package generation | Read-write |
| `documentGraph` | `debug.ts` | File watching, document graph | Read-write |
| `groupChat` | `groupChat.ts` | Group chat management | Read-write |
| `app` | `system.ts` | App lifecycle (quit, relaunch) | Write-only |
| `stats` | `stats.ts` | Usage analytics | Read-write |
| `leaderboard` | `leaderboard.ts` | Leaderboard registration | Read-write |
| `symphony` | `symphony.ts` | Token donations / OSS contributions | Read-write |
| `tabNaming` | `tabNaming.ts` | Auto tab name generation | Read-write |
| `directorNotes` | `directorNotes.ts` | Unified history + synopsis | Read-write |
| `wakatime` | `wakatime.ts` | WakaTime integration | Read-only |

### Plugin Consumption

These APIs are available to any code running in the renderer process. A renderer-side plugin could call these directly. However, there is **no sandboxing** — a plugin would have full access to all namespaces. **Gap: Need a scoped/sandboxed API surface for plugins that limits access to approved namespaces.**

---

## 4. IPC Handler Registration (`src/main/ipc/handlers/index.ts`)

### Pattern

`registerAllHandlers(deps: HandlerDependencies)` is called once during app initialization. It registers ~25 handler modules, each setting up `ipcMain.handle()` calls for their domain.

### `HandlerDependencies` Interface

Provides access to core singletons:

- `mainWindow` / `getMainWindow()` — BrowserWindow reference
- `app` — Electron App instance
- `getAgentDetector()` — agent detection
- `agentConfigsStore` — agent configuration persistence
- `getProcessManager()` — process management
- `settingsStore` — app settings
- `sessionsStore` / `groupsStore` — session/group persistence
- `getWebServer()` — web server reference
- `tunnelManager` — Cloudflare tunnels
- `claudeSessionOriginsStore` — session origin tracking

### Registered Handler Modules

Git, Autorun, Playbooks, History, Agents, Process, Persistence, System, Claude, AgentSessions, GroupChat, Debug, Speckit, OpenSpec, Context, Marketplace, Stats, DocumentGraph, SshRemote, Filesystem, Attachments, Web, Leaderboard, Notifications, Symphony, AgentError, TabNaming, DirectorNotes, Wakatime.

### Plugin Consumption

A plugin could register new IPC handlers following the same pattern: export a `registerXxxHandlers(deps)` function and call `ipcMain.handle()`. However, there is **no dynamic handler registration** — all handlers are registered at startup. **Gap: Need a runtime handler registration mechanism for plugins, or a plugin-specific IPC namespace.**

---

## 5. Layer Stack / Modal Priority System (`src/renderer/constants/modalPriorities.ts`)

### Pattern

Modals and overlays use numeric priorities to determine stacking order and Escape key handling. The layer stack system ensures only the topmost layer handles Escape.

### Priority Ranges

| Range | Purpose | Examples |
|-------|---------|---------|
| 1000+ | Critical modals | Quit confirm (1020), Agent error (1010), Tour (1050) |
| 900–999 | High priority | Rename instance (900), Gist publish (980) |
| 700–899 | Standard modals | New instance (750), Quick actions (700), Batch runner (720) |
| 400–699 | Settings/info | Settings (450), Usage dashboard (540), About (600) |
| 100–399 | Overlays/previews | File preview (100), Git diff (200) |
| 1–99 | Autocomplete | Slash autocomplete (50), File tree filter (30) |

### Plugin Consumption

A plugin could register a modal or panel with its own priority value. The system is purely convention-based (numeric constants) — there's no enforcement mechanism. **Gap: Need a reserved priority range for plugin modals (e.g., 300–399) and a registration API so plugins don't collide with core priorities.**

---

## 6. Right Panel Tab System (`src/renderer/types/index.ts`)

### Current Definition

```typescript
export type RightPanelTab = 'files' | 'history' | 'autorun';
```

This is a string literal union type controlling which tab is active in the Right Bar.

### Plugin Consumption

Adding a plugin-provided tab would require extending this union type at runtime, which TypeScript's type system doesn't support dynamically. **Gap: Need to refactor `RightPanelTab` to allow dynamic registration of custom tabs (e.g., string-based with a registry, or a union with a `plugin:${string}` pattern).**

---

## 7. Marketplace Manifest Structure (`src/shared/marketplace-types.ts`)

### Prior Art for Plugin Manifests

The `MarketplacePlaybook` interface is excellent prior art for a plugin manifest:

| Field | Type | Plugin Analog |
|-------|------|---------------|
| `id` | `string` | Plugin slug ID |
| `title` | `string` | Display name |
| `description` | `string` | Short description |
| `category` | `string` | Plugin category |
| `author` | `string` | Plugin author |
| `authorLink?` | `string` | Author URL |
| `tags?` | `string[]` | Searchable tags |
| `lastUpdated` | `string` | Version date |
| `path` | `string` | Entry point / folder path |
| `documents` | `MarketplaceDocument[]` | Plugin files / components |
| `source?` | `PlaybookSource` | 'official' or 'local' |

### Existing Infrastructure

- **Manifest fetching** from GitHub (`https://raw.githubusercontent.com/...`)
- **Local cache** (`userData/marketplace-cache.json`)
- **Error handling** with typed errors: `MarketplaceFetchError`, `MarketplaceCacheError`, `MarketplaceImportError`
- **API response types** for manifest retrieval, document fetching, and import operations

### Plugin Consumption

A plugin manifest system could reuse much of this infrastructure: GitHub-hosted registry, local cache, import/install flow. The `MarketplaceManifest` structure maps well to a `PluginRegistry` structure. **Gap: Need a `PluginManifest` type with additional fields for permissions, entry points (main/renderer), API version requirements, and dependency declarations.**

---

## 8. Stats Subscription API (`src/main/preload/stats.ts`)

### API Methods

| Method | Parameters | Returns | Access |
|--------|-----------|---------|--------|
| `recordQuery` | `QueryEvent` | `Promise<string>` (ID) | Write |
| `startAutoRun` | `AutoRunSession` | `Promise<string>` (ID) | Write |
| `endAutoRun` | `id, duration, tasksCompleted` | `Promise<boolean>` | Write |
| `recordAutoTask` | `AutoRunTask` | `Promise<string>` (ID) | Write |
| `getStats` | `range, filters?` | `Promise<Array<QueryEvent>>` | Read |
| `getAutoRunSessions` | `range` | `Promise<Array<Session>>` | Read |
| `getAutoRunTasks` | `autoRunSessionId` | `Promise<Array<Task>>` | Read |
| `getAggregation` | `range` | `Promise<StatsAggregation>` | Read |
| `exportCsv` | `range` | `Promise<string>` | Read |
| `onStatsUpdate` | `callback` | Unsubscribe function | Read (subscription) |
| `clearOldData` | `olderThanDays` | `Promise<DeleteResult>` | Write |
| `getDatabaseSize` | — | `Promise<number>` | Read |
| `getEarliestTimestamp` | — | `Promise<number\|null>` | Read |
| `recordSessionCreated` | `SessionCreatedEvent` | `Promise<string\|null>` | Write |
| `recordSessionClosed` | `sessionId, closedAt` | `Promise<boolean>` | Write |
| `getSessionLifecycle` | `range` | `Promise<Array<LifecycleEvent>>` | Read |

### Key Types

- **`StatsAggregation`**: `totalQueries`, `totalDuration`, `avgDuration`, `byAgent` (per-agent count/duration), `bySource` (user/auto counts), `byDay` (date/count/duration arrays)
- **`QueryEvent`**: `sessionId`, `agentType`, `source`, `startTime`, `duration`, `projectPath?`, `tabId?`

### Plugin Consumption

The stats API is well-suited for dashboard plugins. Read methods allow querying historical data with time range filters. `onStatsUpdate` enables real-time refresh. Write methods could let plugins record custom metrics. **Note: the stats database (SQLite via `stats-db.ts`) is not directly accessible from the renderer — all access goes through IPC handlers.**

---

## 9. Process API (`src/main/preload/process.ts`)

### Commands (Write)

| Method | Description |
|--------|-------------|
| `spawn(config)` | Spawn a new agent or terminal process |
| `write(sessionId, data)` | Write to process stdin |
| `interrupt(sessionId)` | Send Ctrl+C (SIGINT) |
| `kill(sessionId)` | Kill a process |
| `resize(sessionId, cols, rows)` | Resize terminal |
| `runCommand(config)` | Run a single shell command |
| `getActiveProcesses()` | List active processes |

### Event Subscriptions (Read)

| Event | Callback Signature |
|-------|-------------------|
| `onData` | `(sessionId, data: string)` |
| `onExit` | `(sessionId, code: number)` |
| `onSessionId` | `(sessionId, agentSessionId: string)` |
| `onSlashCommands` | `(sessionId, commands: string[])` |
| `onThinkingChunk` | `(sessionId, content: string)` |
| `onToolExecution` | `(sessionId, toolEvent: ToolExecutionEvent)` |
| `onSshRemote` | `(sessionId, sshRemote: SshRemoteInfo \| null)` |
| `onUsage` | `(sessionId, usageStats: UsageStats)` |
| `onAgentError` | `(sessionId, error: AgentError)` |
| `onStderr` | `(sessionId, data: string)` |
| `onCommandExit` | `(sessionId, code: number)` |

Plus remote-command event subscriptions for the web interface (`onRemoteCommand`, `onRemoteSwitchMode`, `onRemoteInterrupt`, `onRemoteSelectSession`, `onRemoteSelectTab`, `onRemoteNewTab`, `onRemoteCloseTab`, `onRemoteRenameTab`).

### Plugin Consumption

This is the most plugin-relevant API surface. A renderer-side plugin can subscribe to all events for real-time monitoring (dashboard, auditor) and invoke `kill()` / `interrupt()` for guardrails. The `getActiveProcesses()` method provides a snapshot of all running processes. **Gap: No session-scoped filtering in subscriptions — plugins receive all events for all sessions and must filter themselves.**

---

## Summary of Identified Gaps

| # | Gap | Severity | Blocks |
|---|-----|----------|--------|
| 1 | No plugin listener registration API (main process) | High | Guardrails, Auditor |
| 2 | No sandboxed/scoped renderer API surface | High | All renderer plugins |
| 3 | No runtime IPC handler registration for plugins | Medium | External Integration |
| 4 | No reserved modal priority range for plugins | Low | Dashboard (if modal) |
| 5 | Static `RightPanelTab` union — no dynamic tab registration | Medium | Dashboard |
| 6 | No `PluginManifest` type (permissions, entry points, API version) | High | All plugins |
| 7 | No session-scoped event filtering in process subscriptions | Low | Performance optimization |
| 8 | No plugin-scoped storage API | Medium | Auditor, Guardrails |
| 9 | No middleware/interception layer in ProcessManager event chain | High | Guardrails (approach A) |
| 10 | No plugin UI registration system (panels, tabs, widgets) | High | Dashboard, any UI plugin |
