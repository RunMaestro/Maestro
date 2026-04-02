# Phase 01-B: Remove Dead Store Selectors

## Objective

Remove 53 exported store selectors/helpers that have zero external references. These exports exist in store files but are never imported anywhere.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Store Selectors"
**Risk:** Very low - exports have zero external references. Store files remain (only removing unused exports).
**Estimated savings:** ~200 lines across 9 store files

---

## Pre-flight Checks

- [x] Phase 01-A (dead components) is complete (all 7 files deleted, committed)
- [x] `rtk npm run lint` passes
- [x] `rtk vitest run` passes (7 pre-existing failures in main/shared unrelated to stores)

---

## Tasks

### Task 1: Remove dead exports from agentStore.ts

- [x] Completed 2026-04-02. All 4 exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "selectAvailableAgents\|selectAgentsDetected\|getAgentState\|getAgentActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "agentStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `selectAvailableAgents`, `selectAgentsDetected`, `getAgentState`, `getAgentActions`
- [ ] Update test file if it imports any of these exports

### Task 2: Remove dead exports from batchStore.ts

- [x] Completed 2026-04-02. All 3 exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "selectStoppingBatchSessionIds\|selectBatchRunState\|getBatchActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "batchStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `selectStoppingBatchSessionIds`, `selectBatchRunState`, `getBatchActions`
- [ ] Update test file if it imports any of these exports

### Task 3: Remove dead exports from fileExplorerStore.ts

- [x] Completed 2026-04-02. Both exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "getFileExplorerState\|getFileExplorerActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "fileExplorerStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `getFileExplorerState`, `getFileExplorerActions`
- [ ] Update test file if it imports any of these exports

### Task 4: Remove dead exports from groupChatStore.ts

- [x] Completed 2026-04-02. Both exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "getGroupChatState\|getGroupChatActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "groupChatStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `getGroupChatState`, `getGroupChatActions`
- [ ] Update test file if it imports any of these exports

### Task 5: Remove dead exports from modalStore.ts

- [x] Completed 2026-04-02. 1 of 2 removed (`selectModal`). `selectModalOpen` is actively used - do NOT remove.
- [ ] Verify `selectModal` has zero external refs: `rtk grep "selectModal[^O]" src/ --glob "*.{ts,tsx}" | rtk grep -v "modalStore" | rtk grep -v "__tests__"`
- [ ] Verify `selectModalOpen` IS used: `rtk grep "selectModalOpen" src/ --glob "*.{ts,tsx}" | rtk grep -v "modalStore"`
- [ ] Remove `selectModal` only (keep `selectModalOpen`)

### Task 6: Remove dead exports from notificationStore.ts

- [x] Completed 2026-04-02. All 6 exports removed. Test file updated.
- [ ] Verify zero external refs for all 6: `rtk grep "selectToasts\|selectToastCount\|selectConfig\|resetToastIdCounter\|getNotificationState\|getNotificationActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "notificationStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `selectToasts`, `selectToastCount`, `selectConfig`, `resetToastIdCounter`, `getNotificationState`, `getNotificationActions`
- [ ] Update test file (rewrite counter test to not depend on absolute counter values)

### Task 7: Remove dead exports from operationStore.ts

- [x] Completed 2026-04-02. All 3 exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "selectIsAnyOperationInProgress\|getOperationState\|getOperationActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "operationStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `selectIsAnyOperationInProgress`, `getOperationState`, `getOperationActions`
- [ ] Update test file if it imports any of these exports

### Task 8: Remove dead exports from sessionStore.ts

- [x] Completed 2026-04-02. All 9 exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "selectBookmarkedSessions\|selectSessionsByGroup\|selectUngroupedSessions\|selectGroupById\|selectSessionCount\|selectIsReady\|selectIsAnySessionBusy\|getSessionState\|getSessionActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "sessionStore" | rtk grep -v "__tests__"`
- [ ] Remove exports: `selectBookmarkedSessions`, `selectSessionsByGroup`, `selectUngroupedSessions`, `selectGroupById`, `selectSessionCount`, `selectIsReady`, `selectIsAnySessionBusy`, `getSessionState`, `getSessionActions`
- [ ] Update test file (rewrite initialization flow test to use store state directly)

### Task 9: Remove dead exports from settingsStore.ts

- [x] Completed 2026-04-02. All 11 exports handled.
- [ ] Remove `export` keyword from 8 `DEFAULT_*` constants (keep constants for internal use)
- [ ] Remove `export` keyword from `getBadgeLevelForTime` (keep function for internal use)
- [ ] Fully remove `getSettingsState` and `getSettingsActions`
- [ ] Update `settingsStore.test.ts` - replace constant imports with `useSettingsStore.getState()` pattern
- [ ] Update `useSettings.test.ts` - replace constant imports with `useSettingsStore.getState()` pattern
- [ ] Update `fonts-and-sizing.test.ts` - replace constant imports with `useSettingsStore.getState()` pattern
- [ ] Update `SessionList.test.tsx` - replace constant imports with `useSettingsStore.getState()` pattern

### Task 10: Remove dead exports from tabStore.ts

- [x] Completed 2026-04-02. All 12 exports removed. Test file updated.
- [ ] Verify zero external refs: `rtk grep "selectActiveTab\|selectActiveFileTab\|selectUnifiedTabs\|selectTabById\|selectFileTabById\|selectTabCount\|selectAllTabs\|selectAllFileTabs\|selectActiveTerminalTab\|selectTerminalTabs\|getTabState\|getTabActions" src/ --glob "*.{ts,tsx}" | rtk grep -v "tabStore" | rtk grep -v "__tests__"`
- [ ] Remove all 12 exports from `tabStore.ts`
- [ ] Clean up unused type imports (`UnifiedTab`, `TerminalTab`) and utility imports (`getActiveTab`, `buildUnifiedTabs`)
- [ ] Update test file to remove references to deleted exports

### Task 11: Verify - lint and tests pass

- [x] Completed 2026-04-02. Lint passes. 139/139 store-related tests pass.
- [ ] Run type checking: `rtk tsc -p tsconfig.lint.json --noEmit && rtk tsc -p tsconfig.main.json --noEmit`
- [ ] Run store-related tests: `rtk vitest run src/__tests__/renderer/stores/`
- [ ] Confirm zero new test failures (pre-existing failures in cue/path/message areas are acceptable)

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

- 53 dead exports removed across 9 store files
- No new lint errors
- All tests pass
- Store files still contain all their USED exports
