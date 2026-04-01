# SCAN-COMPONENTS.md - Component Pattern Duplicates

Generated: 2026-03-20 via `grep -rn` against `src/`

---

## Most Repeated className Combinations (5+ occurrences)

| Count | className                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------- |
| 338   | `"w-4 h-4"`                                                                                             |
| 294   | `"w-3 h-3"`                                                                                             |
| 195   | `"text-xs"`                                                                                             |
| 187   | `"w-3.5 h-3.5"`                                                                                         |
| 158   | `"w-5 h-5"`                                                                                             |
| 136   | `"flex items-center gap-2"`                                                                             |
| 120   | `"text-sm"`                                                                                             |
| 81    | `"text-sm font-medium"`                                                                                 |
| 58    | `"flex items-center gap-3"`                                                                             |
| 56    | `"flex-1"`                                                                                              |
| 45    | `"relative"`                                                                                            |
| 39    | `"p-4 rounded-lg"`                                                                                      |
| 39    | `"p-1 rounded hover:bg-white/10 transition-colors"`                                                     |
| 38    | `"font-medium"`                                                                                         |
| 37    | `"font-bold"`                                                                                           |
| 32    | `"flex-1 min-w-0"`                                                                                      |
| 32    | `"flex items-center gap-2 mb-3"`                                                                        |
| 31    | `"w-4 h-4 animate-spin"`                                                                                |
| 31    | `"flex items-center gap-1"`                                                                             |
| 30    | `"space-y-2"`                                                                                           |
| 26    | `"text-sm font-bold"`                                                                                   |
| 26    | `"flex items-start gap-3"`                                                                              |
| 26    | `"flex gap-2"`                                                                                          |
| 25    | `"w-2.5 h-2.5"`                                                                                         |
| 24    | `"text-xs font-medium"`                                                                                 |
| 24    | `"flex items-center gap-1.5"`                                                                           |
| 23    | `"w-full"`                                                                                              |
| 23    | `"w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"` |
| 23    | `"w-4 h-4 flex-shrink-0"`                                                                               |
| 23    | `"space-y-3"`                                                                                           |
| 22    | `"w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"`      |
| 22    | `"px-1.5 py-0.5 rounded text-xs"`                                                                       |
| 21    | `"w-6 h-6"`                                                                                             |
| 21    | `"text-xs mt-1"`                                                                                        |
| 20    | `"text-sm leading-relaxed"`                                                                             |
| 20    | `"flex items-center gap-2 mb-2"`                                                                        |
| 20    | `"block text-xs font-bold opacity-70 uppercase mb-2"`                                                   |
| 19    | `"text-sm space-y-2 pl-7"`                                                                              |
| 19    | `"p-4 rounded-lg border"`                                                                               |
| 18    | `"truncate"`                                                                                            |

---

## Ghost Icon Button Pattern Locations

The "ghost icon button" is `p-1 rounded hover:bg-white/10 transition-colors` (or `p-1.5` variant). **39+ exact matches** of the `p-1` variant and **many more `p-1.5` variants**. These are inline `<button>` elements with no shared component.

### `p-1 rounded hover:bg-white/10 transition-colors` (exact)

| File                                                       | Lines                |
| ---------------------------------------------------------- | -------------------- |
| `renderer/components/AboutModal.tsx`                       | 133, 143, 155, 165   |
| `renderer/components/AgentSessionsModal.tsx`               | 451                  |
| `renderer/components/AutoRunExpandedModal.tsx`             | 435                  |
| `renderer/components/AutoRunSearchBar.tsx`                 | 105, 114, 124        |
| `renderer/components/BatchRunnerModal.tsx`                 | 518, 526             |
| `renderer/components/CreatePRModal.tsx`                    | 230                  |
| `renderer/components/CreateWorktreeModal.tsx`              | 140                  |
| `renderer/components/DebugPackageModal.tsx`                | 270                  |
| `renderer/components/DirectorNotes/DirectorNotesModal.tsx` | 210                  |
| `renderer/components/DocumentsPanel.tsx`                   | 481, 489, 1084, 1099 |
| `renderer/components/FileExplorerPanel.tsx`                | 1135, 1144           |
| `renderer/components/FilePreview.tsx`                      | 2155                 |
| `renderer/components/GroupChatInfoOverlay.tsx`             | 62, 273              |
| `renderer/components/GroupChatModal.tsx`                   | 248                  |
| `renderer/components/HistoryDetailModal.tsx`               | 227                  |
| `renderer/components/LeaderboardRegistrationModal.tsx`     | 801                  |
| `renderer/components/MainPanel.tsx`                        | 1083, 1126, 1631     |
| `renderer/components/MarketplaceModal.tsx`                 | 1144                 |
| `renderer/components/MergeProgressModal.tsx`               | 310                  |
| `renderer/components/MergeProgressOverlay.tsx`             | 247                  |
| `renderer/components/MergeSessionModal.tsx`                | 623                  |
| `renderer/components/NewInstanceModal.tsx`                 | 854, 1592            |
| `renderer/components/PlaygroundPanel.tsx`                  | 600                  |
| `renderer/components/SendToAgentModal.tsx`                 | 476                  |
| `renderer/components/ShortcutsHelpModal.tsx`               | 76                   |
| `renderer/components/SummarizeProgressModal.tsx`           | 341                  |
| `renderer/components/SummarizeProgressOverlay.tsx`         | 235                  |
| `renderer/components/SymphonyModal.tsx`                    | 1035, 1762           |
| `renderer/components/TransferProgressModal.tsx`            | 387                  |
| `renderer/components/UpdateCheckModal.tsx`                 | 180, 190             |
| `renderer/components/WorktreeConfigModal.tsx`              | 203                  |
| `renderer/components/ui/Modal.tsx`                         | 165                  |
| `renderer/components/shared/AgentSelector.tsx`             | 157                  |

### `p-1.5 rounded hover:bg-white/10 transition-colors` variant

| File                                                   | Lines                |
| ------------------------------------------------------ | -------------------- |
| `renderer/components/AgentCreationDialog.tsx`          | 306                  |
| `renderer/components/AgentPromptComposerModal.tsx`     | 156                  |
| `renderer/components/AgentSessionsBrowser.tsx`         | 722, 730, 1280       |
| `renderer/components/BatchRunnerModal.tsx`             | 780                  |
| `renderer/components/GistPublishModal.tsx`             | 185, 194             |
| `renderer/components/MarketplaceModal.tsx`             | 338, 1230, 1243      |
| `renderer/components/PromptComposerModal.tsx`          | 458, 597             |
| `renderer/components/SessionList/LiveOverlayPanel.tsx` | 356, 367             |
| `renderer/components/Settings/SshRemotesSection.tsx`   | 268, 301, 313        |
| `renderer/components/SymphonyModal.tsx`                | 568, 590, 1855, 1865 |

### `opacity-0 group-hover:opacity-100` variant (show-on-hover)

| File                                                          | Lines                   |
| ------------------------------------------------------------- | ----------------------- |
| `renderer/components/AutoRun.tsx`                             | 397, 434, 2195          |
| `renderer/components/AutoRunExpandedModal.tsx`                | 349                     |
| `renderer/components/CollapsibleJsonViewer.tsx`               | 124                     |
| `renderer/components/ExecutionQueueBrowser.tsx`               | 588                     |
| `renderer/components/GroupChatInput.tsx`                      | 532                     |
| `renderer/components/GroupChatMessages.tsx`                   | 407, 427                |
| `renderer/components/InlineWizard/DocumentGenerationView.tsx` | 210                     |
| `renderer/components/LogFilterControls.tsx`                   | 165                     |
| `renderer/components/LogViewer.tsx`                           | 641                     |
| `renderer/components/PlaygroundPanel.tsx`                     | 1175                    |
| `renderer/components/ProcessMonitor.tsx`                      | 947, 1068, 1106         |
| `renderer/components/QueuedItemsList.tsx`                     | 166                     |
| `renderer/components/SessionItem.tsx`                         | 302                     |
| `renderer/components/SessionList/SessionList.tsx`             | 1023                    |
| `renderer/components/SessionList/SkinnySidebar.tsx`           | 90                      |
| `renderer/components/SessionListItem.tsx`                     | 141                     |
| `renderer/components/TerminalOutput.tsx`                      | 842, 857, 867, 877, 929 |
| `renderer/components/Wizard/shared/DocumentEditor.tsx`        | 61                      |

**Total ghost button instances: 100+ across 40+ files, no shared GhostButton component.**

---

## Spinner Instances (Loader2 animate-spin)

**Total Loader2 render instances (excluding imports): 95+ across 43 files**

Top files by spinner count:

| Count | File                                                       |
| ----- | ---------------------------------------------------------- |
| 9     | `renderer/components/SymphonyModal.tsx`                    |
| 7     | `renderer/components/AgentSessionsBrowser.tsx`             |
| 5     | `renderer/components/DocumentGraph/DocumentGraphView.tsx`  |
| 5     | `renderer/components/AgentSessionsModal.tsx`               |
| 4     | `renderer/components/UpdateCheckModal.tsx`                 |
| 4     | `renderer/components/Settings/SshRemotesSection.tsx`       |
| 4     | `renderer/components/LeaderboardRegistrationModal.tsx`     |
| 3     | `renderer/components/TransferErrorModal.tsx`               |
| 3     | `renderer/components/Settings/SshRemoteModal.tsx`          |
| 3     | `renderer/components/MarketplaceModal.tsx`                 |
| 3     | `renderer/components/MainPanel.tsx`                        |
| 3     | `renderer/components/FilePreview.tsx`                      |
| 3     | `renderer/components/AutoRun.tsx`                          |
| 3     | `renderer/components/AgentCreationDialog.tsx`              |
| 3     | `renderer/components/AboutModal.tsx`                       |
| 2     | `renderer/components/WorktreeConfigModal.tsx`              |
| 2     | `renderer/components/Wizard/screens/PhaseReviewScreen.tsx` |
| 2     | `renderer/components/TabBar.tsx`                           |
| 2     | `renderer/components/SendToAgentModal.tsx`                 |
| 2     | `renderer/components/RightPanel.tsx`                       |
| 2     | `renderer/components/FileExplorerPanel.tsx`                |
| 2     | `renderer/components/DirectorNotes/DirectorNotesModal.tsx` |
| 2     | `renderer/components/DirectorNotes/AIOverviewTab.tsx`      |
| 2     | `renderer/components/DebugPackageModal.tsx`                |
| 2     | `renderer/components/CreatePRModal.tsx`                    |
| 2     | `renderer/components/BatchRunnerModal.tsx`                 |
| 2     | `renderer/components/AutoRunExpandedModal.tsx`             |

Common inline spinner patterns (no shared Spinner component):

- `<Loader2 className="w-4 h-4 animate-spin" />` (most common)
- `<Loader2 className="w-3 h-3 animate-spin" />`
- `<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />`
- `<Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />`

---

## Empty State Pattern Locations

Patterns: "No ... found", "No ... yet", empty state views, empty result messages.

| File                                                          | Line | Text                                                           |
| ------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `renderer/components/EmptyStateView.tsx`                      | 33   | `EmptyStateView` (shared component, used only in App.tsx:3340) |
| `renderer/components/AboutModal.tsx`                          | 330  | "No sessions found"                                            |
| `renderer/components/AgentSessionsBrowser.tsx`                | 1477 | "No ... sessions found for this project"                       |
| `renderer/components/AgentSessionsModal.tsx`                  | 599  | "No Claude sessions found for this project"                    |
| `renderer/components/AutoRun.tsx`                             | 1994 | "No Documents Found"                                           |
| `renderer/components/AutoRun.tsx`                             | 2103 | "_No content yet._"                                            |
| `renderer/components/AutoRunDocumentSelector.tsx`             | 298  | "No markdown files found"                                      |
| `renderer/components/AutoRunSetupModal.tsx`                   | 265  | "Folder found (no markdown documents yet)"                     |
| `renderer/components/CueModal.tsx`                            | 481  | "No activity yet"                                              |
| `renderer/components/DirectorNotes/UnifiedHistoryTab.tsx`     | 600  | "No history entries found across any agents."                  |
| `renderer/components/DocumentGraph/DocumentGraphView.tsx`     | 1763 | "No markdown files found"                                      |
| `renderer/components/DocumentGraph/DocumentGraphView.tsx`     | 2006 | "No documents found"                                           |
| `renderer/components/DocumentsPanel.tsx`                      | 501  | "No documents found in folder"                                 |
| `renderer/components/ExecutionQueueBrowser.tsx`               | 201  | "No items queued"                                              |
| `renderer/components/FileExplorerPanel.tsx`                   | 1262 | "No files found"                                               |
| `renderer/components/GitLogViewer.tsx`                        | 357  | "No commits found"                                             |
| `renderer/components/GroupChatHistoryPanel.tsx`               | 668  | "No task history yet."                                         |
| `renderer/components/GroupChatList.tsx`                       | 310  | "No group chats yet"                                           |
| `renderer/components/GroupChatParticipants.tsx`               | 157  | "No participants yet."                                         |
| `renderer/components/GroupChatRightPanel.tsx`                 | 307  | "No participants yet."                                         |
| `renderer/components/HistoryPanel.tsx`                        | 567  | "No history yet."                                              |
| `renderer/components/InlineWizard/DocumentGenerationView.tsx` | 767  | "_No content yet._"                                            |
| `renderer/components/InlineWizard/DocumentGenerationView.tsx` | 1068 | "No documents generated yet."                                  |
| `renderer/components/LogViewer.tsx`                           | 614  | "No logs yet" / "No logs match your filter"                    |
| `renderer/components/MarketplaceModal.tsx`                    | 1368 | "No results found"                                             |
| `renderer/components/MergeSessionModal.tsx`                   | 754  | "No matching session or tab found"                             |

**Total: 26+ distinct empty state locations, most with duplicated inline styling rather than shared component.**
