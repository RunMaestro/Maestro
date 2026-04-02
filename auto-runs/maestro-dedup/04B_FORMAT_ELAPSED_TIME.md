# Phase 04-B: Consolidate formatElapsedTime Re-definitions

## Objective

Replace 5 redundant `formatElapsedTime` definitions with the canonical version in `src/shared/formatters.ts:144`.

**Evidence:** `docs/agent-guides/scans/SCAN-FORMATTERS.md`, "formatElapsed / formatElapsedTime re-definitions"
**Risk:** Very low - all 5 are identical implementations
**Estimated savings:** ~50 lines

---

## Pre-flight Checks

- [ ] Phase 04-A (formatDuration) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Verify all 5 are identical to canonical

Read the canonical at `src/shared/formatters.ts:144`, then compare with:

1. `MergeProgressModal.tsx:58`
2. `MergeProgressOverlay.tsx:53`
3. `SummarizeProgressModal.tsx:57`
4. `SummarizeProgressOverlay.tsx:51`
5. `TransferProgressModal.tsx:79`

All should be identical functions.

### Task 2: Remove local definitions and add imports

For each of the 5 files:

1. Remove the local `formatElapsedTime` function
2. Add: `import { formatElapsedTime } from '../../shared/formatters';` (adjust path as needed)

**NOTE:** `MergeProgressModal.tsx` and `SummarizeProgressModal.tsx` were flagged as dead components in Phase 01. If they were already deleted, skip them.

### Task 3: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

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
