# CLAUDE-PLANNING-PIPELINE.md

Agent-facing architecture reference for the Planning Pipeline epic (#243). Read this before touching anything under `src/main/planning-pipeline/` or `src/shared/planning-pipeline-*.ts`.

---

## Overview

The Planning Pipeline is a state machine that carries a work item through the full idea-to-merge lifecycle. It is _separate from_ the Work Graph status vocabulary — it adds lifecycle semantics the generic Work Graph does not express.

### Stage sequence

```
idea → prd-draft → prd-finalized → epic-decomposed → tasks-decomposed
     → agent-ready → runner-active → needs-review → review-approved → fork-merged
                                          ↕
                                    needs-fix ↔ fix-active  (failure loop)
```

Stage state is represented as a **GitHub label** with a `pipeline:` prefix on the work item's issue/PR. At most one pipeline label may be present at a time.

### Label state machine

| Stage              | Label                       | Entered when…                                     |
| ------------------ | --------------------------- | ------------------------------------------------- |
| `idea`             | `pipeline:idea`             | Work item first enters the pipeline               |
| `prd-draft`        | `pipeline:prd-draft`        | User starts writing a PRD                         |
| `prd-finalized`    | `pipeline:prd-finalized`    | PRD is approved and ready to decompose            |
| `epic-decomposed`  | `pipeline:epic-decomposed`  | Delivery Planner creates the epic                 |
| `tasks-decomposed` | `pipeline:tasks-decomposed` | Epic tasks are created and unblocked tasks tagged |
| `agent-ready`      | `pipeline:agent-ready`      | Task is eligible for auto-pickup by an agent      |
| `runner-active`    | `pipeline:runner-active`    | An agent has claimed and is working the task      |
| `needs-review`     | `pipeline:needs-review`     | Agent pushed a PR; review agent launched          |
| `review-approved`  | `pipeline:review-approved`  | Reviewer approved; merge is queued                |
| `fork-merged`      | `pipeline:fork-merged`      | PR was merged into the fork repository            |
| `needs-fix`        | `pipeline:needs-fix`        | Quality gate or reviewer rejected the PR          |
| `fix-active`       | `pipeline:fix-active`       | Fix agent is working the remediation              |

**Transition rules** live in `PIPELINE_TRANSITIONS` and `PIPELINE_FAILURE_TRANSITIONS` in `src/shared/planning-pipeline-types.ts`. All other edges are rejected by `InvalidPipelineTransitionError`.

---

## Components

### Shared contracts

| Component                                        | File                                     | Task |
| ------------------------------------------------ | ---------------------------------------- | ---- |
| Stage vocabulary + transition tables             | `src/shared/planning-pipeline-types.ts`  | #244 |
| Guard layer (label → stage, planStageTransition) | `src/shared/planning-pipeline-guards.ts` | #245 |

### Runtime primitives

| Component                         | File                                             | Task |
| --------------------------------- | ------------------------------------------------ | ---- |
| Event bus                         | `src/main/planning-pipeline/event-bus.ts`        | #246 |
| Trigger registry                  | `src/main/planning-pipeline/trigger-registry.ts` | #246 |
| Dispatcher (wires bus → registry) | `src/main/planning-pipeline/dispatcher.ts`       | #246 |
| Runtime factory                   | `src/main/planning-pipeline/runtime.ts`          | #246 |
| Barrel                            | `src/main/planning-pipeline/index.ts`            | #246 |

### Stage-transition triggers

| Trigger              | File                                                                  | Transition                           | Task |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------ | ---- |
| prd-to-epic          | `src/main/planning-pipeline/triggers/prd-to-epic-trigger.ts`          | `prd-finalized → epic-decomposed`    | #247 |
| tasks-agent-ready    | `src/main/planning-pipeline/triggers/tasks-agent-ready-trigger.ts`    | `epic-decomposed → tasks-decomposed` | #248 |
| agent-ready-claim    | `src/main/planning-pipeline/triggers/agent-ready-claim-trigger.ts`    | `* → agent-ready`                    | #249 |
| pr-quality-gate      | `src/main/planning-pipeline/triggers/pr-quality-gate-trigger.ts`      | `runner-active → needs-review`       | #250 |
| review-runner        | `src/main/planning-pipeline/triggers/review-runner-trigger.ts`        | `* → needs-review`                   | #251 |
| serialized-merge     | `src/main/planning-pipeline/triggers/serialized-merge-trigger.ts`     | `review-approved → fork-merged`      | #252 |
| doc-gap-auto-promote | `src/main/planning-pipeline/triggers/doc-gap-auto-promote-trigger.ts` | `workGraph.item.created` (doc-gap)   | #257 |
| Trigger barrel       | `src/main/planning-pipeline/triggers/index.ts`                        | —                                    | —    |

### Heartbeat supervisor

| Component          | File                                                          | Task |
| ------------------ | ------------------------------------------------------------- | ---- |
| Supervisor types   | `src/main/planning-pipeline/heartbeat/supervisor-types.ts`    | #253 |
| PipelineSupervisor | `src/main/planning-pipeline/heartbeat/pipeline-supervisor.ts` | #253 |
| Barrel             | `src/main/planning-pipeline/heartbeat/index.ts`               | #253 |

`PipelineSupervisor.tick()` is called on a timer by the consumer. Each tick fetches all in-flight items, finds those with expired claims, force-releases them, and either retries (up to `maxRetries`, default 2) or dead-letters.

### Hygiene: stray-file detector

| Component         | File                                                        | Task |
| ----------------- | ----------------------------------------------------------- | ---- |
| StrayFileDetector | `src/main/planning-pipeline/hygiene/stray-file-detector.ts` | #254 |

Detects worktree contamination before merge. Injectable `runGit` dep; accepts string and RegExp allowlist entries. `assertNoStrayFiles()` throws when stray files are found.

### Safety: fork-only guard

| Component       | File                                                   | Task |
| --------------- | ------------------------------------------------------ | ---- |
| Fork-only guard | `src/main/planning-pipeline/safety/fork-only-guard.ts` | #255 |

Thin wrapper around `src/shared/fork-only-github.ts`. Provides `assertForkOnlyOperation({ repo })` and `assertForkOnlyOperation({ ghArgs })` call forms. Any pipeline operation that pushes, opens a PR, or comments on a remote MUST call this guard first.

### CCPM stage mirror

| Component        | File                                                           | Task |
| ---------------- | -------------------------------------------------------------- | ---- |
| Mirror types     | `src/main/planning-pipeline/ccpm-mirror/stage-mirror-types.ts` | #256 |
| Mirror functions | `src/main/planning-pipeline/ccpm-mirror/stage-mirror.ts`       | #256 |
| Barrel           | `src/main/planning-pipeline/ccpm-mirror/index.ts`              | #256 |

`appendStageTransition()` and `appendRetryEvent()` write audit entries to the CCPM mirror. Both accept a `StageMirrorDeps` injection so they can be tested without a real DB.

### SLA tracking + notifications + restart recovery

| Component            | File                                                     | Task |
| -------------------- | -------------------------------------------------------- | ---- |
| SLA types            | `src/main/planning-pipeline/sla/sla-types.ts`            | #259 |
| SlaTracker           | `src/main/planning-pipeline/sla/sla-tracker.ts`          | #259 |
| SlaBreachNotifier    | `src/main/planning-pipeline/sla/notification-emitter.ts` | #259 |
| recoverPipelineState | `src/main/planning-pipeline/sla/restart-recovery.ts`     | #259 |
| Barrel               | `src/main/planning-pipeline/sla/index.ts`                | #259 |

`SlaTracker` is in-memory. Feed it `PipelineStageEvent`s; call `findBreaches(now)` to get all items over threshold. `SlaBreachNotifier` wraps `SlaTracker` and routes breaches to channels (`console | webhook | ipc`). `recoverPipelineState()` reconciles in-flight items after a Maestro restart.

---

## File-by-file index

```
src/shared/
  planning-pipeline-types.ts       Stage enums, transition tables, label map,
                                   isValidTransition(), InvalidPipelineTransitionError
  planning-pipeline-guards.ts      isPipelineLabel(), detectCurrentStage(),
                                   planStageTransition(), applyStageTransition()

src/main/planning-pipeline/
  index.ts                         Barrel (bus, registry, dispatcher, runtime)
  event-bus.ts                     PipelineEventBus — subscribe/publish, async handler chain
  trigger-registry.ts              PipelineTriggerRegistry — register/unregister/dispatch
  dispatcher.ts                    PipelineDispatcher — start/stop subscription wiring
  runtime.ts                       createPipelineRuntime() — factory for all three primitives

  triggers/
    index.ts                       Barrel re-exports for all triggers
    prd-to-epic-trigger.ts         prd-finalized → epic-decomposed (calls planner.convertPrdToEpic)
    tasks-agent-ready-trigger.ts   epic-decomposed → tasks-decomposed (tags unblocked tasks agent-ready)
    agent-ready-claim-trigger.ts   * → agent-ready (calls dispatchEngine.runAutoPickup)
    pr-quality-gate-trigger.ts     runner-active → needs-review (runs QualityGateChecker)
    review-runner-trigger.ts       * → needs-review (launches ReviewerLauncher)
    serialized-merge-trigger.ts    review-approved → fork-merged (serialized MergeRunner chain)
    doc-gap-auto-promote-trigger.ts workGraph.item.created (living-wiki-doc-gap) → planner task

  heartbeat/
    supervisor-types.ts            InFlightClaim, InFlightWorkItem, PipelineSupervisorDeps
    pipeline-supervisor.ts         PipelineSupervisor.tick() — expired-claim watchdog
    index.ts                       Barrel

  hygiene/
    stray-file-detector.ts         detectStrayFiles(), assertNoStrayFiles()

  safety/
    fork-only-guard.ts             assertForkOnlyOperation({ repo | ghArgs })

  ccpm-mirror/
    stage-mirror-types.ts          StageTransitionEntry, StageTransitionActor
    stage-mirror.ts                appendStageTransition(), appendRetryEvent()
    index.ts                       Barrel

  sla/
    sla-types.ts                   StageDuration, SlaConfig, SlaBreach
    sla-tracker.ts                 SlaTracker — in-memory duration tracking + findBreaches()
    notification-emitter.ts        SlaBreachNotifier — routes breaches to channels
    restart-recovery.ts            recoverPipelineState() — reconciles in-flight on boot
    index.ts                       Barrel

src/__tests__/
  shared/
    planning-pipeline-types.test.ts
    planning-pipeline-guards.test.ts
  main/planning-pipeline/
    event-bus.test.ts
    trigger-registry.test.ts
    dispatcher.test.ts
    runtime.test.ts
    triggers/
      prd-to-epic-trigger.test.ts
      tasks-agent-ready-trigger.test.ts
      agent-ready-claim-trigger.test.ts
      pr-quality-gate-trigger.test.ts
      review-runner-trigger.test.ts
      serialized-merge-trigger.test.ts
      doc-gap-auto-promote-trigger.test.ts
    heartbeat/
      pipeline-supervisor.test.ts
    hygiene/
      stray-file-detector.test.ts
    safety/
      fork-only-guard.test.ts
    ccpm-mirror/
      stage-mirror.test.ts
    sla/
      sla-tracker.test.ts
      notification-emitter.test.ts
      restart-recovery.test.ts
  integration/
    planning-pipeline-smoke.integration.test.ts
```

---

## How a transition flows end-to-end

```
Caller
  │
  ├─ 1. planStageTransition(currentLabels, targetStage)
  │       ↳ guards.ts: validates from→to against PIPELINE_TRANSITIONS
  │       ↳ returns { add, remove } label-mutation plan
  │
  ├─ 2. Apply plan to GitHub issue/PR labels (external I/O, caller's responsibility)
  │
  └─ 3. bus.publish({ workItemId, fromStage, toStage, actor, occurredAt })
          ↓
          PipelineEventBus — calls all subscribers sequentially, awaits each
          ↓
          PipelineDispatcher.start() subscription (one subscriber)
          ↓
          PipelineTriggerRegistry.dispatch(event)
          ↓
          Looks up handlers for buildTriggerKey(event.fromStage, event.toStage)
          ↓
          Runs matched TriggerHandlers in registration order
              e.g. prd-finalized→epic-decomposed → createPrdToEpicTrigger
                   runner-active→needs-review     → createPrQualityGateTrigger
                                                  → createReviewRunnerTrigger (2nd handler)
```

All handler errors are caught and logged. No error prevents subsequent handlers from running or causes `bus.publish()` to reject.

---

## How to add a new stage

1. **Extend `PIPELINE_STAGES`** in `src/shared/planning-pipeline-types.ts` (or `PIPELINE_FAILURE_STAGES` for a failure-loop stage).
2. **Add edge(s) to `PIPELINE_TRANSITIONS`** (or `PIPELINE_FAILURE_TRANSITIONS`).
3. **Add label entry to `PIPELINE_LABEL_BY_STAGE`** with a `pipeline:` prefix.
4. **Write a guard test** in `src/__tests__/shared/planning-pipeline-types.test.ts` covering the new edge and any new rejection cases.
5. **Create a trigger handler** under `src/main/planning-pipeline/triggers/` using the factory + registration helper pattern (see `prd-to-epic-trigger.ts` as the canonical template).
6. **Register the trigger** by calling `registerXxxTrigger(registry, deps)` at application startup.
7. **Export from trigger barrel** (`triggers/index.ts`).
8. **Add unit tests** for the trigger factory covering happy path, guard no-op, dep errors swallowed, and registration helper.

---

## Validation steps

Run after any change to this subsystem:

```bash
# Type-check shared contracts and main-process code
npx tsc -p tsconfig.lint.json --noEmit
npx tsc -p tsconfig.main.json --noEmit

# Unit tests: shared types + guards
npm run audit:pipeline-types

# Unit tests: runtime primitives (bus, registry, dispatcher, runtime factory)
npm run audit:pipeline-runtime

# Unit tests: all trigger handlers + subsystems
npm run audit:pipeline-triggers

# Full pipeline suite (all of the above in sequence)
npm run audit:pipeline-all

# End-to-end smoke (full PRD-to-merge journey with stubs)
npx vitest run src/__tests__/integration/planning-pipeline-smoke.integration.test.ts
```

Manual smoke sequence (requires a running Maestro instance):

1. Create a PRD via `/plan`; finalize. Confirm epic auto-decomposes (`pipeline:epic-decomposed` label appears).
2. Confirm root tasks auto-tag `agent-ready` in the dashboard.
3. Trigger a runner claim; let it push a fork PR; observe `pipeline:runner-active`.
4. Watch quality gate fire (`pipeline:needs-review`) and review agent launch.
5. Approve the review runner output; observe `pipeline:review-approved` → serialized merge → `pipeline:fork-merged`.
6. Restart Maestro mid-claim; observe `recoverPipelineState()` reconciles correctly.
7. Force a stall; observe retry then dead-letter after max retries.
8. Attempt an upstream PR target; observe fork-only guard rejection.

---

## Open work items

| Item                                          | Status      | Notes                                                                                                                    |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| doc-gap-auto-promote requires settings wiring | Blocked     | The `DocGapAutoPromoteDeps.plannerService` needs to be wired to a real `DeliveryPlannerService` instance at app startup. |
| SLA thresholds config UI                      | Not started | `SlaConfig.thresholdsMs` is hardcoded at wiring time; a settings panel should allow per-stage overrides.                 |
| `QualityGateChecker` concrete implementation  | Not started | Currently a stub interface; a future task wires `tsc --noEmit` + conflict-marker grep + ESLint invocations.              |
| `MergeRunner` concrete implementation         | Not started | Interface is defined; a future task wires `gh pr merge` + base-drift checks.                                             |
| `ReviewerLauncher` concrete implementation    | Not started | Interface is defined; a future task wires to `agent-spawner.ts` / dispatch engine.                                       |
| Dashboard wiring (#258)                       | In flight   | Pipeline stage events need to be surfaced in the dashboard IPC layer.                                                    |
