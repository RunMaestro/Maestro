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
| Test mock, factory, or setup pattern               | [TEST-PATTERNS.md](docs/agent-guides/TEST-PATTERNS.md)           |
| Renderer service or constant                       | [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md)   |
| Process spawning or listener                       | [PROCESS-SYSTEM.md](docs/agent-guides/PROCESS-SYSTEM.md)         |
| Web/mobile hook or component                       | [WEB-MOBILE.md](docs/agent-guides/WEB-MOBILE.md)                 |
| CLI command or playbook feature                    | [CLI-PLAYBOOKS.md](docs/agent-guides/CLI-PLAYBOOKS.md)           |
| CLI verb mirroring a point-and-click action        | [CLI-UI-PARITY.md](docs/agent-guides/CLI-UI-PARITY.md)           |
| Group chat or Symphony feature                     | [GROUP-CHAT.md](docs/agent-guides/GROUP-CHAT.md)                 |
| Stats, analytics, or dashboard                     | [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)       |
| Prompt template or SpecKit/OpenSpec                | [PROMPTS-SPECS.md](docs/agent-guides/PROMPTS-SPECS.md)           |
| Cue pipeline feature                               | [CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md)             |
| App lifecycle, updater, or power mgmt              | [MAIN-LIFECYCLE.md](docs/agent-guides/MAIN-LIFECYCLE.md)         |
| Stat card, chart, sparkline, or input control      | [WIDGET-LIBRARY.md](docs/agent-guides/WIDGET-LIBRARY.md)         |
| Plugin, sandbox capability, or contribution        | [PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) |

### Commonly-reimplemented functions (do NOT add new copies)

Grep-verified 2026-09-04 (`npm run docs:verify` re-checks every path). This is the INDEX: name, canonical symbols, home file. The full entry for each - the failure it replaced, its invariants, and the traps that made the duplicates wrong - lives in [CANONICAL-UTILITIES.md](docs/agent-guides/CANONICAL-UTILITIES.md). If a name below matches what you are about to write, import the canonical one; read its full entry before extending or working around it.

- **ID generation:** `generateId()`, `generateUUID()` in `src/renderer/utils/ids.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()`, `formatCount()` in `src/shared/formatters.ts`
- **Format tokens:** `formatTokens()`, `formatTokensCompact()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** `humanizeDuration(ms, opts)`, `formatDurationHuman` in `src/shared/duration.ts`
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts`
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Timestamp for a generated file name:** `fileTimestampSlug(dateOrTimestamp?)`, `saveImageToProject()` in `src/shared/formatters.ts`
- **Summing a Codex session's tokens:** `CodexTokenCounts`, `token_count` in `src/shared/codexTokenUsage.ts`
- **Path utilities:** `truncatePath()`, `getParentDir()` in `src/shared/formatters.ts`
- **Classifying a file by extension:** `getFileCategory()`, `isPreviewableFile()` in `src/shared/fileCategories.ts`
- **Strip ANSI:** `stripAnsiCodes()` in `src/shared/stringUtils.ts`
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()` in `src/main/utils/shell-escape.ts`
- **Platform detection:** `isWindows()`, `isMacOS()` in `src/shared/platformDetection.ts`
- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()` in `src/renderer/utils/shortcutFormatter.ts`
- **Whether a chord may be bound at all:** `findReservedShortcutCombo(keys)`, `RESERVED_SHORTCUT_COMBOS` in `src/shared/shortcutKeys.ts`
- **How much of the keyboard the user has mastered:** `collectBoundShortcuts(...maps)`, `countUsedBoundShortcuts(bound, usedIds)` in `src/renderer/constants/keyboardMastery.ts`
- **Naming the OS file manager in copy:** `getFileManagerName(platform)`, `fileManagerName()` in `src/renderer/utils/platformUtils.ts`
- **Color math and contrast:** `readableTextOn()`, `isReadableOn()` in `src/shared/colorContrast.ts`
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **Whether an agent is working right now (main process):** `isAgentBusy(session, processManager)`, `isAiTabProcessActive(...)` in `src/main/utils/agent-busy.ts`
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })`, `theme` in `src/renderer/stores/notificationStore.ts`
- **Center flash (rapid acks):** `notifyCenterFlash({ message, color, detail?, duration? })`, `flashCopiedToClipboard()` in `src/renderer/stores/centerFlashStore.ts`
- **Opening a modal / dashboard by name:** `UI_SURFACES`, `resolveUiSurface()` in `src/shared/uiSurfaces.ts`
- **Whether a modal takes the window over:** `DESTINATION_MODALS`, `registerExternalDestination()` in `src/renderer/stores/modalStore.ts`
- **Toggling the unread filters:** `toggleAllUnreadFilters()`, `toggleTabUnreadFilter()` in `src/renderer/services/unreadFilters.ts`
- **Scheduled Tasks (clock-driven Cue subs):** `src/shared/cue/scheduled-tasks.ts`
- **How much work happened in a group chat:** `computeGroupChatActivity(entries)`, `elapsedTimeMs` in `src/shared/groupChatActivity.ts`
- **Whether an agent is drawn in the Left Bar:** `sessionMatchesFilter()`, `passesUnreadFilter()` in `src/renderer/utils/sidebarMembership.ts`
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`
- **Session mutation:** `updateSessionWith(sessionId, updater)` in `src/renderer/stores/sessionStore.ts`
- **Per-agent git actions:** `useGitAgentActions(session)`, `buildGitWorktreeCommands` in `src/renderer/hooks/git/useGitAgentActions.ts`
- **Focus an AI tab:** `aiTabFocusFields(tabId?)`, `activeFileTabId` in `src/renderer/utils/tabHelpers.ts`
- **Focus a file tab:** `fileTabFocusFields(tabId)` in `src/renderer/utils/tabHelpers.ts`
- **Audio/video playback:** `handleOpenFileTab()`, `enqueueMedia()` in `src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts`
- **Run a shell command from the chat:** `dispatchShellCommand()`, `runShellCommand()` in `src/renderer/services/shellCommand.ts`
- **Revealing output the user asked for, past a paused auto-scroll:** `requestTranscriptScrollToBottom(sessionId, tabId)`, `TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT` in `src/renderer/services/transcriptScroll.ts`
- **Delete the file the user is previewing:** `requestFileDeletion({ path, sshRemoteId?, sessionId? })`, `confirm` in `src/renderer/services/fileDeletion.ts`
- **Telling the Files panel a file appeared or vanished:** `requestFileTreeRefresh(sessionId)`, `nudgeFileTreeForPaths(paths)` in `src/renderer/utils/fileTreeRefresh.ts`
- **Loading a LOCAL file tree:** `walkLocalFileTree()`, `loadFileTree()` in `src/main/utils/file-tree-walk.ts`
- **Ask the model for a shell command (AI command mode):** `requestAiCommand()`, `acceptAiCommand()` in `src/renderer/services/aiCommand.ts`
- **Appending to a transcript entry:** `canAppendToLogEntry(entry, source)`, `isSelfContainedCard(entry)` in `src/renderer/utils/logEntries.ts`
- **Command mode (`!`) is STATE, not a text prefix, and it is a LADDER:** `isShellCommandMode()`, `isAiCommandMode()` in `src/renderer/utils/shellCommandInput.ts`
- **Shell tab completion:** `useTabCompletion()`, `commandMode` in `src/renderer/hooks/input/useTabCompletion.ts`
- **Right-click menu on an image:** `contextmenu`, `onContextMenu` in `src/renderer/components/ImageContextMenuHost.tsx`
- **Font zoom on a reading pane:** `useFontScale(storageKey)`, `AArrowUp` in `src/renderer/hooks/ui/useFontScale.ts`
- **Bare `+` / `-` / `0` zoom on a surface:** `useScaleShortcuts(control, { enabled })`, `useScalePreference` in `src/renderer/hooks/ui/useScaleShortcuts.ts`
- **Whether a surface is the topmost layer:** `useIsTopLayer(priority)`, `MODAL_PRIORITIES` in `src/renderer/hooks/ui/useIsTopLayer.ts`
- **Who asked for this turn (interactive vs automation):** `QUERY_SOURCE_ENV_VAR`, `QuerySource` in `src/shared/querySource.ts`
- **An agent's effective environment:** `resolveAgentEnvironment()`, `isSecretEnvKey()` in `src/shared/agentEnvironment.ts`
- **Whether a login flow can fix an auth failure:** `classifyCredentialKind()`, `credentialKindBlocksLogin()` in `src/shared/providerAuthIdentity.ts`
- **Bucketing Director's Notes bullets:** `bucketNarrativeItems()`, `shouldRenderBuckets()` in `src/shared/directorNotesGrouping.ts`
- **Sortable table header:** `useTableSort()`, `role` in `src/renderer/components/ui/SortableTh.tsx`
- **Graphing a set of documents rather than one:** `scopeDirectory`, `openGraphScope()` in `src/renderer/components/DocumentGraph/graphDataBuilder.ts`
- **A labeled action button in a panel header:** `src/renderer/components/ui/HeaderActionButton.tsx`
- **Highlighting a search hit:** `highlightMatches(text, query, accentColor)`, `searchMatchRanges(text, query)` in `src/renderer/utils/highlightMatches.tsx`
- **Highlighting a FUZZY hit:** `renderFuzzyHighlight(text, indices, styles?)`, `fuzzyMatchWithIndices(text, query)` in `src/renderer/utils/search.ts`
- **Jumping a markdown preview to a heading:** `scrollToHeadingSlug()`, `headingLevelColor()` in `src/renderer/components/FilePreview/shared/headings.ts`
- **Reaching the open file preview from a modal:** `requestHeadingPalette()`, `HEADING_PALETTE_EVENT` in `src/renderer/services/headingPalette.ts`
- **A text box that narrows a list:** `resultLabel`, `AutoRunSearchBar` in `src/renderer/components/ui/FilterInput.tsx`
- **A pane that reads and edits a markdown document:** `generateProseStyles({ theme, scopeSelector })`, `focus` in `src/renderer/components/FilePreview/markdownEditor`
- **`{{template}}` variable autocomplete:** `useTemplateAutocompleteEngine()`, `useTemplateAutocomplete()` in `src/renderer/hooks/input/useTemplateAutocompleteEngine.ts`
- **Keyboard navigation in a `<DualPaneFileEditor>` list:** built in; `onDeleteItem`, `autoFocusList`, `listFocusToken` props
- **Segmented toolbar (sort/filter pill bar):** `borderLeft`, `variant` in `src/renderer/components/ui/SegmentedControl.tsx`
- **Paginating a list already in memory:** `usePagination(items, pageSize, resetKey)`, `useHistoryPagination` in `src/renderer/hooks/ui/usePagination.ts`
- **Following streaming output in a capped box:** `useStickToBottom(contentKey)`, `useScrollIntoView` in `src/renderer/hooks/ui/useStickToBottom.ts`
- **Keeping a virtualized list on its selection:** `scrollToIndex`, `ref` in `src/renderer/hooks/ui/useScrollIntoView.ts`
- **Adding a control to the Left Bar header:** three-zone row in `src/renderer/components/SessionList/SessionList.tsx`; see guide before touching
- **Element width for JS-computed layout:** `useElementWidth(ref, enabled?)`, `ResizeObserver` in `src/renderer/hooks/ui/useElementWidth.ts`
- **Usage Dashboard card tile:** `StatCard` in `src/renderer/components/UsageDashboard/EntityTile.tsx`
- **Fixed-pitch font for shell text:** `resolveFixedPitchFontFamily()`, `resolveTerminalFontFamily()` in `src/renderer/utils/fixedPitchFont.ts`
- **Rendering raw terminal output (ANSI):** `useAnsiConverter(theme)`, `getCachedAnsiHtml(text, theme.id, converter)` in `src/renderer/hooks/ui/useAnsiConverter.ts`
- **Any CLI verb that can move the Maestro view:** `resolveBackgroundFlag()`, `readBackgroundField()` in `src/shared/focusPlacement.ts`
- **Making a tab the visible one:** `aiTabFocusFields`, `fileTabFocusFields` in `src/renderer/utils/tabFocusFields.ts`
- **Record view for one table row:** `RecordDetailModal` in `src/renderer/components/ui/RecordDetailModal.tsx`
- **Previewing a parquet file:** `matchedRows`, `complete` in `src/renderer/components/ParquetViewer/`
- **Modal layer:** `useModalLayer()`, `registerLayer()` in `src/renderer/hooks/ui/useModalLayer.ts`
- **Modal / find-bar ESC pill:** `onClose`, `useCallback` in `src/renderer/components/ui/EscCloseButton.tsx`
- **Dropdown/tooltip anchored to a header element:** `useAnchoredMenuPosition(menuRef, anchorRef)`, `createPortal(..., document.body)` in `src/renderer/hooks/ui/useAnchoredMenuPosition.ts`
- **Remembered textarea height:** `useResizableTextarea()`, `style` in `src/renderer/hooks/ui/useResizableTextarea.ts`
- **Auto-growing composer textarea:** `useAutosizeTextarea()`, `onChange` in `src/renderer/hooks/ui/useAutosizeTextarea.ts`
- **Line numbers beside a `<textarea>`:** `lineNumberGutterMetrics()`, `scrollTop` in `src/renderer/components/ui/TextareaLineNumbers.tsx`
- **A view preference a user sets by clicking:** `usePersistedToggle(storageKey, defaultValue)`, `AutoRunNoticeBanner` in `src/renderer/hooks/ui/usePersistedToggle.ts`
- **Sizing a Document Graph node:** `calculateNodeWidth(label, previewCharLimit)`, `calculateNodeHeight(previewText, previewCharLimit)` in `src/renderer/components/DocumentGraph/mindMapLayouts.ts`
- **A pane width the user sets by dragging:** `useResizablePanel()`, `settingsKey` in `src/renderer/hooks/ui/useResizablePanel.ts`
- **A modal default sized to the screen:** `viewportModalSize({ width, height })`, `defaultSize` in `src/renderer/utils/modalSizing.ts`
- **Focus after render:** `useFocusAfterRender()`, `useFocusOnMount()` in `src/renderer/hooks/utils/useFocusAfterRender.ts`
- **Event listeners:** `useEventListener()`, `addEventListener` in `src/renderer/hooks/utils/useEventListener.ts`
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()` in `src/renderer/hooks/utils/useThrottle.ts`
- **Identity-stable callback:** `useStableCallback()`, `createMarkdownComponents()` in `src/renderer/hooks/utils/useStableCallback.ts`
- **Render markdown:** `components`, `MarkdownRenderer` in `src/renderer/components/Markdown/`
- **Clickable task checkboxes in rendered markdown:** `toggleTaskCheckboxAtLine(content, line)`, `rehypeSourceLine` in `src/renderer/utils/markdownTasks.ts`
- **Model/effort badges on a finished turn:** `turnEffort`, `codifyTurnSettings()` in `src/renderer/components/ui/TurnSettingPills.tsx`
- **The tab a queued item is going to:** `resolveQueuedItemTabName(session, item)`, `resolveQueuedItemTarget()` in `src/renderer/utils/executionQueue.ts`
- **Editing the newest queued message:** `requestEditLastQueuedMessage()`, `editLastQueuedMessage` in `src/renderer/services/editQueuedMessage.ts`
- **Whether a Force Send control exists at all:** `shouldOfferForceSend(eligibility)`, `getForceSendEligibility()` in `src/renderer/utils/executionQueue.ts`
- **Model tier / effort level (`'low' | 'medium' | 'high'`):** `resolveTierModel()`, `resolveEffortLevel()` in `src/shared/modelTiers.ts`
- **Auto Run markers (HITL / halt / model hint):** `scanMaestroMarkers()`, `findPendingHitlGate()` in `src/shared/autorunMarkers.ts`
- **Fence-aware markdown scanning:** `forEachMarkdownLine()`, `UNCHECKED_TASK_REGEX` in `src/shared/markdownTaskScan.ts`
- **Thinking mode (`'off' | 'on' | 'sticky'`):** `THINKING_MODES`, `nextThinkingMode()` in `src/shared/types.ts`

If your use case does NOT match an existing utility, prefer extending the canonical file over creating a new one. If you genuinely need something new, add the full entry to [CANONICAL-UTILITIES.md](docs/agent-guides/CANONICAL-UTILITIES.md) and a one-line index entry above so the next person can find it.

The tracker at [DEDUP-TRACKER.md](docs/agent-guides/DEDUP-TRACKER.md) lists all known duplication findings.

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

| ID              | Name          | Status     |
| --------------- | ------------- | ---------- |
| `claude-code`   | Claude Code   | **Active** |
| `codex`         | OpenAI Codex  | **Active** |
| `opencode`      | OpenCode      | **Active** |
| `factory-droid` | Factory Droid | **Active** |
| `copilot-cli`   | Copilot-CLI   | **Beta**   |
| `terminal`      | Terminal      | Internal   |

See [[CLAUDE-AGENTS.md]] for capabilities and integration details.

---

## Quick Commands

```bash
npm run dev           # Development with hot reload (isolated data, can run alongside production)
npm run dev:prod-data # Development using production data (close production app first)
npm run dev:web       # Web interface development
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
├── web/                    # Web/mobile interface
│   ├── mobile/            # Mobile-optimized React app
│   └── components/        # Shared web components
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

| Task                          | Primary Files                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler               | `src/main/index.ts`, `src/main/preload/` (one module per namespace)                                                                                                                                                                                              |
| Add UI component              | `src/renderer/components/`                                                                                                                                                                                                                                       |
| Add web/mobile component      | `src/web/components/`, `src/web/mobile/`                                                                                                                                                                                                                         |
| Add keyboard shortcut         | `src/renderer/constants/shortcuts.ts`, `App.tsx`                                                                                                                                                                                                                 |
| Add theme                     | `src/renderer/constants/themes.ts`                                                                                                                                                                                                                               |
| Add modal                     | Component + `src/renderer/constants/modalPriorities.ts`                                                                                                                                                                                                          |
| Add tab overlay menu          | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]]                                                                                                                                                                                                     |
| Add setting                   | `src/shared/settingsMetadata.ts` (metadata), `src/renderer/stores/settingsStore.ts`, `src/main/stores/defaults.ts`, AND `src/renderer/components/Settings/searchableSettings.ts` + `data-setting-id` wrapper on rendered control (see [[CLAUDE-PATTERNS.md]] §3) |
| Add template variable         | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts`                                                                                                                                                                                     |
| Modify system prompts         | `src/prompts/*.md` (wizard, Auto Run, etc.) or edit via **Maestro Prompts** tab in Settings                                                                                                                                                                      |
| Customize prompts             | Use **Maestro Prompts** tab in Settings, or edit `userData/core-prompts-customizations.json`                                                                                                                                                                     |
| Add new prompt                | `src/prompts/*.md`, `src/shared/promptDefinitions.ts` (add to `CORE_PROMPTS` array and `PROMPT_IDS`)                                                                                                                                                             |
| Add Spec-Kit command          | `src/prompts/speckit/`, `src/main/speckit-manager.ts`                                                                                                                                                                                                            |
| Add OpenSpec command          | `src/prompts/openspec/`, `src/main/openspec-manager.ts`                                                                                                                                                                                                          |
| Add CLI command               | `src/cli/commands/`, `src/cli/index.ts`                                                                                                                                                                                                                          |
| Add new agent                 | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md)                                                                                    |
| Add agent output parser       | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                 |
| Add agent session storage     | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                   |
| Add agent error patterns      | `src/shared/agentErrorPatterns.ts`                                                                                                                                                                                                                               |
| Add agent context window      | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                            |
| Add playbook feature          | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                  |
| Add marketplace playbook      | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                      |
| Playbook import/export        | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                  |
| Modify wizard flow            | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                     |
| Add tour step                 | `src/renderer/components/Wizard/tour/tourSteps.tsx`                                                                                                                                                                                                              |
| Modify file linking           | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                            |
| Add documentation page        | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                       |
| Add documentation screenshot  | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                     |
| MCP server integration        | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                     |
| Add stats/analytics feature   | `src/main/stats/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                   |
| Add Usage Dashboard chart     | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                        |
| Add Document Graph feature    | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                               |
| Add colorblind palette        | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                   |
| Add performance metrics       | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                              |
| Capture/analyze perf trace    | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces                                                                                                |
| Add power management          | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                   |
| Spawn agent with SSH support  | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                        |
| Modify file preview tabs      | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                 |
| Add parquet viewer feature    | `src/renderer/components/ParquetViewer/` (UI), `src/main/parquet/` (query engine), `src/shared/parquet/` (filter language + wire types)                                                                                                                          |
| Add Director's Notes feature  | `src/renderer/components/DirectorNotes/`, `src/shared/directorNotesNarrative.ts`, `src/shared/directorNotesGrouping.ts`, `src/main/ipc/handlers/director-notes.ts`                                                                                               |
| Add Encore Feature            | `src/renderer/types/index.ts` (flag), `useSettings.ts` (state), `SettingsModal.tsx` (toggle UI), gate in `App.tsx` + keyboard handler                                                                                                                            |
| Modify history components     | `src/renderer/components/History/`                                                                                                                                                                                                                               |
| Modify history activity graph | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                               |
| Add Cue event type            | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                        |
| Add Cue template variable     | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                |
| Modify Cue modal              | `src/renderer/components/CueModal/`                                                                                                                                                                                                                              |
| Configure Cue engine          | `src/main/cue/cue-engine.ts`, `src/main/ipc/handlers/cue.ts`                                                                                                                                                                                                     |
| Add terminal feature          | `src/renderer/components/XTerminal.tsx`, `src/renderer/components/TerminalView.tsx`                                                                                                                                                                              |
| Modify terminal tabs          | `src/renderer/utils/terminalTabHelpers.ts`, `src/renderer/stores/tabStore.ts`                                                                                                                                                                                    |

---

## Critical Implementation Guidelines

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
  SSH and their prompt shouldn't leak to the local machine (see
  `sshUnresolvedFailure()` in `src/cli/services/agent-spawner.ts` for the CLI's
  version of this).

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

When driving the running app over Chrome DevTools Protocol (e.g. one-off `scripts/cdp-*.js` harnesses for reproducing a bug, clicking through a flow, or capturing screenshots), treat those scripts as **throwaway**. They are debugging scaffolding, not shipped code:

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
