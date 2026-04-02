# Phase 01-A: Delete Dead Component Files

## Objective

Remove 7 component files that have ZERO production imports. These files are completely unreferenced in the codebase and can be safely deleted.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Component Files"
**Risk:** None - zero production imports confirmed 2026-04-01
**Estimated savings:** ~7 files deleted entirely

---

## Pre-flight Checks

- [x] Completed 2026-04-02. `npm run lint` passes clean. `vitest run` shows 602 test files passed (24003 tests passed), 9 pre-existing failures (26 tests) all unrelated to dead component deletions - they are Windows path handling issues in cue-yaml-loader, pathUtils, messageHandlers, agents discovery, and SessionList rendering tests.
- [x] Baseline confirmed 2026-04-02. No test failures related to the 7 deleted component files or their 3 deleted test files.

---

## Tasks

### Task 1: Verify each component has zero production imports

- [x] Completed 2026-04-01. All 7 components verified to have zero production imports.
- [ ] Verify `AgentSessionsModal` has zero production imports: `rtk grep "AgentSessionsModal" src/ --glob "*.{ts,tsx}" | rtk grep -v "AgentSessionsModal.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `GitWorktreeSection` has zero production imports: `rtk grep "GitWorktreeSection" src/ --glob "*.{ts,tsx}" | rtk grep -v "GitWorktreeSection.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `GroupChatParticipants` has zero production imports: `rtk grep "GroupChatParticipants" src/ --glob "*.{ts,tsx}" | rtk grep -v "GroupChatParticipants.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `MergeProgressModal` has zero production imports: `rtk grep "MergeProgressModal" src/ --glob "*.{ts,tsx}" | rtk grep -v "MergeProgressModal.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `ShortcutEditor` has zero production imports: `rtk grep "ShortcutEditor" src/ --glob "*.{ts,tsx}" | rtk grep -v "ShortcutEditor.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `SummarizeProgressModal` has zero production imports: `rtk grep "SummarizeProgressModal" src/ --glob "*.{ts,tsx}" | rtk grep -v "SummarizeProgressModal.tsx" | rtk grep -v "__tests__"`
- [ ] Verify `ThemePicker` has zero production imports: `rtk grep "ThemePicker" src/ --glob "*.{ts,tsx}" | rtk grep -v "ThemePicker.tsx" | rtk grep -v "__tests__"`

### Task 2: Delete the 7 dead component files

- [x] Completed 2026-04-01. All 7 files deleted.
- [ ] Delete `src/renderer/components/AgentSessionsModal.tsx`
- [ ] Delete `src/renderer/components/GitWorktreeSection.tsx`
- [ ] Delete `src/renderer/components/GroupChatParticipants.tsx`
- [ ] Delete `src/renderer/components/MergeProgressModal.tsx`
- [ ] Delete `src/renderer/components/ShortcutEditor.tsx`
- [ ] Delete `src/renderer/components/SummarizeProgressModal.tsx`
- [ ] Delete `src/renderer/components/ThemePicker.tsx`

### Task 3: Delete associated test files (if they exist)

- [x] Completed 2026-04-01. 3 test files found and deleted.
- [ ] Check for test files: `rtk grep -l "AgentSessionsModal\|GitWorktreeSection\|GroupChatParticipants\|MergeProgressModal\|ShortcutEditor\|SummarizeProgressModal\|ThemePicker" src/__tests__/ --glob "*.test.{ts,tsx}"`
- [ ] Delete `src/__tests__/renderer/components/AgentSessionsModal.test.tsx` (if exists)
- [ ] Delete `src/__tests__/renderer/components/ShortcutEditor.test.tsx` (if exists)
- [ ] Delete `src/__tests__/renderer/components/ThemePicker.test.tsx` (if exists)
- [ ] Check for test files of remaining 4 components and delete any found

### Task 4: Check for stale imports in barrel files

- [x] Completed 2026-04-01. No stale re-exports found.
- [ ] Search for stale re-exports: `rtk grep "AgentSessionsModal\|GitWorktreeSection\|GroupChatParticipants\|MergeProgressModal\|ShortcutEditor\|SummarizeProgressModal\|ThemePicker" src/ --glob "index.{ts,tsx}"`
- [ ] Remove any stale re-exports found

### Task 5: Verify - lint and tests pass

- [ ] Run lint: `rtk npm run lint`
- [ ] Run tests: `rtk vitest run`
- [ ] Confirm zero new test failures from your changes (pre-existing failures are acceptable)

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

- 7 component files deleted
- Associated test files deleted
- No lint errors
- All tests pass
- Zero references to deleted components remain in production code
