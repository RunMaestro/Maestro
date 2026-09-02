<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Remaining Systems Guide

Covers four smaller subsystems: Context Providers, Renderer Types, Web Utilities, and Symphony Runner.

---

## 1. Context Providers (`src/renderer/contexts/`)

Four React context files (~770 lines total, see per-file counts below) that provide cross-component state without prop drilling. All follow the same pattern: create context with `null` default, provider component wraps hook logic, consumer hook throws if used outside provider.

### When to Use Context vs. Store

- **Context** - State that needs React's render cycle (triggers re-renders on change). Used for UI state that multiple components read: completion dropdowns, layer stack, wizard state, git polling data.
- **Store (useUIStore, zustand)** - State that changes frequently or needs imperative access outside React. Used for sidebar toggles, focus area, UI flags.

The dividing line: contexts own _derived/polled data_ or _popup/modal coordination_. Stores own _simple toggles and flags_.

### GitStatusContext.tsx (253 lines)

Centralizes git status polling for all sessions. Splits data into three focused sub-contexts to minimize re-renders:

| Context                     | Hook                 | Data                                                    | Update Frequency    |
| --------------------------- | -------------------- | ------------------------------------------------------- | ------------------- |
| `GitBranchContext`          | `useGitBranch()`     | branch name, remote, ahead/behind                       | Rarely              |
| `GitFileStatusContext`      | `useGitFileStatus()` | file count, `hasChanges()`                              | On file operations  |
| `GitDetailContext`          | `useGitDetail()`     | file changes, additions/deletions, `refreshGitStatus()` | Active session only |
| `GitStatusContext` (legacy) | `useGitStatus()`     | full `gitStatusMap`, everything                         | Deprecated          |

**Provider props:** `sessions: Session[]`, `activeSessionId?: string`, `options?: UseGitStatusPollingOptions`

**Usage counts:**

- `useGitFileStatus` - 3 consumers (GitStatusWidget, MainPanel, SessionList)
- `useGitDetail` - 2 consumers (GitStatusWidget, MainPanel)
- `useGitBranch` - 2 consumers (MainPanel, `useGitAgentActions`)
- `useGitStatus` (legacy) - 0 external consumers (deprecated, safe to remove)

The underlying data comes from `useGitStatusPolling` hook which polls via IPC.

### useGitAgentActions (`src/renderer/hooks/git/useGitAgentActions.ts`)

The per-agent git action set (View Git Log, View Git Diff, Git Pull, Git Push,
Change Branch, Checkpoints, Create Pull Request, Configure Worktrees), shared by the three
surfaces that offer it: the header branch pill dropdown (`GitPillMenu`), the Left
Bar right-click menu (`SessionContextMenu`), and the command palette
(`buildGitWorktreeCommands`). **Do not re-derive these actions anywhere else** -
add to this hook, then surface the new action in all three so mouse and keyboard
stay at parity.

```ts
const git = useGitAgentActions(session);
if (!git.isGitRepo) return null;
git.pull(); // opens the streaming runner for THIS session's repo
```

Returns `{ isGitRepo, branch, ahead, behind, canCreatePR, canConfigureWorktrees, viewLog, viewDiff, pull, push, switchBranch, createPR, viewCheckpoints, configureWorktrees }`.
Every action opens its modal through the modal store directly, so callers need
no prop drilling and can act on an agent that isn't the active one. Branch and
ahead/behind come from `useGitBranch()`, falling back to `session.worktreeBranch`.
`viewDiff` is the only async one - it has to read the diff before there is
anything to show, and flashes "No diff to examine" (re-syncing stale polling
stats) rather than opening an empty viewer.

Two exported helpers resolve the git target and are reused elsewhere:
`resolveGitCwd(session)` (terminal agents' live `shellCwd` wins over `cwd`) and
`resolveGitSshRemoteId(session)` (top-level id, then the per-session config when
enabled).

### InlineWizardContext.tsx (177 lines)

Wraps `useInlineWizard` hook to make `/wizard` slash command state available globally. The inline wizard creates or iterates on Auto Run documents within an existing session conversation, unlike the full-screen onboarding wizard (`MaestroWizard.tsx`).

**Hook:** `useInlineWizardContext()` returns `UseInlineWizardReturn`

**Key state fields:**

- `isWizardActive`, `wizardMode` ('new' | 'iterate' | 'ask'), `wizardGoal`
- `confidence` (0-100), `ready`, `readyToGenerate`
- `conversationHistory`, `streamingContent`, `generationProgress`
- `isGeneratingDocs`, `generatedDocuments`, `existingDocuments`

**Key actions:** `startWizard()`, `endWizard()`, `sendMessage()`, `generateDocuments()`, `reset()`

**Usage:** 2 consumers (App.tsx, useWizardHandlers reference)

### InputContext.tsx (251 lines)

Manages completion popup and command history state extracted from App.tsx. Four completion subsystems:

| Subsystem       | Mode          | State Fields                                                                        |
| --------------- | ------------- | ----------------------------------------------------------------------------------- |
| Slash Commands  | AI + terminal | `slashCommandOpen`, `selectedSlashCommandIndex`                                     |
| Tab Completion  | Terminal only | `tabCompletionOpen`, `selectedTabCompletionIndex`, `tabCompletionFilter`            |
| @ Mention       | AI only       | `atMentionOpen`, `atMentionFilter`, `atMentionStartIndex`, `selectedAtMentionIndex` |
| Command History | Both          | `commandHistoryOpen`, `commandHistoryFilter`, `commandHistorySelectedIndex`         |

**Hook:** `useInputContext()` returns all state + setters + reset methods + `closeAllCompletions()`

**Performance note:** Input _values_ (text content) are intentionally NOT in context - they stay in App.tsx local state to avoid re-renders on every keystroke. Only popup open/close state lives here.

**Usage:** 3 consumers (App.tsx, useInputHandlers, useInputKeyDown)

### LayerStackContext.tsx (89 lines)

Provides global modal/overlay layer stack management with centralized Escape key handling. The provider installs a capture-phase keydown listener that delegates Escape to the topmost layer's `onEscape` handler.

**Hook:** `useLayerStack()` returns `LayerStackAPI` with methods `registerLayer(layer: LayerInput): string`, `unregisterLayer(id: string): void`, `updateLayerHandler(id, handler): void`, `getTopLayer(): Layer | undefined`, `closeTopLayer(): Promise<boolean>`, `getLayers(): Layer[]`, and boolean helpers `hasOpenLayers()` / `hasOpenModal()`, plus a `layerCount: number` field. Defined in `src/renderer/hooks/ui/useLayerStack.ts`.

**Usage:** 20+ consumers - every modal and overlay component registers with the layer stack (App.tsx, AgentCreationDialog, BatchRunnerModal, SettingsModal, AutoRunLightbox, etc.)

This is the most widely used context. The layer type system is defined in `src/renderer/types/layer.ts`.

---

## 2. Renderer Types (`src/renderer/types/`)

Four type files defining the core data model for the renderer process.

### index.ts (~999 lines) - Core Type Definitions

The central type file. Contains the `Session` interface (the largest type at ~200 fields) and all supporting types. Organized as:

**Re-exports from shared:** Theme types, AgentError, ToolType, Group, UsageStats, BatchDocumentEntry, Playbook, ThinkingMode, WorktreeRunTarget, GroupChat types, SymphonySessionMetadata, HistoryEntryType.

**Renderer-only type aliases:**

- `SessionState` = 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error'
- `FileChangeType` = 'modified' | 'added' | 'deleted'
- `RightPanelTab`, `SettingsTab`, `FocusArea`, `LLMProvider`

**Major interfaces (renderer-only):**

- `Session` - The agent data model. Contains ~200 fields: identity, tabs, file tree, SSH config, execution queue, wizard state, custom overrides, batch state, etc.
- `AITab` - Individual conversation tab within a session. Contains logs, usage stats, input value, staged images, wizard state, scroll position, etc.
- `FilePreviewTab` - In-tab file viewing with navigation history.
- `UnifiedTab` / `UnifiedTabRef` / `ClosedTabEntry` - Discriminated unions for the unified tab system.
- `LogEntry` - Timestamped log entries (stdout, stderr, system, user, ai, error, thinking, tool).
- `QueuedItem` - Items in the session execution queue.
- `AgentCapabilities` - Feature flags for agent support (resume, readonly, image input, streaming, etc.).
- `AgentConfig` - Agent configuration (binary path, args, config options).
- `ProcessConfig` - Process spawning configuration.
- `BatchRunConfig` / `BatchRunState` - Batch processing configuration and state.
- `AutoRunStats`, `MaestroUsageStats`, `OnboardingStats` - Achievement/analytics types.
- `KeyboardMasteryStats`, `LeaderboardRegistration` - Gamification types.
- `EncoreFeatureFlags`, `DirectorNotesSettings`, `ContextManagementSettings` - Feature settings.
- `SessionWizardState`, `WizardMessage`, `WizardGeneratedDocument` - Inline wizard state.

**Extended from shared base types:**

- `HistoryEntry extends BaseHistoryEntry` - adds `achievementAction` field
- `WorktreeConfig extends BaseWorktreeConfig` - adds `ghPath` field
- `BatchRunConfig` - renderer version adds `worktree` and `worktreeTarget` fields not in the shared version

### contextMerge.ts (177 lines)

Types for context merge/transfer operations between sessions:

- `ContextSource` - A tab or session to merge from
- `MergeRequest` / `MergeResult` - Merge operation request/response
- `GroomingProgress` - Progress updates during long merge operations
- `DuplicateInfo` / `DuplicateDetectionResult` - Duplicate detection across contexts
- `SummarizeRequest` / `SummarizeResult` / `SummarizeProgress` - Context summarization

### layer.ts (107 lines)

Type system for the LayerStackContext:

- `LayerType` = 'modal' | 'overlay'
- `FocusTrapMode` = 'strict' | 'lenient' | 'none'
- `BaseLayer`, `ModalLayer`, `OverlayLayer` - Layer hierarchy
- `Layer` = discriminated union
- `LayerInput` = `ModalLayerInput | OverlayLayerInput` (discriminated union of `Omit<Layer, 'id'>` variants)
- Type guards: `isModalLayer()`, `isOverlayLayer()`

### fileTree.ts (7 lines)

Single interface:

```typescript
export interface FileNode {
	name: string;
	type: 'file' | 'folder';
	children?: FileNode[];
	fullPath?: string;
	isFolder?: boolean;
}
```

---

## 3. Web Utilities (`src/web/utils/`, ~300 lines)

Utilities that once served the legacy `src/web/` browser subsystem. After the Phase 06 mobile retirement, only `serviceWorker.ts` (and its `logger.ts` dependency) is still load-bearing - it registers the PWA service worker from `src/web-desktop/bootstrap.ts`. The rest (`config.ts`, `cssCustomProperties.ts`, `viewState.ts`) is orphaned dead code documented here for reference; the browser interface is now the web-desktop bundle, which reuses the renderer's own utilities. See [WEB-MOBILE.md](WEB-MOBILE.md).

### config.ts (152 lines)

Configuration management for the web interface. Reads server-injected `window.__MAESTRO_CONFIG__` containing security token, session ID, and API base paths.

**Key exports:**

- `getMaestroConfig()` - Returns `MaestroConfig` (security token, session/tab IDs, API/WS base paths). Falls back to URL extraction in dev mode.
- `isDashboardMode()` / `isSessionMode()` - View mode checks
- `getCurrentSessionId()` / `getCurrentTabId()` - Current navigation state
- `buildApiUrl(endpoint)` - Constructs full API URLs with token prefix
- `buildWebSocketUrl(sessionId?)` - Constructs WebSocket URLs (ws:/wss:)
- `getDashboardUrl()` / `getSessionUrl(sessionId, tabId?)` - Navigation URLs
- `updateUrlForSessionTab(sessionId, tabId?)` - Updates URL bar without page reload via `history.replaceState`

### cssCustomProperties.ts (275 lines)

Converts Maestro theme colors to CSS custom properties for dynamic theming in the web interface. Maps camelCase color keys to `--maestro-*` CSS variables.

**Key exports:**

- `generateCSSProperties(theme)` - Returns `Record<ThemeCSSProperty, string>` mapping
- `generateCSSString(theme, selector?)` - Returns full CSS rule string
- `injectCSSProperties(theme)` - Creates/updates a `<style>` element in `<head>` (SSR-safe)
- `removeCSSProperties()` - Removes injected style element
- `setElementCSSProperties(element, theme)` - Applies to specific DOM element (scoped theming)
- `removeElementCSSProperties(element)` - Cleans up element styles
- `getCSSProperty(property, element?)` - Reads computed value
- `cssVar(property, fallback?)` - Returns `var(--maestro-*, fallback)` string for inline styles
- `THEME_CSS_PROPERTIES` - Array of all 13 CSS variable names

### logger.ts (170 lines)

Structured logging for the web/PWA interface. All logs prefixed with `[WebUI]`. Uses `BaseLogLevel` and `LOG_LEVEL_PRIORITY` from `shared/logger-types.ts` for consistency with the main process logger.

**Singleton:** `webLogger` with methods `debug()`, `info()`, `warn()`, `error()`, plus `setLevel()`, `setEnabled()`, `enableDebug()`, `reset()`.

Default minimum level: `warn`. Exposed on `window.__webLogger` in development for debugging.

### serviceWorker.ts (180 lines)

Service worker lifecycle management for offline PWA capability.

**Key exports:**

- `registerServiceWorker(config?)` - Registers `sw.js` with token-prefixed path. Handles update detection, offline/online status events, and message forwarding.
- `unregisterServiceWorker()` - Cleans up registration
- `isServiceWorkerSupported()` - Feature detection
- `isOffline()` - Checks `navigator.onLine`
- `skipWaiting()` - Activates waiting worker (for user-confirmed updates)
- `pingServiceWorker()` - Health check with 1-second timeout

### viewState.ts (198 lines)

Persists web UI state to `localStorage` across page refreshes. Two storage keys: `maestro-web-view-state` (view state) and `maestro-web-scroll-state` (scroll positions).

**State persisted:** `ViewState` includes active overlays, session/tab selection, input mode, history panel filter/search, plus `savedAt` timestamp. State older than 5 minutes is considered stale and discarded.

**Key exports:**

- `saveViewState(partial)` / `loadViewState()` / `clearViewState()`
- `saveScrollPosition(view, position)` / `loadScrollState()`
- `debouncedSaveViewState(partial, delay=300)` - 300ms debounce
- `debouncedSaveScrollPosition(view, position, delay=500)` - 500ms debounce (scroll events fire frequently)

### index.ts (26 lines)

Barrel file re-exporting from `cssCustomProperties` and `serviceWorker`. Does NOT re-export `config`, `logger`, or `viewState` - those are imported directly by consumers.

---

## 4. Symphony Runner (`src/main/services/symphony-runner.ts`, 443 lines)

Orchestrates open-source contributions via Maestro Symphony. This is a main-process service that handles the git/GitHub workflow for contributing to repositories.

### Contribution Flow

`startContribution(options)` executes a 6-step pipeline:

1. **Clone** - Shallow clone (`--depth=1`) of the target repository
2. **Branch** - Create and checkout a feature branch
3. **Fork setup** - Uses `ensureForkSetup()` from `symphony-fork` utils to detect if user needs a fork (no push access to upstream). Configures git remotes accordingly.
4. **Git config** - Sets `user.name` = "Maestro Symphony", `user.email` = "symphony@runmaestro.ai"
5. **Empty commit + Push** - Creates placeholder commit `[Symphony] Start contribution for #N` and pushes branch
6. **Draft PR** - Creates a draft PR via `gh pr create --draft` with "Closes #N" body. Handles cross-fork PRs with `--repo` and `--head` flags.
7. **Setup Auto Run docs** - Copies or downloads documents to `Auto Run Docs/` folder in the cloned repo. Handles both repo-relative paths and external URLs (GitHub attachments).

Returns: `{ success, draftPrUrl, draftPrNumber, autoRunPath, isFork, forkSlug }`

### Finalization

`finalizeContribution(localPath, prNumber, issueNumber, issueTitle, upstreamSlug?)`:

- Commits all changes (`rtk git add -A`)
- Pushes to origin (fork or upstream)
- Converts draft PR to ready-for-review via `gh pr ready`
- Updates PR body with completion summary

### Cancellation

`cancelContribution(localPath, prNumber, cleanup?, upstreamSlug?)`:

- Closes the draft PR via `gh pr close`
- Deletes branch (only for non-fork PRs; cross-fork branch deletion fails due to permissions)
- Optionally removes local clone directory

### Relationship to Other Systems

- **Auto Run** - Symphony sets up Auto Run documents, then the actual document processing happens via the standard batch/Auto Run system in the renderer (useBatchProcessor, batchStateMachine). Symphony Runner only does the git/PR scaffolding.
- **CLI** - No overlap. The CLI has its own playbook processing (`src/cli/services/playbooks.ts`) which is independent.
- **Group Chat** - No direct connection. Symphony sessions can participate in group chats, but the runner itself has no group chat logic.
- **IPC integration** - Called from `src/main/ipc/handlers/symphony/contributionStart.ts` via `symphony:startContribution` IPC handler. Frontend accesses it through `useSymphony` hook and `SymphonyModal.tsx`.

- **IPC integration** - Called from `src/main/ipc/handlers/symphony/contributionStart.ts` via `symphony:startContribution` IPC handler. Frontend accesses it through `useSymphony` hook and `SymphonyModal.tsx`.

---

## 5. Parquet Query Engine (`src/main/parquet/`, `src/shared/parquet/`)

The main-process half of the Parquet file preview. Unlike every other previewable format, a Parquet file is never read into memory: it stays behind an open file descriptor and the renderer asks for windows of rows over `parquet:*` IPC.

| File                                     | Role                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/shared/parquet/types.ts`            | Wire contract: `ParquetFileInfo`, `ParquetQueryRequest`, `ParquetQueryResult`, `ParquetScanStats` |
| `src/shared/parquet/preview.ts`          | `isParquetFile()`, and the marker `fs:readFile` returns in place of content                       |
| `src/shared/parquet/filterExpression.ts` | Tokenizer, parser, binder, and per-row evaluator for the filter language                          |
| `src/shared/parquet/pushdown.ts`         | Compiles a bound predicate into parquet-level pruning                                             |
| `src/main/parquet/parquet-file.ts`       | Open handles, footer metadata, schema summary, SSH caching                                        |
| `src/main/parquet/parquet-query.ts`      | The scan engine: pruning, projection, resumable match sets, sorting, export                       |
| `src/main/ipc/handlers/parquet.ts`       | `parquet:open` / `query` / `export` / `close`                                                     |

### The four things that will bite you

**1. Statistics are in the CONVERTED domain, not the physical one.**

This is the single most important fact in the subsystem, and getting it wrong loses rows silently. A `TIMESTAMP(MICROS)` column stores `1704067200000000` on disk, so it is natural to assume a bound compared against footer statistics must be in microseconds. It must not: hyparquet runs every statistic through `convertMetadata` while parsing the footer, so by the time a bound reaches the pruning check a timestamp is a `Date`, a DATE is a `Date`, a DECIMAL is already scaled, and a BYTE_ARRAY is a UTF-8 string. Compiling a bound in microseconds makes it a thousand times larger than anything it is compared against, every row group "provably" cannot match, and the filter returns nothing while looking perfectly healthy.

The upside of that fact: statistics and decoded row values live in the same domain, so `bindFilterExpression` coerces a literal once and both `compileFilterPushdown` and `evaluateFilterNode` use it unchanged.

**2. The pushdown filter must never be more selective than the predicate.**

Anything inexpressible is dropped and the residual evaluator still runs on every surviving row, so a dropped conjunct costs speed and never correctness. The asymmetry that matters: a child may be dropped from an `and`, but if any child of an `or` fails to compile the **whole** `or` must be dropped - narrowing one branch of a union discards rows the other branch would have matched. `pushdown.test.ts` pins both directions.

**3. `pruningFilter`, not `filter`.**

The engine calls `parquetScan({ pruningFilter })` rather than `parquetRead({ filter })`. `pruningFilter` eliminates physical row ranges without dropping individual rows, leaving row-level truth entirely to `evaluateFilterNode`. That is what makes a merely-conservative bound safe: even a sloppy pushdown can only cost pruning, never rows. `filter` would apply per-row matching with hyparquet's own semantics, and any disagreement between the two evaluators would drop real data.

**4. Pruning is measured, not inferred.**

`CountingAsyncBuffer` counts every byte read through the file handle, so `stats.bytesRead` is the truth about how much of the file a query touched. hyparquet decides internally which chunks and pages to fetch, so this is the only honest measurement available - do not try to compute it from the plan.

### Resumable scans

A query stops as soon as the requested window is full or `MAX_QUERY_MS` expires, and returns `complete: false`. The `ScanSession` (cached per file per filter) remembers which range it reached, so paging through a filtered 100M-row file is one forward pass in total rather than one pass per page.

Two consequences for callers:

- `matchedRows` is a **lower bound** until `complete` is true. Pass `countAll: true` to drive the scan toward completion instead of stopping at the window.
- A session is cached per **filter only**, not per (filter, columns). Showing or hiding a column re-materializes a page from the existing match set instead of re-running the scan.

Only one session is kept per file: filters are typed character by character, and an unbounded cache would pin a scan plus its decoded column buffers for every prefix the user passed through.

### Two-phase projection

Inside a surviving range, only the columns the predicate mentions are decoded first. If nothing matches, the wide columns are never touched. This is the whole point of a columnar format, and it is why a bare search term (which must read every column) is the slowest filter the language can express.

### A broken filter matches nothing

`ScanSession.blocked` is deliberately distinct from `identity` (no filter at all). An expression that fails to parse or bind matches zero rows and carries its `ParquetFilterProblem` back to the renderer. Falling back to "no filter" would show all 8 million rows under a red error message, which reads as filtering being broken rather than as the expression being broken.

### hyparquet is loaded lazily

It is ESM-only and about 150 KB of parser, and most sessions never open a Parquet file, so `loadParquetReader()` caches a dynamic `import()` rather than paying at app launch. `hyparquet-compressors` comes with it for gzip/brotli/zstd/lz4 (snappy is built in).

### SSH

There is no byte-range channel over an SSH shell, so a remote file is fetched whole into a cache directory keyed by remote id, path, size, and mtime, and read locally from there. Above `MAX_REMOTE_BYTES` the open fails loudly with a message that names the actual remedy, because the base64-over-SSH transfer materializes the file in main-process memory twice on the way to disk.

### Testing

`src/__tests__/main/parquet/parquet-query.test.ts` writes its fixture at test time with `hyparquet-writer`, so there is no binary in the repo and the reader runs against real row groups, real footer statistics, and real snappy pages.

Two things to know before adding cases:

- **Use `// @vitest-environment node`.** The reader hands hyparquet `ArrayBuffer`s that it checks with `instanceof`, and jsdom's separate realm fails that check for reasons unrelated to the code under test.
- **`hyparquet-writer` records only a null count for annotated `TIMESTAMP` columns.** Do not assert row-group pruning on a timestamp filter against a written fixture - there are no min/max statistics to prune with. Pin the bound in `pushdown.test.ts` instead, and assert pruning on a plain `INT64` column.
