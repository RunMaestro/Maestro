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
- `CueSettings` - Global config: `timeout_minutes` (default 30), `timeout_on_fail` ("break"/"continue"), `max_concurrent` (default 1), `queue_size` (default 512, max 10000)
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

Note: per-session `initSession` and central `dispatchSubscription` are not exposed as public `CueEngine` methods - they live on `CueSessionRuntimeService` and `CueDispatchService` respectively, invoked internally by `start()` and by trigger-source callbacks.

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
- **Re-trigger on activity** (`retrigger_on_comments: true`): re-fires when an item's `updatedAt` advances past the stored revision. Default off - when on, fetches comments-since-last-fire via `gh pr|issue view --json comments` and attaches them to the event payload as `new_comments` (surfaced as `{{CUE_NEW_COMMENTS}}` template var). Capped per-item by `max_notifications` (default 10, `0` = unlimited). Counter tracks re-fires only - initial discovery is always allowed regardless of cap. Once the cap is hit, the poller stops emitting events but freezes `last_revision` so raising the cap later resumes from the right point rather than replaying stale activity.

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
| `PipelineListTab.tsx`   | Pipeline List tab - prose + health, read-only   |
| `StatusDot.tsx`         | Color-coded status indicator                    |
| `cueModalUtils.ts`      | Utility functions for the modal                 |

**Tabs.** `CueModalTab` in `CueModalHeader.tsx` is the tab union, and it must stay
in sync with `CUE_MODAL_TABS` in `src/shared/uiSurfaces.ts` - that registry is what
`maestro-cli open cue --tab <id>` validates against, and `CueModalHeader.test.tsx`
asserts the two render in the same order. Note the id/label mismatch on the graph
tab: its id is `pipeline` while its label is "Pipeline Graph". The id predates the
rename and is deliberately frozen, because saved deep links, the YAML editor's nav
button, and `useModalHandlers`' first-run routing all address it by id.

**Pipeline Graph vs Pipeline List.** Two tabs over the same data, not two modes of
one tab. The graph (`CuePipelineEditor`) owns editing and is the only place a
pipeline can be changed. The list (`PipelineListTab`) is read-only and answers the
questions a canvas is bad at: what does each pipeline do, and is it working? It
renders `dashboardPipelines` (the same disk-loaded pipelines the Dashboard uses),
so it needs no editor state and no save path.

**The prompt renders on the STEP, never the trigger.** A trigger's outgoing edge
and its target's incoming edge are the same edge, so rendering `prompts` in both
columns prints every prompt twice; a fan-out trigger also has one prompt per
target rather than one of its own. `CuePipelineTriggerSummary.prompts` still
exists for callers describing a trigger on its own - just do not put it in the
trigger column. Same reason the search haystack indexes step prompts only.

**Row-level "Run now" is gated on a SINGLE trigger subscription.** With several
triggers the button is ambiguous (each trigger is its own subscription with its
own prompt) and destructive - the real 39-trigger "Pedsidian" pipeline would
dispatch 39 agent runs on one click. Multi-trigger pipelines expose a per-trigger
Run inside the expanded detail instead. Do not "simplify" this back to a
fire-them-all button.

**Renaming a pipeline** goes through `src/main/cue/cue-pipeline-rename.ts`, NOT
the editor's save path - the list has no editor state to save. A pipeline is not
an object on disk, it is the set of subscriptions sharing a `pipeline_name`, so
the rename rewrites that field on every member in every root the pipeline spans.
Three invariants:

- **Subscription names are never rewritten.** They are stable identities: the
  layout store keys trigger positions by them and `source_sub` points at them.
  So `Old-chain-2` survives a rename to `New`, and that is correct - membership
  is decided by `pipeline_name`, not by the name suffix.
- **The handler enumerates roots itself** from `engine.getStatus()`. A caller
  passing "the root of the agent I clicked" would silently rename half of a
  cross-agent pipeline.
- **A layout failure is a warning, not a failure.** The YAML write has already
  landed by then; reporting the whole rename as failed would send the user
  looking for a change that is already on disk. The layout re-key exists because
  the visual id is `pipeline-${name}`, so a rename orphans the old entry.

Note that health history legitimately reads as empty right after a rename: runs
recorded the name they ran under, and `derivePipelineHealth` matches on it.

**Escape during a rename is a LAYER, not a keydown handler.** `PipelineListTab`
registers `MODAL_PRIORITIES.CUE_PIPELINE_RENAME` (462, above `CUE_MODAL`) while
`renamingId !== null`. The layer stack listens on `window` at CAPTURE, so an
`onKeyDown` on the rename input can never see Escape - it would close the whole
Cue modal instead of cancelling the rename. Same mechanism and same reason as
`CUE_SCHEDULED_TASK_FILTER`. Register it with `focusTrap: 'none'`,
`blocksLowerLayers: false`, `capturesFocus: false`: it is an inline field, not
an overlay, and it must not dim the modal or trap focus.

**Remembered tab.** `lastOpenCueTab` is module-level state in `CueModal.tsx`,
resolved in the `useState` lazy initializer (a restore effect double-fires under
StrictMode and clobbers the saved value). Same shape as `lastOpenSettingsTab` in
`Settings/SettingsModal.tsx`. An explicit `initialTab` from modal data always
wins. Tests must call `__resetLastOpenCueTabForTests()` in `beforeEach`, or the
remembered tab leaks between cases.

### CuePipelineEditor (`src/renderer/components/CuePipelineEditor/`)

Visual pipeline editor using React Flow for drag-and-drop pipeline construction.

| File / Directory              | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `CuePipelineEditor.tsx`       | Main editor component                            |
| `PipelineCanvas.tsx`          | React Flow canvas with nodes and edges           |
| `PipelineSelector.tsx`        | Dropdown for selecting/managing pipelines        |
| `PipelineToolbar.tsx`         | Toolbar with layout and zoom controls            |
| `PipelineContextMenu.tsx`     | Right-click context menu                         |
| `cueEventConstants.ts`        | Event type metadata and icons                    |
| `pipelineColors.ts`           | Pipeline color palette                           |
| `drawers/`                    | Trigger and agent drawer panels                  |
| `nodes/`                      | Custom React Flow node components                |
| `edges/`                      | Custom React Flow edge components                |
| `panels/`                     | Node and edge configuration panels               |
| `utils/`                      | Pipeline-to-YAML and YAML-to-pipeline conversion |
| `utils/pipelineMembership.ts` | Which pipelines belong to a given agent          |

#### Layout buttons (Tidy and Arrange)

Two top-right canvas buttons (in `PipelineCanvas.tsx`, props `onTidy` / `onArrange`) drive `handleArrange(mode)` in `CuePipelineEditor.tsx`, where `mode` is `'tidy' | 'untangle'`. Both branch on the active view:

- **Single pipeline, Tidy** - `arrangePipelineNodes` (in `utils/pipelineAutoArrange.ts`) splits the pipeline into weakly-connected components (edges treated as undirected) and lays each one out as its own horizontal band: nodes left-to-right by flow depth (rank = longest path from a root within that component), stacked within each column. Bands are stacked top-to-bottom in current reading order, so independent trigger-to-agent chains keep their own rows instead of being merged into shared columns. Order within a column follows current vertical position, so the existing arrangement is aligned, not reshuffled; crossing edges are left intact. Truly disconnected nodes (no edges) are packed into a grid band beneath the chains.
- **Single pipeline, Arrange** - `untanglePipelineNodes` uses the same per-component banding and flow-depth columns but reorders nodes within each column to minimize edge crossings (Sugiyama ordering: barycenter sweeps + adjacent-swap transpose refinement, keeping the best of several passes). It is seeded by current vertical order, so it untangles rather than scrambles.
- **All Pipelines view** - `arrangePipelineGroups` packs the per-pipeline group cards into a balanced grid via `viewOffset`, leaving node positions untouched. No edges cross between cards, so the Tidy button is hidden here and both modes route through this path.

Pressing either opens a `ConfirmModal` (`arrangeConfirmMode` drives its title/label/copy), then `handleArrange` mutates canonical state (flips dirty, undoable via Discard), persists, and re-fits the view. The layout helpers are pure and unit-tested in `pipelineAutoArrange.test.ts`; the crossing-minimizer is verified with a true segment-intersection count, independent of the layout's internal ordering.

#### Agent scope in the All Pipelines view (`CueGraphTarget` / `CueGraphScope`)

"View in Graph" in the Sessions table hands the editor a `CueGraphTarget`:
`{ id, nonce, scope? }`. The nonce is what lets a repeat click on the same row
re-trigger navigation. `id` selects a single pipeline; when it is `null` and
`scope` is set, the All Pipelines view is narrowed to that agent's pipelines.

Membership is resolved by `pipelinesForSession()` (see
`utils/pipelineMembership.ts`), never by pipeline color - several pipelines can
share a color, and a command-only pipeline has no agent node to match at all.
One owned pipeline selects it outright; several apply a scope; none falls
through to the unfiltered view.

Three invariants the implementation depends on:

- **The scope filters the CANVAS only.** `visiblePipelines` is what feeds
  `convertToReactFlowNodes`/`Edges`, the node count, and the viewport hook;
  `pipelineState.pipelines` stays canonical. Every mutation is already blocked
  in the All Pipelines view, so a scoped canvas cannot write a partial layout
  back to disk.
- **The viewport hook must see the same set the canvas draws.** It stacks
  pipelines vertically and fits the result, so passing it the unfiltered list
  fits the view around the empty bands of the pipelines it filtered out. That is
  why `usePipelineViewport` takes `scopeKey` and re-fits on it: scoping in or
  out swaps the visible set without changing the selection, which its
  selection-change re-fit alone would miss.
- **A scope that resolves to nothing falls back to the unfiltered view**, not an
  empty canvas - pipelines can be renamed or deleted between the click and the
  render. Any manual selection clears the scope: the user navigated elsewhere.

#### Visual node identity round-trip (`target_node_key` / `fan_out_node_keys`)

Every agent and command node dropped onto the canvas gets a stable
`nodeKey` UUID (generated in `usePipelineCanvasCallbacks.ts`). On save,
`pipelineToYaml.ts` writes that key as `target_node_key` (single-target
subs) or `fan_out_node_keys[i]` (fan-out positions) on the owning
subscription. On load, `yamlToPipeline.ts`'s `getOrCreateAgentNode` and
`createCommandNode` resolve these keys via a per-pipeline `nodeKeyToNode`
map: matching keys collapse to one shared visual node (explicit
fan-in), distinct keys produce distinct visual nodes - even when both
target the same `agent_id`. Subs with no key fall back to the legacy
dedup-by-sessionName path (preserves load behavior for hand-written or
pre-fix YAML). The main-process normalizer
(`cue-config-normalizer.ts:normalizeSubscription`) must passthrough both
fields - it allowlists every persisted field, and the renderer
silently re-merges visual nodes if either field gets dropped there.
The engine itself ignores these fields entirely.

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

### `src/shared/cue-pipeline-summary.ts`

Pure prose + health derivation over a `CuePipeline`. No React, no IPC, so the
renderer, a future CLI listing, and tests all describe a pipeline identically.

- `getTriggerConfigSummary(data)` - short config line for a trigger (`every 15min`,
  `09:00, 17:00`). Used by BOTH the graph's trigger nodes and the list, which is
  why it lives here rather than in `CuePipelineEditor/utils/pipelineGraph.ts`.
- `summarizeCommandNode(data)` - the `$ cmd` / `cli send → target` line.
- `describePipeline(pipeline)` - triggers, steps in execution order, and the
  strings the list renders. Step order comes from a BFS over the edges, NOT array
  position: hand-authored YAML can list the last agent first. It returns BOTH
  `flow` (the full `a → b → c` chain) and `headline` (what the collapsed row
  shows). Render `headline`, never `flow`: a pipeline with >1 trigger or >4 steps
  is usually N independent chains grouped under one name, so arrow-chaining their
  node names describes a sequence that does not exist - and a 39-node line buries
  every other row. `flow` stays exported for the search haystack.
- Every trigger and step carries a `CueNodePrompts` (`prompts`, `count`,
  `preview`). Resolution order matters: a step reads its INCOMING edges first and
  only falls back to `AgentNodeData.inputPrompt` when none carried one. That
  mirrors the loader, which deliberately CLEARS `inputPrompt` on trigger→agent
  edges (mirroring the two caused stale saves) and reserves it for chain agents.
  `preview` is whitespace-collapsed but NOT length-capped - the list clips it with
  CSS so it fits the real column width; a character cap would waste space on a
  wide window and still overflow on a narrow one.
- `derivePipelineHealth(pipeline, ctx)` - the health badge. Precedence is
  `running > invalid > disabled > failing > healthy > idle`. Feed it `configErrors`
  from `validatePipelines` (prefix-stripped via `stripPipelinePrefix`) and the
  `disabled` flag from the subscriptions' on-disk `enabled` fields; it matches runs
  to the pipeline itself via `pipelineName` with a `-chain-N` / `-fanin` fallback.
  The `idle` label is "No recent runs", never "never run" - the activity log is a
  bounded window and a stronger claim would be false.

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
