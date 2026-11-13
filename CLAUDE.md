# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation Index

This guide has been split into focused sub-documents for progressive disclosure:

| Document                                   | Description                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [[CLAUDE-PATTERNS.md]]                     | Core implementation patterns (process management, settings, modals, themes, Auto Run, SSH, Encore Features)                                                              |
| [[CLAUDE-IPC.md]]                          | IPC API surface (`window.maestro.*` namespaces)                                                                                                                          |
| [[CLAUDE-PERFORMANCE.md]]                  | Performance best practices (React optimization, debouncing, batching)                                                                                                    |
| [[CLAUDE-WIZARD.md]]                       | Onboarding Wizard, Inline Wizard, and Tour System                                                                                                                        |
| [[CLAUDE-FEATURES.md]]                     | Usage Dashboard and Document Graph features                                                                                                                              |
| [[CLAUDE-AGENTS.md]]                       | Supported agents and capabilities                                                                                                                                        |
| [[CLAUDE-SESSION.md]]                      | Session interface (agent data model) and code conventions                                                                                                                |
| [[CLAUDE-PLATFORM.md]]                     | Cross-platform concerns (Windows, Linux, macOS, SSH remote)                                                                                                              |
| [[CLAUDE-CUE.md]]                          | Cue automation engine: architecture, dispatch flow, lifecycle, gotchas (read before editing `src/main/cue/`)                                                             |
| [[CLAUDE-PLUGINS.md]]                      | Plugin system architecture: tiers, sandbox, broker, capabilities, contributions, signing, trust model (read before editing `src/main/plugins/` or `src/shared/plugins/`) |
| [[CLAUDE-SETTINGS.md]]                     | Settings modal style guide: typography, color, dimming, spacing, primitives, registration checklist (read before editing `src/renderer/components/Settings/`)            |
| [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md) | Detailed agent integration guide                                                                                                                                         |

---

## Before Writing New Code - Check Existing Utilities

**MANDATORY:** Before creating any new utility function, helper, hook, component, type, or constant, check the guide docs in `docs/agent-guides/` to see if it already exists. Duplicated code is the #1 source of maintenance burden in this codebase - there are already grep-verified instances of 20+ duplicate format helpers, 60+ ad-hoc mock factories, and 500+ manual modal-layer registrations. Don't add to the pile.

| Before creating...                                 | Check this guide first                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Utility function (formatting, IDs, paths, strings) | [SHARED-UTILS.md](docs/agent-guides/SHARED-UTILS.md)             |
| IPC handler or preload bridge                      | [IPC-PATTERNS.md](docs/agent-guides/IPC-PATTERNS.md)             |
| Store action, selector, or hook                    | [STATE-PATTERNS.md](docs/agent-guides/STATE-PATTERNS.md)         |
| Agent parser, storage, or error pattern            | [AGENT-INFRA.md](docs/agent-guides/AGENT-INFRA.md)               |
| UI component, modal, or theme usage                | [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md)               |
| Stat card, chart, sparkline, or input control      | [WIDGET-LIBRARY.md](docs/agent-guides/WIDGET-LIBRARY.md)         |
| Test mock, factory, or setup pattern               | [TEST-PATTERNS.md](docs/agent-guides/TEST-PATTERNS.md)           |
| Renderer service or constant                       | [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md)   |
| Process spawning or listener                       | [PROCESS-SYSTEM.md](docs/agent-guides/PROCESS-SYSTEM.md)         |
| Browser (web-desktop) UI, PWA, or touch hook       | [WEB-MOBILE.md](docs/agent-guides/WEB-MOBILE.md)                 |
| CLI command or playbook feature                    | [CLI-PLAYBOOKS.md](docs/agent-guides/CLI-PLAYBOOKS.md)           |
| CLI verb mirroring a point-and-click action        | [CLI-UI-PARITY.md](docs/agent-guides/CLI-UI-PARITY.md)           |
| Group chat or Symphony feature                     | [GROUP-CHAT.md](docs/agent-guides/GROUP-CHAT.md)                 |
| Stats, analytics, or dashboard                     | [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)       |
| Prompt template or SpecKit/OpenSpec                | [PROMPTS-SPECS.md](docs/agent-guides/PROMPTS-SPECS.md)           |
| Cue pipeline feature                               | [CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md)             |
| App lifecycle, updater, or power mgmt              | [MAIN-LIFECYCLE.md](docs/agent-guides/MAIN-LIFECYCLE.md)         |
| Plugin, sandbox capability, or contribution        | [PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) |
| React context, renderer type, or Symphony runner   | [REMAINING-SYSTEMS.md](docs/agent-guides/REMAINING-SYSTEMS.md)   |
| Release step, tag, bump, or announcement           | [RELEASE-RUNBOOK.md](docs/agent-guides/RELEASE-RUNBOOK.md)       |
| Vulnerability report, advisory, CVE, or credit     | [SECURITY-RUNBOOK.md](docs/agent-guides/SECURITY-RUNBOOK.md)     |

### Commonly-reimplemented functions (do NOT add new copies)

Grep-verified 2026-11-05 (`npm run docs:verify` re-checks every path). This is the INDEX: name, canonical symbols, home file. The full entry for each - the failure it replaced, its invariants, and the traps that made the duplicates wrong - lives in [CANONICAL-UTILITIES.md](docs/agent-guides/CANONICAL-UTILITIES.md). If a name below matches what you are about to write, import the canonical one; read its full entry before extending or working around it.

- **ID generation:** `generateId()`, `generateUUID()` in `src/renderer/utils/ids.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Truncate prose without splitting a word:** `truncateAtWordBoundary()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()`, `formatCount()` in `src/shared/formatters.ts`
- **Format tokens:** `formatTokens()`, `formatTokensCompact()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** everything in `src/shared/duration.ts` (re-exported from `formatters.ts`).
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts - common mistake).
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format a calendar day:** `formatCalendarDay()` in `src/shared/formatters.ts` renders a `YYYY-MM-DD` string as `"Jul 10, 2026"`.
- **Local calendar day keys:** `toLocalYmd()`, `parseLocalYmd()`, `addLocalDays()`, `startOfLocalDay()` in `src/shared/localDay.ts`.
- **Format an hour of day:** `formatHourOfDay()` in `src/shared/formatters.ts` (`13` -> `"1 PM"`).
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Token pricing and Codex token totals:** `resolveModelPricing()` / `calculateModelCost()` in `src/shared/modelPricing.ts`, and `CodexTokenCounts` in `src/shared/codexTokenUsage.ts`.
- **Claude's cost and per-model usage for one turn:** `claudeTurnCost()`, `readClaudeTurnBaseline()`, `parseCostStateRow()` in `src/shared/claudeCostTracker.ts`.
- **Usage, cost and message count of a Claude transcript:** `computeClaudeSessionUsage()` / `computeClaudeUsageWithSubagents()` / `readClaudeSubagentTranscripts()` in `src/shared/claudeSessionUsage.ts`, `countClaudeTranscriptMessages()` in `src/shared/claudeTranscriptMessages.ts`.
- **Which account dir an agent runs under:** `resolveAgentAccountDir()` in `src/shared/agentAccountDir.ts` (pure; main's store-reading wrapper of the same name is in `src/main/agents/provider-account-dirs.ts`).
- **Capping stored tool output:** `compactToolOutput()` / `compactSessionToolOutputs()` in `src/shared/toolOutput.ts`.
- **Merging browser-deferred conversations:** `projectWebSession()` / `readDeferredContent()` / `mergeDeferredSessionContent()` in `src/main/stores/deferred-session-content.ts`, over `mergeDeferredItems()` / `MAX_PERSISTED_SESSION_LOGS` in `src/shared/deferredSessionContent.ts`.
- **Timestamp for a generated file name:** `fileTimestampSlug(dateOrTimestamp?)` in `src/shared/formatters.ts`.
- **Path utilities:** `truncatePath()`, `getParentDir()`, `truncateCommand()`, `isAbsolutePath()`, `getBasename()`, `joinPath()` in `src/shared/formatters.ts` (`joinPath` is the renderer-safe `path.join`: it uses whichever separator the base path speaks, so Windows and SSH-remote POSIX paths both survive)
- **Worktree path comparisons:** `normalizeWorktreePath(path, posix?)`, `isPathAtOrUnderRoot()` in `src/shared/worktreePaths.ts`.
- **Remote worktree aliases:** `resolveWorktreeAliasesRemote()` in `src/main/utils/remote-git.ts` batches saved and registered paths with independent physical, missing, or unresolved results.
- **Parsing a base64 data URL (an image payload):** `parseBase64DataUrl()`, `mediaSubtype()` in `src/shared/dataUrl.ts` (never a `base64,(.+)$` capture)
- **Reading a zip from disk:** `readZipArchive(filePath, options?)`, `extractZipTo()`, `isUnsafeZipEntryName()` in `src/main/utils/zip-archive.ts`.
- **Classifying a file by extension:** `getFileCategory()`, `isPreviewableFile()`, `matchesFileCategory()`, `getFileExtension()` in `src/shared/fileCategories.ts`.
- **Guarding a serialized JSON payload before it overwrites a file:** `assertSerializedJsonIsSafe(serialized, target)` in `src/shared/jsonUtils.ts`.
- **Serializing async work on one entity:** `createKeyedWriteQueue()` in `src/shared/keyedWriteQueue.ts` (re-exported from `src/main/utils/atomic-json-store.ts`, which is still the import site every main-process caller uses).
- **Loading an image for canvas compositing:** `loadImageElement(src)` in `src/renderer/utils/loadImage.ts`.
- **Saving generated image bytes to disk:** `saveImageDataUrlToDisk(dataUrl, defaultName?)` in `src/renderer/utils/imageExport.ts`.
- **Screenshotting a surface exactly as it is painted:** `window.maestro.shell.capturePage(rect?)` (preload in `src/main/preload/system.ts`, handler `window:capturePage` in `src/main/ipc/handlers/system.ts`).
- **An Error in a log entry or JSON payload:** `serializeError()`, `toLoggableData()` in `src/shared/serializeError.ts`, with `ipcErrorMessage(err, fallback?)` beside them for the text to SHOW from a rejected `window.maestro.*` call.
- **An ssh run that never reached the host (exit 255):** `isSshConnectionFailure()`, `describeSshUnreachable(remote, stderr)` in `src/shared/sshConnection.ts`, applied to every remote file op by `execRemoteCommand()` in `src/main/utils/remote-fs.ts`.
- **An SSH remote went down (one dialog per remote):** `noteSshExit()`, `checkSshRemote()` in `src/main/ssh-reachability.ts`; run one-shot remote commands with `execSshCommand()` in `src/main/utils/ssh-command-builder.ts`.
- **Strip ANSI / collapse progress overwrites:** `stripAnsiCodes()`, `processCarriageReturns()` in `src/shared/stringUtils.ts`
- **Reading what a TUI painted from a raw capture:** `replayTerminalScreen()`, `capturedAlternateScreen()` in `src/maestro-p/screen-replay.ts`
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
- **A path handed to a REMOTE shell (`cd`, `ls`, `stat` over SSH):** `shellEscapeRemotePath()` in `src/main/utils/shell-escape.ts`.
- **SSH connection options (`ssh -o`):** `resolveSshOptions()` / `buildSshOptionArgs()` / `validateSshOption()` in `src/shared/sshOptions.ts`.
- **HTTP request from the main process:** `fetchWithTimeout(url, options?, timeoutMs?)` in `src/main/utils/fetchWithTimeout.ts`, with `isFetchTimeoutError()` and `DEFAULT_FETCH_TIMEOUT_MS`.
- **Timing out a supervised agent process:** `createIdleWatchdog({ idleMs, maxMs?, onIdle, onMax? })` in `src/main/utils/idle-watchdog.ts`, fed by the event list in `src/main/utils/agent-liveness.ts`.
- **A git query the UI polls in the background:** `execGitReadOnly()`, `isGitTimeout()`, `READ_ONLY_GIT_TIMEOUT_MS` in `src/main/utils/remote-git.ts`
- **Whether a working directory can be spawned into:** `unusableCwdReason()` in `src/main/process-manager/utils/spawnCwd.ts`.
- **Encore Feature flags and their defaults:** `ENCORE_FEATURE_DEFAULTS`, `resolveEncoreFeatures()` in `src/shared/encoreFeatureDefaults.ts`
- **Maestro's data directory, without Electron:** `resolveUserDataDir(options?)`, `assertUserDataDirExists(dir)` in `src/shared/userDataDir.ts`.
- **Where the synced stores live (custom Storage Location):** `resolveSyncDir(userDataDir)`, `isValidSyncPath()`, `BOOTSTRAP_STORE_FILE` in `src/shared/syncPath.ts`.
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts` (works in both processes).
- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()`, `formatMetaKey()` (symbol: `⌘` / `Ctrl`), `formatMetaKeyName()` (prose: `Command` / `Ctrl`), `formatAltKeyName()` (prose: `Option` / `Alt`) in `src/renderer/utils/shortcutFormatter.ts`.
- **Advertising a shortcut next to the control that fires it:** `ShortcutHint` (`variant="chip"` for an inline key-cap, `variant="row"` for a hint header pinned above a dropdown's option list) and `shortcutSuffix(keys)` (for a `title=` tooltip) in `src/renderer/components/ui/ShortcutHint.tsx`.
- **Font-family fallback chain:** `withMonoFallback()` / `resolveSurfaceFont()` over `MONO_FALLBACK_STACK` and `SANS_FALLBACK_STACK` in `src/shared/fontStack.ts`.
- **Fixed-pitch font for shell text:** `resolveFixedPitchFontFamily()` / `resolveTerminalFontFamily()` / `isFixedPitchStack()` in `src/renderer/utils/fixedPitchFont.ts`, wrapped for React by `useFixedPitchFont()`.
- **Saving the user's own font setup:** `captureTypographySnapshot(values)`, `typographySnapshotPatch(snapshot)`, `typographySnapshotMatches(snapshot, values)` in `src/shared/typographySnapshot.ts`, persisted under the single `typographySnapshot` setting and driven by `saveTypographySnapshot()` / `restoreTypographySnapshot()` in `src/renderer/stores/settingsThemeSlice.ts`.
- **Whether a chord may be bound at all:** `findReservedShortcutCombo(keys)` over `RESERVED_SHORTCUT_COMBOS` in `src/shared/shortcutKeys.ts`.
- **Whether a keystroke belongs to a text field (guard before `preventDefault`):** `isTextInputTarget()`, `isTextEntryTarget()` in `src/renderer/utils/messageScrollNavigation.ts`.
- **How much of the keyboard the user has mastered:** `collectBoundShortcuts(...maps)` (denominator) and `countUsedBoundShortcuts(bound, usedIds)` (numerator) in `src/renderer/constants/keyboardMastery.ts`.
- **Naming the OS file manager in copy:** `getFileManagerName(platform)` / `fileManagerName()` in `src/renderer/utils/platformUtils.ts` return the bare noun (`Finder` / `Explorer` / `File Manager`), and `getRevealLabel()` / `getOpenInLabel()` are built from it.
- **Parsing a Codex assistant directive:** `parseCodexDirective()`, `findCodexDirectives()`, `KNOWN_CODEX_DIRECTIVES` in `src/shared/codexDirectives.ts`.
- **Rendering a Codex `visualize` reference inline:** `loadCodexVisualization()` in `src/main/codex-visualization.ts` (assets read from the agent's own CODEX_HOME, served on the Concerto `visualization` surface), drawn by `CodexVisualizationFrame` (`src/renderer/components/Markdown/components/CodexVisualizationFrame.tsx`)
- **Resuming a provider session a background synopsis may still hold:** `awaitSynopsisWriters()` in `src/main/process-manager/utils/synopsisWriterGate.ts`, already called by `process:spawn`.
- **Acting on a clicked Codex followup chip:** `requestCodexFollowup()`, `resolveCodexFollowup()`, `codexDirectivesLiveForSource()` and `CODEX_FOLLOWUP_EVENT` in `src/renderer/services/codexFollowup.ts`, drawn by `FollowupChip` (`src/renderer/components/Markdown/components/FollowupChip.tsx`) and answered by one `useEventListener` in `App.tsx`.
- **Running a shell code fence from an agent's reply:** `requestCodeFenceCommand()` / `CODE_FENCE_COMMAND_EVENT` in `src/renderer/services/codeFenceCommand.ts`, `isRunnableShellLanguage()` / `commandFromShellFence()` in `src/renderer/utils/shellCommandInput.ts`, drawn by `<CodeRunButton>`.
- **Touch primitives:** `isCoarsePointer()`, `triggerHaptic()`, `supportsHaptics()`, `HAPTIC_PATTERNS`, `GESTURE_THRESHOLDS`, `MIN_TOUCH_TARGET` in `src/renderer/utils/touch.ts` (do NOT re-derive `navigator.vibrate` calls or `matchMedia('(pointer: coarse)')` queries)
- **Long-press gesture:** `useLongPress()` in `src/renderer/hooks/utils/useLongPress.ts` (scroll-aware touch long-press that opens right-click affordances like context menus and tab overlays; do NOT hand-roll `setTimeout` + `touchmove`)
- **Color math and contrast:** `readableTextOn()`, `isReadableOn()`, `contrastRatio()`, `relativeLuminance()`, `blendColors()`, `transparentize()`, `adjustBrightness()`, `hexToRgb()` in `src/shared/colorContrast.ts`.
- **Diagram labels on fills the AUTHOR chose:** `repairDiagramLabelContrast(svg)` in `src/renderer/utils/diagramLabelContrast.ts`, over `cssColorToHex()` in `src/shared/colorContrast.ts`.
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **Two-letter labels for a set of agents:** `buildAgentInitials(agents)`, `agentInitialCandidates(name)` in `src/shared/agentInitials.ts`
- **Which providers a user can pick:** `AGENT_PICKER_META` / `PICKABLE_AGENT_IDS` / `getAgentPickerMeta()` in `src/shared/agentMetadata.ts`.
- **Which account dirs exist for a provider (main):** `getProviderAccountDirs(toolType, options?)` in `src/main/agents/provider-account-dirs.ts`
- **Reading a Codex account's credentials off disk:** `readCodexAuth()`, `codexAuthHeaders()`, `extractEmailFromJwt()` in `src/main/agents/codex-auth.ts`.
- **Codex rate-limit reset credits:** spend rules in `src/shared/codexResetCredits.ts` (`describeCreditSpend`, `shouldAutoSpendCredit`, `nextCreditToSpend`, `describeCreditExpiry`), the two primitives in `src/main/agents/codex-reset-credits.ts` (`fetchCodexResetCredits` READs, `consumeCodexResetCredit` WRITEs), renderer state in `src/renderer/stores/codexResetCreditsStore.ts`, automation in `src/renderer/services/codexAutoReset.ts`.
- **Naming the account a login acts on:** `AccountPill`, `ghAccountLabel()` in `src/renderer/components/ui/AccountPill.tsx`.
- **Keeping a plan account on the Usage Dashboard after its agents leave:** `rememberQuotaAccounts()`, `pruneMissingQuotaAccounts()` in `src/main/stores/quotaAccountsStore.ts`.
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Deferred main-process store persistence:** `deferStoreWrites()`, `flushPendingSessionWrites()` in `src/main/stores/deferred-writes.ts` / `src/main/stores/instances.ts`
- **Recovering from a store file that is not JSON:** `createStoreDeserializer()`, `corruptStorePath()` in `src/main/stores/corrupt-store-recovery.ts`.
- **Writing a Claude session's origin record:** `setClaudeSessionOrigin()`, `mergeClaudeSessionOrigin()` in `src/main/storage/claude-session-origins.ts`
- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })` in `src/renderer/stores/notificationStore.ts`.
- **Whether in-app toasts are on:** `areToastsEnabled()`, `TOAST_DURATION_OFF`, `resolveEnabledToastDuration()` in `src/shared/toastDuration.ts`.
- **What a toast click does:** `ToastClickAction` + `parseToastClickAction()` in `src/shared/toastClickAction.ts`, dispatched by `dispatchToastClickAction()` in `src/renderer/services/toastClickActions.ts`.
- **Toast history / unread state:** `history`, `markNotificationRead()`, `selectUnreadNotificationCount()` in `src/renderer/stores/notificationStore.ts`.
- **Center flash (rapid acks):** `notifyCenterFlash({ message, color, detail?, duration? })` in `src/renderer/stores/centerFlashStore.ts`.
- **Opening a modal / dashboard by name:** `UI_SURFACES` + `resolveUiSurface()` / `resolveUiSurfaceTab()` / `describeSurfaceAccess()` in `src/shared/uiSurfaces.ts`, dispatched by `openUiSurface()` in `src/renderer/utils/openUiSurface.ts`.
- **Whether a modal takes the window over:** `DESTINATION_MODALS` + `DESTINATION_SHORTCUT_IDS` + `registerExternalDestination()` in `src/renderer/stores/modalStore.ts`.
- **Toggling the unread filters:** `toggleAllUnreadFilters()` / `toggleTabUnreadFilter()` in `src/renderer/services/unreadFilters.ts`, with `areUnreadFiltersActive()` beside them.
- **Scheduled Tasks (clock-driven Cue subs):** types and pure helpers in `src/shared/cue/scheduled-tasks.ts`, filesystem work in `src/main/cue/cue-scheduled-tasks.ts`.
- **Editing one Cue subscription in place:** `patchSubscriptionInYaml()`, `setSubscriptionTurnSettings()`, `findSubscriptionsByName()` in `src/main/cue/cue-subscription-edit.ts`.
- **Whether two subscriptions are the same visual trigger:** `triggerGroupKey(sub)` in `src/shared/cue/trigger-group-key.ts`.
- **How big a pipeline is on the canvas:** `pipelineCardBounds(nodes, opts?)`, plus `nodeFootprintWidth()`, `estimateNodeWidth()` and `NODE_CHROME_OVERHANG` in `src/renderer/components/CuePipelineEditor/utils/nodeFootprint.ts`.
- **Which pipelines belong to an agent:** `pipelinesForSession(sessionId, pipelines, graphSessions)`, plus `pipelineInvolvesSession()` and `pipelineNamesDeclaredBySession()` in `src/renderer/components/CuePipelineEditor/utils/pipelineMembership.ts`.
- **Where a pipeline is drawn (its home agent):** `resolvePipelineHomes()` in `src/renderer/components/CuePipelineEditor/utils/pipelineMembership.ts`.
- **What a group chat does with a message it cannot send yet:** the pure rules in `src/shared/groupChatQueueModel.ts` (`mustQueue`, `canDrain`, `enqueueMessage`, `completeItem`, `failItem`, `failHead`, `requeueFailedAtFront`, `resumeQueue`, `removeItem`, `reorderItem`, `parseQueueState`), driven by `src/main/group-chat/group-chat-queue.ts`.
- **How much work happened in a group chat:** `computeGroupChatActivity(entries)` in `src/shared/groupChatActivity.ts`, fed by the per-turn measurements `src/main/group-chat/group-chat-turn-metrics.ts` stamps onto each history entry.
- **How big a tab's conversation is and how long it ran:** `computeTabConversationStats()`, `formatConversationDuration()` in `src/shared/tabConversationStats.ts`
- **Whether an agent is drawn in the Left Bar:** `sessionMatchesFilter()` and `passesUnreadFilter()` in `src/renderer/utils/sidebarMembership.ts`.
- **Whether an agent is answering a consult right now:** `useSessionIsBeingConsulted(sessionId)` for one row, `useConsultedSessionIds()` / `selectConsultedSessionIds(requests)` for a surface that draws many rows in one pass, all in `src/renderer/stores/crossAgentInFlightStore.ts`.
- **Taking the user to an agent:** `jumpToAgent(sessionId, { tabId? })`, `revealAgentInSidebar(session)`, `openAgentSettings(session)` in `src/renderer/services/agentNavigation.ts`
- **Dismissing a drawer after the user picks something in it:** `closeLeftSidebarForNavigation()` / `closeRightPanelForNavigation()` in `src/renderer/stores/uiStore.ts`, over `isNarrowViewportNow()` in `src/renderer/hooks/ui/useViewportBreakpoint.ts`.
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`.
- **Reading settings without the lifecycle effects:** `useSettingsValues()` in `src/renderer/hooks/settings/useSettings.ts`.
- **A Settings section the search can show inline:** `GENERAL_SECTIONS` / `DISPLAY_SECTIONS` / `ENCORE_SECTIONS` in each tab's `sections.tsx`, looked up by `findSettingsSection(settingId)` in `src/renderer/components/Settings/settingsSections.ts`.
- **Which agent this client is looking at:** `persistActiveSessionId()` / `readPersistedActiveSessionId()` in `src/renderer/utils/activeSessionPersistence.ts`.
- **Telling the other clients an agent appeared or went away:** `sessions:lifecycleSync`, emitted by `sessions:setMany` / `sessions:setAll` in `src/main/ipc/handlers/persistence.ts` and applied by `useSessionLifecycleSync` (`src/renderer/hooks/session/useSessionLifecycleSync.ts`).
- **Session mutation:** `updateSessionWith(sessionId, updater)` for a whole agent, plus one single-tab updater per tab type in `src/renderer/stores/sessionStore.ts`.
- **Moving an agent to another directory:** `withWorkingDirectory(session, dir)`, `workingDirectoryChangeBlocker(session)`, `isSameDirectory(a, b)`, `rebasePathOntoRoot()` in `src/renderer/utils/agentWorkingDirectory.ts`.
- **Whether a PR is being opened right now:** `usePRCreationActive(worktreePath)` / `startPRCreation(target)` in `src/renderer/stores/prCreationStore.ts`, settled by `usePRCreationNotifier`.
- **Ending a turn with no process exit:** `settleTabThinkingState(session, tabId)` in `src/renderer/utils/tabHelpers`.
- **Leaving inline wizard mode:** `flattenWizardIntoTab(tab, { summary? })` in `src/renderer/utils/tabHelpers/index.ts`.
- **Which agents own an Opt+Cmd+# slot:** `buildSessionJumpSlotMap(visibleSessions)`, `sessionJumpShortcut(digit)` in `src/renderer/utils/sessionJumpSlots.ts`
- **Focus an AI tab:** `aiTabFocusFields(tabId?)` in `src/renderer/utils/tabHelpers`.
- **Focus a file tab:** `fileTabFocusFields(tabId)` in `src/renderer/utils/tabHelpers`.
- **Closing a tab while the unread filter is on:** `closeTab()`'s third argument is an OVERRIDE, not a value you must supply - omit it and `src/renderer/utils/tabHelpers` reads `uiStore.showUnreadOnly` itself.
- **Naming a tab from the user's message:** `requestTabAutoName()`, `collectNamingPrompt()`, `requestWizardTabAutoName()` in `src/renderer/services/tabAutoNaming.ts`
- **Which provider account an agent runs as:** `resolveAgentProfile()` / `resolveAgentAccountKey()` / `effectiveAgentCustomEnvVars()` / `resolveAgentBillingCredential()` over `PROVIDER_PROFILE_CONFIGS` in `src/shared/providerProfiles.ts`, indexed for the renderer by `useProviderProfiles(sessions)` in `src/renderer/hooks/stats/useProviderProfiles.ts`.
- **Per-agent git actions:** `useGitAgentActions(session)` in `src/renderer/hooks/git/useGitAgentActions.ts`.
- **What an unnamed tab is called:** `getTabDisplayName(tab)` in `src/renderer/utils/tabHelpers`, over `formatSessionId(agentSessionId)` for the id label itself (`8535E0E3`, `SES_4BCD`, `THR_ABC1`).
- **Where a closed tab's name still exists:** `HistoryEntry.sessionName`, and in practice nowhere else; every surface that reopens a past session passes it as `handleResumeSession`'s third argument.
- **Whether an AI tab is drawn in the tab strip:** `isAiTabHidden(tab)` in `src/renderer/utils/unifiedTabOrderUtils.ts`, and `visibleAiTabs(tabs)` beside it for the list form (returns the input by reference when nothing is hidden, so callers can memoize on identity).
- **Counting or listing an agent's tabs by visibility:** `tabStripSlotKeys()`, `tabStripVisibility()`, `countTabStrip()`, `countOpenTabs()`, `dropOrphanedTabs()`, `collectGroupMemberTabKeys()` in `src/shared/tabStripMembership.ts`.
- **Never leaving an agent with an empty tab strip:** `ensureAgentHasVisibleTab()`, `agentHasVisibleTab()`, `createBlankAiTab()` in `src/renderer/utils/unifiedTabOrderUtils.ts`.
- **Audio/video playback:** media NEVER becomes a file preview tab; `handleOpenFileTab()` in `src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts` diverts it to `useMediaPlaybackStore.openMedia()` / `enqueueMedia()`, and the one player is `FloatingMediaPlayer` under `MediaPlaybackHost`.
- **Opening a clicked link:** `openUrl(url, { ctrlKey })` in `src/renderer/utils/openUrl.ts`, over `parseUrlRoutingHint()` / `isWebUrl()` / `stripUrlRoutingHint()` in `src/shared/urlRoutingHint.ts`
- **Run a shell command from the chat:** `dispatchShellCommand()` (records it in recall history, then runs it) / `runShellCommand()` / `cancelShellCommand()` / `resolveCommandCwd()` in `src/renderer/services/shellCommand.ts`.
- **Revealing output the user asked for, past a paused auto-scroll:** `requestTranscriptScrollToBottom(sessionId, tabId)` / `TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT` in `src/renderer/services/transcriptScroll.ts`.
- **Delete the file the user is previewing:** `requestFileDeletion({ path, sshRemoteId?, sessionId? })` in `src/renderer/services/fileDeletion.ts`.
- **Telling the Files panel a file appeared or vanished:** `requestFileTreeRefresh(sessionId)` in `src/renderer/utils/fileTreeRefresh.ts` (renderer) and `nudgeFileTreeForPaths(paths)` in `src/cli/services/file-tree-refresh.ts` (CLI).
- **Ask the model for a shell command (AI command mode):** `requestAiCommand()` / `acceptAiCommand()` / `dismissAiCommand()` in `src/renderer/services/aiCommand.ts`, state in `src/renderer/stores/aiCommandStore.ts`, prompt in `src/prompts/ai-command.md` (id `ai-command`, editable in Settings -> Maestro Prompts).
- **The system-prompt envelope for a provider with no `--append-system-prompt`:** `EMBEDDED_SYSTEM_PROMPT_SEPARATOR`, `embedSystemPromptInPrompt(systemPrompt, userPrompt)`, `stripEmbeddedSystemPrompt(text)`, `hasEmbeddedSystemPrompt(text)` in `src/shared/embeddedSystemPrompt.ts`.
- **Consulting another agent from a message (`@mention`):** `planCrossAgentMentions()` / `dispatchCrossAgentMentions()` / `dispatchCrossAgentMentionsForMessage()` in `src/renderer/services/crossAgentMentions.ts`, over `sendCrossAgentRequest()` in `src/renderer/hooks/agent/useCrossAgentDispatch.ts`.
- **Quoting a passage into the agent's message box from outside the chat:** `quoteIntoAgentComposer(sessionId, text)` in `src/renderer/services/quoteIntoComposer.ts`, over `appendQuoteToDraft()` / `formatFileSelection()` in `src/renderer/utils/quoteSelection.ts`.
- **Holding a mentioning turn open until its consult replies:** `holdTurnForConsults()`, `settleConsultHold()`, `withConsultPendingNote()` in `src/renderer/services/crossAgentConsultHold.ts`.
- **When a mention runs (parallel / consult first / hand-off):** `inferMentionTiming()` in `src/shared/crossAgentContext.ts`, carried as `CrossAgentMentionPlan.routing`.
- **An agent asking another agent (`maestro-cli ask`):** `runCrossAgentAsk()` in `src/renderer/services/crossAgentAsk.ts`, over the same `sendCrossAgentRequest()` a typed `@mention` uses.
- **Marking an agent's own hand-off in its transcript (`dispatch` / `ask` from its shell):** `readCallerIdentity()` / `callerMessageFields()` / `readCallerMessageFields()` / `isSelfDispatch()` in `src/shared/agentDelegation.ts`, `noteDispatchDelegation()` in `src/main/web-server/handlers/messageHandlers/agentDelegation.ts`, `recordAgentDelegation()` / `settleAgentDelegation()` in `src/renderer/services/agentDelegation.ts`, drawn by `<AgentDelegationCard>`.
- **Sending a prompt to an agent from outside the composer:** `enqueuePromptForTab()` / `buildQueuedMessageItem()` in `src/renderer/services/queuedPrompt.ts`.
- **What a snooze opener was handed:** `resolveSnoozeTarget(session, id)` in `src/renderer/utils/snoozeHelpers.ts`, returning `{ tabId, tabLabel, canRunWakePrompt }`.
- **Parking, waking, dismissing, or rescheduling ONE snooze:** `snoozeTabWithMirror()`, `wakeSnoozeNow()`, `dismissSnoozeNow()`, `rescheduleSnoozeNow()` in `src/renderer/services/snoozeActions.ts`, with `runRemoteSnoozeCommand()` beside them for the CLI's far end.
- **Appending to a transcript entry:** `canAppendToLogEntry(entry, source)` / `isSelfContainedCard(entry)` in `src/renderer/utils/logEntries.ts`.
- **Command mode (`!`) is STATE, not a text prefix:** `composerInputStore.aiCommandMode` (`'off' | 'shell' | 'ai'`), persisted as `AITab.commandMode`; read it with `isShellCommandMode()` / `isAiCommandMode()` / `normalizeComposerCommandMode()` in `src/renderer/utils/shellCommandInput.ts`, never by testing the text for a leading `!` or the value for truthiness (`'off'` is truthy).
- **Shell tab completion:** `useTabCompletion()` in `src/renderer/hooks/input/useTabCompletion.ts` serves BOTH the terminal composer and command mode, told apart by its third `commandMode` argument (the text can't say which - a command line looks the same either way).
- **Right-click menu on an image:** already done app-wide by `<ImageContextMenuHost>` in `src/renderer/components/ImageContextMenuHost.tsx` (one delegated listener; opt a surface out with `data-no-image-menu`).
- **Font zoom on a reading pane:** `useFontScale(storageKey)` in `src/renderer/hooks/ui/useFontScale.ts` + `<FontScaleControl>` in `src/renderer/components/ui/FontScaleControl.tsx` (`variant="inline"` for a toolbar, `variant="floating"` for a pill over a scrolling pane).
- **Pan and zoom a diagram or image:** `usePanZoom()`, `fitToView` in `src/renderer/hooks/ui/usePanZoom.ts`.
- **Bare `+` / `-` / `0` zoom on a surface:** `useScaleShortcuts(control, { enabled })` in `src/renderer/hooks/ui/useScaleShortcuts.ts`, over any `useScalePreference` control, with the keys named in the buttons' tooltips via `<ScaleControl shortcutHint>`.
- **Whether a surface is the topmost layer:** `useIsTopLayer(priority)` in `src/renderer/hooks/ui/useIsTopLayer.ts`.
- **Who asked for this turn (interactive vs automation):** `QUERY_SOURCE_ENV_VAR` / `QuerySource` / `DEFAULT_QUERY_SOURCE` in `src/shared/querySource.ts`.
- **Prefixing an agent's New Session Message:** `prependNewSessionMessageOnFirstTurn(prompt, message, agentSessionId)` for a turn that may be RESUMING, `prependNewSessionMessage(prompt, message)` for a spawn that is always a new provider session, both in `src/shared/newSessionMessage.ts`.
- **Who SENT this turn (Web Login attribution):** `getActingUser()` in `src/main/web-server/auth/acting-user.ts`, `noteTurnActor()` / `resolveTurnActor()` / `forgetAgentActors()` in `src/main/web-server/auth/turn-attribution.ts`.
- **An agent's effective environment:** `resolveAgentEnvironment()`, `isSecretEnvKey()`, `maskEnvValue()`, `envSourceLabel()` in `src/shared/agentEnvironment.ts`, rendered by `<EnvVarList>` in `src/renderer/components/ui/EnvVarList.tsx`.
- **Tiny uppercase state chip:** `<MiniBadge>` in `src/renderer/components/ui/MiniBadge.tsx`.
- **The red Stop pill:** `<StopTurnButton>` in `src/renderer/components/ui/StopTurnButton.tsx`.
- **"Show only providers this machine can run":** `filterToAvailableProviders()` / `providerLocationLabel()` in `src/renderer/utils/providerAvailability.ts`, rendered by `<ProviderAvailabilityBar>` in `src/renderer/components/ui/ProviderAvailabilityBar.tsx`.
- **Whether a login flow can fix an auth failure:** `classifyCredentialKind()` and `credentialKindBlocksLogin()` in `src/shared/providerAuthIdentity.ts`, which also owns `providerAuthKey()` (the credential's shared scope: agent binary + host).
- **Typing a login command into a shell:** `formatAgentLoginCommand(login, syntax?)` and `loginShellSyntaxFor(shellId, isWindows)` in `src/shared/agentMetadata.ts`.
- **Bucketing Director's Notes bullets:** `bucketNarrativeItems()` / `shouldRenderBuckets()` / `buildNarrativeGroupLookup()` in `src/shared/directorNotesGrouping.ts`, bound to live store state by `useNarrativeGroupLookup()` in `src/renderer/components/DirectorNotes/`.
- **Which provider generates a synopsis:** `AUTO_SYNOPSIS_PROVIDER`, `synopsisProviderChoice()`, `pickFirstAvailableProvider()` in `src/shared/directorNotesProvider.ts`.
- **Data a surface fetches that must survive it unmounting (stale-while-revalidate):** `useCachedResource(key, fetcher, { enabled?, onError? })`, `revalidateCachedResource()`, `readCachedResource()` in `src/renderer/hooks/utils/useCachedResource.ts`.
- **Tokens per second:** `extractClaudeSpeedSamples()`, `computeClaudeTokenSpeed()`, `CodexTokenSpeedTracker`, `summarizeTokenSpeed()` in `src/shared/tokenSpeed.ts`, displayed with `formatTokensPerSecond()` from `src/shared/formatters.ts`.
- **Parsing a session transcript in the main process:** `runTranscriptParse(task)` in `src/main/transcript-parse/transcript-parse-pool.ts` (worker threads; task bodies in `transcript-parse-tasks.ts` must stay electron-free)
- **Reading a page of a transcript's messages:** `forEachJsonlLine()` in `src/main/utils/jsonl-stream.ts` feeding `MessagePageCollector` in `src/main/storage/base-session-storage.ts`, and `readFirstJsonlLine()` beside it for a header lookup.
- **A cache derivation upgrade that survives being killed:** `isDerivationStale()`, `accumulateUpgradeBaseline()`, `finishDerivationUpgrade()` in `src/main/utils/statsCache.ts`.
- **Showing the progress of a long scan:** `withStatsIndexing()` in `src/main/stats/stats-indexing.ts`, `summarizeStatsIndexing()` in `src/shared/statsIndexing.ts`, drawn by `<StatsIndexingHost>`
- **Color for the Nth chart series:** `getSeriesColor(index, theme, colorBlindMode?)` in `src/renderer/components/UsageDashboard/chartUtils.ts`.
- **Sortable table header:** `<SortableTh>` in `src/renderer/components/ui/SortableTh.tsx` + `useTableSort()` in `src/renderer/hooks/ui/useTableSort.ts`.
- **Graphing a set of documents rather than one:** `BuildOptions.scopeFiles` / `scopeDirectory` in `src/renderer/components/DocumentGraph/graphDataBuilder.ts`, opened via `openGraphScope()` in `fileExplorerStore.ts`.
- **A labeled action button in a panel header:** `<HeaderActionButton>` in `src/renderer/components/ui/HeaderActionButton.tsx`.
- **Highlighting a search hit:** `highlightMatches(text, query, accentColor)` in `src/renderer/utils/highlightMatches.tsx` for ordinary text, and `<TextareaHighlightOverlay>` in `src/renderer/components/ui/TextareaHighlightOverlay.tsx` for text inside an editable `<textarea>`.
- **Highlighting a FUZZY hit:** `renderFuzzyHighlight(text, indices, styles?)`, `fuzzyMatchWithIndices(text, query)` in `src/renderer/utils/search.ts`.
- **Opening the expanded staged-image organizer:** `requestOpenStagedImagesOrganizer()` and `OPEN_STAGED_IMAGES_ORGANIZER_EVENT` in `src/renderer/services/stagedImagesOrganizer.ts`.
- **A list of editable `key = value` pairs:** `<KeyValueRows>` in `src/renderer/components/ui/KeyValueRows.tsx`, with `recordToKeyValueRows()` / `keyValueRowsToRecords()` beside it.
- **Switching a `key = value` entry off without deleting it:** `splitParkedEntries()` / `setKeysParked()` / `parkedPairKeys()` in `src/shared/parkedRecords.ts`.
- **`.env` text for an env-var editor (Advanced mode):** `parseDotEnv()`, `serializeDotEnv()`, `envVarRecordsFingerprint()`, and the validator both editing modes share (`validateEnvVarEntry()`, `ENV_VAR_NAME_PATTERN`) in `src/shared/dotEnv.ts`.
- **A text box that narrows a list:** `<FilterInput>` in `src/renderer/components/ui/FilterInput.tsx`.
- **A pane that reads and edits a markdown document:** the File Preview stack, never a bare `<textarea>`: `<Markdown preset="document">` for reading, `<MarkdownEditor>` from `src/renderer/components/FilePreview/markdownEditor` for writing, and the user's live `toggleMarkdownMode` binding to flip between them (`MemoryViewer` is the reference implementation).
- **Jumping a markdown preview to a heading:** `scrollToHeadingSlug()`, `headingLevelColor()` in `src/renderer/components/FilePreview/shared/headings.ts`, reached from a modal via `requestHeadingPalette()` / `HEADING_PALETTE_EVENT` in `src/renderer/services/headingPalette.ts`.
- **Which heading the reader is under right now:** `findActiveHeadingSlug(scroller, container, onReadActive?)` plus `ACTIVE_HEADING_FOLD_PX` in `src/renderer/components/FilePreview/shared/headings.ts`.
- **Highlight vs selection in a heading list:** `FilePreviewToc` (`src/renderer/components/FilePreview/FilePreviewToc.tsx`) takes `activeIndex` (where the document is scrolled) and keeps its own `selectedIndex` (which row is lit); `-1` is a real value on both.
- **Keyboard navigation in a `<DualPaneFileEditor>` list:** built in (Up/Down walk visible rows, Backspace/Delete raise `onDeleteItem(selectedId)`); pass `autoFocusList` and bump `listFocusToken` after a consumer-driven delete.
- **Segmented toolbar (sort/filter pill bar):** `<SegmentedControl>` in `src/renderer/components/ui/SegmentedControl.tsx`.
- **Paginating a list already in memory:** `usePagination(items, pageSize, resetKey)` in `src/renderer/hooks/ui/usePagination.ts`, pure helpers in `src/renderer/utils/pagination.ts`, UI in `<Pager>` (`src/renderer/components/ui/Pager.tsx`).
- **Keeping a scrolling strip's active item on screen:** `useRevealActiveItem(activeKey, { align? })` + `revealActiveProps(isActive)` in `src/renderer/hooks/ui/useRevealActiveItem.ts` (scrolls the container only, never `scrollIntoView`; re-reveals on resize)
- **Following streaming output in a capped box:** `useStickToBottom(contentKey)` in `src/renderer/hooks/ui/useStickToBottom.ts`.
- **Restoring an AI tab's scroll position:** the `initialScrollTop` + `initialIsAtBottom` pair, consumed by `useTerminalOutputScroll()` in `src/renderer/components/TerminalOutput/hooks/useTerminalOutputScroll.ts`.
- **Reaching an off-screen item while dragging:** `useDragAutoScroll(ref, { active, startInset?, endInset? })` in `src/renderer/hooks/ui/useDragAutoScroll.ts`.
- **Keeping a virtualized list on its selection:** the virtualizer's own `scrollToIndex` from an effect keyed on the selected index, never a `ref` on the selected row; in a NON-virtualized list use `useScrollIntoView` in `src/renderer/hooks/ui/useScrollIntoView.ts`.
- **Adding a control to the Left Bar header:** the row is three zones (identity, indicators, menu) in `SessionList.tsx`; a status control goes in the CENTER band, and the wordmark is drawn in full or dropped (`showWordmark`), never truncated.
- **Element width for JS-computed layout:** `useElementWidth(ref, enabled?)` in `src/renderer/hooks/ui/useElementWidth.ts`.
- **Keeping toasts off a surface the user works in:** `useToastAvoidZone()`, `toastBottomInset()` in `src/renderer/hooks/ui/useToastAvoidZone.ts`
- **Usage Dashboard card tile:** `<EntityTile>` in `src/renderer/components/UsageDashboard/EntityTile.tsx`.
- **A label that must not truncate:** `useOptionalLabelFits(rowRef)` in `src/renderer/hooks/ui/useOptionalLabelFits.ts`
- **Usage Dashboard metric tile:** `MetricCard` in `src/renderer/components/UsageDashboard/MetricCard.tsx`
- **Recording wizard usage:** `beginWizardRun()`, `recordWizardDocuments()` in `src/renderer/services/wizardStats.ts`
- **Naming an agent from its folder (vs naming the project):** `projectNameFromPath()`, `defaultAgentNameForPath()` in `src/renderer/components/Wizard/shared/projectIdentity.ts`
- **Creating a tab straight into a tile:** `tileNewTab()` / `canTileNewTab()` in `src/renderer/hooks/tabs/tileNewTab.ts`.
- **Opening a modal from inside Settings:** `launchFromSettings(open)` in `src/renderer/utils/launchFromSettings.ts`.
- **Filtering the Git Log:** `gitLogSearchTerms(query)`, `matchesGitLogTerms(commit, terms)` in `src/renderer/utils/gitLogSearch.ts`.
- **Layout and navigation for the Git Log graph:** `buildGitGraphCore()`, `computeGitGraphGeometry()`, `stepGitGraphVertical()`, `stepGitGraphHorizontal()`, `jumpGitGraphVertical()`, `gitGraphColumnEdge()`, `gitGraphTopCommit()`, `buildGitGraphTemplate()`, `assignGitGraphBranches()`, `pickBranchFromRefs()` in `src/renderer/utils/gitGraphLayout.ts`.
- **Arrow-key navigation over a list or grid:** `useListNavigation()` in `src/renderer/hooks/keyboard/useListNavigation.ts`.
- **Rendering raw terminal output (ANSI):** `useAnsiConverter(theme)` in `src/renderer/hooks/ui/useAnsiConverter.ts` for the theme-aware `ansi-to-html` converter, then `getCachedAnsiHtml(text, theme.id, converter)` in `src/renderer/utils/textProcessing.ts` to convert, sanitize (DOMPurify), and cache.
- **Any CLI verb that can move the Maestro view:** `resolveBackgroundFlag()` (CLI side) / `readBackgroundField()` (handler side) in `src/shared/focusPlacement.ts`.
- **Making a tab the visible one:** the four `*FocusFields` helpers in `src/renderer/utils/tabHelpers/focusFields.ts` (`aiTabFocusFields`, `fileTabFocusFields`, `browserTabFocusFields`, `terminalTabFocusFields`), re-exported from `tabHelpers`.
- **Record view for one table row:** `<RecordDetailModal>` in `src/renderer/components/ui/RecordDetailModal.tsx`.
- **Previewing a parquet file:** `<ParquetViewer>` in `src/renderer/components/ParquetViewer/`, over the main-process engine in `src/main/parquet/` and the shared filter language in `src/shared/parquet/`.
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Keyboard-shortcut hint / kbd pill:** `<Keycap>` and `<KeycapHint>` in `src/renderer/components/ui/Keycap.tsx`.
- **Modal / find-bar ESC pill:** `<EscCloseButton>` in `src/renderer/components/ui/EscCloseButton.tsx`.
- **Keeping a floating menu on screen:** `useContextMenuPosition(menuRef, x, y)` in `src/renderer/hooks/ui/useContextMenuPosition.ts`, which `useAnchoredMenuPosition` also passes through.
- **How a floating surface looks (popover, menu, hover card, tooltip):** `elevatedSurfaceStyle(theme)`, `getElevatedSurfaceColors(colors)` in `src/renderer/utils/elevatedSurface.ts`
- **Dropdown/tooltip anchored to a header element:** `useAnchoredMenuPosition(menuRef, anchorRef)` in `src/renderer/hooks/ui/useAnchoredMenuPosition.ts`, rendered via `createPortal(..., document.body)`.
- **A menu that opens on mouse hover AND on click:** `useHoverPopover({ triggerRef, contentRef, hoverEnabled? })` in `src/renderer/hooks/ui/useHoverPopover.ts`.
- **Remembered textarea height:** `useResizableTextarea()` in `src/renderer/hooks/ui/useResizableTextarea.ts`.
- **Auto-growing composer textarea:** `useAutosizeTextarea()` in `src/renderer/hooks/ui/useAutosizeTextarea.ts` (helpers in `src/renderer/utils/textareaSizing.ts`).
- **Line numbers beside a `<textarea>`:** `<TextareaLineNumbers>` + `lineNumberGutterMetrics()` in `src/renderer/components/ui/TextareaLineNumbers.tsx`.
- **Guarded `localStorage` access:** `safeLocalStorage()` in `src/renderer/utils/safeLocalStorage.ts`, with `safeSessionStorage()` beside it for state that belongs to one browser TAB rather than to the browser, `writeStorageValue(storage, key, value)` for a write to any Storage, and `safeStorageGet(key)` / `safeStorageSet(key, value)` for ordinary localStorage preference reads and writes.
- **A view preference a user sets by clicking:** `usePersistedToggle(storageKey, defaultValue)` in `src/renderer/hooks/ui/usePersistedToggle.ts`.
- **Sizing a Document Graph node:** `calculateNodeWidth(label, previewCharLimit)` and `calculateNodeHeight(previewText, previewCharLimit)` in `src/renderer/components/DocumentGraph/mindMapLayouts.ts`.
- **A pane width the user sets by dragging:** `useResizablePanel()` in `src/renderer/hooks/ui/useResizablePanel.ts` for the drag itself, then pick the persistence by where the pane lives.
- **A dropdown the user resizes by its bottom edge (never off screen):** `useResizableDropdownHeight()`, `fitDropdownHeight` in `src/renderer/hooks/ui/useResizableDropdownHeight.ts`
- **A modal default sized to the screen:** `viewportModalSize({ width, height })` in `src/renderer/utils/modalSizing.ts`, passed as `defaultSize` to `useResizableModal`.
- **Focus after render:** `useFocusAfterRender()` in `src/renderer/hooks/utils/useFocusAfterRender.ts` (do NOT use `useEffect + setTimeout(() => ref.focus())`).
- **Event listeners:** `useEventListener()` in `src/renderer/hooks/utils/useEventListener.ts` (do NOT pair raw `addEventListener`/`removeEventListener` inside useEffect)
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()`, `useThrottledCallback()` in `src/renderer/hooks/utils/useThrottle.ts` (filename is misleading - all three live here)
- **Identity-stable callback:** `useStableCallback()` in `src/renderer/hooks/utils/useStableCallback.ts`.
- **Render markdown:** `<Markdown preset="chat | document | release-notes">` from `src/renderer/components/Markdown/` (do NOT hand-roll `<ReactMarkdown>` + a per-surface `components`/plugin map).
- **Expanding `{{INCLUDE:name}}` in a prompt:** `resolvePromptIncludes()`, `findPromptIncludeNames()` in `src/shared/promptIncludes.ts`
- **Clickable task checkboxes in rendered markdown:** `toggleTaskCheckboxAtLine(content, line)` in `src/renderer/utils/markdownTasks.ts`, plus `rehypeSourceLine` (`src/renderer/components/Markdown/rehypeSourceLine.ts`) and the `onTaskToggle` option on `createMarkdownComponents()`, which swaps in `<TaskCheckbox>`.
- **Model/effort badges on a finished turn:** `<TurnSettingPills>` in `src/renderer/components/ui/TurnSettingPills.tsx`, fed from `LogEntry.turnModel` / `turnEffort`.
- **Tab overlay-menu shortcut badge:** `<ShortcutHint keys={...} theme={theme} />` in `src/renderer/components/ui/ShortcutHint.tsx`.
- **Which tab a tab-scoped action targets:** `resolveActiveTabRef(session)` in `src/renderer/utils/panelLayout.ts` returns the `UnifiedTabRef` a per-tab command (rename, etc.) should act on.
- **The tab a queued item is going to:** `resolveQueuedItemTabName(session, item)` in `src/renderer/utils/executionQueue.ts` for the LABEL, `resolveQueuedItemTarget()` in `src/renderer/utils/tabHelpers` for the tab itself.
- **Whether a queued item's tab is still mid-turn:** `isQueuedItemTargetBusy(session, item)` in `src/renderer/utils/tabHelpers`.
- **Editing the newest queued message:** `requestEditLastQueuedMessage()` in `src/renderer/services/editQueuedMessage.ts`.
- **Whether a Force Send control exists at all:** `shouldOfferForceSend(eligibility)` in `src/renderer/utils/executionQueue.ts`, paired with `getForceSendEligibility()` (can it run?) and `getForceSendTitle()` (why not?).
- **Model tier / effort level (`'low' | 'medium' | 'high'`):** `resolveTierModel()`, `resolveEffortLevel()`, `cheapTurnSettings()` in `src/shared/modelTiers.ts`.
- **A provider refusing an effort level:** `parseEffortRejection()`, `noteEffortRejection()`, `getEffortRejection()`, `describeEffortRejection()` in `src/shared/effortRejection.ts`.
- **Auto Run document names (absolute path to folder-relative):** `resolveAutoRunDocumentName()`, `resolveAutoRunDocumentNames()` in `src/shared/autoRunDocumentPaths.ts`
- **Un-parking an Auto Run stopped on an error:** `registerBatchResumer()`, `getBatchResumer()` in `src/renderer/services/batchResumer.ts`.
- **Auto Run markers (HITL / halt / model hint):** `scanMaestroMarkers()`, `findPendingHitlGate()`, `detectHaltMarker()`, `hasMaestroMarker()` in `src/shared/autorunMarkers.ts`, rendered by `remarkMaestroMarkers` (`src/renderer/components/Markdown/remarkMaestroMarkers.ts`) + `<MarkerPill>`.
- **Fence-aware markdown scanning:** `forEachMarkdownLine()`, `UNCHECKED_TASK_REGEX`, `CHECKED_TASK_COUNT_REGEX`, `CHECKED_TASK_REGEX` in `src/shared/markdownTaskScan.ts`.
- **Thinking mode (`'off' | 'on' | 'sticky'`):** `THINKING_MODES`, `nextThinkingMode()`, `asThinkingMode()` in `src/shared/types.ts`.
- **Whether an agent is working right now (main process):** `isAgentBusy(session, processManager)` / `isAiTabProcessActive(processManager, agentId, tabId, isActiveTab)` in `src/main/utils/agent-busy.ts`.
- **Loading a LOCAL file tree:** `walkLocalFileTree()` / `loadFileTree()` in `src/main/utils/file-tree-walk.ts`.
- **`{{template}}` variable autocomplete:** `useTemplateAutocompleteEngine()` in `src/renderer/hooks/input/useTemplateAutocompleteEngine.ts` owns the state machine (when the popup opens, what the query is, which key does what, what text replaces what).
- **Whether a surface is on a phone:** `usePhoneLayout()` / `isPhoneLayout()` in `src/renderer/hooks/ui/useViewportBreakpoint.ts`.
- **The `src` of a conversation image:** `displayImageSrc(src)` in `src/renderer/utils/sessionImageSrc.ts`, over the reference grammar in `src/shared/sessionImageRefs.ts`.
- **A tab chip's action menu shell:** `<TabOverlayPortal>` in `src/renderer/components/TabBar/TabOverlayPortal.tsx`.
- **A bottom sheet on a phone:** `<PhoneBottomSheet>` in `src/renderer/components/ui/PhoneBottomSheet.tsx`.
- **Rows inside a `PhoneBottomSheet`:** `PhoneSheetSection`, `PhoneSheetOptionRow`, `PhoneSheetActionRow` in `src/renderer/components/ui/PhoneSheetRows.tsx`, with `PHONE_SHEET_ROW_HEIGHT` (52) and `PHONE_SHEET_OPTION_HEIGHT` (44).
- **The file preview toolbar on a phone:** `<FilePreviewActionsSheet>` in `src/renderer/components/FilePreview/FilePreviewActionsSheet.tsx`, fed by the `FilePreviewHeaderAction` / `FilePreviewHeaderStat` lists `FilePreviewHeader` builds.
- **Every composer setting on a phone:** `<ComposerOptionsSheet>` in `src/renderer/components/InputArea/components/ComposerOptionsSheet.tsx`, opened by the `...` in `ToolbarControls`' phone branch.
- **A keyboard-only hint (chord badge, keycap, arrow-key legend):** put `data-shortcut-hint` on it; one rule in the "Phone layout" block of `src/renderer/index.css` hides every element carrying it on a phone.
- **A control whose only pointer path is a double-click:** give it a single-tap path under `isCoarsePointer()` (iOS never dispatches `dblclick`); drive it in tests with `setCoarsePointer()` from `src/__tests__/helpers/mockPointer.ts`.
- **A tab chip on a phone:** the chip is capped at `60vw`, only its label (`data-tab-label`) shrinks, and the close button carries `data-tab-close`; the rules in `src/renderer/index.css` key on those attributes, so mark them on any new chip type.
- **A modal that fills a phone:** nothing to write; every modal that passes a `resizeKey` stamps `data-modal-resize-key` and the phone stylesheet makes it full-screen, while a small dialog passes no key and stays a dialog.
- **Clearing the iOS status bar in a home-screen web app:** `--maestro-top-inset` in `src/renderer/index.css`, fed by `installStandaloneStatusBarInset()` in `src/renderer/utils/standaloneStatusBar.ts` (called from the web bootstrap).
- **Swipe down to close a modal on a phone:** `useLayerSwipeDismiss()` in `src/renderer/hooks/ui/useLayerSwipeDismiss.ts`, mounted once in `LayerStackProvider`.
- **Whether a configured env value means "unset":** `isBlankEnvValue()`, `isBlankEnvKey()`, `stripBlankEnvVars()` in `src/shared/agentEnvironment.ts`
- **Suggesting an env-var NAME:** `suggestEnvVarKeys()`, `PROVIDER_ENV_VAR_SUGGESTIONS`, `COMMON_ENV_VAR_SUGGESTIONS`, `rememberableEnvVarKeys()`, `withBlankEnvVarRow()` in `src/shared/envVarCatalog.ts`, rendered by `<EnvVarKeyInput>` in `src/renderer/components/shared/EnvVarKeyInput.tsx` and fed by `useKnownEnvVarKeys()`.
- **Reaching the open file preview from a modal:** `requestHeadingPalette()`, `HEADING_PALETTE_EVENT` in `src/renderer/services/headingPalette.ts`
- **Rendering a surface containing `<MarkdownEditor>` in a test:** `markdownEditorModuleMock()` in `src/__tests__/helpers/mockMarkdownEditor.tsx` (CM6 cannot lay itself out in jsdom)
- **Sizing a virtualized row the user's font decides:** `virtualizer.measureElement` + `data-index` and NO inline `height`; see `HistoryPanel` and `FileSearchModal`.
- **An agent's model list, and refreshing it:** `discoverAgentModels()` in `src/main/agents/model-discovery.ts`, `refreshModels()` on `useAgentModelEffortOptions()`.
- **Whether an absolute path exists, from render code:** `checkPathExists()` in `src/renderer/utils/fileLinks/pathExistence.ts`, `usePathExistence(sshRemoteId?)` in `src/renderer/hooks/utils/usePathExistence.ts` (async-filled cache; `remarkFileLinks` links a spaced absolute path only once it exists)
- **Finding the file a markdown embed points at:** `resolveEmbedCandidates()`, `findFirstExistingPath()`, `parseEmbedAltSize()` in `src/renderer/utils/fileLinks/embedResolution.ts`.
- **A path the user typed on the CLI:** `resolveCliPath(input)` in `src/cli/utils/parse.ts`
- **Filing GitHub feedback (check gh, search, +1, submit):** `submitFeedbackConversation()`, `searchFeedbackIssues()` in `src/main/feedback/index.ts`
- **Sizing a surface to its longest label:** `widestLabelWidth(labels, opts)`, `estimateLabelWidth()` in `src/renderer/utils/labelWidth.ts`
- **Diagram content clipped at the SVG edge:** `expandSvgViewBoxToContent(svg, padding?)` in `src/renderer/utils/svgViewBox.ts`
- **Ordering the Auto Run run list from the picker:** `applySelectionOrder()`, `selectFolderFiles()` in `src/renderer/utils/documentSelectionOrder.ts`
- **Whether an Auto Run is parked waiting on the user:** `useAutoRunErrorPaused(sessionId)` in `src/renderer/hooks/batch/useAutoRunPause.ts` (never read `errorPaused` off the `batchRunState` prop; the chain drops it)
- **What the Thinking pill lists:** `buildThinkingItems(sessions, ownsSession?)` in `src/renderer/utils/thinkingItems.ts` (read through `useThinkingItems()`).
- **Folding a disk change into an Auto Run draft:** `reconcileDiskContent()`, `isAutoRunDocumentLocked()` in `src/renderer/utils/autoRunDraft.ts`
- **Auto Run percent complete and ETA:** `autoRunProgressPercent()`, `estimateAutoRunEta()` in `src/shared/autorunProgress.ts`, drawn by `<AutoRunProgressStats>`.
- **Auto Run steering notes (mid-run course correction):** `formatSteeringNotesBlock()`, `MAX_PENDING_STEERING_NOTES` in `src/shared/autorunSteering.ts`.
- **Turning the web interface or its tunnel on or off:** `startLiveServer()`, `stopLiveServer()`, `disableAllLive()`, `turnLiveModeOff()`, `startTunnel()`, `stopTunnel()`, `getLiveModeState()`, `ensureCliServer()` in `src/main/web-server/live-mode.ts`.
- **Lifetime counters that must never go down (`usageStats`, `autoRunStats`):** `mergeUsagePeaks()` in `src/shared/usagePeaks.ts`, `mergeAutoRunStats()` in `src/shared/autoRunStatsMerge.ts`, enforced in `settings:set`
- **Whether this renderer owns an app-wide side effect:** `useIsLifecycleOwner()` in `src/renderer/contexts/WindowContext.tsx` (primary desktop window only; a web-desktop tab also reads as `isMainWindow`)
- **Context and grouping on Sentry events:** `v8OomFingerprint()` in `src/shared/sentryGrouping.ts` (one issue per process for V8 OOM minidumps, `['v8-oom', <process>]`, plus tag `native.crash: v8-oom`).

If your use case does NOT match an existing utility, prefer extending the canonical file over creating a new one. If you genuinely need something new, add the full entry to [CANONICAL-UTILITIES.md](docs/agent-guides/CANONICAL-UTILITIES.md) and a one-line index entry above so the next person can find it.

The tracker at [DEDUP-TRACKER.md](docs/agent-guides/DEDUP-TRACKER.md) lists all known duplication findings.

---

## Constitution: If the User Can Do It, `maestro-cli` Can Do It

**Non-negotiable.** Every action a person can take in Maestro's UI (a button, a checkbox, a palette command, a context-menu item, a shortcut, a modal flow) MUST have a `maestro-cli` path that does the same thing, reaches the same code, and reports the result back to the caller. Agents drive Maestro through the CLI. An action they cannot reach there is an action they cannot take for the user.

- **Ship both together.** A new UI action without its CLI verb is incomplete, the same way a feature without its tests is incomplete. Do not defer it to "later".
- **One implementation.** The UI and the CLI call the same main-process function. Pull the logic out of the IPC handler into a service module the WS bridge also calls (see `src/main/feedback/` and `generateDebugPackage`). Never write a second copy for the CLI.
- **No dialogs on the CLI path.** Where the UI raises a save or open dialog, the CLI takes the path as a flag (`--output`, `--attach`) and resolves it with `resolveCliPath()`.
- **Every write has a read.** A verb whose result an agent cannot verify is a verb it has to guess about.
- **Record the parity.** Add the row to the Covered table in [CLI-UI-PARITY.md](docs/agent-guides/CLI-UI-PARITY.md). A gap you cannot close in the same change goes in its Open gaps list, with the reason.

---

## Agent Behavioral Guidelines

Core behaviors for effective collaboration. Failures here cause the most rework. These are judgment calls, not scripts: state what you decided and why, then keep moving - blocking on questions is the exception, reserved for choices that are expensive to reverse.

### Surface Assumptions That Matter

If a wrong guess would materially change the work, name that assumption in one sentence and say which reading you took. Do not enumerate assumptions for their own sake - a list format invites inventing filler to complete it, and manufactured assumptions are worse than none.

### Name Conflicts, Then Proceed

On inconsistent or conflicting requirements ("X in file A but Y in file B"), name the conflict, state which interpretation you chose and why, and continue. Stop and ask only when both readings are plausible AND choosing wrong is expensive to undo. Silently picking one is the failure; halting on every ambiguity is the overcorrection.

### Push Back When Warranted

Not a yes-machine. When an approach has clear problems: point out the issue directly, explain the concrete downside, propose an alternative, then accept the decision if overridden. Sycophancy ("Of course!") followed by implementing a bad idea helps no one.

### Enforce Simplicity

Resist overcomplicating: abstractions must earn their complexity, and the boring, obvious solution usually wins. This is about structure, not line count - routing through a canonical shared utility is correct even when inlining would be shorter.

### Maintain Scope Discipline

Deliver what was asked at the scope asked. A bug or cleanup opportunity you trip over is worth one line in your summary, not a detour: do not remove comments you don't understand, refactor adjacent systems as side effects, or widen a task because something nearby looks fixable. If the discovery genuinely blocks the task, say so and fix only the blocking part.

### Dead Code Hygiene

After refactoring, identify now-unreachable code and list it in your summary. Delete it in the same change when it is unambiguously dead (only your refactor referenced it); list it and leave it when there is any doubt. Don't leave corpses silently, and don't silently delete code you merely believe is unused.

### Validate Before Push

Before pushing any branch, re-run the relevant formatting, lint, type-check, and test commands for the changes you made. Fix any issues those commands surface, include the fixes in the branch, and only then push or update the PR.

Local validation runs on a single OS and cannot catch platform-specific breakage (path separators, home directories, drive letters). A branch is not mergeable until both CI matrix legs, `test (ubuntu-latest)` and `test (windows-latest)`, are green; never merge on a local single-OS pass alone.

### Worktrees Go in the Worktree Directory

When you need a second checkout of this repository (a scratch branch, a merge trial, a build check against another branch), create it with `maestro-cli create-worktree --agent <your-agent-id> --branch <name> --base-branch <ref>`, never with a bare `git worktree add`. The desktop puts it in the agent's configured Worktree Directory (`~/Projects/Maestro-WorkTrees` for the main Maestro agent) and registers it as a worktree agent in the Left Bar, which is what keeps it visible to the user. Worktrees created by hand under `.worktrees/`, `~/Projects/worktrees/`, or a temp folder are invisible to the app; on 2026-09-11 a finished feature sat uncommitted in one for a day because nothing showed it existed. Remove a scratch worktree when you are done with it (`rm node_modules` first if you symlinked one in, then `git worktree remove`), and never leave work uncommitted in one.

---

## Standardized Vernacular

Use these terms consistently in code, comments, and documentation:

### Terminology: Agent vs Session

In Maestro, the terms "agent" and "session" have distinct meanings:

- **Agent** - An entity in the Left Bar backed by a provider (Claude Code, Codex, etc.). This is what users see, create, and interact with. Each agent has its own workspace, tabs, and configuration.
- **Session** (or **provider session**) - An individual conversation context within a provider (e.g., Claude's `session_id`). Each AI tab within an agent can have its own provider session. In code, the `Session` interface represents an agent (historical naming).

Use "agent" in user-facing language. Reserve "session" for provider-level conversation contexts or when documenting the code interface.

### UI Components

- **Left Bar** - Left sidebar with agent list and groups (`SessionList.tsx`)
- **Right Bar** - Right sidebar with Files, History, Auto Run tabs (`RightPanel.tsx`)
- **Main Window** - Center workspace (`MainPanel.tsx`)
  - **AI Terminal** - Main window in AI mode (interacting with AI agents)
  - **Command Terminal** - Main window in terminal/shell mode
  - **System Log Viewer** - Special view for system logs (`LogViewer.tsx`)

### Automation

- **Cue** - Event-driven automation system (Maestro Cue), gated as an Encore Feature. Watches for file changes, time intervals, agent completions, GitHub PRs/issues, and pending markdown tasks to trigger automated prompts. Configured via `.maestro/cue.yaml` per project.
- **Cue Modal** - Dashboard for managing Cue subscriptions and viewing activity (`CueModal/CueModal.tsx`)

### Agent States (color-coded)

- **Green** - Ready/idle
- **Yellow** - Agent thinking/busy
- **Red** - No connection/error
- **Pulsing Orange** - Connecting

---

## Code Style

This codebase uses **tabs for indentation**, not spaces. Always match existing file indentation when editing.

### Writing Style: No Em-Dashes or En-Dashes

**NEVER use U+2014 (em dash) or U+2013 (en dash) anywhere.** This applies to everything you write: user docs (`docs/`), in-app documentation, system prompts (`src/prompts/`), UI copy, code comments, commit messages, PR descriptions, and your own responses. Em dashes are a tell-tale sign of bot-authored text; humans almost never type them. Use one of these instead, whichever fits the sentence:

- A spaced hyphen (`-`) for an aside or appositive.
- A comma, colon, or parentheses to set off a clause.
- Two separate sentences when the clauses stand on their own.
- A plain hyphen (`-`) for numeric ranges (e.g. `10-20`; do not use U+2013 for ranges).

This is non-negotiable. If you catch an em-dash or en-dash in anything you produce or edit, replace it.

---

## Do Not Edit: `docs/releases.md`

`docs/releases.md` is generated/updated automatically during release pressing. **Never modify it manually** - even when shipping user-facing changes that would seem to warrant a release note entry. The release tooling handles it.

---

## Project Overview

Maestro is an Electron desktop app for managing multiple AI coding assistants simultaneously with a keyboard-first interface.

### Supported Agents

| ID              | Name            | Status     |
| --------------- | --------------- | ---------- |
| `antigravity`   | Antigravity CLI | **Beta**   |
| `claude-code`   | Claude Code     | **Active** |
| `codex`         | Codex           | **Active** |
| `copilot-cli`   | Copilot-CLI     | **Beta**   |
| `factory-droid` | Factory Droid   | **Beta**   |
| `grok`          | Grok CLI        | **Beta**   |
| `hermes`        | Hermes          | **Beta**   |
| `omp`           | Oh My Pi        | **Beta**   |
| `opencode`      | OpenCode        | **Beta**   |
| `pi`            | Pi              | **Beta**   |
| `qwen3-coder`   | Qwen3 Coder     | **Beta**   |
| `terminal`      | Terminal        | Internal   |
| `gemini-cli`    | Gemini CLI      | Hidden     |

Rows are in picker order - alphabetical by display name, which is what
`PICKABLE_AGENT_IDS` sorts `AGENT_PICKER_META` into in
`src/shared/agentMetadata.ts`, the one registry all three provider pickers read.
The record's own key order does not matter; a new provider can be added anywhere
in it. Which provider a picker DEFAULTS to is a separate list,
`AGENT_AUTOSELECT_ORDER`, so the default is a real preference rather than
whatever happens to sort first. `terminal` is internal and never offered, and
`gemini-cli` is `hidden` in its definition and `null` in the picker registry:
superseded by Antigravity, kept only for type and back-compat reasons.

See [[CLAUDE-AGENTS.md]] for capabilities and integration details.

---

## Quick Commands

```bash
npm run dev           # Development with hot reload (isolated data, can run alongside production)
npm run dev:prod-data # Development using production data (close production app first)
npm run dev:web-desktop # Browser build of the renderer (WebSocket IPC bridge, port 5176)
npm run build         # Full production build
npm run clean         # Clean build artifacts
npm run lint          # TypeScript type checking (all configs)
npm run lint:eslint   # ESLint code quality checks
npm run package       # Package for all platforms
npm run test          # Run test suite
npm run test:watch    # Run tests in watch mode
```

---

## Architecture at a Glance

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts            # Entry point (app lifecycle, window, startup wiring)
│   ├── ipc/bootstrap/      # setupIpcHandlers(): the live IPC registration
│   ├── ipc/handlers/       # IPC handler modules (stats, git, playbooks, cue, etc.)
│   ├── preload/            # Secure IPC bridge (one module per namespace)
│   ├── process-manager/    # Process spawning (PTY + child_process)
│   ├── agents/             # Agent definitions, detection, capabilities, model discovery
│   ├── cue/                # Maestro Cue event-driven automation engine
│   ├── parsers/            # Per-agent output parsers + error patterns
│   ├── storage/            # Per-agent session storage implementations
│   ├── plugins/            # Plugin manager, sandbox, broker, consent
│   ├── stats/              # Usage stats SQLite (stats-db.ts, schema, aggregations)
│   ├── web-server/         # WebSocket bridge for web-desktop and the CLI
│   └── utils/              # Utilities (execFile, ssh-spawn-wrapper, etc.)
│
├── renderer/               # React frontend (desktop)
│   ├── App.tsx            # Main coordinator
│   ├── components/        # UI components
│   ├── hooks/             # Custom React hooks
│   ├── stores/            # Zustand stores (sessions, settings, ui, modal, ...)
│   ├── services/          # Renderer-side services (shell commands, mentions, ...)
│   ├── constants/         # Themes, shortcuts, priorities
│   └── contexts/          # Context providers (LayerStack, etc.)
│
├── web-desktop/            # Browser build of the renderer (WebSocket IPC bridge)
│
├── web/                    # PWA assets (public/) + utils/serviceWorker.ts; the rest is legacy, unimported
│
├── cli/                    # maestro-cli: commands/ and services/ (playbooks, batch, spawner)
│
├── maestro-p/              # maestro-p TUI wrapper for provider CLIs
│
├── prompts/                # System prompts (editable .md files)
│
├── shared/                 # Shared types and utilities (both processes, CLI-safe)
│
├── types/                  # Ambient type declarations
│
└── __tests__/              # Vitest suite (mirrors src/ layout)

docs/                       # Mintlify documentation (docs.runmaestro.ai) + docs/agent-guides/
```

---

## Key Files for Common Tasks

| Task                                | Primary Files                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler                     | `src/main/ipc/handlers/` (handler module), `src/main/ipc/bootstrap/index.ts` (`setupIpcHandlers`), `src/main/preload/` (one module per namespace)                                                                                                                |
| Add UI component                    | `src/renderer/components/`                                                                                                                                                                                                                                       |
| Add browser/mobile touch affordance | `src/renderer/components/`, `src/renderer/utils/touch.ts`, `src/renderer/hooks/utils/` (gate on `isCoarsePointer()`; PWA assets in `src/web/public/`)                                                                                                            |
| Add keyboard shortcut               | `src/renderer/constants/shortcuts.ts`, `App.tsx`                                                                                                                                                                                                                 |
| Add theme                           | `src/renderer/constants/themes.ts`                                                                                                                                                                                                                               |
| Add modal                           | Component + `src/renderer/constants/modalPriorities.ts`                                                                                                                                                                                                          |
| Add tab overlay menu                | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]]                                                                                                                                                                                                     |
| Add setting                         | `src/shared/settingsMetadata.ts` (metadata), `src/renderer/stores/settingsStore.ts`, `src/main/stores/defaults.ts`, AND `src/renderer/components/Settings/searchableSettings.ts` + `data-setting-id` wrapper on rendered control (see [[CLAUDE-PATTERNS.md]] §3) |
| Add template variable               | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts`                                                                                                                                                                                     |
| Modify system prompts               | `src/prompts/*.md` (wizard, Auto Run, etc.) or edit via **Maestro Prompts** tab in Settings                                                                                                                                                                      |
| Customize prompts                   | Use **Maestro Prompts** tab in Settings, or edit `userData/core-prompts-customizations.json`                                                                                                                                                                     |
| Add new prompt                      | `src/prompts/*.md`, `src/shared/promptDefinitions.ts` (add to `CORE_PROMPTS` array and `PROMPT_IDS`)                                                                                                                                                             |
| Add Spec-Kit command                | `src/prompts/speckit/`, `src/main/speckit-manager.ts`                                                                                                                                                                                                            |
| Add OpenSpec command                | `src/prompts/openspec/`, `src/main/openspec-manager.ts`                                                                                                                                                                                                          |
| Add CLI command                     | `src/cli/commands/`, `src/cli/index.ts`                                                                                                                                                                                                                          |
| Add new agent                       | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md)                                                                                    |
| Add agent output parser             | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                 |
| Add parquet viewer feature          | `src/renderer/components/ParquetViewer/` (UI), `src/main/parquet/` (query engine), `src/shared/parquet/` (filter language + wire types)                                                                                                                          |
| Add agent session storage           | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                   |
| Add agent error patterns            | `src/shared/agentErrorPatterns.ts`                                                                                                                                                                                                                               |
| Add agent context window            | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                            |
| Add playbook feature                | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                  |
| Add marketplace playbook            | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                      |
| Playbook import/export              | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                  |
| Modify wizard flow                  | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                     |
| Add tour step                       | `src/renderer/components/Wizard/tour/tourSteps.tsx`                                                                                                                                                                                                              |
| Modify file linking                 | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                            |
| Add documentation page              | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                       |
| Add documentation screenshot        | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                     |
| MCP server integration              | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                     |
| Add stats/analytics feature         | `src/main/stats/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                   |
| Add Usage Dashboard chart           | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                        |
| Add Document Graph feature          | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                               |
| Add colorblind palette              | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                   |
| Add performance metrics             | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                              |
| Capture/analyze perf trace          | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces                                                                                                |
| Add power management                | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                   |
| Spawn agent with SSH support        | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                        |
| Modify file preview tabs            | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                 |
| Add Director's Notes feature        | `src/renderer/components/DirectorNotes/`, `src/shared/directorNotesNarrative.ts`, `src/shared/directorNotesGrouping.ts`, `src/main/ipc/handlers/director-notes.ts`                                                                                               |
| Add Encore Feature                  | `src/renderer/types/index.ts` (flag), `src/renderer/stores/settingsStore.ts` (default), `src/shared/plugins/first-party.ts` (tile + per-feature settings body), gate in `App.tsx` + keyboard handler                                                             |
| Modify history components           | `src/renderer/components/History/`                                                                                                                                                                                                                               |
| Modify history activity graph       | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                               |
| Modify Auto Run Thought Stream      | `src/renderer/stores/thoughtStreamStore.ts` (one timeline of thoughts + tool calls, `buildActivityFeed`), `ThoughtStreamPanel.tsx`, `hooks/agent/internal/useThoughtStream{Capture,Tool}Listener.ts`, `src/renderer/utils/toolActivityLabel.ts`                  |
| Add Cue event type                  | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                        |
| Add Cue template variable           | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                |
| Modify Cue modal                    | `src/renderer/components/CueModal/`                                                                                                                                                                                                                              |
| Configure Cue engine                | `src/main/cue/cue-engine.ts`, `src/main/ipc/handlers/cue.ts`                                                                                                                                                                                                     |
| Add terminal feature                | `src/renderer/components/XTerminal.tsx`, `src/renderer/components/TerminalView.tsx`                                                                                                                                                                              |
| Modify terminal tabs                | `src/renderer/utils/terminalTabHelpers.ts`, `src/renderer/stores/tabStore.ts`                                                                                                                                                                                    |

---

## Critical Implementation Guidelines

### Every Surface Needs Three Ways In and Two Ways Out

A modal, dashboard, or panel the user opens is not done until it has a **hotkey**
(`DEFAULT_SHORTCUTS` + `useMainKeyboardHandler`), a **command palette** entry
(`QuickActionsModal/commands/`), and a **menu** item (`HamburgerMenuContent.tsx`,
skipped only for an in-the-moment show/hide toggle), plus an entry in
`UI_SURFACES` (`src/shared/uiSurfaces.ts`). It also needs **Escape and a visible
close control** (`<EscCloseButton>` or the `Modal` X), and a `resizeKey` so its
size is remembered. If its content owns live state, closing must park it
(`Modal`'s `hidden` prop), not unmount it. Full rules:
[UI-PATTERNS.md → Every Surface Needs Three Ways In](docs/agent-guides/UI-PATTERNS.md#every-surface-needs-three-ways-in-and-two-ways-out).

### Click-Driven Modals: Disable Text Selection

If a modal's primary purpose is _clicking_ (buttons, tabs, list rows, cards, graph nodes, filter chips, toggles), put `select-none` on its root container. Native browser drag-to-select highlighting fires accidentally during normal interactions and looks broken. Inputs and textareas keep working - Chromium preserves form-control selection regardless of ancestor `user-select: none`. For any nested subtree that's content-driven (detail views, code editors, log entry bodies, file paths, AI output, error messages), apply `select-text` on its root to opt back in. Skip the rule entirely on modals whose main purpose is reading or editing text (`CueYamlEditor`, `CueHelpModal`, wizard chat shell, System Log Viewer, confirmation dialogs). Decide click- vs content-driven when adding a new modal - retrofitting later means hunting down every nested view that needs `select-text`. Full rationale in [UI-PATTERNS.md → Text Selection in Modals](docs/agent-guides/UI-PATTERNS.md#text-selection-in-modals).

### Error Handling & Sentry

Maestro uses Sentry for error tracking. Field data from production crashes is invaluable for improving code quality.

**DO let exceptions bubble up:**

```typescript
// WRONG - silently swallowing errors hides bugs from Sentry
try {
	await riskyOperation();
} catch (e) {
	console.error(e); // Lost to the void
}

// CORRECT - let unhandled exceptions reach Sentry
await riskyOperation(); // Crashes are reported automatically
```

**DO handle expected/recoverable errors explicitly:**

```typescript
// CORRECT - known failure modes should be handled gracefully
try {
	await fetchUserData();
} catch (e) {
	if (e.code === 'NETWORK_ERROR') {
		showOfflineMessage(); // Expected, recoverable
	} else {
		throw e; // Unexpected - let Sentry capture it
	}
}
```

**DO use Sentry utilities for explicit reporting:**

```typescript
import { captureException, captureMessage } from '../utils/sentry';

// Report exceptions with context
await captureException(error, { userId, operation: 'sync' });

// Report notable events that aren't crashes
await captureMessage('Unusual state detected', 'warning', { state });
```

**Key files:** `src/main/utils/sentry.ts`, `src/renderer/components/ErrorBoundary.tsx`

---

### SSH Remote Execution Awareness

**IMPORTANT:** When implementing any feature that spawns agent processes (e.g., context grooming, group chat, batch operations), you MUST support SSH remote execution.

Agents can be configured to run on remote hosts via SSH. Without proper SSH wrapping, agents will always execute locally, breaking the user's expected behavior.

**Required pattern:**

1. Check if the session has `sshRemoteConfig` with `enabled: true`
2. Use `wrapSpawnWithSsh()` from `src/main/utils/ssh-spawn-wrapper.ts` to wrap the spawn config
3. Pass the SSH store (available via `createSshRemoteStoreAdapter(settingsStore)`)

```typescript
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

// Before spawning, wrap the config with SSH if needed
if (sshStore && session.sshRemoteConfig?.enabled) {
	const sshWrapped = await wrapSpawnWithSsh(spawnConfig, session.sshRemoteConfig, sshStore);
	// Use sshWrapped.command, sshWrapped.args, sshWrapped.cwd, etc.
}
```

**Also ensure:**

- The correct agent type is used (don't hardcode `claude-code`)
- Custom agent configuration (customPath, customArgs, customEnvVars) is passed through
- Agent's `binaryName` is used for remote execution (not local paths)
- When the user enabled SSH but the configured remote can't be resolved, **fail
  loudly** instead of silently running locally - the user explicitly opted into
  SSH and their prompt shouldn't leak to the local machine. `wrapSpawnWithSsh()`
  does NOT throw in that case: it hands back the unmodified local config with
  `sshRemoteUsed: null`, which still carries the REMOTE's `cwd`, so taking it
  runs the agent on the user's machine against a path that is either missing or
  (worse) the wrong files. Every caller must check `sshRemoteUsed` and throw
  `sshUnresolvedRemoteMessage(sshConfig)` from `ssh-spawn-wrapper.ts`. See
  `groomContext()` and `spawnGroupChatAgent()` for the pattern, and
  `sshUnresolvedFailure()` in `src/cli/services/agent-spawner.ts` for the CLI's
  version of this.

**CLI parity:** The CLI (`src/cli/services/agent-spawner.ts`) spawns agent
processes for batch/playbook automation and honors the same SSH wrapping and
agent-config overrides as the desktop app. When adding new CLI spawn sites,
thread `sessionSshRemoteConfig`, `customArgs`, `customEnvVars`, `customModel`,
`customEffort` through to `spawnAgent(...)`. The CLI loads `ssh-spawn-wrapper`
via dynamic `import()` so the SSH chain stays out of the local hot path.

See [[CLAUDE-PATTERNS.md]] for detailed SSH patterns.

---

## Debugging

### Root Cause Verification (Before Implementing Fixes)

Initial hypotheses are often wrong. Before implementing any fix:

1. **IPC issues:** Verify handler is registered in `src/main/index.ts` before modifying caller code
2. **UI rendering bugs:** Check CSS properties (overflow, z-index, position) on element AND parent containers before changing component logic
3. **State not updating:** Trace the data flow from source to consumer; check if the setter is being called vs if re-render is suppressed
4. **Feature not working:** Verify the code path is actually being executed (add temporary `console.log`, check output, then remove)

**Historical patterns that wasted time:**

- Tab naming bug: Modal coordination was "fixed" when the actual issue was an unregistered IPC handler
- Tooltip clipping: Attempted `overflow: visible` on element when parent container had `overflow: hidden`
- Session validation: Fixed renderer calls when handler wasn't wired in main process

### CDP / Browser-Automation Scripts Are Ephemeral

When driving the running app over Chrome DevTools Protocol (e.g. one-off `scripts/cdp-*.mjs` harnesses for reproducing a bug, clicking through a flow, or capturing screenshots), treat those scripts as **throwaway**. They are debugging scaffolding, not shipped code:

- Write them under `scripts/` if you like, but **delete them when the investigation is done** - do not leave them in the working tree and do not commit them.
- If one gets committed by accident, remove it (a forward `git rm` commit is fine; avoid history surgery on `rc` unless asked).
- Heads-up on this dev setup: the dev server often runs with `DISABLE_HMR=1`, so live edits will NOT hot-reload. A full page reload only picks up new code if the vite process was started **after** the edit hit disk. Verify the served module actually contains your change (`curl localhost:17173/<module>` and grep) before trusting any CDP screenshot.

### Focus Not Working

1. Add `tabIndex={0}` or `tabIndex={-1}`
2. Add `outline-none` class
3. Use `ref={(el) => el?.focus()}` for auto-focus

### Settings Not Persisting

1. Check wrapper function calls `window.maestro.settings.set()`
2. Check loading code in `useSettings.ts` useEffect

### Modal Escape Not Working

1. Register with layer stack (don't handle Escape locally)
2. Check priority is set correctly

---

## MCP Server

Maestro provides a hosted MCP (Model Context Protocol) server for AI applications to search the documentation.

**Server URL:** `https://docs.runmaestro.ai/mcp`

**Available Tools:**

- `SearchMaestro` - Search the Maestro knowledge base for documentation, code examples, API references, and guides

**Connect from Claude Desktop/Code:**

```json
{
	"mcpServers": {
		"maestro": {
			"url": "https://docs.runmaestro.ai/mcp"
		}
	}
}
```

See [MCP Server documentation](https://docs.runmaestro.ai/mcp-server) for full details.
