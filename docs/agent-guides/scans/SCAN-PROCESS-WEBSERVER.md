# Dedup Scan: Process Manager, Process Listeners, Web Server

---

## 1. Process Manager Scan

### 1.1 Spawn Config Construction - Duplication with Group Chat

Multiple call sites construct `ProcessConfig` objects for `processManager.spawn()`. These share overlapping logic for SSH wrapping, env var merging, shell selection, and image handling.

**Spawn call sites found:**

```
src/main/ipc/handlers/process.ts:498          - Main IPC spawn handler (most comprehensive)
src/main/group-chat/group-chat-router.ts:555  - Group chat participant spawn
src/main/group-chat/group-chat-router.ts:945  - Group chat participant spawn (recovery)
src/main/group-chat/group-chat-router.ts:1279 - Group chat moderator spawn
src/main/group-chat/group-chat-router.ts:1479 - Group chat moderator synthesis spawn
src/main/group-chat/group-chat-agent.ts:224   - Group chat agent spawn
src/main/ipc/handlers/tabNaming.ts:250        - Tab naming batch spawn
src/main/utils/context-groomer.ts:333         - Context grooming spawn
src/main/ipc/handlers/context.ts:232          - Context handler spawn
```

**Finding: MODERATE duplication risk.**
The main IPC handler (`process.ts:498`) is the authoritative spawn site with full SSH, Windows shell, env var, and image handling. Group chat spawn sites in `group-chat-router.ts` (4 locations) build their own config objects with overlapping fields. However, group chat spawns differ in important ways (moderator vs participant session ID format, synthesis-specific prompts, recovery context). The duplication is structural rather than copy-paste - each site assembles a `ProcessConfig` appropriate to its use case.

**Recommendation:** Consider extracting a `buildSpawnConfig()` helper that handles the common fields (shell selection, env vars, context window, agent capabilities lookup) and lets callers override the session-specific fields. This would reduce the surface area for bugs when spawn behavior changes.

### 1.2 ProcessManager Methods vs IPC Handler Logic

**Finding: No significant duplication.**
ProcessManager methods are low-level process operations (spawn, write, kill, interrupt). IPC handlers in `process.ts` add session-level logic on top (SSH wrapping, agent detection, shell configuration, power management). The boundary is clean - ProcessManager owns process lifecycle, IPC handlers own session-level orchestration.

### 1.3 SSH Error Detection - Repeated Across Handlers

`matchSshErrorPattern()` from `parsers/error-patterns.ts` is called in 4 locations within process-manager:

```
src/main/process-manager/handlers/StdoutHandler.ts:204  - SSH error in stdout lines
src/main/process-manager/handlers/StderrHandler.ts:70   - SSH error in stderr
src/main/process-manager/handlers/ExitHandler.ts:159    - SSH error at exit (combined output)
src/main/process-manager/runners/SshCommandRunner.ts:136 - SSH error in command stderr
```

**Finding: Intentional redundancy, not duplication.**
Each call site checks a different output stream at a different lifecycle stage. The `errorEmitted` flag prevents double-reporting within a single session. StdoutHandler checks per-line during streaming, StderrHandler checks stderr chunks, ExitHandler checks combined output at exit for errors that only became apparent after process completion. SshCommandRunner handles a different code path (one-off commands vs agent processes).

### 1.4 Error Detection Pattern - Three Entry Points

The agent error detection pattern uses three methods on the parser interface:

```
StdoutHandler:  detectErrorFromParsed(parsed) OR detectErrorFromLine(line)
StderrHandler:  detectErrorFromLine(stderrData)
ExitHandler:    detectErrorFromExit(code, stderr, stdout)
```

**Finding: Clean separation by design.**
`detectErrorFromParsed` handles pre-parsed JSON (avoids double-parse), `detectErrorFromLine` handles raw text lines (stderr, non-JSON stdout), and `detectErrorFromExit` handles exit-code-based detection with full output context. The `errorEmitted` flag ensures only the first detected error is reported.

---

## 2. Process Listeners Scan

### 2.1 All Functions

```
index.ts:31          - setupProcessListeners (orchestrator)
forwarding-listeners.ts:13 - setupForwardingListeners (5 simple forwards)
data-listener.ts:28  - setupDataListener (output routing + web broadcast)
usage-listener.ts:17 - setupUsageListener (token stats + group chat)
session-id-listener.ts:16 - setupSessionIdListener (agent session tracking)
error-listener.ts:14 - setupErrorListener (error forwarding)
stats-listener.ts:24 - insertQueryEventWithRetry (DB insert with backoff)
stats-listener.ts:75 - setupStatsListener (query completion tracking)
exit-listener.ts:19  - setupExitListener (exit routing + group chat)
wakatime-listener.ts:25 - heartbeatForSession (helper)
wakatime-listener.ts:50 - setupWakaTimeListener (WakaTime integration)
wakatime-listener.ts:76 - flushPendingFiles (file heartbeat flush)
```

### 2.2 Parsing Logic Across Listeners

**data-listener.ts** and **exit-listener.ts** both:
- Check `sessionId.startsWith(GROUP_CHAT_PREFIX)` for fast-path optimization
- Match session IDs against `REGEX_MODERATOR_SESSION`
- Parse participant session IDs via `outputParser.parseParticipantSessionId()`
- Buffer and route group chat output

**Finding: MODERATE duplication between data-listener and exit-listener.**
Both files contain the same group-chat session ID detection logic: prefix check, moderator regex match, participant parsing. The difference is timing - data-listener buffers during streaming, exit-listener processes on completion.

**usage-listener.ts** and **session-id-listener.ts** repeat the same pattern:
- `sessionId.startsWith(GROUP_CHAT_PREFIX)` check
- `outputParser.parseParticipantSessionId()` call
- `sessionId.match(REGEX_MODERATOR_SESSION)` call

**Recommendation:** Extract a `classifyGroupChatSession(sessionId)` helper that returns `{ type: 'moderator' | 'participant' | 'regular', groupChatId?, participantName? }`. This would eliminate the repeated prefix check + regex match + parser call pattern across 4 listener files.

### 2.3 Data Listener vs Error Listener - Shared Patterns

**Finding: No real duplication.**
`error-listener.ts` is minimal (15 lines of logic) and only forwards agent errors. `data-listener.ts` handles output routing, group chat buffering, and web broadcast. They operate on different event types (`agent-error` vs `data`).

### 2.4 Group Chat Context Loading Pattern

Both `exit-listener.ts` (moderator exit and participant exit paths) load the group chat with:
```typescript
const chat = await groupChatStorage.loadGroupChat(groupChatId);
```

The moderator exit path adds retry logic (`loadChatWithRetry`). The participant exit path does a single load.

**Finding: Minor inconsistency.** Participant exit path should probably also retry on transient failures, or both should use the same strategy.

---

## 3. Web Server Scan

### 3.1 All Routes and Handlers

**Static Routes (staticRoutes.ts):**
```
GET  /                           - Redirect to runmaestro.ai
GET  /health                     - Health check
GET  /$TOKEN/manifest.json       - PWA manifest (cached)
GET  /$TOKEN/sw.js               - Service worker (cached)
GET  /$TOKEN                     - Dashboard SPA
GET  /$TOKEN/                    - Dashboard SPA (trailing slash)
GET  /$TOKEN/session/:sessionId  - Session view SPA
GET  /:token                     - Invalid token catch-all
```

**API Routes (apiRoutes.ts):**
```
GET  /$TOKEN/api/sessions              - List sessions
GET  /$TOKEN/api/session/:id           - Session detail
POST /$TOKEN/api/session/:id/send      - Send command
GET  /$TOKEN/api/theme                 - Current theme
POST /$TOKEN/api/session/:id/interrupt - Interrupt session
GET  /$TOKEN/api/history               - History entries
```

**WebSocket Route (wsRoute.ts):**
```
GET  /$TOKEN/ws                  - WebSocket endpoint
```

**WebSocket Message Handlers (messageHandlers.ts):**
```
ping, subscribe, send_command, switch_mode, select_session,
get_sessions, select_tab, new_tab, close_tab, rename_tab,
star_tab, reorder_tab, toggle_bookmark
```

### 3.2 Duplicated Type Definitions

**CONFIRMED DUPLICATION: WebClient, WebClientMessage, LiveSessionInfo**

These interfaces are defined in BOTH `types.ts` (canonical) AND `handlers/messageHandlers.ts`:

```
types.ts:195          - export interface WebClient { ... }
messageHandlers.ts:44 - export interface WebClient { ... }

types.ts:205          - export interface WebClientMessage { ... }
messageHandlers.ts:30 - export interface WebClientMessage { ... }

types.ts:58           - export interface LiveSessionInfo { ... }
messageHandlers.ts:63 - export interface LiveSessionInfo { ... }
```

The definitions are identical. `messageHandlers.ts` re-declares them instead of importing from `../types`.

**Recommendation:** Remove the duplicate interfaces from `messageHandlers.ts` and import them from `../types`. The `handlers/index.ts` barrel file should re-export from `../types` instead of from `messageHandlers.ts`.

### 3.3 Session Enrichment with Live Info - Triplicated

The pattern "map sessions to add `liveInfo.agentSessionId`, `liveEnabledAt`, `isLive`" appears in 3 locations:

```
apiRoutes.ts:101-109    - GET /api/sessions
wsRoute.ts:121-129      - WebSocket initial sessions_list
messageHandlers.ts:395-403 - get_sessions message handler
```

All three contain nearly identical code:
```typescript
const sessionsWithLiveInfo = allSessions.map((s) => {
    const liveInfo = this.callbacks.getLiveSessionInfo?.(s.id);
    return {
        ...s,
        agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
        liveEnabledAt: liveInfo?.enabledAt,
        isLive: this.callbacks.isSessionLive?.(s.id) || false,
    };
});
```

**A fourth instance** for single-session enrichment exists at `apiRoutes.ts:152-158`.

**Recommendation:** Extract an `enrichSessionsWithLiveInfo(sessions, getLiveSessionInfo, isSessionLive)` utility function. Each call site would become a one-liner.

### 3.4 Web Server Factory - Repeated isWebContentsAvailable Guards

The factory (`web-server-factory.ts`) contains 11 near-identical callback implementations that all follow the same pattern:

```typescript
server.setXxxCallback(async (sessionId: string, ...) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
        logger.warn('mainWindow is null for xxx', 'WebServer');
        return false;
    }
    if (!isWebContentsAvailable(mainWindow)) {
        logger.warn('webContents is not available for xxx', 'WebServer');
        return false;
    }
    mainWindow.webContents.send('remote:xxx', sessionId, ...);
    return true;
});
```

This exact structure (null check, availability check, log, send, return) repeats for: selectTab, closeTab, renameTab, starTab, reorderTab, toggleBookmark, selectSession, switchMode, interruptSession, and partially for executeCommand.

**Recommendation:** Extract a helper:
```typescript
function forwardToRenderer(
    getMainWindow, channel: string, ...args
): Promise<boolean> {
    const mainWindow = getMainWindow();
    if (!mainWindow || !isWebContentsAvailable(mainWindow)) return false;
    mainWindow.webContents.send(channel, ...args);
    return true;
}
```
This would reduce ~120 lines of repetitive code to ~20 lines.

### 3.5 WebSocket Message Handling vs IPC Patterns

**Finding: Intentional separation, not duplication.**
WebSocket messages from web clients are forwarded to the renderer via IPC callbacks. The WebSocket handler validates inputs and checks session state before forwarding. IPC handlers in the main process handle the same operations but from the Electron renderer. They share the same underlying callbacks (wired up in the factory) but have different input validation and error handling appropriate to their transport.

### 3.6 Broadcast Methods - Thin Delegation

`WebServer` has 13 broadcast methods that are pure one-line delegations to `BroadcastService`:

```typescript
broadcastToWebClients(message) { this.broadcastService.broadcastToAll(message); }
broadcastToSessionClients(id, msg) { this.broadcastService.broadcastToSession(id, msg); }
// ... 11 more
```

Similarly, 17 callback setter methods delegate to `CallbackRegistry`.

**Finding: Acceptable facade pattern.** The delegation keeps the `WebServer` API stable while internals are extracted. No action needed unless the class exceeds 800 lines (currently ~606).

---

## Summary of Actionable Findings

| Priority | Location | Issue | Lines Affected |
|----------|----------|-------|----------------|
| HIGH | `messageHandlers.ts` | Duplicate interfaces (WebClient, WebClientMessage, LiveSessionInfo) - identical to `types.ts` | ~30 lines |
| HIGH | `apiRoutes.ts`, `wsRoute.ts`, `messageHandlers.ts` | Triplicated session enrichment with live info | ~30 lines (3x10) |
| MEDIUM | `web-server-factory.ts` | 11 near-identical `isWebContentsAvailable` guard patterns | ~120 lines |
| MEDIUM | Process listeners (4 files) | Repeated group-chat session classification (prefix + regex + parser) | ~40 lines (4x10) |
| LOW | `group-chat-router.ts` (4 sites) | Spawn config construction overlap with IPC handler | Structural, not copy-paste |
| LOW | `exit-listener.ts` | Inconsistent retry strategy (moderator retries, participant doesn't) | ~10 lines |
