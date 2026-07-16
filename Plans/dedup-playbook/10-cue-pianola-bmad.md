# Stage 10 - Cue, Pianola, Debug Package, and BMAD

## Objective

Consolidate domain-local orchestration and defaults without creating cross-domain abstractions or altering execution semantics.

## Priorities

**3, 22, 44, 52, 53, 81, 84, 90, 100**

## Dependencies

Stages 02, 04, and 05 complete. Priority 120 from Stage 04 should land before other Cue repository edits.

## Priority playbooks

### 3 - Pianola gate, polling gate, interval parser

Characterize enable/disable, interval units/bounds, initial run, timer ownership, overlap prevention, cancellation, and persistence. Extract a single interval parser and compatible gate state machine only if behavior matches. Test fake-timer transitions, invalid interval, disable during run, and repeated start. Keep domain-specific actions outside.

### 22 - Pianola/release decomposition reassessment

After priority 3 and Stage 03 land, re-measure module size and responsibility boundaries. Split only cohesive units with independent tests and stable interfaces. Do not split for line count alone. Record `retain` if remaining orchestration is clearer together.

### 44 - Cue executor session factory

Migrate the local production/test session factory copy to the canonical helper established in Stage 02 or an appropriate production builder. Compare every field and timestamp/ID policy. Preserve fresh nested state. Remove the local copy after execution tests pass.

### 52 - Cue YAML mutation contract

Inventory create/update/delete/reorder mutation paths, comment preservation, schema validation, path containment, atomic writes, backup, and notification. Define one typed mutation service operating on validated documents. Add fixtures for comments, unknown keys, malformed YAML, concurrent edits, and write failure. Migrate operations incrementally.

### 53 - Cue query session traversal

Compare query paths for graph/session traversal, ordering, disabled nodes, cycles, missing references, and result limits. Extract a pure traversal function with explicit inputs. Add graph fixtures for linear, branch, cycle, missing node, and empty cases.

### 81 - `DEFAULT_CUE_SETTINGS`

Replace fallback literals only after field-by-field parity proof. Import canonical defaults without creating runtime cycles. Add a test that every fallback path equals the canonical setting and that explicit configuration wins.

### 84 - Archive stream helper

Compare ZIP/archive response headers, stream error handling, abort, cleanup, filename encoding, and backpressure. Extract only if contracts match. Test success, empty archive, source error, client abort, invalid name, and cleanup. `retain` is valid if security/transport policies differ.

### 90 - Debug package `collectCategory`

Identify repeated orchestration around category collection while keeping category-specific collectors explicit. Extract sequencing/error aggregation/metadata only. Test partial collector failure, empty category, cancellation, deterministic order, and output manifest.

### 100 - BMAD/spec-manager factory

Compare BMAD, SpecKit, and OpenSpec storage/loading/updating contracts. Extend the existing spec-manager factory only for shared filesystem/schema mechanics. Keep bundle sources, prompt semantics, versioning, and user customization policies explicit. Add per-manager golden fixtures and update/rollback tests.

## Verification

- Cue YAML round-trip fixtures preserve comments and unknown supported content.
- Fake-timer Pianola tests prove no overlap/leak.
- Cue execution/session tests pass.
- Archive tests verify cleanup and abort.
- Debug package output is deterministic.
- BMAD/SpecKit/OpenSpec refresh and customization smoke each pass.

## Rollback

YAML and manager changes retain backups/read-old behavior until verified. Timer/gate changes revert as a unit. Do not partially revert factory internals while callers depend on them.

## Exit criteria

All nine priorities are implemented, retained, or rejected with evidence; Cue mutations are singular and safe; Pianola timers have one owner; BMAD common mechanics use the factory without erasing domain policy.

## Investigated execution cards

|   P | Observed source                                                                                                                                                                                   | Chosen edit sequence                                                                                                                         | Exact proof / rollback                                                                                                          |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
|   3 | `ensurePianolaEnabled` and polling/interval handling repeat across `src/cli/commands/pianola.ts`, `pianola-orchestrate.ts`, `pianola-learn.ts`, `pianola-profile.ts`, and `pianola-supervise.ts`. | Extract CLI-local gate and interval parser after command characterization; migrate read-only/profile commands before orchestrate/supervise.  | Pianola CLI subprocess tests for invalid interval, disabled, overlap, cancel; fake timers. Revert command family independently. |
|  22 | Large Pianola orchestration and `.github/workflows/release.yml` were structural hotspots; P3/P28 may remove much of the pressure.                                                                 | Re-measure after those land; split only cohesive scheduler/execution/release units with independent contracts; otherwise mark retain.        | Module metrics plus existing Pianola/release matrix; no line-count-only split.                                                  |
|  44 | `cue-executor.test.ts` defines `createMockSession` equivalent to `cue-test-helpers.ts`; other Cue tests import the helper.                                                                        | Import canonical helper, preserve overrides, delete local factory.                                                                           | `bun run test -- src/__tests__/main/cue/cue-executor.test.ts` and Cue suite. Single-file rollback.                              |
|  52 | Cue YAML mutation logic is split between `cue-engine.ts`, `cue-self-destruct.ts`, and config/repository paths for create/update/delete.                                                           | Add one typed config mutation service preserving comments/backup/atomicity; migrate update, delete, self-destruct in that order.             | Cue YAML golden fixtures for comments, unknown keys, malformed/concurrent/write failure. Restore backup on rollback.            |
|  53 | `src/main/cue/cue-query-service.ts::getStatus` and `getGraphData` repeat session/graph traversal.                                                                                                 | Extract pure traversal with ordering/cycle/missing-node contract; migrate status then graph.                                                 | Query-service graph fixtures for linear/branch/cycle/missing/disabled.                                                          |
|  81 | `cue-run-manager.ts:816-818` and other fallbacks duplicate values from `src/shared/cue/contracts.ts::DEFAULT_CUE_SETTINGS`.                                                                       | Add parity test; import canonical defaults at each fallback; remove literals.                                                                | Cue run/config tests for absent versus explicit config. Revert import if cycle appears.                                         |
|  84 | Archive stream mechanics repeat in Cue/debug/download handlers but may differ in headers/abort/security.                                                                                          | Build contract matrix; extract main-local stream helper only for identical ZIP response policy.                                              | Archive tests for success/empty/error/client abort/name encoding/cleanup. Mark retain if policies differ.                       |
|  90 | `src/main/debug-package/index.ts::generateDebugPackage` repeats per-category try/collect/record `filesIncluded` around `collectCategory`.                                                         | Extract orchestration accepting named collector; keep collectors explicit; migrate categories one by one.                                    | Debug-package tests for partial failure, deterministic order, cancellation, manifest.                                           |
| 100 | `src/main/spec-command-manager.ts::createSpecCommandManager` is used alongside custom storage/loading in `src/main/bmad-manager.ts`.                                                              | Move BMAD compatible load/store/update mechanics into factory hooks; preserve BMAD sources/customization; migrate reads then writes/refresh. | BMAD/SpecKit/OpenSpec fixture and refresh/customization tests. Revert BMAD factory adapter as one unit.                         |
