# Phase 01-D: Remove Dead Main Process Exports

## Objective

Remove 75 exported functions/constants/types from `src/main/` that have zero external references.

**Evidence:** `docs/agent-guides/scans/SCAN-DEADCODE.md`, "Dead Main Process Exports"
**Risk:** Low - zero external references confirmed. However, main process code can have side effects, so verify each removal carefully.
**Estimated savings:** ~500 lines across 35 files

---

## Pre-flight Checks

- [ ] Phase 01-C (dead shared utils) is complete
- [ ] `rtk npm run lint` passes

---

## Important Notes

- **DO NOT touch `src/main/cue/` files if Cue is under active development.** The scan lists several cue exports as dead, but verify current state before removing.
- For each export, verify with: `rtk grep "EXPORT_NAME" src/ --include="*.ts" --include="*.tsx" | grep -v "DEFINING_FILE" | grep -v "__tests__"`
- Some exports may be used via dynamic dispatch or reflection - if in doubt, skip.

---

## Tasks

### Task 1: Remove dead exports from main/constants.ts

Remove:

- `DEBUG_GROUP_CHAT`
- `debugLogLazy`

### Task 2: Remove dead exports from main/cue/ files

**CAUTION: Cue is under active development. Triple-check each export.**

From `main/cue/cue-db.ts`:

- `isCueDbReady`
- `getRecentCueEvents`
- `clearGitHubSeenForSubscription`

From `main/cue/cue-heartbeat.ts`:

- `HEARTBEAT_INTERVAL_MS`
- `SLEEP_THRESHOLD_MS`

From `main/cue/cue-subscription-setup.ts`:

- `DEFAULT_FILE_DEBOUNCE_MS`

From `main/cue/cue-task-scanner.ts`:

- `extractPendingTasks`

From `main/cue/cue-types.ts`:

- `CUE_YAML_FILENAME`
- `LEGACY_CUE_YAML_FILENAME`

### Task 3: Remove dead export from main/debug-package/collectors/sanitize.ts

Remove: `sanitizeText`

### Task 4: Remove dead exports from main/group-chat/ files

From `main/group-chat/group-chat-agent.ts` (5 exports):

- `getParticipantSystemPrompt`
- `getParticipantSessionId`
- `isParticipantActive`
- `getActiveParticipants`
- `clearAllParticipantSessionsGlobal`

From `main/group-chat/group-chat-config.ts`:

- `getCustomShellPath`

From `main/group-chat/group-chat-log.ts` (2):

- `escapeContent`
- `unescapeContent`

From `main/group-chat/group-chat-moderator.ts` (3):

- `startSessionCleanup`
- `stopSessionCleanup`
- `clearAllModeratorSessions`

From `main/group-chat/group-chat-router.ts` (5):

- `setGroupChatReadOnlyState`
- `getPendingParticipants`
- `clearPendingParticipants`
- `extractMentions`
- `extractAllMentions`

From `main/group-chat/group-chat-storage.ts`:

- `getGroupChatsDir`

From `main/group-chat/output-buffer.ts` (2):

- `hasGroupChatBuffer`
- `isGroupChatBufferTruncated`

From `main/group-chat/output-parser.ts` (2):

- `extractTextGeneric`
- `extractTextFromAgentOutput`

From `main/group-chat/session-recovery.ts`:

- `detectSessionNotFoundError`

### Task 5: Remove dead exports from main/ipc/handlers/

From `main/ipc/handlers/autorun.ts`:

- `getAutoRunWatcherCount`

From `main/ipc/handlers/director-notes.ts`:

- `sanitizeDisplayName`

From `main/ipc/handlers/documentGraph.ts`:

- `getDocumentGraphWatcherCount`

From `main/ipc/handlers/index.ts`:

- `registerAllHandlers`

From `main/ipc/handlers/notifications.ts` (6):

- `parseNotificationCommand`
- `getNotificationQueueLength`
- `getActiveNotificationCount`
- `clearNotificationQueue`
- `resetNotificationState`
- `getNotificationMaxQueueSize`

### Task 6: Remove dead exports from main/parsers/

From `main/parsers/agent-output-parser.ts`:

- `isValidToolType`

From `main/parsers/index.ts`:

- `initializeOutputParsers`
- `ensureParsersInitialized`

### Task 7: Remove dead exports from other main/ files

From `main/process-listeners/index.ts`:

- `setupProcessListeners`

From `main/stats/migrations.ts`:

- `getMigrations`

From `main/storage/index.ts`:

- `initializeSessionStorages`

From `main/stores/utils.ts`:

- `findSshRemoteById`

### Task 8: Remove dead exports from main/utils/

From `main/utils/cliDetection.ts` (5):

- `clearCloudflaredCache`
- `getGhPath`
- `clearGhCache`
- `getSshPath`
- `clearSshCache`

From `main/utils/execFile.ts`:

- `needsWindowsShell`

From `main/utils/ipcHandler.ts` (4):

- `createHandler`
- `createDataHandler`
- `withErrorLogging`
- `createIpcDataHandler`

From `main/utils/sentry.ts`:

- `stopMemoryMonitoring`

From `main/utils/shell-escape.ts`:

- `shellEscapeArgs`

From `main/utils/shellDetector.ts`:

- `getShellCommand`

From `main/utils/ssh-command-builder.ts`:

- `buildRemoteCommand`

From `main/utils/ssh-config-parser.ts` (2):

- `parseConfigContent`
- `findSshConfigHost`

From `main/utils/statsCache.ts` (2):

- `getStatsCachePath`
- `getGlobalStatsCachePath`

From `main/utils/terminalFilter.ts` (2):

- `isCommandEcho`
- `extractCommand`

From `main/utils/wslDetector.ts` (2):

- `isWindowsMountPath`
- `getWslWarningMessage`

### Task 9: Remove dead exports from main/wakatime-manager.ts

Remove:

- `detectLanguageFromPath`
- `WRITE_TOOL_NAMES`

### Task 10: Clean up files that became empty

If any file has zero remaining exports after removal, delete the file entirely.

### Task 11: Verify - lint and tests pass

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

If tests fail because test files imported these dead exports, update the test files to remove those imports.

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

- 75 dead exports removed across 35 main process files
- Any now-empty files deleted
- No lint errors
- All tests pass
- Cue files handled carefully (skipped if uncertain)
