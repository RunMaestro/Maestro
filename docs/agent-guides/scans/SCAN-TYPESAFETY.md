# SCAN-TYPESAFETY

Type safety audit of the Maestro codebase: `as any`, untyped parameters, non-null assertions, and catch clause typing.

Generated: 2026-03-20

---

## `as any` in Source (Non-Test)

**Total: 108 occurrences** across non-test source files.

Top 30 files by count:

| File                                                                  | Count |
| --------------------------------------------------------------------- | ----- |
| `src/renderer/components/FilePreview.tsx`                             | 13    |
| `src/renderer/components/Wizard/screens/ConversationScreen.tsx`       | 12    |
| `src/renderer/components/Wizard/screens/AgentSelectionScreen.tsx`     | 9     |
| `src/renderer/hooks/session/useSessionCrud.ts`                        | 8     |
| `src/renderer/components/Wizard/screens/PhaseReviewScreen.tsx`        | 6     |
| `src/renderer/components/Wizard/WizardExitConfirmModal.tsx`           | 6     |
| `src/renderer/hooks/remote/useLiveMode.ts`                            | 5     |
| `src/renderer/hooks/wizard/useWizardHandlers.ts`                      | 4     |
| `src/renderer/components/Wizard/screens/DirectorySelectionScreen.tsx` | 4     |
| `src/renderer/components/Wizard/MaestroWizard.tsx`                    | 4     |
| `src/renderer/App.tsx`                                                | 3     |
| `src/web/mobile/SessionStatusBanner.tsx`                              | 2     |
| `src/web/mobile/App.tsx`                                              | 2     |
| `src/renderer/utils/remarkFileLinks.ts`                               | 2     |
| `src/renderer/hooks/agent/useInterruptHandler.ts`                     | 2     |
| `src/renderer/components/Wizard/services/conversationManager.ts`      | 2     |
| `src/renderer/components/UsageDashboard/SessionStats.tsx`             | 2     |
| `src/main/process-manager/spawners/PtySpawner.ts`                     | 2     |
| `src/main/ipc/handlers/agents.ts`                                     | 2     |
| `src/cli/commands/send.ts`                                            | 2     |
| `src/web/utils/logger.ts`                                             | 1     |
| `src/web/hooks/useMobileSessionManagement.ts`                         | 1     |
| `src/renderer/utils/platformUtils.ts`                                 | 1     |
| `src/renderer/components/Wizard/tour/TourStep.tsx`                    | 1     |
| `src/renderer/components/Wizard/services/phaseGenerator.ts`           | 1     |
| `src/renderer/components/WindowsWarningModal.tsx`                     | 1     |
| `src/renderer/components/MarkdownRenderer.tsx`                        | 1     |
| `src/renderer/components/InputArea.tsx`                               | 1     |
| `src/renderer/components/GroupChatModal.tsx`                          | 1     |
| `src/main/wakatime-manager.ts`                                        | 1     |

**Hotspot: Wizard subsystem** - 41 of 108 `as any` usages (38%) are concentrated in the Wizard components.

---

## `as any` in Tests

**Total: 2,948 occurrences** across test files in `src/__tests__/`.

This is expected for test mocks and fixtures but is notably high (27x the production count).

---

## `any` in Function Signatures

Explicit `: any` type annotations in parameters and return types (excluding `as any` casts and comments):

- `src/main/debug-package/collectors/group-chats.ts:74` - `(p: any) =>`
- `src/main/debug-package/collectors/web-server.ts:51` - `(session: any) =>`
- `src/main/index.ts:369` - `(s: any) =>`
- `src/main/index.ts:786` - `(s: any) =>`
- `src/main/ipc/handlers/agents.ts:75` - `catch (error: any)`
- `src/main/ipc/handlers/agents.ts:90` - `catch (error: any)`
- `src/main/ipc/handlers/agents.ts:101` - `catch (error: any)`
- `src/main/ipc/handlers/agents.ts:108` - `let config: any`
- `src/main/ipc/handlers/agents.ts:228` - `function stripAgentFunctions(agent: any)`
- `src/main/ipc/handlers/agents.ts:243` - `(opt: any) =>`
- `src/main/ipc/handlers/agents.ts:484` - `(a: any) =>`
- `src/main/ipc/handlers/agents.ts:487` - `(a: any) =>`
- `src/main/ipc/handlers/attachments.ts:181` - `catch (err: any)`
- `src/main/ipc/handlers/filesystem.ts:121` - `(entry: any) =>`
- `src/main/ipc/handlers/filesystem.ts:172` - `catch (error: any)`
- `src/main/ipc/handlers/marketplace.ts:972` - `let playbooks: any[]`
- `src/main/ipc/handlers/persistence.ts:49` - `value: any`
- `src/main/ipc/handlers/playbooks.ts:55` - `playbooks: any[]`
- `src/main/ipc/handlers/playbooks.ts:99` - `documents: any[]`
- `src/main/ipc/handlers/playbooks.ts:118` - `documents: any[]`
- `src/main/ipc/handlers/playbooks.ts:161` - `documents: any[]`
- `src/main/ipc/handlers/playbooks.ts:175` - `(p: any) =>`
- `src/main/ipc/handlers/playbooks.ts:206` - `(p: any) =>`
- `src/main/ipc/handlers/playbooks.ts:247` - `(p: any) =>`
- `src/main/ipc/handlers/process.ts:62` - `Store<{ sessions: any[] }>`
- `src/main/ipc/handlers/web.ts:94` - `catch (error: any)`
- `src/main/ipc/handlers/web.ts:290` - `catch (error: any)`
- `src/main/ipc/handlers/web.ts:310` - `catch (error: any)`
- `src/main/ipc/handlers/web.ts:334` - `catch (error: any)`
- `src/main/ipc/handlers/web.ts:356` - `catch (error: any)`

**Hotspot files:** `agents.ts` (8 usages), `playbooks.ts` (6 usages), `web.ts` (5 usages).

---

## Non-null Assertions (`!.`)

**Total: 123 non-null assertions** in `src/renderer/` (non-test).

Top 20 files by count:

| File                                                                   | Count |
| ---------------------------------------------------------------------- | ----- |
| `src/renderer/hooks/agent/useAgentListeners.ts`                        | 41    |
| `src/renderer/components/Wizard/services/conversationManager.ts`       | 24    |
| `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`                | 6     |
| `src/renderer/components/HistoryDetailModal.tsx`                       | 6     |
| `src/renderer/components/ProcessMonitor.tsx`                           | 5     |
| `src/renderer/hooks/agent/useAgentExecution.ts`                        | 4     |
| `src/renderer/components/DocumentGraph/mindMapLayouts.ts`              | 4     |
| `src/renderer/utils/remarkFileLinks.ts`                                | 3     |
| `src/renderer/hooks/worktree/useWorktreeHandlers.ts`                   | 3     |
| `src/renderer/hooks/props/useMainPanelProps.ts`                        | 2     |
| `src/renderer/hooks/input/useInputHandlers.ts`                         | 2     |
| `src/renderer/hooks/batch/useInlineWizard.ts`                          | 2     |
| `src/renderer/hooks/batch/useAutoRunImageHandling.ts`                  | 2     |
| `src/renderer/hooks/agent/useInterruptHandler.ts`                      | 2     |
| `src/renderer/components/PromptComposerModal.tsx`                      | 2     |
| `src/renderer/components/NewInstanceModal.tsx`                         | 2     |
| `src/renderer/components/DocumentGraph/MindMap.tsx`                    | 2     |
| `src/renderer/components/CuePipelineEditor/panels/NodeConfigPanel.tsx` | 2     |
| `src/renderer/hooks/wizard/useWizardHandlers.ts`                       | 1     |
| `src/renderer/hooks/remote/useSshRemotes.ts`                           | 1     |

**Hotspot: `useAgentListeners.ts`** - 41 of 123 (33%) of all non-null assertions in renderer.

---

## `catch (e: any)` vs `catch (e: unknown)`

| Pattern                  | Count  |
| ------------------------ | ------ |
| `catch (error: any)`     | **17** |
| `catch (error: unknown)` | **21** |

### `catch (error: any)` locations (17):

- `src/main/ipc/handlers/agents.ts:75`
- `src/main/ipc/handlers/agents.ts:90`
- `src/main/ipc/handlers/agents.ts:101`
- `src/main/ipc/handlers/attachments.ts:181`
- `src/main/ipc/handlers/filesystem.ts:172`
- `src/main/ipc/handlers/web.ts:94`
- `src/main/ipc/handlers/web.ts:290`
- `src/main/ipc/handlers/web.ts:310`
- `src/main/ipc/handlers/web.ts:334`
- `src/main/ipc/handlers/web.ts:356`
- `src/main/ipc/handlers/web.ts:390`
- `src/main/utils/execFile.ts:134`
- `src/main/web-server/routes/apiRoutes.ts:290`
- `src/main/web-server/routes/apiRoutes.ts:333`
- `src/renderer/components/Settings/SettingsModal.tsx:313`
- `src/renderer/stores/agentStore.ts:486`
- `src/web/mobile/MobileHistoryPanel.tsx:896`

### `catch (error: unknown)` locations (21):

- `src/main/app-lifecycle/quit-handler.ts:178`
- `src/main/app-lifecycle/quit-handler.ts:184`
- `src/main/group-chat/group-chat-log.ts:186`
- `src/main/group-chat/group-chat-storage.ts:278`
- `src/main/group-chat/group-chat-storage.ts:312`
- `src/main/group-chat/group-chat-storage.ts:593`
- `src/main/group-chat/group-chat-storage.ts:642`
- `src/main/group-chat/group-chat-storage.ts:660`
- `src/main/ipc/handlers/groupChat.ts:780`
- `src/main/process-listeners/session-id-listener.ts:70`
- `src/renderer/components/shared/AgentConfigPanel.tsx:313`
- `src/renderer/hooks/agent/useInterruptHandler.ts:394`
- `src/renderer/hooks/batch/useBatchProcessor.ts:1166`
- `src/renderer/hooks/cue/usePipelineLayout.ts:71`
- `src/renderer/hooks/cue/usePipelineLayout.ts:103`
- `src/renderer/hooks/cue/usePipelineState.ts:235`
- `src/renderer/hooks/cue/usePipelineState.ts:324`
- `src/renderer/hooks/cue/usePipelineState.ts:347`
- `src/renderer/hooks/remote/useRemoteHandlers.ts:187`
- `src/renderer/hooks/remote/useRemoteHandlers.ts:420`
- `src/renderer/hooks/symphony/useSymphonyContribution.ts:218`

**Pattern:** Newer code (group-chat, cue, symphony) consistently uses `unknown`. Older IPC handlers (`agents.ts`, `web.ts`, `attachments.ts`) use `any`. The codebase is mid-migration toward `catch (e: unknown)`.
