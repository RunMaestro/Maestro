# Phase 01-A: Delete Dead Component Files

## Objective

Remove 7 component files that have ZERO production imports. These files are completely unreferenced in the codebase and can be safely deleted.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Component Files"
**Risk:** None - zero production imports confirmed 2026-04-01
**Estimated savings:** ~7 files deleted entirely

---

## Pre-flight Checks

- [ ] Run `rtk npm run lint` and confirm it passes before making changes
- [ ] Run `rtk vitest run` and confirm baseline passes

---

## Tasks

### Task 1: Verify each component has zero production imports

- [x] Completed 2026-04-01. All 7 components verified to have zero production imports.
  - `AgentSessionsModal`: Only non-import refs are type `AgentSessionsModalData` in `modalStore.ts` (type def, not component import) + test file
  - `GitWorktreeSection`: Only comment refs in `BatchRunnerModal.test.tsx`
  - `GroupChatParticipants`: Only comment ref in `GroupChatRightPanel.tsx`
  - `MergeProgressModal`: Only comment ref in `TransferProgressModal.tsx`
  - `ShortcutEditor`: Test file only
  - `SummarizeProgressModal`: Self-references only
  - `ThemePicker`: `ThemeTab.tsx` has `handleThemePickerKeyDown` variable name (not an import) + test file

### Task 2: Delete the 7 dead component files

- [x] Completed 2026-04-01. All 7 files deleted:
  1. `src/renderer/components/AgentSessionsModal.tsx`
  2. `src/renderer/components/GitWorktreeSection.tsx`
  3. `src/renderer/components/GroupChatParticipants.tsx`
  4. `src/renderer/components/MergeProgressModal.tsx`
  5. `src/renderer/components/ShortcutEditor.tsx`
  6. `src/renderer/components/SummarizeProgressModal.tsx`
  7. `src/renderer/components/ThemePicker.tsx`

### Task 3: Delete associated test files (if they exist)

- [x] Completed 2026-04-01. 3 test files found and deleted:
  1. `src/__tests__/renderer/components/AgentSessionsModal.test.tsx`
  2. `src/__tests__/renderer/components/ShortcutEditor.test.tsx`
  3. `src/__tests__/renderer/components/ThemePicker.test.tsx`
  - No test files existed for: GitWorktreeSection, GroupChatParticipants, MergeProgressModal, SummarizeProgressModal

### Task 4: Check for stale imports in barrel files

- [x] Completed 2026-04-01. No stale re-exports found in any `index.ts` or `index.tsx` barrel files.

### Task 5: Verify - lint and tests pass

- [ ] Run both commands and confirm they pass:

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip tests.** The Windows build environment is now fixed. Both lint and test must pass before this task is complete.

---

## Success Criteria

- 7 component files deleted
- Associated test files deleted
- No lint errors
- All tests pass
- Zero references to deleted components remain in production code
