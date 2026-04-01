# SCAN-HOOKS.md - Hook Pattern Duplicates

Generated: 2026-03-20 via `grep -rn` against `src/`

---

## setTimeout Focus Pattern (file:line)

Every `setTimeout(() => ref.current?.focus(), N)` instance in production code:

| File                                                            | Line | Delay |
| --------------------------------------------------------------- | ---- | ----- |
| `renderer/App.tsx`                                              | 1053 | 0ms   |
| `renderer/App.tsx`                                              | 2120 | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 373  | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 458  | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 698  | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 791  | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 813  | 50ms  |
| `renderer/components/AgentSessionsBrowser.tsx`                  | 1274 | 50ms  |
| `renderer/components/AgentSessionsModal.tsx`                    | 287  | 50ms  |
| `renderer/components/BatchRunnerModal.tsx`                      | 351  | 100ms |
| `renderer/components/CreateWorktreeModal.tsx`                   | 65   | 50ms  |
| `renderer/components/CuePipelineEditor/drawers/AgentDrawer.tsx` | 49   | 50ms  |
| `renderer/components/FilePreview.tsx`                           | 1705 | 0ms   |
| `renderer/components/FileSearchModal.tsx`                       | 270  | 50ms  |
| `renderer/components/GroupChatHistoryPanel.tsx`                 | 535  | 0ms   |
| `renderer/components/HistoryPanel.tsx`                          | 413  | 0ms   |
| `renderer/components/InputArea.tsx`                             | 573  | 0ms   |
| `renderer/components/InputArea.tsx`                             | 580  | 0ms   |
| `renderer/components/LightboxModal.tsx`                         | 137  | 0ms   |
| `renderer/components/MarketplaceModal.tsx`                      | 845  | 50ms  |
| `renderer/components/MergeSessionModal.tsx`                     | 238  | 50ms  |
| `renderer/components/QuickActionsModal.tsx`                     | 284  | 50ms  |
| `renderer/components/SendToAgentModal.tsx`                      | 208  | 50ms  |
| `renderer/components/Settings/SshRemoteModal.tsx`               | 216  | 0ms   |
| `renderer/components/Settings/tabs/ShortcutsTab.tsx`            | 34   | 50ms  |
| `renderer/components/Settings/tabs/ThemeTab.tsx`                | 40   | 50ms  |
| `renderer/components/SymphonyModal.tsx`                         | 1431 | 50ms  |
| `renderer/components/TabSwitcherModal.tsx`                      | 265  | 50ms  |
| `renderer/hooks/groupChat/useGroupChatHandlers.ts`              | 138  | 0ms   |
| `renderer/hooks/keyboard/useKeyboardNavigation.ts`              | 344  | 0ms   |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 307  | 100ms |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 311  | const |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 426  | 0ms   |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 438  | 0ms   |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 534  | 100ms |
| `renderer/hooks/keyboard/useMainKeyboardHandler.ts`             | 623  | const |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 374  | 0ms   |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 383  | 0ms   |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 392  | 0ms   |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 401  | 0ms   |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 524  | 0ms   |
| `renderer/hooks/modal/useModalHandlers.ts`                      | 589  | 0ms   |
| `renderer/hooks/symphony/useSymphonyContribution.ts`            | 233  | 50ms  |
| `renderer/hooks/wizard/useWizardHandlers.ts`                    | 1208 | 100ms |
| `web/mobile/MobileHistoryPanel.tsx`                             | 948  | 50ms  |

**Total: 45 setTimeout-focus calls across 28 files.** No shared `useFocusAfterRender` hook exists.

---

## addEventListener/removeEventListener Pairs by File (3+ calls)

| Count | File                                                     |
| ----- | -------------------------------------------------------- |
| 10    | `renderer/utils/activityBus.ts`                          |
| 10    | `renderer/components/MarketplaceModal.tsx`               |
| 8     | `renderer/hooks/keyboard/useMainKeyboardHandler.ts`      |
| 8     | `renderer/components/SymphonyModal.tsx`                  |
| 8     | `renderer/App.tsx`                                       |
| 6     | `web/utils/serviceWorker.ts`                             |
| 6     | `web/mobile/TabBar.tsx`                                  |
| 6     | `web/mobile/SlashCommandAutocomplete.tsx`                |
| 6     | `web/mobile/SessionPillBar.tsx`                          |
| 6     | `web/mobile/QuickActionsMenu.tsx`                        |
| 6     | `web/mobile/CommandInputBar.tsx`                         |
| 6     | `renderer/hooks/ui/useResizablePanel.ts`                 |
| 6     | `renderer/hooks/ui/useAppHandlers.ts`                    |
| 6     | `renderer/hooks/modal/useModalHandlers.ts`               |
| 6     | `renderer/components/SessionList/SessionList.tsx`        |
| 5     | `web/hooks/useDeviceColorScheme.ts`                      |
| 4     | `web/mobile/MobileHistoryPanel.tsx`                      |
| 4     | `web/hooks/useKeyboardVisibility.ts`                     |
| 4     | `renderer/hooks/utils/useDebouncedPersistence.ts`        |
| 4     | `renderer/hooks/ui/useClickOutside.ts`                   |
| 4     | `renderer/hooks/session/useHandsOnTimeTracker.ts`        |
| 4     | `renderer/hooks/remote/useMobileLandscape.ts`            |
| 4     | `renderer/components/Wizard/shared/DocumentSelector.tsx` |
| 4     | `renderer/components/TabBar.tsx`                         |
| 4     | `renderer/components/ExecutionQueueBrowser.tsx`          |

Files with exactly 2 (add+remove pair): 38 additional files (see full grep output).

**Total: 63+ files with manual addEventListener/removeEventListener pairs.** Most follow identical useEffect cleanup pattern.

---

## Files That Re-derive activeSession from Store

Every `const activeSession = ...` derivation from sessions/store:

| Count | File                                                |
| ----- | --------------------------------------------------- |
| 3     | `renderer/hooks/worktree/useWorktreeHandlers.ts`    |
| 3     | `renderer/hooks/tabs/useTabHandlers.ts`             |
| 3     | `renderer/hooks/input/useInputHandlers.ts`          |
| 3     | `renderer/App.tsx`                                  |
| 2     | `web/hooks/useMobileSessionManagement.ts`           |
| 2     | `renderer/hooks/session/useSessionLifecycle.ts`     |
| 2     | `renderer/hooks/modal/useQuickActionsHandlers.ts`   |
| 2     | `renderer/hooks/git/useFileExplorerEffects.ts`      |
| 2     | `renderer/hooks/batch/useAutoRunDocumentLoader.ts`  |
| 2     | `renderer/components/AppModals/AppModals.tsx`       |
| 1     | `web/mobile/SessionPillBar.tsx`                     |
| 1     | `web/mobile/ResponseViewer.tsx`                     |
| 1     | `web/hooks/useSessions.ts`                          |
| 1     | `renderer/stores/sessionStore.ts`                   |
| 1     | `renderer/hooks/wizard/useWizardHandlers.ts`        |
| 1     | `renderer/hooks/session/useSessionRestoration.ts`   |
| 1     | `renderer/hooks/session/useCycleSession.ts`         |
| 1     | `renderer/hooks/session/useActivityTracker.ts`      |
| 1     | `renderer/hooks/modal/usePromptComposerHandlers.ts` |
| 1     | `renderer/hooks/modal/useModalHandlers.ts`          |
| 1     | `renderer/hooks/input/useInputKeyDown.ts`           |
| 1     | `renderer/hooks/git/useGitStatusPolling.ts`         |
| 1     | `renderer/hooks/batch/useBatchHandlers.ts`          |
| 1     | `renderer/hooks/agent/useMergeTransferHandlers.ts`  |
| 1     | `renderer/hooks/agent/useInterruptHandler.ts`       |
| 1     | `renderer/components/SessionList/SessionList.tsx`   |
| 1     | `renderer/components/QuickActionsModal.tsx`         |
| 1     | `renderer/components/BatchRunnerModal.tsx`          |

**Total: 28 files re-derive activeSession.** Many could use a shared selector or store hook.

---

## Debounce/Throttle Implementations by File (3+ references)

| Count | File                                                               | Notes                   |
| ----- | ------------------------------------------------------------------ | ----------------------- |
| 23    | `renderer/hooks/batch/useSessionDebounce.ts`                       | Dedicated debounce hook |
| 21    | `renderer/components/CuePipelineEditor/panels/NodeConfigPanel.tsx` | Inline debounce         |
| 18    | `renderer/hooks/utils/useThrottle.ts`                              | Dedicated throttle hook |
| 18    | `main/ipc/handlers/documentGraph.ts`                               | Inline debounce         |
| 13    | `renderer/components/TerminalOutput.tsx`                           | Inline debounce         |
| 11    | `main/cue/cue-yaml-loader.ts`                                      | Inline debounce         |
| 9     | `renderer/hooks/ui/useScrollPosition.ts`                           | Inline throttle         |
| 9     | `main/cue/cue-file-watcher.ts`                                     | Inline debounce         |
| 8     | `renderer/hooks/utils/useDebouncedPersistence.ts`                  | Dedicated debounce hook |
| 8     | `renderer/hooks/batch/useBatchProcessor.ts`                        | Inline debounce         |
| 8     | `renderer/components/DocumentGraph/DocumentGraphView.tsx`          | Inline debounce         |
| 7     | `renderer/hooks/input/useInputHandlers.ts`                         | Inline debounce         |
| 6     | `renderer/hooks/stats/useStats.ts`                                 | Inline throttle         |
| 6     | `renderer/components/UsageDashboard/UsageDashboardModal.tsx`       | Inline debounce         |
| 6     | `renderer/components/HistoryPanel.tsx`                             | Inline debounce         |
| 6     | `main/process-listeners/wakatime-listener.ts`                      | Inline debounce         |
| 4     | `renderer/hooks/utils/index.ts`                                    | Re-exports              |
| 4     | `renderer/hooks/symphony/useSymphony.ts`                           | Inline debounce         |
| 4     | `renderer/hooks/batch/useAutoRunUndo.ts`                           | Inline debounce         |
| 3     | `renderer/components/Wizard/screens/PhaseReviewScreen.tsx`         | Inline debounce         |
| 3     | `renderer/App.tsx`                                                 | Inline debounce         |
| 3     | `main/ipc/handlers/git.ts`                                         | Inline debounce         |

**Shared hooks exist (`useSessionDebounce`, `useThrottle`, `useDebouncedPersistence`) but 15+ files implement debounce/throttle inline instead of using them.**
