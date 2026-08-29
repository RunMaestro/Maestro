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

### Commonly-reimplemented functions (do NOT add new copies)

Grep-verified 2026-04-10. Import from these canonical locations:

- **ID generation:** `generateId()` in `src/renderer/utils/ids.ts`, `generateUUID()` in `src/shared/uuid.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()` (compact: `1.2M`) and `formatCount()` (exact, grouped: `1,204,993`) in `src/shared/formatters.ts`. Pick by whether the digits ARE the information - a badge wants the magnitude, a filtered row count wants the number.
- **Format tokens:** `formatTokens()`, `formatTokensCompact()`, `estimateTokenCount()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Humanized durations:** everything in `src/shared/duration.ts` (re-exported from `formatters.ts`). `humanizeDuration(ms, opts)` is the one engine; `formatDurationHuman` / `Compact` / `Verbose` / `Parts` / `Decimal` / `Long` / `Words`, plus `formatActiveTime`, `formatElapsedTime`, and `formatElapsedTicker` (thinking pill: `"0m 3s"`), are presets over it. **Never hand-roll another `Math.floor(ms / 86400000)` ladder** - a dozen near-identical copies had already drifted apart on where the ladder stops, whether a zero segment is padded (`"2h 0m"` vs `"2h"`), and whether a countdown rounds up. Those are options (`units`, `maxUnits`, `style`, `keepZeroUnits`, `keepLeadingZero`, `adjacentUnits`, `round`, `fallback`), so pick a preset or call the engine. Unit sizes are in `DURATION_MS` - don't redeclare `const DAY = 86400000`. See [SHARED-UTILS.md → Durations](docs/agent-guides/SHARED-UTILS.md#durations-srcshareddurationts---both).
- **Format profiling spans (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts - common mistake). Two-decimal `"123.45ms"` / `"1.23s"` for perf traces only; it caps at seconds, so a multi-day span comes out as a giant seconds float. For anything user-facing use `src/shared/duration.ts`.
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format a calendar day:** `formatCalendarDay()` in `src/shared/formatters.ts` renders a `YYYY-MM-DD` string as `"Jul 10, 2026"`. It reads the parts out of the string and builds a LOCAL date, because `new Date('2026-07-10')` is parsed as UTC midnight and renders the day before everywhere west of Greenwich.
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Path utilities:** `truncatePath()`, `getParentDir()`, `truncateCommand()`, `isAbsolutePath()`, `getBasename()`, `joinPath()` in `src/shared/formatters.ts` (`joinPath` is the renderer-safe `path.join`: it uses whichever separator the base path speaks, so Windows and SSH-remote POSIX paths both survive)
- **Saving a rendered diagram:** `saveSvgToProject()` in `src/renderer/utils/svgExport.ts` writes into the project's `.maestro/diagrams/` (`DIAGRAMS_DIR` in `src/shared/maestro-paths.ts`). Every SVG surface (chat inline `<svg>`, Mermaid, Fast-tier markdown) exports through the one `SvgContextMenu` + `useSvgContextMenu` pair. Do NOT add a new download path or a second save destination.
- **Strip ANSI:** `stripAnsiCodes()` in `src/shared/stringUtils.ts`
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
- **HTTP request from the main process:** `fetchWithTimeout(url, options?, timeoutMs?)` in `src/main/utils/fetchWithTimeout.ts`, with `isFetchTimeoutError()` and `DEFAULT_FETCH_TIMEOUT_MS`. A bare `fetch()` has no timeout, so a stalled socket hangs the caller forever: in the main process that is an IPC handler that never settles and a renderer spinner that never stops. Do NOT hand-roll `new AbortController()` + `setTimeout`, and do NOT add another local `fetchWithTimeout` - there used to be three functions with that exact name and three different signatures. It composes a caller-supplied `signal` rather than overwriting it, so passing your own cancellation still works. Callers needing extra behaviour wrap it locally (see `fetchBmadResource()` in `src/main/bmad-manager.ts`).
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts` (works in both processes). In renderer-only code prefer `isWindowsPlatform()`, `isMacOSPlatform()`, `isLinuxPlatform()` in `src/renderer/utils/platformUtils.ts`. Never read `process.platform` in the renderer: the `process` polyfill (`src/renderer/public/process-shim.js`) reports the sentinel `'browser'`, and `navigator.platform` is deprecated and unreliable.
- **Modifier-key display text:** `formatKey()`, `formatShortcutKeys()`, `formatMetaKey()` (symbol: `⌘` / `Ctrl`), `formatMetaKeyName()` (prose: `Command` / `Ctrl`), `formatAltKeyName()` (prose: `Option` / `Alt`) in `src/renderer/utils/shortcutFormatter.ts`. Do NOT hard-code `⌘`, `Cmd+`, `Ctrl+`, `Option`, or `Alt` in UI copy, tooltips, or setting descriptions - it renders the wrong key on the other platform. Outside the renderer (CLI, main process) use `formatShortcutKeysFor(keys, isMac)` / `formatKeyFor()` in `src/shared/shortcutKeys.ts`, which owns the key maps; the renderer file is just the platform binding over it.
- **Whether a chord may be bound at all:** `findReservedShortcutCombo(keys)` over `RESERVED_SHORTCUT_COMBOS` in `src/shared/shortcutKeys.ts`. `Cmd/Ctrl+Shift+Arrow` is the OS's select-to-end inside a text field, and a Maestro binding on one wins in every input in the app, so the user loses the native behavior with no way to tell that apart from a broken text box. It is checked at BOTH ends and the second half is the one that is easy to skip: the recorder (`ShortcutsTab`) refuses a fresh binding, and `migrateShortcuts()` in `settingsStore.ts` strips one already on disk and falls back to the bundled default. A recorder-only guard leaves anyone who already bound the chord broken forever. The table is written in terms of `Meta` and comparison collapses `Ctrl`/`Command` into it, matching `eventMatchesShortcutKeys`, so one entry covers every platform - do NOT add a separate `Ctrl` row.
- **Naming the OS file manager in copy:** `getFileManagerName(platform)` / `fileManagerName()` in `src/renderer/utils/platformUtils.ts` return the bare noun (`Finder` / `Explorer` / `File Manager`), and `getRevealLabel()` / `getOpenInLabel()` are built from it. Do NOT hard-code `Finder` in a hint, tooltip, or menu label - it reads wrong on Windows, and the failure is invisible on a Mac dev machine. Same class of bug as hard-coding `⌘`.
- **Touch primitives:** `isCoarsePointer()`, `triggerHaptic()`, `supportsHaptics()`, `HAPTIC_PATTERNS`, `GESTURE_THRESHOLDS`, `MIN_TOUCH_TARGET` in `src/renderer/utils/touch.ts` (do NOT re-derive `navigator.vibrate` calls or `matchMedia('(pointer: coarse)')` queries)
- **Long-press gesture:** `useLongPress()` in `src/renderer/hooks/utils/useLongPress.ts` (scroll-aware touch long-press that opens right-click affordances like context menus and tab overlays; do NOT hand-roll `setTimeout` + `touchmove`)
- **Color math and contrast:** `readableTextOn()`, `isReadableOn()`, `contrastRatio()`, `relativeLuminance()`, `blendColors()`, `transparentize()`, `adjustBrightness()`, `hexToRgb()` in `src/shared/colorContrast.ts`. Whenever a foreground and its background are BOTH derived from theme colors (diagram fills, chart labels, badges, generated SVG), run the foreground through `readableTextOn(preferred, backgrounds)` so a theme whose accent sits near its text color can't paint near-identical colors on top of each other. It returns the preferred color untouched when it already clears WCAG AA and nudges the theme's own color otherwise, so nothing snaps to hard-coded black/white.
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **Which providers a user can pick:** `AGENT_PICKER_META` / `PICKABLE_AGENT_IDS` / `getAgentPickerMeta()` in `src/shared/agentMetadata.ts`. ONE registry feeds all three provider pickers: the New Agent modal (`SUPPORTED_AGENTS` re-exports it), the New Agent Wizard's tile strip (`AGENT_TILES` is derived from it), and the Group Chat moderator dropdown (the same tiles, filtered by what detection found). Do NOT hand-write a fourth list of agent ids for a new picker: the three used to be written by hand, and Grok and Qwen3 Coder shipped selectable in the New Agent modal while being absent from the wizard and un-pickable as a moderator. The record is keyed by `AgentId`, so a new id fails to compile until it is either given metadata or explicitly set to `null` (internal or unshipped). **Order is derived, not authored:** `PICKABLE_AGENT_IDS` sorts by display name, so every picker shows one predictable alphabetical list and a new entry can go anywhere in the record. Do NOT re-sort the record by hand to move a provider, and do NOT default a picker to the first entry - that hands a fresh Group Chat to whichever beta provider sorts first. Auto-selection reads `AGENT_AUTOSELECT_ORDER` (a preference list) and picks the first entry the user actually has installed. Adding a provider also means a `case` in `AgentLogo` and a glyph in `AGENT_ICONS`, or the tile draws a blank fallback ring. What a picker SHOWS is narrowed again at render time by detection - see `filterToAvailableProviders` below - so a provider missing from a picker may simply not be installed on that machine. Full checklist: [AGENT_SUPPORT.md → Step 2.6](AGENT_SUPPORT.md#step-26-register-the-provider-in-the-pickers).
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })` in `src/renderer/stores/notificationStore.ts`. Use for async results, errors, and persistent/dismissable messages. Same five-color design language as Center Flash: `green | yellow | orange | red | theme` (default `theme`). Set `dismissible: true` (or pass `--dismissible` from `maestro-cli notify toast`) when the user MUST acknowledge - disables auto-dismiss, requires click to close, and emphasizes the X button. Cannot combine `dismissible` with `duration`/`--timeout`. External CLI cap: 60 seconds (use `--dismissible` for sticky). **Click actions** (data-driven, survive the IPC bridge): pass `clickAction: { kind: 'jump-session', sessionId, tabId? } | { kind: 'open-file', sessionId, path } | { kind: 'open-url', url }` for what should happen when the toast body is clicked, or use the legacy `sessionId`/`tabId` fields for plain agent jump. From the CLI: `--agent` (+ optional `--tab`), `--open-file <path>` (requires `--agent`), `--open-url <url>` (mutually exclusive with `--open-file`). `--action-url` / `--action-label` render an inline link button beneath the message and are independent of the body click. **Source-agent label:** pass `sourceAgent` (CLI `--source-agent <label>`) to stamp which agent/pipeline fired the toast in the header strip. It's store-independent, so it shows even when the agent isn't loaded in the Left Bar (the name resolved from `--agent`/`sessionId` only renders when that agent is in the desktop store) - use it for cron/watchdog toasts. The explicit label wins over the resolved name for display; pair it with `--agent` to also get click-to-jump. Do NOT pass renderer-only callbacks across the bridge - use `clickAction` instead.
- **Center flash (rapid acks):** `notifyCenterFlash({ message, color, detail?, duration? })` in `src/renderer/stores/centerFlashStore.ts`; clipboard helper `flashCopiedToClipboard()` in `src/renderer/utils/flashCopiedToClipboard.ts`. Use for momentary "I did the thing" confirmations of user-initiated actions. Five-color design language: `green | yellow | orange | red | theme` - default `theme` matches the active Maestro theme. External integrations can fire flashes via `maestro-cli notify flash <message> --color <color>`. Do NOT roll your own center-screen overlay, useState+setTimeout flash, add a sixth color, or use a Toast for clipboard acks. Single visible flash at a time, themed frosted-glass card mounted once in `App.tsx`. Full decision rules, color palette, and design language: [UI-PATTERNS.md → Center Flash System](docs/agent-guides/UI-PATTERNS.md#center-flash-system-rapid-temporary-notifications).
- **Opening a modal / dashboard by name:** `UI_SURFACES` + `resolveUiSurface()` / `resolveUiSurfaceTab()` / `describeSurfaceAccess()` in `src/shared/uiSurfaces.ts`, dispatched by `openUiSurface()` in `src/renderer/utils/openUiSurface.ts`. One registry serves `maestro-cli open <surface> [--tab]`, the main-process `open_modal` validator, and the renderer dispatcher, and it carries the discovery hints (hotkey id, command-palette text, click target) so an agent can teach the manual path while opening the pane. Adding a modal means adding one entry, not touching four files - and if it has tabs, list them there so `--tab` can deep-link.
- **Scheduled Tasks (clock-driven Cue subs):** types and pure helpers in `src/shared/cue/scheduled-tasks.ts`, filesystem work in `src/main/cue/cue-scheduled-tasks.ts`. `maestro-cli cue schedule` and the Cue modal's Scheduled Tasks tab (via `cue:*ScheduledTask*` IPC) both go through that one module, so they cannot write different YAML for the same task. Do NOT hand-roll another cue.yaml writer.
- **Whether an agent is drawn in the Left Bar:** `sessionMatchesFilter()` and `passesUnreadFilter()` in `src/renderer/utils/sidebarMembership.ts`. "Visible" means drawn ANYWHERE in the scrollable list; scroll position is irrelevant. Both the render path (`useSessionCategories`) and `Cmd+[` / `Cmd+]` (`useCycleSession`) call these, because a cycle that disagrees with the list about membership moves the cursor onto an agent that is not on screen, which reads as the shortcut jumping at random. Adding a match rule here fixes both at once. The "does this agent need attention?" half of that answer lives in `sessionNeedsAttention()` / `sessionOrChildrenNeedAttention()` in `src/renderer/utils/sessionAttention.ts`, because the bell badge, the collapsed rail (`SkinnySidebar`), and the jump-badge projection (`useSortedSessions`) ask it WITHOUT a filter context - so a new attention rule (unread, busy, **error**, Auto Run batch, stuck outage) goes there and every surface picks it up at once. Errored agents were invisible in the unread filter for exactly this reason: four rival copies of the predicate, and only one of them knew about `state === 'error'`. The inputs are shared state (`uiStore.sessionFilter`, `uiStore.showArchivedGroupChats`) rather than local `useState` for the same reason - see [STATE-PATTERNS.md → uiStore](docs/agent-guides/STATE-PATTERNS.md#uistore). Note that `orderGroupChatsForDisplay()` drops archived chats ITSELF, so a caller that has already decided archived chats are on screen must pass `{ includeArchived: true }` rather than pre-filtering, or they are removed again on the way through.
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`; `useActiveSession()` hook in `src/renderer/hooks/session/useActiveSession.ts`
- **Session mutation:** `updateSessionWith(sessionId, updater)` for an agent, `updateAiTab(sessionId, tabId, updater)` for one AI tab, both in `src/renderer/stores/sessionStore.ts` (do NOT hand-roll `setSessions(prev => prev.map(...))`)
- **Per-agent git actions:** `useGitAgentActions(session)` in `src/renderer/hooks/git/useGitAgentActions.ts` - the shared View Git Log / View Git Diff / Pull / Push / Change Branch / Create PR / Configure Worktrees set behind ALL THREE surfaces that offer it: the header branch pill dropdown, the Left Bar right-click menu, and the command palette (`buildGitWorktreeCommands`). Also exports `resolveGitCwd()` / `resolveGitSshRemoteId()`. Adding a git action means extending this hook and surfacing it in all three, not re-deriving cwd + SSH id + modal calls. See [REMAINING-SYSTEMS.md](docs/agent-guides/REMAINING-SYSTEMS.md#usegitagentactions-srcrendererhooksgitusegitagentactionsts).
- **Focus an AI tab:** `aiTabFocusFields(tabId?)` in `src/renderer/utils/tabHelpers` - spread into a session patch (`{ ...s, ...aiTabFocusFields(tabId) }`) to land on an AI tab. It clears `activeFileTabId`/`activeTerminalTabId`/`activeBrowserTabId` and sets `inputMode: 'ai'`. Do NOT hand-roll the literal: those non-AI tab types outrank the AI tab in the render precedence, so omitting even one leaves the previous view on screen.
- **Focus a file tab:** `fileTabFocusFields(tabId)` in `src/renderer/utils/tabHelpers` - the file-tab counterpart to the above. Clears the terminal and browser selections (both outrank the file tab) and sets `inputMode: 'ai'`.
- **Audio/video playback:** media NEVER becomes a file preview tab. `handleOpenFileTab()` (`src/renderer/hooks/tabs/internal/useFilePreviewTabHandlers.ts`) is the single choke point every open path funnels through, and it diverts playable media to `useMediaPlaybackStore.openMedia()` (or `enqueueMedia()` when the caller passes `mediaMode: 'queue'`) before a tab can be created. Any path that opens SEVERAL files must pass `mediaMode: 'queue'` for every media file after the first - see `openFilesInOrder()` in `useFileContextMenu.ts` - or each open steals the player from the one before and only the last survives. The only surface media appears on is `FloatingMediaPlayer` - there is no docked/in-panel placement, so do NOT add one. Exactly ONE player exists app-wide, owned by `MediaPlaybackHost` (`src/renderer/components/MediaPlayback/`), mounted once in `App.tsx` and never unmounted: anything rendered per-tab or per-agent is torn down on switch, and removing a media element from the document pauses it. Do NOT mount a second player to play two files at once - the single-player invariant is what makes overlapping audio impossible; `stepMediaItem()` walks the queue in open order, a finished file hands off via `advanceAfterEnded()`, and the history menu jumps by recency. **Queue and history are two lists with opposite lifetimes:** the queue persists (settings key `mediaPlayerQueue`, debounced writes, hydrated in `settingsStore`) while history is per-boot, so history holds whole `MediaItem`s rather than IDs into the queue - never "simplify" it back into pointers, or dropping a queue entry would rewrite what the user already heard. Classify media with `getOpenedMediaKind()` in `src/renderer/utils/mediaItems.ts`. **A `file://` link clicked in markdown must go through `openFileUrl()`** (`src/renderer/utils/openFileUrl.ts`), never straight to `shell.openPath`: the file-link plugins emit `file://` for any path outside the project root, so an agent mentioning `~/Scratch/x.mp3` was handing it to the OS player and bypassing the choke point entirely. **The player's height is derived, never stored** (`src/renderer/utils/mediaFloatGeometry.ts`): chrome for audio, chrome + `width / aspect` for video, where the aspect is the file's real `videoWidth / videoHeight` and the chrome is MEASURED (font metrics differ per platform, so a hard-coded transport height letterboxes video somewhere). Only position and a per-kind width persist, so a mixed queue reshapes itself as it advances. **Minimize and close are different actions and must stay that way:** the `-` button sets `dismissed` (widget hidden, audio continues, `NowPlayingIndicator` in the Left Bar header becomes its play/pause via `requestToggle` plus a separate restore button), while `x` calls `closeItem` (player released, sound stops, rest of the queue intact). Minimize is a `hidden` STYLE FLAG on `FloatingMediaPlayer`, never a different render branch in `MediaPlaybackHost` - moving the media element in the React tree unmounts it, and that runs the spec's pause steps. **Neither list shows the loaded track:** history records DEPARTURES (a track enters when it stops being active) and `historyForActiveChange` also strips the incoming id, while the queue menu filters via `upcomingMediaItems()` at display time - the active item must stay in `items` or `stepMediaItem` loses prev/next. `clearQueue` keeps the loaded track, since clearing what is queued must not stop playback. **Queueing un-hides the widget** (`enqueueMedia` clears `dismissed` and `dormant`), and that is deliberate rather than a violation of the minimize invariant above: adding files is a request to SEE the queue, so doing it into a hidden player produces no visible response anywhere in the app and reads as the command having done nothing. It is safe because un-hiding is not interrupting - the loaded track is untouched and keeps playing. It fires even when NOTHING was added: queueing files that are all already queued adds zero items, and gating the reveal on `added > 0` made "Add to Play Queue" a silent no-op on exactly the second attempt, which is when a user retries a command that appeared to do nothing. For the same reason the idle branch loads the first file the user POINTED AT rather than the first one newly added, so re-queueing something the queue already holds still puts a widget on screen. A control that hides itself must not silently stop media, and a close button that only hid it leaves audio coming from nowhere. User docs: [media-player.md](docs/media-player.md).
- **Run a shell command from the chat:** `dispatchShellCommand()` (records it in recall history, then runs it) / `runShellCommand()` / `cancelShellCommand()` / `resolveCommandCwd()` in `src/renderer/services/shellCommand.ts`. This is command mode (`!command` in the AI composer). Any new surface that runs a one-off command and shows its output in a transcript should reuse this rather than calling `window.maestro.process.runCommand` directly - the synthetic `{sessionId}-shell-{runId}` id is what keeps the output out of the agent listeners. AI command mode routes its accepted suggestion through the SAME `dispatchShellCommand`, so it runs, records, and recalls identically; do NOT add a parallel run path for it. The one difference is the optional `request` field, stamped onto the card only when the caller passes one - its presence means exactly "this was generated, not typed", and it is what the card shows as provenance and what the next AI command sees as the `Asked:` line. `dispatchShellCommand` forwards its whole options object to `runShellCommand` rather than naming fields, so a new field cannot be silently dropped in between. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#shellcommandts-200-lines).
- **Delete the file the user is previewing:** `requestFileDeletion({ path, sshRemoteId?, sessionId? })` in `src/renderer/services/fileDeletion.ts`. Opens the shared destructive `confirm` modal, deletes through `window.maestro.fs.delete` (SSH-aware, same IPC the Files panel uses), force-closes every preview tab pointing at the path, and nudges the Files panel with the `maestro:refreshFileTree` CustomEvent. Both the File Preview toolbar's trash button and the command palette's `File: Delete` entry route through it - do NOT hand-roll a second confirm-then-delete path, or the two surfaces drift on what they warn about and what they clean up. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#filedeletionts---delete-the-previewed-file).
- **Ask the model for a shell command (AI command mode):** `requestAiCommand()` / `acceptAiCommand()` / `dismissAiCommand()` in `src/renderer/services/aiCommand.ts`, state in `src/renderer/stores/aiCommandStore.ts`, prompt in `src/prompts/ai-command.md` (id `ai-command`, editable in Settings -> Maestro Prompts). The suggestion runs on the tab's OWN provider at its current model and effort, read-only and with tools disabled. Do NOT hand-roll another one-shot model call for this: the main-process handler (`src/main/ipc/handlers/aiCommand.ts`) goes through the shared `groomContext()` runner.
- **Consulting another agent from a message (`@mention`):** `planCrossAgentMentions()` / `dispatchCrossAgentMentions()` / `dispatchCrossAgentMentionsForMessage()` in `src/renderer/services/crossAgentMentions.ts`, over `sendCrossAgentRequest()` in `src/renderer/hooks/agent/useCrossAgentDispatch.ts`. Resolution and dispatch are SEPARATE on purpose, because when a consult fires is part of the contract: a message sent while the agent is busy goes to the execution queue, so `useInputProcessing` plans at submit (it needs `suppressLocal` to know whether the source agent answers at all), stamps `crossAgentMention: true` on the `QueuedItem`, and `agentStore.processQueuedItem` fires the consult when the item becomes the agent's turn. **Never consult at submit time** - that pulls the other agent into a question still sitting several messages deep in the queue. This holds for a LEADING mention too (`suppressLocal`, where the source agent does not answer at all): it queues as a `crossAgentOnly` item, and `processQueuedItem` fires the consult and returns without spawning, releasing the dequeue's busy state via `applyQueuedItemRelease`. "This agent doesn't answer it" is not "it has nothing to wait for" - the item's queue POSITION is the user's instruction. Use `hasWorkAheadOfNewMessage()` (`utils/executionQueue.ts`) to make that call. Both entry points are module functions, not hook members, because the queue drain runs outside React. The CLI/web dispatch paths ride the SAME planner: `useRemoteHandlers` plans on the immediate path (a leading mention consults and skips the local spawn) and `useRemoteIntegration` stamps `crossAgentMention`/`crossAgentOnly` on a `dispatch --queue` item - so `maestro-cli dispatch "@Agent ..."` consults exactly like a typed message. Do NOT add a dispatch entry point that hands text straight to a spawn; a mention it never planned is silently inert. Anything that rewrites a queued item's text must re-derive BOTH flags from a fresh plan (`handleEditQueueItem`), never just `crossAgentMention`: where the mention sits is what decides whether this agent answers at all, and an edit can move it, so a stale `crossAgentOnly` silently discards half of what the user changed. And `suppressLocal` with no tab to anchor the reply on is a DROP, not a fallback - letting it through hands the local agent a message addressed to somebody else, which is the one thing the flag exists to prevent. On the main side, `cross-agent-router.ts` spawns the target with `target.customPath || agent.path || agent.command` (same rule as the tab spawn and the Group Chat moderator): detection probes known install dirs BEFORE PATH, so a consult that ignored the agent's `customPath` ran a stale nvm codex stub while the tab ran the real one. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#crossagentmentionsts-115-lines).
- **Appending to a transcript entry:** `canAppendToLogEntry(entry, source)` / `isSelfContainedCard(entry)` in `src/renderer/utils/logEntries.ts`. A `LogEntry` is either an open stream (coalesce consecutive chunks into it) or a self-contained card that owns its own text (`shellCommand`, `retryOutageId`, `recoveryAction`, `aiCommand`, `metadata.hiddenProgress`, `metadata.toolState`). Cards keep a NATURAL source - a `!` command's card is `source: 'stdout'` because its body really is terminal output - so **never gate coalescing on `source` alone**; that's how agent replies ended up rendered inside a command's output box. Adding a new card kind means adding its marker to `isSelfContainedCard`, which fixes every coalescing site at once.
- **Command mode (`!`) is STATE, not a text prefix, and it is a LADDER:** the live value is `composerInputStore.aiCommandMode` (`'off' | 'shell' | 'ai'`), persisted per tab as `AITab.commandMode`. `!` on an EMPTY composer climbs one rung (agent -> `'shell'`, a literal command line -> `'ai'`, a plain-English request the model turns into one); Escape on an empty composer climbs back down; the caret never leaves the textarea. The bang is consumed on entry and never appears in the draft, so NEVER test the text for a leading `!` to detect the mode - a real command can contain bangs, and the draft won't start with one. **Never test the value for truthiness either: `'off'` is a truthy string.** Compare against the literals, or use `isShellCommandMode()` / `isAiCommandMode()`. Persisted values from older builds are booleans (`true` meant `'shell'`), so always read `AITab.commandMode` through `normalizeComposerCommandMode()`. The invariant: the same string is a shell command, a request for one, or an agent message depending only on this value, so any path that persists or restores `inputValue` MUST carry `commandMode` with it (`syncAiInputToSession` reads it from the store itself so a caller can't forget). Helpers all live in `src/renderer/utils/shellCommandInput.ts`. See [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md#command-mode-is-state-not-a-text-prefix).
- **Shell tab completion:** `useTabCompletion()` in `src/renderer/hooks/input/useTabCompletion.ts` serves BOTH the terminal composer and command mode, told apart by its third `commandMode` argument (the text can't say which - a command line looks the same either way). Terminal mode completes against `shellCwd` + `shellCommandHistory`; command mode completes against the project root + the bang-prefixed entries in `aiCommandHistory`, because a command-mode command runs at the agent's `cwd` regardless of where a terminal tab has `cd`-ed. Suggestion values are plain command lines in both cases. Add completion sources here, not in a parallel hook.
- **Right-click menu on an image:** already done, app-wide. `<ImageContextMenuHost>` (`src/renderer/components/ImageContextMenuHost.tsx`) is mounted once in `App.tsx` and runs ONE delegated `contextmenu` listener that resolves the image from the click target, so raster `<img>`, inline `<svg>`, Mermaid charts, thumbnails, and the lightbox all get Copy Image / Save to Project / Save As with **zero per-surface wiring**. Do NOT add an `onContextMenu` to a new image surface or hand-roll copy/save buttons - a new surface is covered the moment it renders. To opt a surface out (it owns its own right-click behavior), put `data-no-image-menu` on its container. Export helpers live in `src/renderer/utils/imageExport.ts` (`saveImageToProject()` writes to `.maestro/diagrams/` and works over SSH). See [UI-PATTERNS.md → Right-Click Image Menu](docs/agent-guides/UI-PATTERNS.md#right-click-image-menu-imagecontextmenuhost).
- **Font zoom on a reading pane:** `useFontScale(storageKey)` in `src/renderer/hooks/ui/useFontScale.ts` + `<FontScaleControl>` in `src/renderer/components/ui/FontScaleControl.tsx` (`variant="inline"` for a toolbar, `variant="floating"` for a pill over a scrolling pane). The hook owns clamping, two-decimal rounding, and localStorage; do NOT hand-roll another `AArrowUp`/`AArrowDown` pair or another `clampFontScale`. Render it ONLY where the zoom moves type - Director's Notes hides it in Rich Mode, and the file preview gates it on `canScaleFontForView()` in `filePreviewUtils.ts`. See [UI-PATTERNS.md → `<FontScaleControl>`](docs/agent-guides/UI-PATTERNS.md#fontscalecontrol-srcrenderercomponentsuifontscalecontroltsx).
- **An agent's effective environment:** `resolveAgentEnvironment()`, `isSecretEnvKey()`, `maskEnvValue()`, `envSourceLabel()` in `src/shared/agentEnvironment.ts`, rendered by `<EnvVarList>` in `src/renderer/components/ui/EnvVarList.tsx`. Three layers decide what an agent runs as (global Settings -> Environment, then per-provider Settings -> Agents, then the agent's own overrides), and each is edited in a different pane, so no single settings screen answers "which profile is this actually running as?". The module does the SAME merge as `process:spawnTerminalTab` and reports which layer won plus which it shadowed. Do NOT re-derive the precedence inline: a merge that disagrees with the spawner's describes a process nobody is running. Distinct from `Settings/EnvVarsEditor`, which EDITS one layer - pick by question ("change a value" vs "which profile am I on?") and do not add an edit mode to `<EnvVarList>` to cover both. Secret-looking keys are masked behind a per-row reveal, matched loosely on purpose: these panels get opened while screen-sharing for help, so a false positive costs one click and a false negative leaks a live key.
- **Tiny uppercase state chip:** `<MiniBadge>` in `src/renderer/components/ui/MiniBadge.tsx` - "WT" beside a worktree agent, "Snoozed" beside a tab. The generic text counterpart to `<CountBadge>` (a number and nothing else) and to the fixed-word domain pills beside it (`WorktreePill`, `GitRunningBadge`). Do NOT hand-roll another `text-[9px] px-1 rounded uppercase` span: the same chip was written per surface and drifts on padding and weight. The label is its own accessible name, so pass a real word rather than an abbreviation, unless the abbreviation is the established UI term (then pass `title` with the long form).
- **"Show only providers this machine can run":** `filterToAvailableProviders()` / `providerLocationLabel()` in `src/renderer/utils/providerAvailability.ts`, rendered by `<ProviderAvailabilityBar>` in `src/renderer/components/ui/ProviderAvailabilityBar.tsx`. Both provider pickers (the wizard's tile strip, the New Agent modal's list) hide uninstalled providers by default behind one toggle, and the rules live in `shared` code so the two cannot drift. Three invariants: the count describes ALL supported providers, never the filtered rows (a count that shrank with the list reads "4 of 4" and answers nothing); filtering down to nothing falls back to the FULL list (an empty picker has no row to reach per-provider settings through, so a binary in a non-standard place becomes unreachable); and the SELECTED provider survives the filter (duplicating an agent whose provider is missing would otherwise hide the row showing what is selected). Say `providerLocationLabel(remoteHost)` rather than hard-coding "locally" - both pickers can point at an SSH remote, and the counts describe whichever host was probed. Flipping the filter renumbers the list, so carry the focus ring by PROVIDER, not by index.
- **Whether a login flow can fix an auth failure:** `classifyCredentialKind()` and `credentialKindBlocksLogin()` in `src/shared/providerAuthIdentity.ts`, which also owns `providerAuthKey()` (the credential's shared scope: agent binary + host). NOT every credential is an OAuth login. An agent authenticating with `ANTHROPIC_API_KEY`, one pointed at a gateway via `ANTHROPIC_BASE_URL`, and one running on Bedrock/Vertex all fail with the SAME `auth_expired` output an expired login produces, and running the provider's login command for them produces a successful-looking flow that changes nothing the agent presents - the user believes it is fixed and the next prompt burns on the same rejection. So any surface that offers to sign the user in gates on this first (`ReauthModal` does), and reports the real remedy instead. Feed it the effective env from `resolveAgentEnvironment()`, never a partial one: a classification built from a different merge describes a process nobody is running. Related: an error `message` in `src/shared/agentErrorPatterns.ts` must name WHAT failed and never a terminal command, because the bank does not know which of these kinds produced the line.
- **Sortable table header:** `<SortableTh>` in `src/renderer/components/ui/SortableTh.tsx` + `useTableSort()` in `src/renderer/hooks/ui/useTableSort.ts`. The hook owns the flip-vs-switch rule (clicking the ACTIVE column reverses it; clicking a DIFFERENT column jumps to that column's own default direction instead of inheriting the previous one - inheriting is what makes a freshly-picked column show Z-A or least-used-first and read as broken data). The component owns `aria-sort` placement (on the `<th>`, not the control), a stable caret slot so switching columns doesn't reflow the header row, and a real `<button>` for the click target. Do NOT hand-roll `<th role="button" onClick>`: `role` grants the semantics without the tab stop or Enter/Space handling, so it announces as a button and then does nothing from the keyboard.
- **Graphing a set of documents rather than one:** `BuildOptions.scopeFiles` / `scopeDirectory` in `src/renderer/components/DocumentGraph/graphDataBuilder.ts`, opened via `openGraphScope()` in `fileExplorerStore.ts`. Focus mode ("what does this document reach?") only creates nodes for files its BFS walks INTO, so a file nothing links to can never appear; scope mode ("how do these documents relate?") makes a node for every file in the set. Unreachable documents were being dropped TWICE - the builder's BFS, and then again by `prepareLayoutInput()` in `mindMapLayouts.ts`, which all four layout algorithms funnel through - so fixing only the builder renders nothing. They ride a `showOrphans` flag into the layout and get their own band via `positionOrphanNodesBottom()`, NOT a borrowed depth ring: an unreachable node has no depth, and giving it one draws it as a child of a center it has no link to. Scope mode also skips `startBacklinkScan`, which would pull in files outside the scope - the exact files the user did not select.
- **A text box that narrows a list:** `<FilterInput>` in `src/renderer/components/ui/FilterInput.tsx` - search icon, borderless input, optional `resultLabel` count, and a clear button that appears only once there is something to clear. Do NOT hand-roll another `<Search/> + <input>` pill; there are already a dozen near-identical copies that disagree on whether a clear button exists and what Escape does. Distinct from a FIND bar (`AutoRunSearchBar`, `TerminalSearchBar`), which walks matches inside one document and owns next/prev plus a match index - pick by question ("which rows do I see?" vs "take me to the next hit") and do not add match navigation to `<FilterInput>`. **Escape needs the host's help inside a modal:** the layer stack handles the key at capture on `window`, so the input never sees it and the surface closes instead of the filter clearing. Clear the query from the host's own `onEscape` first (see `MemoryViewer`).
- **Keyboard navigation in a `<DualPaneFileEditor>` list:** built in. Up/Down walk the VISIBLE rows (collapsed categories are skipped, the ends do not wrap), and Backspace/Delete raise `onDeleteItem(selectedId)` - the list reports the intent, the consumer owns the confirmation. Both keys are ignored unless the event came from a row, so the "+ New" button in the same container cannot delete anything. Pass `autoFocusList` when the surface's whole job is walking the list (the Memory Viewer) so the keys work without clicking a row first; it fires on the FIRST selection rather than on mount (the list loads async) and defers to anything that already holds focus, so a user who went straight for the filter box keeps the caret. After a consumer-driven delete, bump `listFocusToken`: the focused row was just unmounted, focus falls to `<body>`, and the next Backspace silently does nothing, which reads as the keyboard dying halfway through a cleanup pass.
- **Segmented toolbar (sort/filter pill bar):** `<SegmentedControl>` in `src/renderer/components/ui/SegmentedControl.tsx`. The "Sort by: [Name][Created][Queries]" bar above a grid or chart. It owns active-segment coloring, seam borders, `role="radiogroup"` semantics, arrow-key navigation, and a single tab stop; each segment gets `data-testid="${testId}-${value}"`. Do NOT hand-roll another `.map()` over buttons with `borderLeft` seams. Distinct from `<RadioGroup>`, which is the stacked list-row form for settings panes - pick by layout, and do not add a `variant` prop to either to cover the other. See [UI-PATTERNS.md → Segmented Toolbars](docs/agent-guides/UI-PATTERNS.md#segmented-toolbars-segmentedcontrol).
- **Paginating a list already in memory:** `usePagination(items, pageSize, resetKey)` in `src/renderer/hooks/ui/usePagination.ts`, pure helpers in `src/renderer/utils/pagination.ts`, UI in `<Pager>` (`src/renderer/components/ui/Pager.tsx`). Do NOT confuse it with `useHistoryPagination`, which is the async IPC-backed windowing engine for data that arrives page by page - this one is for a list you already hold. The hook clamps the current page on every read rather than in an effect, which is what stops a filter that shrinks 1236 rows to 18 from rendering an empty grid under "Page 30 of 1"; pass a `resetKey` built from whatever the user can change that reorders the list (sort mode, filter mode, query text) so re-sorting does not strand them on an arbitrary slice. Render `<Pager>` in the TOOLBAR ROW, not under the list: a pager below a long grid inside a scrolling modal makes the user scroll to the bottom, click, then scroll back up.
- **Following streaming output in a capped box:** `useStickToBottom(contentKey)` in `src/renderer/hooks/ui/useStickToBottom.ts` - returns a callback ref that keeps a scrolling box pinned to its newest content and releases the moment the user scrolls up. Reach for it whenever a box has BOTH a capped height and content that arrives over time: once it hits its cap it stops growing, so the transcript's own auto-scroll has nothing left to follow and the user is stranded on the FIRST screen of output while the live tail piles up below. Pinning is recomputed from geometry on every scroll event, never remembered as a flag - a flag has to tell a programmatic scroll from a user one, and scrolling to where you already are fires no event to clear the guard. Do NOT collapse it into a boolean. Distinct from `useScrollIntoView` (one element in a list) and `TerminalOutput`'s MutationObserver (the whole pane). See [UI-PATTERNS.md → Following Streaming Output](docs/agent-guides/UI-PATTERNS.md#following-streaming-output-usesticktobottom).
- **Keeping a virtualized list on its selection:** the virtualizer's own `scrollToIndex` from an effect keyed on the selected index, never a `ref` on the selected row. An inline arrow ref is a new identity every render, so React re-attaches it (and re-fires it) on every render rather than on every change of selection - and since `@tanstack/react-virtual` re-renders inside `flushSync` on every scroll-offset change, that closes a loop: a wheel tick scrolls the list, the ref re-attaches, and `scrollIntoView` snaps it back inside the same event. `FileSearchModal`'s wheel was never broken; the row ref was undoing it. `scrollIntoView` also cannot reach a row outside the rendered window, and `behavior: 'smooth'` over thousands of rows animates long enough for the next gesture to fight it. In a NON-virtualized list use `useScrollIntoView` (`src/renderer/hooks/ui/useScrollIntoView.ts`), which keys on the value. See [UI-PATTERNS.md → Scrolling a Virtualized List](docs/agent-guides/UI-PATTERNS.md#scrolling-a-virtualized-list-to-the-selection).
- **Adding a control to the Left Bar header:** the row neither wraps nor scrolls and the sidebar goes down to 256px, so it has a declared yield order rather than whatever CSS shrinks first. The MAESTRO wordmark is drawn IN FULL or dropped entirely (`showWordmark` in `SessionList.tsx`); it must never `truncate`, because a brand rendered as "MAE..." reads as a rendering bug. The now-playing pill is the shrink target of last resort - its filename is the one thing here that can be clipped without looking broken, so the pill is `min-w-0` while every button, icon, and divider stays `shrink-0`. Reserve width for the form a control is CURRENTLY in (the pill sheds its filename when narrow, so its compact and labeled reserves are separate constants), and ask `selectNowPlayingVisible` whether the pill is on screen rather than re-deriving it. See [UI-PATTERNS.md → Left Bar Header Width Gates](docs/agent-guides/UI-PATTERNS.md#left-bar-header-width-gates).
- **Element width for JS-computed layout:** `useElementWidth(ref, enabled?)` in `src/renderer/hooks/ui/useElementWidth.ts`. Reach for it only when the value must exist in JS - an inline SVG chart needs real pixels for its viewBox, and a breakpoint that switches column counts needs a number to compare. Anything expressible in CSS stays in CSS. It returns 0 until the first measurement, so gate width-dependent children on `width > 0` rather than drawing a zero-width chart, and it no-ops without `ResizeObserver` so jsdom tests need no polyfill.
- **Usage Dashboard card tile:** `<EntityTile>` in `src/renderer/components/UsageDashboard/EntityTile.tsx` - the shared tile behind every dashboard card grid (agent grid, per-tab grid): status dot, title, badges, corner age, subtitle, labeled stat row, sparkline, plus all four border states and the staggered `card-enter` animation. A new grid shapes data into `EntityTileStat[]`; it does not re-derive the chrome. Not the same thing as the widget library's `StatCard` (one headline metric), and it stays under `UsageDashboard/` because widgets may not import from there.
- **Creating a tab straight into a tile:** `tileNewTab()` / `canTileNewTab()` in `src/renderer/hooks/tabs/tileNewTab.ts` - creates an AI/file/terminal/browser tab and splits the current view around it in one session update (the palette's "Tile New ... Below" family). It reuses the drag path's `tileTabIntoGroup` / `createGroupFromDrop`, so keyboard and drag produce identical layouts. Do NOT hand-roll "create a tab, then tile it": the ordinary new-tab paths all clear `activeGroupId` to claim the panel, which tears down the group you are building - that is why this mints every tab non-activating.
- **Opening a modal from inside Settings:** `launchFromSettings(open)` in `src/renderer/utils/launchFromSettings.ts`. Settings renders at `z-[9999]`, so a launcher inside it (Extensions -> "Open Pianola", a plugin's `modal` panel) opens the new modal BEHIND Settings and the click looks like a no-op. This closes Settings first, then runs the launcher. Not for confirmations or pickers that are meant to stack on top of Settings. See [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md#modals-launched-from-inside-settings-launchfromsettings).
- **Lane and row positions in the Git Log graph:** `computeGitGraphLanes()`, `stepGitGraphRow()`, `stepGitGraphLane()`, `gitGraphHashAtRow()`, `pickBranchFromRefs()` in `src/renderer/utils/gitGraphLanes.ts`. `GitGraphView` DRAWS the graph and `GitLogViewer` NAVIGATES it with the arrow keys, and both need the same answer to "which lane is this commit in, and what order are the lanes drawn in?" - derive it twice and an arrow key lands in a column the user is not looking at. Row 0 is the OLDEST commit and is drawn at the BOTTOM (matching @gitgraph's vertical orientation), so a row STEP of `+1` is visually upward. Note the graph is built from `git log --all` while the List view holds only the current branch, so graph navigation must move by ROW rather than by the list's index - a commit selected on a side branch has no list index, and the key reads as dead.
- **Arrow-key navigation over a list or grid:** `useListNavigation()` in `src/renderer/hooks/keyboard/useListNavigation.ts`. Pass `columns` for a 2-D grid (left/right step one item, up/down jump a row); grid mode keys on the option's PRESENCE, so a grid reflowed to one column still answers all four arrows. Omit it for a plain list, where left/right stay inert. For a responsive grid feed it `useGridColumnCount(el, itemCount)` from `src/renderer/hooks/ui/useGridColumnCount.ts`, which takes the ELEMENT (held in state via a callback ref, since a ref mutating in place is invisible to React and would keep measuring an unmounted grid) and reads the RESOLVED `grid-template-columns` - a hard-coded row width walks to the wrong tile as soon as an `auto-fill` grid reflows. Render the result as a roving tabindex over native `<button>`s. See [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md#arrow-navigation-over-a-list-or-grid-uselistnavigation).
- **Rendering raw terminal output (ANSI):** `useAnsiConverter(theme)` in `src/renderer/hooks/ui/useAnsiConverter.ts` for the theme-aware `ansi-to-html` converter, then `getCachedAnsiHtml(text, theme.id, converter)` in `src/renderer/utils/textProcessing.ts` to convert, sanitize (DOMPurify), and cache. The 16 ANSI slots map onto the ACTIVE theme rather than the xterm palette, so do NOT hand-roll another `new Convert({...})` - a second palette drifts the first time a theme adds a color. Collapse carriage returns with `processCarriageReturns()` BEFORE converting, or a progress line arrives as a screen of dead rows, and run any regex over the output through `stripAnsiCodes()` first. The renderer only owns half of this: **nothing Maestro spawns is a TTY**, so the producing side must force color too (`-c color.ui=always` for git, `FORCE_COLOR=1` / `CLICOLOR_FORCE=1` for whatever its hooks run) or the console renders a perfect wall of gray.
- **Any CLI verb that can move the Maestro view:** `resolveBackgroundFlag()` (CLI side) / `readBackgroundField()` (handler side) in `src/shared/focusPlacement.ts`. **Focus belongs to the human operator**: an agent may create a surface, it may not decide the human should be looking at it. `background: true` means the active AGENT does not change AND the active TAB inside any agent does not change - the surface is still created and addressable, so "created but invisible" is a different bug. **The flag is ADDITIVE: no verb's default changed.** `open-file`, `open-terminal`, `open-browser`, `tab new`, `create-agent`, `create-worktree` and `switch-mode` all still focus when the flag is absent; `dispatch --new-tab` is still background-by-default with `--focus`, which is also its pre-existing behaviour. `focus-agent`, `send --tab` and `open` exist TO move the view and carry no flag at all. `readBackgroundField` is an OPT-IN - only a literal `true` counts. **Never write `message.background !== false` in a handler**: that reads an absent field as an opt-in and silently stops the verb from focusing, breaking every existing caller at once. Defaults are keyed by VERB, not message, because `tab new --prompt` and `dispatch --new-tab` share `new_ai_tab_with_prompt` and disagree. `--no-switch` on `open-file` is NOT a spelling of `--background`: it stays on the current agent but still activates the tab there, while `--background` changes nothing rendered anywhere (both may be passed; background wins). On the renderer, background placement is simply not spreading a focus patch - `createTab({ activate: false })`, `addTerminalTab(s, tab, { activate: false })`, `handleOpenFileTab(file, { activate: false })`. See [CLI-UI-PARITY.md → Focus belongs to the human](docs/agent-guides/CLI-UI-PARITY.md#focus-belongs-to-the-human---background----focus).
- **Making a tab the visible one:** the four `*FocusFields` helpers in `src/renderer/utils/tabFocusFields.ts` (`aiTabFocusFields`, `fileTabFocusFields`, `browserTabFocusFields`, `terminalTabFocusFields`), re-exported from `tabHelpers.ts`. The main window renders exactly ONE tab type by precedence (terminal > file > browser > ai), so "focus this tab" is never one assignment - missing a higher-ranked selection leaves the previous view on screen and the focus silently does nothing. They live in their own import-free module because both `tabHelpers` and `terminalTabHelpers` need them and those two already point at each other.
- **Record view for one table row:** `<RecordDetailModal>` in `src/renderer/components/ui/RecordDetailModal.tsx` - the field/value flip of a row that every tabular preview opens on double-click (CSV/TSV via `CsvRowDetailModal`, parquet via `ParquetViewer`). Callers pass a flat `fields` list plus their own `priority` / `resizeKey` / `testIdPrefix`; the mapping from a row to fields belongs in the caller, since a CSV row is positional strings and a parquet row is typed values. Do NOT hand-roll a second one - focus starts on the FIELD LIST rather than the filter input, because Left/Right step rows and Up/Down scroll and none of that works while a text input owns the caret (`/` moves focus to the filter).
- **Previewing a parquet file:** `<ParquetViewer>` in `src/renderer/components/ParquetViewer/`, over the main-process engine in `src/main/parquet/` and the shared filter language in `src/shared/parquet/`. Parquet is the one previewable format that never crosses IPC: `fs:readFile` short-circuits it to a marker (`shared/parquet/preview.ts`) and the viewer queries windows of rows through `window.maestro.parquet.*`. Three invariants: **filtering and sorting round-trip to the engine** (filtering the loaded page would only ever search the first few hundred rows of a hundred million); **`matchedRows` is a LOWER BOUND until `complete` is true**, rendered `1,204+`, converged by a background `countAll: true` pass that doubles as the prefetch; and **hiding a column changes the projection**, so the engine stops decoding it. The one thing that silently loses data: **filter literals compile into the CONVERTED domain, not the physical one** - hyparquet converts footer statistics while parsing, so a `TIMESTAMP(MICROS)` bound is epoch MILLISECONDS, and compiling microseconds prunes every row group in the file while looking healthy. See [REMAINING-SYSTEMS.md → Parquet Query Engine](docs/agent-guides/REMAINING-SYSTEMS.md#5-parquet-query-engine-srcmainparquet-srcsharedparquet).
- **Making a tab the visible one:** the four `*FocusFields` helpers in `src/renderer/utils/tabHelpers/focusFields.ts` (`aiTabFocusFields`, `fileTabFocusFields`, `browserTabFocusFields`, `terminalTabFocusFields`), re-exported from `tabHelpers`. The main window renders exactly ONE tab type by precedence (terminal > file > browser > ai), so "focus this tab" is never one assignment - missing a higher-ranked selection leaves the previous view on screen and the focus silently does nothing. They live in their own import-free module because both `tabHelpers` and `terminalTabHelpers` need them and those two already point at each other. `src/renderer/utils/tabFocusFields.ts` is a thin re-export of the same four for older import sites.
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Keyboard-shortcut hint / kbd pill:** `<Keycap>` and `<KeycapHint>` in `src/renderer/components/ui/Keycap.tsx`. Draws a key as a physical key (face, border, bottom lip) instead of a bare glyph in a caption. `pressed` sinks the cap so a surface can echo the real keypress - drive it from a short timer, never from `keyup`, because a held key repeats without ever sending one. `onClick` makes the hint the control itself, which is how a legend can double as the Apply / Cancel row and still satisfy the graphical-exit rule. Do NOT hand-roll another `<kbd>` pill. See [UI-PATTERNS.md -> Keycaps](docs/agent-guides/UI-PATTERNS.md#keycaps-keycap--keycaphint).
- **Modal / find-bar ESC pill:** `<EscCloseButton>` in `src/renderer/components/ui/EscCloseButton.tsx`. Every modal, palette, and find bar needs a graphical exit - Escape alone strands users on remote desktop and tablets. Pass an `onClose` that does exactly what the Escape handler does (extract it into a shared `useCallback` rather than duplicating the body). Do NOT hand-roll the `px-2 py-0.5 rounded text-xs font-bold` pill; the inert `<div>` version used to be copy-pasted in nine places. See [UI-PATTERNS.md → Every Modal Needs a Graphical Exit](docs/agent-guides/UI-PATTERNS.md#every-modal-needs-a-graphical-exit-escclosebutton).
- **Dropdown/tooltip anchored to a header element:** `useAnchoredMenuPosition(menuRef, anchorRef)` in `src/renderer/hooks/ui/useAnchoredMenuPosition.ts`, rendered via `createPortal(..., document.body)`. Anything anchored inside the Main Panel header MUST use this. `absolute top-full` is silently clipped: the header wraps its left cluster in `overflow-hidden` boxes only as tall as the pill, which is how the git pill's hover card and the git status tooltip were both invisible for months. Bare `position: fixed` doesn't help either, because `.header-container` sets `container-type: inline-size` (implying `contain: layout`), making the header a containing block for fixed descendants. Since jsdom has no layout engine, a test asserting `toBeInTheDocument()` passes while the element is invisible - assert it is NOT a descendant of the header subtree instead.
- **Remembered textarea height:** `useResizableTextarea()` in `src/renderer/hooks/ui/useResizableTextarea.ts` - every `resize-y` textarea should keep the height the user dragged it to, across reopen and app restart. Spread its `style` last and pass `externalRef` if the component already owns a ref. See [UI-PATTERNS.md → Resizable Textareas](docs/agent-guides/UI-PATTERNS.md#resizable-textareas).
- **Auto-growing composer textarea:** `useAutosizeTextarea()` in `src/renderer/hooks/ui/useAutosizeTextarea.ts` (helpers in `src/renderer/utils/textareaSizing.ts`). Every composer that grows with its content rides it - AI composer, both wizard composers, group chat, feedback chat. Do NOT hand-roll `height = 'auto'` then `height = scrollHeight` again: the `'auto'` toggle collapses the internal scroll to the top, so a full, scrolling composer clipped the line being typed on every keystroke. Run it on the committed value, never inside `onChange` - an `onChange` resize never fires for dictation, draft restore, or template insertion, which grows the text without growing the box. Distinct from `useResizableTextarea`, which remembers a height the USER dragged.
- **Line numbers beside a `<textarea>`:** `<TextareaLineNumbers>` + `lineNumberGutterMetrics()` in `src/renderer/components/ui/TextareaLineNumbers.tsx`. The gutter is scroll-synced (translated by the textarea's `scrollTop`, written straight to the DOM so a fast scroll can't lag a frame) and wrap-aware (each logical line is measured against a hidden mirror sharing the textarea's font and wrap width, so number N sits on the FIRST visual row of line N). Both the Cue YAML editor and the Auto Run expanded modal ride it. Do NOT hand-roll another `value.split('\n').map((_, i) => <div>{i + 1}</div>)` gutter - that's what the YAML editor had, and it drifted out of alignment the moment the document scrolled or any line wrapped. Derive the textarea's `paddingLeft` from `lineNumberGutterMetrics(value).textPaddingLeft` rather than guessing a pixel value; the metrics are in `ch` and reserve two digits minimum so the editor doesn't reflow at line 10. See [UI-PATTERNS.md → Line Numbers on a `<textarea>`](docs/agent-guides/UI-PATTERNS.md#line-numbers-on-a-textarea-textarealinenumbers).
- **Guarded `localStorage` access:** `safeLocalStorage()` in `src/renderer/utils/safeLocalStorage.ts`. Reading the global itself can THROW (storage-blocked renderer, private mode, a jsdom test without Storage), so never touch `localStorage` directly in a hook - three private `storage()` copies existed before this was pulled out. A missing Storage must cost the user their persistence, not their pane.
- **A view preference a user sets by clicking:** `usePersistedToggle(storageKey, defaultValue)` in `src/renderer/hooks/ui/usePersistedToggle.ts` - one boolean in localStorage, for a collapsed banner or a folded section that must survive the surface unmounting (a Right Bar tab switch, a re-render from new data) but isn't worth a Settings row. Storage failures degrade to in-memory only, so a storage-blocked renderer costs the user persistence, not their pane. Do NOT hand-roll another `useState(() => localStorage.getItem(...) === 'true')` pair - a collapse that resets on every re-render reads as the banner refusing to stay closed. `AutoRunNoticeBanner`'s `collapseKey` is the first caller. For a preference that is one of several words rather than yes/no (a sort mode, a view density), use `usePersistedChoice(storageKey, options, defaultValue)` in the same folder: it validates the stored string against the option list, so a mode from an older build falls back to the default instead of stranding the surface in a state its control cannot express. See [UI-PATTERNS.md → Collapsible Advisories](docs/agent-guides/UI-PATTERNS.md#collapsible-advisories-autorunnoticebanner-usepersistedtoggle).
- **A pane width the user sets by dragging:** `useResizablePanel()` in `src/renderer/hooks/ui/useResizablePanel.ts` for the drag itself, then pick the persistence by where the pane lives. Top-level chrome (Left Bar, Right Bar) is a real setting: pass `settingsKey` and back it with a `settingsStore` field. A pane INSIDE another surface (the Document Graph's preview pane, a split inside a panel) is a view preference: pair it with `usePersistedPanelWidth(storageKey, { defaultWidth, minWidth, maxWidth })` and OMIT `settingsKey`, or the hook writes the width a second time under a key nothing reads back. Keep the stored bounds and the live clamp separate - the stored bounds decide what may be written to disk, while the `maxWidth` passed to the drag folds in the container as it is right now, so a width that was legal on a maximized window can't swallow the canvas after the modal is resized down.
- **A modal default sized to the screen:** `viewportModalSize({ width, height })` in `src/renderer/utils/modalSizing.ts`, passed as `defaultSize` to `useResizableModal`. Only for surfaces the user pans around INSIDE (a graph, a dashboard) - a form or dialog has a natural width and more room buys it nothing. A fixed default that reads as generous on a laptop is a postage stamp on a 5K display, and the user re-drags it on every machine. Memoize it once per mount: the hook re-clamps the live size on `resize`, and a default that moves under it fights that listener.
- **Focus after render:** `useFocusAfterRender()` in `src/renderer/hooks/utils/useFocusAfterRender.ts` (do NOT use `useEffect + setTimeout(() => ref.focus())`). Same file: `useFocusOnMount()` for a modal that must land with its input focused, and **`useFocusOnClose(ref, isOpen)` for handing the caret BACK when a transient surface closes**. The layer stack restores focus generically now (`useLayerStack` snapshots `document.activeElement` when a focus-capturing layer registers and hands it back when the layer unregisters, but ONLY if focus landed nowhere), so a modal registered through `useModalLayer` needs nothing. Reach for `useFocusOnClose` when the surface is NOT a registered layer (an inline editor, a popover) or when the caret should land somewhere OTHER than where it started - it wins, because the stack defers to anything that already claimed focus. It fires only on the true -> false edge, so it cannot steal focus from something the user clicked afterwards. Do NOT restore focus by hand in a modal's `onClose`: a surface dismissed with Escape never runs it, which is how focus ended up on `document.body` with the pane behind it looking ready while swallowing the next keystroke.
- **Event listeners:** `useEventListener()` in `src/renderer/hooks/utils/useEventListener.ts` (do NOT pair raw `addEventListener`/`removeEventListener` inside useEffect)
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()`, `useThrottledCallback()` in `src/renderer/hooks/utils/useThrottle.ts` (filename is misleading - all three live here)
- **Identity-stable callback:** `useStableCallback()` in `src/renderer/hooks/utils/useStableCallback.ts` - one identity forever, always calling the newest implementation. Reach for it when a new callback identity is read as a STRUCTURAL change rather than a fresh value. The canonical case is `createMarkdownComponents()`: it builds a fresh map of component functions, so rebuilding it gives React a new component TYPE for every element and it unmounts and remounts the entire rendered document, discarding the reader's scroll position and restarting images and Mermaid. Any callback that closes over document content (a task-checkbox toggle, for instance) is reborn on every edit and triggers exactly that. Do NOT use it to silence an exhaustive-deps warning - it hides the callback from dependency arrays, so an effect that should re-run when its captured values change no longer will.
- **Render markdown:** `<Markdown preset="chat | document | wizard-bubble | release-notes">` from `src/renderer/components/Markdown/` (do NOT hand-roll `<ReactMarkdown>` + a per-surface `components`/plugin map). The chat preset is what `MarkdownRenderer` wraps. Shared internals: `buildMarkdownPlugins` (`Markdown/plugins.ts`), `preprocessMarkdown` (`Markdown/preprocess.ts`), leaf renderers in `Markdown/components/*`, and the document component map `createMarkdownComponents()` in `src/renderer/utils/markdownConfig.ts`. See [UI-PATTERNS.md → `<Markdown>`](docs/agent-guides/UI-PATTERNS.md).
- **Clickable task checkboxes in rendered markdown:** `toggleTaskCheckboxAtLine(content, line)` in `src/renderer/utils/markdownTasks.ts`, plus `rehypeSourceLine` (`src/renderer/components/Markdown/rehypeSourceLine.ts`) and the `onTaskToggle` option on `createMarkdownComponents()`, which swaps in `<TaskCheckbox>`. react-markdown renders every GFM checkbox `disabled`, so those three pieces are what make one clickable - the file preview and the Auto Run panel both ride them. Do NOT count checkboxes in the DOM and map them onto the Nth `- [ ]` line: that drifts the moment a task marker appears inside a code fence. **Every component override in `createMarkdownComponents()` must forward its props** (destructure `node` out, spread the rest): `rehypeSourceLine` tags EVERY block, and `lineSync.domGetTopLineByAttr()` reads those tags to keep the file preview and the editor on the same line across the toggle. `React.createElement('p', null, children)` eats the attribute, which left HEADINGS as the only anchored blocks - so a document scrolled to the very top reported the first heading, and hitting Edit jumped there. See [UI-PATTERNS.md → Clickable task checkboxes](docs/agent-guides/UI-PATTERNS.md#clickable-task-checkboxes) and [Preview/edit scroll sync](docs/agent-guides/UI-PATTERNS.md#previewedit-scroll-sync-rides-the-same-data-source-line-tags).
- **Model/effort badges on a finished turn:** `<TurnSettingPills>` in `src/renderer/components/ui/TurnSettingPills.tsx`, fed from `LogEntry.turnModel` / `turnEffort`. Those are stamped at SEND time by `codifyTurnSettings()` in `src/renderer/utils/providerTabSessions.ts` - spread it into whatever tab patch marks the tab busy. Never label a turn from the live tab or agent value: settings are codified at send, so a model change made mid-stream must not relabel the response already running. **A QUEUED message freezes its settings when it is queued**, since the queue may not drain until several model changes later: every path that builds a `QueuedItem` spreads `captureQueuedTurnSettings()` into `item.turnSettings`, and both the pills (`markTabRunningQueuedItem`) and the spawn (`agentStore.processQueuedItem`) read it back through `codifyQueuedTurnSettings()`. The presence of the object is the capture flag - an undefined model INSIDE it means "the agent default was chosen", so never `?? ` it against the live value. See [UI-PATTERNS.md → Turn Attribution Pills](docs/agent-guides/UI-PATTERNS.md#turn-attribution-pills-turnsettingpills).
- **Tab overlay-menu shortcut badge:** `<ShortcutHint keys={...} theme={theme} />` in `src/renderer/components/TabBar/ShortcutHint.tsx`. Every tab item's overlay menu (AI, file, terminal, browser, group) uses this one copy; it was previously re-declared inline, byte-identical, in four components. Do NOT re-declare it locally or hand-roll the `ml-auto` badge span.
- **Which tab a tab-scoped action targets:** `resolveActiveTabRef(session)` in `src/renderer/utils/panelLayout.ts` returns the `UnifiedTabRef` a per-tab command (rename, etc.) should act on - the active tiled group's FOCUSED PANE when a group owns the panel, else the single-view tab via `resolveSingleViewTabRef()`. Do NOT hand-roll the `terminal -> file -> browser -> AI` precedence chain: focusing a tiled pane does not set `inputMode`/`activeTerminalTabId`, so an open-coded chain silently targets the AI tab hidden behind the group. Pair with `resolveTabRefRenameValue()` (user-assigned name only, `null` when the tab is gone) to seed a rename input, and `resolveTabRefTitle()` for display text.
- **The tab a queued item is going to:** `resolveQueuedItemTabName(session, item)` in `src/renderer/utils/executionQueue.ts` for the LABEL, `resolveQueuedItemTarget()` in `src/renderer/utils/tabHelpers` for the tab itself. Unlike `turnSettings`, a `QueuedItem`'s `tabName` is NOT frozen on purpose - it is a last-known fallback for a tab that is gone by the time the queue drains. Do NOT render `item.tabName` directly: an item queued into a brand-new tab snapshots `New` and keeps it forever, so after auto-naming the Execution Queue indicator grouped one tab under whichever name its FIRST item happened to carry, and the browser listed two rows for one tab under two different names. The resolver reads the live tab, then a closed-but-draining orphan, then the snapshot. See [UI-PATTERNS.md → Queued Item Tab Labels](docs/agent-guides/UI-PATTERNS.md#queued-item-tab-labels-resolvequeueditemtabname).
- **Whether a Force Send control exists at all:** `shouldOfferForceSend(eligibility)` in `src/renderer/utils/executionQueue.ts`, paired with `getForceSendEligibility()` (can it run?) and `getForceSendTitle()` (why not?). Rendering and enabling are separate questions: `canForce` decides DISABLED, this decides PRESENT. Only `needs-forced-parallel` is worth showing dimmed, because its tooltip names a setting the user can go turn on; `no-target-tab` could never work, and `target-tab-busy` resolves itself (a tab runs one turn at a time, so the item is already next in line). Both surfaces - the inline QUEUED card in `QueuedItemsList` and the Execution Queue browser's Send Now - call it, so they cannot drift on when the button appears, which they had already done once in both directions.
- **Model tier / effort level (`'low' | 'medium' | 'high'`):** `resolveTierModel()`, `resolveEffortLevel()`, `cheapTurnSettings()` in `src/shared/modelTiers.ts`; `MAESTRO:MODEL` markers via `findActiveModelHint()` in `src/shared/autorunModelHints.ts`; the join in `resolveTurnSettings()` in `src/shared/autorunTurnSettings.ts`. A marker's PLACEMENT is its scope (own line = from there down, end of a task line = that task only), the two layer per axis, and `'default'` stays a directive rather than collapsing to `undefined` so a task can opt out of a document-wide hint - do NOT normalize it away at parse time. One vocabulary maps to every provider, and it maps to ladder POSITIONS, not same-named strings - Claude's `high` is `max`, Codex's `low` is `minimal`. Do NOT pass a provider's own effort word through from a document, and do NOT add a tier table for a provider whose model IDs are discovered at runtime (codex, copilot-cli, opencode): a shipped guess rots into naming a model the user cannot run. Unmapped returns `undefined`, meaning inherit-the-agent's-value AND warn - never substitute silently, because a deep-planning task quietly running on the default model is the exact failure this replaced. Shared because the desktop and CLI Auto Run engines must resolve a document identically.
- **Auto Run markers (HITL / halt / model hint):** `scanMaestroMarkers()`, `findPendingHitlGate()`, `detectHaltMarker()`, `hasMaestroMarker()` in `src/shared/autorunMarkers.ts`, rendered by `remarkMaestroMarkers` (`src/renderer/components/Markdown/remarkMaestroMarkers.ts`) + `<MarkerPill>`. All three markers are HTML comments, so they render as NOTHING - and two of them silently block the next run (a live HITL gate pauses it, a halt marker makes Auto Run refuse to start), which presents to the user as "I pressed Run and nothing happened". `scanMaestroMarkers` is the rendering side and reports each marker's STATUS (`live` / `spent` / `invalid`), because presence is not the useful question: a gate above an unchecked task and one above a checked task are a character apart in the source and only the first stops the run. Do NOT hand-roll another marker regex - the engines and the pill must agree, or the pill sends the user to remove the wrong marker. Pills are wired ONLY into `createMarkdownComponents` (the document map); chat builds its own map, so an agent explaining the syntax in a message keeps rendering as prose rather than claiming a setting exists. One deliberate asymmetry: `detectHaltMarker` is NOT fence-aware (the engine must never miss a halt an agent mis-indented) while `scanMaestroMarkers` is (a pill on a documentation example would be a lie).
- **Fence-aware markdown scanning:** `forEachMarkdownLine()`, `UNCHECKED_TASK_REGEX`, `CHECKED_TASK_COUNT_REGEX`, `CHECKED_TASK_REGEX` in `src/shared/markdownTaskScan.ts`. Every Auto Run document scanner (task counting, HITL gates, model hints, human-step detection) rides this one walk, in `shared/` because the CLI engine cannot import from `src/renderer`. Do NOT hand-roll another line loop: any scanner that forgets the fence bookkeeping fires on a playbook that merely DOCUMENTS the marker syntax, and the copies drift on closing-fence length, tilde fences, and CRLF.
- **Thinking mode (`'off' | 'on' | 'sticky'`):** `THINKING_MODES`, `nextThinkingMode()`, `asThinkingMode()` in `src/shared/types.ts`. One cycle order serves the composer's Thinking chip and `maestro-cli tab thinking <tab-id> cycle`, so a click and a CLI cycle cannot disagree about what comes next - do NOT hand-roll another `['off', 'on', 'sticky']` ladder or an inline `indexOf(...) + 1` step. Narrow anything arriving from the CLI or the web bridge through `asThinkingMode()` rather than casting: `'off'` is a truthy string, and an unrecognized mode written straight into a tab is a permanently wrong chip rather than a rejected command.

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

Local validation runs on a single OS and cannot catch platform-specific breakage (path separators, home directories, drive letters). A branch is not mergeable until both CI matrix legs, `test (ubuntu-latest)` and `test (windows-latest)`, are green; never merge on a local single-OS pass alone.

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

Rows are in picker order - alphabetical by display name, which is what
`PICKABLE_AGENT_IDS` sorts `AGENT_PICKER_META` into in
`src/shared/agentMetadata.ts`, the one registry all three provider pickers read.
The record's own key order does not matter; a new provider can be added anywhere
in it. Which provider a picker DEFAULTS to is a separate list,
`AGENT_AUTOSELECT_ORDER`, so the default is a real preference rather than
whatever happens to sort first. `terminal` is internal and never offered.

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

| Task                                | Primary Files                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler                     | `src/main/index.ts`, `src/main/preload.ts`                                                                                                                                                                                                                       |
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
| Add new agent                       | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` - see [AGENT_SUPPORT.md](AGENT_SUPPORT.md)                                                                                          |
| Add agent output parser             | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                 |
| Add parquet viewer feature          | `src/renderer/components/ParquetViewer/` (UI), `src/main/parquet/` (query engine), `src/shared/parquet/` (filter language + wire types)                                                                                                                          |
| Add agent session storage           | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                   |
| Add agent error patterns            | `src/shared/agentErrorPatterns.ts`                                                                                                                                                                                                                               |
| Add agent context window            | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                            |
| Add playbook feature                | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                  |
| Add marketplace playbook            | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                      |
| Playbook import/export              | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                  |
| Modify wizard flow                  | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                     |
| Add tour step                       | `src/renderer/components/Wizard/tour/tourSteps.ts`                                                                                                                                                                                                               |
| Modify file linking                 | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                            |
| Add documentation page              | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                       |
| Add documentation screenshot        | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                     |
| MCP server integration              | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                     |
| Add stats/analytics feature         | `src/main/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                         |
| Add Usage Dashboard chart           | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                        |
| Add Document Graph feature          | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                               |
| Add colorblind palette              | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                   |
| Add performance metrics             | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                              |
| Capture/analyze perf trace          | `src/main/profiling/` (Chromium contentTracing capture), `scripts/analyze-perf-trace.mjs` (offline analysis), `CLAUDE-PERFORMANCE.md` -> Field Performance Traces                                                                                                |
| Add power management                | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                   |
| Spawn agent with SSH support        | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                        |
| Modify file preview tabs            | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                 |
| Add Director's Notes feature        | `src/renderer/components/DirectorNotes/`, `src/main/ipc/handlers/director-notes.ts`                                                                                                                                                                              |
| Add Encore Feature                  | `src/renderer/types/index.ts` (flag), `useSettings.ts` (state), `SettingsModal.tsx` (toggle UI), gate in `App.tsx` + keyboard handler                                                                                                                            |
| Modify history components           | `src/renderer/components/History/`                                                                                                                                                                                                                               |
| Modify history activity graph       | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                               |
| Modify Auto Run Thought Stream      | `src/renderer/stores/thoughtStreamStore.ts` (in-memory capture + `groupThoughtsIntoBlocks`), `src/renderer/components/ThoughtStreamPanel.tsx` (panel), `src/renderer/hooks/agent/internal/useThoughtStreamCaptureListener.ts` (taps `process:thinking-chunk`)    |
| Add Cue event type                  | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                        |
| Add Cue template variable           | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                |
| Modify Cue modal                    | `src/renderer/components/CueModal.tsx`                                                                                                                                                                                                                           |
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
