# SCAN-BLOCKS.md - Structural Code Block Duplicates

Generated: 2026-03-20 via `grep -rn` against `src/`

---

## setSessions Calls by File (non-test, 5+ occurrences)

| Count | File                                                |
| ----- | --------------------------------------------------- |
| 68    | `renderer/hooks/tabs/useTabHandlers.ts`             |
| 25    | `renderer/hooks/wizard/useWizardHandlers.ts`        |
| 22    | `renderer/App.tsx`                                  |
| 18    | `renderer/hooks/input/useInputProcessing.ts`        |
| 18    | `renderer/hooks/git/useFileTreeManagement.ts`       |
| 17    | `renderer/hooks/remote/useRemoteIntegration.ts`     |
| 16    | `web/hooks/useMobileSessionManagement.ts`           |
| 16    | `renderer/hooks/worktree/useWorktreeHandlers.ts`    |
| 16    | `renderer/hooks/batch/useAutoRunHandlers.ts`        |
| 16    | `renderer/components/FileExplorerPanel.tsx`         |
| 13    | `renderer/hooks/ui/useAppHandlers.ts`               |
| 13    | `renderer/hooks/agent/useAgentListeners.ts`         |
| 11    | `renderer/hooks/agent/useMergeTransferHandlers.ts`  |
| 10    | `renderer/hooks/keyboard/useMainKeyboardHandler.ts` |
| 9     | `web/hooks/useSessions.ts`                          |
| 9     | `renderer/components/AppModals.tsx`                 |
| 8     | `renderer/stores/sessionStore.ts`                   |
| 8     | `renderer/hooks/git/useFileExplorerEffects.ts`      |
| 8     | `renderer/components/QuickActionsModal.tsx`         |
| 7     | `renderer/utils/tabHelpers.ts`                      |
| 7     | `renderer/hooks/session/useSessionRestoration.ts`   |
| 7     | `renderer/hooks/input/useInputHandlers.ts`          |
| 7     | `renderer/hooks/agent/useSessionPagination.ts`      |
| 7     | `renderer/components/RightPanel.tsx`                |
| 6     | `renderer/hooks/session/useSessionLifecycle.ts`     |
| 6     | `renderer/hooks/session/useGroupManagement.ts`      |
| 6     | `renderer/hooks/input/useInputSync.ts`              |
| 6     | `renderer/hooks/agent/useMergeSession.ts`           |
| 6     | `renderer/components/SessionList/SessionList.tsx`   |
| 5     | `renderer/hooks/session/useActivityTracker.ts`      |
| 5     | `renderer/hooks/remote/useRemoteHandlers.ts`        |
| 5     | `renderer/hooks/agent/useSendToAgent.ts`            |
| 5     | `renderer/hooks/agent/useInterruptHandler.ts`       |
| 5     | `renderer/hooks/agent/useAgentSessionManagement.ts` |

**Total distinct production files with setSessions: 68+**

---

## Nested aiTabs.map Calls (file:line)

Every `s.aiTabs.map(...)` or `session.aiTabs.map(...)` inside a setSessions updater:

| File                                                 | Line | Pattern                                                      |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------ |
| `renderer/App.tsx`                                   | 1409 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/agent/useAgentExecution.ts`          | 307  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useAgentExecution.ts`          | 330  | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 254  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 509  | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 557  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 606  | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 857  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/agent/useAgentListeners.ts`          | 949  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 1209 | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/agent/useAgentListeners.ts`          | 1527 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 128  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 184  | `updatedAiTabsForIdle = s.aiTabs.map(...)`                   |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 263  | `updatedSession.aiTabs = s.aiTabs.map(...)`                  |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 299  | `updatedAiTabs = updatedSession.aiTabs.map(...)`             |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 354  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/agent/useInterruptHandler.ts`        | 411  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/agent/useMergeSession.ts`            | 761  | `aiTabs: session.aiTabs.map(...)`                            |
| `renderer/hooks/agent/useMergeTransferHandlers.ts`   | 522  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/agent/useQueueProcessing.ts`         | 126  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/agent/useQueueProcessing.ts`         | 162  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/batch/useBatchHandlers.ts`           | 528  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/input/useInputHandlers.ts`           | 243  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputHandlers.ts`           | 291  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputHandlers.ts`           | 309  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 287  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/input/useInputProcessing.ts`         | 629  | `updatedAiTabs = s.aiTabs.map(...)`                          |
| `renderer/hooks/input/useInputProcessing.ts`         | 681  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 694  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 723  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 768  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 787  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 912  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/input/useInputProcessing.ts`         | 1024 | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/input/useInputProcessing.ts`         | 1123 | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/input/useInputSync.ts`               | 59   | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`  | 656  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`  | 671  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`  | 692  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/useModalHandlers.ts`           | 544  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/usePromptComposerHandlers.ts`  | 127  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/usePromptComposerHandlers.ts`  | 147  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/usePromptComposerHandlers.ts`  | 171  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/useQuickActionsHandlers.ts`    | 95   | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/modal/useQuickActionsHandlers.ts`    | 117  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/remote/useRemoteHandlers.ts`         | 358  | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/remote/useRemoteHandlers.ts`         | 429  | `s.aiTabs.map(...)`                                          |
| `renderer/hooks/remote/useRemoteIntegration.ts`      | 361  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/remote/useRemoteIntegration.ts`      | 392  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/session/useBatchedSessionUpdates.ts` | 207  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/session/useBatchedSessionUpdates.ts` | 310  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/session/useBatchedSessionUpdates.ts` | 348  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/session/useBatchedSessionUpdates.ts` | 380  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/session/useBatchedSessionUpdates.ts` | 421  | `aiTabs: updatedSession.aiTabs.map(...)`                     |
| `renderer/hooks/session/useSessionLifecycle.ts`      | 268  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/session/useSessionLifecycle.ts`      | 396  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/session/useSessionLifecycle.ts`      | 413  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/session/useSessionRestoration.ts`    | 224  | `correctedSession.aiTabs = correctedSession.aiTabs.map(...)` |
| `renderer/hooks/session/useSessionRestoration.ts`    | 278  | `resetAiTabs = correctedSession.aiTabs.map(...)`             |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1036 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1079 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1114 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1155 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1168 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1185 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1230 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/tabs/useTabHandlers.ts`              | 1263 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 306  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 371  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 396  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 439  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 468  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 558  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 600  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 632  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 654  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 827  | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 980  | `updatedTabs = s.aiTabs.map(...)`                            |
| `renderer/hooks/wizard/useWizardHandlers.ts`         | 1027 | `aiTabs: s.aiTabs.map(...)`                                  |
| `renderer/stores/agentStore.ts`                      | 168  | `s.aiTabs.map(...)`                                          |
| `renderer/stores/agentStore.ts`                      | 482  | `s.aiTabs.map(...)`                                          |
| `renderer/stores/sessionStore.ts`                    | 298  | `aiTabs: session.aiTabs.map(...)`                            |
| `renderer/utils/tabHelpers.ts`                       | 233  | `session.aiTabs.filter(...)`                                 |
| `renderer/utils/tabHelpers.ts`                       | 420  | `session.aiTabs.filter(...)`                                 |
| `renderer/utils/tabHelpers.ts`                       | 1032 | `session.aiTabs.filter(...)`                                 |

**Total: 82 nested aiTabs.map/filter calls across 25 files**

---

## registerLayer/unregisterLayer by File (non-test)

| Count | File                                                           |
| ----- | -------------------------------------------------------------- |
| 17    | `renderer/components/DocumentGraph/DocumentGraphView.tsx`      |
| 6     | `renderer/hooks/ui/useLayerStack.ts`                           |
| 5     | `renderer/hooks/ui/useModalLayer.ts`                           |
| 5     | `renderer/components/BatchRunnerModal.tsx`                     |
| 4     | `renderer/components/WorktreeConfigModal.tsx`                  |
| 4     | `renderer/components/Wizard/tour/TourOverlay.tsx`              |
| 4     | `renderer/components/Wizard/WizardResumeModal.tsx`             |
| 4     | `renderer/components/Wizard/WizardExitConfirmModal.tsx`        |
| 4     | `renderer/components/Wizard/ExistingDocsModal.tsx`             |
| 4     | `renderer/components/Wizard/ExistingAutoRunDocsModal.tsx`      |
| 4     | `renderer/components/UsageDashboard/UsageDashboardModal.tsx`   |
| 4     | `renderer/components/TransferProgressModal.tsx`                |
| 4     | `renderer/components/TerminalSearchBar.tsx`                    |
| 4     | `renderer/components/TerminalOutput.tsx`                       |
| 4     | `renderer/components/TabSwitcherModal.tsx`                     |
| 4     | `renderer/components/SymphonyModal.tsx`                        |
| 4     | `renderer/components/SummarizeProgressModal.tsx`               |
| 4     | `renderer/components/StandingOvationOverlay.tsx`               |
| 4     | `renderer/components/SendToAgentModal.tsx`                     |
| 4     | `renderer/components/QuitConfirmModal.tsx`                     |
| 4     | `renderer/components/QuickActionsModal.tsx`                    |
| 4     | `renderer/components/PromptComposerModal.tsx`                  |
| 4     | `renderer/components/ProcessMonitor.tsx`                       |
| 4     | `renderer/components/PlaygroundPanel.tsx`                      |
| 4     | `renderer/components/MergeSessionModal.tsx`                    |
| 4     | `renderer/components/MergeProgressModal.tsx`                   |
| 4     | `renderer/components/MarketplaceModal.tsx`                     |
| 4     | `renderer/components/LogViewer.tsx`                            |
| 4     | `renderer/components/LightboxModal.tsx`                        |
| 4     | `renderer/components/LeaderboardRegistrationModal.tsx`         |
| 4     | `renderer/components/KeyboardMasteryCelebration.tsx`           |
| 4     | `renderer/components/InlineWizard/WizardExitConfirmDialog.tsx` |
| 4     | `renderer/components/HistoryDetailModal.tsx`                   |
| 4     | `renderer/components/GitLogViewer.tsx`                         |
| 4     | `renderer/components/FirstRunCelebration.tsx`                  |
| 4     | `renderer/components/FileSearchModal.tsx`                      |
| 4     | `renderer/components/FilePreview.tsx`                          |
| 4     | `renderer/components/FileExplorerPanel.tsx`                    |
| 4     | `renderer/components/ExecutionQueueBrowser.tsx`                |
| 4     | `renderer/components/DocumentsPanel.tsx`                       |
| 4     | `renderer/components/DirectorNotes/DirectorNotesModal.tsx`     |
| 4     | `renderer/components/CueModal.tsx`                             |
| 4     | `renderer/components/CreateWorktreeModal.tsx`                  |
| 4     | `renderer/components/CreatePRModal.tsx`                        |
| 4     | `renderer/components/AutoRunSearchBar.tsx`                     |
| 4     | `renderer/components/AutoRunLightbox.tsx`                      |
| 4     | `renderer/components/AutoRunExpandedModal.tsx`                 |
| 4     | `renderer/components/AgentSessionsModal.tsx`                   |
| 4     | `renderer/components/AgentSessionsBrowser.tsx`                 |
| 4     | `renderer/components/AgentPromptComposerModal.tsx`             |
| 4     | `renderer/components/AgentCreationDialog.tsx`                  |
| 3     | `renderer/components/Settings/SettingsModal.tsx`               |
| 3     | `renderer/components/GitDiffViewer.tsx`                        |

**Total: 53 files with registerLayer/unregisterLayer boilerplate.** The `useModalLayer.ts` hook exists but only 1-2 files use it. The other 50+ files duplicate the same pattern manually.

---

## Most Common Toast Notification Titles

| Count | Title                                  |
| ----- | -------------------------------------- |
| 4     | `Debug Package Failed`                 |
| 3     | `Error`                                |
| 2     | `Worktree Created`                     |
| 2     | `New Worktree Discovered`              |
| 2     | `Failed to Create Worktree`            |
| 2     | `Debug Package Created`                |
| 2     | `Compaction Failed`                    |
| 2     | `Agent Creation Failed`                |
| 1     | `Auto Run: ${errorTitle}` (template)   |
| 1     | `Worktrees Discovered`                 |
| 1     | `Worktrees Disabled`                   |
| 1     | `Worktree Error`                       |
| 1     | `Worktree Agent Not Found`             |
| 1     | `Test Notification`                    |
| 1     | `Target Agent Busy`                    |
| 1     | `Synopsis`                             |
| 1     | `Symphony: PR Ready for Review`        |
| 1     | `Symphony: Manual Finalization Needed` |
| 1     | `Symphony: Auto-Finalize Failed`       |
| 1     | `Symphony Error`                       |
| 1     | `Statistics Database`                  |
| 1     | `Session Merged`                       |
| 1     | `Pull Request Created`                 |
| 1     | `Playbook Imported`                    |
| 1     | `PR Creation Failed`                   |
| 1     | `PR Created`                           |
| 1     | `Nothing to Publish`                   |
| 1     | `Nothing to Copy`                      |
| 1     | `No Remote URL`                        |
| 1     | `Install GUID Copied`                  |

**Total notifyToast calls: 65+ across 18 files**
