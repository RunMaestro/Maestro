# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation Index

This guide has been split into focused sub-documents for progressive disclosure:

| Document                             | Description                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [[CLAUDE-PATTERNS.md]]               | Core implementation patterns (process management, settings, modals, themes, Auto Run, SSH, Encore Features)                                                              |
| [[CLAUDE-IPC.md]]                    | IPC API surface (`window.maestro.*` namespaces)                                                                                                                          |
| [[CLAUDE-PERFORMANCE.md]]            | Performance best practices (React optimization, debouncing, batching)                                                                                                    |
| [[CLAUDE-WIZARD.md]]                 | Onboarding Wizard, Inline Wizard, and Tour System                                                                                                                        |
| [[CLAUDE-FEATURES.md]]               | Usage Dashboard and Document Graph features                                                                                                                              |
| [[CLAUDE-AGENTS.md]]                 | Supported agents and capabilities                                                                                                                                        |
| [[CLAUDE-SESSION.md]]                | Session interface (agent data model) and code conventions                                                                                                                |
| [[CLAUDE-PLATFORM.md]]               | Cross-platform concerns (Windows, Linux, macOS, SSH remote)                                                                                                              |
| [[CLAUDE-CUE.md]]                    | Cue automation engine: architecture, dispatch flow, lifecycle, gotchas (read before editing `src/main/cue/`)                                                             |
| [[CLAUDE-PLUGINS.md]]                | Plugin system architecture: tiers, sandbox, broker, capabilities, contributions, signing, trust model (read before editing `src/main/plugins/` or `src/shared/plugins/`) |
| [[CLAUDE-SETTINGS.md]]               | Settings modal style guide: typography, color, dimming, spacing, primitives, registration checklist (read before editing `src/renderer/components/Settings/`)            |
| [AGENT_SUPPORT.md](AGENT_SUPPORT.md) | Detailed agent integration guide                                                                                                                                         |

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
| Group chat or Symphony feature                     | [GROUP-CHAT.md](docs/agent-guides/GROUP-CHAT.md)                 |
| Stats, analytics, or dashboard                     | [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)       |
| Prompt template or SpecKit/OpenSpec                | [PROMPTS-SPECS.md](docs/agent-guides/PROMPTS-SPECS.md)           |
| Cue pipeline feature                               | [CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md)             |
| App lifecycle, updater, or power mgmt              | [MAIN-LIFECYCLE.md](docs/agent-guides/MAIN-LIFECYCLE.md)         |
| Stat card, chart, sparkline, or input control      | [WIDGET-LIBRARY.md](docs/agent-guides/WIDGET-LIBRARY.md)         |
| Plugin, sandbox capability, or contribution        | [PLUGIN-DEVELOPMENT.md](docs/agent-guides/PLUGIN-DEVELOPMENT.md) |

### Commonly-reimplemented functions (do NOT add new copies)

Grep-verified 2026-04-10. Import from these canonical locations:

- **ID generation:** `generateId()` in `src/renderer/utils/ids.ts`, `generateUUID()` in `src/shared/uuid.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()` in `src/shared/formatters.ts`
- **Format tokens:** `formatTokens()`, `formatTokensCompact()`, `estimateTokenCount()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** everything in `src/shared/duration.ts` (re-exported from `formatters.ts`). `humanizeDuration(ms, opts)` is the one engine; `formatDurationHuman` / `Compact` / `Verbose` / `Parts` / `Decimal` / `Long` / `Words`, plus `formatActiveTime` and `formatElapsedTime`, are presets over it. **Never hand-roll another `Math.floor(ms / 86400000)` ladder** - a dozen near-identical copies had already drifted apart on where the ladder stops, whether a zero segment is padded (`"2h 0m"` vs `"2h"`), and whether a countdown rounds up. Those are options (`units`, `maxUnits`, `style`, `keepZeroUnits`, `adjacentUnits`, `round`, `fallback`), so pick a preset or call the engine. Unit sizes are in `DURATION_MS` - don't redeclare `const DAY = 86400000`. See [SHARED-UTILS.md → Durations](docs/agent-guides/SHARED-UTILS.md#durations-srcshareddurationts---both).
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts - common mistake). Two-decimal `"123.45ms"` / `"1.23s"` for perf traces only; it caps at seconds, so a multi-day span comes out as a giant seconds float. For anything user-facing use `src/shared/duration.ts`.
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Path utilities:** `truncatePath()`, `getParentDir()`, `truncateCommand()`, `isAbsolutePath()`, `getBasename()` in `src/shared/formatters.ts`
- **Strip ANSI:** `stripAnsiCodes()` in `src/shared/stringUtils.ts`
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts` (works in both processes). In renderer-only code prefer `isWindowsPlatform()`, `isMacOSPlatform()`, `isLinuxPlatform()` in `src/renderer/utils/platformUtils.ts`. Never read `process.platform` in the renderer: the `process` polyfill (`src/renderer/public/process-shim.js`) reports the sentinel `'browser'`, and `navigator.platform` is deprecated and unreliable.
- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()`, `formatMetaKey()` (symbol: `⌘` / `Ctrl`), `formatMetaKeyName()` (prose: `Command` / `Ctrl`) in `src/renderer/utils/shortcutFormatter.ts`. Do NOT hard-code `⌘`, `Cmd+`, or `Ctrl+` in UI copy, tooltips, or setting descriptions - it renders the wrong key on the other platform.
- **Color math and contrast:** `readableTextOn()`, `isReadableOn()`, `contrastRatio()`, `relativeLuminance()`, `blendColors()`, `transparentize()`, `adjustBrightness()`, `hexToRgb()` in `src/shared/colorContrast.ts`. Whenever a foreground and its background are BOTH derived from theme colors (diagram fills, chart labels, badges, generated SVG), run the foreground through `readableTextOn(preferred, backgrounds)` so a theme whose accent sits near its text color can't paint near-identical colors on top of each other. It returns the preferred color untouched when it already clears WCAG AA and nudges the theme's own color otherwise, so nothing snaps to hard-coded black/white.
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })` in `src/renderer/stores/notificationStore.ts`. Use for async results, errors, and persistent/dismissable messages. Same five-color design language as Center Flash: `green | yellow | orange | red | theme` (default `theme`). Set `dismissible: true` (or pass `--dismissible` from `maestro-cli notify toast`) when the user MUST acknowledge - disables auto-dismiss, requires click to close, and emphasizes the X button. Cannot combine `dismissible` with `duration`/`--timeout`. External CLI cap: 60 seconds (use `--dismissible` for sticky). **Click actions** (data-driven, survive the IPC bridge): pass `clickAction: { kind: 'jump-session', sessionId, tabId? } | { kind: 'open-file', sessionId, path } | { kind: 'open-url', url }` for what should happen when the toast body is clicked, or use the legacy `sessionId`/`tabId` fields for plain agent jump. From the CLI: `--agent` (+ optional `--tab`), `--open-file <path>` (requires `--agent`), `--open-url <url>` (mutually exclusive with `--open-file`). `--action-url` / `--action-label` render an inline link button beneath the message and are independent of the body click. **Source-agent label:** pass `sourceAgent` (CLI `--source-agent <label>`) to stamp which agent/pipeline fired the toast in the header strip. It's store-independent, so it shows even when the agent isn't loaded in the Left Bar (the name resolved from `--agent`/`sessionId` only renders when that agent is in the desktop store) - use it for cron/watchdog toasts. The explicit label wins over the resolved name for display; pair it with `--agent` to also get click-to-jump. Do NOT pass renderer-only callbacks across the bridge - use `clickAction` instead.
- **Center flash (rapid acks):** `notifyCenterFlash({ message, color, detail?, duration? })` in `src/renderer/stores/centerFlashStore.ts`; clipboard helper `flashCopiedToClipboard()` in `src/renderer/utils/flashCopiedToClipboard.ts`. Use for momentary "I did the thing" confirmations of user-initiated actions. Five-color design language: `green | yellow | orange | red | theme` - default `theme` matches the active Maestro theme. External integrations can fire flashes via `maestro-cli notify flash <message> --color <color>`. Do NOT roll your own center-screen overlay, useState+setTimeout flash, add a sixth color, or use a Toast for clipboard acks. Single visible flash at a time, themed frosted-glass card mounted once in `App.tsx`. Full decision rules, color palette, and design language: [UI-PATTERNS.md → Center Flash System](docs/agent-guides/UI-PATTERNS.md#center-flash-system-rapid-temporary-notifications).
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`; `useActiveSession()` hook in `src/renderer/hooks/session/useActiveSession.ts`
- **Session mutation:** `updateSessionWith(sessionId, updater)` in `src/renderer/stores/sessionStore.ts` (do NOT hand-roll `setSessions(prev => prev.map(...))`)
- **Per-agent git actions:** `useGitAgentActions(session)` in `src/renderer/hooks/git/useGitAgentActions.ts` - the shared View Git Log / View Git Diff / Pull / Push / Change Branch / Create PR / Configure Worktrees set behind ALL THREE surfaces that offer it: the header branch pill dropdown, the Left Bar right-click menu, and the command palette (`buildGitWorktreeCommands`). Also exports `resolveGitCwd()` / `resolveGitSshRemoteId()`. Adding a git action means extending this hook and surfacing it in all three, not re-deriving cwd + SSH id + modal calls. See [REMAINING-SYSTEMS.md](docs/agent-guides/REMAINING-SYSTEMS.md#usegitagentactions-srcrendererhooksgitusegitagentactionsts).
- **Focus an AI tab:** `aiTabFocusFields(tabId?)` in `src/renderer/utils/tabHelpers.ts` - spread into a session patch (`{ ...s, ...aiTabFocusFields(tabId) }`) to land on an AI tab. It clears `activeFileTabId`/`activeTerminalTabId`/`activeBrowserTabId` and sets `inputMode: 'ai'`. Do NOT hand-roll the literal: those non-AI tab types outrank the AI tab in the render precedence, so omitting even one leaves the previous view on screen.
- **Focus a file tab:** `fileTabFocusFields(tabId)` in `src/renderer/utils/tabHelpers.ts` - the file-tab counterpart to the above. Clears the terminal and browser selections (both outrank the file tab) and sets `inputMode: 'ai'`.
- **Audio/video playback:** media NEVER becomes a file preview tab. `handleOpenFileTab()` (`src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts`) is the single choke point every open path funnels through, and it diverts playable media to `useMediaPlaybackStore.openMedia()` before a tab can be created. The only surface media appears on is `FloatingMediaPlayer` - there is no docked/in-panel placement, so do NOT add one. Exactly ONE player exists app-wide, owned by `MediaPlaybackHost` (`src/renderer/components/MediaPlayback/`), mounted once in `App.tsx` and never unmounted: anything rendered per-tab or per-agent is torn down on switch, and removing a media element from the document pauses it. Do NOT mount a second player to play two files at once - the single-player invariant is what makes overlapping audio impossible; `stepMediaItem()` walks the queue in open order and the history menu jumps by recency. Classify media with `getOpenedMediaKind()` in `src/renderer/utils/mediaItems.ts`. User docs: [media-player.md](docs/media-player.md).
- **Run a shell command from the chat:** `runShellCommand()` / `cancelShellCommand()` / `resolveCommandCwd()` in `src/renderer/services/shellCommand.ts`. This is command mode (`!command` in the AI composer). Any new surface that runs a one-off command and shows its output in a transcript should reuse this rather than calling `window.maestro.process.runCommand` directly - the synthetic `{sessionId}-shell-{runId}` id is what keeps the output out of the agent listeners. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#shellcommandts-200-lines).
- **Appending to a transcript entry:** `canAppendToLogEntry(entry, source)` / `isSelfContainedCard(entry)` in `src/renderer/utils/logEntries.ts`. A `LogEntry` is either an open stream (coalesce consecutive chunks into it) or a self-contained card that owns its own text (`shellCommand`, `retryOutageId`, `recoveryAction`, `aiCommand`, `metadata.hiddenProgress`, `metadata.toolState`). Cards keep a NATURAL source - a `!` command's card is `source: 'stdout'` because its body really is terminal output - so **never gate coalescing on `source` alone**; that's how agent replies ended up rendered inside a command's output box. Adding a new card kind means adding its marker to `isSelfContainedCard`, which fixes every coalescing site at once.
- **Command mode (`!`) is STATE, not a text prefix:** the live flag is `composerInputStore.aiCommandMode`, persisted per tab as `AITab.commandMode`. The bang is consumed on entry and never appears in the draft, so NEVER test the text for a leading `!` to detect the mode - a real command can contain bangs, and the draft won't start with one. The invariant: the same string is a shell command or an agent message depending only on this flag, so any path that persists or restores `inputValue` MUST carry `commandMode` with it (`syncAiInputToSession` reads it from the store itself so a caller can't forget). Helpers: `detectCommandModeEntry()` and `stripShellCommandEscape()` in `src/renderer/utils/shellCommandInput.ts`. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#command-mode-is-state-not-a-text-prefix).
- **Shell tab completion:** `useTabCompletion()` in `src/renderer/hooks/input/useTabCompletion.ts` serves BOTH the terminal composer and command mode, told apart by its third `commandMode` argument (the text can't say which - a command line looks the same either way). Terminal mode completes against `shellCwd` + `shellCommandHistory`; command mode completes against the project root + the bang-prefixed entries in `aiCommandHistory`, because a command-mode command runs at the agent's `cwd` regardless of where a terminal tab has `cd`-ed. Suggestion values are plain command lines in both cases. Add completion sources here, not in a parallel hook.
- **Right-click menu on an image:** already done, app-wide. `<ImageContextMenuHost>` (`src/renderer/components/ImageContextMenuHost.tsx`) is mounted once in `App.tsx` and runs ONE delegated `contextmenu` listener that resolves the image from the click target, so raster `<img>`, inline `<svg>`, Mermaid charts, thumbnails, and the lightbox all get Copy Image / Save to Project / Save As with **zero per-surface wiring**. Do NOT add an `onContextMenu` to a new image surface or hand-roll copy/save buttons - a new surface is covered the moment it renders. To opt a surface out (it owns its own right-click behavior), put `data-no-image-menu` on its container. Export helpers live in `src/renderer/utils/imageExport.ts` (`saveImageToProject()` writes to `.maestro/diagrams/` and works over SSH). See [UI-PATTERNS.md → Right-Click Image Menu](docs/agent-guides/UI-PATTERNS.md#right-click-image-menu-imagecontextmenuhost).
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Modal / find-bar ESC pill:** `<EscCloseButton>` in `src/renderer/components/ui/EscCloseButton.tsx`. Every modal, palette, and find bar needs a graphical exit - Escape alone strands users on remote desktop and tablets. Pass an `onClose` that does exactly what the Escape handler does (extract it into a shared `useCallback` rather than duplicating the body). Do NOT hand-roll the `px-2 py-0.5 rounded text-xs font-bold` pill; the inert `<div>` version used to be copy-pasted in nine places. See [UI-PATTERNS.md → Every Modal Needs a Graphical Exit](docs/agent-guides/UI-PATTERNS.md#every-modal-needs-a-graphical-exit-escclosebutton).
- **Dropdown/tooltip anchored to a header element:** `useAnchoredMenuPosition(menuRef, anchorRef)` in `src/renderer/hooks/ui/useAnchoredMenuPosition.ts`, rendered via `createPortal(..., document.body)`. Anything anchored inside the Main Panel header MUST use this. `absolute top-full` is silently clipped: the header wraps its left cluster in `overflow-hidden` boxes only as tall as the pill, which is how the git pill's hover card and the git status tooltip were both invisible for months. Bare `position: fixed` doesn't help either, because `.header-container` sets `container-type: inline-size` (implying `contain: layout`), making the header a containing block for fixed descendants. Since jsdom has no layout engine, a test asserting `toBeInTheDocument()` passes while the element is invisible - assert it is NOT a descendant of the header subtree instead.
- **Remembered textarea height:** `useResizableTextarea()` in `src/renderer/hooks/ui/useResizableTextarea.ts` - every `resize-y` textarea should keep the height the user dragged it to, across reopen and app restart. Spread its `style` last and pass `externalRef` if the component already owns a ref. See [UI-PATTERNS.md → Resizable Textareas](docs/agent-guides/UI-PATTERNS.md#resizable-textareas).
- **Focus after render:** `useFocusAfterRender()` in `src/renderer/hooks/utils/useFocusAfterRender.ts` (do NOT use `useEffect + setTimeout(() => ref.focus())`)
- **Event listeners:** `useEventListener()` in `src/renderer/hooks/utils/useEventListener.ts` (do NOT pair raw `addEventListener`/`removeEventListener` inside useEffect)
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()`, `useThrottledCallback()` in `src/renderer/hooks/utils/useThrottle.ts` (filename is misleading - all three live here)
- **Render markdown:** `<Markdown preset="chat | document | wizard-bubble | release-notes">` from `src/renderer/components/Markdown/` (do NOT hand-roll `<ReactMarkdown>` + a per-surface `components`/plugin map). The chat preset is what `MarkdownRenderer` wraps. Shared internals: `buildMarkdownPlugins` (`Markdown/plugins.ts`), `preprocessMarkdown` (`Markdown/preprocess.ts`), leaf renderers in `Markdown/components/*`, and the document component map `createMarkdownComponents()` in `src/renderer/utils/markdownConfig.ts`. See [UI-PATTERNS.md → `<Markdown>`](docs/agent-guides/UI-PATTERNS.md).

If your use case does NOT match an existing utility, prefer extending the canonical file over creating a new one. If you genuinely need something new, add it to the relevant guide in `docs/agent-guides/` so the next person can find it.

The tracker at [DEDUP-TRACKER.md](docs/agent-guides/DEDUP-TRACKER.md) lists all known duplication findings.

---

## Agent Behavioral Guidelines

Core behaviors for effective collaboration. Failures here cause the most rework.

### Surface Assumptions Early

Before implementing non-trivial work, explicitly state assumptions. Never silently fill in ambiguous requirements - the most common failure mode is guessing wrong and running with it. Format: "Assumptions: 1) X, 2) Y. Correct me now or I proceed."

### Manage Confusion Actively

When encountering inconsistencies, conflicting requirements, or unclear specs: **STOP**. Name the specific confusion, present the tradeoff, and wait for resolution. Bad: silently picking one interpretation. Good: "I see X in file A but Y in file B - which takes precedence?"

### Push Back When Warranted

Not a yes-machine. When an approach has clear problems: point out the issue directly, explain the concrete downside, propose an alternative, then accept the decision if overridden. Sycophancy ("Of course!") followed by implementing a bad idea helps no one.

### Enforce Simplicity

Natural tendency is to overcomplicate - actively resist. Before finishing: Can this be fewer lines? Are abstractions earning their complexity? Would a senior dev say "why didn't you just..."? Prefer the boring, obvious solution.

### Maintain Scope Discipline

Touch only what's asked. Do NOT: remove comments you don't understand, "clean up" orthogonal code, refactor adjacent systems as side effects, or delete seemingly-unused code without approval. Surgical precision, not unsolicited renovation.

### Dead Code Hygiene

After refactoring: identify now-unreachable code, list it explicitly, ask "Should I remove these now-unused elements: [list]?" Don't leave corpses. Don't delete without asking.

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
- **Cue Modal** - Dashboard for managing Cue subscriptions and viewing activity (`CueModal.tsx`)

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
│   ├── preload.ts          # Secure IPC bridge
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
| Add IPC handler               | `src/main/index.ts`, `src/main/preload.ts`                                                                                                                                                                                                                       |
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
| Add new agent                 | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [AGENT_SUPPORT.md](AGENT_SUPPORT.md)                                                                                          |
| Add agent output parser       | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                 |
| Add agent session storage     | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                   |
| Add agent error patterns      | `src/main/parsers/error-patterns.ts`                                                                                                                                                                                                                             |
| Add agent context window      | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                            |
| Add playbook feature          | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                  |
| Add marketplace playbook      | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                      |
| Playbook import/export        | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                  |
| Modify wizard flow            | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                     |
| Add tour step                 | `src/renderer/components/Wizard/tour/tourSteps.ts`                                                                                                                                                                                                               |
| Modify file linking           | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                            |
| Add documentation page        | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                       |
| Add documentation screenshot  | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                     |
| MCP server integration        | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                     |
| Add stats/analytics feature   | `src/main/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                         |
| Add Usage Dashboard chart     | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                        |
| Add Document Graph feature    | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                               |
| Add colorblind palette        | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                   |
| Add performance metrics       | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                              |
| Capture/analyze perf trace    | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces                                                                                                |
| Add power management          | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                   |
| Spawn agent with SSH support  | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                        |
| Modify file preview tabs      | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                 |
| Add Director's Notes feature  | `src/renderer/components/DirectorNotes/`, `src/main/ipc/handlers/director-notes.ts`                                                                                                                                                                              |
| Add Encore Feature            | `src/renderer/types/index.ts` (flag), `useSettings.ts` (state), `SettingsModal.tsx` (toggle UI), gate in `App.tsx` + keyboard handler                                                                                                                            |
| Modify history components     | `src/renderer/components/History/`                                                                                                                                                                                                                               |
| Modify history activity graph | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                               |
| Add Cue event type            | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                        |
| Add Cue template variable     | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                |
| Modify Cue modal              | `src/renderer/components/CueModal.tsx`                                                                                                                                                                                                                           |
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
