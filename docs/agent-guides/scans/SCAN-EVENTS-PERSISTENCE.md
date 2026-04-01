# SCAN-EVENTS-PERSISTENCE

Scan date: 2026-03-20
Source: `src/renderer/`, `src/main/`, `src/web/`

---

## addEventListener by Event Type

```
grep -oh "addEventListener('[a-z]*'" src/renderer/ -r --include="*.ts" --include="*.tsx" | sort | uniq -c | sort -rn | head -15
```

```
     38 addEventListener('keydown')
      8 addEventListener('mousedown')
      7 addEventListener('visibilitychange')
      6 addEventListener('click')
      3 addEventListener('scroll')
      3 addEventListener('resize')
      2 addEventListener('wheel')
      2 addEventListener('mouseup')
      2 addEventListener('mousemove')
      2 addEventListener('beforeunload')
      1 addEventListener('unhandledrejection')
      1 addEventListener('touchstart')
      1 addEventListener('orientationchange')
      1 addEventListener('keyup')
      1 addEventListener('focus')
```

**Key finding:** 38 `keydown` listeners across the renderer. Risk of conflicting keyboard handlers.

---

## Files with Most Listeners

```
grep -c "addEventListener" src/renderer/ -r --include="*.ts" --include="*.tsx" | grep -v ":0$\|__tests__" | sort -t: -k2 -rn | head -15
```

| File                                                    | Count |
| ------------------------------------------------------- | ----- |
| `src/renderer/utils/activityBus.ts`                     | 5     |
| `src/renderer/components/MarketplaceModal.tsx`          | 5     |
| `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts` | 4     |
| `src/renderer/components/SymphonyModal.tsx`             | 4     |
| `src/renderer/App.tsx`                                  | 4     |
| `src/renderer/hooks/ui/useAppHandlers.ts`               | 3     |
| `src/renderer/hooks/modal/useModalHandlers.ts`          | 3     |
| `src/renderer/components/Wizard/MaestroWizard.tsx`      | 3     |
| `src/renderer/components/SessionList/SessionList.tsx`   | 3     |
| `src/renderer/main.tsx`                                 | 2     |
| `src/renderer/hooks/utils/useDebouncedPersistence.ts`   | 2     |
| `src/renderer/hooks/ui/useResizablePanel.ts`            | 2     |
| `src/renderer/hooks/ui/useClickOutside.ts`              | 2     |
| `src/renderer/hooks/session/useHandsOnTimeTracker.ts`   | 2     |
| `src/renderer/hooks/remote/useMobileLandscape.ts`       | 2     |

---

## IPC Events (webContents.send)

```
grep -oh "webContents\.send('[^']*'" src/main/ -r --include="*.ts" | sort | uniq -c | sort -rn
```

42 unique IPC event channels, all used exactly once:

| Event                                 | Source |
| ------------------------------------- | ------ |
| `worktree:discovered`                 | main/  |
| `updates:status`                      | main/  |
| `symphony:updated`                    | main/  |
| `symphony:prCreated`                  | main/  |
| `symphony:contributionStarted`        | main/  |
| `stats:updated`                       | main/  |
| `remote:toggleBookmark`               | main/  |
| `remote:switchMode`                   | main/  |
| `remote:starTab`                      | main/  |
| `remote:selectTab`                    | main/  |
| `remote:selectSession`                | main/  |
| `remote:reorderTab`                   | main/  |
| `remote:renameTab`                    | main/  |
| `remote:refreshFileTree`              | main/  |
| `remote:refreshAutoRunDocs`           | main/  |
| `remote:openFileTab`                  | main/  |
| `remote:newTab`                       | main/  |
| `remote:interrupt`                    | main/  |
| `remote:executeCommand`               | main/  |
| `remote:configureAutoRun`             | main/  |
| `remote:closeTab`                     | main/  |
| `process:ssh-remote`                  | main/  |
| `notification:commandCompleted`       | main/  |
| `marketplace:manifestChanged`         | main/  |
| `logger:newLog`                       | main/  |
| `history:externalChange`              | main/  |
| `groupChat:stateChange`               | main/  |
| `groupChat:participantsChanged`       | main/  |
| `groupChat:moderatorUsage`            | main/  |
| `groupChat:moderatorSessionIdChanged` | main/  |
| `groupChat:message`                   | main/  |
| `groupChat:historyEntry`              | main/  |
| `documentGraph:filesChanged`          | main/  |
| `cue:activityUpdate`                  | main/  |
| `cli:activityChange`                  | main/  |
| `claude:projectStatsUpdate`           | main/  |
| `claude:globalStatsUpdate`            | main/  |
| `autorun:fileChanged`                 | main/  |
| `app:systemResume`                    | main/  |
| `app:requestQuitConfirmation`         | main/  |
| `agentSessions:globalStatsUpdate`     | main/  |

---

## localStorage Usage in Web

```
grep -rn "localStorage" src/web/ --include="*.ts" --include="*.tsx"
```

45 matches in 7 files:

| File                                          | Count | Purpose                            |
| --------------------------------------------- | ----- | ---------------------------------- |
| `src/web/hooks/useCommandHistory.ts`          | 8     | Command history persistence        |
| `src/web/hooks/useMobileSessionManagement.ts` | 1     | URL-based session config           |
| `src/web/hooks/useMobileViewState.ts`         | 4     | View state persistence             |
| `src/web/hooks/useNotifications.ts`           | 9     | Notification prompt/declined state |
| `src/web/hooks/useOfflineQueue.ts`            | 6     | Offline command queue survival     |
| `src/web/hooks/useUnreadBadge.ts`             | 7     | Unread response tracking           |
| `src/web/utils/viewState.ts`                  | 10    | View + scroll position persistence |

**Key locations:**

- `src/web/hooks/useCommandHistory.ts:115` - `localStorage.getItem(storageKey)`
- `src/web/hooks/useCommandHistory.ts:143` - `localStorage.setItem(storageKey, JSON.stringify(history))`
- `src/web/hooks/useNotifications.ts:104` - `localStorage.getItem(NOTIFICATION_PROMPT_KEY)`
- `src/web/hooks/useNotifications.ts:124` - `localStorage.setItem(NOTIFICATION_PROMPT_KEY, 'true')`
- `src/web/hooks/useOfflineQueue.ts:116` - `localStorage.getItem(STORAGE_KEY)`
- `src/web/hooks/useOfflineQueue.ts:134` - `localStorage.setItem(STORAGE_KEY, JSON.stringify(queue))`
- `src/web/hooks/useUnreadBadge.ts:67` - `localStorage.getItem(UNREAD_RESPONSES_KEY)`
- `src/web/hooks/useUnreadBadge.ts:86` - `localStorage.setItem(UNREAD_RESPONSES_KEY, JSON.stringify([...ids]))`
- `src/web/utils/viewState.ts:88` - `localStorage.setItem(STORAGE_KEY, JSON.stringify(newState))`
- `src/web/utils/viewState.ts:100` - `localStorage.getItem(STORAGE_KEY)`
- `src/web/utils/viewState.ts:144` - `localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(newState))`

---

## writeFileSync (Blocking Writes)

```
grep -rn "writeFileSync" src/main/ --include="*.ts" | grep -v __tests__
```

| File                                           | Line | Context                                                                              |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `src/main/history-manager.ts`                  | 139  | `fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf-8')`             |
| `src/main/history-manager.ts`                  | 154  | `fs.writeFileSync(this.migrationMarkerPath, ...)`                                    |
| `src/main/history-manager.ts`                  | 221  | `fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')`                 |
| `src/main/history-manager.ts`                  | 248  | `fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')`                 |
| `src/main/history-manager.ts`                  | 282  | `fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')`                 |
| `src/main/history-manager.ts`                  | 444  | `fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')`                 |
| `src/main/ipc/handlers/cue.ts`                 | 219  | `fs.writeFileSync(filePath, options.content, 'utf-8')`                               |
| `src/main/ipc/handlers/cue.ts`                 | 233  | `fs.writeFileSync(absPath, content, 'utf-8')`                                        |
| `src/main/ipc/handlers/cue.ts`                 | 281  | `fs.writeFileSync(layoutFilePath, JSON.stringify(options.layout, null, 2), 'utf-8')` |
| `src/main/ipc/handlers/process.ts`             | 232  | `fs.writeFileSync(systemPromptTempFile, config.appendSystemPrompt, 'utf-8')`         |
| `src/main/process-manager/utils/imageUtils.ts` | 36   | `fs.writeFileSync(tempPath, buffer)`                                                 |

**Key finding:** `history-manager.ts` has 6 blocking write calls. These run on the main process and could cause UI stalls during heavy history operations.

---

## JSON.parse Usage (Main Process)

```
grep -rn "JSON\.parse" src/main/ --include="*.ts" | grep -v __tests__
```

96 matches across the main process. Highest concentration files:

| File                                                | Count |
| --------------------------------------------------- | ----- |
| `src/main/storage/codex-session-storage.ts`         | 14    |
| `src/main/ipc/handlers/claude.ts`                   | 13    |
| `src/main/storage/claude-session-storage.ts`        | 5     |
| `src/main/history-manager.ts`                       | 5     |
| `src/main/storage/factory-droid-session-storage.ts` | 5     |
| `src/main/parsers/claude-output-parser.ts`          | 4     |
| `src/main/ipc/handlers/symphony.ts`                 | 5     |
| `src/main/parsers/codex-output-parser.ts`           | 3     |
| `src/main/parsers/factory-droid-output-parser.ts`   | 3     |
| `src/main/parsers/opencode-output-parser.ts`        | 3     |
| `src/main/group-chat/group-chat-storage.ts`         | 3     |
| `src/main/storage/opencode-session-storage.ts`      | 3     |

**Unsafe parse locations (inside try-catch status unknown, verify manually):**

- `src/main/cue/cue-github-poller.ts:118` - `JSON.parse(stdout)`
- `src/main/cue/cue-github-poller.ts:189` - `JSON.parse(stdout)`
- `src/main/debug-package/collectors/group-chats.ts:63` - `JSON.parse(content)`
- `src/main/group-chat/group-chat-storage.ts:277` - `JSON.parse(content) as GroupChat`
- `src/main/group-chat/output-parser.ts:29` - `JSON.parse(line)`
- `src/main/ipc/handlers/agents.ts:110` - `JSON.parse(content)` (config file)
- `src/main/ipc/handlers/marketplace.ts:125` - `JSON.parse(content)`
- `src/main/ipc/handlers/marketplace.ts:250` - `JSON.parse(content)`
- `src/main/ipc/handlers/persistence.ts:212` - `JSON.parse(content)`
- `src/main/ipc/handlers/playbooks.ts:44` - `JSON.parse(content)`
- `src/main/openspec-manager.ts:98,212,221` - `JSON.parse(content)` (3 locations)
- `src/main/speckit-manager.ts:127,241,250` - `JSON.parse(content)` (3 locations)
- `src/main/utils/statsCache.ts:112,201` - `JSON.parse(content)` (2 locations)
- `src/main/wakatime-manager.ts:229` - `JSON.parse(data)`
- `src/main/web-server/routes/wsRoute.ts:193` - `JSON.parse(message.toString())`
- `src/main/process-manager/handlers/ExitHandler.ts:239` - `JSON.parse(managedProcess.jsonBuffer!)`

---

## Path Construction (homedir, userData)

```
grep -rn "homedir()\|getPath.*userData" src/main/ --include="*.ts" | grep -v __tests__
```

88 matches. Major clusters:

**`os.homedir()` usage (48 matches):**

| File                                                       | Count | Purpose                              |
| ---------------------------------------------------------- | ----- | ------------------------------------ |
| `src/main/group-chat/group-chat-router.ts`                 | 11    | CWD fallback for group chat spawning |
| `src/main/ipc/handlers/claude.ts`                          | 7     | Claude session directory resolution  |
| `src/main/agents/path-prober.ts`                           | 3     | Agent binary discovery               |
| `src/main/storage/claude-session-storage.ts`               | 1     | Projects dir: `~/.claude/projects`   |
| `src/main/storage/codex-session-storage.ts`                | 1     | Sessions dir: `~/.codex/sessions`    |
| `src/main/storage/factory-droid-session-storage.ts`        | 1     | Sessions dir: `~/.factory/sessions`  |
| `src/main/storage/opencode-session-storage.ts`             | 2     | Platform-specific data dir           |
| `src/main/ipc/handlers/agentSessions.ts`                   | 2     | Home directory resolution            |
| `src/main/ipc/handlers/agents.ts`                          | 2     | XDG config + home                    |
| `src/main/ipc/handlers/filesystem.ts`                      | 1     | Return home dir                      |
| `src/main/ipc/handlers/groupChat.ts`                       | 2     | CWD fallback                         |
| `src/main/ipc/handlers/marketplace.ts`                     | 1     | Homedir for playbook install         |
| `src/main/ipc/handlers/process.ts`                         | 2     | CWD fallback for SSH                 |
| `src/main/index.ts`                                        | 3     | Session CWD fallback                 |
| `src/main/process-manager/runners/LocalCommandRunner.ts`   | 1     | Home directory fallback              |
| `src/main/process-manager/utils/envBuilder.ts`             | 2     | PATH construction                    |
| `src/main/utils/ssh-spawn-wrapper.ts`                      | 2     | SSH CWD                              |
| `src/main/utils/logger.ts`                                 | 3     | Platform-specific log path           |
| `src/main/wakatime-manager.ts`                             | 3     | Wakatime binary/config paths         |
| `src/main/debug-package/collectors/sanitize.ts`            | 2     | Path sanitization                    |
| `src/main/debug-package/collectors/windows-diagnostics.ts` | 1     | Windows diagnostics                  |
| `src/main/parsers/codex-output-parser.ts`                  | 1     | CODEX_HOME fallback                  |

**`app.getPath('userData')` usage (40 matches):**

| File                                               | Count | Purpose                        |
| -------------------------------------------------- | ----- | ------------------------------ |
| `src/main/ipc/handlers/system.ts`                  | 4     | User data path queries         |
| `src/main/index.ts`                                | 4     | Data path setup (dev/prod)     |
| `src/main/ipc/handlers/attachments.ts`             | 5     | Attachment storage             |
| `src/main/stores/instances.ts`                     | 3     | Bootstrap store path           |
| `src/main/ipc/handlers/claude.ts`                  | 1     | Stats cache path               |
| `src/main/ipc/handlers/cue.ts`                     | 1     | Pipeline layout path           |
| `src/main/ipc/handlers/marketplace.ts`             | 3     | Cache + manifest paths         |
| `src/main/ipc/handlers/persistence.ts`             | 1     | CLI activity path              |
| `src/main/ipc/handlers/playbooks.ts`               | 1     | Playbooks dir                  |
| `src/main/ipc/handlers/symphony.ts`                | 1     | Symphony dir                   |
| `src/main/cue/cue-db.ts`                           | 1     | Cue database path              |
| `src/main/debug-package/collectors/group-chats.ts` | 1     | Group chats dir                |
| `src/main/debug-package/collectors/storage.ts`     | 1     | User data inspection           |
| `src/main/group-chat/group-chat-storage.ts`        | 1     | Config dir fallback            |
| `src/main/history-manager.ts`                      | 1     | Config dir                     |
| `src/main/openspec-manager.ts`                     | 2     | Customizations + prompts paths |
| `src/main/speckit-manager.ts`                      | 2     | Customizations + prompts paths |
| `src/main/stats/stats-db.ts`                       | 1     | Stats database path            |
| `src/main/storage/codex-session-storage.ts`        | 1     | Session cache path             |
| `src/main/utils/statsCache.ts`                     | 2     | Stats cache paths              |
