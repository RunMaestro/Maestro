<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# IPC Patterns Reference

Complete reference for Maestro's IPC (Inter-Process Communication) architecture: namespaces, handler registration, preload bridge, error handling conventions, and SSH-aware patterns.

---

## Architecture Overview

```text
Renderer (React)                    Main (Electron)
  window.maestro.settings.get()  -->  ipcMain.handle('settings:get', ...)
  window.maestro.process.spawn() -->  ipcMain.handle('process:spawn', ...)
  window.maestro.git.status()    -->  ipcMain.handle('git:status', ...)
        ^                                      |
        |                                      v
  ipcRenderer.on('output', ...)  <--  safeSend('output', data)
```

Three layers:

1. **IPC Handlers** (`src/main/ipc/handlers/`) - Main process handlers registered via `ipcMain.handle()`
2. **Preload Bridge** (`src/main/preload/`) - Renderer-safe API exposed via `contextBridge.exposeInMainWorld()`
3. **Renderer Access** - Components call `window.maestro.<namespace>.<method>()`

---

## All IPC Namespaces

These namespaces are exposed on `window.maestro` via the preload bridge:

| Namespace       | Preload Factory            | Handler File        | Purpose                                                 |
| --------------- | -------------------------- | ------------------- | ------------------------------------------------------- |
| `settings`      | `createSettingsApi()`      | `persistence.ts`    | App settings CRUD                                       |
| `sessions`      | `createSessionsApi()`      | `persistence.ts`    | Session persistence (save/load)                         |
| `groups`        | `createGroupsApi()`        | `persistence.ts`    | Group persistence                                       |
| `process`       | `createProcessApi()`       | `process.ts`        | Agent process lifecycle (spawn, kill, write, interrupt) |
| `agentError`    | `createAgentErrorApi()`    | `agent-error.ts`    | Agent error state management                            |
| `context`       | `createContextApi()`       | `context.ts`        | Context merging and grooming                            |
| `web`           | `createWebApi()`           | `web.ts`            | Web interface state sync                                |
| `webserver`     | `createWebserverApi()`     | `web.ts`            | Web server lifecycle                                    |
| `live`          | `createLiveApi()`          | `web.ts`            | Live session sharing                                    |
| `git`           | `createGitApi()`           | `git.ts`            | Git operations (status, diff, branch, worktree)         |
| `fs`            | `createFsApi()`            | `filesystem.ts`     | File system operations (read, write, list, stat)        |
| `agents`        | `createAgentsApi()`        | `agents.ts`         | Agent detection, config, capabilities                   |
| `dialog`        | `createDialogApi()`        | `system.ts`         | Native file/folder dialogs                              |
| `fonts`         | `createFontsApi()`         | `system.ts`         | System font enumeration                                 |
| `shells`        | `createShellsApi()`        | `system.ts`         | Available shell detection                               |
| `shell`         | `createShellApi()`         | `system.ts`         | OS shell operations (openExternal, revealInExplorer)    |
| `tunnel`        | `createTunnelApi()`        | `system.ts`         | Cloudflare tunnel management                            |
| `sshRemote`     | `createSshRemoteApi()`     | `ssh-remote.ts`     | SSH remote configuration and testing                    |
| `sync`          | `createSyncApi()`          | `system.ts`         | State sync between desktop and web                      |
| `devtools`      | `createDevtoolsApi()`      | `system.ts`         | DevTools toggle                                         |
| `power`         | `createPowerApi()`         | `system.ts`         | Sleep prevention management                             |
| `updates`       | `createUpdatesApi()`       | `system.ts`         | App update checking                                     |
| `logger`        | `createLoggerApi()`        | `system.ts`         | Log forwarding (renderer -> main)                       |
| `claude`        | `createClaudeApi()`        | `claude.ts`         | Claude Code session storage (DEPRECATED)                |
| `agentSessions` | `createAgentSessionsApi()` | `agentSessions.ts`  | Multi-agent session storage (preferred)                 |
| `tempfile`      | `createTempfileApi()`      | `persistence.ts`    | Temp file creation                                      |
| `history`       | `createHistoryApi()`       | `history.ts`        | History entry CRUD                                      |
| `cli`           | `createCliApi()`           | `persistence.ts`    | CLI activity tracking                                   |
| `speckit`       | `createSpeckitApi()`       | `speckit.ts`        | Spec-Kit command management                             |
| `openspec`      | `createOpenspecApi()`      | `openspec.ts`       | OpenSpec command management                             |
| `notification`  | `createNotificationApi()`  | `notifications.ts`  | OS notifications and TTS                                |
| `attachments`   | `createAttachmentsApi()`   | `attachments.ts`    | Image attachment management                             |
| `autorun`       | `createAutorunApi()`       | `autorun.ts`        | Auto Run document management                            |
| `playbooks`     | `createPlaybooksApi()`     | `playbooks.ts`      | Playbook CRUD and import/export                         |
| `marketplace`   | `createMarketplaceApi()`   | `marketplace.ts`    | Playbook marketplace                                    |
| `debug`         | `createDebugApi()`         | `debug.ts`          | Debug package generation                                |
| `documentGraph` | `createDocumentGraphApi()` | `documentGraph.ts`  | Document graph file watching                            |
| `groupChat`     | `createGroupChatApi()`     | `groupChat.ts`      | Group chat orchestration                                |
| `app`           | `createAppApi()`           | `system.ts`         | App lifecycle (quit, version, paths)                    |
| `platform`      | Direct value               | N/A                 | `process.platform` string (synchronous)                 |
| `stats`         | `createStatsApi()`         | `stats.ts`          | Usage statistics DB                                     |
| `leaderboard`   | `createLeaderboardApi()`   | `leaderboard.ts`    | Leaderboard submission                                  |
| `symphony`      | `createSymphonyApi()`      | `symphony.ts`       | Open-source contribution system                         |
| `tabNaming`     | `createTabNamingApi()`     | `tabNaming.ts`      | Automatic tab name generation                           |
| `directorNotes` | `createDirectorNotesApi()` | `director-notes.ts` | Unified history + synopsis                              |
| `wakatime`      | `createWakatimeApi()`      | `wakatime.ts`       | WakaTime integration                                    |
| `cue`           | `createCueApi()`           | `cue.ts`            | Maestro Cue event-driven automation                     |

---

## How to Add a New IPC Handler

### Step 1: Create the handler file

Create `src/main/ipc/handlers/myFeature.ts`:

```typescript
import { ipcMain } from 'electron';
import {
	createIpcHandler,
	createIpcDataHandler,
	withIpcErrorLogging,
} from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[MyFeature]';

export interface MyFeatureHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
}

export function registerMyFeatureHandlers(deps: MyFeatureHandlerDependencies): void {
	// Pattern 1: Custom response shape { success, ...data }
	ipcMain.handle(
		'myFeature:doSomething',
		createIpcHandler({ context: LOG_CONTEXT, operation: 'doSomething' }, async (arg1: string) => {
			const result = await processData(arg1);
			return { items: result }; // Returned as { success: true, items: [...] }
		})
	);

	// Pattern 2: Standard { success, data } response
	ipcMain.handle(
		'myFeature:getData',
		createIpcDataHandler({ context: LOG_CONTEXT, operation: 'getData' }, async (id: string) => {
			return await fetchData(id); // Returned as { success: true, data: ... }
		})
	);

	// Pattern 3: Transparent error logging (re-throws)
	ipcMain.handle(
		'myFeature:update',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'update' },
			async (id: string, value: string) => {
				return await updateData(id, value); // Return value passed through unchanged
			}
		)
	);
}
```

### Step 2: Register in the handler index

Edit `src/main/ipc/handlers/index.ts`:

```typescript
import { registerMyFeatureHandlers, MyFeatureHandlerDependencies } from './myFeature';

// Add to registerAllHandlers():
registerMyFeatureHandlers({
	getMainWindow: deps.getMainWindow,
});
```

### Step 3: Create the preload bridge

Create `src/main/preload/myFeature.ts`:

```typescript
import { ipcRenderer } from 'electron';

export interface MyFeatureApi {
	doSomething: (arg1: string) => Promise<{ success: boolean; items?: any[]; error?: string }>;
	getData: (id: string) => Promise<{ success: boolean; data?: any; error?: string }>;
	update: (id: string, value: string) => Promise<any>;
}

export function createMyFeatureApi(): MyFeatureApi {
	return {
		doSomething: (arg1) => ipcRenderer.invoke('myFeature:doSomething', arg1),
		getData: (id) => ipcRenderer.invoke('myFeature:getData', id),
		update: (id, value) => ipcRenderer.invoke('myFeature:update', id, value),
	};
}
```

### Step 4: Expose in preload index

Edit `src/main/preload/index.ts`:

```typescript
import { createMyFeatureApi } from './myFeature';

// In the contextBridge.exposeInMainWorld call:
contextBridge.exposeInMainWorld('maestro', {
	// ...existing namespaces...
	myFeature: createMyFeatureApi(),
});
```

### Step 5: Add TypeScript types

Add to the `Window` interface so TypeScript knows about `window.maestro.myFeature`:

- Export the API type from preload index
- Add to the renderer's type declarations

---

## Error Handling Conventions

### Standard Response Formats

**Pattern 1 - Custom shape (`createIpcHandler` / `createHandler`):**

```typescript
// Success: { success: true, items: [...], tree: [...] }
// Error:   { success: false, error: "Error message" }
```

**Pattern 2 - Standard data (`createIpcDataHandler` / `createDataHandler`):**

```typescript
// Success: { success: true, data: <any> }
// Error:   { success: false, error: "Error message" }
```

**Pattern 3 - Transparent (`withIpcErrorLogging`):**

```typescript
// Success: returns handler's return value unchanged
// Error:   logs error, re-throws (caller must handle)
```

### Error Serialization

The `ipcHandler.ts` module includes `serializeError()` which extracts useful properties from Error objects (which don't serialize well with JSON.stringify):

```typescript
// Error objects produce {} with JSON.stringify
// serializeError extracts: name, message, stack, plus any custom properties
```

### Dependency Validation

```typescript
// Common pattern: validate ProcessManager before use
const processManager = requireProcessManager(getProcessManager);
// Throws "Process manager not initialized" if null

// Generic version for any nullable dependency
const detector = requireDependency(getAgentDetector, 'Agent detector');
```

---

## Safe IPC Messaging (Main -> Renderer)

Use `safeSend` for main-to-renderer messages to handle disposed renderer windows:

```typescript
import { createSafeSend } from '../utils/safe-send';

const safeSend = createSafeSend(getMainWindow);

// Safe: handles GPU crashes, window closing, app shutdown
safeSend('output', sessionId, data);

// Unsafe: can throw "Render frame was disposed"
mainWindow.webContents.send('output', sessionId, data); // DON'T DO THIS
```

The `isWebContentsAvailable(win)` type guard provides inline checks:

```typescript
if (isWebContentsAvailable(mainWindow)) {
	mainWindow.webContents.send('channel', data);
}
```

---

## SSH-Aware Patterns

When implementing features that spawn agent processes, SSH remote execution must be supported.

### Check and Wrap Pattern

```typescript
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

// In your handler:
const sshStore = createSshRemoteStoreAdapter(settingsStore);

let spawnConfig = {
	command: agentConfig.path || agentConfig.command,
	args: agentConfig.args,
	cwd: session.cwd,
	prompt: userMessage,
	agentBinaryName: agentConfig.binaryName,
	customEnvVars: session.customEnvVars,
};

// Wrap with SSH if the session is configured for remote execution
if (session.sshRemoteConfig?.enabled) {
	const wrapped = await wrapSpawnWithSsh(spawnConfig, session.sshRemoteConfig, sshStore);
	// Use wrapped.command, wrapped.args, wrapped.cwd
	// wrapped.sshRemoteUsed contains the SshRemoteConfig or null
}
```

### Key Rules

1. **Always use `agentBinaryName`** for remote commands (not local paths like `/opt/homebrew/bin/codex`)
2. **Pass custom env vars** through the SSH command (they're embedded in the remote shell command)
3. **Handle large prompts**: prompts >4000 chars use `--input-format stream-json` via stdin instead of command-line args
4. **CWD becomes local home**: the remote CWD is embedded in the SSH command; local process uses `os.homedir()`

---

## Handler Registration Architecture

All handlers are registered in `registerAllHandlers()` in `src/main/ipc/handlers/index.ts`. Dependencies are injected via the `HandlerDependencies` interface:

```typescript
interface HandlerDependencies {
	mainWindow: BrowserWindow | null;
	getMainWindow: () => BrowserWindow | null;
	app: App;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	getProcessManager: () => ProcessManager | null;
	settingsStore: Store<MaestroSettings>;
	sessionsStore: Store<SessionsData>;
	groupsStore: Store<GroupsData>;
	getWebServer: () => WebServer | null;
	tunnelManager: TunnelManagerType;
	claudeSessionOriginsStore: Store<ClaudeSessionOriginsData>;
}
```

Each handler module exports a `register*Handlers(deps)` function and a `*HandlerDependencies` interface specifying which subset of dependencies it needs.

**Note:** `registerWebHandlers` is NOT called from `registerAllHandlers()` because it requires module-level webServer state management. It's registered separately in `src/main/index.ts`.

---

## Bidirectional Communication Patterns

### Renderer -> Main (Request/Response)

```typescript
// Renderer
const result = await window.maestro.git.status(cwd, sshRemoteId);

// Main (ipcMain.handle returns a value)
ipcMain.handle('git:status', async (_event, cwd, sshRemoteId) => {
	return await getGitStatus(cwd, sshRemoteId);
});
```

### Main -> Renderer (Events/Push)

```typescript
// Main: push data to renderer
safeSend('output', sessionId, eventData);
safeSend('process-exit', sessionId, exitCode);
safeSend('usage-update', sessionId, usageStats);

// Renderer: listen for events via preload
// (preload exposes ipcRenderer.on wrappers in namespace APIs)
window.maestro.process.onOutput((sessionId, data) => { ... });
```

### Event Forwarding (Logger)

The logger event forwarding is set up separately from handler registration:

```typescript
// In registerAllHandlers:
setupLoggerEventForwarding(deps.getMainWindow);

// This connects logger.on('newLog') to safeSend('system-log', entry)
```

---

## Browser Tab Shortcut Forwarding

Electron `<webview>` elements run guest content in a separate Chromium process. When the webview has keyboard focus, keydown events are routed directly to the guest — the host renderer's `window` keydown listener never fires. This requires a dedicated forwarding pipeline for app shortcuts.

### Event Flow

```text
User presses Cmd+Shift+] in webview
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Guest Chromium process                             │
│  before-input-event fires on WebContents            │
│  (src/main/app-lifecycle/window-manager.ts:303)     │
│  → event.preventDefault() blocks page from seeing   │
│    the keydown                                      │
│  → sends IPC: browser-tab:shortcutKey               │
└─────────────────────┬───────────────────────────────┘
                      │ IPC (main → renderer)
                      ▼
┌─────────────────────────────────────────────────────┐
│  Preload bridge                                     │
│  (src/main/preload/system.ts:226-229)               │
│  ipcRenderer.on('browser-tab:shortcutKey', handler) │
│  → exposes as window.maestro.app.                   │
│    onBrowserTabShortcutKey(callback)                │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Renderer IPC listener                              │
│  (useMainKeyboardHandler.ts, useEffect)             │
│  → blurs webview element (document.activeElement)   │
│  → window.dispatchEvent(new KeyboardEvent(...))     │
└─────────────────────┬───────────────────────────────┘
                      │ synthetic keydown on window
                      ▼
┌─────────────────────────────────────────────────────┐
│  Main keyboard handler (useMainKeyboardHandler.ts)  │
│  Processes the shortcut normally (tab cycling,      │
│  Cmd+L address bar focus, etc.)                     │
└─────────────────────────────────────────────────────┘
```

### Defense-in-Depth: Guest JS Injection

A secondary forwarding path exists via JavaScript injection into the guest page. The main process injects a capture-phase keydown listener on `dom-ready` and `did-navigate` (`window-manager.ts:326-350`). This listener calls `console.log('__MAESTRO_KEY__...')`, which the main process picks up via `console-message` and forwards over the same `browser-tab:shortcutKey` IPC channel.

This path is **redundant** when `before-input-event` is active (which blocks the keydown from reaching the page). It serves as a fallback for the narrow window between webview mount and guest attachment.

`BrowserTabView.tsx` also injects a similar listener for scroll-based address bar auto-hide (`__MAESTRO_SCROLL__` messages).

### Focus-Steal Prevention

Pages with autofocus elements (search bars, login forms) or that call `window.focus()` can pull keyboard focus to the webview without user interaction. `BrowserTabView.tsx` prevents this:

```typescript
// pointerdown on host container → mark as intentional
// focusin without preceding pointerdown → blur immediately
```

This ensures the webview only captures keyboard input after an explicit user click, keeping app shortcuts flowing through the window handler for keyboard-driven tab navigation.

### Tab Navigation Pitfall

The `showUnreadOnly` filter in `tabHelpers.ts` (`navigateToNextUnifiedTab` / `navigateToPrevUnifiedTab`) handles tab types with explicit branches. Browser tabs must be listed alongside terminal tabs as "always navigable" — if omitted, they fall through to the AI tab lookup, return undefined, and are silently skipped.

### Key Files

| File                                                    | Role                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/main/app-lifecycle/window-manager.ts`              | `before-input-event` handler, guest JS injection, `console-message` forwarding |
| `src/main/preload/system.ts`                            | `onBrowserTabShortcutKey` IPC bridge                                           |
| `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts` | IPC → blur + dispatch KeyboardEvent                                            |
| `src/renderer/components/MainPanel/BrowserTabView.tsx`  | Focus-steal guard, scroll injection                                            |
| `src/renderer/utils/tabHelpers.ts`                      | Tab navigation with browser tab handling                                       |

---

## Encore-gated IPC Handlers

Some features are gated behind "Encore Feature" flags that users toggle in **Settings → Encore**. When a flag is off, the feature's IPC channels must reject calls — even if the renderer's modal is open — so CLI/web/MCP clients cannot bypass the gate.

### Helper: `requireEncoreFeature`

```typescript
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
```

`requireEncoreFeature(settingsStore, flag)` reads the `encoreFeatures` key from the main-process settings store and returns either `null` (feature enabled, proceed) or a `FeatureDisabledError`:

```typescript
interface FeatureDisabledError {
	success: false;
	code: 'FEATURE_DISABLED';
	feature: string; // the flag key that was checked
	error: string; // 'FEATURE_DISABLED' (for IpcResult compat)
}
```

### Usage Pattern

Pass `settingsStore` through the handler deps and call `gate()` at the top of each `ipcMain.handle` callback:

```typescript
export interface MyHandlerDeps {
  settingsStore: SettingsStoreInterface;
}

export function registerMyHandlers(deps: MyHandlerDeps): void {
  const gate = () => requireEncoreFeature(deps.settingsStore, 'myFeature');

  ipcMain.handle('myFeature:doSomething', async (_event, input) => {
    const gateError = gate();
    if (gateError) return gateError;
    // ... real handler logic
    return createIpcDataHandler(...)(_event, input);
  });
}
```

The `gateError` is returned directly (not thrown) so the caller receives the structured `{ success: false, code: 'FEATURE_DISABLED', feature }` shape rather than a generic error string.

### Gated Channels (as of 2026-05-01)

| Feature flag        | Channels gated                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentDispatch`     | `agentDispatch:getBoard`, `getFleet`, `assignManually`, `releaseClaim`, `pauseAgent`, `resumeAgent`, `listAgents`, `listEligible`, `assign`, `release`, `pause`, `resume`, `createSubtask`, `status` |
| `deliveryPlanner`   | `deliveryPlanner:createPrd`, `decomposePrd`, `decomposeEpic`, `dashboard`, `sync`, `createBugFollowUp`, `addProgressComment`, `resolvePaths`, `getProgress`, `listProgress`, `promoteDocGap`         |
| `planningPipeline`  | `pipeline:getDashboard`                                                                                                                                                                              |
| `conversationalPrd` | `conversationalPrd:createSession`, `sendMessage`, `getSession`, `listSessions`, `archiveSession`, `finalizeSession`                                                                                  |

### Adding a New Gated Feature

1. Add the flag key to `EncoreFeatureFlags` in `src/renderer/types/index.ts`
2. Add a `false` default to `DEFAULT_ENCORE_FEATURES` in `src/renderer/stores/settingsStore.ts`
3. Add a toggle in `src/renderer/components/Settings/tabs/EncoreTab.tsx`
4. Pass `settingsStore` through the handler's deps interface
5. Call `requireEncoreFeature(deps.settingsStore, '<flag>')` at the top of each handler
6. Register the handler with `settingsStore: deps.settingsStore` in `src/main/ipc/handlers/index.ts`
