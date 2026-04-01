# SCAN-MAIN.md - Main Process Duplicates

Generated: 2026-03-20 via `grep -rn` against `src/`

---

## IPC Handler Boilerplate (ipcMain.handle counts by file)

| Count | File                                   |
| ----- | -------------------------------------- |
| 37    | `main/ipc/handlers/system.ts`          |
| 26    | `main/ipc/handlers/git.ts`             |
| 24    | `main/ipc/handlers/groupChat.ts`       |
| 20    | `main/ipc/handlers/symphony.ts`        |
| 19    | `main/ipc/handlers/cue.ts`             |
| 19    | `main/ipc/handlers/agents.ts`          |
| 17    | `main/ipc/handlers/stats.ts`           |
| 16    | `main/ipc/handlers/web.ts`             |
| 16    | `main/ipc/handlers/claude.ts`          |
| 14    | `main/ipc/handlers/autorun.ts`         |
| 13    | `main/utils/ipcHandler.ts`             |
| 13    | `main/ipc/handlers/agentSessions.ts`   |
| 10    | `main/ipc/handlers/history.ts`         |
| 10    | `main/ipc/handlers/filesystem.ts`      |
| 8     | `main/ipc/handlers/process.ts`         |
| 8     | `main/ipc/handlers/persistence.ts`     |
| 7     | `main/ipc/handlers/ssh-remote.ts`      |
| 7     | `main/ipc/handlers/playbooks.ts`       |
| 6     | `main/ipc/handlers/speckit.ts`         |
| 6     | `main/ipc/handlers/openspec.ts`        |
| 6     | `main/ipc/handlers/context.ts`         |
| 5     | `main/ipc/handlers/marketplace.ts`     |
| 5     | `main/ipc/handlers/attachments.ts`     |
| 4     | `main/auto-updater.ts`                 |
| 4     | `main/app-lifecycle/window-manager.ts` |
| 3     | `main/ipc/handlers/notifications.ts`   |
| 2     | `main/ipc/handlers/wakatime.ts`        |
| 2     | `main/ipc/handlers/documentGraph.ts`   |
| 2     | `main/ipc/handlers/director-notes.ts`  |
| 2     | `main/ipc/handlers/debug.ts`           |
| 2     | `main/ipc/handlers/agent-error.ts`     |
| 1     | `main/ipc/handlers/tabNaming.ts`       |
| 1     | `main/ipc/handlers/index.ts`           |

**Total: 313 ipcMain.handle registrations across 33 files.**

Note: `main/utils/ipcHandler.ts` provides `createIpcHandler` wrapper but many files still use raw `ipcMain.handle` directly.

---

## SSH Command Construction / wrapSpawnWithSsh Locations

All files that call `wrapSpawnWithSsh()`:

| File                                   | Lines | Context                           |
| -------------------------------------- | ----- | --------------------------------- |
| `main/cue/cue-executor.ts`             | 273   | Cue pipeline agent spawn          |
| `main/group-chat/group-chat-agent.ts`  | 191   | Group chat participant spawn      |
| `main/group-chat/group-chat-router.ts` | 545   | Router agent spawn (context path) |
| `main/group-chat/group-chat-router.ts` | 936   | Router agent spawn (second path)  |
| `main/group-chat/group-chat-router.ts` | 1314  | Router moderator spawn            |
| `main/group-chat/group-chat-router.ts` | 1518  | Router additional spawn           |
| `main/utils/ssh-spawn-wrapper.ts`      | 85    | Definition of wrapSpawnWithSsh    |

Each call site follows the same pattern:

```
const sshWrapped = await wrapSpawnWithSsh(config, sshRemoteConfig, sshStore);
spawnCommand = sshWrapped.command;
spawnArgs = sshWrapped.args;
spawnCwd = sshWrapped.cwd;
spawnEnvVars = sshWrapped.customEnvVars;
```

The 5-line destructure block is repeated verbatim at every call site.

---

## console.log vs logger Usage by File (top 30)

### console.log (should generally be logger)

| Count | File                                                        |
| ----- | ----------------------------------------------------------- |
| 130   | `main/group-chat/group-chat-router.ts`                      |
| 26    | `main/group-chat/group-chat-agent.ts`                       |
| 14    | `renderer/hooks/remote/useRemoteHandlers.ts`                |
| 14    | `renderer/components/Wizard/services/phaseGenerator.ts`     |
| 14    | `cli/commands/run-playbook.ts`                              |
| 11    | `renderer/components/DocumentGraph/graphDataBuilder.ts`     |
| 11    | `main/ipc/handlers/groupChat.ts`                            |
| 9     | `renderer/utils/tabHelpers.ts`                              |
| 9     | `renderer/services/inlineWizardDocumentGeneration.ts`       |
| 9     | `main/group-chat/group-chat-moderator.ts`                   |
| 9     | `cli/commands/clean-playbooks.ts`                           |
| 8     | `renderer/hooks/batch/useBatchProcessor.ts`                 |
| 8     | `renderer/hooks/agent/useAgentListeners.ts`                 |
| 8     | `renderer/components/DocumentGraph/DocumentGraphView.tsx`   |
| 7     | `renderer/hooks/remote/useRemoteIntegration.ts`             |
| 7     | `main/ipc/handlers/context.ts`                              |
| 6     | `web/mobile/AllSessionsView.tsx`                            |
| 6     | `main/utils/logger.ts`                                      |
| 6     | `cli/commands/list-sessions.ts`                             |
| 5     | `renderer/services/contextSummarizer.ts`                    |
| 5     | `renderer/hooks/batch/useWorktreeManager.ts`                |
| 5     | `renderer/components/Wizard/screens/ConversationScreen.tsx` |
| 4     | `renderer/utils/contextExtractor.ts`                        |
| 4     | `renderer/hooks/ui/useLayerStack.ts`                        |
| 4     | `renderer/hooks/input/useInputProcessing.ts`                |
| 4     | `renderer/components/QuickActionsModal.tsx`                 |
| 4     | `renderer/components/NotificationsPanel.tsx`                |
| 4     | `main/process-manager/handlers/StdoutHandler.ts`            |
| 4     | `main/index.ts`                                             |
| 4     | `cli/commands/list-playbooks.ts`                            |

### logger.\* (proper structured logging)

| Count | File                                                   |
| ----- | ------------------------------------------------------ |
| 65    | `main/ipc/handlers/symphony.ts`                        |
| 53    | `main/ipc/handlers/agents.ts`                          |
| 48    | `main/web-server/web-server-factory.ts`                |
| 46    | `main/ipc/handlers/autorun.ts`                         |
| 42    | `main/ipc/handlers/marketplace.ts`                     |
| 38    | `main/stats/stats-db.ts`                               |
| 34    | `main/ipc/handlers/git.ts`                             |
| 33    | `main/ipc/handlers/groupChat.ts`                       |
| 29    | `main/storage/opencode-session-storage.ts`             |
| 29    | `main/ipc/handlers/system.ts`                          |
| 28    | `main/web-server/handlers/messageHandlers.ts`          |
| 27    | `main/ipc/handlers/process.ts`                         |
| 26    | `main/index.ts`                                        |
| 25    | `main/process-manager/spawners/ChildProcessSpawner.ts` |
| 24    | `main/ipc/handlers/notifications.ts`                   |
| 24    | `main/ipc/handlers/agentSessions.ts`                   |
| 22    | `main/storage/claude-session-storage.ts`               |
| 22    | `main/ipc/handlers/web.ts`                             |
| 22    | `main/app-lifecycle/window-manager.ts`                 |
| 21    | `main/ipc/handlers/context.ts`                         |
| 21    | `main/ipc/handlers/claude.ts`                          |

**Key finding:** `main/group-chat/group-chat-router.ts` has 130 `console.log` calls and only uses `logger` in some places. This is the largest offender. Many renderer files also use `console.log` instead of the available logger.

---

## Settings Store Access Patterns by File (top 25)

| Count | File                                               |
| ----- | -------------------------------------------------- |
| 100   | `renderer/stores/settingsStore.ts` (definition)    |
| 18    | `main/index.ts`                                    |
| 17    | `main/ipc/handlers/process.ts`                     |
| 13    | `main/ipc/handlers/ssh-remote.ts`                  |
| 13    | `main/ipc/handlers/autorun.ts`                     |
| 12    | `main/ipc/handlers/index.ts`                       |
| 9     | `main/web-server/web-server-factory.ts`            |
| 9     | `main/ipc/handlers/stats.ts`                       |
| 8     | `main/wakatime-manager.ts`                         |
| 8     | `main/ipc/handlers/web.ts`                         |
| 7     | `main/ipc/handlers/system.ts`                      |
| 6     | `renderer/components/Wizard/WizardContext.tsx`     |
| 5     | `main/process-listeners/wakatime-listener.ts`      |
| 5     | `main/ipc/handlers/persistence.ts`                 |
| 5     | `main/ipc/handlers/agents.ts`                      |
| 4     | `renderer/App.tsx`                                 |
| 4     | `main/stores/instances.ts`                         |
| 4     | `main/ipc/handlers/git.ts`                         |
| 3     | `renderer/components/Settings/tabs/DisplayTab.tsx` |
| 3     | `main/stores/getters.ts`                           |
| 3     | `main/ipc/handlers/tabNaming.ts`                   |
| 3     | `main/ipc/handlers/symphony.ts`                    |
| 3     | `main/ipc/handlers/marketplace.ts`                 |
| 3     | `main/ipc/handlers/debug.ts`                       |

**Pattern:** Settings store is accessed from 25+ files in main process. Most access `settingsStore.get(key)` inline rather than through a centralized accessor.
