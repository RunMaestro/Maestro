<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Cue Pipeline System

Guide for `src/main/cue/` - Maestro's event-driven automation engine.

> **Branch note:** Cue source lives on the `rc` branch (not yet merged to `main`). The compiled output exists at `dist/main/cue/`. This guide was significantly refactored on rc: trigger sources moved into `src/main/cue/triggers/`, config parsing/validation into `src/main/cue/config/`, and new service modules (completion, dispatch, query, recovery, session-runtime, session-registry, session-state) were extracted from the engine.

---

## Overview

Cue is an event-driven automation system that triggers AI agent prompts in response to events. It reads YAML configuration files (`maestro-cue.yaml` or `.maestro/cue.yaml`) from each agent's project root and manages the full lifecycle: detecting events, queuing executions, spawning agent processes, tracking completions, and propagating results through chains.

### Supported Trigger Types

| Event Type            | Description                                               | Source Module                                  |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `app.startup`         | Fires once per process lifecycle on Electron launch       | `cue-session-runtime-service` (runtime loop)   |
| `time.heartbeat`      | Periodic interval timer ("run every N minutes")           | `triggers/cue-heartbeat-trigger-source.ts`     |
| `time.scheduled`      | Cron-like triggers (specific times/days)                  | `triggers/cue-scheduled-trigger-source.ts`     |
| `file.changed`        | File system change via chokidar watcher                   | `triggers/cue-file-watcher-trigger-source.ts`  |
| `agent.completed`     | Fires when another agent finishes                         | `cue-engine` (reactive)                        |
| `github.pull_request` | New PRs detected via `gh` CLI polling                     | `triggers/cue-github-poller-trigger-source.ts` |
| `github.issue`        | New issues detected via `gh` CLI polling                  | `triggers/cue-github-poller-trigger-source.ts` |
| `task.pending`        | Unchecked markdown tasks (`- [ ]`) found in watched files | `triggers/cue-task-scanner-trigger-source.ts`  |

### Execution Patterns

- **Fan-out:** A single subscription fires its prompt against multiple target sessions in parallel.
- **Fan-in:** A subscription waits for multiple source sessions to complete before firing.
- **Chain propagation:** When an agent completes a Cue run, its completion event can trigger downstream subscriptions (with a depth guard of 10 to prevent infinite loops).
- **Two-phase runs:** A subscription can define an `output_prompt` that executes after the main prompt succeeds, using the main output as context.

---

## Module Reference

### cue-types.ts (~57 lines)

Thin re-export shim. Most type definitions have moved to `src/shared/cue/` (canonical). This file re-exports the shared types, defines `AgentCompletionData` (main-process only), provides the `createCueEvent()` factory, and exports `CUE_YAML_FILENAME` plus the deprecated `LEGACY_CUE_YAML_FILENAME` alias.

Canonical types now live in `src/shared/cue/contracts.ts` (re-exported via `src/shared/cue/index.ts`):

- `CueEventType` - Union of all 8 trigger types (including `app.startup`)
- `CueSubscription` - A trigger-prompt pairing with optional filter, fan-out, schedule, watch pattern, etc.
- `CueSettings` - Global config: `timeout_minutes` (default 30), `timeout_on_fail` ("break"/"continue"), `max_concurrent` (default 1), `queue_size` (default 10)
- `CueConfig` - Top-level parsed YAML: `{ subscriptions, settings }`
- `CueEvent` - An event instance with id, type, timestamp, triggerName, payload
- `CueRunResult` - Result of a completed/failed run (stdout, stderr, exitCode, durationMs, etc.)
- `CueSessionStatus` - Status summary per agent (subscription count, active runs, next trigger)
- `CueGraphSession` - Session + subscriptions for the pipeline graph visualization
- `DEFAULT_CUE_SETTINGS`, `CUE_EVENT_TYPES`, `CUE_GITHUB_STATES`, `CUE_SCHEDULE_DAYS`

### cue-engine.ts (~398 lines)

The central coordinator. Manages session lifecycle, wires up all event sources, and dispatches through the execution pipeline. On rc, much of the heavier logic has been extracted into dedicated service modules (`cue-completion-service.ts`, `cue-dispatch-service.ts`, `cue-query-service.ts`, `cue-recovery-service.ts`, `cue-session-runtime-service.ts`, `cue-session-registry.ts`, `cue-session-state.ts`).

**Class: `CueEngine`**

Constructor dependencies (`CueEngineDeps`):

- `getSessions()` - Returns all active sessions
- `onCueRun()` - Spawns a Cue execution
- `onStopCueRun()` - Stops a running execution
- `onLog()` - Logging callback
- `onPreventSleep()` / `onAllowSleep()` - Power management integration

Key public methods:

- `start(reason?)` / `stop()` - Enable/disable the engine; `reason` (`'system-boot'` vs `'user-toggle'`) gates whether `app.startup` fires
- `refreshSession(sessionId, projectRoot)` - Hot-reloads YAML via `sessionRuntimeService` (tears down old, re-initializes)
- `removeSession(sessionId)` - Delegates to `sessionRuntimeService` to tear down all subscriptions and clear queue
- `notifyAgentCompleted(sessionId, completionData?)` - Handles `agent.completed` triggers; routes to `completionService`
- `getStatus()` / `getActiveRuns()` / `getActivityLog()` / `getQueueStatus()` / `getSettings()` / `getGraphData()` - Read-only projections via `queryService`
- `stopRun(runId)` / `stopAll()` / `isEnabled()` / `clearQueue()` / `clearFanInState()` / `hasCompletionSubscribers()` - Run/state control
- `triggerSubscription(subscriptionName)` - Manual "Run Now" by subscription name

Note: per-session `initSession` and central `dispatchSubscription` are not exposed as public `CueEngine` methods — they live on `CueSessionRuntimeService` and `CueDispatchService` respectively, invoked internally by `start()` and by trigger-source callbacks.

Composed submodules (created in constructor):

- `CueRunManager` - Concurrency control and execution
- `CueFanInTracker` - Multi-source completion tracking
- `CueHeartbeat` - Sleep detection and heartbeat writing
- `CueActivityLog` - In-memory ring buffer of recent results

### cue-executor.ts (~520 lines)

Spawns background agent processes when triggers fire. Follows the same spawn pattern as Auto Run via `process:spawn`.

**Key functions:**

- `executeCuePrompt(config)` - Main execution function:
  1. Resolves prompt (file path or inline text)
  2. Populates template context with Cue event data (file paths, GitHub metadata, task lists, source output)
  3. Substitutes template variables
  4. Builds agent spawn args via `buildAgentArgs()` / `applyAgentConfigOverrides()`
  5. Applies SSH wrapping if configured (`wrapSpawnWithSsh()`)
  6. Spawns the process, captures stdout/stderr
  7. Enforces timeout with SIGTERM then SIGKILL escalation (5s delay)
  8. Returns `CueRunResult`
- `stopCueRun(runId)` - SIGTERM then SIGKILL after 5 seconds
- `getCueProcessList()` - Returns serializable process info for the Process Monitor
- `recordCueHistoryEntry()` - Creates a `HistoryEntry` with type `'CUE'`

Template variables populated for events:

- All events: `cue.eventType`, `cue.triggerName`, `cue.runId`, `cue.eventTimestamp`
- `file.changed`: `cue.filePath`, `cue.fileName`, `cue.fileDir`, `cue.fileExt`, `cue.fileChangeType`
- `agent.completed`: `cue.sourceSession`, `cue.sourceOutput`, `cue.sourceStatus`, `cue.sourceExitCode`
- `task.pending`: `cue.taskFile`, `cue.taskCount`, `cue.taskList`, `cue.taskContent`
- `github.*`: `cue.ghNumber`, `cue.ghTitle`, `cue.ghAuthor`, `cue.ghUrl`, `cue.ghBody`, `cue.ghLabels`, etc.

### cue-yaml-loader.ts (~119 lines)

Thin facade over `config/` modules. Provides `loadCueConfig()`, `resolveCueConfigPath()`, `watchCueYaml()`, `validateCueConfig()` - delegating to the repository/normalizer/validator split below. On rc the heavy logic was extracted to:

- `config/cue-config-repository.ts` - File discovery, YAML read/parse, watching
- `config/cue-config-normalizer.ts` - Prompt file resolution and shape normalization
- `config/cue-config-validator.ts` - Comprehensive validation (subscription name uniqueness, event-specific required fields, schedule format, glob patterns via picomatch, settings ranges)

### triggers/ (trigger source registry)

The `cue-subscription-setup.ts` module was deleted on rc. Each event source is now its own trigger source implementing a common interface in `triggers/cue-trigger-source.ts`:

| File                                  | Purpose                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `cue-trigger-source.ts`               | Common trigger source interface                                     |
| `cue-trigger-source-registry.ts`      | Registry and lookup of trigger sources                              |
| `cue-trigger-filter.ts`               | Shared filter-matching helpers                                      |
| `cue-heartbeat-trigger-source.ts`     | `time.heartbeat` interval timer                                     |
| `cue-scheduled-trigger-source.ts`     | `time.scheduled` cron-like firing                                   |
| `cue-schedule-utils.ts`               | Next-occurrence calculation (replaces `calculateNextScheduledTime`) |
| `cue-file-watcher-trigger-source.ts`  | `file.changed` chokidar wrapper                                     |
| `cue-github-poller-trigger-source.ts` | `github.pull_request` / `github.issue` poller                       |
| `cue-task-scanner-trigger-source.ts`  | `task.pending` markdown scanner                                     |

### cue-run-manager.ts (~452 lines)

Concurrency control, queue management, and run lifecycle.

**Factory: `createCueRunManager(deps)`**

Key behaviors:

- Enforces `max_concurrent` per session (default 1)
- Queues events when at capacity; drops oldest when queue is full
- Drains queue on slot availability; skips stale events (older than timeout)
- Supports two-phase runs (output_prompt after main task)
- Tracks `manuallyStoppedRuns` to avoid double-decrement of concurrency slots
- Integrates with power management (prevents sleep during active runs)
- Records events to SQLite via `cue-db`

### cue-fan-in-tracker.ts (~249 lines)

Multi-source completion tracking for `agent.completed` subscriptions with multiple `source_session` entries.

**Factory: `createCueFanInTracker(deps)`**

Key behaviors:

- Accumulates completions per subscription key (`ownerSessionId:subName`)
- Starts a timeout timer on first source completion
- On timeout: `timeout_on_fail: "continue"` fires with partial data, `"break"` drops silently
- Source output truncated to 5000 chars per source
- Propagates max `chainDepth` from all sources

### cue-file-watcher.ts

Wraps chokidar to watch glob patterns with per-file debouncing. (The trigger source adapter in `triggers/cue-file-watcher-trigger-source.ts` wires this into the engine.)

- Watches for `change`, `add`, `unlink` events
- Per-file debounce timers (configurable, default 5 seconds)
- Produces `CueEvent` with payload: `path`, `filename`, `directory`, `extension`, `changeType`

### cue-github-poller.ts (~313 lines)

Polls GitHub CLI for new PRs/issues, tracks "seen" state in SQLite.

Key design:

- Resolves `gh` CLI path via `resolveGhPath()` / `getExpandedEnv()` from shared utils
- Auto-detects repo via `gh repo view --json nameWithOwner` if not specified
- First poll seeds existing items as "seen" (no flood of events on first run)
- Supports `gh_state` filter: `"open"` (default), `"closed"`, `"merged"` (PRs only), `"all"`
- 30-day retention on seen records; prunes every 24 hours
- Has its own `execFileAsync` wrapper (local, not the shared utils version)

### cue-heartbeat.ts (~52 lines)

Heartbeat writer and sleep/wake detection.

- Writes timestamp to SQLite every 30 seconds
- On engine start, checks gap since last heartbeat; if > 2 minutes, triggers reconciler
- 7-day event prune age

### cue-reconciler.ts (~67 lines)

Catches up on missed `time.heartbeat` events after sleep/wake gaps.

- Calculates missed intervals per subscription during the sleep gap
- Fires exactly one catch-up event per subscription (with `reconciled: true` in payload)
- Does NOT reconcile file.changed or agent.completed events

### cue-task-scanner.ts (~189 lines)

Polls markdown files for unchecked tasks (`- [ ]`).

- Uses picomatch for glob pattern matching
- Recursive directory walk (skips `node_modules`, `.git`, `.next`)
- Tracks content hashes per file to only trigger on changes
- Seeds on first scan (no events for pre-existing tasks)
- Produces events with `taskCount`, `taskList`, `tasks`, `content` (truncated to 10K chars)

### cue-filter.ts (~123 lines)

Filter matching engine for event payload filtering.

Supports:

- Exact string/number/boolean match
- Negation (`!value`)
- Numeric comparison (`>`, `<`, `>=`, `<=`)
- Glob patterns (`*.ts` via picomatch)
- Dot-notation nested key access (`source.status`)
- All conditions are AND'd

### cue-activity-log.ts (~40 lines)

Simple in-memory ring buffer of completed run results (max 500). Used by the Cue Modal dashboard.

### Extracted services (rc)

The engine orchestration logic was split into focused services on rc:

| File                             | Responsibility                                                       |
| -------------------------------- | -------------------------------------------------------------------- |
| `cue-completion-service.ts`      | Handles `agent.completed` routing and fan-in dispatch                |
| `cue-dispatch-service.ts`        | Central subscription dispatch (fan-out expansion, run manager)       |
| `cue-query-service.ts`           | Status, active runs, graph-data queries                              |
| `cue-recovery-service.ts`        | Post-sleep reconciliation and orphan cleanup                         |
| `cue-session-registry.ts`        | Per-session subscription bookkeeping                                 |
| `cue-session-runtime-service.ts` | Session lifecycle, YAML hot-reload, teardown                         |
| `cue-session-state.ts`           | Immutable session state model                                        |
| `pipeline-layout-store.ts`       | Persistence for the visual pipeline editor layout (nodes + viewport) |

### cue-db.ts (~320 lines)

SQLite persistence using `better-sqlite3` with WAL mode.

**Tables:**

- `cue_events` - Event journal (id, type, trigger_name, session_id, subscription_name, status, created_at, completed_at, payload). Indexed on `created_at` and `session_id`.
- `cue_heartbeat` - Single-row table (id=1, last_seen) for sleep detection.
- `cue_github_seen` - Tracks seen GitHub items per subscription (subscription_id, item_key, seen_at). Indexed on `seen_at`.

---

## IPC Handlers

Registered in `src/main/ipc/handlers/cue.ts` via `registerCueHandlers()`.

| Channel                   | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `cue:getSettings`         | Get merged Cue settings                            |
| `cue:getStatus`           | Get status of all Cue-enabled sessions             |
| `cue:getActiveRuns`       | Get currently running executions                   |
| `cue:getActivityLog`      | Get recent completed/failed runs                   |
| `cue:enable`              | Start the engine                                   |
| `cue:disable`             | Stop the engine                                    |
| `cue:stopRun`             | Stop a specific running execution                  |
| `cue:stopAll`             | Stop all running executions                        |
| `cue:triggerSubscription` | Manual "Run Now" by name                           |
| `cue:getQueueStatus`      | Get queue depth per session                        |
| `cue:refreshSession`      | Re-read YAML for a session                         |
| `cue:removeSession`       | Remove a session from tracking                     |
| `cue:getGraphData`        | Get sessions+subscriptions for graph visualization |
| `cue:readYaml`            | Read raw YAML content                              |
| `cue:writeYaml`           | Write YAML + optional prompt files to `.maestro/`  |
| `cue:deleteYaml`          | Delete cue config file                             |
| `cue:validateYaml`        | Validate YAML as Cue config                        |
| `cue:savePipelineLayout`  | Save visual pipeline editor layout                 |
| `cue:loadPipelineLayout`  | Load saved pipeline layout                         |

---

## Renderer Components

### CueModal (`src/renderer/components/CueModal/`)

Dashboard modal for monitoring and controlling Cue.

| File                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `CueModal.tsx`          | Main modal shell with tabs                      |
| `SessionsTable.tsx`     | Table of Cue-enabled sessions with status       |
| `ActiveRunsList.tsx`    | Currently running executions with stop controls |
| `ActivityLog.tsx`       | History of completed/failed runs                |
| `ActivityLogDetail.tsx` | Detailed view of a single run result            |
| `StatusDot.tsx`         | Color-coded status indicator                    |
| `cueModalUtils.ts`      | Utility functions for the modal                 |

### CuePipelineEditor (`src/renderer/components/CuePipelineEditor/`)

Visual pipeline editor using React Flow for drag-and-drop pipeline construction.

| File / Directory          | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `CuePipelineEditor.tsx`   | Main editor component                            |
| `PipelineCanvas.tsx`      | React Flow canvas with nodes and edges           |
| `PipelineSelector.tsx`    | Dropdown for selecting/managing pipelines        |
| `PipelineToolbar.tsx`     | Toolbar with layout and zoom controls            |
| `PipelineContextMenu.tsx` | Right-click context menu                         |
| `cueEventConstants.ts`    | Event type metadata and icons                    |
| `pipelineColors.ts`       | Pipeline color palette                           |
| `drawers/`                | Trigger and agent drawer panels                  |
| `nodes/`                  | Custom React Flow node components                |
| `edges/`                  | Custom React Flow edge components                |
| `panels/`                 | Node and edge configuration panels               |
| `utils/`                  | Pipeline-to-YAML and YAML-to-pipeline conversion |

### CueYamlEditor (`src/renderer/components/CueYamlEditor/`)

YAML text editor with AI assistance for writing Cue configurations.

| File                      | Purpose                              |
| ------------------------- | ------------------------------------ |
| `CueYamlEditor.tsx`       | Main editor wrapper                  |
| `YamlTextEditor.tsx`      | Code editor with syntax highlighting |
| `CueAiChat.tsx`           | AI chat panel for config assistance  |
| `PatternPicker.tsx`       | Template pattern selection           |
| `PatternPreviewModal.tsx` | Preview a pattern before applying    |

### CueHelpModal.tsx

Standalone help modal with documentation about Cue.

---

## Shared Types

### `src/shared/cue-pipeline-types.ts`

Types for the visual pipeline editor (React Flow canvas):

- `CUE_COLOR` - Brand color: `#06b6d4` (cyan)
- `PIPELINE_COLORS` - 12 distinct colors for pipeline differentiation
- `EdgeMode` - `"pass"` / `"debate"` / `"autorun"`
- `CuePipeline` - Named pipeline with nodes, edges, and color
- `PipelineLayoutState` - Saved node positions and viewport

### `src/shared/maestro-paths.ts`

Path constants:

- `CUE_CONFIG_PATH` = `".maestro/cue.yaml"`
- `CUE_PROMPTS_DIR` = `".maestro/prompts"`
- `LEGACY_CUE_CONFIG_PATH` = `"maestro-cue.yaml"` (via `LEGACY_CUE_YAML_FILENAME`)

---

## System Integration Points

1. **Process Manager** - Cue executor spawns processes following the same pattern as `process:spawn` IPC handler
2. **Power Manager** - Prevents system sleep during scheduled subscriptions and active runs
3. **SSH Remote** - Full SSH wrapping support via `wrapSpawnWithSsh()`
4. **Template Variables** - Uses shared `substituteTemplateVariables()` from `src/shared/templateVariables.ts`
5. **Agent System** - Uses `getAgentDefinition()`, `getAgentCapabilities()`, `buildAgentArgs()`, `applyAgentConfigOverrides()`
6. **History** - Records history entries with type `'CUE'` and Cue-specific metadata
7. **Output Parsers** - Uses per-agent output parsers to extract clean text from JSON/NDJSON stdout
8. **CLI Detection** - Uses `resolveGhPath()` and `getExpandedEnv()` from shared utils for GitHub polling
9. **Stats DB** - Follows the same `better-sqlite3` + WAL pattern as `stats-db.ts`

---

## Configuration Format

Example `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: lint-on-save
    event: file.changed
    watch: 'src/**/*.ts'
    prompt: 'Run lint on {{cue.filePath}} and fix any issues'

  - name: morning-standup
    event: time.scheduled
    schedule_times: ['09:00']
    schedule_days: [mon, tue, wed, thu, fri]
    prompt_file: .maestro/prompts/standup.md

  - name: review-new-prs
    event: github.pull_request
    repo: owner/repo
    poll_minutes: 5
    gh_state: open
    prompt: 'Review PR #{{cue.ghNumber}}: {{cue.ghTitle}}'

  - name: aggregate-results
    event: agent.completed
    source_session: [agent-1, agent-2, agent-3]
    fan_out: [summary-agent]
    prompt: 'Summarize: {{cue.sourceOutput}}'
    filter:
      status: completed

settings:
  timeout_minutes: 30
  timeout_on_fail: continue
  max_concurrent: 2
  queue_size: 10
```
