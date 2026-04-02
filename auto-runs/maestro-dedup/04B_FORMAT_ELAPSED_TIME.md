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

## Success Criteria

- 5 local `formatElapsedTime` definitions removed (or fewer if some files were deleted in Phase 01)
- All imports point to `src/shared/formatters.ts`
- Lint and tests pass
