# SCAN-PATTERNS.md - Structural Pattern Duplicates

Generated via `grep -rn` on `src/`. All matches are file:line verified. Tests excluded.

---

## try-catch with console.error only (no captureException)

### Counts

- Total `catch` blocks in production code: **611**
- Total `console.error` lines in production code: **356**
- Total `captureException`/`captureMessage` lines: **112**
- Catch blocks followed by `console.error` within 5 lines: **252**
- Files with `console.error` but zero Sentry usage: **118 files**

### Files with console.error but no captureException/captureMessage (118 files)

**CLI (14 files):**

```
src/cli/commands/auto-run.ts
src/cli/commands/clean-playbooks.ts
src/cli/commands/list-agents.ts
src/cli/commands/list-groups.ts
src/cli/commands/list-playbooks.ts
src/cli/commands/list-sessions.ts
src/cli/commands/open-file.ts
src/cli/commands/refresh-auto-run.ts
src/cli/commands/refresh-files.ts
src/cli/commands/run-playbook.ts
src/cli/commands/send.ts
src/cli/commands/show-agent.ts
src/cli/commands/show-playbook.ts
src/cli/commands/status.ts
src/cli/services/agent-spawner.ts
src/cli/services/maestro-client.ts
src/cli/services/storage.ts
```

**Main process (4 files):**

```
src/main/cue/cue-file-watcher.ts
src/main/ipc/handlers/context.ts
src/main/ipc/handlers/system.ts
src/main/stores/utils.ts
src/main/utils/logger.ts
```

**Renderer - Components (40+ files):**

```
src/renderer/components/AboutModal.tsx
src/renderer/components/AchievementCard.tsx
src/renderer/components/AgentCreationDialog.tsx
src/renderer/components/AgentSessionsBrowser.tsx
src/renderer/components/AgentSessionsModal.tsx
src/renderer/components/AutoRun.tsx
src/renderer/components/AutoRunLightbox.tsx
src/renderer/components/DebugPackageModal.tsx
src/renderer/components/DebugWizardModal.tsx
src/renderer/components/DirectorNotes/UnifiedHistoryTab.tsx
src/renderer/components/DocumentGraph/DocumentGraphView.tsx
src/renderer/components/DocumentGraph/graphDataBuilder.ts
src/renderer/components/FileExplorerPanel.tsx
src/renderer/components/GroupChatInfoOverlay.tsx
src/renderer/components/GroupChatParticipants.tsx
src/renderer/components/GroupChatRightPanel.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/LightboxModal.tsx
(and 20+ more component files)
```

**Renderer - Hooks (24 files):**

```
src/renderer/hooks/batch/useBatchProcessor.ts
src/renderer/hooks/batch/useDocumentProcessor.ts
src/renderer/hooks/batch/useInlineWizard.ts
src/renderer/hooks/batch/useMarketplace.ts
src/renderer/hooks/batch/usePlaybookManagement.ts
src/renderer/hooks/batch/useWorktreeValidation.ts
src/renderer/hooks/input/useInputProcessing.ts
src/renderer/hooks/remote/useCliActivityMonitoring.ts
src/renderer/hooks/remote/useLiveMode.ts
src/renderer/hooks/remote/useLiveOverlay.ts
src/renderer/hooks/remote/useRemoteIntegration.ts
src/renderer/hooks/remote/useSshRemotes.ts
src/renderer/hooks/session/useSessionCrud.ts
src/renderer/hooks/session/useSessionRestoration.ts
src/renderer/hooks/stats/useStats.ts
src/renderer/hooks/symphony/useContributorStats.ts
src/renderer/hooks/symphony/useSymphony.ts
src/renderer/hooks/symphony/useSymphonyContribution.ts
src/renderer/hooks/tabs/useTabExportHandlers.ts
src/renderer/hooks/tabs/useTabHandlers.ts
src/renderer/hooks/ui/useAppHandlers.ts
src/renderer/hooks/ui/useAppInitialization.ts
src/renderer/hooks/wizard/useWizardHandlers.ts
src/renderer/hooks/worktree/useWorktreeHandlers.ts
```

**Renderer - Services/Stores/Utils (14 files):**

```
src/renderer/services/contextSummarizer.ts
src/renderer/services/inlineWizardDocumentGeneration.ts
src/renderer/services/ipcWrapper.ts
src/renderer/services/openspec.ts
src/renderer/services/speckit.ts
src/renderer/stores/agentStore.ts
src/renderer/stores/notificationStore.ts
src/renderer/stores/sessionStore.ts
src/renderer/stores/settingsStore.ts
src/renderer/utils/contextExtractor.ts
src/renderer/utils/fileExplorer.ts
src/renderer/utils/gitDiffParser.ts
src/renderer/utils/sessionHelpers.ts
src/renderer/utils/tokenCounter.ts
```

**Shared/Web (2 files):**

```
src/shared/cli-activity.ts
src/web/utils/logger.ts
```

---

## resolve() definitions in stores (5 identical)

Every Zustand store defines its own identical `resolve` helper:

```
src/renderer/stores/batchStore.ts:86           function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T
src/renderer/stores/fileExplorerStore.ts:81    function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T
src/renderer/stores/groupChatStore.ts:136      function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T
src/renderer/stores/sessionStore.ts:145        function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T
src/renderer/stores/uiStore.ts:129             function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T
```

All 5 have identical signatures and identical implementations. Should be extracted to a shared store utility.

---

## SpecKit vs OpenSpec - Line count comparison

These are near-identical parallel implementations:

| File Pair     | SpecKit                          | OpenSpec                          | Delta   |
| ------------- | -------------------------------- | --------------------------------- | ------- |
| IPC handler   | `ipc/handlers/speckit.ts` (100)  | `ipc/handlers/openspec.ts` (100)  | 0       |
| Manager       | `speckit-manager.ts` (530)       | `openspec-manager.ts` (471)       | 59      |
| UI Panel      | `SpecKitCommandsPanel.tsx` (424) | `OpenSpecCommandsPanel.tsx` (426) | 2       |
| Service       | `services/speckit.ts` (56)       | `services/openspec.ts` (56)       | 0       |
| Prompts index | `prompts/speckit/index.ts` (157) | `prompts/openspec/index.ts` (111) | 46      |
| **Total**     | **1,267**                        | **1,164**                         | **103** |

The IPC handlers, services, and UI panels are virtually identical (0-2 line difference). The managers differ by 59 lines (SpecKit has more commands). Together they account for ~2,431 lines that could be reduced to ~1,300 with a shared base implementation.

Notably, both also share the `EditingCommand` interface (see SCAN-TYPES.md):

```
src/renderer/components/AICommandsPanel.tsx:25         interface EditingCommand
src/renderer/components/OpenSpecCommandsPanel.tsx:21   interface EditingCommand
src/renderer/components/SpecKitCommandsPanel.tsx:21    interface EditingCommand
```

---

## Group chat spawn sites (5 processManager.spawn calls)

All in `src/main/group-chat/`:

```
src/main/group-chat/group-chat-agent.ts:226         addParticipantToChat - main participant spawn
src/main/group-chat/group-chat-router.ts:583        spawnModerator - moderator spawn
src/main/group-chat/group-chat-router.ts:976        direct participant spawn (in turnRouter)
src/main/group-chat/group-chat-router.ts:1352       spawnModeratorSynthesis - synthesis spawn
src/main/group-chat/group-chat-router.ts:1553       respawnParticipantWithRecovery - recovery spawn
```

### Shared spawn pattern across all 5 sites

Each spawn site repeats this ~30-line pattern:

1. Resolve agent config (command, args, env vars)
2. Wrap with SSH if configured (`wrapSpawnWithSsh`)
3. Get Windows spawn config (`getWindowsSpawnConfig`)
4. Call `processManager.spawn({...})` with ~15 fields
5. Handle spawn failure

The SSH wrapping and Windows config code is copy-pasted across all sites:

```
src/main/group-chat/group-chat-agent.ts:178-220     SSH + Windows spawn config
src/main/group-chat/group-chat-router.ts:540-590    SSH + Windows spawn config
src/main/group-chat/group-chat-router.ts:930-980    SSH + Windows spawn config
src/main/group-chat/group-chat-router.ts:1302-1370  SSH + Windows spawn config
src/main/group-chat/group-chat-router.ts:1510-1560  SSH + Windows spawn config
```

### IPC layer spawn orchestration

The IPC handler (`src/main/ipc/handlers/groupChat.ts`) calls these spawn functions:

```
src/main/ipc/handlers/groupChat.ts:191     spawnModerator(chat, processManager)
src/main/ipc/handlers/groupChat.ts:328     spawnModerator(updated, processManager)
src/main/ipc/handlers/groupChat.ts:433     spawnModerator(chat, processManager)
src/main/ipc/handlers/groupChat.ts:463     addParticipantToChat (via groupChat module)
src/main/ipc/handlers/groupChat.ts:529     addParticipantToChat
src/main/ipc/handlers/groupChat.ts:637     batch spawn via processManager
```

---

## Summary

| Pattern                           | Count                    | Impact                                            |
| --------------------------------- | ------------------------ | ------------------------------------------------- |
| catch + console.error (no Sentry) | 252 blocks in 118 files  | Silent error swallowing, no production visibility |
| `resolve()` in stores             | 5 identical copies       | Trivial dedup to shared utility                   |
| SpecKit/OpenSpec parallel code    | ~2,431 lines             | ~1,100 lines removable via shared base            |
| Group chat spawn boilerplate      | 5 sites, ~150 lines each | Extract `spawnGroupChatAgent()` helper            |
