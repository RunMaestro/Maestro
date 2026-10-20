# CLAUDE.md

Essential guidance for working with this codebase. This file is loaded into every session, so it holds only rules that apply to every task plus indexes that route to everything else. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation Index

None of these load automatically. Read the one that matches the task before you start; do not read them all.

| Document                                   | Read it before...                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [[CLAUDE-PATTERNS.md]]                     | Touching process management, modals, themes, tabs, the execution queue, Auto Run, SSH spawns, error handling, or Encore gating. Also holds the debugging checklists |
| [[CLAUDE-IPC.md]]                          | Adding or calling a `window.maestro.*` API                                                                                                                          |
| [[CLAUDE-PERFORMANCE.md]]                  | Performance-sensitive renderer work (React optimization, debouncing, batching) or capturing a perf trace                                                            |
| [[CLAUDE-WIZARD.md]]                       | Editing the Onboarding Wizard, Inline Wizard, or Tour System                                                                                                        |
| [[CLAUDE-FEATURES.md]]                     | Editing the Usage Dashboard or Document Graph                                                                                                                       |
| [[CLAUDE-AGENTS.md]]                       | Adding or changing a provider, or looking up what a provider supports                                                                                               |
| [[CLAUDE-SESSION.md]]                      | Touching the `Session` interface (the agent data model)                                                                                                             |
| [[CLAUDE-PLATFORM.md]]                     | Anything path-, shell-, or OS-specific (Windows, Linux, macOS, SSH remote)                                                                                          |
| [[CLAUDE-CUE.md]]                          | Editing `src/main/cue/` (architecture, dispatch flow, lifecycle, gotchas)                                                                                           |
| [[CLAUDE-PLUGINS.md]]                      | Editing `src/main/plugins/` or `src/shared/plugins/` (tiers, sandbox, broker, capabilities, signing, trust model)                                                   |
| [[CLAUDE-SETTINGS.md]]                     | Editing `src/renderer/components/Settings/` or adding a setting (style guide plus the registration checklist)                                                       |
| [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md) | Integrating a new agent end to end                                                                                                                                  |

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
| Group chat (or Symphony, a separate feature)       | [GROUP-CHAT.md](docs/agent-guides/GROUP-CHAT.md)                 |
| Stats, analytics, or dashboard                     | [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)       |
| Prompt template or SpecKit/OpenSpec                | [PROMPTS-SPECS.md](docs/agent-guides/PROMPTS-SPECS.md)           |
| Cue pipeline feature                               | [CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md)             |
| App lifecycle, updater, or power mgmt              | [MAIN-LIFECYCLE.md](docs/agent-guides/MAIN-LIFECYCLE.md)         |
| Plugin, sandbox capability, or contribution        | [PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) |
| React context, renderer type, or Symphony runner   | [REMAINING-SYSTEMS.md](docs/agent-guides/REMAINING-SYSTEMS.md)   |
| Release step, tag, bump, or announcement           | [RELEASE-RUNBOOK.md](docs/agent-guides/RELEASE-RUNBOOK.md)       |
| Vulnerability report, advisory, CVE, or credit     | [SECURITY-RUNBOOK.md](docs/agent-guides/SECURITY-RUNBOOK.md)     |
| Plugin media isolation or a bounded native tool    | [PLUGIN-MEDIA-TOOLS.md](docs/agent-guides/PLUGIN-MEDIA-TOOLS.md) |
| Docs or site screenshot                            | [SCREENSHOT-CAPTURE.md](docs/agent-guides/SCREENSHOT-CAPTURE.md) |

### Commonly-reimplemented functions (do NOT add new copies)

This is the INDEX: one line per entry (name, canonical symbols, home file). If a name below matches what you are about to write, import the canonical one. The full entry for each (the failure it replaced, its invariants, and the traps that made the duplicates wrong) lives under the same title and group heading in [CANONICAL-UTILITIES.md](docs/agent-guides/CANONICAL-UTILITIES.md). Read that entry before extending or working around the utility: `grep -n "<entry title>" docs/agent-guides/CANONICAL-UTILITIES.md`.

Keep rationale OUT of this list. `npm run docs:verify` fails when an index line grows past one line of symbols and paths, or when an entry exists in only one of the two files.

#### Formatting, IDs, and pricing

- **ID generation:** `generateId()` in `src/renderer/utils/ids.ts`, `generateUUID()` in `src/shared/uuid.ts`
- **Browser relay text chunks:** `chunkBrowserRelayText()` in `src/shared/browserRelay.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()` (compact), `formatCount()` (exact) in `src/shared/formatters.ts`
- **Format tokens:** `formatTokens()`, `formatTokensCompact()`, `estimateTokenCount()` in `src/shared/formatters.ts`
- **Truncate prose without splitting a word:** `truncateAtWordBoundary()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** everything in `src/shared/duration.ts`: `humanizeDuration(ms, opts)` plus its presets (never another `Math.floor(ms / 86400000)` ladder)
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts; perf traces only)
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format a calendar day:** `formatCalendarDay()` in `src/shared/formatters.ts`
- **Local calendar day keys:** `toLocalYmd()`, `parseLocalYmd()`, `addLocalDays()` in `src/shared/localDay.ts`
- **Format an hour of day:** `formatHourOfDay()` in `src/shared/formatters.ts`
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Timestamp for a generated file name:** `fileTimestampSlug(dateOrTimestamp?)` in `src/shared/formatters.ts`
- **Token pricing and Codex token totals:** `resolveModelPricing()` / `calculateModelCost()` in `src/shared/modelPricing.ts`, and `CodexTokenCounts` in `src/shared/codexTokenUsage.ts`
- **Summing a Codex session's tokens:** `CodexTokenCounts` in `src/shared/codexTokenUsage.ts`
- **Claude's cost and per-model usage for one turn:** `claudeTurnCost()`, `readClaudeTurnBaseline()`, `parseCostStateRow()` in `src/shared/claudeCostTracker.ts`
- **Live tokens-per-second rate:** `createThroughputTracker()`, `THROUGHPUT_WINDOWS_MS` in `src/shared/throughputRate.ts`
- **Tokens per second:** `extractClaudeSpeedSamples()`, `computeClaudeTokenSpeed()`, `CodexTokenSpeedTracker`, `summarizeTokenSpeed()` in `src/shared/tokenSpeed.ts`; `formatTokensPerSecond()` in `src/shared/formatters.ts`
- **Usage, cost and message count of a Claude transcript:** `computeClaudeSessionUsage()`, `computeClaudeUsageWithSubagents()`, `readClaudeSubagentTranscripts()` in `src/shared/claudeSessionUsage.ts`; `countClaudeTranscriptMessages()` in `src/shared/claudeTranscriptMessages.ts`

#### Paths, files, and strings

- **Path utilities:** `truncatePath()`, `getParentDir()`, `truncateCommand()`, `isAbsolutePath()`, `getBasename()`, `joinPath()` in `src/shared/formatters.ts`
- **Worktree path comparisons:** `normalizeWorktreePath()`, `isPathAtOrUnderRoot()` in `src/shared/worktreePaths.ts`
- **Remote worktree aliases:** `resolveWorktreeAliasesRemote()` in `src/main/utils/remote-git.ts`
- **A path the user typed on the CLI:** `resolveCliPath(input)` in `src/cli/utils/parse.ts`
- **An image file the user named on the CLI:** `readCliImageFile(input, maxBytes)` in `src/cli/utils/imageFiles.ts`
- **Classifying a file by extension:** `getFileCategory()`, `isPreviewableFile()`, `matchesFileCategory()`, `getFileExtension()` in `src/shared/fileCategories.ts`
- **Reading a zip from disk:** `readZipArchive()`, `extractZipTo()`, `isUnsafeZipEntryName()` in `src/main/utils/zip-archive.ts` (never `adm-zip`)
- **Guarding a serialized JSON payload before it overwrites a file:** `assertSerializedJsonIsSafe(serialized, target)` in `src/shared/jsonUtils.ts`
- **Deterministic JSON (same value, same text):** `canonicalJson(value)` in `src/shared/canonicalJson.ts` (never hash or compare `JSON.stringify` output)
- **Redacting secrets from text you persist or show:** `redactSecrets(text, opts?)`, `passesLuhn()` in `src/shared/redactSecrets.ts`
- **Strip ANSI / collapse progress overwrites:** `stripAnsiCodes()`, `processCarriageReturns()` in `src/shared/stringUtils.ts`
- **Matching error patterns against an agent's exit output:** `stripJsonEventLines()` in `src/shared/agentErrorPatterns.ts`
- **Reading what a TUI painted from a raw capture:** `replayTerminalScreen(raw)`, `capturedAlternateScreen(raw)` in `src/maestro-p/screen-replay.ts`
- **Loading a LOCAL file tree:** `walkLocalFileTree()` in `src/main/utils/file-tree-walk.ts`, wrapped by `loadFileTree()` in `src/renderer/utils/fileExplorer.ts`
- **Telling the Files panel a file appeared or vanished:** `requestFileTreeRefresh(sessionId)` in `src/renderer/utils/fileTreeRefresh.ts` (renderer) and `nudgeFileTreeForPaths(paths)` in `src/cli/services/file-tree-refresh.ts` (CLI)
- **Delete the file the user is previewing:** `requestFileDeletion()` in `src/renderer/services/fileDeletion.ts`

#### Main process: stores, persistence, platform

- **One log entry as one JSON line (`--log-format json`):** `formatJsonLogLine()`, `buildJsonLogLine()`, `JSON_LOG_ID_FIELDS` in `src/shared/jsonLogLine.ts`
- **A CLI verb that needs the desktop app, when the app is absent:** `exitIfMaestroNotRunning(error, options)` / `failFromError()` in `src/cli/services/session-command.ts`, over `MaestroNotRunningError`
- **An explicit data directory on a CLI verb (`--data-dir`):** `applyDataDirOption()`, `requireDataDirOrExit()` in `src/cli/services/data-dir-option.ts` (sets `MAESTRO_USER_DATA` so every reader agrees; never creates the folder)
- **Reading or writing `maestro-agent-configs.json` without Electron:** `readAgentConfigsStoreFile(dataDir)`, `writeAgentConfigsStoreFile()` in `src/main/stores/agent-configs-store-file.ts`
- **Reading or writing `maestro-sessions.json` without Electron:** `readSessionsStoreFile(dataDir)`, `writeSessionsStoreFile()` in `src/main/stores/sessions-store-file.ts`
- **Maestro's data directory, without Electron:** `resolveUserDataDir(options?)`, `assertUserDataDirExists(dir)` in `src/shared/userDataDir.ts`
- **Where the synced stores live (custom Storage Location):** `resolveSyncDir(userDataDir)`, `isValidSyncPath()`, `BOOTSTRAP_STORE_FILE` in `src/shared/syncPath.ts`; the CLI's `getSyncDir()` in `src/cli/services/storage.ts`
- **Deferred main-process store persistence:** `deferStoreWrites()` in `src/main/stores/deferred-writes.ts`, `flushPendingSessionWrites()` in `src/main/stores/instances.ts`
- **Rewriting a large `{ key: [...] }` JSON store file:** `serializeWithMemoizedArray(data, memoKey)` in `src/shared/memoizedJsonSerialize.ts`
- **Recovering from a store file that is not JSON:** `createStoreDeserializer()`, `corruptStorePath()` in `src/main/stores/corrupt-store-recovery.ts` (never `clearInvalidConfig`)
- **Sealing a file with the key the OS holds for the app:** `safeStorageSeal(safeStorage)`, `obscuringSeal()`, `SealProvider`, `SafeStorageLike` in `src/main/utils/safe-storage-seal.ts`
- **Proving a sealed file is the newest one (rollback and deletion):** `createKeyringAnchor(service, account)`, `AnchorStore`, `keyringAnchor()`, `noAnchor()` in `src/main/utils/keyring-anchor.ts`
- **Writing a Claude session's origin record:** `setClaudeSessionOrigin()`, `mergeClaudeSessionOrigin()` in `src/main/storage/claude-session-origins.ts`
- **Serializing async work on one entity:** `createKeyedWriteQueue()` in `src/shared/keyedWriteQueue.ts` (main imports it via `src/main/utils/atomic-json-store.ts`)
- **Capping stored tool output:** `compactToolOutput()`, `compactSessionToolOutputs()` in `src/shared/toolOutput.ts`
- **Merging browser-deferred conversations:** `projectWebSession()`, `readDeferredContent()`, `mergeDeferredSessionContent()` in `src/main/stores/deferred-session-content.ts`, over `mergeDeferredItems()` in `src/shared/deferredSessionContent.ts`
- **HTTP request from the main process:** `fetchWithTimeout()`, `isFetchTimeoutError()` in `src/main/utils/fetchWithTimeout.ts` (never a bare `fetch()`)
- **A git query the UI polls in the background:** `execGitReadOnly()`, `isGitTimeout()`, `READ_ONLY_GIT_TIMEOUT_MS` in `src/main/utils/remote-git.ts`
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts`; renderer-only `isWindowsPlatform()` and siblings in `src/renderer/utils/platformUtils.ts` (never `process.platform` in the renderer)
- **Encore Feature flags and their defaults:** `ENCORE_FEATURE_DEFAULTS`, `resolveEncoreFeatures(raw)`, `isEncoreFeatureEnabled()`, `requireEncoreFeature()` in `src/shared/encoreFeatureDefaults.ts`; background services follow the flag via `createEncoreFeatureLifecycle()` in `src/main/encore-feature-lifecycle.ts`
- **Whether a stored agent is live (a switched-off Pianola is dormant):** `filterLiveAgents()`, `isAgentDormant()` in `src/shared/agentVisibility.ts`; per process `getLiveSessions()` (main getters), `readLiveSessions()` (CLI storage), `useLiveSessions()` in `src/renderer/hooks/session/useLiveSessions.ts`
- **A maestro-cli verb that belongs to an Encore Feature:** `encoreCommand()`, `requireEncore()`, `requireEncoreForOptions()` in `src/cli/utils/encore-gate.ts`
- **Filing GitHub feedback (check gh, search, +1, submit):** `submitFeedbackConversation()`, `searchFeedbackIssues()` in `src/main/feedback/index.ts`

#### Spawning and stopping agents (process, SSH, env, prompts)

- **A secret a server supplies by name:** `lookupSecret()`, `resolveSecrets()`, `isValidSecretName()` in `src/shared/serverSecrets.ts` ($CREDENTIALS_DIRECTORY, /run/secrets, then env)
- **maestro-lib as a library for a program outside this repository:** `MAESTRO_LIB_VERSION`, `planSessionTurn` in `src/shared/maestro-lib/index.ts`, built by `npm run build:maestro-lib` and documented in `docs/maestro-lib.md`
- **Escaping for a Windows cmd.exe launch:** `escapeCmdArgs()` in `src/shared/maestro-lib/launch/windows-shell-escape.ts`, `windowsShellReason()` in `src/shared/maestro-lib/launch/windows-command.ts`
- **Launching an agent (env layers, prompt delivery, SSH target):** `buildAgentLaunchPlan()` in `src/shared/maestro-lib/launch/launch-plan.ts` (env in `launch/env.ts`, prompt in `launch/prompt-delivery.ts`, SSH target in `launch/ssh-remote-resolver.ts`)
- **Starting, streaming, stopping and resuming an agent turn:** `startTurn()` in `src/shared/maestro-lib/run/start-turn.ts`, `runTurn()` / `runToCompletion()` in `src/shared/maestro-lib/run/run-to-completion.ts`, `planSessionTurn()` in `src/shared/maestro-lib/run/session.ts`
- **Stopping a process (interrupt, terminate, kill the tree):** `stopProcess(target, options)` in `src/shared/maestro-lib/control/termination.ts` (never a bare `kill('SIGTERM')` + `setTimeout`)
- **Whether a Claude turn runs the maestro-p TUI or `claude --print`:** `resolveClaudeSpawnModeCore()`, `applyClaudeSpawnDecision()` in `src/shared/maestro-lib/launch/interactive-mode.ts`
- **Timing out a supervised agent process:** `createIdleWatchdog()` in `src/main/utils/idle-watchdog.ts`, events in `src/main/utils/agent-liveness.ts` (the budget is silence, not wall clock)
- **A one-shot answer from a cheap model (no tab, no tools):** `window.maestro.context.groomContext()` with `cheapTurn` / `readOnly` / `disableTools` / `timeoutMs`, over `groomContext()` in `src/main/utils/context-groomer.ts`
- **Whether a working directory can be spawned into:** `unusableCwdReason(cwd)` in `src/main/process-manager/utils/spawnCwd.ts`
- **Whether an agent is working right now (main process):** `isAgentBusy()`, `isAiTabProcessActive()` in `src/main/utils/agent-busy.ts` (never the persisted `state`)
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
- **Resuming a provider session a background synopsis may still hold:** `awaitSynopsisWriters()` in `src/main/process-manager/utils/synopsisWriterGate.ts` (already called by `process:spawn`; no per-send-path busy check)
- **A path handed to a REMOTE shell (`cd`, `ls`, `stat` over SSH):** `shellEscapeRemotePath()` in `src/main/utils/shell-escape.ts` (`shellEscape()` stops `~` from expanding)
- **SSH connection options (`ssh -o`):** `resolveSshOptions()`, `buildSshOptionArgs()`, `validateSshOption()` in `src/shared/sshOptions.ts`
- **Building or delivering the Maestro system prompt:** `assembleMaestroSystemPrompt()` in `src/shared/maestroSystemPrompt.ts`; `applySystemPromptDelivery()` in `src/main/utils/system-prompt-delivery.ts`; `buildMaestroSystemPromptForSession()` in `src/main/utils/maestro-system-prompt.ts`
- **The system-prompt envelope for a provider with no `--append-system-prompt`:** `embedSystemPromptInPrompt()`, `stripEmbeddedSystemPrompt()`, `hasEmbeddedSystemPrompt()` in `src/shared/embeddedSystemPrompt.ts` (a wire format; never template it inline)
- **Who asked for this turn (interactive vs automation):** `QUERY_SOURCE_ENV_VAR`, `QuerySource`, `DEFAULT_QUERY_SOURCE` in `src/shared/querySource.ts` (`MAESTRO_QUERY_SOURCE`)
- **Prefixing an agent's New Session Message:** `prependNewSessionMessageOnFirstTurn()`, `prependNewSessionMessage()` in `src/shared/newSessionMessage.ts`
- **Who SENT this turn (Web Login attribution):** `getActingUser()` in `src/main/web-server/auth/acting-user.ts`; `noteTurnActor()`, `resolveTurnActor()`, `forgetAgentActors()` in `src/main/web-server/auth/turn-attribution.ts`
- **An agent's effective environment:** `resolveAgentEnvironment()`, `isSecretEnvKey()`, `maskEnvValue()` in `src/shared/agentEnvironment.ts`, rendered by `<EnvVarList>` in `src/renderer/components/ui/EnvVarList.tsx`
- **Whether a configured env value means "unset":** `isBlankEnvValue(value)`, `isBlankEnvKey(key)` and `stripBlankEnvVars(vars)` in `src/shared/agentEnvironment.ts`
- **Suggesting an env-var NAME:** `suggestEnvVarKeys()`, `PROVIDER_ENV_VAR_SUGGESTIONS`, `withBlankEnvVarRow()` in `src/shared/envVarCatalog.ts`, rendered by `<EnvVarKeyInput>` in `src/renderer/components/shared/EnvVarKeyInput.tsx`
- **Assembling the prompt, arguments and launch request of a chat turn:** `assembleTurn()` in `src/shared/maestro-lib/turns/assemble.ts`
- **Running a chat turn with no desktop (send, queue, stop, per-tab events):** `createRuntimeTurns()` in `src/shared/maestro-lib/runtime/turns.ts`
- **Recording a finished turn (transcript, History, usage):** `createTurnRecorder()`, `buildTurnTranscript()` in `src/shared/maestro-lib/turns/record-turn.ts`
- **Serving a runtime to other processes (`maestro-cli host`):** `startRuntimeServer()` in `src/shared/maestro-lib/runtime/server.ts`

#### Providers, accounts, and auth

- **Claude Code's memory folder for a project:** `resolveClaudeMemoryPath()` in `src/shared/maestro-lib/translation/memory.ts`, `resolveConfigDirKeyFromEnv()` in `src/shared/maestro-lib/launch/interactive-mode.ts`
- **Discovering installed Codex skills:** `discoverCodexSkills()` in `src/main/agents/codex-skills.ts`
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **Two-letter labels for a set of agents:** `buildAgentInitials(agents)`, `agentInitialCandidates(name)` in `src/shared/agentInitials.ts`
- **Which providers a user can pick:** `AGENT_PICKER_META`, `PICKABLE_AGENT_IDS`, `getAgentPickerMeta()`, `AGENT_AUTOSELECT_ORDER` in `src/shared/agentMetadata.ts`
- **"Show only providers this machine can run":** `filterToAvailableProviders()`, `providerLocationLabel()` in `src/renderer/utils/providerAvailability.ts`, rendered by `<ProviderAvailabilityBar>`
- **Which provider account an agent runs as:** `resolveAgentProfile()`, `resolveAgentAccountKey()`, `effectiveAgentCustomEnvVars()`, `resolveAgentBillingCredential()` in `src/shared/providerProfiles.ts`; `useProviderProfiles()` in `src/renderer/hooks/stats/useProviderProfiles.ts`
- **Which account dirs exist for a provider (main):** `getProviderAccountDirs(toolType, options?)` in `src/main/agents/provider-account-dirs.ts`
- **Which account dir an agent runs under:** `resolveAgentAccountDir()` in `src/shared/agentAccountDir.ts` (store-reading wrapper in `src/main/agents/provider-account-dirs.ts`)
- **Naming the account a login acts on:** `<AccountPill>`, `ghAccountLabel()` in `src/renderer/components/ui/AccountPill.tsx`; `parseGhActiveAccount()` in `src/main/utils/ghErrors.ts`
- **Whether a login flow can fix an auth failure:** `classifyCredentialKind()`, `credentialKindBlocksLogin()`, `providerAuthKey()` in `src/shared/providerAuthIdentity.ts`
- **Typing a login command into a shell:** `formatAgentLoginCommand()`, `loginShellSyntaxFor()` in `src/shared/agentMetadata.ts`
- **Reading a Codex account's credentials off disk:** `readCodexAuth()`, `codexAuthHeaders()`, `extractEmailFromJwt()` in `src/main/agents/codex-auth.ts`
- **Codex rate-limit reset credits:** spend rules (`describeCreditSpend()`) in `src/shared/codexResetCredits.ts`, primitives in `src/main/agents/codex-reset-credits.ts`, state in `src/renderer/stores/codexResetCreditsStore.ts`, automation in `src/renderer/services/codexAutoReset.ts`
- **Keeping a plan account on the Usage Dashboard after its agents leave:** `rememberQuotaAccounts()`, `pruneMissingQuotaAccounts()` in `src/main/stores/quotaAccountsStore.ts`; `partitionSnapshotsByAge()` in `src/main/stores/usageSnapshotRetention.ts`
- **Which provider generates a synopsis:** `synopsisProviderChoice()`, `pickFirstAvailableProvider()` in `src/shared/directorNotesProvider.ts`; `resolveSynopsisProvider()` in `src/main/utils/director-notes-provider.ts`
- **Parsing a Codex assistant directive:** `parseCodexDirective()`, `findCodexDirectives()`, `KNOWN_CODEX_DIRECTIVES` in `src/shared/codexDirectives.ts`; U+E200 content references via `findCodexContentReferences()`, `KNOWN_CODEX_CONTENT_REFERENCES`
- **Rendering a Codex `visualize` reference inline:** `loadCodexVisualization()` in `src/main/codex-visualization.ts`, drawn by `CodexVisualizationFrame` in `src/renderer/components/Markdown/components/CodexVisualizationFrame.tsx`
- **Acting on a clicked Codex followup chip:** `requestCodexFollowup()`, `resolveCodexFollowup()`, `codexDirectivesLiveForSource()` in `src/renderer/services/codexFollowup.ts`, drawn by `FollowupChip`
- **Changing an agent's provider:** `switchAgentProvider()`, `switchTabProvider()`, `resolveTurnProvider()` in `src/shared/maestro-lib/agents/providerSwap.ts`

#### Agents (renderer state and navigation)

- **The record a new agent starts as:** `buildNewAgentRecord(input)`, `newAgentClaudeInteractive(toolType)` in `src/shared/newAgentRecord.ts`
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`; `useActiveSession()` hook in `src/renderer/hooks/session/useActiveSession.ts`
- **Session mutation:** `updateSessionWith()`, `updateAiTab()`, `updateFileTab()`, `updateBrowserTab()` in `src/renderer/stores/sessionStore.ts` (never `setSessions(prev => prev.map(...))` for one agent or tab)
- **Which agent this client is looking at:** `persistActiveSessionId()`, `readPersistedActiveSessionId()` in `src/renderer/utils/activeSessionPersistence.ts` (never `sessions.getActiveSessionId()` directly)
- **Which client this page is, across a reload:** `getClientInstanceId()` / `isReloadedClientInstance()` in `src/renderer/utils/clientInstance.ts`
- **Telling the other clients an agent appeared or went away:** `sessions:lifecycleSync`, emitted in `src/main/ipc/handlers/persistence.ts`, applied by `useSessionLifecycleSync` in `src/renderer/hooks/session/useSessionLifecycleSync.ts`
- **Moving an agent to another directory:** `withWorkingDirectory()`, `workingDirectoryChangeBlocker()`, `isSameDirectory()` in `src/renderer/utils/agentWorkingDirectory.ts`
- **Per-agent git actions:** `useGitAgentActions(session)` in `src/renderer/hooks/git/useGitAgentActions.ts`
- **Whether a PR is being opened right now:** `usePRCreationActive()`, `startPRCreation()` in `src/renderer/stores/prCreationStore.ts`
- **Taking the user to an agent:** `jumpToAgent()`, `revealAgentInSidebar()`, `openAgentSettings()` in `src/renderer/services/agentNavigation.ts`
- **Whether an agent is drawn in the Left Bar:** `sessionMatchesFilter()`, `passesUnreadFilter()`, `passesHiddenGroupFilter()` in `src/renderer/utils/sidebarMembership.ts`; attention via `sessionNeedsAttention()` in `src/renderer/utils/sessionAttention.ts`
- **Listing agents in the Left Bar's order:** `leftBarAgentOrder()`, `orderLeftBarGroups()` in `src/renderer/utils/leftBarOrder.ts`
- **Whether an agent is answering a consult right now:** `useSessionIsBeingConsulted(sessionId)`, `useConsultedSessionIds()` in `src/renderer/stores/crossAgentInFlightStore.ts`
- **Dismissing a drawer after the user picks something in it:** `closeLeftSidebarForNavigation()`, `closeRightPanelForNavigation()` in `src/renderer/stores/uiStore.ts` (call at the tap, never from an effect)
- **Which agents own an Opt+Cmd+# slot:** `buildSessionJumpSlotMap(visibleSessions)`, `sessionJumpShortcut(digit)` in `src/renderer/utils/sessionJumpSlots.ts`
- **Naming an agent from its folder (vs naming the project):** `projectNameFromPath()`, `defaultAgentNameForPath()` in `src/renderer/components/Wizard/shared/projectIdentity.ts`
- **Recording wizard usage:** `beginWizardRun()`, `recordWizardDocuments()` in `src/renderer/services/wizardStats.ts`
- **Leaving inline wizard mode:** `flattenWizardIntoTab(tab, { summary? })` in `src/renderer/utils/tabHelpers/index.ts`
- **What the Thinking pill lists:** `buildThinkingItems()` in `src/renderer/utils/thinkingItems.ts` (read through `useThinkingItems()`); `useBackgroundAutoRuns()` in `src/renderer/hooks/batch/useBackgroundAutoRuns.ts`

#### Tabs

- **Making a tab the visible one:** `aiTabFocusFields()`, `fileTabFocusFields()`, `browserTabFocusFields()`, `terminalTabFocusFields()` in `src/renderer/utils/tabHelpers/focusFields.ts` (never hand-roll the literal)
- **Any CLI verb that can move the Maestro view:** `resolveBackgroundFlag()` (CLI) / `readBackgroundField()` (handler) in `src/shared/focusPlacement.ts` (never `message.background !== false`)
- **Which tab a tab-scoped action targets:** `resolveActiveTabRef(session)`, `resolveTabRefRenameValue()`, `resolveTabRefTitle()` in `src/renderer/utils/panelLayout.ts`
- **Whether an AI tab is drawn in the tab strip:** `isAiTabHidden(tab)`, `visibleAiTabs(tabs)`, `hasUnreadVisibleTab(tabs)` in `src/renderer/utils/unifiedTabOrderUtils.ts` (never `aiTabs.length` or `aiTabs.some((t) => t.hasUnread)`)
- **What an unnamed tab is called:** `getTabDisplayName(tab)`, `isSessionIdLabel()` in `src/renderer/utils/tabHelpers`, over `formatSessionId(agentSessionId)`
- **Where a closed tab's name still exists:** `HistoryEntry.sessionName` only; pass it as the third argument of `handleResumeSession`
- **Reading a past conversation back into a tab:** `loadResumableSession()` in `src/renderer/services/resumableSession.ts`
- **Which tab a Quick Chat message goes to:** `decideRoute()`, `parseRouteAnswer()` in `src/shared/quickChatRouting.ts`; `routeQuickChatMessage()`, `reopenClosedConversation()` in `src/renderer/services/quickChatRouter.ts`
- **Naming a tab from the user's message:** `requestTabAutoName()`, `collectNamingPrompt()`, `requestWizardTabAutoName()` in `src/renderer/services/tabAutoNaming.ts`
- **Closing a tab while the unread filter is on:** `closeTab()`'s third argument is an OVERRIDE; omit it and `src/renderer/utils/tabHelpers/index.ts` reads `uiStore.showUnreadOnly`
- **Ending a turn with no process exit:** `settleTabThinkingState(session, tabId)` in `src/renderer/utils/tabHelpers/index.ts`
- **Handing the agent back when a shell command or a CLI playbook ends:** `settleAgentStateFromTabs(session)` in `src/renderer/utils/tabHelpers` (never gate on `aiPid`, which per-tab agents leave at 0 or -1)
- **Agent state from tab states another client reported:** `syncAgentStateToTabs(session)` in `src/renderer/utils/tabHelpers` (the web-desktop inventory sync)
- **A tab's own process produced output:** `markTabBusyFromOutput(session, tabId)` in `src/renderer/utils/tabHelpers`, via `noteLiveTabOutput()` in `src/renderer/hooks/agent/internal/helpers/liveTabOutput.ts` (check the tab first; write only when it is not already busy)
- **Stop and a pending auto-retry:** `stopRetriesForAgent(sessionId)` in `src/renderer/stores/retryStore.ts` (not `cancelRetry`, which raises the blocking error state)
- **Killing every AI process an agent owns:** `killAgentAiProcesses(agentId)` in `src/renderer/services/process.ts` (never kill the bare `{id}-ai`, which no per-tab turn uses)
- **Toggling the unread filters:** `toggleTabUnreadFilter()`, `toggleAllUnreadFilters()`, and `areUnreadFiltersActive()` in `src/renderer/services/unreadFilters.ts`
- **Creating a tab straight into a tile:** `tileNewTab()` / `canTileNewTab()` in `src/renderer/hooks/tabs/tileNewTab.ts`
- **Restoring an AI tab's scroll position:** `initialScrollTop` + `initialIsAtBottom`, consumed by `useTerminalOutputScroll()` in `src/renderer/components/TerminalOutput/hooks/useTerminalOutputScroll.ts`
- **How big a tab's conversation is and how long it ran:** `computeTabConversationStats()`, `formatConversationDuration()` in `src/shared/tabConversationStats.ts`
- **What a snooze opener was handed:** `resolveSnoozeTarget(session, id)` in `src/renderer/utils/snoozeHelpers.ts`
- **Parking, waking, dismissing, or rescheduling ONE snooze:** `snoozeTabWithMirror()`, `wakeSnoozeNow()`, `dismissSnoozeNow()`, `rescheduleSnoozeNow()` in `src/renderer/services/snoozeActions.ts`

#### Composer, queue, and transcript

- **Command mode (`!`) is STATE, not a text prefix, and it is a LADDER:** the mode is STATE, never a leading `!`: `composerInputStore.aiCommandMode` (`'off' | 'shell' | 'ai'`), read through `isShellCommandMode()`, `isAiCommandMode()`, `normalizeComposerCommandMode()` in `src/renderer/utils/shellCommandInput.ts`
- **Run a shell command from the chat:** `dispatchShellCommand()`, `runShellCommand()`, `cancelShellCommand()`, `resolveCommandCwd()` in `src/renderer/services/shellCommand.ts`
- **Ask the model for a shell command (AI command mode):** `requestAiCommand()`, `acceptAiCommand()`, `dismissAiCommand()` in `src/renderer/services/aiCommand.ts`; prompt in `src/prompts/ai-command.md`
- **Shell tab completion:** `useTabCompletion()` in `src/renderer/hooks/input/useTabCompletion.ts` (terminal composer and command mode)
- **Revealing output the user asked for, past a paused auto-scroll:** `requestTranscriptScrollToBottom(sessionId, tabId)` in `src/renderer/services/transcriptScroll.ts`
- **Appending to a transcript entry:** `canAppendToLogEntry(entry, source)` / `isSelfContainedCard(entry)` in `src/renderer/utils/logEntries.ts`
- **`{{template}}` variable autocomplete:** `useTemplateAutocompleteEngine()` in `src/renderer/hooks/input/useTemplateAutocompleteEngine.ts`, bound by `useTemplateAutocomplete()` (textarea) or `useEditorTemplateAutocomplete()` (CodeMirror)
- **Sending a prompt to an agent from outside the composer:** `enqueuePromptForTab()`, `buildQueuedMessageItem()` in `src/renderer/services/queuedPrompt.ts` (queue it, do not spawn it)
- **Running or withdrawing one queued item now:** `sendQueuedItemNow()`, `removeQueuedItem()` in `src/renderer/services/queuedPrompt.ts`
- **The tab a queued item is going to:** `resolveQueuedItemTabName(session, item)` in `src/renderer/utils/executionQueue.ts` (label), `resolveQueuedItemTarget()` in `src/renderer/utils/tabHelpers` (tab); never render `item.tabName`
- **Editing the newest queued message:** `requestEditLastQueuedMessage()` in `src/renderer/services/editQueuedMessage.ts`
- **Recovering a turn refused on the context limit:** `getContextCompactCommand()` in `src/shared/contextCompaction.ts`; `compactTabContext()`, `recordContextCompaction()` in `src/renderer/services/contextCompaction.ts`; driven by `scheduleRetryForError()` in `src/renderer/stores/retryStore.ts`
- **Whether a Force Send control exists at all:** `shouldOfferForceSend()`, `getForceSendEligibility()`, `getForceSendTitle()` in `src/renderer/utils/executionQueue.ts`
- **Model/effort badges on a finished turn:** `<TurnSettingPills>` in `src/renderer/components/ui/TurnSettingPills.tsx`; settings are stamped at SEND by `codifyTurnSettings()` in `src/renderer/utils/providerTabSessions.ts`
- **Thinking mode (`'off' | 'on' | 'sticky'`):** `THINKING_MODES`, `nextThinkingMode()`, `asThinkingMode()` in `src/shared/types.ts`
- **The red Stop pill:** `<StopTurnButton>` in `src/renderer/components/ui/StopTurnButton.tsx`
- **Opening the expanded staged-image organizer:** `requestOpenStagedImagesOrganizer()` in `src/renderer/services/stagedImagesOrganizer.ts`
- **The `src` of a conversation image:** `displayImageSrc(src)` in `src/renderer/utils/sessionImageSrc.ts`, over `src/shared/sessionImageRefs.ts`; a chip wraps the RESULT in `sessionImageThumbnailSrc()`
- **Referencing / thumbnailing a pasted transcript image:** `isSessionImageRef()`, `sessionImageThumbnailSrc()` in `src/shared/sessionImageRefs.ts`

#### Cross-agent consults

- **Consulting another agent from a message (`@mention`):** `planCrossAgentMentions()`, `dispatchCrossAgentMentions()`, `dispatchCrossAgentMentionsForMessage()`, `queuedMentionFields()` in `src/renderer/services/crossAgentMentions.ts` (plan at submit, fire when the item is the agent's turn)
- **Holding a mentioning turn open until its consult replies:** `holdTurnForConsults()`, `settleConsultHold()`, `withConsultPendingNote()` in `src/renderer/services/crossAgentConsultHold.ts`
- **When a mention runs (parallel / consult first / hand-off):** `inferMentionTiming()` in `src/shared/crossAgentContext.ts`; `armMentionHandoff()`, `releaseMentionHandoff()`, `dropMentionHandoffs()` in `src/renderer/services/crossAgentHandoff.ts`
- **An agent asking another agent (`maestro-cli ask`):** `runCrossAgentAsk()` in `src/renderer/services/crossAgentAsk.ts` (a question is `ask`, never `dispatch`)
- **Marking an agent's own hand-off in its transcript (`dispatch` / `ask` from its shell):** `readCallerIdentity()`, `callerMessageFields()`, `isSelfDispatch()` in `src/shared/agentDelegation.ts`; `recordAgentDelegation()`, `settleAgentDelegation()` in `src/renderer/services/agentDelegation.ts`
- **Running a consult (prompt, budgets, completion, Stop):** `createConsultService()` in `src/shared/maestro-lib/agents/consult.ts`
- **Which agents a message mentions, and the `@` picker's rules:** `planMentions()`, `resolveMentionedTargetSessionIds()`, `buildAgentMentionSuggestions()` in `src/shared/maestro-lib/mentions/roster.ts`

#### Auto Run, Cue, Group Chat, Director's Notes

- **Importing a Cue bundle into a data dir:** `planCueBundleImport()`, `importCueBundle()` in `src/main/cue/bundle/cue-bundle-importer.ts` (dry run, workspace mapping, atomic write)
- **Merging subscriptions into an existing cue.yaml:** `mergeSubscriptionsIntoCueYaml()`, `writeMergedCueYaml()` in `src/main/cue/cue-scheduled-tasks.ts` and `src/main/cue/cue-yaml-write.ts`
- **The GitHub token Cue's own `gh` calls run with:** `buildGhEnv(base)`, `GH_TOKEN_SECRET_NAMES` in `src/main/cue/cue-gh-token.ts` (reads secret files before env; scrubs tokens from failures)
- **Health of a headless Cue engine (`/healthz`, `/readyz`, `/status`):** `createCueEngineHealth()` in `src/main/cue/cue-engine-health.ts`, served by `startCueStatusServer()` in `src/main/cue/cue-status-server.ts`
- **Telling someone outside about a headless Cue notification:** `createCueNotifyWebhook()`, `parseNotifyWebhookUrl()` in `src/main/cue/cue-notify-webhook.ts` (`--notify-webhook` for notifications)
- **Telling systemd about a headless Cue engine:** `createSystemdNotifier()`, `watchdogIntervalMs()` in `src/main/cue/cue-systemd-notify.ts` (driven by `CueEngineHealth` for READY, WATCHDOG, STOPPING)
- **Stopping a headless Cue engine without losing work:** `CueEngine.drain()` / `forceStop()` in `src/main/cue/cue-engine.ts` (never `stop()`, which deletes the persisted queue)
- **Whether a data dir can run Cue unattended:** `checkCueReadiness()`, `formatCueReadiness()` in `src/main/cue/cue-readiness.ts` (behind `cue engine check`, `--require-ready`, and `/readyz`)
- **Redacting credentials from text that leaves the machine:** `redactCredentialTokens()`, `containsCredentialToken()` in `src/shared/agent-run/redact.ts`
- **Model tier / effort level (`'low' | 'medium' | 'high'`):** `resolveTierModel()`, `resolveEffortLevel()`, `cheapTurnSettings()`, `cheapResumeTurnSettings()` in `src/shared/modelTiers.ts`; `findActiveModelHint()` in `src/shared/autorunModelHints.ts`; `resolveTurnSettings()` in `src/shared/autorunTurnSettings.ts`
- **A provider refusing an effort level:** `parseEffortRejection()`, `noteEffortRejection()` in `src/shared/effortRejection.ts`; `rejectedEffortForLevel()` in `src/shared/modelTiers.ts`; `armEffortFallback()` in `src/renderer/services/effortRejection.ts`
- **A synopsis turn (the cheap summary resumed on a finished session):** the model rule is `cheapResumeTurnSettings()` in `src/shared/modelTiers.ts`; the CLI turn is `requestCliSynopsis()` in `src/cli/services/synopsis.ts`
- **Un-parking an Auto Run stopped on an error:** `registerBatchResumer()`, `getBatchResumer()` in `src/renderer/services/batchResumer.ts`; `resolveAutoResumePolicy()` in `src/shared/autorunAutoResume.ts`; `scheduleAutoResume()`, `cancelPendingAutoResume()` in `src/renderer/stores/autoRunResumeStore.ts`
- **Auto Run markers (HITL / halt / model hint):** `scanMaestroMarkers()`, `findPendingHitlGate()`, `detectHaltMarker()`, `hasMaestroMarker()` in `src/shared/autorunMarkers.ts`, rendered by `<MarkerPill>`
- **Auto Run steering notes (mid-run course correction):** `formatSteeringNotesBlock()` in `src/shared/autorunSteering.ts`; `submitSteeringNote()`, `recordSteeringResponse()`, `runRemoteSteeringCommand()` in `src/renderer/services/autoRunSteering.ts`; wire shape in `src/shared/autoRunSteeringCommands.ts`
- **Fence-aware markdown scanning:** `forEachMarkdownLine()`, `UNCHECKED_TASK_REGEX`, `CHECKED_TASK_COUNT_REGEX`, `CHECKED_TASK_REGEX` in `src/shared/markdownTaskScan.ts`
- **Auto Run document names (absolute path to folder-relative):** `resolveAutoRunDocumentName()`, `resolveAutoRunDocumentNames()` in `src/shared/autoRunDocumentPaths.ts`
- **Ordering the Auto Run run list from the picker:** `applySelectionOrder()`, `selectFolderFiles()` in `src/renderer/utils/documentSelectionOrder.ts`
- **Whether an Auto Run is parked waiting on the user:** `useAutoRunErrorPaused(sessionId)` in `src/renderer/hooks/batch/useAutoRunPause.ts` (never `errorPaused` off the `batchRunState` prop)
- **Folding a disk change into an Auto Run draft:** `reconcileDiskContent()`, `isAutoRunDocumentLocked()` in `src/renderer/utils/autoRunDraft.ts`
- **Auto Run percent complete and ETA:** `autoRunProgressPercent()`, `estimateAutoRunEta()` in `src/shared/autorunProgress.ts`, drawn by `<AutoRunProgressStats>`
- **Which agent an Auto Run executes in (worktree targets):** `resolveAutoRunDispatchTarget()` in `src/renderer/services/autoRunDispatchTarget.ts`; cue.yaml spelling in `src/shared/cue/autorun-worktree.ts`
- **Scheduled Tasks (clock-driven Cue subs):** types and pure helpers in `src/shared/cue/scheduled-tasks.ts`, filesystem work in `src/main/cue/cue-scheduled-tasks.ts`
- **Editing one Cue subscription in place:** `patchSubscriptionInYaml()`, `setSubscriptionTurnSettings()`, `findSubscriptionsByName()` in `src/main/cue/cue-subscription-edit.ts`; `applyCueTurnSettingsPatch()` in `src/shared/cue/turn-settings.ts`
- **Whether two subscriptions are the same visual trigger:** `triggerGroupKey(sub)` in `src/shared/cue/trigger-group-key.ts`
- **How big a pipeline is on the canvas:** `pipelineCardBounds()`, `nodeFootprintWidth()`, `estimateNodeWidth()` in `src/renderer/components/CuePipelineEditor/utils/nodeFootprint.ts`
- **Which pipelines belong to an agent:** `pipelinesForSession()`, `pipelineInvolvesSession()`, `pipelineNamesDeclaredBySession()` in `src/renderer/components/CuePipelineEditor/utils/pipelineMembership.ts`
- **What a group chat does with a message it cannot send yet:** pure rules in `src/shared/groupChatQueueModel.ts`, driven by `src/main/group-chat/group-chat-queue.ts` (the queue is owned by MAIN; the renderer holds a mirror)
- **How much work happened in a group chat:** `computeGroupChatActivity(entries)` in `src/shared/groupChatActivity.ts` (never the first-to-last message span)
- **Bucketing Director's Notes bullets:** `bucketNarrativeItems()`, `shouldRenderBuckets()`, `buildNarrativeGroupLookup()` in `src/shared/directorNotesGrouping.ts`
- **Which agent a persisted group chat participant came from:** `findSessionForParticipantName(participantName, sessions)` in `src/shared/group-chat-types.ts`
- **Running an Auto Run with no desktop (launch, progress, pause, stop):** `createRuntimeAutoRun()` in `src/shared/maestro-lib/runtime/autorun.ts`
- **Running a group chat or a consult with no desktop (rounds, `@participant`, `ask`):** `createRuntimeGroupChats()` in `src/shared/maestro-lib/runtime/group-chats.ts`, `createRuntimeConsults()` in `src/shared/maestro-lib/runtime/consults.ts`

#### Notifications, modals, and surfaces

- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })` in `src/renderer/stores/notificationStore.ts` (async results, errors, sticky messages)
- **Whether in-app toasts are on:** `areToastsEnabled()`, `TOAST_DURATION_OFF`, `resolveEnabledToastDuration()` in `src/shared/toastDuration.ts`; `setToastsEnabled()` (settings store), `toggleInAppToasts()` in `src/renderer/services/inAppToasts.ts` (never compare against `-1`)
- **What a toast click does:** `ToastClickAction` + `parseToastClickAction()` in `src/shared/toastClickAction.ts`, dispatched by `dispatchToastClickAction()` in `src/renderer/services/toastClickActions.ts`
- **Toast history / unread state:** `history`, `markNotificationRead()`, `selectUnreadNotificationCount()` in `src/renderer/stores/notificationStore.ts`; `<NotificationCenter>`, `<NotificationCenterHost>` in `src/renderer/components/NotificationCenter.tsx`
- **Center flash (rapid acks):** `notifyCenterFlash()` in `src/renderer/stores/centerFlashStore.ts`; `flashCopiedToClipboard()` in `src/renderer/utils/flashCopiedToClipboard.ts` (momentary acks; never a Toast for clipboard)
- **Keeping toasts off a surface the user works in:** `useToastAvoidZone()`, `toastBottomInset()` in `src/renderer/hooks/ui/useToastAvoidZone.ts`
- **Opening a modal / dashboard by name:** `UI_SURFACES`, `resolveUiSurface()` in `src/shared/uiSurfaces.ts`, dispatched by `openUiSurface()` in `src/renderer/utils/openUiSurface.ts`
- **Whether a modal takes the window over:** `DESTINATION_MODALS`, `registerExternalDestination()` in `src/renderer/stores/modalStore.ts`
- **Opening a modal from inside Settings:** `launchFromSettings(open)` in `src/renderer/utils/launchFromSettings.ts`
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Whether a surface is the topmost layer:** `useIsTopLayer(priority)` in `src/renderer/hooks/ui/useIsTopLayer.ts`
- **Modal / find-bar ESC pill:** `<EscCloseButton>` in `src/renderer/components/ui/EscCloseButton.tsx`
- **A modal default sized to the screen:** `viewportModalSize({ width, height })` in `src/renderer/utils/modalSizing.ts`
- **Audio/video playback:** media NEVER becomes a tab: `handleOpenFileTab()` in `src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts` diverts it to `useMediaPlaybackStore` and the one `FloatingMediaPlayer`; `file://` links go through `openFileUrl()` in `src/renderer/utils/openFileUrl.ts`
- **Opening a clicked link:** `openUrl(url, { ctrlKey })` in `src/renderer/utils/openUrl.ts`, over `parseUrlRoutingHint()` / `isWebUrl()` / `stripUrlRoutingHint()` in `src/shared/urlRoutingHint.ts`
- **Right-click menu on an image:** already app-wide via `<ImageContextMenuHost>` in `src/renderer/components/ImageContextMenuHost.tsx`; opt a surface out with `data-no-image-menu`
- **Saving generated image bytes to disk:** `saveImageDataUrlToDisk()`, `saveImageElementToDisk()`, `saveImageToProject()` in `src/renderer/utils/imageExport.ts`
- **Reading a pasted or dropped image (or any Blob) as a data URL:** `readBlobAsDataUrl()`, `imageFilesIn()`, `downscaleImageDataUrl()` in `src/renderer/utils/imageData.ts`
- **Screenshotting a surface exactly as it is painted:** `window.maestro.shell.capturePage(rect?)` (preload `src/main/preload/system.ts`, handler in `src/main/ipc/handlers/system.ts`)
- **Loading an image for canvas compositing:** `loadImageElement(src)` in `src/renderer/utils/loadImage.ts`
- **Pan and zoom a diagram or image:** `usePanZoom()` in `src/renderer/hooks/ui/usePanZoom.ts`; full-window viewer via `openZoomViewer(element)` in `src/renderer/components/ZoomViewer/zoomViewerStore.ts`
- **Diagram content clipped at the SVG edge:** `expandSvgViewBoxToContent(svg, padding?)` in `src/renderer/utils/svgViewBox.ts`
- **The message of a rejected IPC call:** `ipcErrorMessage(error)` in `src/renderer/utils/ipcErrorMessage.ts` (never show `error.message` raw)

#### Keyboard and shortcuts

- **Which bindings the live keyboard mode matches:** `resolveEffectiveShortcuts()`, `overridesWithEdits()` in `src/shared/effectiveShortcuts.ts`; `selectActiveShortcuts()` and siblings in `src/renderer/stores/settingsShortcutsSlice.ts`; `useActiveShortcuts()` in `src/renderer/hooks/settings/useActiveShortcuts.ts`
- **Matching a key sequence (`g g`, `g t`):** `createSequenceMatcher()`, `collectSequenceBindings()`, `SEQUENCE_TIMEOUT_MS` in `src/renderer/utils/shortcutSequence.ts`; each step compares with `eventMatchesShortcutKeys()` in `src/renderer/utils/shortcutMatch.ts` (never a second copy of the chord rules)
- **Showing a key sequence in progress:** `<SequencePrefixIndicator>` in `src/renderer/components/SequencePrefixIndicator.tsx`, fed by `publishSequencePrefix()` / `clearSequencePrefix()` / `useSequencePrefixStore` in `src/renderer/stores/sequencePrefixStore.ts` (one app-wide chip; never a second copy of the prefix)
- **Recording a key sequence, and whether it may be bound:** `recordSequenceStep()` in `src/renderer/utils/shortcutRecorder.ts`; `shortcutSequencesCollide()`, `shortcutSequencesEqual()` in `src/shared/shortcutKeys.ts`
- **Switching the live keyboard mode:** `switchKeyboardMode(mode?)`, `nextKeyboardMode()`, `findKeyboardModeToggleShadow()`, `keyboardModeToggleShadow()`, `KEYBOARD_MODE_TOGGLE_KEYS` in `src/renderer/services/keyboardMode.ts` (never `setKeyboardMode` from a surface)
- **Moving focus between the Left Bar, Main Window, and Right Bar:** `focusRegion()`, `focusRegionDirection()`, `focusRegionVertical()`, `focusedRegion()`, `REGION_ORDER` in `src/renderer/services/regionFocus.ts`
- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()`, `formatMetaKey()`, `formatMetaKeyName()`, `formatAltKeyName()` in `src/renderer/utils/shortcutFormatter.ts`; outside the renderer `formatShortcutKeysFor()` in `src/shared/shortcutKeys.ts`
- **Advertising a shortcut next to the control that fires it:** `<ShortcutHint>`, `<ShortcutKeys>`, `shortcutText()`, `shortcutSuffix(keys)` in `src/renderer/components/ui/ShortcutHint.tsx` (also the tab overlay-menu badge)
- **Keyboard-shortcut hint / kbd pill:** `<Keycap>` and `<KeycapHint>` in `src/renderer/components/ui/Keycap.tsx`
- **A system-wide (OS-level) hotkey:** `setNamedGlobalHotkey(id, keys, onPress)`, `keysToAccelerator(keys)` in `src/main/global-hotkey-manager.ts`
- **Whether a chord may be bound at all:** `findReservedShortcutCombo(keys)` in `src/shared/shortcutKeys.ts`
- **Whether a keystroke belongs to a text field (guard before `preventDefault`):** `isTextInputTarget()`, `isTextEntryTarget()` in `src/renderer/utils/messageScrollNavigation.ts`; `isEditingTextTarget()`, `isEditingTextFocused()` in `src/renderer/utils/editableTarget.ts`
- **Whether a keystroke is free for a binding to claim (normal mode):** `isNormalMode(event, doc?)` beside `isTextEntryTarget()` in `src/renderer/utils/messageScrollNavigation.ts` (the caller adds `hasOpenLayers()`)
- **Hiding a switched-off Encore Feature's shortcut, menu item, or setting:** `availableShortcuts()`, `isShortcutAvailable()`, `SHORTCUT_ENCORE_FLAGS` in `src/renderer/utils/encoreShortcuts.ts`; `requiresEncore` on `SearchableSetting`; `encoreFlag` on a `MenuCommand` in `src/main/app-menu.ts`
- **Hiding a switched-off Encore Feature's prompts and template variables:** `isPromptAvailable()` in `src/shared/promptDefinitions.ts`; `availableTemplateVariables()` in `src/shared/templateVariables.ts`, read through `useAvailableTemplateVariables()` in `src/renderer/hooks/input/useAvailableTemplateVariables.ts`
- **How much of the keyboard the user has mastered:** `selectMasteryBoundShortcuts()` in `src/renderer/stores/settingsShortcutsSlice.ts`; `collectBoundShortcutsAcrossModes()`, `countUsedBoundShortcuts()` in `src/renderer/constants/keyboardMastery.ts`
- **Arrow-key navigation over a list or grid:** `useListNavigation()` in `src/renderer/hooks/keyboard/useListNavigation.ts`; a grid feeds it `useGridColumnCount()` from `src/renderer/hooks/ui/useGridColumnCount.ts`
- **Bare `+` / `-` / `0` zoom on a surface:** `useScaleShortcuts(control, { enabled })` in `src/renderer/hooks/ui/useScaleShortcuts.ts`
- **Keyboard navigation in a `<DualPaneFileEditor>` list:** built in: Up/Down walk the visible rows, Backspace/Delete raise `onDeleteItem`; pass `autoFocusList`, bump `listFocusToken` after a delete

#### UI components and widgets

- **A spinning loading icon:** `<Spinner>` in `src/renderer/components/ui/Spinner.tsx` (never `animate-spin` on an `<svg>`)
- **Tiny uppercase state chip:** `<MiniBadge>` in `src/renderer/components/ui/MiniBadge.tsx`
- **A labeled action button in a panel header:** `<HeaderActionButton>` in `src/renderer/components/ui/HeaderActionButton.tsx`
- **A text box that narrows a list:** `<FilterInput>` in `src/renderer/components/ui/FilterInput.tsx`
- **Segmented toolbar (sort/filter pill bar):** `<SegmentedControl>` in `src/renderer/components/ui/SegmentedControl.tsx`
- **Paginating a list already in memory:** `usePagination()` in `src/renderer/hooks/ui/usePagination.ts`, `<Pager>` in `src/renderer/components/ui/Pager.tsx` (not `useHistoryPagination`)
- **Sortable table header:** `<SortableTh>` in `src/renderer/components/ui/SortableTh.tsx` + `useTableSort()` in `src/renderer/hooks/ui/useTableSort.ts`
- **A list of editable `key = value` pairs:** `<KeyValueRows>` in `src/renderer/components/ui/KeyValueRows.tsx`, with `recordToKeyValueRows()` / `keyValueRowsToRecords()` beside it
- **Switching a `key = value` entry off without deleting it:** `splitParkedEntries()` / `setKeysParked()` / `parkedPairKeys()` in `src/shared/parkedRecords.ts`
- **Record view for one table row:** `<RecordDetailModal>` in `src/renderer/components/ui/RecordDetailModal.tsx`
- **Usage Dashboard card tile:** `<EntityTile>` in `src/renderer/components/UsageDashboard/EntityTile.tsx`
- **Usage Dashboard metric tile:** `<MetricCard>` in `src/renderer/components/UsageDashboard/MetricCard.tsx`
- **Color for the Nth chart series:** `getSeriesColor(index, theme, colorBlindMode?)` in `src/renderer/components/UsageDashboard/chartUtils.ts`
- **A label that must not truncate:** `useOptionalLabelFits(rowRef)` in `src/renderer/hooks/ui/useOptionalLabelFits.ts`
- **Adding a control to the Left Bar header:** three zones (identity, indicators, menu); a status control goes in the CENTER band and the wordmark never truncates (`showWordmark` in `SessionList.tsx`)
- **Color math and contrast:** `readableTextOn()`, `isReadableOn()`, `contrastRatio()`, `blendColors()`, `transparentize()`, `adjustBrightness()`, `hexToRgb()` in `src/shared/colorContrast.ts`
- **Diagram labels on fills the AUTHOR chose:** `repairDiagramLabelContrast(svg)` in `src/renderer/utils/diagramLabelContrast.ts`, over `cssColorToHex()` in `src/shared/colorContrast.ts`
- **Naming the OS file manager in copy:** `getFileManagerName()`, `fileManagerName()`, `getRevealLabel()`, `getOpenInLabel()` in `src/renderer/utils/platformUtils.ts`
- **Rendering raw terminal output (ANSI):** `useAnsiConverter(theme)` in `src/renderer/hooks/ui/useAnsiConverter.ts`, then `getCachedAnsiHtml()` in `src/renderer/utils/textProcessing.ts`
- **Previewing a parquet file:** `<ParquetViewer>` in `src/renderer/components/ParquetViewer/`, over the main-process engine in `src/main/parquet/` and the shared filter language in `src/shared/parquet/`
- **Graphing a set of documents rather than one:** `BuildOptions.scopeFiles` / `scopeDirectory` in `src/renderer/components/DocumentGraph/graphDataBuilder.ts`, opened via `openGraphScope()` in `fileExplorerStore.ts`
- **Sizing a Document Graph node:** `calculateNodeWidth()`, `calculateNodeHeight()` in `src/renderer/components/DocumentGraph/mindMapLayouts.ts` (never the `NODE_WIDTH` constant)
- **Filtering the Git Log:** `gitLogSearchTerms()`, `matchesGitLogTerms()` in `src/renderer/utils/gitLogSearch.ts`; `contractGitGraphNodes()` in `src/renderer/utils/gitGraphLayout.ts`
- **Layout and navigation for the Git Log graph:** `buildGitGraphCore()`, `computeGitGraphGeometry()`, `stepGitGraphVertical()`, `stepGitGraphHorizontal()` and siblings in `src/renderer/utils/gitGraphLayout.ts`

#### Markdown, text, and fonts

- **Render markdown:** `<Markdown preset="chat | document | wizard-bubble | release-notes">` from `src/renderer/components/Markdown/`; document map `createMarkdownComponents()` in `src/renderer/utils/markdownConfig.ts`
- **Markdown to plain text (list rows, previews):** `stripMarkdown()`, `flattenMarkdownTables()` in `src/shared/markdown.ts`
- **Clickable task checkboxes in rendered markdown:** `toggleTaskCheckboxAtLine()` in `src/renderer/utils/markdownTasks.ts`, `rehypeSourceLine` in `src/renderer/components/Markdown/rehypeSourceLine.ts`, `onTaskToggle` on `createMarkdownComponents()`
- **A pane that reads and edits a markdown document:** the File Preview stack, never a bare `<textarea>`: `<Markdown preset="document">` to read, `<MarkdownEditor>` from `src/renderer/components/FilePreview/markdownEditor` to write (`MemoryViewer` is the reference)
- **Jumping a markdown preview to a heading:** `scrollToHeadingSlug()`, `headingLevelColor()` in `src/renderer/components/FilePreview/shared/headings.ts`
- **Which heading the reader is under right now:** `findActiveHeadingSlug()` in `src/renderer/components/FilePreview/shared/headings.ts`
- **Highlight vs selection in a heading list:** `FilePreviewToc` takes `activeIndex` and keeps its own `selectedIndex`; `-1` is a real value on both
- **Reaching the open file preview from a modal:** `requestHeadingPalette()`, `HEADING_PALETTE_EVENT` in `src/renderer/services/headingPalette.ts`
- **Highlighting a search hit:** `highlightMatches()`, `searchMatchRanges()` in `src/renderer/utils/highlightMatches.tsx`; `<TextareaHighlightOverlay>` in `src/renderer/components/ui/TextareaHighlightOverlay.tsx`
- **Highlighting a FUZZY hit:** `renderFuzzyHighlight()`, `fuzzyMatchWithIndices()` in `src/renderer/utils/search.ts`
- **Rendering a surface containing `<MarkdownEditor>` in a test:** `markdownEditorModuleMock()` in `src/__tests__/helpers/mockMarkdownEditor.tsx` (CM6 cannot lay itself out in jsdom)
- **Line numbers beside a `<textarea>`:** `<TextareaLineNumbers>` + `lineNumberGutterMetrics()` in `src/renderer/components/ui/TextareaLineNumbers.tsx`
- **Font-family fallback chain:** `withMonoFallback()`, `resolveSurfaceFont()`, `MONO_FALLBACK_STACK`, `WORDMARK_FONT_STACK` in `src/shared/fontStack.ts`
- **Fixed-pitch font for shell text:** `resolveFixedPitchFontFamily()`, `resolveTerminalFontFamily()`, `isFixedPitchStack()` in `src/renderer/utils/fixedPitchFont.ts`; `useFixedPitchFont()` in `src/renderer/hooks/ui/useFixedPitchFont.ts`
- **Saving the user's own font setup:** `captureTypographySnapshot()`, `typographySnapshotPatch()`, `typographySnapshotMatches()` in `src/shared/typographySnapshot.ts`; keys from `TYPOGRAPHY_SURFACE_LIST` in `src/shared/typography.ts`
- **Font zoom on a reading pane:** `useFontScale(storageKey)` in `src/renderer/hooks/ui/useFontScale.ts`, `<FontScaleControl>` in `src/renderer/components/ui/FontScaleControl.tsx`, range math in `src/shared/scaleRange.ts`

#### Layout, scroll, sizing, and hook utilities

- **Following streaming output in a capped box:** `useStickToBottom(contentKey)` in `src/renderer/hooks/ui/useStickToBottom.ts`
- **Reaching an off-screen item while dragging:** `useDragAutoScroll(ref, { active })` in `src/renderer/hooks/ui/useDragAutoScroll.ts`
- **Keeping a virtualized list on its selection:** the virtualizer's own `scrollToIndex` from an effect, never a `ref` on the row; a plain list uses `useScrollIntoView` in `src/renderer/hooks/ui/useScrollIntoView.ts`
- **Sizing a virtualized row the user's font decides:** `virtualizer.measureElement` + `data-index` and NO inline `height` (see `HistoryPanel`, `FileSearchModal`)
- **Element width for JS-computed layout:** `useElementWidth(ref, enabled?)`, `useElementHeight(ref, enabled?)` in `src/renderer/hooks/ui/useElementWidth.ts`
- **Keeping a floating menu on screen:** `useContextMenuPosition(menuRef, x, y)` in `src/renderer/hooks/ui/useContextMenuPosition.ts` (apply BOTH `maxHeight` and `overflowY: 'auto'`)
- **Dropdown/tooltip anchored to a header element:** `useAnchoredMenuPosition(menuRef, anchorRef)` in `src/renderer/hooks/ui/useAnchoredMenuPosition.ts`, rendered via `createPortal(..., document.body)`
- **A pane width the user sets by dragging:** `useResizablePanel()` in `src/renderer/hooks/ui/useResizablePanel.ts`; a pane inside another surface pairs it with `usePersistedPanelWidth()` and omits `settingsKey`
- **A dropdown the user resizes by its bottom edge (never off screen):** `useResizableDropdownHeight()`, `fitDropdownHeight` in `src/renderer/hooks/ui/useResizableDropdownHeight.ts`
- **Sizing a surface to its longest label:** `widestLabelWidth(labels, opts)`, `estimateLabelWidth()` in `src/renderer/utils/labelWidth.ts`
- **Remembered textarea height:** `useResizableTextarea()` in `src/renderer/hooks/ui/useResizableTextarea.ts`
- **Auto-growing composer textarea:** `useAutosizeTextarea()` in `src/renderer/hooks/ui/useAutosizeTextarea.ts`
- **Guarded `localStorage` access:** `safeLocalStorage()`, `safeSessionStorage()`, `writeStorageValue()`, `safeStorageGet()` / `safeStorageSet()` in `src/renderer/utils/safeLocalStorage.ts`
- **A view preference a user sets by clicking:** `usePersistedToggle(storageKey, defaultValue)` in `src/renderer/hooks/ui/usePersistedToggle.ts`; `usePersistedChoice()` in `src/renderer/hooks/ui/usePersistedChoice.ts` for one of several words
- **Focus after render:** `useFocusAfterRender()`, `useFocusOnMount()`, `useFocusOnClose(ref, isOpen)` in `src/renderer/hooks/utils/useFocusAfterRender.ts` (never `useEffect` + `setTimeout(() => ref.focus())`)
- **Event listeners:** `useEventListener()` in `src/renderer/hooks/utils/useEventListener.ts` (do NOT pair raw `addEventListener`/`removeEventListener` inside useEffect)
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()`, `useThrottledCallback()` in `src/renderer/hooks/utils/useThrottle.ts` (filename is misleading - all three live here)
- **Identity-stable callback:** `useStableCallback()` in `src/renderer/hooks/utils/useStableCallback.ts`
- **Data a surface fetches that must survive it unmounting:** `useCachedResource()`, `revalidateCachedResource()`, `readCachedResource()` in `src/renderer/hooks/utils/useCachedResource.ts`; `useDashboardResource()`, `useTokenUsage()` in `src/renderer/components/UsageDashboard/`
- **Steering a turn that is ALREADY RUNNING:** `getSteerEligibility()` in `src/renderer/utils/executionQueue.ts`, `steerQueuedItem()`, `requestSteerSend()` in `src/renderer/services/chatSteering.ts`, wire protocol in `src/shared/chatSteering.ts`, `steerCodexAppServerTurn()` in `src/main/codex-app-server/steering.ts`
- **Honoring the user's settings in a secondary window:** `useWindowSettingsSync()`, `usePublishTypographyVars()`, `useReloadSettingsOnExternalChange()` in `src/renderer/hooks/settings/useWindowSettingsSync.ts`

#### Phone and touch (web-desktop)

- **Whether a surface is on a phone:** `usePhoneLayout()` / `isPhoneLayout()` in `src/renderer/hooks/ui/useViewportBreakpoint.ts` (never `window.innerWidth < 640`)
- **Touch primitives:** `isCoarsePointer()`, `triggerHaptic()`, `supportsHaptics()`, `HAPTIC_PATTERNS`, `GESTURE_THRESHOLDS`, `MIN_TOUCH_TARGET` in `src/renderer/utils/touch.ts`
- **Long-press gesture:** `useLongPress()` in `src/renderer/hooks/utils/useLongPress.ts` (never `setTimeout` + `touchmove`)
- **A bottom sheet on a phone:** `<PhoneBottomSheet>` in `src/renderer/components/ui/PhoneBottomSheet.tsx`
- **Rows inside a `PhoneBottomSheet`:** `PhoneSheetSection`, `PhoneSheetOptionRow`, `PhoneSheetActionRow` in `src/renderer/components/ui/PhoneSheetRows.tsx`
- **A tab chip's action menu shell:** `<TabOverlayPortal>` in `src/renderer/components/TabBar/TabOverlayPortal.tsx`
- **The file preview toolbar on a phone:** `<FilePreviewActionsSheet>` in `src/renderer/components/FilePreview/FilePreviewActionsSheet.tsx`
- **Every composer setting on a phone:** `<ComposerOptionsSheet>` in `src/renderer/components/InputArea/components/ComposerOptionsSheet.tsx`
- **A keyboard-only hint (chord badge, keycap, arrow-key legend):** put `data-shortcut-hint` on it; one rule in `src/renderer/index.css` hides it on a phone (never gate it on `usePhoneLayout()` in JSX)
- **A control whose only pointer path is a double-click:** give it a single-tap path under `isCoarsePointer()`; iOS never dispatches `dblclick`
- **A tab chip on a phone:** mark the label `data-tab-label` and the close button `data-tab-close`; the phone rules key on those attributes
- **A modal that fills a phone:** nothing to write: pass a `resizeKey` and the phone stylesheet makes the modal full-screen
- **Swipe down to close a modal on a phone:** `useLayerSwipeDismiss()` in `src/renderer/hooks/ui/useLayerSwipeDismiss.ts`; a panning surface opts out with `data-no-swipe-dismiss`
- **Clearing the iOS status bar in a home-screen web app:** `--maestro-top-inset` and `--maestro-viewport-height` in `src/renderer/index.css`, fed by `installStandaloneStatusBarInset()` in `src/renderer/utils/standaloneStatusBar.ts`

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

Rows are in picker order (alphabetical by display name); the registry is `AGENT_PICKER_META` in `src/shared/agentMetadata.ts`. `terminal` is internal and never offered.

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
│   ├── index.ts            # Entry point, IPC handlers
│   ├── preload/            # Secure IPC bridge (one module per namespace)
│   ├── process-manager.ts  # Process spawning (PTY + child_process)
│   ├── agent-*.ts          # Agent detection, capabilities, session storage
│   ├── cue/               # Maestro Cue event-driven automation engine
│   ├── parsers/            # Per-agent output parsers + error patterns
│   ├── storage/            # Per-agent session storage implementations
│   ├── ipc/handlers/       # IPC handler modules (stats, git, playbooks, cue, etc.)
│   └── utils/              # Utilities (execFile, ssh-spawn-wrapper, etc.)
│
├── renderer/               # React frontend (desktop)
│   ├── App.tsx            # Main coordinator
│   ├── components/        # UI components
│   ├── hooks/             # Custom React hooks
│   ├── services/          # IPC wrappers (git.ts, process.ts)
│   ├── constants/         # Themes, shortcuts, priorities
│   └── contexts/          # Context providers (LayerStack, etc.)
│
├── web-desktop/            # Browser build of the renderer (WebSocket IPC bridge)
│
├── web/                    # PWA assets (public/) + service worker; rest is legacy dead code
│
├── cli/                    # CLI tooling for batch automation
│   ├── commands/          # CLI command implementations
│   └── services/          # Playbook and batch processing
│
├── prompts/                # System prompts (editable .md files)
│
├── shared/                 # Shared types and utilities
│
└── docs/                   # Mintlify documentation (docs.runmaestro.ai)
```

---

## Key Files for Common Tasks

| Task                                | Primary Files                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler                     | `src/main/index.ts`, `src/main/preload/` (one module per namespace)                                                                                                           |
| Add UI component                    | `src/renderer/components/`                                                                                                                                                    |
| Add browser/mobile touch affordance | `src/renderer/components/`, `src/renderer/utils/touch.ts`, `src/renderer/hooks/utils/` (gate on `isCoarsePointer()`; PWA assets in `src/web/public/`)                         |
| Add keyboard shortcut               | `src/renderer/constants/shortcuts.ts`, `App.tsx`                                                                                                                              |
| Add theme                           | `src/renderer/constants/themes.ts`                                                                                                                                            |
| Add modal                           | Component + `src/renderer/constants/modalPriorities.ts`                                                                                                                       |
| Add tab overlay menu                | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]]                                                                                                                  |
| Add setting                         | `src/shared/settingsMetadata.ts`, `src/renderer/stores/settingsStore.ts`, `searchableSettings.ts` + a `data-setting-id` wrapper (checklist: [[CLAUDE-SETTINGS.md]] §9)        |
| Add template variable               | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts`                                                                                                  |
| Modify system prompts               | `src/prompts/*.md` (wizard, Auto Run, etc.) or edit via **Maestro Prompts** tab in Settings                                                                                   |
| Customize prompts                   | Use **Maestro Prompts** tab in Settings, or edit `userData/core-prompts-customizations.json`                                                                                  |
| Add new prompt                      | `src/prompts/*.md`, `src/shared/promptDefinitions.ts` (add to `CORE_PROMPTS` array and `PROMPT_IDS`)                                                                          |
| Add Spec-Kit command                | `src/prompts/speckit/`, `src/main/speckit-manager.ts`                                                                                                                         |
| Add OpenSpec command                | `src/prompts/openspec/`, `src/main/openspec-manager.ts`                                                                                                                       |
| Add CLI command                     | `src/cli/commands/`, `src/cli/index.ts`                                                                                                                                       |
| Add new agent                       | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md) |
| Add agent output parser             | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                              |
| Add parquet viewer feature          | `src/renderer/components/ParquetViewer/` (UI), `src/main/parquet/` (query engine), `src/shared/parquet/` (filter language + wire types)                                       |
| Add agent session storage           | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                |
| Add agent error patterns            | `src/shared/agentErrorPatterns.ts`                                                                                                                                            |
| Add agent context window            | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                         |
| Add playbook feature                | `src/cli/services/playbooks.ts`                                                                                                                                               |
| Add marketplace playbook            | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                   |
| Playbook import/export              | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                               |
| Modify wizard flow                  | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                  |
| Add tour step                       | `src/renderer/components/Wizard/tour/tourSteps.tsx`                                                                                                                           |
| Modify file linking                 | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                         |
| Add documentation page              | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                    |
| Add documentation screenshot        | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                  |
| MCP server integration              | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                  |
| Add stats/analytics feature         | `src/main/stats/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                |
| Add Usage Dashboard chart           | `src/renderer/components/UsageDashboard/`                                                                                                                                     |
| Add Document Graph feature          | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                            |
| Add colorblind palette              | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                |
| Add performance metrics             | `src/shared/performance-metrics.ts`                                                                                                                                           |
| Capture/analyze perf trace          | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces             |
| Add power management                | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                |
| Spawn agent with SSH support        | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                     |
| Modify file preview tabs            | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                              |
| Add Director's Notes feature        | `src/renderer/components/DirectorNotes/`, `src/shared/directorNotesNarrative.ts`, `src/shared/directorNotesGrouping.ts`, `src/main/ipc/handlers/director-notes.ts`            |
| Add Encore Feature                  | `src/renderer/types/index.ts` (flag), `src/shared/plugins/first-party.ts` (tile + settings body), gating checklist in [[CLAUDE-PATTERNS.md]] §12                              |
| Modify history components           | `src/renderer/components/History/`                                                                                                                                            |
| Modify history activity graph       | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`            |
| Modify Auto Run Thought Stream      | `src/renderer/stores/thoughtStreamStore.ts`, `ThoughtStreamPanel.tsx`, `useThoughtStream{Capture,Tool}Listener.ts`, `src/renderer/utils/toolActivityLabel.ts`                 |
| Add Cue event type                  | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                     |
| Add Cue template variable           | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                             |
| Modify Cue modal                    | `src/renderer/components/CueModal/`                                                                                                                                           |
| Configure Cue engine                | `src/main/cue/cue-engine.ts`, `src/main/ipc/handlers/cue.ts`                                                                                                                  |
| Add terminal feature                | `src/renderer/components/XTerminal.tsx`, `src/renderer/components/TerminalView.tsx`                                                                                           |
| Modify terminal tabs                | `src/renderer/utils/terminalTabHelpers.ts`, `src/renderer/stores/tabStore.ts`                                                                                                 |

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

If a modal's primary purpose is _clicking_ (buttons, tabs, rows, cards, graph nodes, chips, toggles), put `select-none` on its root, and `select-text` on any nested content-driven subtree (detail views, code, log bodies, paths, AI output, error messages). Skip the rule on modals whose purpose is reading or editing text. Decide when you add the modal; retrofitting means hunting down every nested view. Rationale: [UI-PATTERNS.md → Text Selection in Modals](docs/agent-guides/UI-PATTERNS.md#text-selection-in-modals).

### Error Handling & Sentry

Field data from production crashes is how bugs get found, so do NOT swallow errors.

- Let unexpected exceptions bubble up. A `try` / `catch` that only calls `console.error` hides the bug from Sentry.
- Handle expected, recoverable failures explicitly (a network error, a missing file), and rethrow everything else.
- Report with context through `captureException()` / `captureMessage()` in `src/main/utils/sentry.ts`.

Code examples: [[CLAUDE-PATTERNS.md]] §15.

### SSH Remote Execution Awareness

Any feature that spawns an agent process (context grooming, group chat, batch operations, a new CLI spawn site) MUST support SSH remote execution. Without the wrapping, the agent runs locally against the remote's path.

- Resolve the target BEFORE any side effect with `buildAgentLaunchPlan()` / `resolveSshLaunchTarget()` in `src/shared/maestro-lib/launch/`, or wrap the spawn with `wrapSpawnWithSsh()` from `src/main/utils/ssh-spawn-wrapper.ts`.
- **Fail loudly, never run locally.** `wrapSpawnWithSsh()` does NOT throw when the remote cannot be resolved: it returns the local config with `sshRemoteUsed: null`. Check it and throw `sshUnresolvedRemoteMessage(sshConfig)`.
- Use the agent's own type (never hardcode `claude-code`), its `binaryName` on the remote, and pass `customPath`, `customArgs`, `customEnvVars`, `customModel`, and `customEffort` through.

Full pattern, the two SSH identifiers, and CLI parity: [[CLAUDE-PATTERNS.md]] §10.

---

## Debugging

### Root Cause Verification (Before Implementing Fixes)

Initial hypotheses are often wrong. Before implementing any fix:

1. **IPC issues:** Verify the handler is registered in `src/main/index.ts` before modifying caller code.
2. **UI rendering bugs:** Check CSS (overflow, z-index, position) on the element AND its parent containers before changing component logic.
3. **State not updating:** Trace the data flow from source to consumer; check whether the setter is called or the re-render is suppressed.
4. **Feature not working:** Verify the code path executes (add a temporary `console.log`, check, remove).

Symptom checklists (focus, settings persistence, modal Escape, clipped overlays): [[CLAUDE-PATTERNS.md]] §11.

### CDP / Browser-Automation Scripts Are Ephemeral

One-off `scripts/cdp-*.mjs` harnesses that drive the running app are throwaway scaffolding: delete them when the investigation is done and never commit them (if one slips in, remove it with a forward `git rm` commit). The dev server often runs with `DISABLE_HMR=1`, so live edits will NOT hot-reload; verify the served module contains your change (`curl localhost:17173/<module>` and grep) before trusting a CDP screenshot.

---

## MCP Server

Maestro hosts an MCP server at `https://docs.runmaestro.ai/mcp` with one tool, `SearchMaestro`, that searches the documentation, code examples, and API references. Connect it with `{ "mcpServers": { "maestro": { "url": "https://docs.runmaestro.ai/mcp" } } }`.

See [MCP Server documentation](https://docs.runmaestro.ai/mcp-server) for full details.
