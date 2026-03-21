# Process System Guide

Covers process spawning, output event routing, and the web server for remote access.

Source directories:
- `src/main/process-manager/` - Process spawning and lifecycle
- `src/main/process-listeners/` - Event routing from processes to renderer/web
- `src/main/web-server/` - HTTP/WebSocket server for mobile/remote access

---

## 1. Process Manager

**Entry point:** `src/main/process-manager/ProcessManager.ts`

### ProcessManager Class

`ProcessManager` extends `EventEmitter` and is the central orchestrator for all spawned processes - both AI agents and terminal shells.

**Internal state:**
- `processes: Map<string, ManagedProcess>` - All active processes keyed by session ID
- Delegates to specialized subsystems: `PtySpawner`, `ChildProcessSpawner`, `DataBufferManager`, `LocalCommandRunner`, `SshCommandRunner`

**Public methods:**

| Method | Purpose |
|--------|---------|
| `spawn(config)` | Spawn a new process (routes to PTY or child_process) |
| `write(sessionId, data)` | Write to a process's stdin |
| `resize(sessionId, cols, rows)` | Resize a PTY terminal |
| `interrupt(sessionId)` | Send SIGINT/Ctrl+C with kill escalation |
| `kill(sessionId)` | Force-kill a process (taskkill on Windows) |
| `killAll()` | Kill every managed process |
| `get(sessionId)` | Get a ManagedProcess by ID |
| `getAll()` | Get all active ManagedProcess entries |
| `getParser(sessionId)` | Get the output parser for a session's agent |
| `parseLine(sessionId, line)` | Parse a JSON line using the session's parser |
| `runCommand(sessionId, cmd, cwd, ...)` | Run a one-off command (local or SSH) |

**Emitted events** (defined in `ProcessManagerEvents`):
- `data` - stdout output (buffered)
- `stderr` - stderr output
- `exit` - process exited
- `command-exit` - one-off command exited (separate from PTY exit)
- `usage` - token/cost usage stats
- `session-id` - agent's internal session ID discovered
- `agent-error` - structured error (auth, rate limit, crash)
- `thinking-chunk` - partial streaming text from agent reasoning
- `tool-execution` - tool use events (OpenCode, Codex)
- `slash-commands` - available slash commands from agent init
- `query-complete` - batch query finished (for stats tracking)

### Spawning Strategy: PTY vs child_process

The `shouldUsePty()` decision is simple:
- **PTY** (`PtySpawner`): Used when `toolType === 'terminal'` OR `requiresPty === true`, AND there is no prompt. PTY gives full terminal emulation with ANSI codes, resize support, and shell aliases.
- **child_process** (`ChildProcessSpawner`): Used for AI agents in batch/interactive mode. Provides clean stdout/stderr separation and JSON stream parsing.

### PtySpawner (`spawners/PtySpawner.ts`)

Spawns via `node-pty`. For terminal mode, it opens the user's configured shell with `-l -i` flags (login + interactive). For AI agents needing PTY, it spawns the agent command directly.

Key behaviors:
- Environment built via `buildPtyTerminalEnv()` (terminal) or `buildChildProcessEnv()` (AI agent in PTY)
- Output goes through `stripControlSequences()` then `DataBufferManager.emitDataBuffered()`
- On exit, buffer is flushed before emitting `exit` event

### ChildProcessSpawner (`spawners/ChildProcessSpawner.ts`)

Spawns via Node's `child_process.spawn()`. This is the workhorse for AI agent interactions.

Key responsibilities:
- Builds final args from config: prompt, images (stream-json or file-based), custom args
- Determines `isStreamJsonMode` from args patterns or SSH stdin script
- Gets the correct `AgentOutputParser` for the agent type
- Wires up `StdoutHandler`, `StderrHandler`, `ExitHandler`
- Handles stdin writing: SSH script, raw prompt, stream-json message, or close for batch
- Windows-specific: auto-enables shell for `.exe` basenames and shell scripts, escapes args for cmd.exe or PowerShell

### Handler Classes

**DataBufferManager** (`handlers/DataBufferManager.ts`):
Batches `data` events to reduce IPC frequency. Flushes every 50ms or when buffer exceeds 8KB.

**StdoutHandler** (`handlers/StdoutHandler.ts`):
The largest handler. Processes stdout in three modes:
1. **Stream-JSON mode**: Splits on newlines, parses each JSON line, extracts usage/session-id/errors/results
2. **Batch mode**: Accumulates all output into jsonBuffer (parsed at exit)
3. **Pass-through**: Emits directly via DataBufferManager

Also handles:
- Error detection via `outputParser.detectErrorFromParsed()` and `matchSshErrorPattern()`
- Usage normalization for cumulative reporters (Claude Code, Codex) via `normalizeUsageToDelta()`
- Thinking chunks, tool execution events, slash commands
- Agent-specific result handling (Codex multi-step, OpenCode step resets)

**StderrHandler** (`handlers/StderrHandler.ts`):
- Accumulates stderr for exit-time analysis (capped at 100KB)
- Detects errors via parser and SSH patterns
- Filters known SSH info messages and Codex tracing lines
- Re-emits Codex content from stderr as regular data

**ExitHandler** (`handlers/ExitHandler.ts`):
- Flushes remaining data buffers
- Processes remaining jsonBuffer content (handles missing trailing newline)
- Handles batch mode JSON parsing at exit
- Runs error detection on exit code + stderr/stdout buffers
- SSH error detection on combined output
- Cleans up temp image files
- Emits `query-complete` for stats tracking

### Runner Classes

**LocalCommandRunner** (`runners/LocalCommandRunner.ts`):
Runs one-off terminal commands. On Unix, uses a transient PTY for shell alias support. On Windows, uses `child_process.spawn` with shell. Sources shell config files (`.zshrc`, `.bash_profile`).

**SshCommandRunner** (`runners/SshCommandRunner.ts`):
Runs terminal commands on remote hosts via SSH. Builds SSH args (key, options, port, destination), wraps command with `cd` and env exports, and spawns the SSH binary directly.

### Utility Modules

| File | Purpose |
|------|---------|
| `utils/envBuilder.ts` | Builds process environments. `buildChildProcessEnv()` strips Electron vars, expands paths, merges global + session env vars. `buildPtyTerminalEnv()` builds terminal env. `buildUnixBasePath()` detects Node version manager paths. |
| `utils/bufferUtils.ts` | `appendToBuffer()` - append with 100KB size cap |
| `utils/imageUtils.ts` | Save base64 images to temp files, build prompt prefixes, cleanup |
| `utils/pathResolver.ts` | Resolve shell paths (cached), build wrapped commands with config sourcing, build interactive shell args |
| `utils/shellEscape.ts` | Windows shell escaping for cmd.exe and PowerShell, shell selection logic to avoid cmd.exe's 8KB limit |
| `utils/streamJsonBuilder.ts` | Build stream-json messages for Claude Code (images + text as JSON) |

### Types (`types.ts`)

**ProcessConfig** - Input to `spawn()`. Key fields: `sessionId`, `toolType`, `command`, `args`, `prompt`, `images`, `requiresPty`, `shell`, `customEnvVars`, `sshStdinScript`, `sendPromptViaStdin`.

**ManagedProcess** - Internal tracked state. Includes PTY or child process handles, buffers (json, stderr, stdout, data, streamed text), parser, usage totals, timing, and SSH context.

**ProcessManagerEvents** - TypeScript interface documenting all emitted events.

---

## 2. Process Listeners

**Entry point:** `src/main/process-listeners/index.ts`

`setupProcessListeners()` wires up all ProcessManager events to the renderer (via IPC) and to the web server (via WebSocket broadcast). Each listener is in its own file.

### Dependency Injection

All listeners receive a `ProcessListenerDependencies` object containing:
- `safeSend` - IPC send function
- `getWebServer`, `getProcessManager`, `getAgentDetector` - lazy getters
- `powerManager` - sleep prevention
- `groupChatEmitters`, `groupChatRouter`, `groupChatStorage` - group chat integration
- `sessionRecovery`, `outputBuffer`, `outputParser` - support utilities
- `usageAggregator` - token counting
- `getStatsDB` - usage database
- `patterns` - compiled regex patterns for session ID parsing

### Listener Modules

**forwarding-listeners.ts** - Simple pass-through forwarding:
- `slash-commands` -> `process:slash-commands`
- `thinking-chunk` -> `process:thinking-chunk`
- `tool-execution` -> `process:tool-execution`
- `stderr` -> `process:stderr`
- `command-exit` -> `process:command-exit`

**data-listener.ts** - Output data routing:
- Group chat moderator sessions: buffers output (routed on exit)
- Group chat participant sessions: buffers output (routed on exit)
- Regular sessions: forwards via `safeSend('process:data', ...)`
- Web broadcast: extracts base session ID, generates message ID, broadcasts `session_output` to subscribed clients
- Skips PTY terminal output and batch/synopsis output for web broadcast

**usage-listener.ts** - Token/cost statistics:
- Group chat participants: calculates context usage percentage, updates participant storage
- Group chat moderator: emits moderator usage events
- Regular sessions: forwards via `safeSend('process:usage', ...)`
- Uses `FALLBACK_CONTEXT_WINDOW` when agent doesn't report one

**session-id-listener.ts** - Agent session ID tracking:
- Group chat participants: stores `agentSessionId` on participant, emits `participantsChanged`
- Group chat moderator: stores `moderatorAgentSessionId`, emits `moderatorSessionIdChanged`
- All sessions: forwards via `safeSend('process:session-id', ...)`

**error-listener.ts** - Agent error handling:
- Logs error details (type, message, recoverability)
- Forwards via `safeSend('agent:error', ...)`

**stats-listener.ts** - Query completion tracking:
- Listens to `query-complete` events from batch mode processes
- Inserts query events into StatsDB with retry logic (3 attempts, exponential backoff)
- Broadcasts `stats:updated` to renderer for dashboard refresh

**exit-listener.ts** - Process exit handling (most complex):
- Removes power block reason
- Group chat moderator exit: loads chat, parses buffered output via `extractTextFromStreamJson()`, routes response (checks for @mentions), sets state to idle. Includes retry logic for transient chat load failures.
- Group chat participant exit: parses buffered output, handles session recovery (detects `session_not_found`, respawns with recovery context), routes agent response, triggers synthesis when all participants have responded
- Regular sessions: forwards via `safeSend('process:exit', ...)`
- Web broadcast: extracts base session ID, broadcasts `session_exit`

**wakatime-listener.ts** - WakaTime integration:
- Sends heartbeats on `data` and `thinking-chunk` events (debounced by WakaTimeManager)
- Collects file paths from `tool-execution` events for detailed tracking
- Flushes file heartbeats on `query-complete` and `usage` events
- Cleans up on `exit`

### Event Flow

```
Agent Process
    |
    v
ProcessManager (emits events)
    |
    v
Process Listeners
    |
    +---> safeSend() ---> Electron IPC ---> Renderer
    |
    +---> WebServer.broadcastToSessionClients() ---> WebSocket ---> Mobile/Web
    |
    +---> StatsDB (query-complete only)
    |
    +---> WakaTimeManager (heartbeats)
    |
    +---> GroupChat router/storage (group chat sessions)
```

---

## 3. Web Server

**Entry point:** `src/main/web-server/WebServer.ts`

### Architecture Overview

The web server provides HTTP and WebSocket access to Maestro for mobile devices and remote browsers. Built on Fastify with `@fastify/websocket`, `@fastify/cors`, `@fastify/rate-limit`, and `@fastify/static`.

**URL structure:**
```
http://IP:PORT/                          -> Redirect to runmaestro.ai
http://IP:PORT/health                    -> Health check (no auth)
http://IP:PORT/$TOKEN/                   -> Dashboard (SPA)
http://IP:PORT/$TOKEN/session/$UUID      -> Session view (SPA)
http://IP:PORT/$TOKEN/api/*              -> REST API
http://IP:PORT/$TOKEN/ws                 -> WebSocket
http://IP:PORT/$TOKEN/assets/*           -> Static assets
http://IP:PORT/$TOKEN/manifest.json      -> PWA manifest
http://IP:PORT/$TOKEN/sw.js              -> Service worker
```

### Security

- UUID security token required in all URLs (except `/health`)
- Token regenerated per app restart (ephemeral mode) or persisted in settings (persistent web link mode)
- Invalid/missing tokens redirect to `runmaestro.ai`
- Token validated as UUID v4 format when loading from storage
- Session IDs and tab IDs sanitized to alphanumeric+hyphens to prevent XSS injection in HTML responses

### WebServer Class

Composes several extracted subsystems:
- `LiveSessionManager` - tracks which sessions are "live" (visible in web UI)
- `CallbackRegistry` - stores all callback functions for session operations
- `WebSocketMessageHandler` - handles incoming WebSocket messages
- `BroadcastService` - sends outgoing messages to connected clients
- `ApiRoutes`, `StaticRoutes`, `WsRoute` - route handlers

Lifecycle: `constructor()` initializes all components, `start()` registers middleware/routes and listens on port (0 = OS-assigned), `stop()` cleans up.

### Routes

**Static Routes** (`routes/staticRoutes.ts`):
- `/` - Redirect to runmaestro.ai
- `/health` - Health check
- `/$TOKEN/manifest.json`, `/$TOKEN/sw.js` - PWA files (cached after first read)
- `/$TOKEN`, `/$TOKEN/` - Dashboard SPA
- `/$TOKEN/session/:sessionId` - Session view SPA (injects config script with token, session ID, tab ID)
- `/:token` - Invalid token catch-all redirect

**API Routes** (`routes/apiRoutes.ts`):

| Method | Path | Purpose | Rate Limit |
|--------|------|---------|------------|
| GET | `/api/sessions` | List all sessions with live info | 100/min |
| GET | `/api/session/:id` | Session detail (optional `?tabId=`) | 100/min |
| POST | `/api/session/:id/send` | Send command to session | 30/min |
| GET | `/api/theme` | Current theme | 100/min |
| POST | `/api/session/:id/interrupt` | Interrupt session | 30/min |
| GET | `/api/history` | History entries (optional `?projectPath=`, `?sessionId=`) | 100/min |

All API responses include `timestamp` field. Sessions are enriched with `isLive`, `liveEnabledAt`, and live `agentSessionId`.

**WebSocket Route** (`routes/wsRoute.ts`):
- Path: `/$TOKEN/ws` (optional `?sessionId=` for session subscription)
- On connect: sends `connected`, `sessions_list`, `theme`, `custom_commands`, and all active `autorun_state` messages
- Incoming messages delegated to `WebSocketMessageHandler`

### WebSocket Message Types

Handled by `WebSocketMessageHandler` (`handlers/messageHandlers.ts`):

| Message Type | Purpose |
|--------------|---------|
| `ping` | Health check, responds with `pong` |
| `subscribe` | Subscribe to session updates |
| `send_command` | Execute AI or terminal command (validates session state) |
| `switch_mode` | Switch between AI and terminal mode |
| `select_session` | Select session in desktop (auto-subscribes client) |
| `get_sessions` | Request updated sessions list |
| `select_tab` | Select a tab within a session |
| `new_tab` | Create a new tab |
| `close_tab` | Close a tab |
| `rename_tab` | Rename a tab |
| `star_tab` | Star/unstar a tab |
| `reorder_tab` | Move a tab to a new position |
| `toggle_bookmark` | Toggle bookmark state on a session |

Command validation: checks session exists and is not busy before executing. Uses client's `inputMode` over server state to avoid sync issues.

### Broadcast Service (`services/broadcastService.ts`)

Sends messages to connected WebSocket clients:
- `broadcastToAll(message)` - sends to every connected client
- `broadcastToSession(sessionId, message)` - sends to clients subscribed to that session (or unsubscribed clients watching everything)

Broadcast message types: `session_live`, `session_offline`, `session_state_change`, `session_added`, `session_removed`, `sessions_list`, `active_session_changed`, `tabs_changed`, `theme`, `custom_commands`, `autorun_state`, `user_input`, `session_output`

### Live Session Manager (`managers/LiveSessionManager.ts`)

Tracks which sessions are visible in the web interface:
- `setSessionLive(sessionId, agentSessionId)` - marks session as live, broadcasts
- `setSessionOffline(sessionId)` - marks offline, cleans up AutoRun state, broadcasts
- Also manages AutoRun state per session for batch processing progress

### Callback Registry (`managers/CallbackRegistry.ts`)

Centralizes 17 callback types (getSessions, getSessionDetail, writeToSession, executeCommand, interruptSession, switchMode, selectSession, selectTab, newTab, closeTab, renameTab, starTab, reorderTab, toggleBookmark, getTheme, getCustomCommands, getHistory).

### Web Server Factory (`web-server-factory.ts`)

Factory function that creates and configures the WebServer with all callbacks wired up. Handles:
- Port selection (custom or random)
- Security token (persistent or ephemeral)
- Session callbacks (maps stored sessions to web-safe format, strips logs)
- Command execution (forwards to renderer via IPC for single source of truth)
- Tab operations (all forwarded to renderer via `mainWindow.webContents.send()`)

The factory pattern with `isWebContentsAvailable()` guards ensures safe forwarding even when the renderer window is closing.

### Types (`types.ts`)

Central type definitions for the entire web-server module:
- Session types: `SessionData`, `SessionDetail`, `SessionBroadcastData`
- UI types: `AITabData`, `LiveSessionInfo`, `CustomAICommand`, `AutoRunState`
- Client types: `WebClient`, `WebClientMessage`
- 17 callback type aliases for all web server operations
- Usage and response types: `SessionUsageStats`, `LastResponsePreview`
