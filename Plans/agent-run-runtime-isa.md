---
task: 'Expand agentRun runtime into a full-featured agent control plane'
slug: 20260701-120000_agent-run-full-featured-control-plane
effort: advanced
effort_source: explicit
phase: verify
progress: 77/81
mode: interactive
started: 2026-07-01T12:00:00Z
updated: 2026-07-01T16:45:00Z
iteration: 2
---

# ISA: agentRun Runtime -> Full-Featured Agent Control Plane

## Problem

The agentRun ledger is a well-designed but **passive** subsystem. The shared core
(`src/shared/agent-run/`: `types.ts`, `validators.ts`, `pianola-adapter.ts`) defines a rich
domain model (runs with provider/model/session linkage, artifacts, touchedFiles, checks,
reviews, pullRequest, merge, usage, a ten-state status enum at `types.ts:1`, typed events,
campaigns) and validation. A JSON/JSONL store (`src/cli/services/agent-run-store.ts`), a CLI
(`src/cli/commands/agent-run.ts`), IPC handlers (`src/main/ipc/handlers/agent-run.ts`), a
preload API (`src/main/preload/agentRun.ts`), and a renderer dashboard
(`src/renderer/components/AgentRunDashboard/AgentRunDashboardModal.tsx`, 874 lines + hook
`src/renderer/hooks/agentRun/useAgentRun.ts`) are all wired.

But almost none of that model is populated in practice, and the write path is unsafe for the
multi-process reality it already lives in:

1. **Only `pianola orchestrate` auto-writes runs.** `pianola-orchestrate.ts:218` upserts runs and
   `:219` appends events. Manual `agent-run` CLI and the IPC handlers also write, but those are
   user-driven, not lifecycle capture. Real Maestro agent sessions never create a run.
2. **Two spawn paths, neither captured.** Desktop sessions route through
   `ProcessManager.spawn(config)` (`ProcessManager.ts:59-78`); CLI-owned runs (`send`, autorun
   batch, goal-runner, synopsis) route through `spawnAgent` (`src/cli/services/agent-spawner.ts:927`,
   which shells `child_process.spawn` directly at `:436`/`:798`) and never touch ProcessManager.
   A ledger that only sees one path is not universal.
3. **Rich fields are schema-only.** `touchedFiles`, `checks`, `reviews`, `pullRequest`, `merge`,
   and `usage` exist on the type but have no producers outside manual CLI/JSON injection.
4. **The dashboard is read-only and manual-refresh.** The IPC layer has no push (no
   `webContents.send` in `agent-run.ts`); `useAgentRun` loads on mount and on explicit
   `refreshRuns` (`useAgentRun.ts:76,202`); the only run action is jump-to-session
   (`AgentRunDashboardModal.tsx:276`).
5. **The store is concurrency-unsafe.** `upsertAgentRun` reads the snapshot then rewrites it
   (`agent-run-store.ts:218,226`) with no lock. The main process and the `pianola orchestrate` /
   `send` CLI can write the same files simultaneously; each produces valid JSON yet loses the
   other's update (last-write-wins across processes). Atomicity guards partial files, not lost
   records.
6. **No lifecycle machine, no recovery.** Intermediate statuses (`waiting`, `needs_review`,
   `fixing`) are defined but have no live signal producer; no legal-transition guard exists; and
   runs left non-terminal when the app or CLI dies are never reconciled (the store only reads
   snapshots, `agent-run-store.ts:208`).
7. **The dashboard modal is 874 lines**, over the repo's <800-line file convention, and grows as
   actions land.

## Vision

Open the AgentRun Dashboard and see **every** interactive and CLI agent Maestro has run (group-chat
sessions excluded this iteration, D9), desktop or CLI, appearing
and updating **live** as they spawn, work, wait, get reviewed, and finish. Each run is a complete
record: which provider/model, on which branch and worktree, which files it touched, which checks
passed, which review findings are open, whether a PR exists, whether it merged, how many tokens it
burned. From the same surface you can cancel a runaway agent, retry a failure, resolve a finding,
or jump to its session. The ledger is the single source of truth for "what have my agents done
and what state is each in", it survives a crash without leaving zombie runs, two processes can
write it at once without losing a record, and it never slows a session down or leaks a credential.

## Out of Scope

- No autonomous plan authoring or task decomposition. Pianola remains the orchestrator and the
  author of plans; this ISA does not add LLM-driven decomposition, plan generation, or new
  autonomous dispatch of un-planned work. F8 adds only BOUNDED, ledger-driven reactive loops
  inside Pianola's existing plan/campaign runtime (needs_review -> fix -> merge), every one of
  them routed through the existing Pianola risk gate and the high-risk-always-escalates invariant.
- The deferred plugin act-verbs (`agents:dispatch`/`process:spawn`) stay locked behind their
  Phase-3 security gate and are untouched here; F8 dispatches through Pianola's existing
  `OrchestratorDeps.dispatch`/`ensureAgent` path, not the plugin host.
- No migration/backfill of historical sessions that ran before capture existed.
- No new provider integrations. Capture works for providers already in
  `KNOWN_AGENT_RUN_PROVIDERS`; adding a provider is out of scope.
- No full web dashboard UI parity. Live run/event push MUST reach web clients over the existing
  web-server bridge (ISC-3.8), but building the complete Extensions-grade web dashboard UI is a
  separate effort; the desktop renderer is the primary surface here.
- **Group-chat sessions are excluded from capture in this iteration** (see D9): their exits are
  consumed and returned before the regular completion seam (`exit-listener.ts:512`). Capturing
  them is a follow-up.
- No replacement of the JSON/JSONL store with SQLite; bound growth via rotation (ISC-6.6) and make
  writes safe via a single authority (F0) instead. A store swap is a separable future ISA.

## Principles

- The ledger is an **observability substrate first**: capture must never change session behavior
  or timing, and must never throw into a session lifecycle path.
- **One write authority.** All agent-run and event writes flow through a single serializing owner;
  no two processes race the same file with read-modify-write.
- **Producers push validated records; the store is dumb.** All domain shaping happens before the
  write; the store only persists validated snapshots atomically.
- **One record per run, append-only ordered events.** State lives on the run (guarded upsert);
  history lives in the JSONL event log with a monotonic sequence.
- **Read the truth at the seam.** Completion status, exit code, branch, and touched files come
  from the real process/git state at the moment of transition, not from an agent's self-report.
- **Terminal is terminal, and crashes are terminal too.** Once a run reaches a terminal state it
  is immutable except by an explicit audited action; a run whose process is gone is reconciled to
  a terminal state, never left dangling.

## Constraints

- **Pure core stays pure.** `src/shared/agent-run/` MUST NOT import `fs`, `electron`,
  `child_process`, or `node:`\* network modules. All producers (git, checks, gh, token usage) and
  the write-authority/lock live in `src/main/` or `src/cli/`. The only shared-core addition is a
  pure `lifecycle.ts` transition table (proven pure by ISC-2.9).
- **Single-writer or CAS-guarded store.** The store MUST NOT allow unguarded concurrent
  read-modify-write. Either the main process is the sole writer and CLI writers route through it,
  or a cross-process lock/compare-and-set wraps every snapshot mutation (see D8).
- **Validate every write.** Every record/event entering the store passes `validateAgentRun` /
  `validateAgentRunEvent` (or strict variants); malformed input is rejected, not coerced.
- **Atomic persistence preserved.** Keep the tmp-write-plus-rename path in `agent-run-store.ts`;
  no partial JSON on crash.
- **Encore/consent-gated where autonomous or sensitive.** Raw prompt text, diffs/artifacts, PR/
  merge data, and destructive control actions respect the `encoreFeatures` contract
  (`src/shared/settingsMetadata.ts:1011`) and consent, re-read at the decision point (see D1).
- Conventions: bun/bunx only (never npm/npx), TypeScript only, tabs for indentation, no em or en
  dashes in source or docs, immutable state updates, every source file under 800 lines.
- Validate ONLY touched areas with `bunx vitest run <files>`. Do NOT run the full suite (known
  pre-existing Windows path-test failures). Extend the e2e harness with the acceptance probe for
  UI-facing work.
- Do not disturb the dirty `rc` working tree; all work happens in the
  `.worktrees/autonomous-manager-agent` worktree on `feat/autonomous-manager-agent`.

## Goal

Turn the agentRun ledger from a Pianola-only record into a **universal, live, actionable, and
crash-safe agent control plane**: every real Maestro agent session other than group-chat (excluded
this iteration, D9), whether spawned via the desktop `ProcessManager.spawn` seam or the CLI
`spawnAgent` seam, is captured from spawn to
terminal state with its rich fields (touched files, checks, reviews, PR, merge, usage) populated
by real producers; all writes flow through a single serializing authority so concurrent main+CLI
writers never lose a record; the dashboard receives live push (desktop and web bridge) and offers
cancel/retry/resolve/merge actions gated by Encore/consent; a pure lifecycle guard enforces legal
transitions with real signal sources for waiting/needs_review/fixing; and startup reconciles any
run left non-terminal by a crash. Done means a freshly spawned agent (desktop OR CLI) appears in
the dashboard within one event tick, transitions through its real lifecycle without manual
refresh, survives an app crash without a zombie run, and its completed record carries the diff,
checks, and usage that actually happened, with the existing Pianola capture path still green. And
it closes the loop with Pianola: a dispatched task binds to its real captured run (not a duplicate
projection), the orchestrator settles tasks on the ledger's structured checks/reviews instead of
busy-to-idle heuristics, and a bounded needs_review -> fix -> merge reactive loop runs behind the
existing risk gate and Encore/autopilot flag -- without adding autonomous plan authoring.

## Criteria

### F0 - Store write-safety foundation

- [ ] ISC-0.1: A single write authority owns all agent-run/event writes; CLI writers reach it via broker/IPC or a cross-process lock (per D8).
- [ ] ISC-0.2: Two concurrent upsertAgentRun calls for different run ids both persist; neither record is lost.
- [ ] ISC-0.3: Two concurrent status updates to the same run resolve deterministically with no lost update.
- [ ] ISC-0.4: Anti: an interrupted write never leaves partial JSON (tmp-write-then-rename preserved).
- [ ] ISC-0.5: Anti: concurrent event appends never interleave a corrupt JSONL line.

### F1 - Universal run lifecycle capture

- [ ] ISC-1.1: A main-process capture service (`src/main/agent-run/`) wraps the write authority and validates every write.
- [ ] ISC-1.2: The `ProcessManager.spawn(config)` chokepoint (`ProcessManager.ts:59-78`) creates an AgentRun at spawn for every non-terminal, non-group-chat session (exclusions per ISC-1.7).
  - [ ] ISC-1.2.1: Identity fields set (provider, model, agentId, agentName).
  - [ ] ISC-1.2.2: Session linkage set (sessionId, tabId).
  - [ ] ISC-1.2.3: Workspace fields set (cwd, repo, worktreePath, branch, baseBranch).
  - [ ] ISC-1.2.4: source classification set and prompt stored per the D1 redaction policy.
- [ ] ISC-1.3: `process:exit` on the regular-exit path (`exit-listener.ts:548-573`, not the group-chat branch) transitions the run to completed (exit 0) or failed (nonzero) with exitCode.
- [ ] ISC-1.4: Every status transition appends a typed `status_change` AgentRunEvent with a timestamp.
- [ ] ISC-1.5: Run wall-clock duration is recorded (completedAt minus createdAt) on the terminal record.
- [ ] ISC-1.6: Capture resolves provider from the session config/toolType mapping, with `unknown` fallback.
- [ ] ISC-1.7: Anti: a `-terminal-` PTY session and any group-chat sessionId (recognized or not) create no AgentRun, filtered at BOTH creation and completion.
- [ ] ISC-1.8: Anti: a capture failure is logged and swallowed; the exit-listener and Cue paths complete unaffected.
- [ ] ISC-1.9: CLI-owned runs (`send`, autorun batch, goal-runner, synopsis) are captured via a hook around `spawnAgent` (`agent-spawner.ts:927`), creating a run at start and completing it on return.
- [ ] ISC-1.10: On app/CLI startup, runs left non-terminal (queued/running/waiting/fixing/needs_review) with no live process are reconciled to a terminal state (failed/stale) per D11.
- [ ] ISC-1.11: A double-spawn/replay that replaces a session's process supersedes or links the prior run (metadata.supersededBy) per D10; no run is orphaned.

### F2 - Rich-field producers

- [ ] ISC-2.1: On completion, touchedFiles is populated from a git diff against baseBranch in the run cwd/worktree.
- [ ] ISC-2.2: Anti: touchedFiles is an empty array (not an error) when the cwd is not a git repository.
- [ ] ISC-2.3: usage is populated from the named provider usage source (Claude usage snapshot / provider stdout token report); absent-source leaves usage undefined, not zero.
- [ ] ISC-2.4: A check run under a run records an AgentRunCheck with name, status, command, and timestamps.
- [ ] ISC-2.5: Reviewer-agent findings are ingested as AgentRunReviewFinding records with severity, category, message, status=open.
- [ ] ISC-2.6: pullRequest is populated (number, url, state, head/base branch) when a PR for the run branch is detected via gh.
- [ ] ISC-2.7: A merge attempt records an AgentRunMergeOutcome (status, commit, error).
- [ ] ISC-2.8: summarizeAgentRun reports accurate check and review counts after producers populate them.
- [ ] ISC-2.9: Anti: no producer code lives in `src/shared/agent-run/`; the pure core imports no fs/electron/child_process.

### F3 - Live dashboard and web bridge

- [ ] ISC-3.1: The write authority broadcasts `agentRun:updated` / `agentRun:eventAppended` to the renderer via webContents.send for EVERY write (main and CLI-origin), not only IPC-handler writes.
- [ ] ISC-3.2: The preload API exposes onUpdated and onEventAppended subscription methods returning an unsubscribe.
- [ ] ISC-3.3: useAgentRun subscribes and updates its state on push without a manual refresh call.
- [ ] ISC-3.4: A newly captured run appears in the open dashboard within 100ms of the push flush (measured in the e2e probe).
- [ ] ISC-3.5: A live status transition updates the run's badge in the open dashboard without refresh.
- [ ] ISC-3.6: Anti: the dashboard unsubscribes on unmount, leaving no dangling IPC listener.
- [ ] ISC-3.7: Anti: a burst of rapid events is coalesced (debounced/batched), not one re-render per event.
- [ ] ISC-3.8: Web clients receive the same run/event push over the web-server broadcast bridge.

### F4 - Dashboard actions

- [ ] ISC-4.1: Cancel on a running desktop run kills the ProcessManager process and sets status cancelled.
- [ ] ISC-4.2: Retry on a failed run re-dispatches, creates a new run linked via metadata.retryOf, and updates the owning campaign's runIds when the run belongs to one.
- [ ] ISC-4.3: Mark-fixed on a review finding sets its status to fixed and updates counts.
- [ ] ISC-4.4: Dismiss on a review finding sets its status to dismissed and updates counts.
- [ ] ISC-4.5: Trigger-merge invokes the merge path and records the merge outcome on the run.
- [ ] ISC-4.6: Open-PR opens the run's pullRequest url via the external-open bridge.
- [ ] ISC-4.7: Jump-to-session navigates to the linked session/tab when sessionId data exists.
- [ ] ISC-4.8: Anti: an action invalid for the run's current state is disabled in the UI and rejected in the handler.
- [ ] ISC-4.9: Anti: destructive actions (cancel, merge, retry) are gated by the Encore/consent check at invocation time.
- [ ] ISC-4.10: Cancel on a CLI/SSH-spawned run either terminates the tracked child or, when untracked, sets a clear cancel-requested state rather than silently no-opping.

### F5 - Lifecycle status machine with real signals

- [ ] ISC-5.1: A pure `src/shared/agent-run/lifecycle.ts` defines the legal status transition table.
- [ ] ISC-5.2: The run is set to waiting when a real waiting signal fires (ISC-5.7).
- [ ] ISC-5.3: The run is set to needs_review when it has open review findings (ISC-5.8).
- [ ] ISC-5.4: The run is set to fixing when a fix agent is dispatched for it (ISC-5.9).
- [ ] ISC-5.5: Anti: an illegal transition (for example completed to running) is rejected by the guard.
- [ ] ISC-5.6: Anti: a terminal state is immutable except via an explicit audited action.
- [ ] ISC-5.7: waiting has a named producer: Pianola waiting_input inference (`pianola-orchestrate.ts:471`) or the plugin session-event (`plugin-session-events.ts:72`); Anti: a working run is not falsely marked waiting.
- [ ] ISC-5.8: needs_review has a named producer: the F2 reviews producer sets it when open findings exist; Anti: a run with zero open findings is never needs_review.
- [ ] ISC-5.9: fixing has a named producer: a fix-agent dispatch event sets it; Anti: a run with no active fix dispatch is never fixing.

### F6 - Gating, ordering, and integrity

- [ ] ISC-6.1: Raw prompt/diff/artifact capture honors the D1 policy (gate/redaction) read at the capture point.
- [ ] ISC-6.2: Active control actions honor the Encore/consent gate read at the action point.
- [ ] ISC-6.3: Every write passes validateAgentRun/validateAgentRunEvent; a malformed record is rejected, not stored.
- [ ] ISC-6.4: Writes remain atomic (tmp write then rename); an interrupted write never leaves partial JSON.
- [ ] ISC-6.5: Anti: no credentials or secret-bearing prompt text are persisted; prompt text is length-capped and secret-redacted.
- [ ] ISC-6.6: The event log growth is bounded by rotation at a defined size/age threshold.
- [ ] ISC-6.7: A run whose worktreePath is deleted (via the git handler or a watched deletion event) is marked stale, not silently broken.
- [ ] ISC-6.8: Events carry a monotonic per-run sequence; readers order by seq then timestamp and suppress duplicates.

### F7 - Decomposition and performance

- [ ] ISC-7.1: AgentRunDashboardModal.tsx (874 lines) is decomposed so every resulting file is under 800 lines.
- [ ] ISC-7.2: list queries support limit AND offset pagination and stay responsive on a 5000-run ledger.
- [ ] ISC-7.3: Anti: only touched-area vitest files are run and they pass; the full suite is not invoked.
- [ ] ISC-7.4: Anti: the existing Pianola capture path (pianola-orchestrate) is unchanged and its tests stay green.

### F8 - Deep Pianola integration

- [ ] ISC-8.1: A Pianola-dispatched task binds to the REAL captured AgentRun for its session (via `ProcessManager.spawn` capture), not a separate `pianola:planId:taskId` projection record.
- [ ] ISC-8.2: Anti: a dispatched task does not produce two ledger records (one projection + one captured); the projection id reconciles to the captured run id.
- [ ] ISC-8.3: A new pure `OrchestratorDeps.getRunLedger(task)` dep exposes the captured run's checks/reviews/pullRequest/merge to the engine; Anti: no fs/electron import enters `src/shared/pianola/`.
- [ ] ISC-8.4: `detectTaskOutcome` settles a task to done only when the ledger shows passing checks and zero open critical/high findings, not busy-to-idle alone.
- [ ] ISC-8.5: `PianolaTaskStatus` gains `needs_review` and `fixing`, aligning the task model with `CampaignTaskStatus`.
- [ ] ISC-8.6: A task whose captured run enters needs_review (open findings) transitions the Pianola task to needs_review.
- [ ] ISC-8.7: On needs_review, the orchestrator dispatches a bounded fix agent (task -> fixing) via the existing `dispatch`/`ensureAgent` path.
- [ ] ISC-8.8: Anti: the fix loop is bounded by a max-attempts cap; an exhausted task escalates to the user rather than re-dispatching forever.
- [ ] ISC-8.9: Every auto-fix and auto-merge decision is rated through `rateRisk`/the Pianola policy and audited before dispatch (audit-before-action).
- [ ] ISC-8.10: Anti: a high-risk auto-action always escalates to the user and is never auto-dispatched (high-risk-always-escalates invariant preserved).
- [ ] ISC-8.11: The campaign adapter is bidirectional: a captured run joining/leaving a task updates the Campaign projection, and a campaign-level retry/cancel reaches the plan.
- [ ] ISC-8.12: Anti: the orchestrator re-reads `encoreFeatures.pianola`/`autopilot` each iteration and self-stops the reactive loop when consent is revoked mid-run.
- [ ] ISC-8.13: Anti: F8 reactive loops are gated by the Encore/autopilot flag; with it off, Pianola behaves exactly as the current supervisor (no auto-fix, no auto-merge).
- [ ] ISC-8.14: When a task's captured run has passing checks and zero open findings, and the merge is not high-risk, Pianola requests merge via the existing merge path, records an AgentRunMergeOutcome, and settles the Pianola task to `done` while its CampaignTask projection advances to `merged`; Anti: merge is never attempted with failing checks or open critical/high findings.

## Test Strategy

| isc       | type        | check                                                                                                                                                                       | threshold                                     | tool                        |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------- |
| ISC-0.1   | unit        | single write authority present; CLI write path routes through it (no direct store write from CLI capture)                                                                   | one writer, CLI uses broker/lock              | vitest + read               |
| ISC-0.2   | integration | spawn two processes upserting different ids concurrently, read back                                                                                                         | both records present                          | vitest + child procs        |
| ISC-0.3   | integration | two concurrent status updates same run, assert final state deterministic, no lost write                                                                                     | last state deterministic, both events present | vitest                      |
| ISC-0.4   | unit        | interrupt write, assert file valid or unchanged                                                                                                                             | no partial JSON                               | vitest                      |
| ISC-0.5   | integration | concurrent appendEvent, assert every JSONL line parses                                                                                                                      | zero corrupt lines                            | vitest                      |
| ISC-1.1   | unit        | capture service exists, imports validateAgentRun, rejects invalid                                                                                                           | file present, invalid throws                  | vitest + read               |
| ISC-1.2   | integration | spawn desktop session in harness, getAgentRun returns record at spawn time                                                                                                  | record exists before exit                     | vitest                      |
| ISC-1.2.1 | unit        | identity fields populated                                                                                                                                                   | provider/model/agentId/agentName set          | vitest                      |
| ISC-1.2.2 | unit        | session linkage populated                                                                                                                                                   | sessionId/tabId set                           | vitest                      |
| ISC-1.2.3 | unit        | workspace fields populated from real cwd/git                                                                                                                                | cwd/repo/worktree/branch/baseBranch set       | vitest + tmp git            |
| ISC-1.2.4 | unit        | source classified, prompt stored per D1 policy                                                                                                                              | source set, prompt gated/redacted             | vitest                      |
| ISC-1.3   | unit        | fire regular exit code 0 then 1, assert completed then failed with exitCode                                                                                                 | status+exitCode match                         | vitest                      |
| ISC-1.4   | unit        | readAgentRunEvents grows by one per transition, type=status_change                                                                                                          | count+type correct                            | vitest                      |
| ISC-1.5   | unit        | terminal record duration = completedAt - createdAt >= 0                                                                                                                     | numeric, non-negative                         | vitest                      |
| ISC-1.6   | unit        | parametrized per provider config/toolType, plus unknown fallback                                                                                                            | one pass per provider + unknown               | vitest                      |
| ISC-1.7   | unit        | fire `-terminal-` and group-chat exits at create and complete, assert no record                                                                                             | zero records                                  | vitest                      |
| ISC-1.8   | unit        | force store to throw, assert exit+Cue handlers unaffected                                                                                                                   | no rethrow, logger.error called               | vitest                      |
| ISC-1.9   | integration | invoke spawnAgent via send/batch/goal-runner harness, assert run created+completed                                                                                          | record with terminal state                    | vitest                      |
| ISC-1.10  | unit        | seed non-terminal run with no process, run startup recovery, assert reconciled                                                                                              | status terminal (failed/stale)                | vitest                      |
| ISC-1.11  | unit        | replay/replace same session, assert prior run superseded/linked, no orphan                                                                                                  | supersededBy set, no dangling running         | vitest                      |
| ISC-2.1   | unit        | seed temp git repo with change, run producer, assert touchedFiles                                                                                                           | matches changed files                         | vitest + tmp git            |
| ISC-2.2   | unit        | run producer in non-git cwd, assert []                                                                                                                                      | empty array, no throw                         | vitest                      |
| ISC-2.3   | unit        | mock provider usage source present and absent                                                                                                                               | present->usage set, absent->undefined         | vitest                      |
| ISC-2.4   | unit        | record a check, assert AgentRunCheck shape                                                                                                                                  | name/status/command/timestamps                | vitest                      |
| ISC-2.5   | unit        | feed reviewer output, assert findings mapped status=open                                                                                                                    | severity/category/message set                 | vitest                      |
| ISC-2.6   | unit        | mock gh PR lookup, assert pullRequest populated                                                                                                                             | number/url/state/branches                     | vitest                      |
| ISC-2.7   | unit        | run merge path, assert merge outcome recorded                                                                                                                               | status set, commit or error                   | vitest                      |
| ISC-2.8   | unit        | extend summarize test after producers                                                                                                                                       | counts exact                                  | vitest                      |
| ISC-2.9   | static      | grep src/shared/agent-run for fs/electron/child_process imports                                                                                                             | zero matches                                  | grep                        |
| ISC-3.1   | unit        | spy webContents.send on both main-origin and CLI-origin writes                                                                                                              | called both paths                             | vitest                      |
| ISC-3.2   | unit        | preload exposes onUpdated/onEventAppended returning unsubscribe                                                                                                             | functions present                             | vitest + read               |
| ISC-3.3   | unit        | hook test: emit push, state updates without refreshRuns                                                                                                                     | state changed, no manual load                 | vitest                      |
| ISC-3.4   | e2e         | seed run after dashboard open, measure appearance latency                                                                                                                   | visible within 100ms                          | playwright                  |
| ISC-3.5   | e2e         | transition status, assert badge changes without refresh                                                                                                                     | badge text/color changes                      | playwright                  |
| ISC-3.6   | unit        | unmount, assert removeListener called                                                                                                                                       | listener count back to base                   | vitest                      |
| ISC-3.7   | unit        | emit N rapid events, assert re-render/load bounded                                                                                                                          | loads << N                                    | vitest                      |
| ISC-3.8   | integration | connect a web client, push a run/event, assert received                                                                                                                     | client gets broadcast                         | vitest + web-server harness |
| ISC-4.1   | unit        | cancel calls ProcessManager kill, status cancelled                                                                                                                          | kill invoked, status cancelled                | vitest                      |
| ISC-4.2   | unit        | retry creates linked run, campaign runIds updated when applicable                                                                                                           | retryOf set, campaign mutated                 | vitest                      |
| ISC-4.3   | unit        | mark-fixed sets finding fixed, counts update                                                                                                                                | status fixed, count +1                        | vitest                      |
| ISC-4.4   | unit        | dismiss sets finding dismissed, counts update                                                                                                                               | status dismissed, count +1                    | vitest                      |
| ISC-4.5   | unit        | trigger-merge records merge outcome                                                                                                                                         | merge field set                               | vitest                      |
| ISC-4.6   | unit        | open-PR calls external-open with url                                                                                                                                        | bridge called with url                        | vitest                      |
| ISC-4.7   | e2e         | jump-to-session navigates when sessionId present                                                                                                                            | session/tab activated                         | playwright                  |
| ISC-4.8   | unit+e2e    | invalid action disabled in UI and rejected in handler                                                                                                                       | button disabled, handler errors               | vitest + playwright         |
| ISC-4.9   | unit        | destructive action with Encore/consent off is rejected                                                                                                                      | action denied                                 | vitest                      |
| ISC-4.10  | unit        | cancel CLI/SSH run: tracked->terminated, untracked->cancel-requested state                                                                                                  | no silent no-op                               | vitest                      |
| ISC-5.1   | unit        | lifecycle.ts exports transition table, pure imports                                                                                                                         | table present, imports clean                  | vitest + read               |
| ISC-5.2   | unit        | waiting signal sets status waiting                                                                                                                                          | status waiting                                | vitest                      |
| ISC-5.3   | unit        | open findings set status needs_review                                                                                                                                       | status needs_review                           | vitest                      |
| ISC-5.4   | unit        | fix dispatch sets status fixing                                                                                                                                             | status fixing                                 | vitest                      |
| ISC-5.5   | unit        | attempt completed to running, guard rejects                                                                                                                                 | transition rejected                           | vitest                      |
| ISC-5.6   | unit        | mutate terminal run without audited action, rejected                                                                                                                        | write rejected                                | vitest                      |
| ISC-5.7   | unit        | fire waiting_input producer, assert waiting; working run not marked                                                                                                         | true positive + anti false positive           | vitest                      |
| ISC-5.8   | unit        | findings present->needs_review; zero findings never needs_review                                                                                                            | true positive + anti                          | vitest                      |
| ISC-5.9   | unit        | fix dispatch->fixing; no dispatch never fixing                                                                                                                              | true positive + anti                          | vitest                      |
| ISC-6.1   | unit        | toggle D1 policy, capture of prompt/diff honors it at read time                                                                                                             | behavior flips with flag                      | vitest                      |
| ISC-6.2   | unit        | toggle Encore/consent, action gate honors it at read time                                                                                                                   | behavior flips with flag                      | vitest                      |
| ISC-6.3   | unit        | feed malformed record/event, assert rejected                                                                                                                                | not persisted                                 | vitest                      |
| ISC-6.4   | unit        | interrupt write, assert no partial JSON                                                                                                                                     | file valid or unchanged                       | vitest                      |
| ISC-6.5   | unit        | prompt with secret pattern, assert redacted and length-capped                                                                                                               | secret absent, length <= cap                  | vitest                      |
| ISC-6.6   | unit        | exceed event threshold, assert rotation                                                                                                                                     | log rotated at threshold                      | vitest                      |
| ISC-6.7   | unit        | delete worktree for a run, assert marked stale                                                                                                                              | status/flag stale                             | vitest                      |
| ISC-6.8   | unit        | append out-of-order + duplicate events, assert seq ordering + dedup                                                                                                         | ordered by seq, dupes suppressed              | vitest                      |
| ISC-7.1   | static      | wc -l each dashboard file after split                                                                                                                                       | each < 800                                    | bash wc                     |
| ISC-7.2   | perf        | list with limit+offset against 5000-run fixture                                                                                                                             | bounded time, offset works                    | vitest                      |
| ISC-7.3   | process     | run only touched-area vitest files, all green                                                                                                                               | targeted files pass                           | bunx vitest                 |
| ISC-7.4   | unit        | run pianola-orchestrate/agent-run existing tests, still green                                                                                                               | no regressions                                | bunx vitest                 |
| ISC-8.1   | integration | dispatch a Pianola task, assert task.runId == captured ProcessManager run id                                                                                                | ids equal                                     | vitest                      |
| ISC-8.2   | integration | after dispatch, count ledger records for the task                                                                                                                           | exactly one                                   | vitest                      |
| ISC-8.3   | unit        | getRunLedger returns checks/reviews/pr/merge; grep shared/pianola for fs/electron                                                                                           | dep present, zero fs imports                  | vitest + grep               |
| ISC-8.4   | unit        | busy-to-idle with failing checks/open critical, assert NOT done                                                                                                             | task stays running/needs_review               | vitest                      |
| ISC-8.5   | unit        | PianolaTaskStatus includes needs_review and fixing                                                                                                                          | both present                                  | vitest + read               |
| ISC-8.6   | unit        | open findings on run, assert task -> needs_review                                                                                                                           | status needs_review                           | vitest                      |
| ISC-8.7   | unit        | needs_review triggers fix dispatch via deps, task -> fixing                                                                                                                 | dispatch called, status fixing                | vitest                      |
| ISC-8.8   | unit        | exceed max fix attempts, assert escalate not re-dispatch                                                                                                                    | escalation, no further dispatch               | vitest                      |
| ISC-8.9   | unit        | auto-fix/auto-merge rated + audited before dispatch                                                                                                                         | rateRisk called, audit entry written          | vitest                      |
| ISC-8.10  | unit        | high-risk auto-action, assert escalated never auto-dispatched                                                                                                               | escalation only                               | vitest                      |
| ISC-8.11  | unit        | run joins task -> campaign updated; campaign retry/cancel -> plan updated                                                                                                   | bidirectional sync observed                   | vitest                      |
| ISC-8.12  | unit        | revoke encoreFeatures.pianola mid-run, assert loop self-stops                                                                                                               | loop halts next iteration                     | vitest                      |
| ISC-8.13  | unit        | autopilot flag off, assert no auto-fix/auto-merge (supervisor parity)                                                                                                       | zero auto-actions                             | vitest                      |
| ISC-8.14  | integration | green run (checks pass, no findings, low risk), assert merge requested + AgentRunMergeOutcome recorded + Pianola task done + CampaignTask merged; dirty run assert no merge | merge on green only                           | vitest                      |

## Features

| name                 | satisfies              | depends_on         | parallelizable               |
| -------------------- | ---------------------- | ------------------ | ---------------------------- |
| F0 write-safety      | ISC-0.1..0.5           | none               | no (foundation, lands first) |
| F5 lifecycle-guard   | ISC-5.1, 5.5, 5.6      | none (pure core)   | yes                          |
| F1 capture-service   | ISC-1.1..1.11          | F0, F5             | partial                      |
| F2 rich-producers    | ISC-2.1..2.9           | F1                 | yes (per producer)           |
| F3 live-push+web     | ISC-3.1..3.8           | F0, F1             | yes                          |
| F5 signals           | ISC-5.2..5.4, 5.7..5.9 | F1, F2             | partial                      |
| F4 dashboard-actions | ISC-4.1..4.10          | F1, F3, F5         | partial                      |
| F6 gating-ordering   | ISC-6.1..6.8           | F0, F1, F2, F4     | partial                      |
| F7 decomp-perf       | ISC-7.1..7.4           | F3                 | yes                          |
| F8 deep-pianola      | ISC-8.1..8.14          | F1, F2, F4, F5, F6 | partial                      |

Build order: **F0 (write-safety) lands first** as the foundation, with F5's pure transition
table (ISC-5.1/5.5/5.6) built in parallel. Then F1 capture (both seams, needs F0+F5). Then F2
producers, F3 live-push+web bridge, and F7 decomposition in parallel on top of F1 (F7 alongside
F3 because the modal is already over the 800-line cap). F5 signal producers (5.2-5.4, 5.7-5.9)
follow F2 (needs_review depends on the reviews producer). F4 actions need F1+F3+F5. F6 gating/
ordering/integrity is woven through F0/F1/F2/F4. **F8 (deep-pianola) lands last**: it depends on
the full substrate (F1 capture for run binding, F2 producers for checks/reviews/merge, F5 signals
for needs_review/fixing, F4/F6 for the gated merge action), and it is the one feature that pulls
bounded orchestration logic back in scope. Each feature is one worktree-scoped change plus
its acceptance probe; UI features extend the e2e harness.

## Decisions

- 2026-07-01 D1 (RESOLVED, third option adopted): capture gating is tiered. **Always-on** minimal
  metadata (provider, model, session/tab linkage, status, timestamps, branch, touchedFile counts)
  like `usageStats` (default true) so the ledger is useful without opt-in. **Gated behind Encore/
  consent + redaction**: raw prompt text, full diffs/artifacts, PR/merge data, and all destructive
  control actions (cancel/retry/merge). Rationale: observability of "what ran and its state" is
  not sensitive and should not be opt-in; the content and the real-world side effects are, and sit
  behind the same gate class as the other autonomous features on this branch. Supersedes the
  earlier A-vs-B framing.
- 2026-07-01 D2: destructive control actions (cancel/retry/merge) are gated; passive capture and
  read/resolve-finding are not. Killing a process or merging a branch is a real-world side effect.
- 2026-07-01 D3: capture hooks BOTH spawn seams, not only the desktop one. Desktop: START/upsert at
  `ProcessManager.spawn` (`ProcessManager.ts:59-78`), the chokepoint for `process.ts:1232`,
  `context.ts:233`, `tabNaming.ts:472`, and replay (group-chat also routes through this seam via
  `spawnGroupChatAgent.ts:231` but is filtered out at capture time per D9/ISC-1.7); COMPLETION at the regular-exit
  path in `exit-listener.ts:548-573`. CLI: START/COMPLETE via a hook around `spawnAgent`
  (`agent-spawner.ts:927`) covering send/batch/goal-runner/synopsis (D7). Capture is guarded
  (ISC-1.8) so a failure cannot affect the Cue path or the session. Creating the run at spawn (not
  exit) is what makes failed/long-running runs visible immediately and makes F3 live streaming
  possible.
- 2026-07-01 D4: producers (git diff, checks, gh, token usage) live in `src/main/agent-run/` (and
  `src/cli/` where CLI-invoked), never in the pure shared core. The shared core gains only
  `lifecycle.ts` (a pure transition table), preserving the fs/electron-free invariant (ISC-2.9).
- 2026-07-01 D5: placement. Written to `Plans/agent-run-runtime-isa.md` to match the branch
  convention (pianola/plugin design docs live in `Plans/`), not a project-root `ISA.md`, because
  it scopes one subsystem expansion.
- 2026-07-01 D6: retain JSON/JSONL; do not migrate to SQLite. Bound growth via event-log rotation
  (ISC-6.6) and make writes safe via F0 (single authority). A store swap is a separable future ISA.
- 2026-07-01 D7 (refined, from codex audit): the ledger captures CLI-owned runs, not only desktop
  ProcessManager runs. A capture hook wraps `spawnAgent` (`agent-spawner.ts:927`) so send, autorun
  batch, goal-runner, and synopsis runs enter the ledger. Without this the Goal's "every real
  Maestro agent session" is false, since those paths use `child_process.spawn` directly and never
  touch ProcessManager.
- 2026-07-01 D8 (from codex audit): store write authority. The main process is the sole writer
  while the app is running; the CLI routes writes through the existing Maestro client/IPC path when
  the app is up, and falls back to a cross-process file lock + compare-and-set when it is not. This
  closes the read-modify-write lost-update hole between the main process and the `pianola
orchestrate`/`send` CLI (`agent-run-store.ts:218,226`).
- 2026-07-01 D9 (from codex audit): group-chat sessions are excluded from capture this iteration.
  Their exits are consumed and returned before the regular completion seam
  (`exit-listener.ts:120,270,512`); capturing them cleanly is deferred. Declared in Out of Scope.
- 2026-07-01 D10 (from codex audit): double-spawn/replay semantics. `ProcessManager.spawn` kills
  any existing process for a sessionId (`ProcessManager.ts:63,69`) and interactive replay
  re-spawns the same session (`index.ts:746`). The prior run is marked superseded and linked via
  metadata.supersededBy to the new run; it is never left dangling.
- 2026-07-01 D11 (from codex audit): crash recovery. On startup, runs left non-terminal with no
  live process are reconciled to a terminal state (failed for known-crashed, stale for unknown),
  because the store only reads snapshots and nothing else clears them (`agent-run-store.ts:208`).
- 2026-07-01 D12 (from codex audit): worktree deletion. A run whose worktreePath is removed (via
  `git.ts:1643/1680` or a watched deletion at `git.ts:1556/1574`) is marked stale so the dashboard
  does not present a broken jump/diff target.
- 2026-07-01 D13 (scope expansion, user-directed): deep Pianola integration is IN scope as F8,
  not a separate companion ISA. F8 unifies the Pianola task run with its real captured AgentRun
  (killing the `pianola:planId:taskId` projection duplicate), feeds the ledger's structured
  checks/reviews/merge into `detectTaskOutcome` via a new pure `OrchestratorDeps.getRunLedger`
  dep, extends `PianolaTaskStatus` with needs_review/fixing, and adds the bounded
  needs_review -> fix -> merge reactive loop. Every auto-action routes through the existing
  `rateRisk`/policy gate (high-risk-always-escalates preserved) and the whole loop is gated by
  `encoreFeatures.pianola`/`autopilot`, re-read each iteration. This narrows the original
  "no orchestration logic" Out-of-Scope line to "no autonomous plan authoring/decomposition":
  bounded reactive loops on an existing plan are in; LLM plan generation stays out.

## Changelog

- conjectured: capturing every Maestro agent run needs exactly two seams -- START at
  `ProcessManager.spawn` and COMPLETE at `exit-listener.ts:565-573` -- and the existing JSON/JSONL
  store is safe to keep as-is.
  refuted by: codex (gpt-5.5, high-effort, read-only) completeness audit 2026-07-01, grounded in
  file:line evidence -- (1) CLI-owned runs (`send`/batch/goal-runner/synopsis) route through
  `spawnAgent` -> `child_process.spawn` (`agent-spawner.ts:927,436,798`) and never touch
  ProcessManager; (2) group-chat exits return before the completion seam (`exit-listener.ts:512`);
  (3) `upsertAgentRun` is unguarded read-modify-write (`agent-run-store.ts:218,226`) so concurrent
  main+CLI writers lose records; (4) `waiting`/`needs_review`/`fixing` had no live signal
  producers; (5) no crash recovery, replay, or worktree-deletion handling; (6) several compound/
  non-atomic ISCs and weak test rows.
  learned: a "universal" ledger must hook BOTH spawn seams (desktop and CLI), serialize all writes
  through one authority, drive lifecycle states from real producers, and reconcile non-terminal
  runs on startup. Atomicity (partial-file safety) is not the same property as concurrency safety
  (lost-update safety); the store had the first, not the second.
  criterion now: added F0 write-safety (ISC-0.1..0.5), ISC-1.9 CLI capture, ISC-1.10 crash
  recovery, ISC-1.11 replay, ISC-3.8 web bridge, ISC-4.10 CLI/SSH cancel, ISC-5.7..5.9 signal
  producers, ISC-6.7 worktree-stale, ISC-6.8 event ordering/dedup; split compound ISC-1.2 into
  1.2.1-1.2.4; resolved D1 with the tiered third option; added D7-D12; corrected the modal size
  claim to 874 lines. ISC count 48 -> 67.
- conjectured: the agentRun ledger and Pianola should stay decoupled -- the ledger is a passive
  substrate Pianola merely writes task runs into, and deep integration belongs in a later ISA.
  refuted by: user direction (2026-07-01) plus a Pianola-runtime read -- Pianola already writes a
  duplicate projection run (`pianolaTaskAgentRunId` = `pianola:planId:taskId`,
  `pianola-orchestrate.ts:177`) distinct from the real captured session, and `detectTaskOutcome`
  settles tasks on busy-to-idle + transcript heuristics (`pianola-orchestrator.ts:121`) while
  blind to the ledger's structured checks/reviews/merge. Keeping them decoupled entrenches a
  double-record and a heuristic-only completion signal.
  learned: the ledger is not just Pianola's output sink; once it carries real checks/reviews/merge
  it is the correct INPUT for orchestration decisions. Unifying the projection with the captured
  run and feeding rich fields back through a pure `getRunLedger` dep lets Pianola settle tasks on
  ground truth and run a bounded needs_review -> fix -> merge loop, all behind the existing risk
  gate and Encore flag -- without adding plan authoring.
  criterion now: added F8 deep-pianola (ISC-8.1..8.14): run/projection unification (8.1-8.2),
  pure getRunLedger dep (8.3), ledger-driven outcome (8.4), needs_review/fixing task states (8.5),
  the bounded fix loop (8.6-8.8), risk-gated + audited auto-actions (8.9-8.10), bidirectional
  campaign sync (8.11), Encore/autopilot gating + supervisor parity (8.12-8.13), and the positive
  gated auto-merge criterion (8.14). Narrowed the Out-of-Scope orchestration line to exclude only
  autonomous plan authoring; added D13. ISC count 67 -> 81.

## Verification

Built across 9 features (F0-F8) in the `.worktrees/autonomous-manager-agent` worktree. `rc`
untouched. Repo-wide `bunx tsc -p tsconfig.json --noEmit` exit 0. New tests: 255 (all
teeth-verified by impl mutation, zero production bugs found); full agent-run + pianola suite
`bunx vitest run` = 638 tests across 29 files, all green.

- F0 write-safety (ISC-0.1..0.5): `src/cli/services/agent-run-lock.ts` cross-process lock
  (mkdir + owner-token, stale steal, timeout) wraps all 5 store mutators. Proven by
  `agent-run-lock.test.ts` + `agent-run-store-concurrency.test.ts` (9 tests, 4 mutations).
- F1 capture (ISC-1.1..1.11): `src/main/agent-run/capture-service.ts` bound to `ProcessManager`
  `spawn` (post-success emit) + `exit-listener` seams; CLI capture via `captureCliRun` at 5
  spawnAgent sites; `recover-runs.ts` startup reconcile; unique per-spawn id + supersede.
  Proven by `capture-service.test.ts` (20) + `recover-runs.test.ts` (14).
- F2 producers (ISC-2.1..2.9): `src/main/agent-run/producers.ts` git diff / usage / gh PR /
  pure check+review mappers, injectable boundaries. Proven by `producers.test.ts` (21).
- F3 live-push (ISC-3.1..3.3, 3.6..3.8): broadcast module + IPC/capture broadcast + preload
  subscribe + debounced hook + web bridge (`WebServer.broadcastToAll`) + CLI-origin store
  watcher. Unit-covered; **ISC-3.4/3.5 are e2e (playwright) and deferred to the harness run.**
- F5 lifecycle + signals (ISC-5.1..5.9): pure `lifecycle.ts` transition guard (77 tests) +
  `signals.ts` waiting/needs_review/fixing with anti-guards (18 tests), wired at the
  pianola-orchestrate waiting_input site.
- F6 integrity (ISC-6.1..6.8): redaction (`redact.ts`, in the 82 pure-helper tests), event
  `seq` ordering + dedup, log rotation, worktree-stale wired into `git.ts` deletion sites.
- F7 decomposition (ISC-7.1..7.2): 874-line modal split into 8 files (max 333 lines);
  offset pagination threaded service->preload->IPC->store. **ISC-7.1 verified by line count.**
- F8 deep-pianola (ISC-8.1..8.14): run/projection unification, `getRunLedger` dep, ledger-driven
  outcome, needs_review/fixing task states, bounded fix loop, risk-rated + audited auto-actions,
  autopilot gate + supervisor parity, bidirectional campaign sync. Proven by
  `pianola-orchestrator-reactive.test.ts` (14, 5 mutations).

### Deferred / carve-outs (honest)

- **ISC-3.4/3.5, 4.7** (dashboard live-appearance + jump-to-session): e2e/playwright probes not
  run here; the code is wired and unit-covered. Run `e2e/` under the harness to close them.
- **ISC-4.5 / ISC-8.14 actual merge**: no git-merge execution path exists anywhere in the app
  (git.ts exposes status/diff/commit/createPR, no branch merge). Per the ISA's own allowance,
  both the F4 action and the F8 loop record an honest `AgentRunMergeOutcome{ status: 'skipped' }`
  with a reason rather than fabricating a merge. The audit + gating + risk-rating path is fully
  wired; only the terminal git call is absent. This is the single intentional stub.
- **Known debt**: `pianola-orchestrate.ts` imports `AgentRunSignals` from `src/main/agent-run/`
  (a CLI->main reference). Runtime-safe (signals.ts pulls only electron-free shared types +
  broadcast, which no-ops in the CLI process), but a future cleanup should relocate the injected
  signal class to a cli-safe module. The `task.agentId === captured sessionId` correspondence the
  waiting-signal and run-unification rely on is consistent across the projection path but is worth
  an integration probe.
