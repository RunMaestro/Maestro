# Phase 13-C: Split Oversized Test Files

## Objective

Address 28 test files exceeding 2,000 lines. Many will shrink naturally after Phase 03 (mock consolidation). Focus on the worst offenders that remain oversized.

**Evidence:** `docs/agent-guides/scans/SCAN-OVERSIZED.md`, "Test Files Over 2000 Lines"
**Risk:** Zero production risk - test-only changes
**Estimated savings:** Improved test maintainability

---

## Pre-flight Checks

- [ ] Phase 13-B (other oversized files) is complete
- [ ] Phase 03 (mock consolidation) is complete
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Re-measure after mock consolidation

Phase 03 removed ~2,900 lines of mock factories. Re-measure:

```
find src/__tests__/ -name "*.test.*" | xargs wc -l | sort -rn | head -30
```

Only target files still over 2,000 lines.

### Task 2: Split symphony.test.ts (was 6,203 lines)

If still oversized, split by test category:
- `symphony.create.test.ts` - creation flow tests
- `symphony.participants.test.ts` - participant management tests
- `symphony.messages.test.ts` - message handling tests
- `symphony.export.test.ts` - export/history tests

### Task 3: Split useBatchProcessor.test.ts (was 5,988 lines)

Split by feature:
- `useBatchProcessor.lifecycle.test.ts`
- `useBatchProcessor.execution.test.ts`
- `useBatchProcessor.worktree.test.ts`
- `useBatchProcessor.errors.test.ts`

### Task 4: Split TabBar.test.tsx (was 5,752 lines)

If still oversized after mock consolidation, split by tab type:
- `TabBar.aiTabs.test.tsx`
- `TabBar.fileTabs.test.tsx`
- `TabBar.dragDrop.test.tsx`
- `TabBar.keyboard.test.tsx`

### Task 5: Create shared test utilities if patterns emerge

During splitting, if common test patterns emerge, extract to:
- `src/__tests__/helpers/renderWithProviders.ts` - common render setup
- `src/__tests__/helpers/testUtils.ts` - common assertions

### Task 6: Verify all tests pass after splitting

```
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 7: Count remaining oversized test files

```
find src/__tests__/ -name "*.test.*" | xargs wc -l | awk '$1 > 2000' | wc -l
```

Target: fewer than 10 files over 2,000 lines.

---

## Success Criteria

- Worst offender test files split into focused modules
- Shared test utilities extracted where applicable
- All tests pass
- Fewer than 10 test files over 2,000 lines
