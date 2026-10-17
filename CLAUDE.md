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
| [[CLAUDE-FEATURES.md]]                     | Editing the Usage Dashboard, Document Graph, or Delegation Graph                                                                                                    |
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
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** everything in `src/shared/duration.ts`: `humanizeDuration(ms, opts)` plus its presets (never another `Math.floor(ms / 86400000)` ladder)
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts; perf traces only)
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format a calendar day:** `formatCalendarDay()` in `src/shared/formatters.ts`
- **Local calendar day keys:** `toLocalYmd()`, `parseLocalYmd()`, `addLocalDays()` in `src/shared/localDay.ts`
- **Format an hour of day:** `formatHourOfDay()` in `src/shared/formatters.ts`
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **The text of a group's pill:** `groupBadgeLabel(group)`, `GROUP_SHORT_LABEL_MAX_LENGTH` in `src/shared/formatters.ts`; `<GroupPill>` in `src/renderer/components/ui/GroupPill.tsx`; `withGroupShortLabel()` in `src/shared/groupAgentDefaults.ts` (never `abbreviateGroupName(group.name)` directly)
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
- **Reading standard input in a CLI verb:** `readStdinText()`, `readStdinIfReady(timeoutMs?)`, `isStdinTerminal()` in `src/cli/services/stdin.ts` (never a bare `fs.readFileSync(0)` for input nobody was told to pipe)
- **The per-agent setting flags of a CLI verb (`--model`, `--env`, `--tier`, ...):** `buildConfigPatch()`, `buildSshPatch()`, `hasSshFlags()` in `src/cli/services/agent-setting-flags.ts`; peers in `peer-flags.ts`
- **A yes/no question on the terminal in a CLI verb:** `confirmOnTerminal(question)`, `canPrompt()` in `src/cli/utils/confirm.ts` (asks only when both ends are a terminal; a script passes `--yes`)
- **A bridge round trip in a CLI verb (send, read the reply, exit with the right code):** `sendBridgeCommand()`, `failCommand(message, json?, code?)` in `src/cli/services/session-command.ts` (never another private `fail()` / `send()`)
- **An image file the user named on the CLI:** `readCliImageFile(input, maxBytes)` in `src/cli/utils/imageFiles.ts`
- **Classifying a file by extension:** `getFileCategory()`, `isPreviewableFile()`, `matchesFileCategory()`, `getFileExtension()` in `src/shared/fileCategories.ts`
- **Reading a zip from disk:** `readZipArchive()`, `extractZipTo()`, `isUnsafeZipEntryName()` in `src/main/utils/zip-archive.ts` (never `adm-zip`)
- **Guarding a serialized JSON payload before it overwrites a file:** `assertSerializedJsonIsSafe(serialized, target)` in `src/shared/jsonUtils.ts`
- **Writing a JSON file atomically from synchronous code:** `atomicWriteJsonSync(filePath, value, opts?)` in `src/shared/atomicJsonSync.ts` (the async twin is `atomicWriteJson()` in `src/main/utils/atomic-json-store.ts`)
- **Deterministic JSON (same value, same text):** `canonicalJson(value)` in `src/shared/canonicalJson.ts` (never hash or compare `JSON.stringify` output)
- **Redacting secrets from text you persist or show:** `redactSecrets(text, opts?)`, `passesLuhn()` in `src/shared/redactSecrets.ts`
- **Strip ANSI / collapse progress overwrites:** `stripAnsiCodes()`, `processCarriageReturns()` in `src/shared/stringUtils.ts`
- **Matching error patterns against an agent's exit output:** `stripJsonEventLines()` in `src/shared/agentErrorPatterns.ts`
- **Reading what a TUI painted from a raw capture:** `replayTerminalScreen(raw)`, `capturedAlternateScreen(raw)` in `src/maestro-p/screen-replay.ts`
- **Loading a LOCAL file tree:** `walkLocalFileTree()` in `src/main/utils/file-tree-walk.ts`, wrapped by `loadFileTree()` in `src/renderer/utils/fileExplorer.ts`
- **Telling the Files panel a file appeared or vanished:** `requestFileTreeRefresh(sessionId)` in `src/renderer/utils/fileTreeRefresh.ts` (renderer) and `nudgeFileTreeForPaths(paths)` in `src/cli/services/file-tree-refresh.ts` (CLI)
- **Delete the file the user is previewing:** `requestFileDeletion()` in `src/renderer/services/fileDeletion.ts`

#### Main process: stores, persistence, platform

- **Maestro's data directory, without Electron:** `resolveUserDataDir(options?)`, `assertUserDataDirExists(dir)` in `src/shared/userDataDir.ts`
- **Where the synced stores live (custom Storage Location):** `resolveSyncDir(userDataDir)`, `isValidSyncPath()`, `BOOTSTRAP_STORE_FILE` in `src/shared/syncPath.ts`; the CLI's `getSyncDir()` in `src/cli/services/storage.ts`
- **Deferred main-process store persistence:** `deferStoreWrites()` in `src/main/stores/deferred-writes.ts`, `flushPendingSessionWrites()` in `src/main/stores/instances.ts`
- **Rewriting a large `{ key: [...] }` JSON store file:** `serializeWithMemoizedArray(data, memoKey)` in `src/shared/memoizedJsonSerialize.ts`
- **Recovering from a store file that is not JSON:** `createStoreDeserializer()`, `corruptStorePath()` in `src/main/stores/corrupt-store-recovery.ts` (never `clearInvalidConfig`)
- **Sealing a file with the key the OS holds for the app:** `safeStorageSeal(safeStorage)`, `obscuringSeal()`, `SealProvider`, `SafeStorageLike` in `src/main/utils/safe-storage-seal.ts`
- **Proving a sealed file is the newest one (rollback and deletion):** `createKeyringAnchor(service, account)`, `AnchorStore`, `keyringAnchor()`, `noAnchor()` in `src/main/utils/keyring-anchor.ts`
- **A per-device state file that holds a secret:** `createPrivateStateFile()`, `sealSecret()`, `unsealSecret()`, `isStoredSecret()`, `SealedSecretError` in `src/main/utils/sealed-state-file.ts`; `SecretStorage`, `describeSecretStorage()` in `src/shared/secretStorage.ts`
- **Writing a Claude session's origin record:** `setClaudeSessionOrigin()`, `mergeClaudeSessionOrigin()` in `src/main/storage/claude-session-origins.ts`
- **Serializing async work on one entity:** `createKeyedWriteQueue()` in `src/shared/keyedWriteQueue.ts` (main imports it via `src/main/utils/atomic-json-store.ts`)
- **Serializing a read-modify-write across PROCESSES:** `withDirectoryLock(lockDir, fn, opts?)`, `sleepSync(ms)` in `src/shared/directoryLock.ts` (for a file the app AND `maestro-cli` write; `createKeyedWriteQueue()` covers one process only)
- **Capping stored tool output:** `compactToolOutput()`, `compactSessionToolOutputs()` in `src/shared/toolOutput.ts`
- **Merging browser-deferred conversations:** `projectWebSession()`, `readDeferredContent()`, `mergeDeferredSessionContent()` in `src/main/stores/deferred-session-content.ts`, over `mergeDeferredItems()` in `src/shared/deferredSessionContent.ts`
- **HTTP request from the main process:** `fetchWithTimeout()`, `isFetchTimeoutError()` in `src/main/utils/fetchWithTimeout.ts` (never a bare `fetch()`)
- **Choosing a port for a local server:** `pickFreePort(host)`, `probePort(port, host)`, `isTcpPort()` in `src/main/utils/tcp-port.ts` (choose once and persist; never move a persisted port)
- **A size-capped log file for a supervised process:** `openCappedLogFile(path, { maxBytes?, onError? })` in `src/main/utils/capped-log-file.ts`
- **Running and reaching the Maestro model server (`llama-server`):** `startModelServer()`, `stopModelServer()`, `getModelServerStatus()`, `ensureModelServerFor(modelId)` in `src/main/local-models/server/supervisor.ts`; `getModelServerReport()`, `installModelServerEngine()` in `server/service.ts`
- **Which `llama-server` build a platform gets:** `selectServerBuild(platform, arch, choice)`, `availableServerBuildChoices()`, `LLAMA_SERVER_RELEASE` in `src/shared/local-models/server-engine.ts` (never a second platform table)
- **What the model server keeps between launches (port, bind, key):** `readModelServerConfig()`, `ensureModelServerPort()`, `writeModelServerSettings()`, `ensureModelServerKey()`, `rotateModelServerKey()` in `src/main/local-models/server/config-store.ts`
- **What the model server is started with (presets file, command line, environment):** `collectServerModels()`, `renderModelServerPresets()`, `buildModelServerArgs()`, `modelServerEnvironment()`, `serverContextSize()` in `src/main/local-models/server/presets.ts`
- **Where the model server's engine is installed and whether it is really there:** `installedServerBinary()`, `isServerEngineInstalled()`, `isServerEngineStale()`, `readServerEngineManifest()`, `removeServerEngine()` in `src/main/local-models/server/engine-store.ts`
- **What the installed engine computes on (GPU or CPU):** `classifyAcceleratorProbe()`, `parseListDevices()`, `acceleratorLabel()`, `serverAcceleratorProblemMessage()` in `src/shared/local-models/server-accelerator.ts`; `checkServerAccelerator()`, `recheckServerAccelerator()` in `server/accelerator.ts`
- **The model server's shared vocabulary (bind modes, status, report, endpoint reference):** `MODEL_SERVER_BINDS`, `ModelServerStatus`, `ModelServerReport`, `modelServerBaseUrl()`, `modelServerEndpoint()`, `MODEL_SERVER_ENDPOINT_ID` in `src/shared/local-models/model-server.ts`
- **Whether a model fits this computer (Fits / Tight / Too large):** `modelFit()`, `describeHardwareProfile()`, `hardwareProfileStat()`, `hardwareFitCaveat()`, `MODEL_FIT_LABELS` in `src/shared/local-models/model-fit.ts`; `resolveHardwareProfile()` in `src/main/local-models/hardware.ts`
- **Grouping and badging models in the Library:** `groupLocalModelsForLibrary()`, `localModelLibrarySection()`, `localModelRoleBadges()`, `LOCAL_MODEL_LIBRARY_SECTIONS`, `CLOUD_ONLY_NOTE` in `src/shared/local-models/library.ts`
- **The model server on a renderer surface:** `useModelServer()`, `MODEL_SERVER_POLL_MS` in `src/renderer/hooks/localModels/useModelServer.ts` (report, install progress and the card's actions; mounting starts nothing)
- **Naming where a model choice lives in Settings (in a message or error):** `modelsSettingsLocation(panel, section?)`, `taskAssignmentLocation(taskId)`, `parseModelsSettingsSubTab()`, `MODELS_SETTINGS_PANELS` in `src/shared/local-models/settings-location.ts`
- **Cards of the Models settings tab:** `<CardButton>`, `<CardRowTitle>`, `<CardWarning>` in `src/renderer/components/Settings/tabs/LocalModelsTab/CardButton.tsx` and `CardParts.tsx`
- **A model the user adds from Hugging Face:** `previewHuggingFaceModel()`, `addHuggingFaceModel()`, `removeUserLocalModel()` in `src/main/local-models/user-models.ts`; `userLocalModelEntry()`, `parseUserLocalModels()` in `src/shared/local-models/user-models.ts`; `allLocalModels()` in `model-catalog.ts`
- **Where model files are downloaded from (a Hugging Face mirror):** `resolveDownloadBase()`, `rebaseSourceUrl()`, `downloadBaseProblem()` in `src/shared/local-models/download-base.ts`; `currentDownloadBase()` in `src/main/local-models/download-base.ts`
- **A git query the UI polls in the background:** `execGitReadOnly()`, `isGitTimeout()`, `READ_ONLY_GIT_TIMEOUT_MS` in `src/main/utils/remote-git.ts`
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts`; renderer-only `isWindowsPlatform()` and siblings in `src/renderer/utils/platformUtils.ts` (never `process.platform` in the renderer)
- **Encore Feature flags and their defaults:** `ENCORE_FEATURE_DEFAULTS`, `resolveEncoreFeatures(raw)` in `src/shared/encoreFeatureDefaults.ts`
- **Filing GitHub feedback (check gh, search, +1, submit):** `submitFeedbackConversation()`, `searchFeedbackIssues()` in `src/main/feedback/index.ts`

#### Spawning and stopping agents (process, SSH, env, prompts)

- **Launching an agent (env layers, prompt delivery, SSH target):** `buildAgentLaunchPlan()` in `src/shared/maestro-lib/launch/launch-plan.ts` (env in `launch/env.ts`, prompt in `launch/prompt-delivery.ts`, SSH target in `launch/ssh-remote-resolver.ts`)
- **Starting, streaming, stopping and resuming an agent turn:** `startTurn()` in `src/shared/maestro-lib/run/start-turn.ts`, `runTurn()` / `runToCompletion()` in `src/shared/maestro-lib/run/run-to-completion.ts`, `planSessionTurn()` in `src/shared/maestro-lib/run/session.ts`
- **Stopping a process (interrupt, terminate, kill the tree):** `stopProcess(target, options)` in `src/shared/maestro-lib/control/termination.ts` (never a bare `kill('SIGTERM')` + `setTimeout`)
- **Whether a Claude turn runs the maestro-p TUI or `claude --print`:** `resolveClaudeSpawnModeCore()`, `applyClaudeSpawnDecision()` in `src/shared/maestro-lib/launch/interactive-mode.ts`
- **Timing out a supervised agent process:** `createIdleWatchdog()` in `src/main/utils/idle-watchdog.ts`, events in `src/main/utils/agent-liveness.ts` (the budget is silence, not wall clock)
- **A one-shot answer from a cheap model (no tab, no tools):** `window.maestro.context.groomContext()` with `cheapTurn` / `readOnly` / `disableTools` / `timeoutMs`, over `groomContext()` in `src/main/utils/context-groomer.ts`
- **Whether a working directory can be spawned into:** `unusableCwdReason(cwd)` in `src/main/process-manager/utils/spawnCwd.ts`
- **Whether an agent is working right now (main process):** `isAgentBusy()`, `isAiTabProcessActive()` in `src/main/utils/agent-busy.ts` (never the persisted `state`)
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
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
- **Parsing a Codex assistant directive:** `parseCodexDirective()`, `findCodexDirectives()`, `KNOWN_CODEX_DIRECTIVES` in `src/shared/codexDirectives.ts`
- **Acting on a clicked Codex followup chip:** `requestCodexFollowup()`, `resolveCodexFollowup()`, `codexDirectivesLiveForSource()` in `src/renderer/services/codexFollowup.ts`, drawn by `FollowupChip`
- **Changing an agent's provider:** `switchAgentProvider()`, `switchTabProvider()`, `resolveTurnProvider()` in `src/shared/maestro-lib/agents/providerSwap.ts`

#### Agents (renderer state and navigation)

- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`; `useActiveSession()` hook in `src/renderer/hooks/session/useActiveSession.ts`
- **Session mutation:** `updateSessionWith()`, `updateAiTab()`, `updateFileTab()`, `updateBrowserTab()` in `src/renderer/stores/sessionStore.ts` (never `setSessions(prev => prev.map(...))` for one agent or tab)
- **Which agent this client is looking at:** `persistActiveSessionId()`, `readPersistedActiveSessionId()` in `src/renderer/utils/activeSessionPersistence.ts` (never `sessions.getActiveSessionId()` directly)
- **Which client this page is, across a reload:** `getClientInstanceId()` / `isReloadedClientInstance()` in `src/renderer/utils/clientInstance.ts`
- **Telling the other clients an agent appeared or went away:** `sessions:lifecycleSync`, emitted in `src/main/ipc/handlers/persistence.ts`, applied by `useSessionLifecycleSync` in `src/renderer/hooks/session/useSessionLifecycleSync.ts`
- **Moving an agent to another directory:** `withWorkingDirectory()`, `workingDirectoryChangeBlocker()`, `isSameDirectory()` in `src/renderer/utils/agentWorkingDirectory.ts`
- **Per-agent git actions:** `useGitAgentActions(session)` in `src/renderer/hooks/git/useGitAgentActions.ts`
- **Whether a PR is being opened right now:** `usePRCreationActive()`, `startPRCreation()` in `src/renderer/stores/prCreationStore.ts`
- **Taking the user to an agent:** `jumpToAgent()`, `revealAgentInSidebar()`, `openAgentSettings(session, { tab? })` in `src/renderer/services/agentNavigation.ts`
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
- **The label above a form field:** `<FormFieldLabel theme htmlFor?>` in `src/renderer/components/ui/FormFieldLabel.tsx`
- **The `src` of a conversation image:** `displayImageSrc(src)` in `src/renderer/utils/sessionImageSrc.ts`, over `src/shared/sessionImageRefs.ts`; a chip wraps the RESULT in `sessionImageThumbnailSrc()`
- **Referencing / thumbnailing a pasted transcript image:** `isSessionImageRef()`, `sessionImageThumbnailSrc()` in `src/shared/sessionImageRefs.ts`

#### Cross-agent consults

- **Consulting another agent from a message (`@mention`):** `planCrossAgentMentions()`, `dispatchCrossAgentMentions()`, `dispatchCrossAgentMentionsForMessage()` in `src/renderer/services/crossAgentMentions.ts` (plan at submit, fire when the item is the agent's turn)
- **Holding a mentioning turn open until its consult replies:** `holdTurnForConsults()`, `settleConsultHold()`, `withConsultPendingNote()` in `src/renderer/services/crossAgentConsultHold.ts`
- **When a mention runs (parallel / consult first / hand-off):** `inferMentionTiming()` in `src/shared/crossAgentContext.ts`; `armMentionHandoff()`, `releaseMentionHandoff()`, `dropMentionHandoffs()` in `src/renderer/services/crossAgentHandoff.ts`
- **An agent asking another agent (`maestro-cli ask`):** `runCrossAgentAsk()` in `src/renderer/services/crossAgentAsk.ts` (a question is `ask`, never `dispatch`)
- **Marking an agent's own hand-off in its transcript (`dispatch` / `ask` from its shell):** `readCallerIdentity()`, `callerMessageFields()`, `isSelfDispatch()` in `src/shared/agentDelegation.ts`; `recordAgentDelegation()`, `settleAgentDelegation()` in `src/renderer/services/agentDelegation.ts`
- **The consultation budget setting (peer consults and delegations per user message):** `MAX_CONSULTATIONS_PER_TURN_SETTING`, `DEFAULT_MAX_CONSULTATIONS_PER_TURN`, `normalizeMaxConsultationsPerTurn()` in `src/shared/consultBudget.ts` (`0` is a real value; never `|| 25`)
- **Spending a consult chain's budget (the shared counter):** `spendConsultBudget()`, `readConsultBudgetSpent()`, `sweepExpiredChains()`, `newConsultChainId()` in `src/main/peer-consults/consult-budget.ts`; `isConsultChainId()` in `src/shared/consultBudget.ts` (fails closed; tests pass `dataDir`)
- **Which consult chain a spawned agent is in (`MAESTRO_CONSULT_CHAIN` / `MAESTRO_CONSULT_DEPTH`):** `readConsultChainEnv()`, `buildConsultChainEnv()`, `childConsultChain()`, `parseConsultChain()`, `withoutConsultChainEnv()`, `ConsultChain` in `src/shared/consultBudget.ts`
- **Admitting a consult or delegation (spend, refuse, place the target):** `admitConsult()` in `src/main/peer-consults/consult-budget.ts`; `admitCliConsult()` in `src/cli/services/consult-budget-guard.ts`; `describeConsultBudgetRefusal()` in `src/shared/consultBudget.ts`; `SpawnAgentOptions.consultChain`
- **Telling an agent what is left of its consult budget (the Peer Agents sentence):** `readConsultBudgetStatus(turn, options?)` in `src/main/peer-consults/consult-budget.ts`; `ConsultBudgetStatus`, `remainingConsultBudget()` in `src/shared/consultBudget.ts`; `PeerPromptOptions.budget` in `src/shared/peerAgents.ts`
- **The fleet's peer relationships as one directed graph (the Delegation Graph):** `buildDelegationGraph(scope, sessions)`, `edgeBetween()`, `isMutual()`, `delegationEdgeId()`, `connectedAgentIds()`, `delegationGraphStats()` in `src/shared/delegationGraph.ts` (calls `resolvePeerRoster()`; never restate precedence)
- **Where an agent sits on the Delegation Graph (saved per scope):** `useDelegationGraphLayout(scope)` in `src/renderer/components/DelegationGraph/useDelegationGraphLayout.ts`; `scopeStorageKey()`, `mergeSavedPositions()`, `prunePositions()` in `src/shared/delegationGraphLayout.ts` (never `saveNodePositions()`)
- **The Delegation Graph's layout names and edge line:** `nextDelegationLayout()`, `isDelegationLayoutType()` in `src/renderer/components/DelegationGraph/delegationLayoutTypes.ts`; `graphEdgeGeometry()` in `src/renderer/utils/graphEdgeGeometry.ts`
- **Drawing and arranging the Delegation Graph:** `<DelegationGraphModal>`, `<DelegationGraphView>`, `useDelegationGraphModel(scope)`, `arrangeDelegationGraph()`, `computeDelegationLayout()` in `src/renderer/components/DelegationGraph/`; `delegationRosterEquality()` in `src/renderer/stores/sessionEquality.ts`
- **Writing a relationship from the Delegation Graph:** `writeDelegationEdge()`, `deleteDelegationEdge()` in `src/renderer/services/delegationGraphEdits.ts`; `peerAgentEditsProblem()`, `resolveGrantedPeer()` in `src/shared/peerAgents.ts`; `<DelegationEdgeEditor>` in `src/renderer/components/DelegationGraph/`
- **Running a consult (prompt, budgets, completion, Stop):** `createConsultService()` in `src/shared/maestro-lib/agents/consult.ts`
- **Which agents a message mentions, and the `@` picker's rules:** `planMentions()`, `resolveMentionedTargetSessionIds()`, `buildAgentMentionSuggestions()` in `src/shared/maestro-lib/mentions/roster.ts`

#### Auto Run, Cue, Group Chat, Director's Notes

- **Model tier / effort level (`'low' | 'medium' | 'high'`):** `resolveTierModel()`, `resolveEffortLevel()`, `cheapTurnSettings()`, `cheapResumeTurnSettings()` in `src/shared/modelTiers.ts`; `findActiveModelHint()` in `src/shared/autorunModelHints.ts`; `resolveTurnSettings()` in `src/shared/autorunTurnSettings.ts`
- **Which target a tier launches on (agent, harness default, built-in):** `resolveTierTarget()`, `tierTargetLaunch()`, `tierLaunchKey()` in `src/shared/modelTiers.ts`; `turnRunOnTarget()` in `src/shared/autorunTurnSettings.ts`
- **Showing and editing tier targets:** `agentTierRows()`, `tierRowRecord()`, `parseTierTargetsEdit()`, `tierPillLabel()`, `suggestHarnessTierDefaults()`, `staleTierModels()` in `src/shared/modelTiers.ts`; `<TierTargetsField>` in `src/renderer/components/shared/TierTargetsField.tsx`
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
- **What a toast click does:** `ToastClickAction` + `parseToastClickAction()` in `src/shared/toastClickAction.ts`, dispatched by `dispatchToastClickAction()` in `src/renderer/services/toastClickActions.ts`
- **Toast history / unread state:** `history`, `markNotificationRead()`, `selectUnreadNotificationCount()` in `src/renderer/stores/notificationStore.ts`; `<NotificationCenter>`, `<NotificationCenterHost>` in `src/renderer/components/NotificationCenter.tsx`
- **Center flash (rapid acks):** `notifyCenterFlash()` in `src/renderer/stores/centerFlashStore.ts`; `flashCopiedToClipboard()` in `src/renderer/utils/flashCopiedToClipboard.ts` (momentary acks; never a Toast for clipboard)
- **Keeping toasts off a surface the user works in:** `useToastAvoidZone()`, `toastBottomInset()` in `src/renderer/hooks/ui/useToastAvoidZone.ts`
- **Opening a modal / dashboard by name:** `UI_SURFACES`, `resolveUiSurface()` in `src/shared/uiSurfaces.ts`, dispatched by `openUiSurface()` in `src/renderer/utils/openUiSurface.ts`
- **Whether a modal takes the window over:** `DESTINATION_MODALS`, `registerExternalDestination()` in `src/renderer/stores/modalStore.ts`
- **Opening a modal from inside Settings:** `launchFromSettings(open)` in `src/renderer/utils/launchFromSettings.ts`
- **Tap-vs-hold on a microphone button:** `usePressAndHold()` in `src/renderer/hooks/utils/usePressAndHold.ts`
- **Opening and shutting the voice microphone without ending the session:** `openVoiceMic({ hold? })`, `closeVoiceMic({ send? })`, `setVoiceListenMode()`, `toggleVoiceListenMode()`, `notifyVoiceStartFailed()` in `src/renderer/services/voiceListening.ts`
- **Switching the voice mode (Tab / Agent / Conductor):** `useVoiceModeSwitch()` (`mode`, `switchTo()`, `cycle()`) in `src/renderer/components/ACappella/useVoiceModeSwitch.ts`, over `SWITCHABLE_VOICE_MODES`, `stepSwitchableVoiceMode()`, `switchableVoiceMode()`, `scopeForMode()` in `src/shared/acappella/voice-mode.ts`
- **Marking what holds the voice floor (agent, tab, Conductor):** `<VoiceFloorMark>` in `src/renderer/components/ACappella/VoiceFloorMark.tsx`; `useConductorHoldsFloor()` in `src/renderer/components/ACappella/ConductorVoiceIndicator.tsx`
- **Teaching the wake word a phrase from the user's own recordings:** `runWakeEnrollmentRequest()`, `registerWakeEnrollmentService()`, `WakeEnrollmentService` in `src/main/acappella/wake/wake-enrollment-service.ts`; `trainEnrolledWakeModel()` in `src/main/acappella/wake/wake-trainer.ts`
- **A voice action from outside the app (`maestro-cli voice`):** `runVoiceControlRequest()`, `registerVoiceControlService()` in `src/main/acappella/voice-control-service.ts`; wire contract in `src/shared/acappella/voice-control.ts`; `sendVoiceControl()` in `src/cli/services/voice-control.ts`
- **The A Cappella settings blob as a table (what a writer outside the panels checks against):** `VOICE_SETTING_FIELDS`, `voiceSettingProblem()`, `withAgentWakePhrase()` in `src/shared/acappella/voice-settings-schema.ts`; `nestedSettingProblem()` in `src/shared/settingsMetadata.ts`
- **The wake word's front end (audio to classifier windows):** `WakeFrontEnd`, `loadWakeFrontEndModels()`, `createWakeFeaturizer()` in `src/main/acappella/wake/wake-front-end.ts`; shape constants in `src/main/acappella/wake/wake-features.ts`
- **Cutting a microphone stream into bursts of speech:** `SpeechBurstSegmenter` in `src/main/acappella/audio/speech-burst.ts` (lead-in, cap, one hand-over per burst; do not hand-roll another burst buffer beside a `VoiceActivityDetector`)
- **Reading a WAV file a caller named by path:** `readPcmWavFile()` in `src/main/utils/wav-file.ts` (validated, bounded, 16-bit PCM only; the CLI route for audio that normally comes from a microphone)
- **Chatting with a document:** `sendDocumentChatMessage()` / `resetDocumentChat()` / `popOutDocumentChat()` / `readDocumentChatView()` in `src/renderer/services/documentChat.ts`, bound to the panel by `useDocumentChat()` and drawn by `components/DocumentChat/`
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Whether a surface is the topmost layer:** `useIsTopLayer(priority)` in `src/renderer/hooks/ui/useIsTopLayer.ts`
- **Modal / find-bar ESC pill:** `<EscCloseButton>` in `src/renderer/components/ui/EscCloseButton.tsx`
- **A modal default sized to the screen:** `viewportModalSize({ width, height })` in `src/renderer/utils/modalSizing.ts`
- **Audio/video playback:** media NEVER becomes a tab: `handleOpenFileTab()` in `src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts` diverts it to `useMediaPlaybackStore` and the one `FloatingMediaPlayer`; `file://` links go through `openFileUrl()` in `src/renderer/utils/openFileUrl.ts`
- **Right-click menu on an image:** already app-wide via `<ImageContextMenuHost>` in `src/renderer/components/ImageContextMenuHost.tsx`; opt a surface out with `data-no-image-menu`
- **Saving generated image bytes to disk:** `saveImageDataUrlToDisk()`, `saveImageElementToDisk()`, `saveImageToProject()` in `src/renderer/utils/imageExport.ts`
- **Reading a pasted or dropped image (or any Blob) as a data URL:** `readBlobAsDataUrl()`, `imageFilesIn()`, `downscaleImageDataUrl()` in `src/renderer/utils/imageData.ts`
- **Screenshotting a surface exactly as it is painted:** `window.maestro.shell.capturePage(rect?)` (preload `src/main/preload/system.ts`, handler in `src/main/ipc/handlers/system.ts`)
- **Loading an image for canvas compositing:** `loadImageElement(src)` in `src/renderer/utils/loadImage.ts`
- **Pan and zoom a diagram or image:** `usePanZoom()` in `src/renderer/hooks/ui/usePanZoom.ts`; full-window viewer via `openZoomViewer(element)` in `src/renderer/components/ZoomViewer/zoomViewerStore.ts`
- **Diagram content clipped at the SVG edge:** `expandSvgViewBoxToContent(svg, padding?)` in `src/renderer/utils/svgViewBox.ts`
- **The message of a rejected IPC call:** `ipcErrorMessage(error)` in `src/renderer/utils/ipcErrorMessage.ts` (never show `error.message` raw)

#### Keyboard and shortcuts

- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()`, `formatMetaKey()`, `formatMetaKeyName()`, `formatAltKeyName()` in `src/renderer/utils/shortcutFormatter.ts`; outside the renderer `formatShortcutKeysFor()` in `src/shared/shortcutKeys.ts`
- **Advertising a shortcut next to the control that fires it:** `<ShortcutHint>`, `<ShortcutKeys>`, `shortcutText()`, `shortcutSuffix(keys)` in `src/renderer/components/ui/ShortcutHint.tsx` (also the tab overlay-menu badge)
- **Keyboard-shortcut hint / kbd pill:** `<Keycap>` and `<KeycapHint>` in `src/renderer/components/ui/Keycap.tsx`
- **A system-wide (OS-level) hotkey:** `setNamedGlobalHotkey(id, keys, onPress)`, `keysToAccelerator(keys)` in `src/main/global-hotkey-manager.ts`
- **Whether a chord may be bound at all:** `findReservedShortcutCombo(keys)` in `src/shared/shortcutKeys.ts`
- **Whether a keystroke belongs to a text field (guard before `preventDefault`):** `isTextInputTarget()`, `isTextEntryTarget()` in `src/renderer/utils/messageScrollNavigation.ts`; `isEditingTextTarget()`, `isEditingTextFocused()` in `src/renderer/utils/editableTarget.ts`
- **Hiding a switched-off Encore Feature's shortcut, menu item, or setting:** `availableShortcuts()`, `isShortcutAvailable()`, `SHORTCUT_ENCORE_FLAGS` in `src/renderer/utils/encoreShortcuts.ts`; `requiresEncore` on `SearchableSetting`; `encoreFlag` on a `MenuCommand` in `src/main/app-menu.ts`
- **Hiding a switched-off Encore Feature's prompts and template variables:** `isPromptAvailable()` in `src/shared/promptDefinitions.ts`; `availableTemplateVariables()` in `src/shared/templateVariables.ts`, read through `useAvailableTemplateVariables()` in `src/renderer/hooks/input/useAvailableTemplateVariables.ts`
- **How much of the keyboard the user has mastered:** `collectBoundShortcuts()`, `countUsedBoundShortcuts()` in `src/renderer/constants/keyboardMastery.ts`
- **Arrow-key navigation over a list or grid:** `useListNavigation()` in `src/renderer/hooks/keyboard/useListNavigation.ts`; a grid feeds it `useGridColumnCount()` from `src/renderer/hooks/ui/useGridColumnCount.ts`
- **Bare `+` / `-` / `0` zoom on a surface:** `useScaleShortcuts(control, { enabled })` in `src/renderer/hooks/ui/useScaleShortcuts.ts`
- **Keyboard navigation in a `<DualPaneFileEditor>` list:** built in: Up/Down walk the visible rows, Backspace/Delete raise `onDeleteItem`; pass `autoFocusList`, bump `listFocusToken` after a delete

#### UI components and widgets

- **A spinning loading icon:** `<Spinner>` in `src/renderer/components/ui/Spinner.tsx` (never `animate-spin` on an `<svg>`)
- **Tiny uppercase state chip:** `<MiniBadge>` in `src/renderer/components/ui/MiniBadge.tsx`
- **A labeled action button in a panel header:** `<HeaderActionButton>` in `src/renderer/components/ui/HeaderActionButton.tsx`
- **A text box that narrows a list:** `<FilterInput>` in `src/renderer/components/ui/FilterInput.tsx`
- **Segmented toolbar (sort/filter pill bar):** `<SegmentedControl>` in `src/renderer/components/ui/SegmentedControl.tsx`
- **Tabs across the top of a modal:** `<ModalTabStrip>`, `useModalTabs()`, `useModalTabCycling()`, `tabPanelProps()` in `src/renderer/components/ui/ModalTabStrip.tsx`
- **The agent settings form (tabs and panels):** `buildAgentSettingsTabs()`, `firstTabWithError()`, `AGENT_SETTINGS_FIELD_TAB`, `<AgentProviderSelect>`, `<BrowseFolderButton>`, `<GeneralTab>` / `<ProviderTab>` / `<ModelsTab>` / `<EnvironmentTab>` / `<PeersTab>` / `<SshTab>` in `src/renderer/components/AgentSettings/`
- **The tabs of the agent settings form (ids and labels):** `AGENT_SETTINGS_TAB_IDS`, `AGENT_SETTINGS_TAB_LABELS`, `AgentSettingsTabId` in `src/shared/agentSettingsTabs.ts`; `AGENT_SETTINGS_SURFACE_TABS` in `src/shared/uiSurfaces.ts`
- **A group's defaults for new agents:** `withGroupDefaults()` in `src/shared/groupAgentDefaults.ts`; `buildGroupDefaults()`, `groupDefaultsToForm()` in `src/renderer/components/GroupSettingsModal/groupDefaultsForm.ts` (copy-at-create; never read at spawn)
- **Publishing a group's defaults to its existing agents:** `diffGroupDefaults()`, `applyGroupDefaultsToSession()`, `PUBLISHABLE_KEYS`, `directGroupMembers()` in `src/shared/groupAgentDefaults.ts`; `publishGroupDefaults()`, `undoGroupDefaultsPublish()` in `src/renderer/services/groupDefaultsPublish.ts`
- **Seeding a new agent from its group's defaults:** `resolveGroupDefaultsSeed()`, `groupDefaultsCreateExtras()` in `src/shared/groupAgentDefaults.ts`; `applySeededTokenProxy()` in `src/renderer/services/groupDefaultsPublish.ts`; `<GroupSeedBanner>` in `src/renderer/components/NewInstanceModal/GroupSeedBanner.tsx`
- **Seeding a create from outside the dialog (CLI):** `seedRemoteCreate()`, `seedableGroup()` in `src/renderer/services/groupSeededCreate.ts`; `groupDefaultsCreateFields()`, `GroupSeededCreateReport` in `src/shared/groupAgentDefaults.ts`
- **Reading and describing a group's Group Settings in a CLI verb:** `readGroupSettingsFlags()`, `groupSettingsBlocker()`, `describeGroupSettings()`, `verifyPersistedGroupSettings()` in `src/cli/services/group-settings.ts`
- **Writing a group's Group Settings from outside the dialog (CLI):** `applyRemoteGroupSettings()` in `src/renderer/services/groupSettingsRemote.ts`; `applyGroupDefaultsPatch()` in `src/renderer/components/GroupSettingsModal/groupDefaultsPatch.ts`; `src/shared/groupSettingsUpdate.ts`
- **Writing the group list to disk and waiting for it (before answering a remote caller):** `flushGroupsToDisk(groups)` in `src/renderer/services/groupPersistence.ts`
- **Agent settings the dialog and `update-agent` both write (resilience, auto reset, extra directories, parked env):** `applyAgentConfigExtras()`, `parseAdditionalDirFlag()`, `AGENT_SWITCH_KEYS`, `AGENT_CONFIG_EXTRA_KEYS` in `src/shared/agentConfigExtras.ts`
- **Editing an agent's env vars:** `<AgentEnvVarsSection>` in `src/renderer/components/shared/AgentEnvVarsSection.tsx`; `hideEnvVars` on `<AgentConfigPanel>` when it is mounted elsewhere; `agentEnvVarHandlers()` beside it
- **Editing an agent's peer grants:** `<PeerAgentsSection>` in `src/renderer/components/shared/PeerAgentsSection.tsx`, fed by `usePeerFleet(groupId)` in `src/renderer/hooks/agent/usePeerFleet.ts`; `PeerGrants`, `normalizePeerAgents()`, `PEER_GRANT_LABELS` in `src/shared/peerAgents.ts`
- **Paginating a list already in memory:** `usePagination()` in `src/renderer/hooks/ui/usePagination.ts`, `<Pager>` in `src/renderer/components/ui/Pager.tsx` (not `useHistoryPagination`)
- **Sortable table header:** `<SortableTh>` in `src/renderer/components/ui/SortableTh.tsx` + `useTableSort()` in `src/renderer/hooks/ui/useTableSort.ts`
- **A list of editable `key = value` pairs:** `<KeyValueRows>` in `src/renderer/components/ui/KeyValueRows.tsx`, with `recordToKeyValueRows()` / `keyValueRowsToRecords()` beside it
- **Switching a `key = value` entry off without deleting it:** `splitParkedEntries()` / `setKeysParked()` / `parkedPairKeys()` in `src/shared/parkedRecords.ts`
- **Record view for one table row:** `<RecordDetailModal>` in `src/renderer/components/ui/RecordDetailModal.tsx`
- **A Usage Dashboard panel that fails on its own:** `<PanelErrorNote>` in `src/renderer/components/UsageDashboard/PanelErrorNote.tsx`
- **What the Models tab derives from a `ModelUsage` record:** `summarizeModelUsage()`, `sortModelSources()`, `sortModelTasks()`, `latencyBarRows()`, `routedTierSlices()` in `src/renderer/components/UsageDashboard/ModelUsage/modelUsageView.ts`; `<LatencyBars>`
- **Usage Dashboard card tile:** `<EntityTile>` in `src/renderer/components/UsageDashboard/EntityTile.tsx`
- **Usage Dashboard metric tile:** `<MetricCard>` in `src/renderer/components/UsageDashboard/MetricCard.tsx`
- **Color for the Nth chart series:** `getSeriesColor(index, theme, colorBlindMode?)` in `src/renderer/components/UsageDashboard/chartUtils.ts`
- **A label that must not truncate:** `useOptionalLabelFits(rowRef)`, `useOptionalContentFits(ref, { axis })` in `src/renderer/hooks/ui/useOptionalLabelFits.ts`
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
- **Clickable task checkboxes in rendered markdown:** `toggleTaskCheckboxAtLine()` in `src/renderer/utils/markdownTasks.ts`, `rehypeSourceLine` in `src/renderer/components/Markdown/rehypeSourceLine.ts`, `onTaskToggle` on `createMarkdownComponents()`
- **The Local Models catalog and store (which models exist, where their files are):** `LOCAL_MODEL_CATALOG`, `getLocalModel()`, `isLocalModelId()`, `localModelsForRuntime()` in `src/shared/local-models/model-catalog.ts`; `getStatus()`, `isInstalled()`, `verify()`, `installPathFor()`
- **Making a local model usable, and which tasks may offer it:** `installLocalModel()`, `ensureLocalRuntimeForModel()` in `src/main/local-models/service.ts`; `isLocalModelOfferedForTask()`, `localModelAssignmentCaution()` over `unofferedLocalModels` in `src/shared/local-models/tasks.ts`; `<LocalModelsEnginesCard>`
- **Loading a native runtime for a local model:** `loadLocalRuntime(runtimeId, consumerId)` in `src/main/local-models/runtime/load-runtime.ts`; `registerNativeRuntimeConsumer()` in `src/main/local-models/runtime/runtime-consumers.ts`
- **Calling a user-run model server (Ollama, LM Studio, OpenAI-compatible):** `validateLocalModelEndpoint()`, `parseLocalModelEndpoints()`, `resolveEndpointApiKey()` in `src/shared/local-models/endpoints.ts`; `endpointChat()`, `endpointEmbed()`, `endpointTranscribe()`
- **Whether a Local Models task would run right now:** `resolveTaskReadiness()`, `resolveAllTaskReadiness()` in `src/main/local-models/task-readiness.ts`; `isTaskRunnable()`, `LOCAL_MODEL_TASK_UNREADY_REASONS` in `src/shared/local-models/task-readiness.ts`
- **Generating text on a local model or an endpoint:** `generateText()`, `getLocalTextEngine()` in `src/main/local-models/text-gen.ts` (one shared, idle-unloading llama instance; never call `getLlama()` elsewhere)
- **Which source a Local Models task runs on:** `LOCAL_MODEL_TASKS`, `resolveLocalModelAssignment()`, `parseLocalModelAssignments()`, `localModelAssignmentProblem()`, `withLocalModelAssignment()`, `formatLocalModelAssignmentSpec()` / `parseLocalModelAssignmentSpec()`
- **Naming a Local Models source for a person:** `localModelAssignmentSourceLabel(assignment, endpoints)` in `src/shared/local-models/tasks.ts` (catalog display name, or `<model> on <endpoint name>`; `null` for `off` and `utility-agent`; a task router `source` has the same shape and is labeled through it too)
- **The agent a spawned process belongs to:** `agentIdFromProcessId(processId)` in `src/main/utils/process-ids.ts` (strips `-ai-{tab}`, `-batch-{ts}`, `-synopsis-{ts}` and `-cue-...`; stripping only `-ai-` reads an Auto Run task as an agent that does not exist)
- **An agent's Local Models gateway (per-agent proxy URL):** `agentGatewaySupport()`, `parseGatewayUrl()`, `isLoopbackGatewayUrl()`, `resolveAgentGateway()`, `gatewayEnvVarsFor()`, `parseGatewayUrlEdit()` in `src/shared/local-models/gateway.ts`; applied by `buildAgentLaunchPlan({ gateway })`
- **An agent's Run on target (the model behind its harness):** `resolveRunOnLaunch()`, `agentRunOnSupport()`, `parseRunOnTarget()` in `src/shared/local-models/run-on.ts`; `prepareLaunchRunOn()`, `applyAgentRunOnToSpawn()` in `src/main/local-models/run-on.ts`
- **Setting and testing an agent's Run on target:** `parseRunOnEdit()`, `formatRunOnSpec()` in `src/shared/local-models/run-on.ts`; `readRunOnFlags()` in `src/cli/services/run-on.ts`; `testAgentRunOn()` in `src/main/local-models/run-on-test.ts`; `<RunOnField>`
- **The Maestro token proxy (address, routing, lifecycle):** `TOKEN_PROXY_ROUTES`, `resolveTokenProxyTarget()`, `tokenProxyGatewayUrl()`, `gatewayPointsAtTokenProxy()` in `src/shared/local-models/token-proxy.ts`; `createTokenProxyServer()` in `src/main/local-models/proxy/server.ts`; `syncTokenProxy()`
- **Compressing tool results in a model request (token proxy):** `compressRequestBody(kind, body, options)`, `findToolResultSpans()`, `summarizeToolResult()`, `formatCompressionMarker()` / `parseCompressionMarker()` in `src/main/local-models/proxy/compress.ts`; `compressWithHeuristics()`, `compressJson()`
- **An agent's Maestro token proxy mode (`off | passthrough | compress | compress-early`):** `resolveTokenProxyMode()`, `asTokenProxyMode()`, `asStoredTokenProxyMode()`, `isCompressingTokenProxyMode()`, `TOKEN_PROXY_MODE_DESCRIPTIONS`, `tokenProxyRouteForAgent()`, `tokenProxyAgentGatewayUrl()`
- **What the token proxy carried, saved and shortened:** `recordTokenProxyRequest()`, `proxyRequestFromLog()`, `readTokenProxyUsage()` in `src/main/local-models/proxy/request-stats.ts`; `getTokenProxyReport()`, `readTokenProxyBlock()` in `proxy/service.ts`; table `proxy_requests` via `src/main/stats/proxy-requests.ts`
- **Routing a token proxy request to a background target:** `planBackgroundRoute()`, `withRequestModel()` in `src/main/local-models/proxy/background-route.ts`; `modelIdInTierFamily()` in `src/shared/modelTiers.ts`; `resolveSourceCallTarget()` in `src/main/local-models/run-on.ts`
- **Setting an agent's background requests target:** `parseBackgroundRequestsEdit()`, `backgroundRequestsSupport()`, `buildBackgroundRequestsOptionGroups()` in `src/shared/local-models/background-requests.ts`; `setAgentBackgroundRequests()`, `OFF_TOKEN_PROXY_FIELDS` in `src/renderer/services/agentGateway.ts`
- **A unified diff of two texts already in memory:** `<TextDiff theme before after>` in `src/renderer/components/ui/TextDiff.tsx`, over `buildSyntheticGitDiff()` / `parseGitDiff()` in `src/renderer/utils/gitDiffParser.ts`
- **Rewriting part of a JSON text without re-printing the rest:** `parseJsonSpans()`, `memberOf()`, `stringValue()`, `isNullSpan()`, `spliceSpans()` in `src/main/local-models/proxy/json-spans.ts` (`JSON.parse` + `JSON.stringify` re-spells escapes, reorders integer-like keys and rounds integers past 2^53)
- **Running a housekeeping task on a local model or endpoint:** `runLocalTask()`, `runEmbeddingTask()`, `runClassifierTask()`, `runSpeechToTextTask()`, `runLocalTaskRequest()` in `src/main/local-models/task-router.ts`, over the registry `LOCAL_MODEL_TASKS` in `src/shared/local-models/tasks.ts`
- **Drafting a pull request title and body on a local model:** `draftPullRequest()`, `draftPullRequestRequest()` in `src/main/local-models/git-drafts.ts`; `parsePullRequestDraftReply()`, `formatPullRequestDraftInput()`, `capDraftLines()` in `src/shared/gitDrafts.ts`; `<PullRequestDraftButton>`
- **Suggesting tabs to close, snooze, or wake on a local model:** `suggestTabCleanup()`, `collectTabCleanupTabs()`, `configureTabCleanup()` in `src/main/local-models/tab-cleanup.ts`; `guardTabCleanupSuggestions()`, `tabCleanupProtection()`, `rebindTabCleanupCandidates()`, `selectTabCleanupCandidates()`
- **Writing a Computer History digest (local model or agent):** `normalizeDigestSource()`, `describeDigestWriter()` in `src/shared/computer-history/config.ts`; `createHistoryDigestWriter()` in `src/main/local-models/history-digests.ts`; `renderSegmentForDigest()` in `digestInput.ts`; `<DigestWriterField>`
- **Gating a Cue run on a local model (`gate`):** `resolveCueGateDecision()`, `parseCueGateReply()`, `formatCueGateInput()`, `readCueGateRecord()` in `src/shared/cue/gate.ts`; `evaluateCueGate()` in `src/main/local-models/cue-gate.ts`; applied only in `dispatchSubscription()` (`src/main/cue/cue-dispatch-service.ts`)
- **Setting a Cue gate from any surface:** `<CueGateField>` in `src/renderer/components/CuePipelineEditor/panels/CueGateField.tsx`; `writeCueGateFields()`, `readCueGateSetting()`, `cueGateConditionProblem()`, `parseCueGateOnUnavailable()` in `src/shared/cue/gate.ts`
- **Screening Cue text for prompt injection (`screen_injection`):** `CUE_UNTRUSTED_TEMPLATE_VARIABLES`, `findCueUntrustedTemplateVariables()`, `cueEventCarriesUntrustedText()` in `src/shared/templateVariables.ts`; `resolveCueInjectionScreen()`, `resolveCueInjectionDecision()`, `writeCueInjectionScreenFields()`
- **Closing an AI tab of any agent, the way a click does:** `closeAiTabInSession(sessionId, tabId, endWizard?)` in `src/renderer/services/aiTabClose.ts` (snapshot before close, closed-tab history, wizard handling; do not re-inline the sequence)
- **Naming a snoozed tab from either process:** `snoozedEntryLabel()`, `clampSnoozeLabel()` in `src/shared/snooze.ts` (renderer `getSnoozedTabLabel()` delegates)
- **Telling the user a housekeeping task was skipped (`unavailable`):** `reportLocalTaskUnavailable()`, `clearLocalTaskNotice()` in `src/main/local-models/task-notices.ts` (logs every time, one yellow toast per task and agent; clear on `ok`)
- **A group chat's recent messages for a prompt:** `formatChatHistoryForPrompt(messages, { last, maxContentChars? })` in `src/main/group-chat/group-chat-log.ts`
- **Tokenizing text for an ONNX model:** `loadTokenizer(dir)`, `clearTokenizerCache()`, `padTokenizedRows()` in `src/main/local-models/tokenizer.ts` (truncation and `encodeWindows` keep the special tokens; never slice encoded ids)
- **Running an ONNX encoder model:** `getOnnxEncoderPool()`, `encoderFeeds()` in `src/main/local-models/onnx-encoder.ts` (one idle-unloading session per model; never `InferenceSession.create` an encoder elsewhere)
- **Embedding text for search by meaning:** `embedTexts(source, texts, { mode })` in `src/main/local-models/embeddings.ts` (unit vectors; `mode` picks the trained prefix; reach it through `runEmbeddingTask`)
- **Routing a prompt to a tier and effort by its nearest labeled examples:** `getEmbeddingRouter()` in `src/main/local-models/model-router.ts`; `getModelRoutingCorrectionStore()` in `model-routing-corrections.ts`; `voteModelRoute()`, `normalizeModelRoutingText()` in `src/shared/local-models/model-routing.ts`
- **Deciding how much model one turn needs (`routeTurn`):** `routeTurn()` in `src/main/local-models/route-turn.ts`; `modelRouterKind()`, `modelRoutingSystemOneRequest()`, `MODEL_ROUTING_TIMEOUT_MS` in `src/shared/local-models/model-routing-task.ts`; `routeTurnRequest()` for another process
- **A turn sent on the Auto model (`auto`):** `isAutoModel()`, `ownModel()` in `src/shared/autoModel.ts`; `resolveAutoTurn()`, `autoModelChoice()`, `autoTurnLabel()` in `src/shared/autoTurn.ts`; `settleAutoTurn()`, `routeQueuedAutoItem()` in `src/renderer/services/autoTurn.ts`; `useAutoModelChoice()`
- **What a turn's stats row says about its model:** `turnModelStatsFields({ runOn, auto })` in `src/shared/autoTurn.ts`; `turnRunOnSource()`, `AITab.turnRunOnSource` in `src/renderer/utils/providerTabSessions.ts`; `SpawnAgentOptions.autoStamp`
- **What every model other than a provider's own did in a range (the Models tab's read):** `readModelUsage(range)` in `src/main/local-models/model-usage.ts`, over `getModelUsage()` in `src/main/stats/model-usage.ts`; `describeModelUsageSource()`, `ModelUsage` in `src/shared/local-models/model-usage.ts`
- **Scanning content for secrets before it is published:** `scanForSecrets()`, `describeSecretFinding()`, `secretScreenRefusal()`, `isSecretScreenRefusal()`, `secretScreenReportLines()` in `src/shared/secretScan.ts`; `screenForSecrets()`, `knownSecretEnv()` in `src/main/local-models/secret-screen.ts`
- **Screening untrusted text for prompt injection:** `classifyText(source, text)` in `src/main/local-models/classifier.ts` (overlapping windows, MAX score across them; reach it through `runClassifierTask`)
- **The Kokoro voice's front end (text to model token ids):** `createKokoroFrontEnd()` in `src/main/acappella/providers/local/kokoro/front-end.ts`; `kokoroPhonemes()`, `normalizeKokoroText()` in `kokoro/text.ts`; `loadEspeak()`, `withoutAddedErrorHandlers()` in `kokoro/espeak.ts`; `loadKokoroVocab()`, `phonemesToIds()`
- **Running a local speech-to-text model:** `getSpeechToTextPool().acquire(modelId, consumerId)` (a lease: `transcribe`, `maxSamples`, `release`) in `src/main/local-models/speech-to-text.ts`; engines and the model table in `src/main/local-models/stt/`
- **Transcribing a whole clip of speech:** `transcribeClip(audio, sampleRate)` in `src/main/local-models/dictation.ts`, over `runSpeechToTextTask()` and `transcribeSpeech()`
- **Recording a dictation without a voice session:** `startDictation()` / `stopDictation()` / `cancelDictation()`, `registerDictationMicrophone()` in `src/main/local-models/dictation.ts`; the microphone is `ClipCapture` in `src/main/acappella/audio/clip-capture.ts`; renderer `window.maestro.localModels.dictation`
- **Dictating into a text box (renderer):** `startDictation()` / `stopDictation()` / `cancelDictation()` / `toggleDictation()`, `registerDictationTarget()`, `focusedDictationTarget()` in `src/renderer/services/dictation.ts`; state in `src/renderer/stores/dictationStore.ts`
- **Putting a transcript in a text box:** `DictationTarget`, `controlledTextDictationTarget()`, `nativeTextDictationTarget()`, `editorViewDictationTarget()`, `dictationTargetForElement()`, `padDictatedText()` in `src/renderer/utils/dictationTargets.ts`
- **Replacing a selection in a string:** `insertTextAtSelection()` in `src/renderer/utils/textSelectionEdit.ts`
- **Saying a line aloud outside a voice session (spoken notices):** `announceAgentFinished()`, `speakNotice()`, `cancelSpokenNotices()`, `registerNoticeSpeaker()` in `src/main/local-models/spoken-notices.ts`; `shouldSpeakNotice()`, `fallbackNoticeLine()`, `composeNoticeLine()`
- **Which Brain routes a spoken request (the `voice-routing` assignment):** `resolveVoiceBrainSource()`, `effectiveBrainProviderId()`, `parseVoiceBrainChoice()` in `src/shared/acappella/voice-routing.ts`; `ASSIGNED_BRAIN_PROVIDERS` in `src/shared/acappella/provider-catalog.ts`
- **Transcribing an audio file from the CLI:** `transcribeAudioFileRequest(path)` in `src/main/local-models/dictation.ts` (`maestro-cli models run dictation --audio <file.wav>`; 16-bit PCM WAV only)
- **What a recogniser's raw text may become:** `sanitizeTranscript()` in `src/main/local-models/stt/transcript.ts` (drops what a model invents for silence; shared by voice and dictation)
- **PCM arithmetic (WAV, int16/float, resampling):** `encodeWav()`, `decodeWavPcm16()`, `int16ToFloat32()`, `float32ToInt16()`, `resampleLinear()`, `resampleFloat32()`, `SPEECH_SAMPLE_RATE` in `src/shared/audio/pcm.ts` (re-exported by `src/main/acappella/providers/pcm.ts`, which keeps `PcmBuffer`)
- **Storing and searching embedding vectors:** `getEmbeddingStore()` (`upsertChunks`, `deleteBySource`, `search`, `knownTextHashes`, `sourceChunkHashes`, `sourceIds`, `hasSource`, `stats`, `clear`), `embeddingTextHash()`, `embeddingChunkId()` in `src/main/local-models/embedding-store.ts`; `l2Normalize()`
- **Cutting text into embedding windows:** `chunkText(text, { countTokens })`, `CHUNK_TARGET_TOKENS`, `MAX_CHUNKS_PER_SOURCE` in `src/main/local-models/text-chunker.ts`; count with `LocalTokenizer.countTokens()` (the text is bounded before it is tokenized; do not remove the bound)
- **Keeping the semantic index current:** `startSemanticIndex()` in `src/main/local-models/semantic-index-startup.ts`; `SemanticIndexer`, `refreshSemanticIndexer()`, `semanticIndexProgress()`, `onSemanticIndexProgress()` in `src/main/local-models/semantic-indexer.ts`
- **Searching past work by meaning or by text:** `searchPastWork()`, `searchPastWorkRequest()` in `src/main/local-models/work-search.ts`; wire types and `workSearchSnippet()`, `formatWorkSearchScore()`, `parseWorkSearchRequest()` in `src/shared/local-models/work-search.ts`
- **A Semantic mode on a renderer search surface:** `useSemanticSearchReady()`, `useSemanticSearch()` in `src/renderer/hooks/localModels/useSemanticSearch.ts`; `<SemanticSearchToggle>`, `<SemanticMatchLine>` in `src/renderer/components/SemanticSearch/` (draw the toggle only while ready)
- **Whether someone is waiting on a local model:** `isInteractiveLocalTaskRunning()`, `whenNoInteractiveLocalTask()` in `src/main/local-models/task-router.ts` (background callers pass `background: true`)
- **Hearing about a new History entry in main:** `HistoryManager.onEntryAdded(listener)` in `src/main/history-manager.ts` (in-process writers only)
- **A transcript turn's index id:** `transcriptSourceId()`, `parseTranscriptSourceId()` in `src/shared/local-models/embedding-index.ts` (the index files transcripts by turn, not by tab)
- **The semantic index's copy of Director's Notes:** `archiveDirectorNotesSynopsisInBackground()`, `readDirectorNotesArchive()` in `src/main/local-models/directors-notes-archive.ts` (written only while `semantic-search` is assigned)
- **Reusing a System One answer (the seven-day cache):** `systemOneCacheKey()`, `readCachedSystemOneAnswer()`, `storeCachedSystemOneAnswer()`, `sweepSystemOneAnswerCache()` in `src/main/local-models/system-one/answer-cache.ts`
- **Recording and reading a System One decision (the ledger):** `keepSystemOneDecision()`, `readSystemOneLedger()`, `readSystemOneAgentSpend()` in `src/main/local-models/system-one/decisions.ts`; `parseSystemOneLedgerQuery()`, `summarizeSystemOneDecision()` in `src/shared/local-models/system-one-ledger.ts`
- **Asking a System One engine a typed question:** `askSystemOne()`, `noul()`, `choice()`, `score()` in `src/main/local-models/system-one/jev-client.ts`; types in `src/shared/local-models/system-one.ts`
- **Running a task on System One:** `runSystemOneTask()` in `src/main/local-models/task-router.ts`; `taskAcceptsSystemOne()`, `buildSystemOneTaskRequest()` in `src/shared/local-models/tasks.ts`
- **Which key a System One engine is called with:** `resolveSystemOneKey()` in `src/main/local-models/system-one/service.ts`; `describeSystemOneKey()` in `src/shared/local-models/system-one-settings.ts`
- **What agents' System One requests cost, and what a job would:** `readSystemOneAgentUsage()` in `src/main/local-models/system-one/agent-service.ts`; `estimateSystemOneJob()`, `formatSystemOneCost()`, `parseSystemOneUsageQuery()` in `src/shared/local-models/system-one-spend.ts`
- **The command line of a System One verb (the `jev` flag grammar):** `readState()`, `buildQuestions()`, `collectQuestionFlags()`, `readRankCandidates()`, `readBatchRows()` in `src/cli/services/system-one-input.ts`; `registerSystemOneAgentCommands()` in `src/cli/commands/system-one-ask.ts`
- **What agents may ask System One, and switching one agent off:** `parseSystemOneBudgetText()`, `systemOneAgentUseBlocker()` in `src/shared/local-models/system-one-settings.ts`; `parseSystemOneOptOutEdit()` in `system-one-agent.ts`; `setAgentSystemOneOptOut()` in `src/renderer/services/agentSystemOne.ts`
- **The System One guide an agent reads (topics and recipes):** `SYSTEM_ONE_GUIDE_TOPICS`, `SYSTEM_ONE_EXAMPLES`, `systemOneGuidePromptDefinitions()` in `src/shared/local-models/system-one-guide.ts`; printed by `systemOneGuide()`, `systemOneExamples()` in `src/cli/commands/system-one-guide.ts`
- **Answering an agent's System One request (the service):** `runAgentSystemOneRequest()`, `getSystemOneAgentAccess()` in `src/main/local-models/system-one/agent-service.ts`; `parseSystemOneAgentRequest()` in `src/shared/local-models/system-one-agent.ts`
- **Which core sections an agent's system prompt carries (System One):** `coreSystemPromptSectionsFor()`, `coreSystemPromptContext()` in `src/shared/maestroSystemPrompt.ts`; `isSystemOneAdvertised()` in `src/shared/local-models/system-one-prompt.ts`
- **Versioned schema migrations for a SQLite file:** `runSqliteMigrations(db, migrations, logContext)`, `sqliteUserVersion()` in `src/main/utils/sqlite-migrations.ts` (shared by `stats.db` and `embeddings.db`; never copy the runner)
- **Writing the A Cappella settings blob from the renderer:** `patchVoiceSettingsSection(section, patch)`, `readVoiceSettingsBlob()`, `ACAPPELLA_SETTINGS_KEY` in `src/renderer/services/voiceSettings.ts`
- **The voice send phrases (the spoken "send it"):** `DEFAULT_SEND_PHRASES`, `parseSendPhrases()`, `formatSendPhrases()`, `isLegacyDefaultSendPhrases()` in `src/shared/acappella/voice-controls.ts`; matched by `matchSendPhrase()` in `src/main/acappella/speech/send-phrase.ts`; edited in the HUD's send panel
- **Which agent a voice session is bound to:** `voiceScopeAgentId(scope)` in `src/shared/acappella/document-scope.ts`, alongside `isDocumentScope()`, `documentScopeName()` and `applyDocumentScope()`
- **Binding a voice session to Quick Chat (locked):** `QUICK_CHAT_VOICE_SCOPE`, `isQuickChatScope()`, `scopeRebindBlocker()` in `src/shared/acappella/quick-chat-scope.ts`; `dispatchToQuickChat()` in `src/main/acappella/dispatch/quick-chat-dispatch.ts`; `useQuickChatVoice()` in `src/renderer/hooks/voice/`
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

### Voice

- **A Cappella** - The voice interface, gated as an Encore Feature and off by default. Speech in, routing to an agent and tab, spoken reply back. The session itself lives in the MAIN process (`src/main/acappella/voice-session-service.ts`); every renderer holds a projection of its event stream, never authority. Architecture: [docs/architecture/acappella/](docs/architecture/acappella/). User docs: [docs/voice-mode.md](docs/voice-mode.md).
- **Conductor** - The routing model that decides which agent and tab an utterance meant. It is a router, not a second assistant: it never answers a question itself.
- **Voice HUD** - The one on-screen surface for a session (`VoiceHud.tsx`). Minimize keeps the session and hands the indicator to the Left Bar; close ENDS it.
- **Voice floor** - Which microphone currently holds the session. One floor app-wide, held locally or by a paired device.
- **Local Models** - The core service A Cappella CONSUMES for everything that is a model: the catalog, downloads and verification, the native runtimes, the speech-to-text engines, and the assigned Brain (`src/shared/local-models/`, `src/main/local-models/`). It is not an Encore Feature and it serves other features too (tab naming, AI command mode, semantic search, the Cue gate, dictation), so voice owns no model stack: voice words for a model (slot, capability, setup bundle) live in `src/shared/acappella/voice-models.ts` keyed by core model id, and a local voice provider leases or loads through the core. Architecture: [docs/architecture/local-models.md](docs/architecture/local-models.md). User docs: [docs/local-models.md](docs/local-models.md).

Three invariants worth knowing before touching any of it, because each was a shipped bug:

1. **Nothing starts itself.** Enabling the feature opens no device, downloads nothing, and registers no hotkey. A session begins only from an explicit trigger (composer microphone, global hotkey, command palette, Left Bar menu, wake word, paired phone). The one surface that appears on its own is **Voice Setup** (`Settings/ACappella/VoiceSetupModal.tsx`), offered when the Encore flag is switched on: it is a consent prompt, not a session, it fetches nothing until the user presses Download, and **Later** leaves voice enabled and unconfigured. That is deliberate - the default provider trio is now the LOCAL one (`DEFAULT_PROVIDER_IDS` in `providers/provider-registry.ts`), so without models a session refuses by name instead of transcribing nothing while looking healthy.
2. **One session belongs to ONE window.** Voice events are broadcast to every renderer like every other main -> renderer push, so a surface that does not gate on `useOwnsVoiceSession()` appears in all of them at once.
3. **A missing capability is refused by name, never substituted.** The gate (`models/capability-gate.ts`) reports the specific slot and its recovery. It never quietly swaps in a cloud provider for a local one that will not load - that would spend the user's money and ship their microphone somewhere they did not choose.

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

| Task                                 | Primary Files                                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler                      | `src/main/index.ts`, `src/main/preload/` (one module per namespace)                                                                                                                                                                                                  |
| Add UI component                     | `src/renderer/components/`                                                                                                                                                                                                                                           |
| Add browser/mobile touch affordance  | `src/renderer/components/`, `src/renderer/utils/touch.ts`, `src/renderer/hooks/utils/` (gate on `isCoarsePointer()`; PWA assets in `src/web/public/`)                                                                                                                |
| Add keyboard shortcut                | `src/renderer/constants/shortcuts.ts`, `App.tsx`                                                                                                                                                                                                                     |
| Add theme                            | `src/renderer/constants/themes.ts`                                                                                                                                                                                                                                   |
| Add modal                            | Component + `src/renderer/constants/modalPriorities.ts`                                                                                                                                                                                                              |
| Add tab overlay menu                 | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]]                                                                                                                                                                                                         |
| Add setting                          | `src/shared/settingsMetadata.ts`, `src/renderer/stores/settingsStore.ts`, `searchableSettings.ts` + a `data-setting-id` wrapper (checklist: [[CLAUDE-SETTINGS.md]] §9)                                                                                               |
| Add template variable                | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts`                                                                                                                                                                                         |
| Modify system prompts                | `src/prompts/*.md` (wizard, Auto Run, etc.) or edit via **Maestro Prompts** tab in Settings                                                                                                                                                                          |
| Customize prompts                    | Use **Maestro Prompts** tab in Settings, or edit `userData/core-prompts-customizations.json`                                                                                                                                                                         |
| Add new prompt                       | `src/prompts/*.md`, `src/shared/promptDefinitions.ts` (add to `CORE_PROMPTS` array and `PROMPT_IDS`)                                                                                                                                                                 |
| Add Spec-Kit command                 | `src/prompts/speckit/`, `src/main/speckit-manager.ts`                                                                                                                                                                                                                |
| Add OpenSpec command                 | `src/prompts/openspec/`, `src/main/openspec-manager.ts`                                                                                                                                                                                                              |
| Add CLI command                      | `src/cli/commands/`, `src/cli/index.ts`, and an example in `src/cli/command-examples.ts` (`src/__tests__/cli/command-tree.test.ts` fails a verb without one)                                                                                                         |
| Add new agent                        | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md)                                                                                        |
| Add agent output parser              | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                     |
| Add parquet viewer feature           | `src/renderer/components/ParquetViewer/` (UI), `src/main/parquet/` (query engine), `src/shared/parquet/` (filter language + wire types)                                                                                                                              |
| Add agent session storage            | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                       |
| Add agent error patterns             | `src/shared/agentErrorPatterns.ts`                                                                                                                                                                                                                                   |
| Add agent context window             | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                                |
| Add playbook feature                 | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                      |
| Add marketplace playbook             | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                          |
| Playbook import/export               | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                      |
| Modify wizard flow                   | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                         |
| Add tour step                        | `src/renderer/components/Wizard/tour/tourSteps.tsx`                                                                                                                                                                                                                  |
| Modify file linking                  | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                                |
| Add documentation page               | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                           |
| Add documentation screenshot         | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                         |
| MCP server integration               | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                         |
| Add stats/analytics feature          | `src/main/stats/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                       |
| Add Usage Dashboard chart            | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                            |
| Add Document Graph feature           | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                                   |
| Add colorblind palette               | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                       |
| Add performance metrics              | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                                  |
| Capture/analyze perf trace           | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces                                                                                                    |
| Add power management                 | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                       |
| Spawn agent with SSH support         | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                            |
| Modify file preview tabs             | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                     |
| Add Director's Notes feature         | `src/renderer/components/DirectorNotes/`, `src/shared/directorNotesNarrative.ts`, `src/shared/directorNotesGrouping.ts`, `src/main/ipc/handlers/director-notes.ts`                                                                                                   |
| Add Encore Feature                   | `src/renderer/types/index.ts` (flag), `src/shared/plugins/first-party.ts` (tile + settings body), gating checklist in [[CLAUDE-PATTERNS.md]] §12                                                                                                                     |
| Modify history components            | `src/renderer/components/History/`                                                                                                                                                                                                                                   |
| Modify history activity graph        | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                                   |
| Modify Auto Run Thought Stream       | `src/renderer/stores/thoughtStreamStore.ts`, `ThoughtStreamPanel.tsx`, `useThoughtStream{Capture,Tool}Listener.ts`, `src/renderer/utils/toolActivityLabel.ts`                                                                                                        |
| Add A Cappella voice feature         | `src/main/acappella/` (session, providers, router, audio, wake, transport), `src/main/ipc/handlers/acappella.ts`, `src/renderer/components/ACappella/` - read [docs/architecture/acappella/system-overview.md](docs/architecture/acappella/system-overview.md) first |
| Add a voice provider (STT/TTS/brain) | `src/main/acappella/providers/` + `src/shared/acappella/provider-catalog.ts`. Register in `provider-registry.ts`; NEVER substitute one provider for another (see `capability-gate.ts`)                                                                               |
| Surface a voice session in the UI    | `useOwnsVoiceSession()` in `src/renderer/components/ACappella/` - voice events are broadcast to EVERY window, so any new voice surface must gate on it or it renders in all of them                                                                                  |
| Change local speech-to-text          | Engines are core: `src/main/local-models/stt/` (Parakeet, Whisper), leased via `SpeechToTextPool` in `local-models/speech-to-text.ts`. Voice's streaming policy: `acappella/providers/local/chunked-stt.ts`. ONNX Runtime only                                       |
| Add a local-model task               | `src/shared/local-models/tasks.ts` (`LOCAL_MODEL_TASK_IDS` + `LOCAL_MODEL_TASKS`), then call `runLocalTask()` or a twin in `src/main/local-models/task-router.ts`; a text task adds a `*-local` prompt in `src/prompts/`. NEVER call llama or an endpoint directly   |
| Add a downloadable native runtime    | `src/shared/local-models/native-runtimes.ts` (descriptor) + `runtime-artifacts.ts` (pinned tarball, hash, and `dependencies`). A tarball is NOT an install: anything the payload `require()`s must be listed, or it verifies clean and throws `MODULE_NOT_FOUND`     |
| Add Cue event type                   | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                            |
| Add Cue template variable            | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                    |
| Modify Cue modal                     | `src/renderer/components/CueModal/`                                                                                                                                                                                                                                  |
| Configure Cue engine                 | `src/main/cue/cue-engine.ts`, `src/main/ipc/handlers/cue.ts`                                                                                                                                                                                                         |
| Add terminal feature                 | `src/renderer/components/XTerminal.tsx`, `src/renderer/components/TerminalView.tsx`                                                                                                                                                                                  |
| Modify terminal tabs                 | `src/renderer/utils/terminalTabHelpers.ts`, `src/renderer/stores/tabStore.ts`                                                                                                                                                                                        |

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
