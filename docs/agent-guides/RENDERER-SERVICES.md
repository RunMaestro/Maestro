<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Renderer Services and Constants Guide

Covers `src/renderer/services/` (13 files, ~4,470 lines) and `src/renderer/constants/` (10 files, ~1,676 lines).

Not documented in detail below but present in `services/`: `bmad.ts` (BMAD slash command service, mirrors `speckit.ts`/`openspec.ts`) and `feedbackConversation.ts` (feedback/wizard conversation flow).

Not documented in detail below but present in `constants/`: `cueYamlDefaults.ts` (default Cue YAML templates).

---

## Services Overview

The services directory provides a clean API layer between React components and the Electron main process via IPC. Services wrap `window.maestro.*` calls exposed by the preload bridge.

### Architecture

```text
React Components
      |
      v
 renderer/services/  <--- createIpcMethod() pattern
      |
      v
 window.maestro.*   (preload bridge)
      |
      v
 main process IPC handlers
```

---

## Service Files

### ipcWrapper.ts (~180 lines)

Central utility for wrapping IPC calls with standardized error handling.

**`createIpcMethod<T>(options)`** - The core pattern used by `git.ts` and `process.ts`:

- **Swallow mode**: Provide `defaultValue` - errors are logged and the default is returned. Used for read operations.
- **Rethrow mode**: Set `rethrow: true` - errors are logged and rethrown. Used for write/mutation operations.
- **Transform**: Optional `transform` function post-processes the result before returning.

Two overloaded option interfaces enforce mutual exclusivity:

- `IpcMethodOptionsWithDefault<T>` - requires `defaultValue`, optional `rethrow: false`
- `IpcMethodOptionsRethrow<T>` - requires `rethrow: true`, no `defaultValue`

**`IpcCache` class** - Simple in-memory cache for IPC results with TTL (default 30s):

- `getOrFetch(key, fetcher, ttl)` - Cache-or-fetch pattern
- `invalidate(key)` / `invalidatePrefix(prefix)` / `clear()` - Cache invalidation
- Exported as singleton `ipcCache`

**Adoption**: Only `git.ts` and `process.ts` use `createIpcMethod`. The wizard services, contextGroomer, contextSummarizer, speckit, and openspec all make direct `window.maestro.*` calls with their own try/catch patterns.

---

### git.ts (~165 lines)

Git operations service. Every method takes an optional `sshRemoteId` parameter for remote execution.

All methods use `createIpcMethod` with `defaultValue` (swallow mode):

- `isRepo(cwd, sshRemoteId?)` - Returns `false` on error
- `getStatus(cwd, sshRemoteId?)` - Parallel fetches status + branch, parses porcelain format via `parseGitStatusPorcelain` from shared utils
- `getDiff(cwd, files?, sshRemoteId?)` - Full diff or per-file diffs
- `getNumstat(cwd, sshRemoteId?)` - Line-level statistics via `parseGitNumstat`
- `getRemoteBrowserUrl(cwd, sshRemoteId?)` - Converts remote URL to browser-friendly URL
- `getBranches(cwd, sshRemoteId?)` - Deduplicated local + remote branches
- `getTags(cwd, sshRemoteId?)` - All tags

Exported as `gitService` object (not a class).

---

### process.ts (~120 lines)

Process management service. Wraps `window.maestro.process.*` calls.

Methods using `createIpcMethod` with `rethrow: true`:

- `spawn(config)` - Returns `ProcessSpawnResult` (pid, success, optional sshRemote info)
- `write(sessionId, data)` - Write to process stdin
- `interrupt(sessionId)` - Send SIGINT/Ctrl+C
- `kill(sessionId)` - Kill process
- `resize(sessionId, cols, rows)` - Resize PTY terminal

Event listener methods (direct passthrough, no createIpcMethod):

- `onData(handler)` - Process stdout data
- `onExit(handler)` - Process exit with code
- `onSessionId(handler)` - Batch mode session ID assignment
- `onToolExecution(handler)` - Tool execution events (OpenCode, Codex)

Exported as `processService` object.

---

### shellCommand.ts (~200 lines)

Command mode ("bang commands"): running a `!command` typed in the AI composer and streaming its output into the transcript. The agent is bypassed entirely - never spawned, never written to, never shown the command or its output.

**Key exports:**

- `dispatchShellCommand({ session, tabId, command })` - record the command in `aiCommandHistory` (bang-prefixed) and run it. **This is the entry point every command surface uses**: a typed `!` command and an accepted AI command mode suggestion both go through it, which is what makes an accepted suggestion indistinguishable from a typed command afterwards, in the transcript and in up-arrow recall alike
- `runShellCommand({ session, tabId, command })` - append a live output card to the tab and run the command; resolves on exit. Use `dispatchShellCommand` unless you deliberately want the run WITHOUT the history entry
- `cancelShellCommand(logId)` - stop a running command by its card's log id (the card's Stop button)
- `resolveCommandCwd(session)` - where a bang command runs (agent `cwd`, or the SSH remote's working dir). Deliberately NOT `shellCwd`, which only terminal mode's `cd` moves. The composer's `CommandModeBar` and Tab completion both call this so the advertised directory, the completion source, and the actual run directory can never disagree
- `isShellCommandRunning(logId)`, `buildShellRunSessionId(sessionId, runId)`, `SHELL_COMMAND_OUTPUT_LIMIT`

**Why a synthetic session id.** `process.runCommand` keys its `data` / `stderr` / `command-exit` events by sessionId. Reusing the agent's real id would route shell output straight into `useAgentDataListener` / `useAgentStderrListener` / `useAgentCommandExitListener`, appending it to the tab as agent output and flipping session state. Each run instead gets `{sessionId}-shell-{runId}`, which matches none of those listeners' patterns (no `-ai-` segment, no `-terminal` suffix, no `-batch-` segment) and no session in the store, so they all no-op and this module owns the stream. Do NOT "simplify" this to the plain session id.

Output is buffered and flushed on an animation frame (one store write per frame, not per chunk) and capped at `SHELL_COMMAND_OUTPUT_LIMIT` characters, because transcript logs are persisted to the sessions file.

Rendered by `components/ShellCommandCard.tsx`, anchored by `LogEntry.shellCommand`. Routing happens at the top of `useInputProcessing.processInput`.

**Deleting a card.** The card carries its own trash icon (with the same inline "Delete? Yes/No" confirm the transcript's user messages use) because it takes an early return in `TerminalOutput` and never renders the shared hover toolbar. It routes to the SAME `handleDeleteLog` in `hooks/tabs/internal/useScrollLogHandlers.ts`, which now branches on `log.shellCommand` before its `source === 'user'` guard, since a card is neither a user message nor part of one:

- It deletes as a **single entry**, not the span-to-the-next-user-message a chat message deletes as. The card owns both its command and its output.
- It must **never** call `claude.deleteMessagePair` - the agent was bypassed entirely, so there is no pair in its session to delete.
- Delete is hidden while the command is still **running**. Removing a live card would orphan the process: output keeps streaming into an entry that no longer exists, with no Stop button left to reach it. Stop first, then delete.

The recall-history rule lives in the pure reducer `hooks/tabs/internal/deleteShellCommandLog.ts`: the bang-prefixed `aiCommandHistory` entry is pruned **only when no card anywhere in the agent still shows that command**. The two lists have different scopes - cards are per tab, `aiCommandHistory` is per agent and deduplicated - so pruning unconditionally would strip `!ls` from up-arrow recall while two other `ls` cards sit on screen.

### Command mode is STATE, not a text prefix

The `!` is a _gesture_ that enters the mode and is consumed on entry - it never lands in the draft. Once in command mode the composer holds the bare command line. **Never infer the mode by testing the text for a leading `!`**: a real command can contain bangs (`find . -name '*!*'`), and the draft doesn't start with one anyway.

`!` is a **rung, not a toggle**. Each press on an EMPTY composer climbs one rung, and Escape on an empty composer climbs back down. Focus never leaves the textarea at any point:

```
agent chat  --!->  'shell'  --!->  'ai'
agent chat  <-Esc-  'shell'  <-Esc-  'ai'
```

| Rung      | The draft is...                 | Enter does                                               |
| --------- | ------------------------------- | -------------------------------------------------------- |
| `'off'`   | a message for the agent         | sends it                                                 |
| `'shell'` | a literal shell command line    | runs it (`dispatchShellCommand`)                         |
| `'ai'`    | plain English describing a want | asks the tab's model for one command line, then confirms |

There is no rung above `'ai'`, so a `!` typed there is ordinary text - the request is prose, and prose contains bangs. A `!` typed into a NON-empty composer is ordinary text on every rung (`echo !` never climbs).

The mode lives in two places, and they must move together:

| Where                              | Scope              | Set by                                                     |
| ---------------------------------- | ------------------ | ---------------------------------------------------------- |
| `composerInputStore.aiCommandMode` | live, active tab   | the `!` gesture; Escape/Backspace on an empty command line |
| `AITab.commandMode`                | persisted, per tab | flushed with `inputValue` (see draft write-back below)     |

`AITab.commandMode` is typed `ComposerCommandMode | boolean` because builds before AI command mode wrote `true` for what is now `'shell'`, and those values are still on disk. **Always read it through `normalizeComposerCommandMode()`**, which maps `true` -> `'shell'` and anything unrecognised -> `'off'` (a corrupt value must land the user in chat, never in a shell).

**The invariant:** the same string is a shell command, a request for one, or a message to the agent depending only on this value. Any path that persists or restores `inputValue` MUST carry `commandMode` with it, or a restored draft routes the wrong way. `syncAiInputToSession` reads the mode from the store itself rather than taking it as an argument, precisely so a caller cannot forget it; the queued write-back carries it too.

Because the value is a union now, **never test it for truthiness** - `'off'` is a truthy string. Compare against `'off'` / `'shell'` / `'ai'`, or use `isShellCommandMode()` / `isAiCommandMode()`.

### Drafts are written back on a typing timer, and always to the tab they were typed in

`useInputSync` owns both halves of draft persistence:

| Function                                       | When                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| `queueAiDraftFlush(tabId, value, commandMode)` | every keystroke, coalesced over ~300ms of idle           |
| `syncAiInputToSession(value, tabId?)`          | blur / submit / tab switch - supersedes any queued write |

Two rules keep drafts from being lost, and both exist because they were broken before:

1. **No flush point is load bearing.** The live text lives in `composerInputStore` (one global slot, deliberately outside session state so a keystroke doesn't re-render the app). Anything that skipped blur/submit/tab-switch - a quit while typing, an unmount, focus that never left the textarea - used to throw the text away. The keystroke-driven write-back means session state is never more than a typing pause behind, and window blur / visibility hide flush it immediately. A write whose text and mode already match the tab returns the same session reference, so the timer costs nothing when nothing changed.
2. **Every write is attributed to a tab id, never to "the active tab".** A flush that lands after the active tab moved (blur arriving late, an async continuation) would otherwise stamp its text onto the newly active tab - erasing that tab's draft with text from another one. Pass the tab id whenever the write can land later than the moment it was scheduled.

`utils/shellCommandInput.ts` is down to two helpers:

| Function                                 | Job                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `detectCommandModeEntry(prev, next)`     | Should this edit climb a rung? Returns the text to keep, bang eaten  |
| `nextComposerCommandMode(mode)`          | The rung a `!` climbs to, or null when there is none above           |
| `previousComposerCommandMode(mode)`      | The rung Escape climbs down to; `'off'` is the floor                 |
| `normalizeComposerCommandMode(raw)`      | Persisted value (including the legacy boolean) -> a mode             |
| `isShellCommandMode` / `isAiCommandMode` | Rung predicates, so call sites don't compare strings inline          |
| `stripShellCommandEscape(v)`             | Unwraps `\!foo` -> `!foo` for messages that really start with a bang |

Entry requires the composer to have been **empty** before the edit, so retrofitting a `!` onto an in-progress message doesn't silently turn a sentence into a shell command - and so `echo !` stays shell text rather than climbing.

Surfaces that consume the mode: `InputArea` (reads the store once, derives `isShellCommandDraft` / `isAiCommandDraft` / `isShellInput`, passes them down), `useInputKeyDown` (Tab trigger, dropdown navigation, the Escape/Backspace ladder, and the proposal card's answer keys), `useInputHandlers` (which composer slice completion reads, the attachment guards, plus the `getCommandMode` dep threaded into `useInputProcessing`), and `useInputAreaTextChange` (the `!` gesture, and suppressing `@` mentions and slash commands - in a shell line `@` is an scp target and `/` starts an absolute path, and in a prose request neither belongs).

### aiCommand.ts - AI command mode

Turns a plain-English request into one shell command line, shows it, and runs it only after a yes/no. The composer's second bang rung.

**Key exports:**

- `requestAiCommand({ session, tabId, request })` - ask the tab's OWN provider, at its current model and effort (resolved with `codifyTurnSettings`, the same helper a chat turn uses), for one command line. Fire and forget: everything visible is driven off `aiCommandStore`
- `acceptAiCommand(session, entry)` - run the proposal through `dispatchShellCommand`
- `dismissAiCommand(entry)` - clear the card and RETURN the original request text, so declining hands it back to the composer for editing

**State** lives in `stores/aiCommandStore.ts`, keyed per AI tab (`${sessionId}:${tabId}`), never on the session model: nothing here survives a restart, and a proposal the user never answered must not come back days later attached to a stale working directory. Each attempt carries a `requestId`, because the model round trip cannot be cancelled once dispatched - a reply that lands after a dismissal (or after a second request replaced the first) is dropped rather than resurrecting a card the user closed.

**The model call** is `aiCommand:suggest` in the main process (`ipc/handlers/aiCommand.ts`), which builds the prompt with `shared/aiCommand.ts` and runs it through `groomContext` with `readOnlyMode` AND `disableTools`. Both flags matter: with tools available, a task-shaped request ("clean up the build output") makes the model try to DO the work instead of naming the command. The prompt itself is `src/prompts/ai-command.md`, editable in Settings -> Maestro Prompts like any other core prompt.

**The handler never executes anything.** The accepted command goes back through the ordinary command-mode path, so a suggested command and a typed one run in the same directory, on the same SSH remote, through the same code.

`shared/aiCommand.ts` holds the two pure pieces, unit-testable without either process: `buildAiCommandPrompt()` (the request is substituted LAST, so a request containing `{{CWD}}` cannot rewrite the environment block above it) and `extractCommandLine()` (strips fences, `$`/`%` prompts, wrapping backticks, and lead-in lines; returns null rather than proposing an empty run).

---

### contextGroomer.ts (~430 lines)

Manages merging multiple conversation contexts across agents.

**Key exports:**

- `AGENT_ARTIFACTS` - Per-agent artifact patterns to strip during transfer (slash commands, brand references, model names)
- `AGENT_TARGET_NOTES` - Per-agent capability descriptions for transfer context
- `buildContextTransferPrompt(sourceAgent, targetAgent)` - Builds a prompt with agent-specific artifact removal instructions
- `ContextGroomingService` class (singleton: `contextGroomingService`)

**Grooming workflow:**

1. Collect and format source contexts
2. Calculate original token count
3. Call `window.maestro.context.groomContext()` with grooming prompt
4. Parse groomed output via `parseGroomedOutput` (from contextExtractor utils)
5. Report token savings

Shared utilities imported from `renderer/utils/contextExtractor`:

- `formatLogsForGrooming` - Formats LogEntry arrays into text
- `parseGroomedOutput` - Parses groomed text back to LogEntry arrays
- `estimateTokenCount` - Estimates tokens from a ContextSource
- `calculateTotalTokens` - Sums token counts across sources

Does NOT use `createIpcMethod`; uses direct `window.maestro.context.*` calls.

---

### contextSummarizer.ts (~489 lines)

Manages compacting a single conversation context to reduce context window usage.

**Key constants:**

- `MAX_SUMMARIZE_TOKENS = 50000` - Single-pass limit
- `TARGET_COMPACTED_TOKENS = 40000` - Multi-pass target
- `MIN_TOKENS_FOR_SUMMARIZATION = 2000` - Fallback threshold
- `MIN_LOG_ENTRIES_FOR_SUMMARIZATION = 8` - Second fallback
- `MAX_CONSOLIDATION_DEPTH = 3` - Prevents infinite loops

**`ContextSummarizationService` class** (singleton: `contextSummarizationService`):

- `summarizeContext(request, sourceLogs, onProgress)` - Main entry. Chunks large contexts automatically.
- `canSummarize(contextUsage, logs?)` - Triple-fallback eligibility check (context %, token estimate, log count)
- `cancelSummarization()` - Calls `window.maestro.context.cancelGrooming()`
- `formatCompactedTabName(originalName)` - Generates "Name Compacted YYYY-MM-DD"

**Chunked summarization:**
Large contexts (>50k tokens) are split into chunks, each summarized separately, then combined. If the combined result exceeds `TARGET_COMPACTED_TOKENS`, up to 3 consolidation passes aggressively reduce it.

Shares the same utilities from `contextExtractor` as contextGroomer: `formatLogsForGrooming`, `parseGroomedOutput`, `estimateTextTokenCount`.

---

### wizardIntentParser.ts (~277 lines)

Parses natural language input after `/wizard` command to determine user intent.

**`parseWizardIntent(input, hasExistingDocs)`** - Returns `{ mode, goal? }`:

- `'new'` - Create new documents from scratch
- `'iterate'` - Modify/extend existing documents (includes extracted goal)
- `'ask'` - Ambiguous, needs user clarification

Detection logic (priority order):

1. Empty input + no docs -> `new`; empty input + docs -> `ask`
2. Prefix match against `NEW_MODE_KEYWORDS` (21 keywords: new, fresh, start, create, begin, scratch, etc.)
3. Prefix match against `ITERATE_MODE_KEYWORDS` (21 keywords: continue, iterate, add, update, modify, etc.)
4. Anywhere-in-input match for both keyword sets
5. Ambiguous fallback: with docs -> `ask`, without docs -> `new`

**Helper functions:**

- `suggestsIterateIntent(input)` - Regex-based patterns ("I want to add...", "can you update...", etc.)
- `suggestsNewIntent(input)` - Regex-based patterns ("start from scratch", "new project", etc.)

Pure logic, no IPC calls.

---

### inlineWizardConversation.ts (~873 lines)

Manages AI conversations during inline wizard mode. Each message spawns a new agent process in batch mode (stateless per-message approach).

**Key functions:**

- `generateInlineWizardPrompt(config)` - Builds system prompt from mode-specific templates (`wizardInlineIteratePrompt` / `wizardInlineNewPrompt`), substitutes template variables
- `startInlineWizardConversation(config)` - Creates session config (no process spawn yet)
- `sendWizardMessage(session, userMessage, history, callbacks?)` - Spawns agent, collects output, parses structured JSON response
- `parseWizardResponse(response)` - Delegates to shared `parseStructuredOutput`, applies `READY_CONFIDENCE_THRESHOLD` (80)
- `endInlineWizardConversation(session)` - Kills process if active

**Agent-specific handling:**

- `buildArgsForAgent(agent)` - Configures per-agent CLI args. Claude Code gets `--allowedTools Read,Glob,Grep,LS` (read-only). Codex/OpenCode use base args.
- `extractResultFromStreamJson(output, agentType)` - Parses Claude Code `result` messages, OpenCode `text` parts, Codex `agent_message` content

**Process management:**

- 20-minute inactivity timeout (resets on any output)
- Registers `onData`, `onExit`, `onThinkingChunk`, `onToolExecution` listeners directly on `window.maestro.process`
- Does NOT use `processService` wrapper

---

### inlineWizardDocumentGeneration.ts (~1,292 lines)

Generates Auto Run documents from wizard conversation results. The largest service file.

**Key functions:**

- `generateInlineDocuments(config)` - Main orchestrator:
  1. Creates date-prefixed subfolder (e.g., "2026-03-21-Feature-Name")
  2. Sets up file watcher on subfolder for real-time streaming
  3. Spawns agent process with generation prompt
  4. Routes both chokidar file-change events and a periodic disk poll through a shared `createPlaybookDocumentEmitter` so each doc surfaces to the UI exactly once (the poll backstops the macOS fsevents cold-start window where add events go missing)
  5. Falls back to parsing document markers from output if neither watcher nor poll caught the file
  6. Creates a playbook configuration for generated documents
- `createPlaybookDocumentEmitter(options)` - Factory returning a `PlaybookDocumentEmitter` that owns the dedup set across watcher + poll inputs. Exposes `tryEmitFile`, `pollAndEmit`, `getEmittedDocuments`, `hasEmitted`. Built as a factory (not a class) so tests can mock `window.maestro.fs` / `window.maestro.autorun` without subclassing.
- `generateDocumentPrompt(config, subfolder?)` - Builds prompt from mode-specific templates
- `parseGeneratedDocuments(output)` - Extracts `---BEGIN DOCUMENT---` / `---END DOCUMENT---` blocks with FILENAME, UPDATE, and CONTENT fields
- `splitIntoPhases(content)` - Fallback splitter when agent produces single large document
- `countTasks(content)` - Counts `- [ ]` / `- [x]` checkbox items
- `sanitizeFilename(filename)` - Prevents path traversal attacks
- `extractDisplayTextFromChunk(chunk, agentType)` - Parses streaming JSON for display text

**Duplicated functions** (also in inlineWizardConversation.ts):

- `extractResultFromStreamJson` - Identical logic for parsing agent output
- `buildArgsForAgent` - Similar but allows Write tool (conversation version restricts to read-only)

---

### speckit.ts (~57 lines)

SpecKit slash command service. Wraps `window.maestro.speckit.*`:

- `getSpeckitCommands()` - Get all spec-kit commands
- `getSpeckitMetadata()` - Get version and refresh date
- `getSpeckitCommand(slashCommand)` - Get single command by slash string

Uses manual try/catch (does not use `createIpcMethod`).

---

### openspec.ts (~57 lines)

OpenSpec slash command service. Wraps `window.maestro.openspec.*`:

- `getOpenSpecCommands()` - Get all OpenSpec commands
- `getOpenSpecMetadata()` - Get version and refresh date
- `getOpenSpecCommand(slashCommand)` - Get single command by slash string

Structurally identical to speckit.ts - same 3 functions, same error handling pattern, same return types. Only the IPC namespace differs.

---

### systemSleep.ts (~90 lines)

Machine-sleep accounting for the renderer. Any duration measured as
`Date.now() - start` counts an overnight suspend as work: the wall clock runs while the
process is frozen, and a system suspend never fires `visibilitychange` (the window stays
"visible" the whole time). The main process measures the real gap with `powerMonitor` and
ships it over `app:systemResume`; this module accumulates it and every Auto Run duration
subtracts it.

- `beginSleepAwareSpan()` / `sleepAwareElapsedMs(span)` - the preferred pair. Per task, per
  loop, per run.
- `onSystemSleep(handler)` - for a live tracker that pauses its own clock (`useTimeTracking`
  walks its per-session timestamps forward by the gap).
- `sleepAwareElapsedSince(startTime)` - for a display that only kept a start timestamp
  (the Auto Run pill, the thinking timer).
- `getTotalSleepMs()`, `recordSystemSleep()` (tests), `resetSystemSleepTracking()` (tests).

Singleton: one IPC listener, attached lazily on first use, one counter, so every consumer
measures the same sleep. The math lives in `src/shared/sleepTracking.ts` and is shared with
the main-process counterpart `src/main/utils/sleep-tracker.ts`.

---

### index.ts (~45 lines)

Barrel export file. Re-exports from:

- `git` (gitService + types)
- `process` (processService + types)
- `ipcWrapper` (createIpcMethod + types)
- `contextGroomer` (ContextGroomingService + singleton + types)
- `contextSummarizer` (ContextSummarizationService + singleton + types)
- `systemSleep` (span helpers, `onSystemSleep`, `getTotalSleepMs` + types)
- `wizardIntentParser` (parseWizardIntent, suggestsIterateIntent, suggestsNewIntent + types)

Notable omissions from the barrel: `speckit.ts`, `openspec.ts`, `inlineWizardConversation.ts`, `inlineWizardDocumentGeneration.ts` are imported directly by consumers.

---

## Constants Overview

### themes.ts (~10 lines)

Pure re-export from `src/shared/themes.ts`. No definitions in this file - all theme data lives in the shared layer.

Exports: `THEMES`, `DEFAULT_CUSTOM_THEME_COLORS`, `getThemeById`, type exports for `Theme`, `ThemeId`, `ThemeColors`, `ThemeMode`.

---

### shortcuts.ts (~193 lines)

Defines all keyboard shortcuts in three tiers:

**`DEFAULT_SHORTCUTS`** (30+ entries) - User-configurable:

- Panel toggles: sidebar, right panel, AI/shell mode
- Agent navigation: previous/next, jump to session
- View actions: files tab, history tab, Auto Run tab, git diff, git log
- Actions: new agent, kill agent, quick actions, settings, help
- Editor: markdown mode, auto-scroll, bookmarks, font size reset
- Modals: prompt composer, wizard, symphony, director's notes

**`FIXED_SHORTCUTS`** (10+ entries) - Displayed but not configurable:

- Jump to session (Alt+Cmd+1-0)
- Context-specific filters (Cmd+F in various views)
- File preview navigation (Cmd+Arrow)
- Font size increase/decrease

**`TAB_SHORTCUTS`** (20+ entries) - AI mode only:

- Tab CRUD: new, close, close all, close others, close left/right, reopen
- Tab navigation: switcher, previous/next, go to tab 1-9, last tab
- Tab actions: rename, toggle read-only, toggle save to history, toggle show thinking, toggle unread, toggle star

Each shortcut has `id`, `label`, and `keys` array.

---

### modalPriorities.ts (~243 lines)

Defines priority/z-index values for all modals and overlays. Used by the layer stack system for Escape key handling and visual stacking.

**Priority Ranges:**

| Range   | Category              | Examples                                                                           |
| ------- | --------------------- | ---------------------------------------------------------------------------------- |
| 1000+   | Critical/Celebrations | Standing ovation (1100), Keyboard mastery (1095), Tour (1050), Quit confirm (1020) |
| 900-999 | High priority         | Gist publish (980), Playbook delete (950), Rename instance (900)                   |
| 700-899 | Standard modals       | Wizard (760), New instance (750), Batch runner (720), Quick action (700)           |
| 600-699 | Group chat + info     | New group chat (650), Shortcuts help (650), About (600)                            |
| 400-599 | Settings + analytics  | Process monitor (550), Usage dashboard (540), Log viewer (500), Settings (450)     |
| 100-399 | Overlays + previews   | Git diff (200), Git log (190), Lightbox (150), File preview (100)                  |
| 1-99    | Autocomplete          | Slash autocomplete (50), File tree filter (30)                                     |

Exported as `MODAL_PRIORITIES` const object with 60+ named entries.

---

### app.ts (~113 lines)

Claude Code tool-related constants for output parsing.

**`KNOWN_TOOL_NAMES`** - Array of 19 known tool names (Task, Bash, Glob, Grep, Read, Edit, Write, etc.)

**`isLikelyConcatenatedToolNames(text)`** - Detects malformed output like "TaskGrepGrepReadReadRead" by checking if text is composed of 3+ consecutive tool names. Also handles MCP tool patterns (`mcp__provider__tool`).

**`CLAUDE_BUILTIN_COMMANDS`** - Map of 10 built-in Claude Code slash commands to descriptions (compact, context, cost, init, pr-comments, release-notes, todos, review, security-review, plan).

**`getSlashCommandDescription(cmd)`** - Returns description for built-in commands, parses plugin commands (`plugin:command`), falls back to generic description.

---

### agentIcons.ts (~80 lines)

Maps agent type IDs to emoji display icons.

**`AGENT_ICONS`** - Record mapping:

- `claude-code` / `claude` -> robot emoji
- `codex` / `openai-codex` -> diamond
- `gemini-cli` / `gemini` -> blue diamond
- `qwen3-coder` / `qwen` -> hexagon
- `opencode` -> pager
- `factory-droid` -> factory
- `terminal` -> laptop

**`getAgentIcon(agentId)`** / **`getAgentIconForToolType(toolType)`** - Safe lookup with `DEFAULT_AGENT_ICON` (wrench) fallback.

Used by `SendToAgentModal` and `useAvailableAgents` hook.

---

### colorblindPalettes.ts (~288 lines)

Comprehensive accessibility color system based on Wong's palette (Nature Methods, 2011).

**Color Palettes:**

- `COLORBLIND_AGENT_PALETTE` - 10 colors for agent/categorical data
- `COLORBLIND_BINARY_PALETTE` - 2 colors (blue/orange) for binary comparisons
- `COLORBLIND_HEATMAP_SCALE` - 5-level sequential scale (light yellow to dark blue)
- `COLORBLIND_LINE_COLORS` - 3 colors for line charts
- `COLORBLIND_EXTENSION_PALETTE` - 15 file type categories with light/dark mode variants

**Pattern fills** for additional visual distinction:

- `COLORBLIND_PATTERNS` - solid, diagonal, dots, crosshatch, horizontal, vertical

**Helper functions:**

- `getColorBlindAgentColor(index)` - Wrapping index lookup
- `getColorBlindHeatmapColor(intensity)` - Clamped 0-4 lookup
- `getColorBlindPattern(index)` - Wrapping pattern lookup
- `getColorBlindExtensionColor(extension, isLightTheme)` - Maps file extensions to category colors (TS/JS, markdown, config, CSS, HTML, Python, Rust, Go, shell, images, Java, C/C++, Ruby, SQL, PDF)

Used extensively by UsageDashboard charts and SymphonyModal.

---

### conductorBadges.ts (~346 lines)

Gamification system tracking cumulative AutoRun time with conductor-themed achievements.

**11 badge levels:**

| Level | Name                      | Required Time |
| ----- | ------------------------- | ------------- |
| 1     | Apprentice Conductor      | 15 minutes    |
| 2     | Assistant Conductor       | 1 hour        |
| 3     | Associate Conductor       | 8 hours       |
| 4     | Resident Conductor        | 24 hours      |
| 5     | Principal Guest Conductor | 1 week        |
| 6     | Chief Conductor           | 30 days       |
| 7     | Music Director            | 3 months      |
| 8     | Maestro Emeritus          | 6 months      |
| 9     | World Maestro             | 1 year        |
| 10    | Grand Maestro             | 5 years       |
| 11    | Titan of the Baton        | 10 years      |

Each badge includes name, description, a historical example conductor with Wikipedia link, and flavor text.

**Helper functions:**

- `getBadgeForTime(cumulativeTimeMs)` - Returns highest qualifying badge
- `getNextBadge(currentBadge)` - Returns next badge or null
- `getProgressToNextBadge(time, current, next)` - 0-100 progress
- `formatTimeRemaining(time, nextBadge)` - Human-readable remaining time
- `formatCumulativeTime(timeMs)` - Human-readable elapsed time

Used by AchievementCard, LeaderboardRegistrationModal, PlaygroundPanel, SessionList.

---

### keyboardMastery.ts (~47 lines)

Keyboard shortcut mastery progression system.

**5 levels:**

| Level     | Name             | Threshold |
| --------- | ---------------- | --------- |
| beginner  | Beginner         | 0%        |
| student   | Student          | 25%       |
| performer | Performer        | 50%       |
| virtuoso  | Virtuoso         | 75%       |
| maestro   | Keyboard Maestro | 100%      |

**Helper functions:**

- `getLevelForPercentage(percentage)` - Returns highest matching level
- `getLevelIndex(percentage)` - Returns index 0-4

Used by ShortcutsHelpModal, KeyboardMasteryCelebration, LeaderboardRegistrationModal, PlaygroundPanel, settingsStore.

---

### cuePatterns.ts (~224 lines)

Defines `CuePattern` interface and the `CUE_PATTERNS` array - preset Cue YAML templates (startup, file watch, interval, etc.) surfaced in the Cue modal for users to pick from.

---

## IPC Access Patterns

**Services using `createIpcMethod`:** `git.ts` (7 calls), `process.ts` (5 calls)

**Services with direct `window.maestro.*` calls:**

- `contextGroomer.ts` - 2 calls to `window.maestro.context.*`
- `contextSummarizer.ts` - 4 calls to `window.maestro.context.*`
- `inlineWizardConversation.ts` - 8 calls to `window.maestro.process.*` and `window.maestro.agents.*`
- `inlineWizardDocumentGeneration.ts` - 15+ calls across `window.maestro.process.*`, `window.maestro.autorun.*`, `window.maestro.agents.*`, `window.maestro.fs.*`
- `speckit.ts` - 3 calls to `window.maestro.speckit.*`
- `openspec.ts` - 3 calls to `window.maestro.openspec.*`

The wizard services and context services bypass both `createIpcMethod` and `processService`, calling the preload bridge directly. They manage their own error handling, event listeners, timeouts, and cleanup.
