# Phase 04-A: Consolidate formatDuration Definitions

## Objective

Replace 22 local `formatDuration` definitions with the canonical implementation in `src/shared/formatters.ts`. This is the single highest-count formatter duplication in the codebase.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatDuration / formatElapsed / formatTime definitions"
**Risk:** Low - pure formatting functions with identical behavior. Verify output matches for each site.
**Estimated savings:** ~210 lines

---

## Pre-flight Checks

- [ ] Phase 03 (test mocks) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Important Context

Two canonical implementations exist:

1. `src/shared/formatters.ts:144` - `formatElapsedTime(seconds)` - takes seconds, returns "Xm Ys" format
2. `src/shared/performance-metrics.ts:336` - `formatDuration(ms)` - takes milliseconds, returns "X.Xs" format

Most local definitions take **seconds** and return human-readable strings like "1h 23m" or "5m 30s". The canonical `formatElapsedTime` in `shared/formatters.ts` is the correct replacement for most.

---

## Tasks

### Task 1: Read and understand the canonical implementations

- [ ] Read `src/shared/formatters.ts` around line 144 - document `formatElapsedTime` signature and output format
- [ ] Read `src/shared/performance-metrics.ts` around line 336 - document `formatDuration` signature and output format
- [ ] Note: `formatElapsedTime(seconds)` returns "Xm Ys"; `formatDuration(ms)` returns "X.Xs"

### Task 2: Inventory all 22 local definitions

- [ ] Find all definitions: `rtk grep "function formatDuration\|const formatDuration\|function formatElapsed\|const formatElapsed\|function formatTime\b" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "performance-metrics" | rtk grep -v "__tests__"`
- [ ] For each, note: input type (seconds vs ms), output format, whether it matches canonical

### Task 3: Consolidate UsageDashboard (9 copies - biggest win)

For each of the 9 files in `src/renderer/components/UsageDashboard/`:

- [ ] Remove the local `formatDuration` function
- [ ] Add: `import { formatElapsedTime as formatDuration } from '../../../shared/formatters';` (or direct name if signatures match)
- [ ] Verify output format matches the local definition it replaced
- [ ] Run tests: `rtk vitest run src/__tests__/renderer/components/UsageDashboard/`

### Task 4: Consolidate renderer component files

- [ ] Read and replace local `formatDuration` in `AboutModal.tsx` with import from `shared/formatters`
- [ ] Read and replace local `formatDuration` in `FirstRunCelebration.tsx` with import from `shared/formatters`
- [ ] Read and replace local `formatDuration` in `SymphonyModal.tsx` with import from `shared/formatters`
- [ ] Read and replace local `formatDuration` in `Toast.tsx` with import from `shared/formatters`

### Task 5: Consolidate hook and utility files

- [ ] Read and replace local `formatDuration` in `AIOverviewTab.tsx` with import from `shared/formatters`
- [ ] Read and replace local `formatDuration` in `useContributorStats.ts` with import from `shared/formatters`

### Task 6: Consolidate main process files

- [ ] Read and replace local `formatDuration` in `groupChatExport.ts` with import from `shared/formatters`
- [ ] Read and replace local `formatDuration` in `tabExport.ts` with import from `shared/formatters`

### Task 7: Consolidate CLI files

- [ ] Read and replace 2 local `formatDuration` definitions in `cli/output/formatter.ts` with import from `shared/formatters`

### Task 8: Handle CueModal/cueModalUtils.ts

- [ ] Read local `formatDuration` in `CueModal/cueModalUtils.ts:25` to determine if it takes seconds or milliseconds
- [ ] If seconds: replace with import of `formatElapsedTime` from `shared/formatters`
- [ ] If milliseconds: replace with import of `formatDuration` from `performance-metrics.ts`
- [ ] **CAUTION:** Cue is under active development - verify signature matches before replacing

### Task 9: Verify all replacements produce identical output

- [ ] For any definition where input/output format differed from canonical, create a thin wrapper or add a variant to `shared/formatters.ts`
- [ ] Ensure no call site has changed output behavior

### Task 10: Run full verification

- [ ] Run lint: `rtk npm run lint`
- [ ] Find related test files: `rtk grep "formatDuration\|formatElapsed" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run related tests: `rtk vitest run <related-test-files>`
- [ ] Confirm zero new test failures

### Task 11: Verify no orphaned definitions remain

- [ ] Check: `rtk grep "function formatDuration\|const formatDuration" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "performance-metrics" | rtk grep -v "__tests__"`
- [ ] Result should be 0

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

- 22 local `formatDuration` definitions removed
- All usages import from `src/shared/formatters.ts` (or `performance-metrics.ts`)
- Output behavior unchanged for every call site
- `rtk npm run lint` passes
- `rtk vitest run` passes
