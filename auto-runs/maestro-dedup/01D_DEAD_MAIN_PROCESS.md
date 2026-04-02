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

- [ ] Verify zero external refs: `rtk grep "DEBUG_GROUP_CHAT\|debugLogLazy" src/ --glob "*.{ts,tsx}" | rtk grep -v "main/constants"`
- [ ] Remove export `DEBUG_GROUP_CHAT` from `src/main/constants.ts`
- [ ] Remove export `debugLogLazy` from `src/main/constants.ts`

### Task 2: Remove dead exports from main/cue/ files

**CAUTION: Cue is under active development. Triple-check each export.**

- [ ] Verify and remove from `src/main/cue/cue-db.ts`: `isCueDbReady`, `getRecentCueEvents`, `clearGitHubSeenForSubscription`
- [ ] Verify and remove from `src/main/cue/cue-heartbeat.ts`: `HEARTBEAT_INTERVAL_MS`, `SLEEP_THRESHOLD_MS`
- [ ] Verify and remove from `src/main/cue/cue-subscription-setup.ts`: `DEFAULT_FILE_DEBOUNCE_MS`
- [ ] Verify and remove from `src/main/cue/cue-task-scanner.ts`: `extractPendingTasks`
- [ ] Verify and remove from `src/main/cue/cue-types.ts`: `CUE_YAML_FILENAME`, `LEGACY_CUE_YAML_FILENAME`
- [ ] For each export, verify with: `rtk grep "EXPORT_NAME" src/ --glob "*.{ts,tsx}" | rtk grep -v "DEFINING_FILE" | rtk grep -v "__tests__"`
- [ ] Skip any export that has external references (Cue is actively developed)

### Task 3: Remove dead export from main/debug-package/collectors/sanitize.ts

- [ ] Verify zero external refs: `rtk grep "sanitizeText" src/ --glob "*.{ts,tsx}" | rtk grep -v "sanitize.ts"`
- [ ] Remove export `sanitizeText` from `src/main/debug-package/collectors/sanitize.ts`

### Task 4: Remove dead exports from main/group-chat/ files

- [ ] Verify and remove from `src/main/group-chat/group-chat-agent.ts` (5): `getParticipantSystemPrompt`, `getParticipantSessionId`, `isParticipantActive`, `getActiveParticipants`, `clearAllParticipantSessionsGlobal`
- [ ] Verify and remove from `src/main/group-chat/group-chat-config.ts` (1): `getCustomShellPath`
- [ ] Verify and remove from `src/main/group-chat/group-chat-log.ts` (2): `escapeContent`, `unescapeContent`
- [ ] Verify and remove from `src/main/group-chat/group-chat-moderator.ts` (3): `startSessionCleanup`, `stopSessionCleanup`, `clearAllModeratorSessions`
- [ ] Verify and remove from `src/main/group-chat/group-chat-router.ts` (5): `setGroupChatReadOnlyState`, `getPendingParticipants`, `clearPendingParticipants`, `extractMentions`, `extractAllMentions`
- [ ] Verify and remove from `src/main/group-chat/group-chat-storage.ts` (1): `getGroupChatsDir`
- [ ] Verify and remove from `src/main/group-chat/output-buffer.ts` (2): `hasGroupChatBuffer`, `isGroupChatBufferTruncated`
- [ ] Verify and remove from `src/main/group-chat/output-parser.ts` (2): `extractTextGeneric`, `extractTextFromAgentOutput`
- [ ] Verify and remove from `src/main/group-chat/session-recovery.ts` (1): `detectSessionNotFoundError`
- [ ] For each, verify with: `rtk grep "EXPORT_NAME" src/ --glob "*.{ts,tsx}" | rtk grep -v "DEFINING_FILE" | rtk grep -v "__tests__"`

### Task 5: Remove dead exports from main/ipc/handlers/

- [ ] Verify and remove from `src/main/ipc/handlers/autorun.ts`: `getAutoRunWatcherCount`
- [ ] Verify and remove from `src/main/ipc/handlers/director-notes.ts`: `sanitizeDisplayName`
- [ ] Verify and remove from `src/main/ipc/handlers/documentGraph.ts`: `getDocumentGraphWatcherCount`
- [ ] Verify and remove from `src/main/ipc/handlers/index.ts`: `registerAllHandlers`
- [ ] Verify and remove from `src/main/ipc/handlers/notifications.ts` (6): `parseNotificationCommand`, `getNotificationQueueLength`, `getActiveNotificationCount`, `clearNotificationQueue`, `resetNotificationState`, `getNotificationMaxQueueSize`

### Task 6: Remove dead exports from main/parsers/

- [ ] Verify and remove from `src/main/parsers/agent-output-parser.ts`: `isValidToolType`
- [ ] Verify and remove from `src/main/parsers/index.ts`: `initializeOutputParsers`, `ensureParsersInitialized`

### Task 7: Remove dead exports from other main/ files

- [ ] Verify and remove from `src/main/process-listeners/index.ts`: `setupProcessListeners`
- [ ] Verify and remove from `src/main/stats/migrations.ts`: `getMigrations`
- [ ] Verify and remove from `src/main/storage/index.ts`: `initializeSessionStorages`
- [ ] Verify and remove from `src/main/stores/utils.ts`: `findSshRemoteById`

### Task 8: Remove dead exports from main/utils/

- [ ] Verify and remove from `src/main/utils/cliDetection.ts` (5): `clearCloudflaredCache`, `getGhPath`, `clearGhCache`, `getSshPath`, `clearSshCache`
- [ ] Verify and remove from `src/main/utils/execFile.ts`: `needsWindowsShell`
- [ ] Verify and remove from `src/main/utils/ipcHandler.ts` (4): `createHandler`, `createDataHandler`, `withErrorLogging`, `createIpcDataHandler`
- [ ] Verify and remove from `src/main/utils/sentry.ts`: `stopMemoryMonitoring`
- [ ] Verify and remove from `src/main/utils/shell-escape.ts`: `shellEscapeArgs`
- [ ] Verify and remove from `src/main/utils/shellDetector.ts`: `getShellCommand`
- [ ] Verify and remove from `src/main/utils/ssh-command-builder.ts`: `buildRemoteCommand`
- [ ] Verify and remove from `src/main/utils/ssh-config-parser.ts` (2): `parseConfigContent`, `findSshConfigHost`
- [ ] Verify and remove from `src/main/utils/statsCache.ts` (2): `getStatsCachePath`, `getGlobalStatsCachePath`
- [ ] Verify and remove from `src/main/utils/terminalFilter.ts` (2): `isCommandEcho`, `extractCommand`
- [ ] Verify and remove from `src/main/utils/wslDetector.ts` (2): `isWindowsMountPath`, `getWslWarningMessage`

### Task 9: Remove dead exports from main/wakatime-manager.ts

- [ ] Verify zero external refs: `rtk grep "detectLanguageFromPath\|WRITE_TOOL_NAMES" src/ --glob "*.{ts,tsx}" | rtk grep -v "wakatime-manager"`
- [ ] Remove export `detectLanguageFromPath` from `src/main/wakatime-manager.ts`
- [ ] Remove export `WRITE_TOOL_NAMES` from `src/main/wakatime-manager.ts`

### Task 10: Clean up files that became empty

- [ ] Check each modified file for remaining exports
- [ ] Delete any file that has zero remaining exports after removal

### Task 11: Verify - lint and tests pass

- [ ] Run lint: `rtk npm run lint`
- [ ] Find related test files: `rtk grep "import.*from.*main/" src/__tests__/ --glob "*.test.{ts,tsx}" -l`
- [ ] Run targeted tests for modified main process files: `rtk vitest run src/__tests__/main/`
- [ ] If tests fail because they imported dead exports, update those test files to remove the imports
- [ ] Confirm zero new test failures from your changes

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
