# Stage 02 - Test Foundation and Coverage Recovery

## Objective

Make the test suite a trustworthy safety net before behavior-bearing deduplication. Consolidate duplicated factories without hiding meaningful setup, remove unnecessary global mocks in controlled batches, and decide the fate of skipped E2E coverage.

## Priorities

- **43:** Migrate exact test session factories to canonical helpers.
- **45:** Trial removal of per-file Lucide mocks in representative batches.
- **106:** Consolidate deterministic `createMockGroup` test factories.
- **109:** Triage skipped E2E blocks into active coverage or deletion.

## Dependencies

Stages 00-01 complete.

## Invariants

- Test helpers represent public behavior, not implementation internals.
- Deterministic IDs, timestamps, and defaults remain explicit.
- A shared factory must allow per-test overrides without mutating shared objects.
- Removing mocks must not make tests depend on animation timing, network, native modules, or environment state.
- Skipped E2E tests are either restored with stable assertions or deleted with documented obsolete-contract proof.

## Priority 43 - Canonical session factories

1. Inventory every production-shaped session factory in tests.
2. Group only exact contract families: renderer session, agent session, batch/Auto Run session, and storage record must not be forced into one oversized factory.
3. Select the existing best canonical helper for each family.
4. Add typed override support with fresh nested objects/arrays per invocation.
5. Add contract tests for deterministic defaults, override precedence, and mutation isolation.
6. Migrate one suite and run it before batch migration.
7. Migrate remaining exact copies; retain local builders where the fixture intentionally models a distinct state.
8. Remove local copies after references reach zero.

Proof: focused suites pass before and after; snapshots and ordering are unchanged.

## Priority 106 - `createMockGroup`

1. Locate every `createMockGroup` declaration and compare returned fields/defaults.
2. Separate truly deterministic group fixtures from scenario builders that encode different membership or timestamps.
3. Place one canonical helper beside existing shared test helpers, not in production code.
4. Return a fresh object and fresh collections on every call.
5. Migrate callers incrementally and delete exact copies.
6. Verify group sorting, hierarchy, modal, and batch tests retain their original intent.

Proof: each migrated suite passes independently and no test depends on call order.

## Priority 45 - Lucide mock removal trial

### Batch design

- Choose one simple component suite, one modal suite, and one large renderer suite.
- Record baseline duration, failures, snapshots, and DOM output.
- Remove only the per-file `vi.mock('lucide-react', ...)` block.
- Keep a central mock only if the real library causes a measured environment or performance problem.

### Decision

- If real icons work: remove per-file mocks in small batches and run each batch.
- If a central mock is needed: expose named icon components through one deterministic test setup preserving accessible labels and passthrough props.
- If a suite relies on an icon's exact SVG structure, rewrite the assertion around accessible behavior unless SVG structure is the actual product contract.

Proof: representative batches pass, runtime does not regress materially, and no new act/timer warnings appear.

## Priority 109 - Skipped E2E triage

For every skipped block:

1. Identify the user journey and current product owner.
2. Reproduce the current flow manually in Electron/web.
3. Classify as `valid but flaky`, `blocked environment`, `obsolete`, `duplicate coverage`, or `unknown`.
4. Valid tests: replace sleeps with observable readiness, stable roles, URL/IPC response waits, and isolated data.
5. Blocked tests: create an explicit environment capability guard and tracking issue; do not leave an unexplained skip.
6. Obsolete tests: prove the feature/contract was removed, then delete the test and associated fixture/page object.
7. Duplicate tests: retain the stronger journey and document why the duplicate adds no boundary coverage.

Proof: active E2E blocks pass repeatedly; remaining skips have a named external prerequisite and owner.

## Verification matrix

| Area                  | Focused proof                                             |
| --------------------- | --------------------------------------------------------- |
| Session factories     | Determinism, override precedence, mutation isolation      |
| Group factories       | Fresh nested data, sorting/hierarchy suites               |
| Lucide mocks          | Representative simple/modal/large suites                  |
| E2E                   | At least three repeated runs for recovered flaky journeys |
| Full test integration | Existing unit/integration suite has no new failures       |

## Rollback

Factory migrations can revert per suite. Do not revert the canonical helper while migrated suites still import it. E2E recovery commits should be isolated per journey.

## Exit criteria

- Priorities 43, 45, 106, and 109 have recorded dispositions.
- Exact factory copies are removed or intentionally retained with contract differences documented.
- Lucide policy is centralized or mocks are removed.
- Every skipped E2E block has an explicit disposition.
- Later stages have reliable characterization-test infrastructure.

## Investigated execution cards

| Priority | Observed locations and decision                                                                                                                                                                                                   | Ordered edit and exact proof                                                                                                                                                                                                                                                 | Acceptance / rollback                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 43       | Canonical helpers are `src/__tests__/helpers/mockSession.ts` and `mockTab.ts`; wrappers/copies occur in 20+ renderer suites, with a full local session body in `ThinkingStatusPill.test.tsx`. Keep path-sensitive fixtures local. | Add typed deterministic overrides and isolation tests to the canonical helpers; migrate `ThinkingStatusPill.test.tsx` first, then exact wrappers. Run `bun run test -- src/__tests__/renderer/components/ThinkingStatusPill.test.tsx src/__tests__/helpers`.                 | All migrated suites keep assertions and no object leaks between tests. Revert one suite migration without reverting the helper.                  |
| 45       | Dozens of local `vi.mock('lucide-react', ...)` blocks duplicate the Proxy mock in `src/__tests__/setup.ts`; some local mocks add test IDs/markup.                                                                                 | Trial one simple, modal, and large renderer suite; remove the local mock, replace mock-markup assertions with accessible behavior, then batch only passing files. Run each selected path with `bun run test -- <path>` and finally `bun run test -- src/__tests__/renderer`. | No SVG/mock-specific dependency, act warning, or material runtime increase. Restore only the local mock if the suite proves a distinct contract. |
| 106      | Identical four-field `createMockGroup` factories appear in eleven named files: `src/__tests__/integration/{AutoRunSessionList,GoalDrivenAutoRun}.test.tsx`, seven renderer component/hook suites, and `sessionStore.test.ts`.     | Add `src/__tests__/helpers/mockGroup.ts`; test fresh objects and deterministic defaults; migrate the eleven files listed in `dedup-report.md:2128-2140`; run them together with `bun run test -- <all eleven paths>`.                                                        | Zero local exact factories and no cross-test coupling. Revert per migrated suite.                                                                |
| 109      | About 34 skipped cases and roughly 600 lines reside in `e2e/autorun-{batch,editing,sessions,setup}.spec.ts` and `e2e/plugins.spec.ts`.                                                                                            | Map each skip to current selectors/behavior; unskip with readiness-based waits, delete only obsolete/equivalent cases, and give environment-blocked cases a named guard/issue. Run `bun run test:e2e -- <spec>` three times per restored spec.                               | Every skip has active coverage, proven deletion, or external blocker. Revert per journey, never by re-adding an unexplained skip.                |
