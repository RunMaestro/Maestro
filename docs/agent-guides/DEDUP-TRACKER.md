<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Deduplication Tracker

Consolidated tracking of all duplicate/dead code in the Maestro codebase. Grep-verified counts from scan files.

> **Note:** This `agent-guides` branch does not include the underlying `SCAN-*.md` evidence files (they live on the companion `docs/codebase-dedup-guides` branch). The tracker below references them by name for cross-reference; counts here were grep-verified as of the "Refreshed" date at the top. To re-verify against current code, grep the patterns described in each finding.

**Status markers (as of 2026-04-10 verification against rc 06e5a2eb3):**

- Component decomposition PARTIALLY RESOLVED: `MainPanel/`, `TabBar/`, `FilePreview/`, `AutoRun/`, `NewInstanceModal/`, `CueModal/` all exist as decomposed directories in `src/renderer/components/`. However, `AutoRun/AutoRun.tsx` (844), `NewInstanceModal/NewInstanceModal.tsx` (843), and `FilePreview/FilePreview.tsx` (1,322) are still over the 800-line target. See `scans/SCAN-OVERSIZED.md` for current counts.
- **Shared hooks that now exist in rc (infra ready, migration not done):**
  - `useModalLayer` at `src/renderer/hooks/ui/useModalLayer.ts`
  - `useActiveSession` at `src/renderer/hooks/session/useActiveSession.ts`
  - `useFocusAfterRender` at `src/renderer/hooks/utils/useFocusAfterRender.ts`
  - `useEventListener` at `src/renderer/hooks/utils/useEventListener.ts`
  - `useDebouncedValue`, `useThrottledCallback`, `useDebouncedCallback` at `src/renderer/hooks/utils/useThrottle.ts`
- **Shared helpers that now exist in rc (infra ready, migration not done):**
  - `updateSessionWith` exported from `src/renderer/stores/sessionStore.ts:444` (related to finding for Phase 07A)
  - `selectActiveSession` and `selectSessionById` in `src/renderer/stores/sessionStore.ts`
- **Canonical formatters in rc** (`src/shared/formatters.ts`): `formatSize`, `formatNumber`, `formatTokens`, `formatTokensCompact`, `formatRelativeTime`, `formatActiveTime`, `formatElapsedTime`, `formatCost`, `estimateTokenCount`, `formatElapsedTimeColon`, `truncatePath`, `getParentDir`, `truncateCommand`. **`formatDuration` is in `src/shared/performance-metrics.ts:336`** (not formatters.ts). `formatTime` / `formatTimestamp` NOT YET canonicalized — local copies still present in multiple files.
- **NOT in rc** (still genuinely missing): `EmptyState`, `GhostIconButton`, `Spinner` in `src/renderer/components/ui/`; `src/__tests__/helpers/` directory; unified `SpecCommandManager` base (speckit and openspec managers still separate); `spawnGroupChatAgent.ts` helper.

## Priority Legend

- **P0** = Bugs/dead code (fix immediately)
- **P1** = High-impact (significant savings)
- **P2** = Medium-impact (maintenance burden)
- **P3** = Nice-to-have

---

## P0 - Bugs / Dead Code

### 1. Dead Component Files (7 files, 0 production imports)

- **Evidence:** SCAN-DEADCODE.md, "Dead Component Files"
- **Count:** 7 component files with zero non-test imports
- **KEEP:** Nothing (all are unused)
- **REMOVE:** `AgentSessionsModal.tsx`, `GitWorktreeSection.tsx`, `GroupChatParticipants.tsx`, `MergeProgressModal.tsx`, `ShortcutEditor.tsx`, `SummarizeProgressModal.tsx`, `ThemePicker.tsx`
- **Estimated savings:** ~7 files deleted entirely

### 2. Dead Store Selectors (53 exports across 9 store files)

- **Evidence:** SCAN-DEADCODE.md, "Dead Store Selectors"
- **Count:** 53 exported selectors/helpers with zero external references
- **KEEP:** Store files themselves (still contain used exports)
- **REMOVE:** 53 specific exports: `selectAvailableAgents`, `selectAgentsDetected`, `getAgentState`, `getAgentActions` (agentStore); `selectStoppingBatchSessionIds`, `selectBatchRunState`, `getBatchActions` (batchStore); `getFileExplorerState`, `getFileExplorerActions` (fileExplorerStore); `getGroupChatState`, `getGroupChatActions` (groupChatStore); `selectModalOpen`, `selectModal` (modalStore); `selectToasts`, `selectToastCount`, `selectConfig`, `resetToastIdCounter`, `getNotificationState`, `getNotificationActions` (notificationStore); `selectIsAnyOperationInProgress`, `getOperationState`, `getOperationActions` (operationStore); `selectBookmarkedSessions`, `selectSessionsByGroup`, `selectUngroupedSessions`, `selectGroupById`, `selectSessionCount`, `selectIsReady`, `selectIsAnySessionBusy`, `getSessionState`, `getSessionActions` (sessionStore); 11 exports from settingsStore; 11 exports from tabStore
- **Estimated savings:** ~200 lines across 9 files

### 3. Dead Shared Utility Exports (43 exports across 18 files)

- **Evidence:** SCAN-DEADCODE.md, "Dead Shared Utils"
- **Count:** 43 exported types/functions/constants with zero external imports
- **KEEP:** Files that still have used exports
- **NOTE (re-vetted 2026-03-28):** `ORPHANED_SESSION_ID` removed from this list - it IS used in `main/ipc/handlers/history.ts:18`
- **DE-EXPORT (keep internal), not remove:** `AGENT_DISPLAY_NAMES` and `BETA_AGENTS` in `src/shared/agentMetadata.ts` are consumed inside the file itself by `getAgentDisplayName()` (line 32) and `isBetaAgent()` (line 73). External callers should go through the wrapper functions. Drop the `export` keyword on these two constants but leave the values in place. `SHARED-UTILS.md` documents them as internal-only.
- **REMOVE:** 41 other exports including all of `cli-activity.ts` exports; `CliServerInfo`; `DebateConfig`, `PipelineNodePosition`, `PipelineNodeType`, `PipelineViewport` (cue-pipeline-types); `buildFocusDeepLink`; 6 gitUtils exports; `DEFAULT_PAGINATION`; `shouldLogLevel`; 6 maestro-paths exports; `PlaybookSource`; `parseVersion`; `PerformanceLogger`, `createNoOpMetrics`; 3 symphony-constants exports; `SymphonyLabel`, `SymphonyErrorType`; `ParsedSynopsis`, `isNothingToReport`; `TemplateSessionInfo`; `WalkTreeOptions`, `walkTree`, `PartitionedPaths`; `SshRemoteStatus`
- **Estimated savings:** ~290 lines across 18 files

### 4. Dead Main Process Exports (75 exports across 35 files)

- **Evidence:** SCAN-DEADCODE.md, "Dead Main Process Exports"
- **Count:** 75 exported functions/constants/types with zero external references
- **KEEP:** Files that still have used exports
- **REMOVE:** 75 exports across 35 files including: `DEBUG_GROUP_CHAT`, `debugLogLazy` (constants); 3 cue-db exports; 2 cue-heartbeat exports; `DEFAULT_FILE_DEBOUNCE_MS`; `extractPendingTasks`; 2 cue-types exports; `sanitizeText`; 5 group-chat-agent exports; `getCustomShellPath`; 2 group-chat-log exports; 3 group-chat-moderator exports; 5 group-chat-router exports; `getGroupChatsDir`; 2 output-buffer exports; 2 output-parser exports; `detectSessionNotFoundError`; `getAutoRunWatcherCount`; `sanitizeDisplayName`; `getDocumentGraphWatcherCount`; `registerAllHandlers`; 6 notification handler exports; `isValidToolType`; 2 parser index exports; `setupProcessListeners`; `getMigrations`; `initializeSessionStorages`; `findSshRemoteById` (stores/utils); 5 cliDetection exports; `needsWindowsShell`; 4 ipcHandler exports; `stopMemoryMonitoring`; `shellEscapeArgs`; `getShellCommand`; `buildRemoteCommand`; 2 ssh-config-parser exports; 2 statsCache exports; 2 terminalFilter exports; 2 wslDetector exports; 2 wakatime-manager exports
- **Estimated savings:** ~500 lines across 35 files

### 5. Duplicate Interface with Self-Conflict (AgentCapabilities has 2 defs in same file)

- **Evidence:** SCAN-TYPES.md, "AgentCapabilities (6 definitions)"
- **Count:** `renderer/global.d.ts` defines `AgentCapabilities` twice (lines 63 and 106)
- **KEEP:** One definition in `renderer/global.d.ts`, canonical in `shared/types.ts` or `main/agents/capabilities.ts`
- **REMOVE:** The duplicate definition within the same file, plus 4 other redundant definitions
- **Estimated savings:** ~50 lines, eliminates potential type-shadowing bug

---

## P1 - High Impact

### 6. setSessions Prop-Drilling (463 calls, 68+ files)

- **Evidence:** SCAN-STATE.md, "setSessions calls"; SCAN-BLOCKS.md, "setSessions Calls by File"
- **Count:** 463 `setSessions` calls across 68+ production files; 14+ prop-drilling sites passing `setSessions` as a function prop
- **KEEP:** `sessionStore.ts` definition and direct store usage
- **Consolidate:** Replace prop-drilling with direct `useSessionStore()` access. Top offenders: `useTabHandlers.ts` (68), `useWizardHandlers.ts` (25), `App.tsx` (22), `useInputProcessing.ts` (18), `useFileTreeManagement.ts` (18), `useRemoteIntegration.ts` (17)
- **Estimated savings:** ~200 lines of prop-passing interfaces/boilerplate

### 7. Nested aiTabs.map/filter Duplication (82 calls, 25 files)

- **Evidence:** SCAN-BLOCKS.md, "Nested aiTabs.map Calls"
- **Count:** 82 `aiTabs.map`/`aiTabs.filter` calls nested inside `setSessions` updaters across 25 files
- **KEEP:** `sessionStore.ts` as canonical location for session update helpers
- **Consolidate:** Extract `updateAiTab(sessionId, tabId, updater)` and `updateActiveAiTab(sessionId, updater)` helpers into `sessionStore.ts`. Top offenders: `useWizardHandlers.ts` (12), `useInputProcessing.ts` (10), `useTabHandlers.ts` (8), `useAgentListeners.ts` (8), `useInterruptHandler.ts` (6), `useBatchedSessionUpdates.ts` (5)
- **Estimated savings:** ~400 lines of nested map boilerplate

### 8. Modal registerLayer/unregisterLayer Boilerplate (53 files)

- **Evidence:** SCAN-BLOCKS.md, "registerLayer/unregisterLayer by File"
- **Count:** 53 files with manual `registerLayer`/`unregisterLayer` boilerplate; `useModalLayer.ts` hook exists but only 1-2 files use it
- **KEEP:** `renderer/hooks/ui/useModalLayer.ts` (existing hook)
- **Consolidate:** Migrate all 50+ files to use `useModalLayer` hook instead of manual `registerLayer`/`unregisterLayer` pairs. Worst offender: `DocumentGraphView.tsx` (17 calls)
- **Estimated savings:** ~200 lines (4 lines per file x 50 files)

### 9. Test Mock Factories - createMockSession (66 definitions)

- **Evidence:** SCAN-MOCKS.md, "createMockSession definitions"
- **Count:** 66 separate `createMockSession` factory definitions across 66 test files
- **KEEP:** Create shared `src/__tests__/helpers/mockSession.ts`
- **REMOVE:** 66 local definitions, replace with imports from shared helper
- **Estimated savings:** ~660 lines (avg ~10 lines each)

### 10. Test Mock Factories - createMockTheme + mockTheme (97 definitions)

- **Evidence:** SCAN-MOCKS.md, "createMockTheme definitions" (31) + "mockTheme object definitions" (66)
- **Count:** 35 `createMockTheme` functions (was 31) + 119 `mockTheme` inline objects (was 66) = 154 total (was 97, REGRESSION)
- **KEEP:** Create shared `src/__tests__/helpers/mockTheme.ts`
- **REMOVE:** 97 local definitions, replace with imports from shared helper
- **Estimated savings:** ~500 lines

### 11. Test window.maestro Mock Setup (64 files)

- **Evidence:** SCAN-MOCKS.md, "Test files with window.maestro mock setup"
- **Count:** 117 test file instances set up their own `window.maestro` mock (was 64, REGRESSION) despite shared mock existing in `src/__tests__/setup.ts:205`
- **KEEP:** `src/__tests__/setup.ts` centralized mock
- **CONSOLIDATE:** Extend `setup.ts` to cover all namespaces, remove 117 local setups
- **Estimated savings:** ~1,755 lines (avg ~15 lines per instance)

### 12. Formatter Duplication - formatDuration (22 redundant definitions)

- **Evidence:** SCAN-FORMATTERS.md, "formatDuration / formatElapsed / formatTime definitions"
- **Count:** 22 local `formatDuration` definitions; 9 identical copies in UsageDashboard alone
- **NOTE (re-vetted 2026-03-28):** Count increased from 21 to 22 since original scan. New `formatDuration` added in `CueModal/cueModalUtils.ts:25` (Cue feature on rc).
- **NOTE (re-vetted 2026-04-01):** Count confirmed at 22. CueModal/cueModalUtils.ts:25 entry verified.
- **KEEP:** `src/shared/formatters.ts:144` (`formatElapsedTime`) and `src/shared/performance-metrics.ts:336` (`formatDuration`)
- **REMOVE:** 22 local re-definitions including all 9 UsageDashboard copies, `AboutModal.tsx`, `FirstRunCelebration.tsx`, `SymphonyModal.tsx`, `Toast.tsx`, `AIOverviewTab.tsx`, `useContributorStats.ts`, `groupChatExport.ts`, `tabExport.ts`, `cli/output/formatter.ts` (2), `CueModal/cueModalUtils.ts`
- **Estimated savings:** ~210 lines

### 13. SpecKit/OpenSpec Parallel Implementation (~2,431 lines, ~1,100 removable)

- **Evidence:** SCAN-PATTERNS.md, "SpecKit vs OpenSpec"
- **Count:** 5 file pairs with near-identical implementations totaling ~2,431 lines combined
- **KEEP:** Create shared base implementation (~1,300 lines)
- **CONSOLIDATE:** `speckit-manager.ts` (530) / `openspec-manager.ts` (471); `SpecKitCommandsPanel.tsx` (424) / `OpenSpecCommandsPanel.tsx` (426); `ipc/handlers/speckit.ts` (100) / `ipc/handlers/openspec.ts` (100); `services/speckit.ts` (56) / `services/openspec.ts` (56); `prompts/speckit/index.ts` (157) / `prompts/openspec/index.ts` (111). Also deduplicate `EditingCommand` interface (3 definitions)
- **Estimated savings:** ~1,100 lines

### 14. Duplicate Type/Interface Definitions (28 interfaces, 98 redundant definitions)

- **Evidence:** SCAN-TYPES.md, all sections
- **Count:** 11 interfaces with 4+ definitions (47 total defs), 17 interfaces with 3 definitions (51 total defs). Top offenders: `AgentCapabilities` (6 defs), `UsageStats` (6 defs), `SessionInfo` (3 defs, was 6 - 3 Cue pipeline dups removed on rc), `AgentConfig` (5 defs), `AgentConfigsData` (5 defs)
- **NOTE (re-vetted 2026-03-28):** SessionInfo reduced from 6 to 4 definitions. 3 Cue pipeline duplicates were removed on rc.
- **NOTE (re-vetted 2026-04-01):** SessionInfo now at 3 definitions (was listed as 4 on 2026-03-28, corrected).
- **KEEP:** Canonical definitions in `shared/types.ts`, `shared/stats-types.ts`, or domain-specific files
- **CONSOLIDATE:** Root cause is preload boundary re-declaration pattern. Types defined in `shared/`, re-declared in `main/preload/`, re-declared in `renderer/types/index.ts` and `renderer/global.d.ts`, then again locally. Fix the preload type-sharing mechanism
- **Estimated savings:** ~370 lines

---

## P2 - Medium Impact

### 15. sessions.find Lookups (71 calls, should use store selectors)

- **Evidence:** SCAN-STATE.md, "sessions.find calls"
- **Count:** 71 `sessions.find(s => s.id === ...)` calls; `useTabHandlers.ts` alone has 13 identical `sessions.find` calls
- **KEEP:** `sessionStore.ts` selectors: `getActiveSession` (line 320), `getSessionById` (line 331)
- **CONSOLIDATE:** Replace 71 inline finds with store selector usage. 8 wizard re-lookups are especially wasteful (re-finding `activeSession` that's already in scope)
- **Estimated savings:** ~100 lines

### 16. getSshRemoteById Re-definitions (6 definitions, 5 redundant)

- **Evidence:** SCAN-STATE.md, "getSshRemoteById - definitions"
- **Count:** 6 definitions: canonical at `main/stores/getters.ts:115`, plus local copies in `agentSessions.ts:82`, `agents.ts:202`, `autorun.ts:43`, `git.ts:54`, `marketplace.ts:66`
- **KEEP:** `main/stores/getters.ts:115`
- **REMOVE:** 5 local re-definitions, import from canonical source
- **Estimated savings:** ~50 lines

### 17. setTimeout Focus Pattern (45 calls, 28 files)

- **Evidence:** SCAN-HOOKS.md, "setTimeout Focus Pattern"
- **Count:** 45 `setTimeout(() => ref.current?.focus(), N)` calls across 28 files, with varying delays (0ms, 50ms, 100ms)
- **KEEP:** Create shared `useFocusAfterRender(ref, delay?)` hook
- **CONSOLIDATE:** Replace 45 inline setTimeout-focus patterns with the shared hook
- **Estimated savings:** ~90 lines

### 18. addEventListener/removeEventListener Boilerplate (63+ files)

- **Evidence:** SCAN-HOOKS.md, "addEventListener/removeEventListener Pairs by File"
- **Count:** 63+ files with manual add/remove event listener pairs; top offenders: `activityBus.ts` (10), `MarketplaceModal.tsx` (10), `useMainKeyboardHandler.ts` (8), `SymphonyModal.tsx` (8), `App.tsx` (8)
- **KEEP:** Create or promote shared `useEventListener(target, event, handler)` hook
- **CONSOLIDATE:** Replace manual add/remove pairs in 63+ files
- **Estimated savings:** ~250 lines

### 19. Ghost Icon Button Pattern (100+ instances, 40+ files)

- **Evidence:** SCAN-COMPONENTS.md, "Ghost Icon Button Pattern Locations"
- **Count:** 39+ exact `p-1 rounded hover:bg-white/10 transition-colors` matches plus `p-1.5` variants and `opacity-0 group-hover:opacity-100` variants, totaling 100+ instances across 40+ files
- **KEEP:** Create shared `<GhostIconButton>` component in `renderer/components/ui/`
- **CONSOLIDATE:** Replace 100+ inline button patterns
- **Estimated savings:** ~300 lines

### 20. Spinner Instances (95+ instances, 43 files)

- **Evidence:** SCAN-COMPONENTS.md, "Spinner Instances"
- **Count:** 95+ `<Loader2 className="... animate-spin" />` instances across 43 files; top offenders: `SymphonyModal.tsx` (9), `AgentSessionsBrowser.tsx` (7), `DocumentGraphView.tsx` (5)
- **KEEP:** Create shared `<Spinner size="sm|md|lg">` component in `renderer/components/ui/`
- **CONSOLIDATE:** Replace 95+ inline Loader2 usages
- **Estimated savings:** ~200 lines

### 21. console.log in Group Chat Router (130 calls)

- **Evidence:** SCAN-MAIN.md, "console.log vs logger Usage by File"
- **Count:** 130 `console.log` calls in `main/group-chat/group-chat-router.ts` alone; 26 in `group-chat-agent.ts`; total raw console.log across codebase significantly higher than structured logger usage in these files
- **KEEP:** `main/utils/logger.ts` (structured logging)
- **CONSOLIDATE:** Replace 130+ console.log calls with logger.debug/info/warn/error in group chat files. Also address 14 in `useRemoteHandlers.ts`, 14 in `phaseGenerator.ts`, 11 in `graphDataBuilder.ts`, 11 in `groupChat.ts` IPC handler
- **Estimated savings:** Improved debuggability, no line count change

### 22. formatElapsedTime Re-definitions (5 redundant)

- **Evidence:** SCAN-FORMATTERS.md, "formatElapsed / formatElapsedTime re-definitions"
- **Count:** 5 local `formatElapsedTime` definitions; canonical exists at `shared/formatters.ts:144`
- **KEEP:** `src/shared/formatters.ts:144`
- **REMOVE:** `MergeProgressModal.tsx:58`, `MergeProgressOverlay.tsx:53`, `SummarizeProgressModal.tsx:57`, `SummarizeProgressOverlay.tsx:51`, `TransferProgressModal.tsx:79` (all identical)
- **Estimated savings:** ~50 lines

### 23. formatTime/formatTimestamp (15 definitions, no canonical)

- **Evidence:** SCAN-FORMATTERS.md, "formatTime / formatTimestamp re-definitions"
- **Count:** 15 local `formatTime`/`formatTimestamp` definitions with no canonical source
- **KEEP:** Create canonical `formatTimestamp(timestamp: number): string` in `shared/formatters.ts`
- **CONSOLIDATE:** Replace 15 local definitions across `GroupChatHistoryPanel.tsx`, `GroupChatMessages.tsx`, `HistoryEntryItem.tsx`, `HistoryDetailModal.tsx`, `WizardMessageBubble.tsx`, `ParticipantCard.tsx`, `ThinkingStatusPill.tsx`, `LongestAutoRunsTable.tsx`, `ConversationScreen.tsx`, `conductorBadges.ts`, `groupChatExport.ts`, `tabExport.ts`, `MessageHistory.tsx`, `MobileHistoryPanel.tsx`, `ResponseViewer.tsx`
- **Estimated savings:** ~100 lines

### 24. formatNumber Re-definitions (5 redundant)

- **Evidence:** SCAN-FORMATTERS.md, "formatNumber / formatSize / formatFileSize definitions"
- **Count:** 5 local `formatNumber` definitions; canonical exists at `shared/formatters.ts:41`
- **KEEP:** `src/shared/formatters.ts:41`
- **REMOVE:** `symphony.ts:928`, `AgentComparisonChart.tsx:93`, `AutoRunStats.tsx:70`, `LocationDistributionChart.tsx:40`, `SourceDistributionChart.tsx:62`, `SummaryCards.tsx:72`
- **Estimated savings:** ~40 lines

### 25. Catch-Console.error Without Sentry (252 blocks, 118 files)

- **Evidence:** SCAN-PATTERNS.md, "try-catch with console.error only"
- **Count:** 252 catch blocks use `console.error` without `captureException`/`captureMessage`; 118 files have `console.error` but zero Sentry usage
- **KEEP:** Sentry utilities at `main/utils/sentry.ts` and `renderer/components/ErrorBoundary.tsx`
- **CONSOLIDATE:** Audit 252 catch blocks; add `captureException` where errors are unexpected. Prioritize: 14 CLI files, 4 main process files, 40+ renderer component files, 24 renderer hook files, 14 renderer service/store/util files
- **Estimated savings:** Improved production error visibility, no line count change

### 26. Group Chat Spawn Boilerplate (5 sites, ~150 lines each)

- **Evidence:** SCAN-PATTERNS.md, "Group chat spawn sites"
- **Count:** 5 `processManager.spawn` call sites in `main/group-chat/`, each repeating ~30 lines of SSH wrapping + Windows config
- **KEEP:** Create `spawnGroupChatAgent(config)` helper in `main/group-chat/`
- **CONSOLIDATE:** `group-chat-agent.ts:226`, `group-chat-router.ts:583`, `group-chat-router.ts:976`, `group-chat-router.ts:1352`, `group-chat-router.ts:1553`
- **Estimated savings:** ~120 lines

### 27. resolve() in Zustand Stores (5 identical copies)

- **Evidence:** SCAN-PATTERNS.md, "resolve() definitions in stores"
- **Count:** 1 confirmed `resolve<T>()` helper (was listed as 5, re-vetted 2026-04-01 - only `batchStore.ts:86` confirmed on rc)
- **KEEP:** Extract to `renderer/stores/utils.ts` if pattern is still used inline elsewhere
- **REMOVE:** Confirmed copy in `batchStore.ts:86`
- **Estimated savings:** ~8 lines (reduced from ~40)

---

## P3 - Nice to Have

### 28. Duplicate Constants - AUTO_RUN_FOLDER_NAME (3 definitions)

- **Evidence:** SCAN-TYPES.md, "Duplicate Constant Definitions"
- **Count:** 3 identical definitions of `AUTO_RUN_FOLDER_NAME = PLAYBOOKS_DIR`
- **KEEP:** `PLAYBOOKS_DIR` from `shared/maestro-paths.ts:14` (already canonical)
- **REMOVE:** `phaseGenerator.ts:153`, `inlineWizardDocumentGeneration.ts:25`, `existingDocsDetector.ts:13` - use `PLAYBOOKS_DIR` directly
- **Estimated savings:** ~6 lines

### 29. DEFAULT_CAPABILITIES Duplication (2 definitions)

- **Evidence:** SCAN-TYPES.md, "DEFAULT_CAPABILITIES"
- **Count:** 2 definitions: `main/agents/capabilities.ts:98` and `renderer/hooks/agent/useAgentCapabilities.ts:89`
- **KEEP:** `main/agents/capabilities.ts:98`
- **CONSOLIDATE:** Import from canonical source or share via preload
- **Estimated savings:** ~20 lines

### 30. generateId/generateUUID (7 definitions)

- **Evidence:** SCAN-FORMATTERS.md, "generateId / generateUUID definitions"
- **Count:** 7 definitions: canonical at `shared/uuid.ts:10` and `renderer/utils/ids.ts:2`; 4 more local copies
- **KEEP:** `shared/uuid.ts` as canonical
- **REMOVE:** `main/stats/utils.ts:29`, `useBatchedSessionUpdates.ts:99`, `useLayerStack.ts:35`, `useCommandHistory.ts:67`, `useOfflineQueue.ts:107`
- **Estimated savings:** ~30 lines

### 31. estimateTokens Duplication (4 redundant, 2 identical pairs)

- **Evidence:** SCAN-FORMATTERS.md, "estimateTokens / estimateTokenCount definitions"
- **Count:** 7 total definitions; canonical at `shared/formatters.ts:176` and `renderer/utils/tokenCounter.ts:55`; 2 identical pairs (`MergeSessionModal`/`SendToAgentModal` and `useMergeSession`/`useSendToAgent`)
- **KEEP:** `shared/formatters.ts:176` or `renderer/utils/tokenCounter.ts:55`
- **REMOVE:** 4 local copies plus reconcile the 2 canonical sources into 1
- **Estimated savings:** ~40 lines

### 32. stripAnsi Duplication (2 definitions)

- **Evidence:** SCAN-FORMATTERS.md, "stripAnsi definitions"
- **Count:** 2 definitions: `main/utils/stripAnsi.ts:47` and `shared/stringUtils.ts:36` (same functionality, different names)
- **KEEP:** `shared/stringUtils.ts:36` (more discoverable location)
- **REMOVE:** `main/utils/stripAnsi.ts` (or redirect as re-export)
- **Estimated savings:** ~30 lines

### 33. formatFileSize (2 redundant definitions)

- **Evidence:** SCAN-FORMATTERS.md, "Local re-definitions of formatFileSize"
- **Count:** 2 local definitions; canonical `formatSize` exists at `shared/formatters.ts:27`
- **KEEP:** `shared/formatters.ts:27` (rename or alias to `formatFileSize`)
- **REMOVE:** `FilePreview.tsx:265`, `documentStats.ts:92`
- **Estimated savings:** ~15 lines

### 34. createMockTab/createMockAITab (12 definitions)

- **Evidence:** SCAN-MOCKS.md, "createMockAITab / createMockTab definitions"
- **Count:** 12 local definitions across test files
- **KEEP:** Create shared `src/__tests__/helpers/mockTab.ts`
- **REMOVE:** 12 local definitions
- **Estimated savings:** ~80 lines

### 35. Empty State Inline Patterns (26+ locations)

- **Evidence:** SCAN-COMPONENTS.md, "Empty State Pattern Locations"
- **Count:** 26+ distinct empty state locations; `EmptyStateView` component exists but is only used in `App.tsx:3340`
- **KEEP:** `renderer/components/EmptyStateView.tsx`
- **CONSOLIDATE:** Extend `EmptyStateView` to accept icon/message/action props, adopt across 26+ locations
- **Estimated savings:** ~150 lines

### 36. activeSession Re-derivation (28 files)

- **Evidence:** SCAN-HOOKS.md, "Files That Re-derive activeSession from Store"
- **Count:** 28 files re-derive `activeSession` from the store; some files do it 3 times internally
- **KEEP:** Store selector `getActiveSession` in `sessionStore.ts`
- **CONSOLIDATE:** Use `useSessionStore(selectActiveSession)` consistently
- **Estimated savings:** ~50 lines

### 37. Debounce/Throttle Inline Implementations (15+ files)

- **Evidence:** SCAN-HOOKS.md, "Debounce/Throttle Implementations by File"
- **Count:** 15+ files implement debounce/throttle inline despite shared hooks existing (`useSessionDebounce`, `useThrottle`, `useDebouncedPersistence`)
- **KEEP:** Existing shared hooks in `renderer/hooks/utils/`
- **CONSOLIDATE:** Migrate 15+ inline implementations to use shared hooks
- **Estimated savings:** ~100 lines

### 38. Repeated CSS className Strings (1,704 repetitions in top 20)

- **Evidence:** SCAN-TYPES.md, "Top 20 Most-Duplicated CSS className Strings"; SCAN-COMPONENTS.md, "Most Repeated className Combinations"
- **Count:** Top 20 classNames repeated 1,704 times. Compound patterns like `"w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"` appear 23 times; `"block text-xs font-bold opacity-70 uppercase mb-2"` appears 20 times
- **KEEP:** Tailwind utility classes are normal, but compound patterns should be extracted
- **CONSOLIDATE:** Extract compound className strings (5+ tokens) into shared constants or components. Icon size classes (`w-4 h-4`, `w-3 h-3`, etc.) account for 1,062 occurrences but are standard Tailwind usage
- **Estimated savings:** ~100 lines for compound patterns only

### 39. Oversized Files (82 files over 800-line limit)

- **Evidence:** SCAN-OVERSIZED.md, "Source Files Over 800 Lines"
- **Count:** 82 source files exceed 800 lines. `App.tsx` at 4,034 (REGRESSION from 3,619), `symphony.ts` handler at 3,318 (was 3,301). `TabBar.tsx` FULLY RESOLVED (2,839 -> 542, split into `TabBar/` directory). `FilePreview.tsx` PARTIALLY RESOLVED (2,662 -> 1,320, split into `FilePreview/` directory). Also decomposed into directories on rc: `MainPanel/`, `AutoRun/`, `NewInstanceModal/`, `CueModal/`.
- **Action:** Decompose top offenders as part of dedup work (many contain the duplicated patterns listed above). Prioritize `App.tsx` (worst offender, growing), `SymphonyModal.tsx`, `useTabHandlers.ts`, `useInputProcessing.ts`
- **Estimated savings:** No direct line savings, but improved maintainability

### 40. Oversized Test Files (28 files over 2,000 lines)

- **Evidence:** SCAN-OVERSIZED.md, "Test Files Over 2000 Lines"
- **Count:** 28 test files exceed 2,000 lines; worst: `symphony.test.ts` (6,203), `useBatchProcessor.test.ts` (5,988), `TabBar.test.tsx` (5,752)
- **Action:** Split into focused test modules; shared mock consolidation (#9, #10, #11) will reduce many of these
- **Estimated savings:** Indirect via mock consolidation

---

## Summary

_Last validated: 2026-04-01 against origin/rc. All 40 findings re-verified. Changes since 2026-03-28 noted inline._

**What improved (2026-04-01):**

- TabBar.tsx: FULLY RESOLVED (2839 -> 542 lines, split into 4 files)
- FilePreview.tsx: PARTIALLY RESOLVED (2662 -> 1320 lines, split into 5 files)
- SessionInfo type: reduced from 6 to 3 definitions (3 Cue pipeline defs removed)
- catch(error: any): reduced from 17 to 15 (2 migrated to unknown)
- Cross-boundary imports: 1 resolved (App.tsx estimateContextUsage)

**What regressed (2026-04-01):**

- App.tsx: grew from 3619 to 4034 lines (+415)
- `as any` casts: 108 -> 115 (+7)
- Test mock proliferation accelerating: mockTheme 66->119, window.maestro 64->117
- lucide-react redundant mocks: 51 -> 54
- Logger mocks: 128 -> 133
- 2000ms timeouts: 25 -> 32
- Port generation duplication: 5 -> 6 locations
- keydown listeners: 38 -> 43

| Priority  | Items  | Estimated Lines Saved | Key Themes                                                                           |
| --------- | ------ | --------------------- | ------------------------------------------------------------------------------------ |
| P0        | 5      | ~1,040                | Dead code removal (179 exports, 7 components, 1 type bug)                            |
| P1        | 9      | ~5,325                | State management patterns, test mocks (growing), formatters, SpecKit/OpenSpec, types |
| P2        | 13     | ~1,328                | UI components, logging, selectors, hooks, error handling (resolve() reduced)         |
| P3        | 13     | ~621                  | Constants, minor formatters, CSS patterns, file size                                 |
| **Total** | **40** | **~8,314**            | Mock proliferation driving increase                                                  |

---

## Recommended Execution Order

1. **Delete dead code (P0 #1-4)** - Zero-risk removal of 178 unused exports and 7 unused components. Verify with `rtk tsc` after each batch.

2. **Fix AgentCapabilities double-definition bug (P0 #5)** - Eliminate the duplicate interface in `renderer/global.d.ts` that may cause type shadowing.

3. **Consolidate test mock factories (P1 #9, #10, #11, P3 #34)** - Create `src/__tests__/helpers/` with shared `mockSession.ts`, `mockTheme.ts`, `mockTab.ts`. Extend `setup.ts` for `window.maestro`. Touches only test files, zero production risk. Saves ~2,240 lines.

4. **Extract shared formatters (P1 #12, P2 #22-24, P3 #31-33)** - Consolidate all `formatDuration`, `formatElapsedTime`, `formatTime`, `formatNumber`, `estimateTokens`, `stripAnsi`, `generateId` into `shared/formatters.ts`. Start with UsageDashboard (11 identical copies). Saves ~505 lines.

5. **Unify SpecKit/OpenSpec (P1 #13)** - Create shared base class/functions for the 5 near-identical file pairs. Saves ~1,100 lines.

6. **Fix type duplication (P1 #14)** - Establish single-source-of-truth for the 28 duplicated interfaces. Address the preload type-sharing mechanism to prevent re-declaration cascade.

7. **Extract session update helpers (P1 #6, #7, P2 #15)** - Add `updateAiTab()`, `updateActiveAiTab()` to `sessionStore.ts`. Replace `sessions.find` with `getSessionById`. Eliminate `setSessions` prop-drilling. Saves ~700 lines.

8. **Create shared UI components (P2 #19, #20, P3 #35)** - Build `<GhostIconButton>`, `<Spinner>`, extend `<EmptyStateView>`. Replace 100+ ghost buttons, 95+ spinners, 26+ empty states. Saves ~650 lines.

9. **Extract shared hooks (P2 #17, #18, P3 #36, #37)** - Create `useFocusAfterRender`, `useEventListener`. Promote existing debounce hooks. Migrate `activeSession` derivations to selectors. Saves ~490 lines.

10. **Consolidate modal boilerplate and group chat spawning (P1 #8, P2 #26, #27)** - Migrate 50+ files to `useModalLayer` hook. Extract `spawnGroupChatAgent()`. Unify store `resolve()` helper. Saves ~360 lines.
