# Remaining Systems Guide

Covers four smaller subsystems: Context Providers, Renderer Types, Web Utilities, and Symphony Runner.

---

## 1. Context Providers (`src/renderer/contexts/`)

Four React context files (~770 lines total) that provide cross-component state without prop drilling. All follow the same pattern: create context with `null` default, provider component wraps hook logic, consumer hook throws if used outside provider.

### When to Use Context vs. Store

- **Context** - State that needs React's render cycle (triggers re-renders on change). Used for UI state that multiple components read: completion dropdowns, layer stack, wizard state, git polling data.
- **Store (useUIStore, zustand)** - State that changes frequently or needs imperitive access outside React. Used for sidebar toggles, focus area, UI flags.

The dividing line: contexts own _derived/polled data_ or _popup/modal coordination_. Stores own _simple toggles and flags_.

### GitStatusContext.tsx (254 lines)

Centralizes git status polling for all sessions. Splits data into three focused sub-contexts to minimize re-renders:

| Context | Hook | Data | Update Frequency |
|---------|------|------|-----------------|
| `GitBranchContext` | `useGitBranch()` | branch name, remote, ahead/behind | Rarely |
| `GitFileStatusContext` | `useGitFileStatus()` | file count, `hasChanges()` | On file operations |
| `GitDetailContext` | `useGitDetail()` | file changes, additions/deletions, `refreshGitStatus()` | Active session only |
| `GitStatusContext` (legacy) | `useGitStatus()` | full `gitStatusMap`, everything | Deprecated |

**Provider props:** `sessions: Session[]`, `activeSessionId?: string`, `options?: UseGitStatusPollingOptions`

**Usage counts:**
- `useGitFileStatus` - 3 consumers (GitStatusWidget, MainPanel, SessionList)
- `useGitDetail` - 2 consumers (GitStatusWidget, MainPanel)
- `useGitBranch` - 1 consumer (MainPanel)
- `useGitStatus` (legacy) - 0 external consumers (deprecated, safe to remove)

The underlying data comes from `useGitStatusPolling` hook which polls via IPC.

### InlineWizardContext.tsx (178 lines)

Wraps `useInlineWizard` hook to make `/wizard` slash command state available globally. The inline wizard creates or iterates on Auto Run documents within an existing session conversation, unlike the full-screen onboarding wizard (`MaestroWizard.tsx`).

**Hook:** `useInlineWizardContext()` returns `UseInlineWizardReturn`

**Key state fields:**
- `isWizardActive`, `wizardMode` ('new' | 'iterate' | 'ask'), `wizardGoal`
- `confidence` (0-100), `ready`, `readyToGenerate`
- `conversationHistory`, `streamingContent`, `generationProgress`
- `isGeneratingDocs`, `generatedDocuments`, `existingDocuments`

**Key actions:** `startWizard()`, `endWizard()`, `sendMessage()`, `generateDocuments()`, `reset()`

**Usage:** 2 consumers (App.tsx, useWizardHandlers reference)

### InputContext.tsx (252 lines)

Manages completion popup and command history state extracted from App.tsx. Four completion subsystems:

| Subsystem | Mode | State Fields |
|-----------|------|-------------|
| Slash Commands | AI + terminal | `slashCommandOpen`, `selectedSlashCommandIndex` |
| Tab Completion | Terminal only | `tabCompletionOpen`, `selectedTabCompletionIndex`, `tabCompletionFilter` |
| @ Mention | AI only | `atMentionOpen`, `atMentionFilter`, `atMentionStartIndex`, `selectedAtMentionIndex` |
| Command History | Both | `commandHistoryOpen`, `commandHistoryFilter`, `commandHistorySelectedIndex` |

**Hook:** `useInputContext()` returns all state + setters + reset methods + `closeAllCompletions()`

**Performance note:** Input _values_ (text content) are intentionally NOT in context - they stay in App.tsx local state to avoid re-renders on every keystroke. Only popup open/close state lives here.

**Usage:** 3 consumers (App.tsx, useInputHandlers, useInputKeyDown)

### LayerStackContext.tsx (90 lines)

Provides global modal/overlay layer stack management with centralized Escape key handling. The provider installs a capture-phase keydown listener that delegates Escape to the topmost layer's `onEscape` handler.

**Hook:** `useLayerStack()` returns `LayerStackAPI` with `registerLayer()`, `unregisterLayer()`, `updateLayerHandler()`, `getTopLayer()`, `closeTopLayer()`, `hasOpenLayers`, `hasOpenModal`

**Usage:** 20+ consumers - every modal and overlay component registers with the layer stack (App.tsx, AgentCreationDialog, BatchRunnerModal, SettingsModal, AutoRunLightbox, etc.)

This is the most widely used context. The layer type system is defined in `src/renderer/types/layer.ts`.

---

## 2. Renderer Types (`src/renderer/types/`)

Four type files defining the core data model for the renderer process.

### index.ts (~943 lines) - Core Type Definitions

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

### contextMerge.ts (178 lines)

Types for context merge/transfer operations between sessions:
- `ContextSource` - A tab or session to merge from
- `MergeRequest` / `MergeResult` - Merge operation request/response
- `GroomingProgress` - Progress updates during long merge operations
- `DuplicateInfo` / `DuplicateDetectionResult` - Duplicate detection across contexts
- `SummarizeRequest` / `SummarizeResult` / `SummarizeProgress` - Context summarization

### layer.ts (108 lines)

Type system for the LayerStackContext:
- `LayerType` = 'modal' | 'overlay'
- `FocusTrapMode` = 'strict' | 'lenient' | 'none'
- `BaseLayer`, `ModalLayer`, `OverlayLayer` - Layer hierarchy
- `Layer` = discriminated union
- `LayerInput` = input types (without auto-generated `id`)
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

Utilities for the web/mobile interface (PWA). These serve the `src/web/` subsystem only and have no overlap with renderer utilities.

### config.ts (153 lines)

Configuration management for the web interface. Reads server-injected `window.__MAESTRO_CONFIG__` containing security token, session ID, and API base paths.

**Key exports:**
- `getMaestroConfig()` - Returns `MaestroConfig` (security token, session/tab IDs, API/WS base paths). Falls back to URL extraction in dev mode.
- `isDashboardMode()` / `isSessionMode()` - View mode checks
- `getCurrentSessionId()` / `getCurrentTabId()` - Current navigation state
- `buildApiUrl(endpoint)` - Constructs full API URLs with token prefix
- `buildWebSocketUrl(sessionId?)` - Constructs WebSocket URLs (ws:/wss:)
- `getDashboardUrl()` / `getSessionUrl(sessionId, tabId?)` - Navigation URLs
- `updateUrlForSessionTab(sessionId, tabId?)` - Updates URL bar without page reload via `history.replaceState`

### cssCustomProperties.ts (270 lines)

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

### logger.ts (171 lines)

Structured logging for the web/PWA interface. All logs prefixed with `[WebUI]`. Uses `BaseLogLevel` and `LOG_LEVEL_PRIORITY` from `shared/logger-types.ts` for consistency with the main process logger.

**Singleton:** `webLogger` with methods `debug()`, `info()`, `warn()`, `error()`, plus `setLevel()`, `setEnabled()`, `enableDebug()`, `reset()`.

Default minimum level: `warn`. Exposed on `window.__webLogger` in development for debugging.

### serviceWorker.ts (181 lines)

Service worker lifecycle management for offline PWA capability.

**Key exports:**
- `registerServiceWorker(config?)` - Registers `sw.js` with token-prefixed path. Handles update detection, offline/online status events, and message forwarding.
- `unregisterServiceWorker()` - Cleans up registration
- `isServiceWorkerSupported()` - Feature detection
- `isOffline()` - Checks `navigator.onLine`
- `skipWaiting()` - Activates waiting worker (for user-confirmed updates)
- `pingServiceWorker()` - Health check with 1-second timeout

### viewState.ts (199 lines)

Persists web UI state to `localStorage` across page refreshes. Two storage keys: `maestro-web-view-state` (view state) and `maestro-web-scroll-state` (scroll positions).

**State persisted:** `ViewState` includes active overlays, session/tab selection, input mode, history panel filter/search, plus `savedAt` timestamp. State older than 5 minutes is considered stale and discarded.

**Key exports:**
- `saveViewState(partial)` / `loadViewState()` / `clearViewState()`
- `saveScrollPosition(view, position)` / `loadScrollState()`
- `debouncedSaveViewState(partial, delay=300)` - 300ms debounce
- `debouncedSaveScrollPosition(view, position, delay=500)` - 500ms debounce (scroll events fire frequently)

### index.ts (27 lines)

Barrel file re-exporting from `cssCustomProperties` and `serviceWorker`. Does NOT re-export `config`, `logger`, or `viewState` - those are imported directly by consumers.

---

## 4. Symphony Runner (`src/main/services/symphony-runner.ts`, 439 lines)

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
- Commits all changes (`git add -A`)
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
- **IPC integration** - Called from `src/main/ipc/handlers/symphony.ts` via `symphony:startContribution` IPC handler. Frontend accesses it through `useSymphony` hook and `SymphonyModal.tsx`.
