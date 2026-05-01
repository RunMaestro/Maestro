# CLAUDE-PLANNING-PIPELINE.md

Agent-facing architecture reference for the Planning Pipeline epic (#243). Read this before touching anything under `src/main/planning-pipeline/` or `src/shared/planning-pipeline-*.ts`.

> **v2 simpler model (post-#429/#430):** trigger handlers, SLA tracking, heartbeat supervisor, and hygiene modules were deleted per #433. The pipeline is now simpler — just stage vocabulary, guards, and dashboard views. See issue #425 rollout tracker for status.

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

### Safety: fork-only guard

| Component       | File                                                   | Task |
| --------------- | ------------------------------------------------------ | ---- |
| Fork-only guard | `src/main/planning-pipeline/safety/fork-only-guard.ts` | #255 |

Thin wrapper around `src/shared/fork-only-github.ts`. Provides `assertForkOnlyOperation({ repo })` and `assertForkOnlyOperation({ ghArgs })` call forms. Any pipeline operation that pushes, opens a PR, or comments on a remote MUST call this guard first.

### External mirror stage audit

| Component        | File                                                               | Task |
| ---------------- | ------------------------------------------------------------------ | ---- |
| Mirror types     | `src/main/planning-pipeline/external-mirror/stage-mirror-types.ts` | #256 |
| Mirror functions | `src/main/planning-pipeline/external-mirror/stage-mirror.ts`       | #256 |
| Barrel           | `src/main/planning-pipeline/external-mirror/index.ts`              | #256 |

`appendStageTransition()` and `appendRetryEvent()` write audit entries to the external mirror. Both accept a `StageMirrorDeps` injection so they can be tested without a real DB. The directory was renamed from `ccpm-mirror/` to `external-mirror/` in issue #411.

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

  safety/
    fork-only-guard.ts             assertForkOnlyOperation({ repo | ghArgs })

  external-mirror/
    stage-mirror-types.ts          StageTransitionEntry, StageTransitionActor
    stage-mirror.ts                appendStageTransition(), appendRetryEvent()
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
    safety/
      fork-only-guard.test.ts
    external-mirror/
      stage-mirror.test.ts
  integration/
    planning-pipeline-smoke.integration.test.ts
```

---

## Stage Transitions

Transitions are guarded by the `planStageTransition()` function in `src/shared/planning-pipeline-guards.ts`, which validates from→to edges against `PIPELINE_TRANSITIONS` and returns a `{ add, remove }` label-mutation plan. Callers apply this plan to GitHub issue/PR labels.

---

## How to add a new stage

1. **Extend `PIPELINE_STAGES`** in `src/shared/planning-pipeline-types.ts` (or `PIPELINE_FAILURE_STAGES` for a failure-loop stage).
2. **Add edge(s) to `PIPELINE_TRANSITIONS`** (or `PIPELINE_FAILURE_TRANSITIONS`).
3. **Add label entry to `PIPELINE_LABEL_BY_STAGE`** with a `pipeline:` prefix.
4. **Write a guard test** in `src/__tests__/shared/planning-pipeline-types.test.ts` covering the new edge and any new rejection cases.

---

## Validation steps

Run after any change to this subsystem:

```bash
# Type-check shared contracts and main-process code
npx tsc -p tsconfig.lint.json --noEmit
npx tsc -p tsconfig.main.json --noEmit

# Unit tests: shared types + guards
npm run audit:pipeline-types

# TypeScript + ESLint
npm run lint
npm run lint:eslint

# Full test suite
npm run test
```

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
