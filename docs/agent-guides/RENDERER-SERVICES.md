# Renderer Services and Constants Guide

Covers `src/renderer/services/` (11 files, ~3,970 lines) and `src/renderer/constants/` (8 files, ~1,596 lines).

---

## Services Overview

The services directory provides a clean API layer between React components and the Electron main process via IPC. Services wrap `window.maestro.*` calls exposed by the preload bridge.

### Architecture

```
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
  4. Watches for files created by agent, notifies callbacks
  5. Falls back to parsing document markers from output if watcher misses them
  6. Creates a playbook configuration for generated documents
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

### index.ts (~36 lines)

Barrel export file. Re-exports from:
- `git` (gitService + types)
- `process` (processService + types)
- `ipcWrapper` (createIpcMethod + types)
- `contextGroomer` (ContextGroomingService + singleton + types)
- `contextSummarizer` (ContextSummarizationService + singleton + types)
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
- View actions: files tab, history tab, auto run tab, git diff, git log
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
| Range | Category | Examples |
|-------|----------|---------|
| 1000+ | Critical/Celebrations | Standing ovation (1100), Keyboard mastery (1095), Tour (1050), Quit confirm (1020) |
| 900-999 | High priority | Gist publish (980), Playbook delete (950), Rename instance (900) |
| 700-899 | Standard modals | Wizard (760), New instance (750), Batch runner (720), Quick action (700) |
| 600-699 | Group chat + info | New group chat (650), Shortcuts help (650), About (600) |
| 400-599 | Settings + analytics | Process monitor (550), Usage dashboard (540), Log viewer (500), Settings (450) |
| 100-399 | Overlays + previews | Git diff (200), Git log (190), Lightbox (150), File preview (100) |
| 1-99 | Autocomplete | Slash autocomplete (50), File tree filter (30) |

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
| Level | Name | Required Time |
|-------|------|--------------|
| 1 | Apprentice Conductor | 15 minutes |
| 2 | Assistant Conductor | 1 hour |
| 3 | Associate Conductor | 8 hours |
| 4 | Resident Conductor | 24 hours |
| 5 | Principal Guest Conductor | 1 week |
| 6 | Chief Conductor | 30 days |
| 7 | Music Director | 3 months |
| 8 | Maestro Emeritus | 6 months |
| 9 | World Maestro | 1 year |
| 10 | Grand Maestro | 5 years |
| 11 | Titan of the Baton | 10 years |

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
| Level | Name | Threshold |
|-------|------|-----------|
| beginner | Beginner | 0% |
| student | Student | 25% |
| performer | Performer | 50% |
| virtuoso | Virtuoso | 75% |
| maestro | Keyboard Maestro | 100% |

**Helper functions:**
- `getLevelForPercentage(percentage)` - Returns highest matching level
- `getLevelIndex(percentage)` - Returns index 0-4

Used by ShortcutsHelpModal, KeyboardMasteryCelebration, LeaderboardRegistrationModal, PlaygroundPanel, settingsStore.

---

### cuePatterns.ts

This file does not exist in the codebase.

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
