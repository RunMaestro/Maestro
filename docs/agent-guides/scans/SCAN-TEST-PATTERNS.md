# SCAN-TEST-PATTERNS

Scan date: 2026-03-20
Source: `src/__tests__/`

---

## Most Common vi.mock Targets

```
grep -oh "vi\.mock('[^']*'" src/__tests__/ -r --include="*.ts" --include="*.tsx" | sort | uniq -c | sort -rn | head -20
```

```
     78 vi.mock('electron')
     51 vi.mock('lucide-react')
     39 vi.mock('../../../../main/utils/logger')
     32 vi.mock('fs')
     29 vi.mock('../../../renderer/contexts/LayerStackContext')
     27 vi.mock('../../../main/utils/logger')
     22 vi.mock('../../../web/components/ThemeProvider')
     20 vi.mock('react-syntax-highlighter/dist/esm/styles/prism')
     20 vi.mock('react-syntax-highlighter')
     19 vi.mock('react-markdown')
     18 vi.mock('remark-gfm')
     18 vi.mock('fs/promises')
     16 vi.mock('../../../renderer/services/git')
     15 vi.mock('os')
     15 vi.mock('../../main/utils/logger')
     15 vi.mock('../../../web/utils/logger')
     14 vi.mock('../../../cli/services/storage')
     13 vi.mock('crypto')
     13 vi.mock('../../../renderer/stores/notificationStore')
     12 vi.mock('electron-store')
```

**Key finding:** `lucide-react` is mocked in 51 individual test files despite already being mocked in `src/__tests__/setup.ts:30`. All 51 per-file mocks are redundant.

---

## Duplicate Test Names

```
grep -oh "it('[^']*'\|it(\"[^\"]*\"" src/__tests__/ -r --include="*.ts" --include="*.tsx" | sort | uniq -c | sort -rn | awk '$1 > 1' | head -20
```

```
     71 it('close')
     44 it('data')
     40 it('\n')
     19 it('/')
     15 it('should remove listener when cleanup is called')
     12 it('should register event listener and return cleanup function')
     12 it('should handle empty content')
     10 it('works with light theme')
     10 it('test-session')
     10 it('should unregister layer on unmount')
     10 it('should register layer on mount')
     10 it('should call callback when event is received')
      9 it('handles empty string')
      9 it('calls onClose when X button is clicked')
      9 it('applies theme colors to modal container')
      8 it('unregisters layer on unmount')
      8 it('registers layer on mount')
      8 it('registers and unregisters without errors')
      8 it('forwards ref')
      8 it('exit')
```

**Key finding:** Boilerplate tests like layer registration, theme colors, and listener cleanup are copy-pasted across dozens of files.

---

## vi.mock lucide-react (Redundant)

Already mocked globally in `src/__tests__/setup.ts:30`. These 51 per-file mocks are unnecessary:

```
grep -rn "vi\.mock.*lucide-react" src/__tests__/ --include="*.ts" --include="*.tsx"
```

| File                                                                                    | Line                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------ |
| `src/__tests__/performance/AutoRunManyDocuments.test.tsx`                               | 97                                   |
| `src/__tests__/performance/AutoRunRapidInteractions.test.tsx`                           | 94                                   |
| `src/__tests__/renderer/components/AboutModal.test.tsx`                                 | 14                                   |
| `src/__tests__/renderer/components/AchievementCard.test.tsx`                            | 43                                   |
| `src/__tests__/renderer/components/AgentPromptComposerModal.test.tsx`                   | 22                                   |
| `src/__tests__/renderer/components/AgentSessionsBrowser.test.tsx`                       | 21                                   |
| `src/__tests__/renderer/components/AppConfirmModals.test.tsx`                           | 19                                   |
| `src/__tests__/renderer/components/AutoRunDocumentSelector.test.tsx`                    | 12                                   |
| `src/__tests__/renderer/components/AutoRunExpandedModal.test.tsx`                       | 32                                   |
| `src/__tests__/renderer/components/AutoRunLightbox.test.tsx`                            | 28                                   |
| `src/__tests__/renderer/components/AutoRunSearchBar.test.tsx`                           | 29                                   |
| `src/__tests__/renderer/components/AutoRunSetupModal.test.tsx`                          | 22                                   |
| `src/__tests__/renderer/components/ConfirmModal.test.tsx`                               | 20                                   |
| `src/__tests__/renderer/components/CreateGroupModal.test.tsx`                           | 19                                   |
| `src/__tests__/renderer/components/CsvTableRenderer.test.tsx`                           | 7                                    |
| `src/__tests__/renderer/components/DeleteAgentConfirmModal.test.tsx`                    | 20                                   |
| `src/__tests__/renderer/components/FileExplorerPanel.test.tsx`                          | 8                                    |
| `src/__tests__/renderer/components/FilePreview.test.tsx`                                | 8                                    |
| `src/__tests__/renderer/components/GistPublishModal.test.tsx`                           | 22                                   |
| `src/__tests__/renderer/components/GroupChatHeader.test.tsx`                            | 6                                    |
| `src/__tests__/renderer/components/GroupChatModals.test.tsx`                            | 15                                   |
| `src/__tests__/renderer/components/HistoryHelpModal.test.tsx`                           | 23                                   |
| `src/__tests__/renderer/components/InlineWizard/WizardModePrompt.test.tsx`              | 22                                   |
| `src/__tests__/renderer/components/LightboxModal.test.tsx`                              | 20                                   |
| `src/__tests__/renderer/components/MarkdownRenderer.test.tsx`                           | 18                                   |
| `src/__tests__/renderer/components/PlaybookDeleteConfirmModal.test.tsx`                 | 14                                   |
| `src/__tests__/renderer/components/PlaybookNameModal.test.tsx`                          | 22                                   |
| `src/__tests__/renderer/components/ProcessMonitor.test.tsx`                             | 13                                   |
| `src/__tests__/renderer/components/PromptComposerModal.test.tsx`                        | 10                                   |
| `src/__tests__/renderer/components/QuickActionsModal.test.tsx`                          | 72                                   |
| `src/__tests__/renderer/components/QuitConfirmModal.test.tsx`                           | 21                                   |
| `src/__tests__/renderer/components/RenameGroupModal.test.tsx`                           | 19                                   |
| `src/__tests__/renderer/components/RightPanel.test.tsx`                                 | 54                                   |
| `src/__tests__/renderer/components/SessionItemCue.test.tsx`                             | 14                                   |
| `src/__tests__/renderer/components/SessionList.test.tsx`                                | 30                                   |
| `src/__tests__/renderer/components/shared/AgentConfigPanel.test.tsx`                    | 14                                   |
| `src/__tests__/renderer/components/SymphonyModal.test.tsx`                              | 59                                   |
| `src/__tests__/renderer/components/TabBar.test.tsx`                                     | 9                                    |
| `src/__tests__/renderer/components/TabSwitcherModal.test.tsx`                           | 23                                   |
| `src/__tests__/renderer/components/TransferErrorModal.test.tsx`                         | 26                                   |
| `src/__tests__/renderer/components/TransferProgressModal.test.tsx`                      | 24                                   |
| `src/__tests__/renderer/components/UsageDashboard/ChartErrorBoundary.test.tsx`          | 12                                   |
| `src/__tests__/renderer/components/UsageDashboard/responsive-layout.test.tsx`           | 22                                   |
| `src/__tests__/renderer/components/UsageDashboard/state-transition-animations.test.tsx` | 22                                   |
| `src/__tests__/renderer/components/UsageDashboardModal.test.tsx`                        | 13                                   |
| `src/__tests__/renderer/components/WindowsWarningModal.test.tsx`                        | 22                                   |
| `src/__tests__/renderer/components/Wizard/WizardIntegration.test.tsx`                   | 30                                   |
| `src/__tests__/renderer/components/Wizard/WizardKeyboardNavigation.test.tsx`            | 23                                   |
| `src/__tests__/renderer/components/Wizard/WizardThemeStyles.test.tsx`                   | 23                                   |
| `src/__tests__/setup.ts`                                                                | 30 (global mock - the canonical one) |
| `src/__tests__/web/mobile/MessageHistory.test.tsx`                                      | 30                                   |

---

## Logger Mock Copies

128 matches across 100 files. Logger is mocked via 4 different relative paths depending on test location:

```
grep -rn "vi\.mock.*logger" src/__tests__/ --include="*.ts" --include="*.tsx"
```

**Path variants (vi.mock definitions only):**

| Path                                | Count | Example files                               |
| ----------------------------------- | ----- | ------------------------------------------- |
| `../../../../main/utils/logger`     | 39    | ipc/handlers/\*.test.ts                     |
| `../../../main/utils/logger`        | 27    | main/agents/_.test.ts, main/stats/_.test.ts |
| `../../main/utils/logger`           | 15    | main/\*.test.ts (top-level)                 |
| `../../../web/utils/logger`         | 15    | web/hooks/\*.test.ts                        |
| `../../../renderer/utils/logger`    | 1     | renderer/components/ErrorBoundary.test.tsx  |
| `../../../../renderer/utils/logger` | 1     | UsageDashboard/ChartErrorBoundary.test.tsx  |

All use the same mock shape: `{ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }`.

---

## renderWithLayerStack Copies

17 independent definitions of `renderWithLayerStack` across test files:

```
grep -rn "renderWithLayerStack" src/__tests__/ --include="*.ts" --include="*.tsx" | grep "const renderWithLayerStack\|function renderWithLayerStack"
```

| File                                                                       | Line |
| -------------------------------------------------------------------------- | ---- |
| `src/__tests__/renderer/components/AgentPromptComposerModal.test.tsx`      | 102  |
| `src/__tests__/renderer/components/AppConfirmModals.test.tsx`              | 69   |
| `src/__tests__/renderer/components/AutoRunSetupModal.test.tsx`             | 54   |
| `src/__tests__/renderer/components/ConfirmModal.test.tsx`                  | 50   |
| `src/__tests__/renderer/components/CreateGroupModal.test.tsx`              | 83   |
| `src/__tests__/renderer/components/DeleteAgentConfirmModal.test.tsx`       | 51   |
| `src/__tests__/renderer/components/GistPublishModal.test.tsx`              | 75   |
| `src/__tests__/renderer/components/InlineWizard/WizardModePrompt.test.tsx` | 51   |
| `src/__tests__/renderer/components/LightboxModal.test.tsx`                 | 47   |
| `src/__tests__/renderer/components/MergeSessionModal.test.tsx`             | 138  |
| `src/__tests__/renderer/components/QuitConfirmModal.test.tsx`              | 46   |
| `src/__tests__/renderer/components/RenameGroupModal.test.tsx`              | 80   |
| `src/__tests__/renderer/components/SendToAgentModal.test.tsx`              | 192  |
| `src/__tests__/renderer/components/TabSwitcherModal.test.tsx`              | 76   |
| `src/__tests__/renderer/components/TransferErrorModal.test.tsx`            | 76   |
| `src/__tests__/renderer/components/TransferProgressModal.test.tsx`         | 70   |
| `src/__tests__/renderer/components/WindowsWarningModal.test.tsx`           | 56   |

---

## LayerStackContext Mock Copies

40 matches across 27 files. Three patterns observed:

```
grep -rn "LayerStackContext\|layerStack.*mock\|registerLayer.*vi.fn" src/__tests__/ --include="*.ts" --include="*.tsx" | head -40
```

**Pattern 1 - Import LayerStackProvider (wraps in real context):**

- `src/__tests__/integration/AutoRunBatchProcessing.test.tsx:17`
- `src/__tests__/integration/AutoRunRightPanel.test.tsx:17`
- `src/__tests__/integration/AutoRunSessionList.test.tsx:16`
- `src/__tests__/performance/AutoRunLargeDocument.test.tsx:15`
- `src/__tests__/performance/AutoRunManyDocuments.test.tsx:19`
- `src/__tests__/performance/AutoRunMemoryLeaks.test.tsx:16`
- `src/__tests__/performance/AutoRunRapidInteractions.test.tsx:16`
- `src/__tests__/performance/ThinkingStreamPerformance.test.tsx:15`
- `src/__tests__/renderer/components/AgentPromptComposerModal.test.tsx:18`
- `src/__tests__/renderer/components/AgentSessionsBrowser.test.tsx:17`
- `src/__tests__/renderer/components/AppConfirmModals.test.tsx:15`
- `src/__tests__/renderer/components/AutoRun.test.tsx:10`
- `src/__tests__/renderer/components/AutoRunBlurSaveTiming.test.tsx:23`
- `src/__tests__/renderer/components/AutoRunContentSync.test.tsx:16`
- `src/__tests__/renderer/components/AutoRunExpandedModal.test.tsx:18`
- `src/__tests__/renderer/components/AutoRunLightbox.test.tsx:18`
- `src/__tests__/renderer/components/AutoRunSearchBar.test.tsx:20`
- `src/__tests__/renderer/components/AutoRunSessionIsolation.test.tsx:16`
- `src/__tests__/renderer/components/AutoRunSetupModal.test.tsx:17`
- `src/__tests__/renderer/components/ConfirmModal.test.tsx:16`
- `src/__tests__/renderer/components/CreateGroupModal.test.tsx:15`

**Pattern 2 - vi.mock with vi.fn() (mocks registerLayer/unregisterLayer):**

- `src/__tests__/renderer/components/AboutModal.test.tsx:74,77`
- `src/__tests__/renderer/components/AgentSessionsModal.test.tsx:6,8,11`
- `src/__tests__/renderer/components/AppModals-selfSourced.test.tsx:127,128,130,131`
- `src/__tests__/renderer/components/AutoRunnerHelpModal.test.tsx:13,17,20`
- `src/__tests__/renderer/components/BatchRunnerModal.test.tsx:11,13,16`
- `src/__tests__/renderer/components/auto-scroll.test.tsx:53,55,56`

---

## Test Files Over 2000 Lines

```
find src/__tests__ -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | awk '$1 > 2000'
```

| Lines | File                                                                         |
| ----- | ---------------------------------------------------------------------------- |
| 6203  | `src/__tests__/main/ipc/handlers/symphony.test.ts`                           |
| 5988  | `src/__tests__/renderer/hooks/useBatchProcessor.test.ts`                     |
| 5752  | `src/__tests__/renderer/components/TabBar.test.tsx`                          |
| 4455  | `src/__tests__/main/ipc/handlers/git.test.ts`                                |
| 3514  | `src/__tests__/renderer/components/AutoRun.test.tsx`                         |
| 3460  | `src/__tests__/renderer/components/MainPanel.test.tsx`                       |
| 3238  | `src/__tests__/renderer/components/SessionList.test.tsx`                     |
| 3176  | `src/__tests__/renderer/components/DocumentGraph/DocumentGraphView.test.tsx` |
| 3130  | `src/__tests__/renderer/utils/tabHelpers.test.ts`                            |
| 3101  | `src/__tests__/integration/symphony.integration.test.ts`                     |
| 3007  | `src/__tests__/renderer/components/AgentSessionsBrowser.test.tsx`            |
| 2791  | `src/__tests__/integration/provider-integration.test.ts`                     |
| 2776  | `src/__tests__/main/cue/cue-engine.test.ts`                                  |
| 2689  | `src/__tests__/renderer/components/NewInstanceModal.test.tsx`                |
| 2537  | `src/__tests__/renderer/components/TabSwitcherModal.test.tsx`                |
| 2508  | `src/__tests__/renderer/hooks/useMainKeyboardHandler.test.ts`                |
| 2507  | `src/__tests__/renderer/hooks/useWizardHandlers.test.ts`                     |
| 2506  | `src/__tests__/renderer/components/BatchRunnerModal.test.tsx`                |
| 2469  | `src/__tests__/renderer/components/SettingsModal.test.tsx`                   |

Total test lines: 463,231
