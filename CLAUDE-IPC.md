# CLAUDE-IPC.md

IPC API surface documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## Overview

The `window.maestro` API exposes the following namespaces:

## Core APIs

- `settings` - Get/set app settings
- `sessions` / `groups` - Agent and group persistence
- `process` - Spawn, write, kill, resize, runCommand/cancelCommand (one-off commands); getHeadlessActivity/onHeadlessActivity (transient host process counts by target agent, versioned snapshots)
- `fs` - ~20 methods: readDir, readDirTree, listTreeRemote, readFile / cancelReadFile, downloadRemoteFile, writeFile, writeImageFile, mkdir, stat, rename, delete / deleteMany, copyPath, compressFolder, directorySize, countItems, startDragOut
- `parquet` - Windowed reads over an open Parquet file (see Parquet API below)
- `dialog` - selectFolder, saveFile
- `shells` - Detect available shells
- `platform` - Synchronous `process.platform` string (the real one, not the renderer shim); prefer `isWindowsPlatform()` etc. in `src/renderer/utils/platformUtils.ts`
- `maestroCliPath` - Resolved path to the bundled `maestro-cli` binary, for template resolution
- `app` - App lifecycle events: quit confirmation, system resume, deep links, menu commands, browser-tab shortcut forwarding
- `windows` - Multi-window system: create, close, list, moveSession, focusWindow, getBounds, drop-zone highlight, remote command relay
- `updates` - Auto-updater: check, download, install, getStatus, onStatus, setAllowPrerelease
- `sync` - Storage Location (custom sync folder): getSettings, getCurrentStoragePath, selectSyncFolder, setCustomPath
- `images` - `resolve` a `maestro-image://` session-image reference to its on-disk file
- `shell` - OS shell integration: openExternal, openPath, trashItem, showItemInFolder, clipboard image read/write, and `capturePage(rect?)`. `capturePage` screenshots the CALLING window as a PNG data URL (`window:capturePage` shoots `event.sender`, so a surface opened in a second window captures itself); pass a viewport-relative CSS-pixel rect to narrow the shot to one region, omit it for the whole page. Resolves null when there is nothing to capture.
- `logger` - System logging

## Agent & Provider Sessions

- `agents` - Detect, get, config, refresh, custom paths, getCapabilities
- `agentSessions` - Generic provider session storage API (list, read, search, delete)
- `agentError` - Agent error handling (clearError, retryAfterError)
- `memory` - Agent memory (Claude per project, Codex per account); every method takes a `MemoryTarget` (`src/shared/agentMemory.ts`): list, read, write, create, delete, search, getPath, plus orphan handling. `search` matches a query against both filenames and file bodies and returns the first matching line per hit, so the Memory Viewer's filter box does not have to pull every file into the renderer.
- `claude` - (Deprecated) Claude Code provider sessions - use `agentSessions` instead
- `context` - Context grooming for cross-provider handoff: getStoredSession, groomContext, cancelGrooming
- `crossAgent` - `@mention` consults: send, cancel (by source agent), onChunk
- `groupChat` - Group chat CRUD, moderator start/stop, submitMessage, the main-owned queue (getQueue, queueAdd/Remove/Reorder/Resume, onQueueState)
- `tabNaming` - generateTabName (auto-naming a tab from its first message)
- `tabs` - Renderer-to-main tab lifecycle notices (notifyAiTabClosed); fire-and-forget
- `aiCommand` - AI command mode: `suggest` a shell command from plain English
- `agentRun` - Agent run ledger and campaigns: list, record, show, events, cancel, retry, resolveFinding, merge
- `symphony` - Symphony contributions: registry, issues, state, start / complete / cancel, draft PRs
- `pianola` - Pianola auto-answer rules, decisions, suggestions, supervisor
- `coworking` - Computer-use coworking: install status, terminal / browser session sync, buffer and browser-op request relays
- `browserSession` - clearSessionData for an in-app browser partition
- `contextTimeline` - Context Timeline capture log: getCaptures, clearCaptures

## Git Integration

- `git` - Status, diff, isRepo, init, commitAll, numstat, branches, tags, info, log, graph, show / showFile, commitCount
- `git` - Worktree support: worktreeInfo, getRepoRoot, worktreeSetup, worktreeRunSetup, worktreeCheckout, listWorktrees, removeWorktree, scan / watch / unwatchWorktreeDirectory, onWorktreeDiscovered / onWorktreeRemoved
- `git` - PR creation: createPR, checkGhCli, getDefaultBranch, createGist
- `git` - Remote sync: runCommand/cancelCommand/onCommandOutput (streaming pull/push/fetch), checkoutBranch, switchBranch
- `sshRemote` - SSH remote configs: saveConfig, deleteConfig, getConfigs, get / setDefaultId, test, getSshConfigHosts

## Web & Live Sessions

- `web` - Broadcast user input, Auto Run state, tab changes to web clients
- `live` - Live mode: toggle, getStatus, getDashboardUrl, getLiveSessions, startServer / stopServer, disableAll, persistent token, onStateChanged (no client count; that is `webserver`)
- `webserver` - getUrl, getConnectedClients
- `tunnel` - Cloudflare tunnel: isCloudflaredInstalled, start, stop, getStatus
- `webLogin` - Web Login accounts: listUsers, createUser, setPassword, setDisplayName, setDisabled, deleteUser
- `federation` - Read-only mirror of Federation peers (desktop-only, memory only): status, peers, snapshot, transcript, reconnect, onEvent (`federation:event`), onReset (`federation:reset`). No service, and `status()` reads `{ enabled: false }`, while the Encore Feature is off

## Automation

- `autorun` - Document and image management for Auto Run
- `playbooks` - Batch run configuration management
- `history` - Per-agent execution history (see History API below)
- `cli` - CLI activity detection for playbook runs
- `tempfile` - Temporary file management for batch processing
- `cue` - Maestro Cue event-driven automation (see Cue API below)
- `cueBackup` - Snapshot/restore of every workspace's `.maestro/cue.yaml` + `.maestro/prompts/` as a zip in `userData/cue-backups/` (Cue modal Backup tab)
- `marketplace` - Playbook marketplace: getManifest, refreshManifest, getDocument, getReadme, importPlaybook, onManifestChanged
- `speckit` / `openspec` / `bmad` - Slash-command prompt sets, same shape each: getMetadata, getPrompts, getCommand, savePrompt, resetPrompt, refresh
- `prompts` - Core prompts (Settings -> Maestro Prompts): get, getAll, save, reset, getBundledDefault, getPath, listFiles
- `maestroCli` - Bundled CLI install: checkStatus, installOrUpdate
- `plugins` - Plugin subsystem: list, setEnabled, install / update / uninstall, contributions, consent grants, invokeCommand / invokeTool, panel and grouping events
- `feedback` - GitHub feedback flow: checkGhAuth, submit / submitConversation, searchIssues, subscribeIssue, drafts, account memory

## Analytics & Visualization

- `stats` - Usage statistics: recordQuery, getAggregation, getTokenUsage, getDelegationTotals / getDelegationByDay, exportUsage, clearOldData, getDatabaseSize, recordResilience, getSessionLifecycle
- `stats` - Auto Run tracking: startAutoRun, endAutoRun, recordAutoTask, getAutoRunSessions, getAutoRunTasks
- `stats` - Real-time updates via `stats:updated` event broadcast
- `cueStats` - Cue analytics: getAggregation, getHistoricalConductorCredit
- `leaderboard` - Leaderboard: getInstallationId, submit, pollAuthStatus, resendConfirmation, get, getLongestRuns, sync
- `directorNotes` - Unified history: getUnifiedHistory, getGraphData(bucketCount, lookbackHours), getRichOverviewStats, getOffsetForTimestamp, generateSynopsis, onSynopsisProgress, onHistoryEntryAdded
- `debug` - Debug package create / preview, getAppStats, Chromium profiling start / stop, simulateAuthExpiry
- `documentGraph` - File watching: watchFolder, unwatchFolder
- `documentGraph` - Real-time updates via `documentGraph:filesChanged` event

## History API

Per-agent history storage, capped at `MAX_ENTRIES_PER_SESSION` (10000, `src/shared/history.ts`) by default; the `maxLogBuffer` setting overrides it through `resolveHistoryEntryLimit()`. Each agent's history is a JSONL file at `userData/history/{sessionId}.jsonl` (one entry per line); `.json` is the legacy single-object format, migrated automatically by `HistoryManager` (`src/main/history-manager.ts`).

```typescript
window.maestro.history = {
  getAll: (projectPath?, sessionId?, sharedContext?) => Promise<HistoryEntry[]>,
  getAllPaginated: (options?) => Promise<PaginatedResult<HistoryEntry>>,
  getCueGroupRuns: (options) => Promise<...>,
  add: (entry, sharedContext?) => Promise<boolean>,
  clear: (projectPath?) => Promise<boolean>,
  delete: (entryId, sessionId?) => Promise<boolean>,
  update: (entryId, updates, sessionId?) => Promise<boolean>,
  updateSessionName: (agentSessionId, sessionName) => Promise<boolean>,
  // Activity-graph data. lookbackHours null = all-time; each (bucketCount,
  // lookback) pair is disk-cached server-side keyed by the session file's
  // mtime+size, so repeat calls are cheap.
  getGraphData: (sessionId, bucketCount, lookbackHours, sharedContext?, projectPath?) => Promise<HistoryGraphData>,
  // Resolve the offset (newest-first sorted) of the first entry whose
  // timestamp <= the given value. Powers click-to-jump on the activity graph.
  getOffsetForTimestamp: (sessionId, timestamp, lookbackHours?, types?) => Promise<number>,
  // For AI context integration:
  getFilePath: (sessionId) => Promise<string | null>,
  listSessions: () => Promise<string[]>,
  // External change detection:
  onExternalChange: (handler) => () => void,
  reload: () => Promise<boolean>,
};
```

`sharedContext` is `{ sshRemoteId, remoteCwd }` for an SSH-backed agent whose history lives on the remote.

**AI Context Integration**: Use `getFilePath(sessionId)` to get the path to an agent's history file. This file can be passed directly to AI agents as context, giving them visibility into past completed tasks, decisions, and work patterns.

**Activity Graph (cached)**: `getGraphData` returns pre-aggregated buckets for the requested lookback (or the full session history when `lookbackHours` is null). Cached to `userData/history-cache/` keyed by source-file fingerprint plus the (bucketCount, lookback) pair, so the graph does not recompute across thousands of entries on every interaction. The unified-history equivalent is `window.maestro.directorNotes.getGraphData(bucketCount, lookbackHours)`.

## Cue API

Maestro Cue event-driven automation engine. Gated behind the `maestroCue` Encore Feature flag (defaults to ON, `src/shared/encoreFeatureDefaults.ts`).

```typescript
window.maestro.cue = {
  // Query engine state
  getStatus: () => Promise<CueSessionStatus[]>,
  getActiveRuns: () => Promise<CueRunResult[]>,
  getActivityLog: (limit?) => Promise<CueRunResult[]>,

  // Engine controls
  enable: () => Promise<void>,
  disable: () => Promise<void>,

  // Run management
  stopRun: (runId) => Promise<boolean>,
  stopAll: () => Promise<void>,

  // Session config management
  refreshSession: (sessionId, projectRoot) => Promise<void>,

  // YAML config file operations
  readYaml: (projectRoot) => Promise<string | null>,
  writeYaml: (projectRoot, content) => Promise<void>,
  validateYaml: (content) => Promise<{ valid: boolean; errors: string[] }>,

  // Real-time updates
  onActivityUpdate: (callback) => () => void,  // Returns unsubscribe function
};
```

Also on `cue` (see `src/main/preload/cue.ts` for signatures): getSettings / saveSettings, getGraphData, getRunLiveOutput, getEventCount, setActive, triggerSubscription (manual Play), getQueueStatus, getMetrics, getFanInHealth, removeSession, scheduled task CRUD (list / create / update / cancelScheduledTask), deleteYaml, renamePipeline, savePipelineLayout / loadPipelineLayout.

**Events:** `cue:activityUpdate` is pushed from main process on subscription triggers, run completions, config reloads, and config removals.

## Cue Backup API

Snapshot/restore of every workspace's `.maestro/cue.yaml` + `.maestro/prompts/` as a single zip in `userData/cue-backups/`. Used by the Cue modal's Backup tab. Restore is **additive only** - files in the live workspace that are not in the backup are left alone (deletion is too easy to regret).

```typescript
window.maestro.cueBackup = {
	create: () => Promise<CueBackupSummary>,
	list: () => Promise<CueBackupSummary[]>,
	inspect: (filePath) => Promise<CueBackupManifest>,
	readFile: (filePath, workspaceId, relativePath) => Promise<string | null>,
	readLive: (cwd, relativePath) => Promise<string | null>,
	restoreFile: (filePath, workspaceId, relativePath) => Promise<void>,
	restoreAll: (filePath) => Promise<CueBackupRestoreResult>,
	getDiffStatus: (filePath) => Promise<CueBackupDiffStatusMap>,
	delete: (filePath) => Promise<void>,
};
```

Every write path validates the backup zip lives inside `userData/cue-backups/` to prevent path traversal. See `src/main/cue/backup/cue-backup-manager.ts` for the implementation and `src/shared/cue-backup-types.ts` for the manifest/diff-status contracts.

## Parquet API

```typescript
window.maestro.parquet = {
	open(filePath, sshRemoteId?): Promise<ParquetFileInfo>;   // footer + schema only
	query(request: ParquetQueryRequest): Promise<ParquetQueryResult>;
	export(options): Promise<{ path; rows; truncated }>;      // CSV / JSON Lines
	close(handle): Promise<void>;
	onFetchProgress(cb): () => void;                          // SSH copy progress
};
```

**Parquet is the one previewable format that never crosses this bridge as content.** `fs:readFile` short-circuits a `.parquet` / `.parq` / `.pq` read to a marker string (`buildParquetPreviewMarker()` in `src/shared/parquet/preview.ts`), the main process keeps the file behind an open descriptor, and the renderer asks for the window of rows it is displaying. A Parquet file is routinely larger than RAM, so reading one into a string to "preview" it would defeat the format twice over.

Three contract details that bite callers:

- **`matchedRows` is a LOWER BOUND until `complete` is true.** A filtered scan stops as soon as it has filled the requested window. Render it as `1,204+`, and pass `countAll: true` to drive the scan toward the exact total.
- **`close` is not optional but is not load-bearing.** Idle handles are reaped, so a missed close leaks nothing permanent - it just holds a file descriptor until the reaper runs.
- **A filter that fails to parse matches ZERO rows**, and returns the problem in `filterError`. It does not fall back to "no filter": showing every row under a red error reads as filtering being broken.
- **`onFetchProgress` fires only for SSH-backed opens**, since a local file is opened in place with nothing to copy. It always ends with exactly one `done: true` event, including for an already-cached file, so a listener can unconditionally take its progress UI down on the terminal event. Events are sent to the requesting WebContents rather than broadcast, and carry `remotePath` so a listener can ignore another tab's copy.

Engine internals (pruning, projection, resumable scans) are documented in [REMAINING-SYSTEMS.md → Parquet Query Engine](docs/agent-guides/REMAINING-SYSTEMS.md).

## Power Management

- `power` - Sleep prevention: setEnabled, isEnabled, getStatus, addReason, removeReason, setKeepDisplayAwake

## Integrations

- `wakatime` - WakaTime CLI management: checkCli, validateApiKey

## Utilities

- `fonts` - Font detection
- `notification` - Desktop notifications, text-to-speech
- `devtools` - Developer tools: open, close, toggle
- `attachments` - Image attachment management
- `codexVisualization` - Codex `visualize` content references: load (builds and registers the isolated frame document; local agents only)
