<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Main Process Lifecycle

This guide documents the Electron main process lifecycle in Maestro: startup sequence, window management, store initialization, auto-updater, power management, WakaTime integration, history manager, IPC handler registration, and shutdown sequence.

## Startup Sequence

The entry point is `src/main/index.ts`. Startup proceeds in distinct phases:

### Phase 1: Pre-Ready (Before `app.whenReady()`)

These operations run at module load time, before Electron's `app` is ready.

#### 1. Data Directory Configuration

Must happen before any `Store` initialization:

```typescript
// Production data path captured first
const productionDataPath = app.getPath('userData');

// Demo mode: use separate data directory
if (DEMO_MODE) {
	app.setPath('userData', DEMO_DATA_PATH);
}

// Development mode: use isolated directory (unless USE_PROD_DATA=1)
if (isDevelopment && !DEMO_MODE && !process.env.USE_PROD_DATA) {
	app.setPath('userData', path.join(app.getPath('userData'), '..', 'maestro-dev'));
}
```

#### 2. Store Initialization

```typescript
const { syncPath, bootstrapStore } = initializeStores({ productionDataPath });
```

The `initializeStores()` function from `src/main/stores/instances.ts` creates all `electron-store` instances. See the Settings Store section below for details.

#### 3. Early Settings

Read before Sentry init for crash reporting and GPU configuration:

```typescript
const { crashReportingEnabled, disableGpuAcceleration, useNativeTitleBar, autoHideMenuBar } =
	getEarlySettings(syncPath);
```

#### 4. GPU Acceleration

Disabled before `app.ready` if user opted out or running in WSL:

```typescript
if (disableGpuAcceleration) {
	app.disableHardwareAcceleration();
}
```

#### 5. Installation ID

Generated once on first run (UUID), stored in settings, used for Sentry error correlation:

```typescript
let installationId = store.get('installationId');
if (!installationId) {
	installationId = crypto.randomUUID();
	store.set('installationId', installationId);
}
```

#### 6. WakaTime Manager Initialization

```typescript
const wakatimeManager = new WakaTimeManager(store);
if (store.get('wakatimeEnabled', false)) {
	wakatimeManager.ensureCliInstalled();
}
```

#### 7. Sentry Initialization

Dynamic import to avoid module-load-time access to `electron.app`. Only enabled in production with crash reporting enabled:

```typescript
if (crashReportingEnabled && !isDevelopment) {
	import('@sentry/electron/main').then(({ init, setTag, IPCMode }) => {
		init({ dsn: '...', ipcMode: IPCMode.Classic, ... });
		setTag('installationId', installationId);
		setTag('channel', version.includes('-RC') ? 'rc' : 'stable');
	});
}
```

Also starts memory monitoring for crash diagnostics (breadcrumbs every 60s, warns above 500MB heap).

#### 8. Convenience Store References

```typescript
const sessionsStore = getSessionsStore();
const groupsStore = getGroupsStore();
const agentConfigsStore = getAgentConfigsStore();
const windowStateStore = getWindowStateStore();
// ... etc
```

#### 9. Factory Creation

- `safeSend` - Safe IPC send wrapper with window availability check
- `cliWatcher` - CLI activity file watcher
- `windowManager` - Window creation and configuration
- `createWebServer` - Web server factory

#### 10. Global Error Handlers

```typescript
setupGlobalErrorHandlers();
```

Sets up `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log errors without crashing the process.

#### 11. Quit Handler Setup

```typescript
const quitHandler = createQuitHandler({ ... });
quitHandler.setup();
```

Intercepts `before-quit` to check for busy agents and run cleanup.

### Phase 2: App Ready (`app.whenReady()`)

#### 1. Logger Configuration

```typescript
const logLevel = store.get('logLevel', 'info');
logger.setLogLevel(logLevel);
const maxLogBuffer = store.get('maxLogBuffer', 1000);
logger.setMaxLogBuffer(maxLogBuffer);
```

#### 2. WSL Check

```typescript
checkWslEnvironment(process.cwd());
```

#### 3. Core Services Initialization

```typescript
processManager = new ProcessManager();
agentDetector = new AgentDetector();
```

Custom agent paths are loaded from the agent configs store and applied to the detector.

#### 4. History Manager Initialization

```typescript
const historyManager = getHistoryManager();
await historyManager.initialize();
historyManager.startWatching((sessionId) => { ... });
```

Creates the `history/` directory, migrates from legacy format if needed, and starts watching for external changes (CLI playbook runs).

#### 5. Stats Database Initialization

```typescript
initializeStatsDB();
```

Creates or opens `stats.db`, runs migrations, creates daily backup, schedules weekly VACUUM.

#### 6. IPC Handler Registration

```typescript
setupIpcHandlers();
```

Registers all IPC handlers (see section below).

#### 7. Process Event Listeners

```typescript
setupProcessListeners();
```

Wires up process output streaming, group chat routing, power management, usage tracking, and WakaTime heartbeats.

#### 8. Application Menu

- **macOS**: Custom menu to prevent native tab-switching shortcuts from intercepting keyboard events
- **Windows/Linux**: Menu hidden entirely (Maestro uses its own UI)

#### 9. Window Creation

```typescript
createWindow();
```

#### 10. CLI Activity Watcher

```typescript
cliWatcher.start();
```

Watches the `cli-activity.json` file for CLI playbook activity.

#### 11. Power Monitor

Listens for system resume after sleep/suspend and notifies the renderer:

```typescript
powerMonitor.on('resume', () => {
	mainWindow.webContents.send('app:systemResume');
});
```

## Window Management

Handled by `src/main/app-lifecycle/window-manager.ts`.

### Window Creation

The `createWindowManager()` factory returns a `WindowManager` with a `createWindow()` method that:

1. Restores saved window state (position, size, maximized/fullscreen) from the window state store
2. Creates a `BrowserWindow` with:
   - Minimum size: 1000x600
   - Background color: `#0b0b0d`
   - Title bar: hidden inset (macOS) or custom (unless native title bar enabled)
   - Auto-hide menu bar (if configured)
   - Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
3. Restores maximized/fullscreen state
4. Saves window state on close (position, size, maximized, fullscreen)
5. Loads content:
   - **Development**: Dev server URL (`http://localhost:{port}`), installs React DevTools
   - **Production**: Loads renderer HTML file from disk

### Security Hardening

- **Window open handler**: All popup/new-window requests are denied
- **Navigation restriction**: Only allows dev server (development) or app file:// URLs (production)
- **Permission handler**: Denies all browser permissions except clipboard access

### Crash Detection

The window manager sets up multiple crash detection handlers:

| Event                       | Action                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `render-process-gone`       | Logs, reports to Sentry, auto-reloads (unless intentionally killed)                |
| `unresponsive`              | Warns, reports to Sentry with memory usage                                         |
| `responsive`                | Logs recovery                                                                      |
| `crashed`                   | Logs, reports to Sentry                                                            |
| `did-fail-load`             | Logs, reports to Sentry (ignores aborted loads)                                    |
| `preload-error`             | Logs, reports to Sentry as fatal                                                   |
| `console-message` (level 3) | Forwards renderer errors to main process logger; reports critical errors to Sentry |

### Auto-Updater Initialization

- **Production**: `initAutoUpdater(mainWindow)` is called after window creation
- **Development**: Stub IPC handlers are registered that return helpful error messages

## Settings Store

### Store Types

All store types are defined in `src/main/stores/types.ts`:

#### `BootstrapSettings`

Local-only store that determines the sync path:

```typescript
interface BootstrapSettings {
	customSyncPath?: string;
	iCloudSyncEnabled?: boolean; // Legacy
}
```

#### `MaestroSettings`

Main settings store with many configuration options:

```typescript
interface MaestroSettings {
	activeThemeId: string;
	llmProvider: string;
	modelSlug: string;
	apiKey: string;
	shortcuts: Record<string, any>;
	fontSize: number;
	fontFamily: string;
	customFonts: string[];
	logLevel: 'debug' | 'info' | 'warn' | 'error';
	defaultShell: string;
	webAuthEnabled: boolean;
	webAuthToken: string | null;
	persistentWebLink: boolean;
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	sshRemotes: SshRemoteConfig[];
	defaultSshRemoteId: string | null;
	sshRemoteIgnorePatterns: string[];
	sshRemoteHonorGitignore: boolean;
	installationId: string | null;
	wakatimeEnabled: boolean;
	wakatimeApiKey: string;
	wakatimeDetailedTracking: boolean;
	totalActiveTimeMs: number;
	[key: string]: any; // Dynamic settings
}
```

#### Other Stores

| Store                      | Type                                                 | Purpose                                        |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| `SessionsData`             | `{ sessions: StoredSession[] }`                      | Active agent sessions                          |
| `GroupsData`               | `{ groups: Group[] }`                                | Session groups                                 |
| `AgentConfigsData`         | `{ configs: Record<string, AgentConfig> }`           | Per-agent custom paths, args, env vars, models |
| `WindowState`              | `{ x, y, width, height, isMaximized, isFullScreen }` | Window geometry persistence                    |
| `ClaudeSessionOriginsData` | Session origin tracking for Claude Code              | Session names, stars, custom origins           |
| `AgentSessionOriginsData`  | Session origin tracking for all agents               | Generic agent session origins                  |

### Store Module Organization

```text
src/main/stores/
  index.ts       # Public API barrel
  types.ts       # Type definitions
  defaults.ts    # Default values for all stores
  instances.ts   # Store instance creation and initialization
  getters.ts     # Public getter functions
  utils.ts       # Utility functions (getCustomSyncPath, getEarlySettings)
```

`initializeStores()` must be called before any store getter. The `app.setPath('userData', ...)` calls must happen before initialization.

## Auto-Updater

Defined in `src/main/auto-updater.ts`.

Uses `electron-updater` with lazy initialization (deferred `require()`) to avoid module-load-time access to `electron.app`.

### Configuration

```typescript
autoUpdater.autoDownload = false; // User must initiate download
autoUpdater.autoInstallOnAppQuit = true; // Install on next quit
autoUpdater.allowPrerelease = false; // Stable channel only
```

### Update Flow

1. `initAutoUpdater(window)` is called from window manager (production only)
2. Event handlers are registered for `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`
3. Status changes are sent to renderer via `updates:status` IPC event
4. Renderer triggers actions via the `window.maestro.updates` API (see `src/main/preload/system.ts:createUpdatesApi`). The exposed IPC channels are:
   - `updates:check` - Trigger a manual GitHub-API version check (registered in `src/main/ipc/handlers/system.ts`)
   - `updates:download` - Start downloading the available update
   - `updates:install` - Install and restart
   - `updates:getStatus` - Get current `UpdateStatus`
   - `updates:setAllowPrerelease` - Toggle beta channel opt-in
   - `updates:checkAutoUpdater` - Invoke `electron-updater` directly (registered separately in `src/main/auto-updater.ts`, distinct from the manual GitHub-API path)

### Status States

```typescript
type UpdateStatus = {
	status:
		| 'idle'
		| 'checking'
		| 'available'
		| 'not-available'
		| 'downloading'
		| 'downloaded'
		| 'error';
	info?: UpdateInfo;
	progress?: ProgressInfo;
	error?: string;
};
```

## Power Management

Defined in `src/main/power-manager.ts`.

Uses Electron's `powerSaveBlocker` API to prevent system sleep during active AI work.

### Architecture

The `PowerManager` class uses reference counting:

- Each busy agent session adds a reason (e.g., `session:{sessionId}`)
- Each Auto Run adds a reason (e.g., `autorun:{identifier}`)
- Group chats add a reason (e.g., `groupchat:{groupChatId}`)
- Sleep is blocked only when the feature is enabled AND there are active reasons
- When the last reason is removed, the blocker is released

### Key Methods

| Method                      | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `setEnabled(enabled)`       | Enable/disable the feature (user preference)       |
| `addBlockReason(reason)`    | Add a reason for blocking sleep                    |
| `removeBlockReason(reason)` | Remove a reason                                    |
| `getStatus()`               | Returns `{ enabled, blocking, reasons, platform }` |

### Platform Support

| Platform | Implementation                                          |
| -------- | ------------------------------------------------------- |
| macOS    | `IOPMAssertionCreateWithName` (like `caffeinate`)       |
| Windows  | `SetThreadExecutionState`                               |
| Linux    | Varies by DE (D-Bus or X11). Works on GNOME, KDE, XFCE. |

The `powerManager` singleton is exported and used across the codebase. It is wired into process listeners to automatically add/remove block reasons when agent sessions become busy/idle.

## WakaTime Integration

Defined in `src/main/wakatime-manager.ts`.

### Detection and Installation

1. Checks for `wakatime-cli` on the user's PATH
2. If not found, automatically downloads from GitHub releases to `~/.wakatime/`
3. Checks for CLI updates once per day

### Heartbeat Mechanism

- Triggered by `data`, `thinking-chunk`, and `query-complete` process events (see `wakatime-listener.ts`)
- Debounced per session in `WakaTimeManager`: maximum 1 heartbeat per 2 minutes (`HEARTBEAT_DEBOUNCE_MS`, matches WakaTime's deduplication window)
- Sends heartbeats with:
  - Project name (derived from session working directory)
  - Language (mapped from file extension via `EXTENSION_LANGUAGE_MAP`)
  - Editor: `Maestro`
  - Plugin: `maestro-wakatime`

### Settings

| Setting                    | Default | Purpose                             |
| -------------------------- | ------- | ----------------------------------- |
| `wakatimeEnabled`          | `false` | Enable/disable WakaTime integration |
| `wakatimeApiKey`           | `""`    | WakaTime API key                    |
| `wakatimeDetailedTracking` | `false` | Track individual file activity      |

### IPC Handlers

Registered in `src/main/ipc/handlers/wakatime.ts`:

| Handler                   | Purpose                            |
| ------------------------- | ---------------------------------- |
| `wakatime:checkCli`       | Check if wakatime-cli is available |
| `wakatime:validateApiKey` | Validate a WakaTime API key        |

### Process Listener

`setupWakaTimeListener()` in `src/main/process-listeners/wakatime-listener.ts` subscribes to the process manager's `data`, `thinking-chunk`, `tool-execution`, `usage`, `query-complete`, and `exit` events, sending heartbeats and flushing file-level activity through the WakaTime manager.

## History Manager

Defined in `src/main/history-manager.ts`.

### Per-Session Storage

The history manager uses per-session JSON files instead of a single global file:

```text
{userData}/history/
  {sessionId}.json    # Per-session history file
```

Each file contains a `HistoryFileData` object with version info and an array of `HistoryEntry` records.

### Benefits Over Legacy Format

- Higher limits: 5,000 entries per session (up from 1,000 global)
- Context passing: History files can be passed directly to AI agents via `{{AGENT_HISTORY_PATH}}`
- Better isolation: Sessions don't pollute each other's history
- Simpler queries: No filtering needed when reading a session's history

### Migration

On first run after upgrade, the manager:

1. Checks for `history-migrated.json` marker
2. If not migrated, reads legacy `maestro-history.json`
3. Splits entries by session ID into per-session files
4. Writes migration marker

### File Watching

`startWatching()` uses `fs.watch()` on the history directory to detect external changes (from CLI playbook runs). When a file changes, it notifies the renderer via `history:externalChange` IPC event.

### Singleton

```typescript
const historyManager = getHistoryManager();
```

## IPC Handler Registration

All IPC handlers are registered in `setupIpcHandlers()` within `src/main/index.ts`. Each handler module is a self-contained file in `src/main/ipc/handlers/`:

| Registration Call                 | Handler Module      | Dependencies                                                         |
| --------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `registerWebHandlers()`           | `web.ts`            | Web server factory, settings store                                   |
| `registerGitHandlers()`           | `git.ts`            | Settings store                                                       |
| `registerAutorunHandlers()`       | `autorun.ts`        | Main window, app, settings store                                     |
| `registerPlaybooksHandlers()`     | `playbooks.ts`      | Main window, app                                                     |
| `registerHistoryHandlers()`       | `history.ts`        | (uses HistoryManager singleton)                                      |
| `registerDirectorNotesHandlers()` | `director-notes.ts` | Process manager, agent detector, agent configs                       |
| `registerCueHandlers()`           | `cue.ts`            | Cue engine                                                           |
| `registerAgentsHandlers()`        | `agents.ts`         | Agent detector, agent configs, settings                              |
| `registerProcessHandlers()`       | `process.ts`        | Process manager, agent detector, agent configs, settings, sessions   |
| `registerPersistenceHandlers()`   | `persistence.ts`    | Settings, sessions, groups stores, web server                        |
| `registerSystemHandlers()`        | `system.ts`         | Main window, app, settings, tunnel, web server, bootstrap            |
| `registerClaudeHandlers()`        | `claude.ts`         | Claude session origins store, main window                            |
| `registerAgentSessionsHandlers()` | `agentSessions.ts`  | Main window, agent session origins                                   |
| `registerGroupChatHandlers()`     | `groupChat.ts`      | Main window, process manager, agent detector, env vars, agent config |
| `registerDebugHandlers()`         | `debug.ts`          | Main window, agent detector, process manager, web server, stores     |
| `registerSpeckitHandlers()`       | `speckit.ts`        | (none)                                                               |
| `registerOpenSpecHandlers()`      | `openspec.ts`       | (none)                                                               |
| `registerBmadHandlers()`          | `bmad.ts`           | (none)                                                               |
| `registerContextHandlers()`       | `context.ts`        | Main window, process manager, agent detector, agent configs          |
| `registerMarketplaceHandlers()`   | `marketplace.ts`    | App, settings store                                                  |
| `registerStatsHandlers()`         | `stats.ts`          | Main window, settings store                                          |
| `registerDocumentGraphHandlers()` | `documentGraph.ts`  | Main window, app                                                     |
| `registerSshRemoteHandlers()`     | `ssh-remote.ts`     | Settings store                                                       |
| `registerFilesystemHandlers()`    | `filesystem.ts`     | (none)                                                               |
| `registerAgentErrorHandlers()`    | `agent-error.ts`    | (none)                                                               |
| `registerNotificationsHandlers()` | `notifications.ts`  | Main window                                                          |
| `registerAttachmentsHandlers()`   | `attachments.ts`    | App                                                                  |
| `registerLeaderboardHandlers()`   | `leaderboard.ts`    | App, settings store                                                  |
| `registerSymphonyHandlers()`      | `symphony.ts`       | App, main window, sessions store                                     |
| `registerTabNamingHandlers()`     | `tabNaming.ts`      | Process manager, agent detector, agent configs, settings             |
| `registerWakatimeHandlers()`      | `wakatime.ts`       | WakaTime manager                                                     |
| `registerFeedbackHandlers()`      | `feedback.ts`       | Process manager, agent detector, web server, settings, stores        |

After handler registration, additional callbacks are set for the group chat router:

- `setGetSessionsCallback()` - Session lookup for auto-add `@mentions`
- `setGetCustomEnvVarsCallback()` - Per-agent env vars
- `setGetAgentConfigCallback()` - Per-agent config values
- `setSshStore()` - SSH store adapter for remote execution
- `setGetCustomShellPathCallback()` - Windows shell preference

Logger event forwarding is also set up to stream logs to the renderer.

## Process Listeners

Set up in `setupProcessListeners()`, delegating to `src/main/process-listeners/index.ts`:

The process manager emits events for:

- **Process output streaming**: Routes `process:data` events to the renderer and web server
- **Process exit**: Handles group chat participant/moderator completion
- **Group chat routing**: Moderator and agent response handling
- **Power management**: Adds/removes sleep block reasons for busy sessions
- **Usage tracking**: Context token calculation, stats recording
- **WakaTime**: Heartbeat on `query-complete`

## Shutdown Sequence

Managed by `src/main/app-lifecycle/quit-handler.ts`.

### Quit Flow

1. User attempts to quit (Cmd+Q, menu, window close on Windows/Linux)
2. `before-quit` event fires
3. If not yet confirmed, event is prevented
4. Renderer is asked to check for busy agents via `app:requestQuitConfirmation`
5. User confirms or cancels via `app:quitConfirmed` / `app:quitCancelled` IPC
6. On confirm, cleanup runs

### Cleanup Operations

The `performCleanup()` function runs synchronously from `before-quit` (async operations are fire-and-forget):

1. **Stop history manager watcher** - `historyManager.stopWatching()`
2. **Stop CLI activity watcher** - `cliWatcher.stop()`
3. **Clean up grooming sessions** - Kill any active context merge/transfer operations
4. **Kill all processes** - `processManager.killAll()`
5. **Stop tunnel** - `tunnelManager.stop()` (fire and forget)
6. **Stop web server** - `webServer.stop()` (fire and forget)
7. **Close stats database** - `closeStatsDB()` (synchronous)

### Platform-Specific Quit Behavior

- **macOS**: `window-all-closed` does not quit the app (standard macOS behavior). App stays in dock.
- **Windows/Linux**: `window-all-closed` triggers `app.quit()`
- **Activate**: On macOS, clicking the dock icon with no windows creates a new window

## Key Source Files

| File                                         | Purpose                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `src/main/index.ts`                          | Entry point, startup sequence, IPC wiring                  |
| `src/main/app-lifecycle/index.ts`            | Lifecycle module barrel                                    |
| `src/main/app-lifecycle/window-manager.ts`   | BrowserWindow creation, crash detection, auto-updater init |
| `src/main/app-lifecycle/quit-handler.ts`     | Quit confirmation flow and cleanup                         |
| `src/main/app-lifecycle/error-handlers.ts`   | Global uncaught exception handlers                         |
| `src/main/app-lifecycle/cli-watcher.ts`      | CLI activity file watcher                                  |
| `src/main/app-lifecycle/settings-watcher.ts` | External settings-file change detection                    |
| `src/main/stores/index.ts`                   | Store module barrel                                        |
| `src/main/stores/types.ts`                   | Store type definitions                                     |
| `src/main/stores/instances.ts`               | Store initialization                                       |
| `src/main/stores/getters.ts`                 | Store getter functions                                     |
| `src/main/stores/defaults.ts`                | Store default values                                       |
| `src/main/stores/utils.ts`                   | Store utilities (early settings, custom sync path)         |
| `src/main/auto-updater.ts`                   | electron-updater integration                               |
| `src/main/power-manager.ts`                  | System sleep prevention                                    |
| `src/main/wakatime-manager.ts`               | WakaTime heartbeat integration                             |
| `src/main/history-manager.ts`                | Per-session history storage and migration                  |
| `src/main/process-manager/`                  | Process spawning (PTY + child_process)                     |
| `src/main/process-listeners/`                | Process event routing                                      |
| `src/main/ipc/handlers/`                     | All IPC handler modules                                    |
| `src/main/utils/sentry.ts`                   | Sentry utilities and memory monitoring                     |
| `src/main/utils/logger.ts`                   | Structured logging                                         |
