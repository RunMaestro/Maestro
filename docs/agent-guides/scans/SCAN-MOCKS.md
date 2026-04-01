# SCAN-MOCKS.md - Test Mock Duplicates

Generated via `grep -rn` on `src/`. All matches are file:line verified.

---

## createMockSession definitions (66 total)

Every test file that defines its own `createMockSession` factory:

```
src/__tests__/integration/AutoRunRightPanel.test.tsx:172
src/__tests__/integration/AutoRunSessionList.test.tsx:226
src/__tests__/main/cue/cue-executor.test.ts:160
src/__tests__/main/cue/cue-test-helpers.ts:14
src/__tests__/main/web-server/services/broadcastService.test.ts:90
src/__tests__/renderer/components/AgentSessionsModal.test.tsx:56
src/__tests__/renderer/components/AppAgentModals.test.tsx:50
src/__tests__/renderer/components/AppConfirmModals.test.tsx:46
src/__tests__/renderer/components/AppModals-selfSourced.test.tsx:166
src/__tests__/renderer/components/AppSessionModals.test.tsx:55
src/__tests__/renderer/components/AppWorktreeModals.test.tsx:39
src/__tests__/renderer/components/FileExplorerPanel.test.tsx:219
src/__tests__/renderer/components/GroupChatInput.test.tsx:49
src/__tests__/renderer/components/HistoryPanel.test.tsx:130
src/__tests__/renderer/components/InlineWizard/WizardInputPanel.test.tsx:59
src/__tests__/renderer/components/InputArea.test.tsx:124
src/__tests__/renderer/components/MergeSessionModal.test.tsx:67
src/__tests__/renderer/components/PromptComposerModal.test.tsx:1107
src/__tests__/renderer/components/QuickActionsModal.test.tsx:117
src/__tests__/renderer/components/RenameSessionModal.test.tsx:39
src/__tests__/renderer/components/SendToAgentModal.test.tsx:139
src/__tests__/renderer/components/SessionItemCue.test.tsx:52
src/__tests__/renderer/components/SessionList.test.tsx:163
src/__tests__/renderer/components/ThinkingStatusPill.test.tsx:43
src/__tests__/renderer/components/WorktreeRunSection.test.tsx:38
src/__tests__/renderer/hooks/batch/useAutoRunHandlers.worktree.test.ts:54
src/__tests__/renderer/hooks/useAgentExecution.test.ts:20
src/__tests__/renderer/hooks/useAgentListeners.test.ts:42
src/__tests__/renderer/hooks/useAgentSessionManagement.test.ts:28
src/__tests__/renderer/hooks/useAtMentionCompletion.test.ts:18
src/__tests__/renderer/hooks/useAutoRunAchievements.test.ts:98
src/__tests__/renderer/hooks/useAutoRunDocumentLoader.test.ts:32
src/__tests__/renderer/hooks/useAutoRunHandlers.test.ts:46
src/__tests__/renderer/hooks/useAvailableAgents.test.ts:54
src/__tests__/renderer/hooks/useBatchHandlers.test.ts:91
src/__tests__/renderer/hooks/useBatchProcessor.test.ts:580
src/__tests__/renderer/hooks/useFileExplorerEffects.test.ts:52
src/__tests__/renderer/hooks/useFileTreeManagement.test.ts:40
src/__tests__/renderer/hooks/useGitStatusPolling.test.ts:23
src/__tests__/renderer/hooks/useGroupManagement.test.ts:29
src/__tests__/renderer/hooks/useInputHandlers.test.ts:153
src/__tests__/renderer/hooks/useInputProcessing.test.ts:44
src/__tests__/renderer/hooks/useKeyboardNavigation.test.ts:7
src/__tests__/renderer/hooks/useMergeSession.test.ts:102
src/__tests__/renderer/hooks/useMergeTransferHandlers.test.ts:138
src/__tests__/renderer/hooks/useModalHandlers.test.ts:44
src/__tests__/renderer/hooks/useRemoteHandlers.test.ts:69
src/__tests__/renderer/hooks/useRemoteIntegration.test.ts:20
src/__tests__/renderer/hooks/useSendToAgent.test.ts:103
src/__tests__/renderer/hooks/useSessionLifecycle.test.ts:49
src/__tests__/renderer/hooks/useSessionRestoration.test.ts:48
src/__tests__/renderer/hooks/useSummarizeHandler.test.ts:92
src/__tests__/renderer/hooks/useTabCompletion.test.ts:12
src/__tests__/renderer/hooks/useTabExportHandlers.test.ts:90
src/__tests__/renderer/hooks/useTabHandlers.test.ts:62
src/__tests__/renderer/hooks/useWizardHandlers.test.ts:108
src/__tests__/renderer/stores/agentStore.test.ts:25
src/__tests__/renderer/stores/sessionStore.test.ts:27
src/__tests__/renderer/stores/tabStore.test.ts:59
src/__tests__/renderer/utils/contextExtractor.test.ts:26
src/__tests__/renderer/utils/sessionValidation.test.ts:9
src/__tests__/renderer/utils/tabHelpers.test.ts:73
src/__tests__/renderer/utils/terminalTabHelpers.test.ts:56
src/__tests__/web/mobile/AllSessionsView.test.tsx:65
src/__tests__/web/mobile/App.test.tsx:512
src/__tests__/web/mobile/SessionPillBar.test.tsx:50
```

---

## createMockTheme definitions (31 total)

```
src/__tests__/integration/AutoRunBatchProcessing.test.tsx:123
src/__tests__/integration/AutoRunRightPanel.test.tsx:127
src/__tests__/integration/AutoRunSessionList.test.tsx:177
src/__tests__/integration/InlineWizardFlow.test.tsx:59
src/__tests__/main/web-server/services/broadcastService.test.ts:65
src/__tests__/performance/AutoRunLargeDocument.test.tsx:127
src/__tests__/performance/AutoRunManyDocuments.test.tsx:195
src/__tests__/performance/AutoRunMemoryLeaks.test.tsx:130
src/__tests__/performance/AutoRunRapidInteractions.test.tsx:197
src/__tests__/performance/ThinkingStreamPerformance.test.tsx:71
src/__tests__/renderer/components/AutoRun.test.tsx:146
src/__tests__/renderer/components/AutoRunBlurSaveTiming.test.tsx:135
src/__tests__/renderer/components/AutoRunContentSync.test.tsx:128
src/__tests__/renderer/components/AutoRunExpandedModal.test.tsx:112
src/__tests__/renderer/components/AutoRunLightbox.test.tsx:73
src/__tests__/renderer/components/AutoRunSearchBar.test.tsx:45
src/__tests__/renderer/components/AutoRunSessionIsolation.test.tsx:130
src/__tests__/renderer/components/BatchRunnerModal.test.tsx:84
src/__tests__/renderer/components/GroupChatInput.test.tsx:25
src/__tests__/renderer/components/GroupChatModals.test.tsx:85
src/__tests__/renderer/components/PlaybookDeleteConfirmModal.test.tsx:27
src/__tests__/renderer/components/RenameSessionModal.test.tsx:17
src/__tests__/renderer/components/RenameTabModal.test.tsx:14
src/__tests__/renderer/components/shared/AgentConfigPanel.test.tsx:46
src/__tests__/renderer/components/ShortcutsHelpModal.test.tsx:14
src/__tests__/renderer/components/TemplateAutocompleteDropdown.test.tsx:14
src/__tests__/renderer/components/ThemePicker.test.tsx:21
src/__tests__/renderer/components/UpdateCheckModal.test.tsx:54
src/__tests__/renderer/components/WorktreeRunSection.test.tsx:15
src/__tests__/renderer/hooks/useTabExportHandlers.test.ts:128
src/__tests__/web/utils/cssCustomProperties.test.ts:24
```

## mockTheme object definitions (66 total)

```
src/__tests__/renderer/components/AchievementCard.test.tsx:80
src/__tests__/renderer/components/AgentSessionsModal.test.tsx:27
src/__tests__/renderer/components/AICommandsPanel.test.tsx:65
src/__tests__/renderer/components/AppModals-selfSourced.test.tsx:145
src/__tests__/renderer/components/AppOverlays.test.tsx:56
src/__tests__/renderer/components/AutoRunDocumentSelector.test.tsx:52
src/__tests__/renderer/components/AutoRunnerHelpModal.test.tsx:45
src/__tests__/renderer/components/CueHelpModal.test.tsx:21
src/__tests__/renderer/components/CueModal.test.tsx:112
src/__tests__/renderer/components/CuePipelineEditor/drawers/AgentDrawer.test.tsx:6
src/__tests__/renderer/components/CuePipelineEditor/drawers/TriggerDrawer.test.tsx:6
src/__tests__/renderer/components/CueYamlEditor.test.tsx:158
src/__tests__/renderer/components/CustomThemeBuilder.test.tsx:34
src/__tests__/renderer/components/DirectorNotes/AIOverviewTab.test.tsx:51
src/__tests__/renderer/components/DirectorNotes/DirectorNotesModal.test.tsx:83
src/__tests__/renderer/components/DirectorNotes/UnifiedHistoryTab.test.tsx:162
src/__tests__/renderer/components/DocumentGraph/DocumentNode.test.tsx:16
src/__tests__/renderer/components/DocumentGraph/ExternalLinkNode.test.tsx:16
src/__tests__/renderer/components/DocumentGraph/GraphLegend.test.tsx:21
src/__tests__/renderer/components/DocumentGraph/NodeBreadcrumb.test.tsx:23
src/__tests__/renderer/components/DocumentGraph/NodeContextMenu.test.tsx:21
src/__tests__/renderer/components/FileExplorerPanel.test.tsx:197
src/__tests__/renderer/components/GitStatusWidget.test.tsx:95
src/__tests__/renderer/components/GroupChatHistoryPanel.test.tsx:31
src/__tests__/renderer/components/History/ActivityGraph.test.tsx:8
src/__tests__/renderer/components/History/HistoryEntryItem.test.tsx:8
src/__tests__/renderer/components/History/HistoryFilterToggle.test.tsx:8
src/__tests__/renderer/components/HistoryDetailModal.test.tsx:34
src/__tests__/renderer/components/HistoryHelpModal.test.tsx:66
src/__tests__/renderer/components/HistoryPanel.test.tsx:109
src/__tests__/renderer/components/InlineWizard/WizardConfidenceGauge.test.tsx:18
src/__tests__/renderer/components/InlineWizard/WizardConversationView.test.tsx:22
src/__tests__/renderer/components/InlineWizard/WizardExitConfirmDialog.test.tsx:32
src/__tests__/renderer/components/InlineWizard/WizardInputPanel.test.tsx:32
src/__tests__/renderer/components/InlineWizard/WizardMessageBubble.test.tsx:24
src/__tests__/renderer/components/InputArea.test.tsx:102
src/__tests__/renderer/components/LogViewer.test.tsx:22
src/__tests__/renderer/components/PlaygroundPanel.test.tsx:116
src/__tests__/renderer/components/PromptComposerModal.test.tsx:44
src/__tests__/renderer/components/QuickActionsModal.test.tsx:77
src/__tests__/renderer/components/RightPanel.test.tsx:90
src/__tests__/renderer/components/SessionList/CollapsedSessionPill.test.tsx:10
src/__tests__/renderer/components/SessionList/LiveOverlayPanel.test.tsx:25
src/__tests__/renderer/components/SessionList/SidebarActions.test.tsx:6
src/__tests__/renderer/components/SessionList/SkinnySidebar.test.tsx:6
src/__tests__/renderer/components/Settings/EnvVarsEditor.test.tsx:18
src/__tests__/renderer/components/Settings/tabs/DisplayTab.test.tsx:125
src/__tests__/renderer/components/Settings/tabs/EncoreTab.test.tsx:130
src/__tests__/renderer/components/Settings/tabs/GeneralTab.test.tsx:112
src/__tests__/renderer/components/Settings/tabs/ShortcutsTab.test.tsx:46
src/__tests__/renderer/components/Settings/tabs/ThemeTab.test.tsx:60
src/__tests__/renderer/components/SettingsModal.test.tsx:281
src/__tests__/renderer/components/ShortcutEditor.test.tsx:23
src/__tests__/renderer/components/TabBar.test.tsx:122
src/__tests__/renderer/components/ThinkingStatusPill.test.tsx:21
src/__tests__/renderer/components/Toast.test.tsx:22
src/__tests__/renderer/components/ui/EmojiPickerField.test.tsx:40
src/__tests__/renderer/components/ui/FormInput.test.tsx:15
src/__tests__/renderer/components/ui/Modal.test.tsx:16
src/__tests__/renderer/components/UsageDashboard/chart-accessibility.test.tsx:19
src/__tests__/renderer/components/Wizard/WizardIntegration.test.tsx:204
src/__tests__/renderer/components/Wizard/WizardKeyboardNavigation.test.tsx:168
src/__tests__/renderer/utils/groupChatExport.test.ts:11
src/__tests__/renderer/utils/markdownConfig.test.ts:34
src/__tests__/renderer/utils/tabExport.test.ts:14
src/__tests__/renderer/utils/theme.test.tsx:22
```

**Combined theme mock total: 97 definitions** (31 createMockTheme + 66 mockTheme objects)

---

## createMockAITab / createMockTab definitions (12 total)

```
src/__tests__/main/web-server/services/broadcastService.test.ts:104    createMockTab
src/__tests__/renderer/components/MergeSessionModal.test.tsx:52        createMockTab
src/__tests__/renderer/components/ThinkingStatusPill.test.tsx:65       createMockAITab
src/__tests__/renderer/hooks/useAgentExecution.test.ts:6               createMockTab
src/__tests__/renderer/hooks/useAgentListeners.test.ts:26              createMockTab
src/__tests__/renderer/hooks/useAgentSessionManagement.test.ts:14      createMockTab
src/__tests__/renderer/hooks/useInputProcessing.test.ts:29             createMockTab
src/__tests__/renderer/hooks/useMergeSession.test.ts:86                createMockTab
src/__tests__/renderer/hooks/useModalHandlers.test.ts:80               createMockAITab
src/__tests__/renderer/hooks/useRemoteIntegration.test.ts:6            createMockTab
```

---

## Test files with window.maestro mock setup (64 files)

Pattern: `window.maestro = {...}` or `(window as any).maestro = mockMaestro`

```
src/__tests__/integration/AutoRunBatchProcessing.test.tsx:163
src/__tests__/integration/AutoRunRightPanel.test.tsx:167
src/__tests__/integration/AutoRunSessionList.test.tsx:221
src/__tests__/integration/InlineWizardFlow.test.tsx:50
src/__tests__/performance/AutoRunLargeDocument.test.tsx:166
src/__tests__/performance/AutoRunManyDocuments.test.tsx:237
src/__tests__/performance/AutoRunMemoryLeaks.test.tsx:169
src/__tests__/performance/AutoRunRapidInteractions.test.tsx:239
src/__tests__/renderer/components/AutoRun.test.tsx:185
src/__tests__/renderer/components/AutoRunBlurSaveTiming.test.tsx:174
src/__tests__/renderer/components/AutoRunContentSync.test.tsx:167
src/__tests__/renderer/components/AutoRunSessionIsolation.test.tsx:169
src/__tests__/renderer/components/CueYamlEditor.test.tsx
src/__tests__/renderer/components/DirectorNotes/AIOverviewTab.test.tsx
src/__tests__/renderer/components/DirectorNotes/UnifiedHistoryTab.test.tsx
src/__tests__/renderer/components/FileExplorerPanel.test.tsx
src/__tests__/renderer/components/GistPublishModal.test.tsx
src/__tests__/renderer/components/ImageDiffViewer.test.tsx
src/__tests__/renderer/components/SaveMarkdownModal.test.tsx
src/__tests__/renderer/components/SessionList/LiveOverlayPanel.test.tsx
src/__tests__/renderer/components/TabBar.test.tsx
src/__tests__/renderer/components/UsageDashboard/AutoRunStats.test.tsx
src/__tests__/renderer/components/UsageDashboard/state-transition-animations.test.tsx
src/__tests__/renderer/components/Wizard/WizardIntegration.test.tsx
src/__tests__/renderer/components/Wizard/WizardKeyboardNavigation.test.tsx
src/__tests__/renderer/components/Wizard/WizardThemeStyles.test.tsx
src/__tests__/renderer/hooks/cue/usePipelineLayout.test.ts
src/__tests__/renderer/hooks/cue/usePipelineState.test.ts
src/__tests__/renderer/hooks/useAgentConfiguration.test.ts
src/__tests__/renderer/hooks/useAgentExecution.test.ts
src/__tests__/renderer/hooks/useAgentListeners.test.ts
src/__tests__/renderer/hooks/useAgentSessionManagement.test.ts
src/__tests__/renderer/hooks/useAppInitialization.test.ts
src/__tests__/renderer/hooks/useAutoRunDocumentLoader.test.ts
src/__tests__/renderer/hooks/useBatchHandlers.test.ts
src/__tests__/renderer/hooks/useBatchProcessor.test.ts
src/__tests__/renderer/hooks/useCue.test.ts
src/__tests__/renderer/hooks/useCueAutoDiscovery.test.ts
src/__tests__/renderer/hooks/useFileExplorerEffects.test.ts
src/__tests__/renderer/hooks/useFileTreeManagement.test.ts
src/__tests__/renderer/hooks/useInputProcessing.test.ts
src/__tests__/renderer/hooks/useInterruptHandler.test.ts
src/__tests__/renderer/hooks/useLiveMode.test.ts
src/__tests__/renderer/hooks/useMergeTransferHandlers.test.ts
src/__tests__/renderer/hooks/useRemoteHandlers.test.ts
src/__tests__/renderer/hooks/useRemoteIntegration.test.ts
src/__tests__/renderer/hooks/useSessionCrud.test.ts
src/__tests__/renderer/hooks/useSessionLifecycle.test.ts
src/__tests__/renderer/hooks/useSessionRestoration.test.ts
src/__tests__/renderer/hooks/useSshRemotes.test.ts
src/__tests__/renderer/hooks/useSymphonyContribution.test.ts
src/__tests__/renderer/hooks/useWebBroadcasting.test.ts
src/__tests__/renderer/hooks/useWizardHandlers.test.ts
src/__tests__/renderer/hooks/useWorktreeValidation.test.ts
src/__tests__/renderer/services/git.test.ts
src/__tests__/renderer/services/inlineWizardConversation.test.ts
src/__tests__/renderer/services/openspec.test.ts
src/__tests__/renderer/services/process.test.ts
src/__tests__/renderer/stores/agentStore.test.ts
src/__tests__/renderer/utils/logger.test.ts
src/__tests__/renderer/utils/participantColors.test.ts
src/__tests__/renderer/utils/platformUtils.test.ts
src/__tests__/renderer/utils/shortcutFormatter.test.ts
src/__tests__/renderer/utils/spawnHelpers.test.ts
```

Note: A shared `mockMaestro` is defined in `src/__tests__/setup.ts:205` but 64 test files still set up their own `window.maestro` mock objects.

---

## Summary

| Mock Type              | Definitions | Suggested Action                                                |
| ---------------------- | ----------- | --------------------------------------------------------------- |
| `createMockSession`    | 66          | Extract to shared `src/__tests__/helpers/mockSession.ts`        |
| `createMockTheme`      | 31          | Extract to shared `src/__tests__/helpers/mockTheme.ts`          |
| `mockTheme` objects    | 66          | Consolidate with createMockTheme                                |
| `createMockTab`        | 12          | Extract to shared `src/__tests__/helpers/mockTab.ts`            |
| `window.maestro` setup | 64 files    | Centralize in `src/__tests__/setup.ts` (already partially done) |
