# CLAUDE-IPC.md

IPC API surface documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## Overview

The `window.maestro` API exposes the following namespaces:

## Core APIs

- `settings` - Get/set app settings
- `sessions` / `groups` - Agent and group persistence
- `process` - Spawn, write, kill, resize
- `fs` - readDir, readFile
- `dialog` - Folder selection
- `shells` - Detect available shells
- `logger` - System logging

## Agent & Provider Sessions

- `agents` - Detect, get, config, refresh, custom paths, getCapabilities
- `agentSessions` - Generic provider session storage API (list, read, search, delete)
- `agentError` - Agent error handling (clearError, retryAfterError)
- `claude` - (Deprecated) Claude Code provider sessions - use `agentSessions` instead

## Git Integration

- `git` - Status, diff, isRepo, numstat, branches, tags, info
- `git` - Worktree support: worktreeInfo, getRepoRoot, worktreeSetup, worktreeCheckout
- `git` - PR creation: createPR, checkGhCli, getDefaultBranch

## Web & Live Sessions

- `web` - Broadcast user input, Auto Run state, tab changes to web clients
- `live` - Toggle live sessions, get status, dashboard URL, connected clients
- `webserver` - Get URL, connected client count
- `tunnel` - Cloudflare tunnel: isCloudflaredInstalled, start, stop, getStatus

## Automation

- `autorun` - Document and image management for Auto Run
- `playbooks` - Batch run configuration management
- `history` - Per-agent execution history (see History API below)
- `cli` - CLI activity detection for playbook runs
- `tempfile` - Temporary file management for batch processing

## Analytics & Visualization

- `stats` - Usage statistics: recordQuery, getAggregatedStats, exportCsv, clearOldData, getDatabaseSize
- `stats` - Auto Run tracking: startAutoRun, endAutoRun, recordTask, getAutoRunSessions
- `stats` - Real-time updates via `stats:updated` event broadcast
- `documentGraph` - File watching: watchFolder, unwatchFolder
- `documentGraph` - Real-time updates via `documentGraph:filesChanged` event

## External Session Activity

Surfaces externally-spawned agent sessions (e.g., Claude Code launched over SSH by the same OS user) observed via per-agent storage-directory watchers. Backed by `ExternalSessionCoordinator`; event shape and the `isActive(event)` helper live in `src/shared/sessionActivity.ts`. See the **External Agent Visibility** section in [[CLAUDE.md]] for the watcher pipeline.

- `storage.listExternalSessions()` - Hydrates the current snapshot of watched session files. Returns `Promise<SessionActivityEvent[]>`.
- `storage.onExternalActivity(callback)` - Subscribes to coalesced coordinator state changes. The callback receives `SessionActivityEvent[]` batches as files grow or appear. Returns an unsubscribe function.

```typescript
window.maestro.storage = {
  listExternalSessions: () => Promise<SessionActivityEvent[]>,
  onExternalActivity: (callback: (events: SessionActivityEvent[]) => void) => () => void,
};
```

Each `SessionActivityEvent` carries `{ agentId, sessionId, projectPath, lastActivityAt, source, sizeBytes }`, where `source` is `'local'` for Maestro-spawned sessions and `'external'` for watch-only observations.

## History API

Per-agent history storage with 5,000 entries per agent (up from 1,000 global). Each agent's history is stored as a JSON file in `~/Library/Application Support/Maestro/history/{sessionId}.json`.

```typescript
window.maestro.history = {
  getAll: (projectPath?, sessionId?) => Promise<HistoryEntry[]>,
  add: (entry) => Promise<boolean>,
  clear: (projectPath?, sessionId?) => Promise<boolean>,
  delete: (entryId, sessionId?) => Promise<boolean>,
  update: (entryId, updates, sessionId?) => Promise<boolean>,
  // For AI context integration:
  getFilePath: (sessionId) => Promise<string | null>,
  listSessions: () => Promise<string[]>,
  // External change detection:
  onExternalChange: (handler) => () => void,
  reload: () => Promise<boolean>,
};
```

**AI Context Integration**: Use `getFilePath(sessionId)` to get the path to an agent's history file. This file can be passed directly to AI agents as context, giving them visibility into past completed tasks, decisions, and work patterns.

## Power Management

- `power` - Sleep prevention: setEnabled, isEnabled, getStatus, addReason, removeReason

## Integrations

- `wakatime` - WakaTime CLI management: checkCli, validateApiKey

## Utilities

- `fonts` - Font detection
- `notification` - Desktop notifications, text-to-speech
- `devtools` - Developer tools: open, close, toggle
- `attachments` - Image attachment management
