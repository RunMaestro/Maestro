# CLAUDE-CUE.md

Architectural reference for **Maestro Cue** — the event-driven automation engine in `src/main/cue/`. For module-level reference (every file's purpose, IPC channels, renderer components, YAML examples), see [docs/agent-guides/CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md). For per-event template variables and YAML schema in user-facing docs, see [src/prompts/\_maestro-cue.md](src/prompts/_maestro-cue.md). This doc is the **why** and the **gotchas** — read it before changing anything in `src/main/cue/`.

## 30-second mental model

Each agent has a project root. Cue looks for `.maestro/cue.yaml` (preferred) or `maestro-cue.yaml` (legacy) under that root and parses it into a list of **subscriptions**. A subscription is a `(event_type, filter, prompt, agent)` tuple — "when X happens, run Y on agent Z." Trigger sources (file watcher, GitHub poller, scheduled clock, heartbeat, task scanner) detect matching events and call the dispatch service, which spawns a background agent process via the same path Auto Run uses. Completions are recorded to SQLite and can chain into other subscriptions (`agent.completed` event). Fan-out runs the same prompt across multiple agents in parallel; fan-in waits for several upstream agents to finish before firing one downstream. Everything is gated by per-session concurrency (`max_concurrent`, default 1) and a persisted queue that survives crashes.

## Architecture

```
                       ┌─────────────────────────────────────────────────┐
  YAML config  ───►    │ CueSessionRuntimeService                        │
  (.maestro/cue.yaml)  │  • initSession / refreshSession / removeSession │
                       │  • ancestor cue.yaml fallback                   │
                       │  • ownership conflict resolution                │
                       │  • registers trigger sources per subscription   │
                       └────────────┬────────────────────────────────────┘
                                    │
                       ┌────────────┴───────────────────────────────┐
   triggers/*  ───►    │ Trigger sources                            │
                       │  file.changed, github.*, time.*,           │
                       │  task.pending, app.startup, agent.completed│
                       └────────────┬───────────────────────────────┘
                                    │  CueEvent (filtered via cue-filter.ts)
                                    ▼
                       ┌─────────────────────────────────┐
                       │ CueDispatchService              │
                       │  fan-out expansion              │  CueCompletionService
                       │  prompt selection (overrides)   │  ◄─── agent.completed
                       └────────────┬────────────────────┘       (chain depth ≤ 10)
                                    │                                    ▲
                                    ▼                                    │
                       ┌─────────────────────────────────┐                │
                       │ CueRunManager                   │   CueFanInTracker
                       │  max_concurrent gate            │   (multi-source merge)
                       │  in-memory + persisted queue    │
                       │  staleness drop, drain, retry   │
                       └────────────┬────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
       cue-executor          cue-shell-executor    cue-cli-executor
       (action: prompt)      (action: command,     (action: command,
                              command.mode: shell)  command.mode: cli)
                                    │
                                    ▼  CueRunResult → recordCueHistoryEntry
                       ┌─────────────────────────────────┐
                       │ cue_events / cue_event_queue    │  cue-db.ts (better-sqlite3, WAL)
                       │ cue_heartbeat / cue_github_seen │
                       └─────────────────────────────────┘
```

## End-to-end dispatch flow

A `github.pull_request` event for a chained subscription, traced from trigger to history row:

1. **Trigger fires.** `cue-github-poller.ts:73` records new items in `cue_github_seen` and emits a `CueEvent` via the trigger source adapter (`triggers/cue-github-poller-trigger-source.ts:45`).
2. **Filter check.** `passesFilter(subscription, event)` runs the subscription's `filter` block against `event.payload` (`cue-filter.ts:41`). All conditions AND'd.
3. **Dispatch.** `CueDispatchService.dispatchSubscription` (`cue-dispatch-service.ts:42`) decides single vs fan-out. Fan-out resolves each `fan_out` target through `fan_out_ids[i]` (preferred, stable across rename) or by name match (legacy). For each target it builds a `fanOutEvent` carrying `payload.fanOutSource` + `payload.fanOutIndex` and calls `executeRun(...)`.
4. **Run manager intercepts.** `CueRunManager.execute` (`cue-run-manager.ts:559`) consults `max_concurrent`. If a slot is open, it calls `doExecuteCueRun` immediately (`cue-run-manager.ts:243`). Otherwise it pushes a `QueuedEvent` into the in-memory queue AND persists it to `cue_event_queue` via `safePersistQueuedEvent` (`cue-run-manager.ts:622-655`).
5. **Spawn.** `executeCuePrompt` (`cue-executor.ts:116`) builds template context (`buildCueTemplateContext`), substitutes variables, builds spawn args (`cue-spawn-builder.ts:58`), wraps with SSH if `sshRemoteConfig.enabled`, then launches via `cue-process-lifecycle.ts:runProcess`. **`forceBatchMode: true`** is set so the agent never falls into TUI mode without a stdin (`cue-spawn-builder.ts`).
6. **Output capture.** Stdout is parsed by the per-agent output parser (`getOutputParser`) — Claude Code → result-event extraction from stream-json, others → raw stdout. Truncation cap is 5000 chars for chain-source output (`SOURCE_OUTPUT_MAX_CHARS`).
7. **Result + history.** `executeCuePrompt` returns a `CueRunResult` with `pipelineName: subscription.pipeline_name` populated. `recordCueHistoryEntry` (`cue-executor.ts:253`) builds a `HistoryEntry` whose `summary` is rendered by `buildCueRunSummary` (`src/shared/cue/cue-summary.ts`).
8. **Chain propagation.** When the agent process exits, the run manager calls `onRunCompleted` which flips through to `notifyAgentCompleted` (`cue-completion-service.ts:122`). Each enabled `agent.completed` subscription whose `source_session` includes the completing agent fires — single-source via `dispatchService`, multi-source via `CueFanInTracker.handleCompletion`. Chain depth is incremented and **aborted at 10** (`MAX_CHAIN_DEPTH`, `cue-engine.ts:63`).

## Engine lifecycle (`CueEngine`, `cue-engine.ts:397`)

`start(reason)` runs in this order — order matters:

1. `recoveryService.init()` — opens the SQLite DB, prunes events older than 7 days (`EVENT_PRUNE_AGE_MS`, `cue-recovery-service.ts:24`). Returns early if init fails.
2. Set `enabled = true`, reset metrics so uptime reflects this start.
3. Emit `engineStarted` log payload — renderer uses this to clear stale UI.
4. For each session, `sessionRuntimeService.initSession(session, { reason })`. **`app.startup` subscriptions only fire when `reason === 'system-boot'`** (Electron launch, not user toggle).
5. `queuePersistence.restoreAll()` — re-execute every persisted-queue entry through `runManager.execute`, **preserving its original `queuedAt`** so the staleness check measures real wait time, not restart time. Restored entries do NOT carry `pipelineName` (no schema column); summaries fall back to `-chain-N` stripping.
6. `recoveryService.detectSleepAndReconcile()` — see [Sleep/wake](#sleepwake-reconciliation).
7. `heartbeat.start()` — 30s interval writes `cue_heartbeat.last_seen` (`HEARTBEAT_INTERVAL_MS`, `cue-heartbeat.ts:14`).

`stop()` reverses everything: clears heartbeat timer, tears down trigger sources, stops active runs, but **does not clear the persisted queue** — it survives across stops so the next `start()` can replay.

## Session lifecycle and ownership

`initSession` (`cue-session-runtime-service.ts:107-200`) is the choke point:

- **YAML discovery.** Calls `loadCueConfigDetailed(projectRoot)`. If the local file is empty AND `no_ancestor_fallback !== true`, walks up parent directories looking for the first non-empty `cue.yaml` and adopts it (with a `[CUE] using ancestor config from` log).
- **Ownership.** When two sessions resolve to the same effective `cue.yaml` (shared `projectRoot`), `computeOwnershipWarning` (`cue-session-state.ts`) tags the non-owner. Subscriptions without an explicit `agent_id` are **suppressed** for the non-owner — both at trigger-source registration AND in `notifyAgentCompleted` (`cue-completion-service.ts:110, 143`). Without this gate, the same chain would dispatch twice. Tie-breaker is configurable via `settings.owner_agent_id` (UUID or display name) — falls back to first-by-session-list when unset.
- **Ancestor pipelines.** Even when the local file has its own subs, ancestor subs whose `agent_id` targets THIS session are merged in (`cue-session-runtime-service.ts:217`). This is how a top-level repo cue.yaml can drive subprojects.
- **Teardown.** `removeSession` stops trigger sources and unregisters from the registry. Queued events are kept unless `clearQueue(sessionId)` is called explicitly. `refreshSession` is teardown + re-init (used on YAML save and on agent rename).

## Subscription model

Subscriptions live in `CueSubscription` (`src/shared/cue/contracts.ts`). Required: `name` (unique per file), `event`. Common optional: `agent_id`, `prompt`/`prompt_file`, `filter`, `enabled`, `source_session`, `source_sub`, `fan_out`/`fan_out_ids`/`fan_out_prompts`, `output_prompt`, `pipeline_name`, `pipeline_color`, `target_node_key`/`fan_out_node_keys`, `interval_minutes`, `schedule_times`/`schedule_days`, `watch`, `repo`/`gh_state`/`poll_minutes`, `action` (`prompt`|`command`), `command` (`{ mode: 'shell'|'cli', ... }`), `include_output_from`, `forward_output_from`.

Two facts that aren't obvious:

- **`prompt_file` is resolved at config load time, not run time.** `materializeCueConfig` reads the file and replaces it with inline `prompt`. A missing `prompt_file` is a **warning, not an error** — the subscription is kept with `prompt = ''` and fails loudly only when it tries to run (`cue-executor.ts` ⇒ `failedResult('...has no prompt content')`). This is the most common "my sub silently doesn't work" cause.
- **`pipeline_name` and visual node keys (`target_node_key`, `fan_out_node_keys`) are renderer concerns** that the engine ignores — but the normalizer must allowlist them or the editor's visual round-trip breaks (multiple separate canvas nodes silently collapse into one). See `cue-config-normalizer.ts:normalizeSubscription`.

## Concurrency, queue, and persistence

`CueRunManager` (`cue-run-manager.ts`) owns these rules:

- **`max_concurrent` per session** (default 1). Tracked in `activeRunCount: Map<sessionId, number>`. Decremented in a `finally` block in `doExecuteCueRun` so a thrown exception still releases the slot.
- **`queue_size` enforces a bounded buffer.** When full, the oldest entry is dropped, and `onQueueOverflow` fires so the renderer can surface a toast. `queue_size <= 0` means "no buffering at all" — incoming events are dropped immediately.
- **Staleness.** On drain, an entry older than `timeout_minutes * 60_000` is dropped and recorded in `cue_events` with `status: 'timeout'` and `payload.droppedFromQueue: true` (so the activity log explains _why_ a queued run never fired). Same check runs at `restoreAll()` time before re-enqueueing.
- **Two-phase output_prompt runs.** When `output_prompt` is set, after the main run succeeds the manager kicks off a second spawn whose subscriptionName is `${subscriptionName}:output` — **load-bearing** for activity-log rendering and stop-run targeting (`cue-run-manager.ts:381, 401`). If you need to filter chains by sub name elsewhere, normalize the `:output` suffix.
- **Manual stop bookkeeping.** `manuallyStoppedRuns` set guards against double-decrementing the concurrency slot when a stop races with natural completion.
- **Queue persistence is fail-open.** Every `persist`/`remove` uses safe-wrapper variants; a DB failure degrades to "live only" rather than breaking the live queue. The `persistId` field on `QueuedEvent` is the DB row id.

`pipelineName` flows alongside the queue in memory but is **not persisted** (no schema column). Restored runs degrade to legacy `-chain-N` stripping in summaries — acceptable since the user-facing label is recoverable from the subscription's current YAML, just not from the queue row.

## Chain propagation and fan-in

When an agent process exits, `notifyAgentCompleted(sessionId, completionData)` is called (`cue-completion-service.ts:122`):

1. **Depth guard.** `chainDepth >= MAX_CHAIN_DEPTH (10)` aborts with an error log. Bumping this limit is dangerous — fan-out × chain depth grows multiplicatively.
2. **Per-config scan.** For each session's config, every `agent.completed` subscription is checked:
   - `agent_id` mismatch → skip.
   - Ownership conflict + no explicit `agent_id` → skip (matches trigger-source gate).
   - `source_session` (string or array) is matched against the completing session's id OR display name.
   - **`source_sub` narrows further**: when set, the upstream sub's `triggeredBy` must be in the allowed list. This is the self-loop / cross-fire guard for shared-session fan-out chains (`cue-completion-service.ts:70-92`). An undefined `triggeredBy` is rejected when `source_sub` is set — non-Cue completions (user typing, exit-listener) cannot accidentally re-fire chain steps.
3. **Single source** → `dispatchService` directly. **Multi-source** → `fanInTracker.handleCompletion`.

`CueFanInTracker` (`cue-fan-in-tracker.ts`) keeps a `Map<key, Map<sourceId, FanInSourceCompletion>>` keyed by `${ownerSessionId}:${subscriptionName}`. **Subscription names containing `:` will mis-key health lookups** (`cue-engine.ts:583` splits on first `:`) — validation should reject them; for now, just don't.

Timeout behavior is governed by the per-config `timeout_on_fail` setting:

- **`break`** — drop the fan-in silently when not all sources have arrived in time (no chain step fires).
- **`continue`** — fire the chain step with whichever sources DID arrive. Output is filtered through `buildFilteredOutputs` and merged via `mergeUpstreamForwarded`. Per-source caps at `SOURCE_OUTPUT_MAX_CHARS` (5000).

The `FanInHealthEntry` projection (`cue-fan-in-tracker.ts:46`) lets the dashboard surface stalls before they actually time out (>50% of timeout elapsed).

## Sleep/wake reconciliation

System sleep / app suspension can leave the engine paused mid-day. Handled in three layers:

- **`cue-heartbeat.ts:79`** — writes `cue_heartbeat.last_seen` every 30s. Three consecutive failures emit `'heartbeatFailure'` for metrics; SQLite-busy errors below threshold are suppressed.
- **`cue-recovery-service.ts:detectSleepAndReconcile`** — at engine start, computes `Date.now() - last_seen`. If gap > `SLEEP_THRESHOLD_MS` (120s), calls `reconcileMissedTimeEvents`.
- **`cue-reconciler.ts:34`** — for each enabled `time.heartbeat` subscription with `interval_minutes`, fires **one** catch-up event with `{ reconciled: true, missedCount, sleepDurationMs }` in payload. **Only `time.heartbeat` is reconciled** — file changes during sleep are lost (the watcher re-init catches new state naturally), and `agent.completed` is durable through fan-in state.

## Trigger source contract

Every source implements the interface in `triggers/cue-trigger-source.ts`. They share a registry (`cue-trigger-source-registry.ts`) and a filter helper (`cue-trigger-filter.ts`). Quick reference:

| Event                 | Source file                            | Cadence             | First-run seeds?       | Reconciled on wake?    |
| --------------------- | -------------------------------------- | ------------------- | ---------------------- | ---------------------- |
| `app.startup`         | (runtime service, not a source)        | once per boot       | n/a                    | no                     |
| `time.heartbeat`      | `cue-heartbeat-trigger-source.ts`      | `interval_minutes`  | n/a                    | **yes** (one catch-up) |
| `time.scheduled`      | `cue-scheduled-trigger-source.ts`      | wall-clock          | n/a                    | no                     |
| `file.changed`        | `cue-file-watcher-trigger-source.ts`   | chokidar + debounce | no                     | no                     |
| `agent.completed`     | `cue-completion-service.ts` (reactive) | on completion       | n/a                    | n/a                    |
| `github.pull_request` | `cue-github-poller-trigger-source.ts`  | `poll_minutes`      | **yes**                | no                     |
| `github.issue`        | same                                   | same                | **yes**                | no                     |
| `task.pending`        | `cue-task-scanner-trigger-source.ts`   | 1m default          | **yes** (content hash) | no                     |

"Seeds on first run" means the source records existing items as already-seen on its first poll so users don't get a flood when adding a new subscription.

## Filter operators (`cue-filter.ts`)

All conditions AND'd. Field names support **dot-notation** (`source.status`). Each value can be:

| Form       | Example           | Behavior                                    |
| ---------- | ----------------- | ------------------------------------------- |
| Literal    | `"completed"`     | Exact match (string equality after coerce). |
| Negation   | `"!failed"`       | Field must NOT equal value.                 |
| Comparison | `">=5"`, `"<100"` | Numeric. Rejects null/NaN/non-finite.       |
| Glob       | `"*.ts"`          | picomatch pattern match.                    |
| Boolean    | `true`/`false`    | Direct boolean equality.                    |

Filters apply per trigger before emit — a filtered-out event is invisible to the rest of the system (no log, no DB row).

## Persistence (`cue-db.ts`)

Single SQLite database, WAL mode. Tables:

| Table             | Purpose                                              | Notes                                                           |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `cue_events`      | Run journal (running / completed / failed / timeout) | 7-day retention. Indexed on `created_at`, `session_id`.         |
| `cue_event_queue` | Phase 12A persisted queue                            | Indexed on `session_id`, `queued_at`. Replayed at engine start. |
| `cue_heartbeat`   | Single-row `(id=1, last_seen)`                       | Drives sleep detection.                                         |
| `cue_github_seen` | Per-subscription seen-item dedupe                    | 30-day retention; pruned every 24h.                             |

`cue_event_queue` does NOT carry `pipelineName` — restored runs degrade to legacy labels.

## Process spawning

- **`cue-spawn-builder.ts`** builds the spawn spec: applies agent capabilities (`buildAgentArgs`), agent-config overrides (`applyAgentConfigOverrides`), forces batch mode, threads `customEnvVars` and `customArgs`. SSH wrapping happens here via `wrapSpawnWithSsh`.
- **`cue-process-lifecycle.ts`** owns the actual `spawn()` with `stdio: ['ignore', 'pipe', 'pipe']`, output capture, and shutdown. **SIGTERM → 5s grace → SIGKILL** (`SIGKILL_DELAY_MS`, both `cue-process-lifecycle.ts:20` and `cue-shell-executor.ts:22` and `cue-cli-executor.ts:95` — keep these in sync if you change the constant).
- **`cue-env-sanitizer.ts`** drops env vars whose name doesn't match `[a-zA-Z_][a-zA-Z0-9_]*` OR whose uppercase form is in a blocklist (`PATH, HOME, USER, SHELL, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, NODE_OPTIONS`). Case-insensitive — Windows `Path` is the same as `PATH`.
- **`cue-output-filter.ts`** truncates per-source chain output to `SOURCE_OUTPUT_MAX_CHARS` (5000) and applies the optional `include_output_from` / `forward_output_from` filters before injecting into downstream prompts.
- **Shell executor** uses local `bash -c <cmd>` (or remote-shell wrapping under SSH); CLI executor invokes `maestro-cli send` with a 5000ms timeout cap.

## Top gotchas (read before editing)

1. **Ownership tie-breaking is silent.** When two agents share a `projectRoot`, the second-registered one's unowned subs vanish from triggers AND completions with no UI. If you add a session and its automation suddenly stops, check ownership. Fix is `agent_id` on every sub OR `settings.owner_agent_id` to pin.
2. **`prompt_file` failures are warnings, not errors.** A typo'd path produces an empty-prompt sub that fails at run time with `'failed'` and a warning log. Always grep for `[CUE] "<sub>" prompt_file` warnings when debugging "my sub doesn't work."
3. **The `:output` suffix on two-phase runs is load-bearing.** `${subscriptionName}:output` shows up as a separate row in `cue_events` and `activity log`. Anything that name-matches subs (filters, chain routing, manual triggers) must handle or normalize it.
4. **Fan-in keys are colon-joined.** Subscription names with `:` will mis-key the fan-in tracker AND the health-check lookup (`cue-engine.ts:583` does a naive first-`:` split). Don't allow them in subs.
5. **`pipeline_name` and `target_node_key`/`fan_out_node_keys` must round-trip through the normalizer.** They're renderer-only data, but if `cue-config-normalizer.ts:normalizeSubscription` drops them on save, the visual editor silently merges separate canvas nodes into one. The engine itself ignores them — the round-trip is the whole point.
6. **Don't change `MAX_CHAIN_DEPTH` (10) without thinking about fan-out.** Worst-case dispatches grow as `fanout^depth`. A pipeline with 3-way fan-out at depth 10 is `3^10 = 59049` parallel agents.
7. **`ChainDepth` is unique to chain step, not run.** Two parallel fan-out runs at depth 3 each show depth 3, not 3 and 4. The depth guard counts steps from the originating trigger, not total runs in flight.
8. **`HEARTBEAT_INTERVAL_MS` is the floor for `time.heartbeat` reconciliation granularity.** A subscription with `interval_minutes: 0.1` (6s) WILL accumulate "missed" intervals that get fired as a single catch-up event after sleep — because the reconciler does `Math.floor(gapMs / intervalMs)`. Sub-minute intervals + sleep events == mass dispatch. Either reject sub-minute intervals in validation or cap reconciled `missedCount` at 1.
9. **Sentry `operation` tags are part of the alerting contract.** `cue:heartbeat`, `cue:finalizeOutputRunStatus`, `cue:shell:sshWrap`, `cue:cliExecutor` are referenced by oncall paging rules. Don't refactor away the per-call-site tags.
10. **Restored queue entries lose `pipelineName`.** This is by design (no schema column). If we ever care to preserve labels across crashes, add a column to `cue_event_queue` and thread it through `PersistableQueueEntry`.

## Common change recipes

| Task                          | Files to touch                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a new event type          | `src/shared/cue/contracts.ts` (`CueEventType` union, `CUE_EVENT_TYPES`), `src/main/cue/triggers/<new>-trigger-source.ts`, register in `cue-trigger-source-registry.ts`, payload extraction in `cue-template-context-builder.ts`, validation in `config/cue-config-validator.ts`.                                                                 |
| Add a subscription field      | `src/shared/cue/contracts.ts` (`CueSubscription`), allowlist in `cue-config-normalizer.ts`, validate in `cue-config-validator.ts`, propagate to result via dispatch → run-manager → executor if it influences runtime.                                                                                                                           |
| Change a runtime constant     | All copies must be updated (e.g. `SIGKILL_DELAY_MS` is duplicated across executors). Grep before you change.                                                                                                                                                                                                                                     |
| Add a new run-level field     | `CueRunResult` (`src/shared/cue/contracts.ts`), populate in all three executors (`cue-executor.ts`, `cue-shell-executor.ts`, `cue-cli-executor.ts`), thread through run-manager's result init at `cue-run-manager.ts:258`, surface in `recordCueHistoryEntry`/`buildCueRunSummary`. The recent `pipelineName` plumbing is the canonical example. |
| Change history summary format | `src/shared/cue/cue-summary.ts` (shared with Cue Modal Activity Log).                                                                                                                                                                                                                                                                            |
| Add a template variable       | `src/shared/templateVariables.ts` (renderer + main shared), `src/main/cue/cue-template-context-builder.ts` (per-event extraction), document in `src/prompts/_maestro-cue.md`.                                                                                                                                                                    |
| Add a new IPC handler         | `src/main/ipc/handlers/cue.ts`, expose in `src/main/preload.ts`, type in `src/renderer/global.d.ts`, hook in `src/renderer/hooks/useCue.ts`.                                                                                                                                                                                                     |

## Test landmarks

`src/__tests__/main/cue/` has ~50 specs (1200+ assertions). The high-coverage entry points:

- `cue-engine.test.ts` — engine boot, session add/remove, dispatch, status projections.
- `cue-run-manager.test.ts` — concurrency, queue, drain, staleness, output_prompt phase, queue persistence, race conditions.
- `cue-executor.test.ts` — spawn, template substitution, SSH wrapping, history-entry construction.
- `cue-completion-chains.test.ts` + `cue-multi-hop-chains.test.ts` — chain propagation, depth guard, source_sub filtering.
- `cue-fan-in-tracker.test.ts` + `cue-fan-in-edge-cases.test.ts` — multi-source completion, partial sources, timeouts.
- `cue-startup.test.ts` — `app.startup` firing rules per `reason`.
- `cue-sleep-prevention.test.ts` + `cue-sleep-wake.test.ts` + `cue-reconciler.test.ts` — sleep/wake, reconciliation.
- `cue-config-normalizer-fanout.test.ts` + `cue-fanout-vanishing-pipeline.test.ts` — round-trip of `pipeline_name` / `target_node_key` / `fan_out_node_keys` (the round-trip-or-bust contract).
- `cue-security.test.ts` — env sanitization, prompt-file path traversal, SSH-resolution failure modes.
- `src/__tests__/shared/cue/cue-summary.test.ts` — `buildCueRunSummary` formatting, chain-N stripping, fan-in tagging, pipeline_name preference.

If you change anything in `src/main/cue/`, run `npx vitest run src/__tests__/main/cue/ src/__tests__/shared/cue/` before pushing — the cue suite is fast and exhaustive.
