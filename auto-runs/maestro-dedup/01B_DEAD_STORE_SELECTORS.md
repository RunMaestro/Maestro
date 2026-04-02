# Phase 01-B: Remove Dead Store Selectors

## Objective

Remove 53 exported store selectors/helpers that have zero external references. These exports exist in store files but are never imported anywhere.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Store Selectors"
**Risk:** Very low - exports have zero external references. Store files remain (only removing unused exports).
**Estimated savings:** ~200 lines across 9 store files

---

## Pre-flight Checks

- [ ] Phase 01-A (dead components) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

---

## Tasks

### Task 1: Remove dead exports from agentStore.ts

File: `src/renderer/stores/agentStore.ts`

Verify zero external references, then remove these 4 exports:

- `selectAvailableAgents`
- `selectAgentsDetected`
- `getAgentState`
- `getAgentActions`

For each, verify with grep first:

```
rtk grep "selectAvailableAgents" src/ --include="*.ts" --include="*.tsx" | grep -v "agentStore" | grep -v "__tests__" | grep -v "\.test\."
```

If grep returns 0 results, remove the export. If it's a function, remove the entire function. If it's a `const` selector, remove the entire const declaration.

### Task 2: Remove dead exports from batchStore.ts

File: `src/renderer/stores/batchStore.ts`

Remove these 3 exports:

- `selectStoppingBatchSessionIds`
- `selectBatchRunState`
- `getBatchActions`

### Task 3: Remove dead exports from fileExplorerStore.ts

File: `src/renderer/stores/fileExplorerStore.ts`

Remove these 2 exports:

- `getFileExplorerState`
- `getFileExplorerActions`

### Task 4: Remove dead exports from groupChatStore.ts

File: `src/renderer/stores/groupChatStore.ts`

Remove these 2 exports:

- `getGroupChatState`
- `getGroupChatActions`

### Task 5: Remove dead exports from modalStore.ts

File: `src/renderer/stores/modalStore.ts`

Remove these 2 exports:

- `selectModalOpen`
- `selectModal`

### Task 6: Remove dead exports from notificationStore.ts

File: `src/renderer/stores/notificationStore.ts`

Remove these 6 exports:

- `selectToasts`
- `selectToastCount`
- `selectConfig`
- `resetToastIdCounter`
- `getNotificationState`
- `getNotificationActions`

### Task 7: Remove dead exports from operationStore.ts

File: `src/renderer/stores/operationStore.ts`

Remove these 3 exports:

- `selectIsAnyOperationInProgress`
- `getOperationState`
- `getOperationActions`

### Task 8: Remove dead exports from sessionStore.ts

File: `src/renderer/stores/sessionStore.ts`

Remove these 9 exports:

- `selectBookmarkedSessions`
- `selectSessionsByGroup`
- `selectUngroupedSessions`
- `selectGroupById`
- `selectSessionCount`
- `selectIsReady`
- `selectIsAnySessionBusy`
- `getSessionState`
- `getSessionActions`

### Task 9: Remove dead exports from settingsStore.ts

File: `src/renderer/stores/settingsStore.ts`

Remove these 11 exports:

- `DEFAULT_CONTEXT_MANAGEMENT_SETTINGS`
- `DEFAULT_AUTO_RUN_STATS`
- `DEFAULT_USAGE_STATS`
- `DEFAULT_KEYBOARD_MASTERY_STATS`
- `DEFAULT_ONBOARDING_STATS`
- `DEFAULT_ENCORE_FEATURES`
- `DEFAULT_DIRECTOR_NOTES_SETTINGS`
- `DEFAULT_AI_COMMANDS`
- `getBadgeLevelForTime`
- `getSettingsState`
- `getSettingsActions`

**WARNING:** Some `DEFAULT_*` constants may be used internally within the same file. Only remove the `export` keyword if the constant is used internally. Remove the entire declaration only if it has zero internal references too.

### Task 10: Remove dead exports from tabStore.ts

File: `src/renderer/stores/tabStore.ts`

Remove these 12 exports:

- `selectActiveTab`
- `selectActiveFileTab`
- `selectUnifiedTabs`
- `selectTabById`
- `selectFileTabById`
- `selectTabCount`
- `selectAllTabs`
- `selectAllFileTabs`
- `selectActiveTerminalTab`
- `selectTerminalTabs`
- `getTabState`
- `getTabActions`

### Task 11: Verify - lint and tests pass

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

Both must pass. If tests fail, a test file was importing one of these selectors - check the test, and if the selector is only used in tests, remove it from the test too.

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
