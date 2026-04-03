# Phase 04-B: Consolidate formatElapsedTime Re-definitions

## Objective

Replace 5 redundant `formatElapsedTime` definitions with the canonical version in `src/shared/formatters.ts:144`.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatElapsed / formatElapsedTime re-definitions"
**Risk:** Very low - all 5 are identical implementations
**Estimated savings:** ~50 lines

---

## Pre-flight Checks

- [x] Phase 04-A (formatDuration) is complete
- [x] `rtk npm run lint` passes

---

## Tasks

### Task 1: Verify all 5 are identical to canonical

- [x] Read canonical: `src/shared/formatters.ts:144` - note signature and output format
- [x] Compare `MergeProgressModal.tsx:58` (skip if deleted in Phase 01) - SKIPPED: file deleted in Phase 01
- [x] Compare `MergeProgressOverlay.tsx:53` - already imports from shared/formatters (consolidated in Phase 04-A)
- [x] Compare `SummarizeProgressModal.tsx:57` (skip if deleted in Phase 01) - SKIPPED: file deleted in Phase 01
- [x] Compare `SummarizeProgressOverlay.tsx:51` - already imports from shared/formatters (consolidated in Phase 04-A)
- [x] Compare `TransferProgressModal.tsx:79` - already imports from shared/formatters (consolidated in Phase 04-A)
- [x] Confirm all remaining definitions are identical to canonical - no local definitions remain

### Task 2: Remove local definitions and add imports

For each file that still exists (some may have been deleted in Phase 01):

- [x] Remove local `formatElapsedTime` from `MergeProgressOverlay.tsx`, add import from `shared/formatters` - already done in Phase 04-A
- [x] Remove local `formatElapsedTime` from `SummarizeProgressOverlay.tsx`, add import from `shared/formatters` - already done in Phase 04-A
- [x] Remove local `formatElapsedTime` from `TransferProgressModal.tsx`, add import from `shared/formatters` - already done in Phase 04-A
- [x] Skip `MergeProgressModal.tsx` and `SummarizeProgressModal.tsx` if already deleted in Phase 01 - confirmed deleted

### Task 3: Verify

- [x] Run lint: `rtk npm run lint` - passes
- [x] Find related tests - found TransferProgressModal.test.tsx and formatters.test.ts
- [x] Run related tests: TransferProgressModal.test.tsx and formatters.test.ts - all pass
- [x] Confirm zero new test failures - confirmed

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

- 5 local `formatElapsedTime` definitions removed (or fewer if some files were deleted in Phase 01)
- All imports point to `src/shared/formatters.ts`
- Lint and tests pass
