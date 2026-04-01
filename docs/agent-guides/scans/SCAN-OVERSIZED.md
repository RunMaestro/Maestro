# SCAN-OVERSIZED.md - Oversized Files

Generated: 2026-03-20 via `wc -l` and `grep -cE` against `src/`

---

## Source Files Over 800 Lines (excluding tests)

| Lines | File                                                               |
| ----- | ------------------------------------------------------------------ |
| 3619  | `renderer/App.tsx`                                                 |
| 3301  | `main/ipc/handlers/symphony.ts`                                    |
| 2839  | `renderer/components/TabBar.tsx`                                   |
| 2662  | `renderer/components/FilePreview.tsx`                              |
| 2610  | `renderer/components/SymphonyModal.tsx`                            |
| 2287  | `renderer/components/AutoRun.tsx`                                  |
| 2142  | `renderer/components/DocumentGraph/DocumentGraphView.tsx`          |
| 2047  | `renderer/hooks/batch/useBatchProcessor.ts`                        |
| 1987  | `renderer/components/MainPanel.tsx`                                |
| 1975  | `generated/prompts.ts`                                             |
| 1928  | `renderer/utils/tabHelpers.ts`                                     |
| 1923  | `renderer/stores/settingsStore.ts`                                 |
| 1908  | `main/ipc/handlers/claude.ts`                                      |
| 1845  | `renderer/components/NewInstanceModal.tsx`                         |
| 1785  | `renderer/components/TerminalOutput.tsx`                           |
| 1759  | `main/storage/opencode-session-storage.ts`                         |
| 1749  | `renderer/components/ProcessMonitor.tsx`                           |
| 1668  | `renderer/components/QuickActionsModal.tsx`                        |
| 1625  | `renderer/hooks/tabs/useTabHandlers.ts`                            |
| 1608  | `renderer/components/PlaygroundPanel.tsx`                          |
| 1578  | `renderer/hooks/agent/useAgentListeners.ts`                        |
| 1575  | `main/group-chat/group-chat-router.ts`                             |
| 1539  | `renderer/components/FileExplorerPanel.tsx`                        |
| 1534  | `renderer/components/AgentSessionsBrowser.tsx`                     |
| 1521  | `renderer/components/Wizard/screens/ConversationScreen.tsx`        |
| 1460  | `main/ipc/handlers/git.ts`                                         |
| 1434  | `renderer/components/MarketplaceModal.tsx`                         |
| 1425  | `renderer/components/Wizard/screens/AgentSelectionScreen.tsx`      |
| 1411  | `web/mobile/MobileHistoryPanel.tsx`                                |
| 1392  | `main/storage/codex-session-storage.ts`                            |
| 1375  | `renderer/components/LeaderboardRegistrationModal.tsx`             |
| 1366  | `renderer/components/DocumentGraph/MindMap.tsx`                    |
| 1353  | `renderer/components/Wizard/services/phaseGenerator.ts`            |
| 1339  | `renderer/components/SessionList/SessionList.tsx`                  |
| 1330  | `web/mobile/App.tsx`                                               |
| 1329  | `renderer/hooks/wizard/useWizardHandlers.ts`                       |
| 1307  | `renderer/components/DocumentsPanel.tsx`                           |
| 1294  | `renderer/services/inlineWizardDocumentGeneration.ts`              |
| 1286  | `main/ipc/handlers/autorun.ts`                                     |
| 1234  | `renderer/components/InlineWizard/DocumentGenerationView.tsx`      |
| 1228  | `renderer/components/UsageDashboard/UsageDashboardModal.tsx`       |
| 1200  | `renderer/components/DocumentGraph/graphDataBuilder.ts`            |
| 1196  | `renderer/hooks/input/useInputProcessing.ts`                       |
| 1172  | `renderer/components/InputArea.tsx`                                |
| 1167  | `web/mobile/SessionPillBar.tsx`                                    |
| 1142  | `main/storage/claude-session-storage.ts`                           |
| 1085  | `main/ipc/handlers/agents.ts`                                      |
| 1070  | `web/mobile/ResponseViewer.tsx`                                    |
| 1066  | `renderer/stores/modalStore.ts`                                    |
| 1065  | `renderer/components/MergeSessionModal.tsx`                        |
| 1062  | `renderer/components/Settings/tabs/GeneralTab.tsx`                 |
| 1056  | `renderer/components/AppModals/AppModals.tsx`                      |
| 1049  | `renderer/components/Wizard/services/conversationManager.ts`       |
| 1046  | `renderer/components/TabSwitcherModal.tsx`                         |
| 1020  | `renderer/components/Wizard/WizardContext.tsx`                     |
| 1009  | `renderer/components/CueModal.tsx`                                 |
| 1001  | `main/parsers/error-patterns.ts`                                   |
| 1000  | `main/ipc/handlers/marketplace.ts`                                 |
| 975   | `renderer/components/UsageDashboard/ActivityHeatmap.tsx`           |
| 974   | `renderer/types/index.ts`                                          |
| 971   | `main/ipc/handlers/agentSessions.ts`                               |
| 965   | `renderer/hooks/modal/useModalHandlers.ts`                         |
| 962   | `renderer/components/DocumentGraph/mindMapLayouts.ts`              |
| 951   | `main/web-server/handlers/messageHandlers.ts`                      |
| 949   | `renderer/components/BatchRunnerModal.tsx`                         |
| 943   | `renderer/components/CueHelpModal.tsx`                             |
| 937   | `renderer/hooks/keyboard/useMainKeyboardHandler.ts`                |
| 935   | `web/mobile/CommandInputBar.tsx`                                   |
| 934   | `web/hooks/useWebSocket.ts`                                        |
| 927   | `main/index.ts`                                                    |
| 914   | `renderer/components/Wizard/screens/PreparingPlanScreen.tsx`       |
| 900   | `main/ipc/handlers/groupChat.ts`                                   |
| 874   | `main/ipc/handlers/process.ts`                                     |
| 872   | `renderer/services/inlineWizardConversation.ts`                    |
| 860   | `renderer/components/Wizard/screens/DirectorySelectionScreen.tsx`  |
| 849   | `renderer/components/CuePipelineEditor/panels/NodeConfigPanel.tsx` |
| 845   | `renderer/hooks/worktree/useWorktreeHandlers.ts`                   |
| 839   | `main/utils/remote-fs.ts`                                          |
| 832   | `main/stats/stats-db.ts`                                           |
| 831   | `renderer/components/RightPanel.tsx`                               |
| 827   | `renderer/components/Settings/SshRemoteModal.tsx`                  |
| 826   | `renderer/hooks/agent/useMergeSession.ts`                          |
| 808   | `renderer/components/DocumentGraph/layoutAlgorithms.ts`            |

**Total: 82 source files exceed 800-line limit.**

### By severity:

- **3000+ lines (critical):** 3 files (App.tsx, symphony handler, TabBar)
- **2000-3000 lines:** 7 files
- **1500-2000 lines:** 12 files
- **1000-1500 lines:** 28 files
- **800-1000 lines:** 32 files

---

## Test Files Over 2000 Lines

| Lines | File                                                                     |
| ----- | ------------------------------------------------------------------------ |
| 6203  | `__tests__/main/ipc/handlers/symphony.test.ts`                           |
| 5988  | `__tests__/renderer/hooks/useBatchProcessor.test.ts`                     |
| 5752  | `__tests__/renderer/components/TabBar.test.tsx`                          |
| 4455  | `__tests__/main/ipc/handlers/git.test.ts`                                |
| 3514  | `__tests__/renderer/components/AutoRun.test.tsx`                         |
| 3460  | `__tests__/renderer/components/MainPanel.test.tsx`                       |
| 3238  | `__tests__/renderer/components/SessionList.test.tsx`                     |
| 3176  | `__tests__/renderer/components/DocumentGraph/DocumentGraphView.test.tsx` |
| 3130  | `__tests__/renderer/utils/tabHelpers.test.ts`                            |
| 3101  | `__tests__/integration/symphony.integration.test.ts`                     |
| 3007  | `__tests__/renderer/components/AgentSessionsBrowser.test.tsx`            |
| 2791  | `__tests__/integration/provider-integration.test.ts`                     |
| 2776  | `__tests__/main/cue/cue-engine.test.ts`                                  |
| 2689  | `__tests__/renderer/components/NewInstanceModal.test.tsx`                |
| 2537  | `__tests__/renderer/components/TabSwitcherModal.test.tsx`                |
| 2508  | `__tests__/renderer/hooks/useMainKeyboardHandler.test.ts`                |
| 2507  | `__tests__/renderer/hooks/useWizardHandlers.test.ts`                     |
| 2506  | `__tests__/renderer/components/BatchRunnerModal.test.tsx`                |
| 2469  | `__tests__/renderer/components/SettingsModal.test.tsx`                   |
| 2465  | `__tests__/renderer/components/AgentSessionsModal.test.tsx`              |
| 2326  | `__tests__/web/mobile/App.test.tsx`                                      |
| 2262  | `__tests__/renderer/components/InputArea.test.tsx`                       |
| 2224  | `__tests__/renderer/components/TerminalOutput.test.tsx`                  |
| 2166  | `__tests__/renderer/components/Wizard/WizardIntegration.test.tsx`        |
| 2144  | `__tests__/main/agents/session-storage.test.ts`                          |
| 2103  | `__tests__/main/ipc/handlers/claude.test.ts`                             |
| 2065  | `__tests__/web/hooks/useWebSocket.test.ts`                               |
| 2007  | `__tests__/renderer/components/UsageDashboardModal.test.tsx`             |

**Total: 28 test files exceed 2000-line limit.**

---

## Files with 20+ Function Definitions

Counted via `export (async )?function` and `export const name = (async )?(` patterns:

| Functions | File                                     |
| --------- | ---------------------------------------- |
| 49        | `main/ipc/handlers/symphony.ts`          |
| 38        | `renderer/utils/tabHelpers.ts`           |
| 28        | `main/preload/process.ts`                |
| 26        | `renderer/components/FilePreview.tsx`    |
| 26        | `main/group-chat/group-chat-storage.ts`  |
| 25        | `main/ipc/handlers/claude.ts`            |
| 24        | `cli/output/formatter.ts`                |
| 22        | `cli/services/agent-spawner.ts`          |
| 21        | `cli/services/storage.ts`                |
| 20        | `renderer/utils/contextExtractor.ts`     |
| 20        | `renderer/components/ProcessMonitor.tsx` |
| 20        | `main/ipc/handlers/marketplace.ts`       |

**Total: 12 files with 20+ functions.**

---

## Summary

| Metric                    | Count |
| ------------------------- | ----- |
| Source files > 800 lines  | 82    |
| Source files > 2000 lines | 10    |
| Source files > 3000 lines | 3     |
| Test files > 2000 lines   | 28    |
| Files with 20+ functions  | 12    |

### Top 5 worst offenders (lines + function count + other issues):

1. **`renderer/App.tsx`** - 3619 lines, 22 setSessions calls
2. **`main/ipc/handlers/symphony.ts`** - 3301 lines, 49 functions, 20 ipcMain.handle
3. **`renderer/components/TabBar.tsx`** - 2839 lines
4. **`renderer/components/FilePreview.tsx`** - 2662 lines, 26 functions
5. **`renderer/components/SymphonyModal.tsx`** - 2610 lines, 9 spinners
