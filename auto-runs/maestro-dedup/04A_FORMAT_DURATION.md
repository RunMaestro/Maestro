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

Read:
- `src/shared/formatters.ts` around line 144 - `formatElapsedTime`
- `src/shared/performance-metrics.ts` around line 336 - `formatDuration`

Document the exact signature and output format of each.

### Task 2: Inventory all 22 local definitions

```
rtk grep "function formatDuration\|const formatDuration\|function formatElapsed\|const formatElapsed\|function formatTime\b" src/ --include="*.ts" --include="*.tsx" | grep -v "shared/formatters" | grep -v "performance-metrics" | grep -v "__tests__"
```

For each definition, note:
- Input type (seconds vs milliseconds)
- Output format
- Whether it exactly matches the canonical

### Task 3: Consolidate UsageDashboard (9 copies - biggest win)

These 9 files in `src/renderer/components/UsageDashboard/` all have identical `formatDuration`:

1. Open each file
2. Remove the local `formatDuration` function
3. Add: `import { formatElapsedTime as formatDuration } from '../../../shared/formatters';`
   (or use the direct name if signatures match)
4. Verify the output format matches

Run tests after: `rtk vitest run`

### Task 4: Consolidate renderer component files

Replace local definitions in:
- `AboutModal.tsx`
- `FirstRunCelebration.tsx`
- `SymphonyModal.tsx`
- `Toast.tsx`

For each:
1. Read the local definition to confirm it matches canonical
2. Remove local definition
3. Add import from `shared/formatters`

### Task 5: Consolidate hook and utility files

Replace local definitions in:
- `AIOverviewTab.tsx`
- `useContributorStats.ts`

### Task 6: Consolidate main process files

Replace local definitions in:
- `groupChatExport.ts`
- `tabExport.ts`

These are in the main process - they can import from `shared/formatters` (shared is accessible from both main and renderer).

### Task 7: Consolidate CLI files

Replace local definitions in:
- `cli/output/formatter.ts` (2 definitions)

### Task 8: Handle CueModal/cueModalUtils.ts

Replace the local `formatDuration` in `CueModal/cueModalUtils.ts:25`.

**CAUTION:** Cue is under active development. Verify the function signature matches before replacing. If it takes milliseconds instead of seconds, use `formatDuration` from `performance-metrics.ts` instead.

### Task 9: Verify all replacements produce identical output

For any definition where the input/output format differed from the canonical:
- Create a thin wrapper that adapts the canonical function
- Or add the variant to `shared/formatters.ts` as a named export

### Task 10: Run full verification

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 11: Verify no orphaned definitions remain

```
rtk grep "function formatDuration\|const formatDuration" src/ --include="*.ts" --include="*.tsx" | grep -v "shared/formatters" | grep -v "performance-metrics" | grep -v "__tests__"
```

Should return 0 results.

---

## Success Criteria

- 22 local `formatDuration` definitions removed
- All usages import from `src/shared/formatters.ts` (or `performance-metrics.ts`)
- Output behavior unchanged for every call site
- `rtk npm run lint` passes
- `rtk vitest run` passes
