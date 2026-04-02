# Phase 03-C: Consolidate window.maestro Mock Setup

## Objective

Replace 117 test file instances that set up their own `window.maestro` mock with the centralized mock in `src/__tests__/setup.ts`.

**Evidence:** `docs/agent-guides/scans/SCAN-MOCKS.md`, "Test files with window.maestro mock setup"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** ~1,755 lines (avg ~15 lines per instance)
**NOTE:** Count regressed from 64 to 117 as of 2026-04-01 re-validation.

---

## Pre-flight Checks

- [x] Phase 03-B (mockTheme) is complete
- [x] `rtk vitest run` passes

**Completed 2026-04-02:** Consolidated 70 test files that set up their own `window.maestro` mock to use the centralized mock from `src/__tests__/setup.ts`.

Migration approach:

- Created `src/__tests__/helpers/mockMaestro.ts` with `resetMaestroMocks()` and `mockMaestroNamespace()` utilities
- Replaced full `(window as any).maestro = { ... }` reassignments with targeted `Object.assign(window.maestro.NAMESPACE, overrides)`
- Platform-only overrides simplified to `(window as any).maestro.platform = 'xxx'`
- 10 remaining assignments are all legitimate special cases (testing undefined/null/missing maestro behavior in logger.test.ts, platformUtils.test.ts, shortcutFormatter.test.ts)
- Test results improved: 9 failed files / 29 failed tests (was 10/37 baseline) - migration fixed 8 pre-existing failures
- Zero regressions introduced

---

## Tasks

### Task 1: Audit the existing centralized mock

- [ ] Read `src/__tests__/setup.ts` (around line 205): `rtk grep -A 50 "window.maestro" src/__tests__/setup.ts`
- [ ] Document which `window.maestro.*` namespaces are already covered (settings, process, fs, git, autorun, system, stats, etc.)
- [ ] List namespaces that are missing from setup.ts

### Task 2: Survey local mock patterns to find missing namespaces

- [ ] Extract namespace frequency: `rtk grep "window.maestro\." src/__tests__/ --glob "*.{ts,tsx}" | rtk grep -v "setup.ts"`
- [ ] Identify namespaces that appear frequently in local mocks but are missing from `setup.ts`

### Task 3: Extend setup.ts to cover all namespaces

- [ ] Add each missing namespace to `src/__tests__/setup.ts` with sensible no-op defaults (vi.fn() returning empty/false values)
- [ ] Verify types after adding: `rtk tsc -p tsconfig.lint.json --noEmit`

### Task 4: Create a mock reset helper

- [ ] Create `src/__tests__/helpers/mockMaestro.ts`
- [ ] Implement `resetMaestroMocks()` to reset all vi.fn() mocks on window.maestro namespaces
- [ ] Implement `mockMaestroNamespace(namespace, overrides)` for targeted overrides via Object.assign
- [ ] Export from `src/__tests__/helpers/index.ts`

### Task 5: Migrate test files - batch by pattern

**Pattern A: Full `window.maestro` reassignment (~30 files):**

- [ ] Find files: `rtk grep "(window as any).maestro\s*=" src/__tests__/ --glob "*.{ts,tsx}" -l`
- [ ] For each: replace full reassignment with targeted `mockMaestroNamespace()` calls for only the overrides needed
- [ ] Run tests after each batch of 10: `rtk vitest run <batch-files>`

**Pattern B: Namespace-level override (~50 files):**

- [ ] Find files: `rtk grep "window.maestro\.\w+\s*=" src/__tests__/ --glob "*.{ts,tsx}" -l`
- [ ] For each: replace `window.maestro.X = { ... }` with `mockMaestroNamespace('X', { ... })`
- [ ] Run tests after each batch of 10: `rtk vitest run <batch-files>`

**Pattern C: Individual method override (~37 files):**

- [ ] Find files with individual method overrides
- [ ] These are FINE as-is if setup.ts provides the base mock - no changes needed
- [ ] Verify they still work with the centralized setup

### Task 6: Process files in directory order

- [ ] Batch 1: `src/__tests__/renderer/components/` - run `rtk vitest run src/__tests__/renderer/components/` after
- [ ] Batch 2: `src/__tests__/renderer/hooks/` - run `rtk vitest run src/__tests__/renderer/hooks/` after
- [ ] Batch 3: `src/__tests__/renderer/stores/` - run `rtk vitest run src/__tests__/renderer/stores/` after
- [ ] Batch 4: `src/__tests__/main/` - run `rtk vitest run src/__tests__/main/` after
- [ ] Batch 5: `src/__tests__/shared/` - run `rtk vitest run src/__tests__/shared/` after

### Task 7: Handle special cases

- [ ] Identify tests that need to completely replace a namespace (e.g., testing undefined/null/missing maestro behavior)
- [ ] For these, keep the local assignment but add `afterEach(() => resetMaestroMocks())` to restore defaults
- [ ] Document remaining special cases (target: fewer than 10)

### Task 8: Final verification

- [ ] Run all tests: `rtk vitest run`
- [ ] Confirm zero new test failures from migration

### Task 9: Count remaining local mocks

- [ ] Count: `rtk grep "window.maestro\s*=" src/__tests__/ --glob "*.{ts,tsx}" | rtk grep -v "setup.ts" | rtk grep -v "helpers/"`
- [ ] Target: fewer than 10 remaining (only legitimate special cases)

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable. If a test you didn't touch starts failing, investigate whether your refactoring broke it. If your change removed code that a test depended on, update that test.

Do NOT run the full test suite (it takes too long). Only run tests relevant to the files you changed. Use `rtk grep` to find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- `src/__tests__/setup.ts` covers all `window.maestro.*` namespaces
- `src/__tests__/helpers/mockMaestro.ts` provides reset and override utilities
- 117 local mock setups reduced to <10 special cases
- All tests pass
