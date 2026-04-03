# Phase 04-A: Consolidate formatDuration Definitions

## Objective

Replace 22 local `formatDuration` definitions with the canonical implementation in `src/shared/formatters.ts`. This is the single highest-count formatter duplication in the codebase.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatDuration / formatElapsed / formatTime definitions"
**Risk:** Low - pure formatting functions with identical behavior. Verify output matches for each site.
**Estimated savings:** ~210 lines

---

## Pre-flight Checks

- [x] Phase 03 (test mocks) is complete
- [x] `rtk npm run lint` passes
- [x] `rtk vitest run` passes

---

## Important Context

Two canonical implementations exist:

1. `src/shared/formatters.ts:144` - `formatElapsedTime(seconds)` - takes seconds, returns "Xm Ys" format
2. `src/shared/performance-metrics.ts:336` - `formatDuration(ms)` - takes milliseconds, returns "X.Xs" format

Most local definitions take **seconds** and return human-readable strings like "1h 23m" or "5m 30s". The canonical `formatElapsedTime` in `shared/formatters.ts` is the correct replacement for most.

---

## Tasks

### Task 1: Read and understand the canonical implementations

- [x] Read `src/shared/formatters.ts` around line 144 - document `formatElapsedTime` signature and output format
- [x] Read `src/shared/performance-metrics.ts` around line 336 - document `formatDuration` signature and output format
- [x] Note: `formatElapsedTime(seconds)` returns "Xm Ys"; `formatDuration(ms)` returns "X.Xs"

> **Note:** `formatElapsedTime` actually takes **milliseconds** (not seconds as documented above). Signature: `formatElapsedTime(ms: number): string` - returns "Xms"/"Xs"/"Xm Ys"/"Xh Ym".

### Task 2: Inventory all 22 local definitions

- [x] Find all definitions: `rtk grep "function formatDuration\|const formatDuration\|function formatElapsed\|const formatElapsed\|function formatTime\b" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "performance-metrics" | rtk grep -v "__tests__"`
- [x] For each, note: input type (seconds vs ms), output format, whether it matches canonical

> **Note:** Found 26+ local definitions across 6 distinct output format patterns. All take ms, not seconds. Added 5 new shared variants to shared/formatters.ts to cover all patterns.

### Task 3: Consolidate UsageDashboard (9 copies - biggest win)

For each of the 9 files in `src/renderer/components/UsageDashboard/`:

- [x] Remove the local `formatDuration` function
- [x] Add: `import { formatElapsedTime as formatDuration } from '../../../shared/formatters';` (or direct name if signatures match)
- [x] Verify output format matches the local definition it replaced
- [x] Run tests: `rtk vitest run src/__tests__/renderer/components/UsageDashboard/`

> **Note:** Actually 11 files in UsageDashboard had local definitions (not 9). PeakHoursChart used compact format (no seconds in minute range) so it imports `formatDurationCompact` instead. All other 10 use `formatElapsedTime`.

### Task 4: Consolidate renderer component files

- [x] Read and replace local `formatDuration` in `AboutModal.tsx` with import from `shared/formatters`
- [x] Read and replace local `formatDuration` in `FirstRunCelebration.tsx` with import from `shared/formatters`
- [x] Read and replace local `formatDuration` in `SymphonyModal.tsx` with import from `shared/formatters`
- [x] Read and replace local `formatDuration` in `Toast.tsx` with import from `shared/formatters`

> **Note:** Each had a unique output format - AboutModal uses `formatElapsedTime`, FirstRunCelebration uses `formatDurationVerbose` (full words), SymphonyModal uses `formatDurationCompact`, Toast uses `formatDurationParts` (with days support).

### Task 5: Consolidate hook and utility files

- [x] Read and replace local `formatDuration` in `AIOverviewTab.tsx` with import from `shared/formatters`
- [x] Read and replace local `formatDuration` in `useContributorStats.ts` with import from `shared/formatters`

### Task 6: Consolidate main process files

- [x] Read and replace local `formatDuration` in `groupChatExport.ts` with import from `shared/formatters`
- [x] Read and replace local `formatDuration` in `tabExport.ts` with import from `shared/formatters`

> **Note:** These take arrays (not ms), so the local function was refactored to compute ms from timestamps then delegate to `formatDurationCompact`.

### Task 7: Consolidate CLI files

- [x] Read and replace 2 local `formatDuration` definitions in `cli/output/formatter.ts` with import from `shared/formatters`

> **Note:** CLI uses decimal format ("5.2m"), so it imports `formatDurationDecimal` and `formatDurationSecondsDecimal`.

### Task 8: Handle CueModal/cueModalUtils.ts

- [x] Read local `formatDuration` in `CueModal/cueModalUtils.ts:25` to determine if it takes seconds or milliseconds
- [x] If seconds: replace with import of `formatElapsedTime` from `shared/formatters`
- [x] If milliseconds: replace with import of `formatDuration` from `performance-metrics.ts`
- [x] **CAUTION:** Cue is under active development - verify signature matches before replacing

> **Note:** Takes ms. Replaced with re-export: `export const formatDuration = formatElapsedTime`. The `formatElapsed` wrapper function was kept since it's domain-specific (parses date string).

### Task 9: Verify all replacements produce identical output

- [x] For any definition where input/output format differed from canonical, create a thin wrapper or add a variant to `shared/formatters.ts`
- [x] Ensure no call site has changed output behavior

> **Note:** Added 5 new variants to `shared/formatters.ts`: `formatDurationCompact`, `formatDurationVerbose`, `formatDurationParts`, `formatDurationDecimal`, `formatDurationSecondsDecimal`. Also handled 4 additional files not in original scope: MergeProgressOverlay, SummarizeProgressOverlay, TransferProgressModal, RightPanel, and web/mobile/CuePanel.tsx.

### Task 10: Run full verification

- [x] Run lint: `rtk npm run lint`
- [x] Find related test files: `rtk grep "formatDuration\|formatElapsed" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [x] Run related tests: `rtk vitest run <related-test-files>`
- [x] Confirm zero new test failures

> **Note:** Both `tsc` configs pass. All 490 related tests pass (formatters: 146, HistoryPanel/AboutModal/etc: 344).

### Task 11: Verify no orphaned definitions remain

- [x] Check: `rtk grep "function formatDuration\|const formatDuration" src/ --glob "*.{ts,tsx}" | rtk grep -v "shared/formatters" | rtk grep -v "performance-metrics" | rtk grep -v "__tests__"`
- [x] Result should be 0

> **Note:** Remaining definitions are all import aliases (e.g., `const formatDuration = formatElapsedTime`) or domain-specific wrappers (tabExport/groupChatExport) that delegate to shared formatters. No self-contained local implementations remain.

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
