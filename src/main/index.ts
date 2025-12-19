import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import * as Sentry from '@sentry/electron/main';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { getThemeById } from './themes';
import Store from 'electron-store';
import { getHistoryManager } from './history-manager';
import { registerGitHandlers, registerAutorunHandlers, registerPlaybooksHandlers, registerHistoryHandlers, registerAgentsHandlers, registerProcessHandlers, registerPersistenceHandlers, registerSystemHandlers, registerClaudeHandlers, registerAgentSessionsHandlers, registerGroupChatHandlers, setupLoggerEventForwarding } from './ipc/handlers';
import { groupChatEmitters } from './ipc/handlers/groupChat';
import { routeModeratorResponse, setGetSessionsCallback } from './group-chat/group-chat-router';
import { initializeSessionStorages } from './storage';
import { initializeOutputParsers } from './parsers';
import { DEMO_MODE, DEMO_DATA_PATH } from './constants';
import { initAutoUpdater } from './auto-updater';

// ============================================================================
// Custom Storage Location Configuration
// ============================================================================
// This bootstrap store is ALWAYS local - it tells us where to find the main data
// Users can choose a custom folder (e.g., iCloud Drive, Dropbox, OneDrive) to sync settings
interface BootstrapSettings {
  customSyncPath?: string;
  iCloudSyncEnabled?: boolean; // Legacy - kept for backwards compatibility during migration
}

const bootstrapStore = new Store<BootstrapSettings>({
  name: 'maestro-bootstrap',
  defaults: {},
});

/**
 * Get the custom sync path if configured.
 * Returns undefined if using default path.
 */
function getSyncPath(): string | undefined {
  const customPath = bootstrapStore.get('customSyncPath');

  if (customPath) {
    // Ensure the directory exists
    if (!fsSync.existsSync(customPath)) {
      try {
        fsSync.mkdirSync(customPath, { recursive: true });
      } catch {
        // If we can't create the directory, fall back to default
        console.error(`Failed to create custom sync path: ${customPath}, using default`);
        return undefined;
      }
    }
    return customPath;
  }

  return undefined; // Use default path
}

// Get the sync path once at startup
const syncPath = getSyncPath();

// Initialize Sentry for crash reporting (before app.ready)
// Check if crash reporting is enabled (default: true for opt-out behavior)
const crashReportingStore = new Store<{ crashReportingEnabled: boolean }>({
  name: 'maestro-settings',
});
const crashReportingEnabled = crashReportingStore.get('crashReportingEnabled', true);

if (crashReportingEnabled) {
  Sentry.init({
    dsn: 'https://2303c5f787f910863d83ed5d27ce8ed2@o4510554134740992.ingest.us.sentry.io/4510554135789568',
    // Set release version for better debugging
    release: app.getVersion(),
    // Only send errors, not performance data
    tracesSampleRate: 0,
    // Filter out sensitive data
    beforeSend(event) {
      // Remove any potential sensitive data from the event
      if (event.user) {
        delete event.user.ip_address;
        delete event.user.email;
      }
      return event;
    },
  });
}

// Demo mode: use a separate data directory for fresh demos
if (DEMO_MODE) {
  app.setPath('userData', DEMO_DATA_PATH);
  console.log(`[DEMO MODE] Using data directory: ${DEMO_DATA_PATH}`);
}

// Type definitions
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
  // Web interface authentication
  webAuthEnabled: boolean;
  webAuthToken: string | null;
  // Web interface custom port
  webInterfaceUseCustomPort: boolean;
  webInterfaceCustomPort: number;
}

const store = new Store<MaestroSettings>({
  name: 'maestro-settings',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    activeThemeId: 'dracula',
    llmProvider: 'openrouter',
    modelSlug: 'anthropic/claude-3.5-sonnet',
    apiKey: '',
    shortcuts: {},
    fontSize: 14,
    fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
    customFonts: [],
    logLevel: 'info',
    defaultShell: 'zsh',
    webAuthEnabled: false,
    webAuthToken: null,
    webInterfaceUseCustomPort: false,
    webInterfaceCustomPort: 8080,
  },
});

// Sessions store
interface SessionsData {
  sessions: any[];
}

const sessionsStore = new Store<SessionsData>({
  name: 'maestro-sessions',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    sessions: [],
  },
});

// Groups store
interface GroupsData {
  groups: any[];
}

const groupsStore = new Store<GroupsData>({
  name: 'maestro-groups',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    groups: [],
  },
});

interface AgentConfigsData {
  configs: Record<string, Record<string, any>>; // agentId -> config key-value pairs
}

const agentConfigsStore = new Store<AgentConfigsData>({
  name: 'maestro-agent-configs',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    configs: {},
  },
});

// Window state store (for remembering window size/position)
// NOTE: This is intentionally NOT synced - window state is per-device
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
}

const windowStateStore = new Store<WindowState>({
  name: 'maestro-window-state',
  // No cwd - always local, not synced (window position is device-specific)
  defaults: {
    width: 1400,
    height: 900,
    isMaximized: false,
    isFullScreen: false,
  },
});

// Note: History storage is now handled by HistoryManager which uses per-session files
// in the history/ directory. The legacy maestro-history.json file is migrated automatically.
// See src/main/history-manager.ts for details.

// Claude session origins store - tracks which Claude sessions were created by Maestro
// and their origin type (user-initiated vs auto/batch)
type ClaudeSessionOrigin = 'user' | 'auto';
interface ClaudeSessionOriginInfo {
  origin: ClaudeSessionOrigin;
  sessionName?: string; // User-defined session name from Maestro
  starred?: boolean;    // Whether the session is starred
}
interface ClaudeSessionOriginsData {
  // Map of projectPath -> { agentSessionId -> origin info }
  origins: Record<string, Record<string, ClaudeSessionOrigin | ClaudeSessionOriginInfo>>;
}

const claudeSessionOriginsStore = new Store<ClaudeSessionOriginsData>({
  name: 'maestro-claude-session-origins',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    origins: {},
  },
});

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;
let cliActivityWatcher: fsSync.FSWatcher | null = null;

/**
 * Create and configure the web server with all necessary callbacks.
 * Called when user enables the web interface.
 */
function createWebServer(): WebServer {
  // Use custom port if enabled, otherwise 0 for random port assignment
  const useCustomPort = store.get('webInterfaceUseCustomPort', false);
  const customPort = store.get('webInterfaceCustomPort', 8080);
  const port = useCustomPort ? customPort : 0;
  const server = new WebServer(port); // Custom or random port with auto-generated security token

  // Set up callback for web server to fetch sessions list
  server.setGetSessionsCallback(() => {
    const sessions = sessionsStore.get('sessions', []);
    const groups = groupsStore.get('groups', []);
    return sessions.map((s: any) => {
      // Find the group for this session
      const group = s.groupId ? groups.find((g: any) => g.id === s.groupId) : null;

      // Extract last AI response for mobile preview (first 3 lines, max 500 chars)
      // Use active tab's logs as the source of truth
      let lastResponse = null;
      const activeTab = s.aiTabs?.find((t: any) => t.id === s.activeTabId) || s.aiTabs?.[0];
      const tabLogs = activeTab?.logs || [];
      if (tabLogs.length > 0) {
        // Find the last stdout/stderr entry from the AI (not user messages)
        const lastAiLog = [...tabLogs].reverse().find((log: any) =>
          log.source === 'stdout' || log.source === 'stderr'
        );
        if (lastAiLog && lastAiLog.text) {
          const fullText = lastAiLog.text;
          // Get first 3 lines or 500 chars, whichever is shorter
          const lines = fullText.split('\n').slice(0, 3);
          let previewText = lines.join('\n');
          if (previewText.length > 500) {
            previewText = previewText.slice(0, 497) + '...';
          } else if (fullText.length > previewText.length) {
            previewText = previewText + '...';
          }
          lastResponse = {
            text: previewText,
            timestamp: lastAiLog.timestamp,
            source: lastAiLog.source,
            fullLength: fullText.length,
          };
        }
      }

      // Map aiTabs to web-safe format (strip logs to reduce payload)
      const aiTabs = s.aiTabs?.map((tab: any) => ({
        id: tab.id,
        agentSessionId: tab.agentSessionId || null,
        name: tab.name || null,
        starred: tab.starred || false,
        inputValue: tab.inputValue || '',
        usageStats: tab.usageStats || null,
        createdAt: tab.createdAt,
        state: tab.state || 'idle',
        thinkingStartTime: tab.thinkingStartTime || null,
      })) || [];

      return {
        id: s.id,
        name: s.name,
        toolType: s.toolType,
        state: s.state,
        inputMode: s.inputMode,
        cwd: s.cwd,
        groupId: s.groupId || null,
        groupName: group?.name || null,
        groupEmoji: group?.emoji || null,
        usageStats: s.usageStats || null,
        lastResponse,
        agentSessionId: s.agentSessionId || null,
        thinkingStartTime: s.thinkingStartTime || null,
        aiTabs,
        activeTabId: s.activeTabId || (aiTabs.length > 0 ? aiTabs[0].id : undefined),
        bookmarked: s.bookmarked || false,
      };
    });
  });

  // Set up callback for web server to fetch single session details
  // Optional tabId param allows fetching logs for a specific tab (avoids race conditions)
  server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => {
    const sessions = sessionsStore.get('sessions', []);
    const session = sessions.find((s: any) => s.id === sessionId);
    if (!session) return null;

    // Get the requested tab's logs (or active tab if no tabId provided)
    // Tabs are the source of truth for AI conversation history
    let aiLogs: any[] = [];
    const targetTabId = tabId || session.activeTabId;
    if (session.aiTabs && session.aiTabs.length > 0) {
      const targetTab = session.aiTabs.find((t: any) => t.id === targetTabId) || session.aiTabs[0];
      aiLogs = targetTab?.logs || [];
    }

    return {
      id: session.id,
      name: session.name,
      toolType: session.toolType,
      state: session.state,
      inputMode: session.inputMode,
      cwd: session.cwd,
      aiLogs,
      shellLogs: session.shellLogs || [],
      usageStats: session.usageStats,
      agentSessionId: session.agentSessionId,
      isGitRepo: session.isGitRepo,
      activeTabId: targetTabId,
    };
  });

  // Set up callback for web server to fetch current theme
  server.setGetThemeCallback(() => {
    const themeId = store.get('activeThemeId', 'dracula');
    return getThemeById(themeId);
  });

  // Set up callback for web server to fetch custom AI commands
  server.setGetCustomCommandsCallback(() => {
    const customCommands = store.get('customAICommands', []) as Array<{
      id: string;
      command: string;
      description: string;
      prompt: string;
    }>;
    return customCommands;
  });

  // Set up callback for web server to fetch history entries
  // Uses HistoryManager for per-session storage
  server.setGetHistoryCallback((projectPath?: string, sessionId?: string) => {
    const historyManager = getHistoryManager();

    if (sessionId) {
      // Get entries for specific session
      const entries = historyManager.getEntries(sessionId);
      // Sort by timestamp descending
      entries.sort((a, b) => b.timestamp - a.timestamp);
      return entries;
    }

    if (projectPath) {
      // Get all entries for sessions in this project
      return historyManager.getEntriesByProjectPath(projectPath);
    }

    // Return all entries (for global view)
    return historyManager.getAllEntries();
  });

  // Set up callback for web server to write commands to sessions
  // Note: Process IDs have -ai or -terminal suffix based on session's inputMode
  server.setWriteToSessionCallback((sessionId: string, data: string) => {
    if (!processManager) {
      logger.warn('processManager is null for writeToSession', 'WebServer');
      return false;
    }

    // Get the session's current inputMode to determine which process to write to
    const sessions = sessionsStore.get('sessions', []);
    const session = sessions.find((s: any) => s.id === sessionId);
    if (!session) {
      logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
      return false;
    }

    // Append -ai or -terminal suffix based on inputMode
    const targetSessionId = session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
    logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

    const result = processManager.write(targetSessionId, data);
    logger.debug(`Write result: ${result}`, 'WebServer');
    return result;
  });

  // Set up callback for web server to execute commands through the desktop
  // This forwards AI commands to the renderer, ensuring single source of truth
  // The renderer handles all spawn logic, state management, and broadcasts
  server.setExecuteCommandCallback(async (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
    if (!mainWindow) {
      logger.warn('mainWindow is null for executeCommand', 'WebServer');
      return false;
    }

    // Look up the session to get Claude session ID for logging
    const sessions = sessionsStore.get('sessions', []);
    const session = sessions.find((s: any) => s.id === sessionId);
    const agentSessionId = session?.agentSessionId || 'none';

    // Forward to renderer - it will handle spawn, state, and everything else
    // This ensures web commands go through exact same code path as desktop commands
    // Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
    logger.info(`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`, 'WebServer');
    mainWindow.webContents.send('remote:executeCommand', sessionId, command, inputMode);
    return true;
  });

  // Set up callback for web server to interrupt sessions through the desktop
  // This forwards to the renderer which handles state updates and broadcasts
  server.setInterruptSessionCallback(async (sessionId: string) => {
    if (!mainWindow) {
      logger.warn('mainWindow is null for interrupt', 'WebServer');
      return false;
    }

    // Forward to renderer - it will handle interrupt, state update, and broadcasts
    // This ensures web interrupts go through exact same code path as desktop interrupts
    logger.debug(`Forwarding interrupt to renderer for session ${sessionId}`, 'WebServer');
    mainWindow.webContents.send('remote:interrupt', sessionId);
    return true;
  });

  // Set up callback for web server to switch session mode through the desktop
  // This forwards to the renderer which handles state updates and broadcasts
  server.setSwitchModeCallback(async (sessionId: string, mode: 'ai' | 'terminal') => {
    logger.info(`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for switchMode', 'WebServer');
      return false;
    }

    // Forward to renderer - it will handle mode switch and broadcasts
    // This ensures web mode switches go through exact same code path as desktop
    logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
    mainWindow.webContents.send('remote:switchMode', sessionId, mode);
    return true;
  });

  // Set up callback for web server to select/switch to a session in the desktop
  // This forwards to the renderer which handles state updates and broadcasts
  // If tabId is provided, also switches to that tab within the session
  server.setSelectSessionCallback(async (sessionId: string, tabId?: string) => {
    logger.info(`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for selectSession', 'WebServer');
      return false;
    }

    // Forward to renderer - it will handle session selection and broadcasts
    logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
    mainWindow.webContents.send('remote:selectSession', sessionId, tabId);
    return true;
  });

  // Tab operation callbacks
  server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
    logger.info(`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for selectTab', 'WebServer');
      return false;
    }

    mainWindow.webContents.send('remote:selectTab', sessionId, tabId);
    return true;
  });

  server.setNewTabCallback(async (sessionId: string) => {
    logger.info(`[Web→Desktop] New tab callback invoked: session=${sessionId}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for newTab', 'WebServer');
      return null;
    }

    // Use invoke for synchronous response with tab ID
    return new Promise((resolve) => {
      const responseChannel = `remote:newTab:response:${Date.now()}`;
      ipcMain.once(responseChannel, (_event, result) => {
        resolve(result);
      });
      mainWindow!.webContents.send('remote:newTab', sessionId, responseChannel);
      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);
    });
  });

  server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
    logger.info(`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for closeTab', 'WebServer');
      return false;
    }

    mainWindow.webContents.send('remote:closeTab', sessionId, tabId);
    return true;
  });

  server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
    logger.info(`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`, 'WebServer');
    if (!mainWindow) {
      logger.warn('mainWindow is null for renameTab', 'WebServer');
      return false;
    }

    mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
    return true;
  });

  return server;
}

function createWindow() {
  // Restore saved window state
  const savedState = windowStateStore.store;

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0b0b0d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Restore maximized/fullscreen state after window is created
  if (savedState.isFullScreen) {
    mainWindow.setFullScreen(true);
  } else if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  logger.info('Browser window created', 'Window', {
    size: `${savedState.width}x${savedState.height}`,
    maximized: savedState.isMaximized,
    fullScreen: savedState.isFullScreen,
    mode: process.env.NODE_ENV || 'production'
  });

  // Save window state before closing
  const saveWindowState = () => {
    if (!mainWindow) return;

    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    const bounds = mainWindow.getBounds();

    // Only save bounds if not maximized/fullscreen (to restore proper size later)
    if (!isMaximized && !isFullScreen) {
      windowStateStore.set('x', bounds.x);
      windowStateStore.set('y', bounds.y);
      windowStateStore.set('width', bounds.width);
      windowStateStore.set('height', bounds.height);
    }
    windowStateStore.set('isMaximized', isMaximized);
    windowStateStore.set('isFullScreen', isFullScreen);
  };

  mainWindow.on('close', saveWindowState);

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    // DevTools can be opened via Command-K menu instead of automatically on startup
    logger.info('Loading development server', 'Window');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    logger.info('Loading production build', 'Window');
    // Open DevTools in production if DEBUG env var is set
    if (process.env.DEBUG === 'true') {
      mainWindow.webContents.openDevTools();
    }
  }

  mainWindow.on('closed', () => {
    logger.info('Browser window closed', 'Window');
    mainWindow = null;
  });

  // Initialize auto-updater (only in production)
  if (process.env.NODE_ENV !== 'development') {
    initAutoUpdater(mainWindow);
    logger.info('Auto-updater initialized', 'Window');
  } else {
    // Register stub handlers in development mode so users get a helpful error
    ipcMain.handle('updates:download', async () => {
      return { success: false, error: 'Auto-update is disabled in development mode. Please check update first.' };
    });
    ipcMain.handle('updates:install', async () => {
      logger.warn('Auto-update install called in development mode', 'AutoUpdater');
    });
    ipcMain.handle('updates:getStatus', async () => {
      return { status: 'idle' as const };
    });
    ipcMain.handle('updates:checkAutoUpdater', async () => {
      return { success: false, error: 'Auto-update is disabled in development mode' };
    });
    logger.info('Auto-updater disabled in development mode (stub handlers registered)', 'Window');
  }
}

// Set up global error handlers for uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.error(
    `Uncaught Exception: ${error.message}`,
    'UncaughtException',
    {
      stack: error.stack,
      name: error.name,
    }
  );
  // Don't exit the process - let it continue running
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error(
    `Unhandled Promise Rejection: ${reason?.message || String(reason)}`,
    'UnhandledRejection',
    {
      reason: reason,
      stack: reason?.stack,
      promise: String(promise),
    }
  );
});

app.whenReady().then(async () => {
  // Load logger settings first
  const logLevel = store.get('logLevel', 'info');
  logger.setLogLevel(logLevel);
  const maxLogBuffer = store.get('maxLogBuffer', 1000);
  logger.setMaxLogBuffer(maxLogBuffer);

  logger.info('Maestro application starting', 'Startup', {
    version: app.getVersion(),
    platform: process.platform,
    logLevel
  });

  // Initialize core services
  logger.info('Initializing core services', 'Startup');
  processManager = new ProcessManager();
  // Note: webServer is created on-demand when user enables web interface (see setupWebServerCallbacks)
  agentDetector = new AgentDetector();

  // Load custom agent paths from settings
  const allAgentConfigs = agentConfigsStore.get('configs', {});
  const customPaths: Record<string, string> = {};
  for (const [agentId, config] of Object.entries(allAgentConfigs)) {
    if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
      customPaths[agentId] = config.customPath as string;
    }
  }
  if (Object.keys(customPaths).length > 0) {
    agentDetector.setCustomPaths(customPaths);
    logger.info(`Loaded custom agent paths: ${JSON.stringify(customPaths)}`, 'Startup');
  }

  logger.info('Core services initialized', 'Startup');

  // Initialize history manager (handles migration from legacy format if needed)
  logger.info('Initializing history manager', 'Startup');
  const historyManager = getHistoryManager();
  try {
    await historyManager.initialize();
    logger.info('History manager initialized', 'Startup');
    // Start watching history directory for external changes (from CLI, etc.)
    historyManager.startWatching((sessionId) => {
      logger.debug(`History file changed for session ${sessionId}, notifying renderer`, 'HistoryWatcher');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('history:externalChange', sessionId);
      }
    });
  } catch (error) {
    // Migration failed - log error but continue with app startup
    // History will be unavailable but the app will still function
    logger.error(`Failed to initialize history manager: ${error}`, 'Startup');
    logger.warn('Continuing without history - history features will be unavailable', 'Startup');
  }

  // Set up IPC handlers
  logger.debug('Setting up IPC handlers', 'Startup');
  setupIpcHandlers();

  // Set up process event listeners
  logger.debug('Setting up process event listeners', 'Startup');
  setupProcessListeners();

  // Create main window
  logger.info('Creating main window', 'Startup');
  createWindow();

  // Note: History file watching is handled by HistoryManager.startWatching() above
  // which uses the new per-session file format in the history/ directory

  // Start CLI activity watcher (polls every 2 seconds for CLI playbook runs)
  startCliActivityWatcher();

  // Note: Web server is not auto-started - it starts when user enables web interface
  // via live:startServer IPC call from the renderer

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  logger.info('Application shutting down', 'Shutdown');
  // Stop history manager watcher
  getHistoryManager().stopWatching();
  // Stop CLI activity watcher
  if (cliActivityWatcher) {
    cliActivityWatcher.close();
    cliActivityWatcher = null;
  }
  // Clean up all running processes
  logger.info('Killing all running processes', 'Shutdown');
  processManager?.killAll();
  logger.info('Stopping tunnel', 'Shutdown');
  await tunnelManager.stop();
  logger.info('Stopping web server', 'Shutdown');
  await webServer?.stop();
  logger.info('Shutdown complete', 'Shutdown');
});

/**
 * Start CLI activity file watcher
 * Uses fs.watch() for event-driven detection when CLI is running playbooks
 */
function startCliActivityWatcher() {
  const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
  const cliActivityDir = path.dirname(cliActivityPath);

  // Ensure directory exists for watching
  if (!fsSync.existsSync(cliActivityDir)) {
    fsSync.mkdirSync(cliActivityDir, { recursive: true });
  }

  // Watch the directory for file changes (handles file creation/deletion)
  // Using directory watch because fs.watch on non-existent file throws
  try {
    cliActivityWatcher = fsSync.watch(cliActivityDir, (_eventType, filename) => {
      if (filename === 'cli-activity.json') {
        logger.debug('CLI activity file changed, notifying renderer', 'CliActivityWatcher');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cli:activityChange');
        }
      }
    });

    cliActivityWatcher.on('error', (error) => {
      logger.error(`CLI activity watcher error: ${error.message}`, 'CliActivityWatcher');
    });

    logger.info('CLI activity watcher started', 'Startup');
  } catch (error) {
    logger.error(`Failed to start CLI activity watcher: ${error}`, 'CliActivityWatcher');
  }
}

function setupIpcHandlers() {
  // Settings, sessions, and groups persistence - extracted to src/main/ipc/handlers/persistence.ts

  // Broadcast user input to web clients (called when desktop sends a message)
  ipcMain.handle('web:broadcastUserInput', async (_, sessionId: string, command: string, inputMode: 'ai' | 'terminal') => {
    if (webServer && webServer.getWebClientCount() > 0) {
      webServer.broadcastUserInput(sessionId, command, inputMode);
      return true;
    }
    return false;
  });

  // Broadcast AutoRun state to web clients (called when batch processing state changes)
  ipcMain.handle('web:broadcastAutoRunState', async (_, sessionId: string, state: {
    isRunning: boolean;
    totalTasks: number;
    completedTasks: number;
    currentTaskIndex: number;
    isStopping?: boolean;
  } | null) => {
    if (webServer && webServer.getWebClientCount() > 0) {
      webServer.broadcastAutoRunState(sessionId, state);
      return true;
    }
    return false;
  });

  // Broadcast tab changes to web clients
  ipcMain.handle('web:broadcastTabsChange', async (_, sessionId: string, aiTabs: any[], activeTabId: string) => {
    if (webServer && webServer.getWebClientCount() > 0) {
      webServer.broadcastTabsChange(sessionId, aiTabs, activeTabId);
      return true;
    }
    return false;
  });

  // Git operations - extracted to src/main/ipc/handlers/git.ts
  registerGitHandlers();

  // Auto Run operations - extracted to src/main/ipc/handlers/autorun.ts
  registerAutorunHandlers({
    mainWindow,
    getMainWindow: () => mainWindow,
    app,
  });

  // Playbook operations - extracted to src/main/ipc/handlers/playbooks.ts
  registerPlaybooksHandlers({
    mainWindow,
    getMainWindow: () => mainWindow,
    app,
  });

  // History operations - extracted to src/main/ipc/handlers/history.ts
  // Uses HistoryManager singleton for per-session storage
  registerHistoryHandlers();

  // Agent management operations - extracted to src/main/ipc/handlers/agents.ts
  registerAgentsHandlers({
    getAgentDetector: () => agentDetector,
    agentConfigsStore,
  });

  // Process management operations - extracted to src/main/ipc/handlers/process.ts
  registerProcessHandlers({
    getProcessManager: () => processManager,
    getAgentDetector: () => agentDetector,
    agentConfigsStore,
    settingsStore: store,
  });

  // Persistence operations - extracted to src/main/ipc/handlers/persistence.ts
  registerPersistenceHandlers({
    settingsStore: store,
    sessionsStore,
    groupsStore,
    getWebServer: () => webServer,
  });

  // System operations - extracted to src/main/ipc/handlers/system.ts
  registerSystemHandlers({
    getMainWindow: () => mainWindow,
    app,
    settingsStore: store,
    tunnelManager,
    getWebServer: () => webServer,
    bootstrapStore, // For iCloud/sync settings
  });

  // Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts
  registerClaudeHandlers({
    claudeSessionOriginsStore,
    getMainWindow: () => mainWindow,
  });

  // Initialize output parsers for all agents (Codex, OpenCode, Claude Code)
  // This must be called before any agent output is processed
  initializeOutputParsers();

  // Initialize session storages and register generic agent sessions handlers
  // This provides the new window.maestro.agentSessions.* API
  initializeSessionStorages();
  registerAgentSessionsHandlers({ getMainWindow: () => mainWindow });

  // Register Group Chat handlers
  registerGroupChatHandlers({
    getMainWindow: () => mainWindow,
    getProcessManager: () => processManager,
    getAgentDetector: () => agentDetector,
  });

  // Set up callback for group chat router to lookup sessions for auto-add @mentions
  setGetSessionsCallback(() => {
    const sessions = sessionsStore.get('sessions', []);
    return sessions.map((s: any) => ({
      id: s.id,
      name: s.name,
      toolType: s.toolType,
      cwd: s.cwd || s.fullPath || process.env.HOME || '/tmp',
    }));
  });

  // Setup logger event forwarding to renderer
  setupLoggerEventForwarding(() => mainWindow);

  // File system operations
  ipcMain.handle('fs:homeDir', () => {
    return os.homedir();
  });

  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Convert Dirent objects to plain objects for IPC serialization
    return entries.map((entry: any) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }));
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      // Check if file is an image
      const ext = filePath.split('.').pop()?.toLowerCase();
      const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
      const isImage = imageExtensions.includes(ext || '');

      if (isImage) {
        // Read image as buffer and convert to base64 data URL
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString('base64');
        const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
        return `data:${mimeType};base64,${base64}`;
      } else {
        // Read text files as UTF-8
        const content = await fs.readFile(filePath, 'utf-8');
        return content;
      }
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  });

  ipcMain.handle('fs:stat', async (_, filePath: string) => {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile()
      };
    } catch (error) {
      throw new Error(`Failed to get file stats: ${error}`);
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to write file: ${error}`);
    }
  });

  // Live session management - toggle sessions as live/offline in web interface
  ipcMain.handle('live:toggle', async (_, sessionId: string, agentSessionId?: string) => {
    if (!webServer) {
      throw new Error('Web server not initialized');
    }

    // Ensure web server is running before allowing live toggle
    if (!webServer.isActive()) {
      logger.warn('Web server not yet started, waiting...', 'Live');
      // Wait for server to start (with timeout)
      const startTime = Date.now();
      while (!webServer.isActive() && Date.now() - startTime < 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!webServer.isActive()) {
        throw new Error('Web server failed to start');
      }
    }

    const isLive = webServer.isSessionLive(sessionId);

    if (isLive) {
      // Turn off live mode
      webServer.setSessionOffline(sessionId);
      logger.info(`Session ${sessionId} is now offline`, 'Live');
      return { live: false, url: null };
    } else {
      // Turn on live mode
      logger.info(`Enabling live mode for session ${sessionId} (claude: ${agentSessionId || 'none'})`, 'Live');
      webServer.setSessionLive(sessionId, agentSessionId);
      const url = webServer.getSessionUrl(sessionId);
      logger.info(`Session ${sessionId} is now live at ${url}`, 'Live');
      return { live: true, url };
    }
  });

  ipcMain.handle('live:getStatus', async (_, sessionId: string) => {
    if (!webServer) {
      return { live: false, url: null };
    }
    const isLive = webServer.isSessionLive(sessionId);
    return {
      live: isLive,
      url: isLive ? webServer.getSessionUrl(sessionId) : null,
    };
  });

  ipcMain.handle('live:getDashboardUrl', async () => {
    if (!webServer) {
      return null;
    }
    return webServer.getSecureUrl();
  });

  ipcMain.handle('live:getLiveSessions', async () => {
    if (!webServer) {
      return [];
    }
    return webServer.getLiveSessions();
  });

  ipcMain.handle('live:broadcastActiveSession', async (_, sessionId: string) => {
    if (webServer) {
      webServer.broadcastActiveSessionChange(sessionId);
    }
  });

  // Start web server (creates if needed, starts if not running)
  ipcMain.handle('live:startServer', async () => {
    try {
      // Create web server if it doesn't exist
      if (!webServer) {
        logger.info('Creating web server', 'WebServer');
        webServer = createWebServer();
      }

      // Start if not already running
      if (!webServer.isActive()) {
        logger.info('Starting web server', 'WebServer');
        const { port, url } = await webServer.start();
        logger.info(`Web server running at ${url} (port ${port})`, 'WebServer');
        return { success: true, url };
      }

      // Already running
      return { success: true, url: webServer.getSecureUrl() };
    } catch (error: any) {
      logger.error(`Failed to start web server: ${error.message}`, 'WebServer');
      return { success: false, error: error.message };
    }
  });

  // Stop web server and clean up
  ipcMain.handle('live:stopServer', async () => {
    if (!webServer) {
      return { success: true };
    }

    try {
      logger.info('Stopping web server', 'WebServer');
      await webServer.stop();
      webServer = null; // Allow garbage collection, will recreate on next start
      logger.info('Web server stopped and cleaned up', 'WebServer');
      return { success: true };
    } catch (error: any) {
      logger.error(`Failed to stop web server: ${error.message}`, 'WebServer');
      return { success: false, error: error.message };
    }
  });

  // Disable all live sessions and stop the server
  ipcMain.handle('live:disableAll', async () => {
    if (!webServer) {
      return { success: true, count: 0 };
    }

    // First mark all sessions as offline
    const liveSessions = webServer.getLiveSessions();
    const count = liveSessions.length;
    for (const session of liveSessions) {
      webServer.setSessionOffline(session.sessionId);
    }

    // Then stop the server
    try {
      logger.info(`Disabled ${count} live sessions, stopping server`, 'Live');
      await webServer.stop();
      webServer = null;
      return { success: true, count };
    } catch (error: any) {
      logger.error(`Failed to stop web server during disableAll: ${error.message}`, 'WebServer');
      return { success: false, count, error: error.message };
    }
  });

  // Web server management
  ipcMain.handle('webserver:getUrl', async () => {
    return webServer?.getSecureUrl();
  });

  ipcMain.handle('webserver:getConnectedClients', async () => {
    return webServer?.getWebClientCount() || 0;
  });

  // System operations (dialog, fonts, shells, tunnel, devtools, updates, logger)
  // extracted to src/main/ipc/handlers/system.ts

  // Claude Code sessions - extracted to src/main/ipc/handlers/claude.ts

  // ==========================================================================
  // Agent Error Handling API
  // ==========================================================================

  // Clear an error state for a session (called after recovery action)
  ipcMain.handle('agent:clearError', async (_event, sessionId: string) => {
    logger.debug('Clearing agent error for session', 'AgentError', { sessionId });
    // Note: The actual error state is managed in the renderer.
    // This handler is used to log the clear action and potentially
    // perform any main process cleanup needed.
    return { success: true };
  });

  // Retry the last operation after an error (optionally with modified parameters)
  ipcMain.handle('agent:retryAfterError', async (_event, sessionId: string, options?: {
    prompt?: string;
    newSession?: boolean;
  }) => {
    logger.info('Retrying after agent error', 'AgentError', {
      sessionId,
      hasPrompt: !!options?.prompt,
      newSession: options?.newSession || false,
    });
    // Note: The actual retry logic is handled in the renderer, which will:
    // 1. Clear the error state
    // 2. Optionally start a new session
    // 3. Re-send the last command or the provided prompt
    // This handler exists for logging and potential future main process coordination.
    return { success: true };
  });

  // Notification operations
  ipcMain.handle('notification:show', async (_event, title: string, body: string) => {
    try {
      const { Notification } = await import('electron');
      if (Notification.isSupported()) {
        const notification = new Notification({
          title,
          body,
          silent: true, // Don't play system sound - we have our own audio feedback option
        });
        notification.show();
        logger.debug('Showed OS notification', 'Notification', { title, body });
        return { success: true };
      } else {
        logger.warn('OS notifications not supported on this platform', 'Notification');
        return { success: false, error: 'Notifications not supported' };
      }
    } catch (error) {
      logger.error('Error showing notification', 'Notification', error);
      return { success: false, error: String(error) };
    }
  });

  // Track active TTS processes by ID for stopping
  const activeTtsProcesses = new Map<number, { process: ReturnType<typeof import('child_process').spawn>; command: string }>();
  let ttsProcessIdCounter = 0;

  // Audio feedback using system TTS command - pipes text via stdin
  ipcMain.handle('notification:speak', async (_event, text: string, command?: string) => {
    console.log('[TTS Main] notification:speak called, text length:', text?.length, 'command:', command);

    // Log the incoming request with full details for debugging
    logger.info('TTS speak request received', 'TTS', {
      command: command || '(default: say)',
      textLength: text?.length || 0,
      textPreview: text ? (text.length > 200 ? text.substring(0, 200) + '...' : text) : '(no text)',
    });

    try {
      const { spawn } = await import('child_process');
      const fullCommand = command || 'say'; // Default to macOS 'say' command
      console.log('[TTS Main] Using fullCommand:', fullCommand);

      console.log('[TTS Main] Spawning with shell:', fullCommand);

      // Log the full command being executed
      logger.info('TTS executing command', 'TTS', {
        command: fullCommand,
        textLength: text?.length || 0,
      });

      // Spawn the TTS process with shell mode to support pipes and command chaining
      const child = spawn(fullCommand, [], {
        stdio: ['pipe', 'ignore', 'pipe'], // stdin: pipe, stdout: ignore, stderr: pipe for errors
        shell: true,
      });

      // Generate a unique ID for this TTS process
      const ttsId = ++ttsProcessIdCounter;
      activeTtsProcesses.set(ttsId, { process: child, command: fullCommand });

      // Write the text to stdin and close it
      if (child.stdin) {
        child.stdin.write(text);
        child.stdin.end();
      }

      child.on('error', (err) => {
        console.error('[TTS Main] Spawn error:', err);
        logger.error('TTS spawn error', 'TTS', {
          error: String(err),
          command: fullCommand,
          textPreview: text ? (text.length > 100 ? text.substring(0, 100) + '...' : text) : '(no text)',
        });
        activeTtsProcesses.delete(ttsId);
      });

      // Capture stderr for debugging
      let stderrOutput = '';
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderrOutput += data.toString();
        });
      }

      child.on('close', (code) => {
        console.log('[TTS Main] Process exited with code:', code);
        if (code !== 0 && stderrOutput) {
          console.error('[TTS Main] stderr:', stderrOutput);
          logger.error('TTS process error output', 'TTS', {
            exitCode: code,
            stderr: stderrOutput,
            command: fullCommand,
          });
        }
        activeTtsProcesses.delete(ttsId);
        // Notify renderer that TTS has completed
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tts:completed', ttsId);
        });
      });

      console.log('[TTS Main] Process spawned successfully with ID:', ttsId);
      logger.info('TTS process spawned successfully', 'TTS', {
        ttsId,
        command: fullCommand,
        textLength: text?.length || 0,
      });
      return { success: true, ttsId };
    } catch (error) {
      console.error('[TTS Main] Error starting audio feedback:', error);
      logger.error('TTS error starting audio feedback', 'TTS', {
        error: String(error),
        command: command || '(default: say)',
        textPreview: text ? (text.length > 100 ? text.substring(0, 100) + '...' : text) : '(no text)',
      });
      return { success: false, error: String(error) };
    }
  });

  // Stop a running TTS process
  ipcMain.handle('notification:stopSpeak', async (_event, ttsId: number) => {
    console.log('[TTS Main] notification:stopSpeak called for ID:', ttsId);

    const ttsProcess = activeTtsProcesses.get(ttsId);
    if (!ttsProcess) {
      console.log('[TTS Main] No active TTS process found with ID:', ttsId);
      return { success: false, error: 'No active TTS process with that ID' };
    }

    try {
      // Kill the process and all its children
      ttsProcess.process.kill('SIGTERM');
      activeTtsProcesses.delete(ttsId);

      logger.info('TTS process stopped', 'TTS', {
        ttsId,
        command: ttsProcess.command,
      });

      console.log('[TTS Main] TTS process killed successfully');
      return { success: true };
    } catch (error) {
      console.error('[TTS Main] Error stopping TTS process:', error);
      logger.error('TTS error stopping process', 'TTS', {
        ttsId,
        error: String(error),
      });
      return { success: false, error: String(error) };
    }
  });

  // Attachments API - store images per Maestro session
  // Images are stored in userData/attachments/{sessionId}/{filename}
  ipcMain.handle('attachments:save', async (_event, sessionId: string, base64Data: string, filename: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const attachmentsDir = path.join(userDataPath, 'attachments', sessionId);

      // Ensure the attachments directory exists
      await fs.mkdir(attachmentsDir, { recursive: true });

      // Extract the base64 content (remove data:image/...;base64, prefix if present)
      const base64Match = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      let buffer: Buffer;
      let finalFilename = filename;

      if (base64Match) {
        const extension = base64Match[1];
        buffer = Buffer.from(base64Match[2], 'base64');
        // Update filename with correct extension if not already present
        if (!filename.includes('.')) {
          finalFilename = `${filename}.${extension}`;
        }
      } else {
        // Assume raw base64
        buffer = Buffer.from(base64Data, 'base64');
      }

      const filePath = path.join(attachmentsDir, finalFilename);
      await fs.writeFile(filePath, buffer);

      logger.info(`Saved attachment: ${filePath}`, 'Attachments', { sessionId, filename: finalFilename, size: buffer.length });
      return { success: true, path: filePath, filename: finalFilename };
    } catch (error) {
      logger.error('Error saving attachment', 'Attachments', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('attachments:load', async (_event, sessionId: string, filename: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const filePath = path.join(userDataPath, 'attachments', sessionId, filename);

      const buffer = await fs.readFile(filePath);
      const base64 = buffer.toString('base64');

      // Determine MIME type from extension
      const ext = path.extname(filename).toLowerCase().slice(1);
      const mimeTypes: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
      };
      const mimeType = mimeTypes[ext] || 'image/png';

      logger.debug(`Loaded attachment: ${filePath}`, 'Attachments', { sessionId, filename, size: buffer.length });
      return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
    } catch (error) {
      logger.error('Error loading attachment', 'Attachments', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('attachments:delete', async (_event, sessionId: string, filename: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const filePath = path.join(userDataPath, 'attachments', sessionId, filename);

      await fs.unlink(filePath);
      logger.info(`Deleted attachment: ${filePath}`, 'Attachments', { sessionId, filename });
      return { success: true };
    } catch (error) {
      logger.error('Error deleting attachment', 'Attachments', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('attachments:list', async (_event, sessionId: string) => {
    try {
      const userDataPath = app.getPath('userData');
      const attachmentsDir = path.join(userDataPath, 'attachments', sessionId);

      try {
        const files = await fs.readdir(attachmentsDir);
        const imageFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
        logger.debug(`Listed attachments for session: ${sessionId}`, 'Attachments', { count: imageFiles.length });
        return { success: true, files: imageFiles };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // Directory doesn't exist yet - no attachments
          return { success: true, files: [] };
        }
        throw err;
      }
    } catch (error) {
      logger.error('Error listing attachments', 'Attachments', error);
      return { success: false, error: String(error), files: [] };
    }
  });

  ipcMain.handle('attachments:getPath', async (_event, sessionId: string) => {
    const userDataPath = app.getPath('userData');
    const attachmentsDir = path.join(userDataPath, 'attachments', sessionId);
    return { success: true, path: attachmentsDir };
  });

  // Auto Run operations - extracted to src/main/ipc/handlers/autorun.ts

  // Playbook operations - extracted to src/main/ipc/handlers/playbooks.ts

  // ==========================================================================
  // Leaderboard API
  // ==========================================================================

  // Submit leaderboard entry to runmaestro.ai
  ipcMain.handle(
    'leaderboard:submit',
    async (
      _event,
      data: {
        email: string;
        displayName: string;
        githubUsername?: string;
        twitterHandle?: string;
        linkedinHandle?: string;
        badgeLevel: number;
        badgeName: string;
        cumulativeTimeMs: number;
        totalRuns: number;
        longestRunMs?: number;
        longestRunDate?: string;
        currentRunMs?: number; // Duration in milliseconds of the run that just completed
        theme?: string;
        clientToken?: string; // Client-generated token for polling auth status
        authToken?: string;   // Required for confirmed email addresses
      }
    ): Promise<{
      success: boolean;
      message: string;
      pendingEmailConfirmation?: boolean;
      error?: string;
      authTokenRequired?: boolean; // True if 401 due to missing token
      ranking?: {
        cumulative: {
          rank: number;
          total: number;
          previousRank: number | null;
          improved: boolean;
        };
        longestRun: {
          rank: number;
          total: number;
          previousRank: number | null;
          improved: boolean;
        } | null;
      };
    }> => {
      try {
        logger.info('Submitting leaderboard entry', 'Leaderboard', {
          displayName: data.displayName,
          email: data.email.substring(0, 3) + '***',
          badgeLevel: data.badgeLevel,
          hasClientToken: !!data.clientToken,
          hasAuthToken: !!data.authToken,
        });

        const response = await fetch('https://runmaestro.ai/api/m4estr0/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Maestro/${app.getVersion()}`,
          },
          body: JSON.stringify(data),
        });

        const result = await response.json() as {
          success?: boolean;
          message?: string;
          pendingEmailConfirmation?: boolean;
          error?: string;
          ranking?: {
            cumulative: {
              rank: number;
              total: number;
              previousRank: number | null;
              improved: boolean;
            };
            longestRun: {
              rank: number;
              total: number;
              previousRank: number | null;
              improved: boolean;
            } | null;
          };
        };

        if (response.ok) {
          logger.info('Leaderboard submission successful', 'Leaderboard', {
            pendingEmailConfirmation: result.pendingEmailConfirmation,
            ranking: result.ranking,
          });
          return {
            success: true,
            message: result.message || 'Submission received',
            pendingEmailConfirmation: result.pendingEmailConfirmation,
            ranking: result.ranking,
          };
        } else if (response.status === 401) {
          // Auth token required or invalid
          logger.warn('Leaderboard submission requires auth token', 'Leaderboard', {
            error: result.error || result.message,
          });
          return {
            success: false,
            message: result.message || 'Authentication required',
            error: result.error || 'Auth token required for confirmed email addresses',
            authTokenRequired: true,
          };
        } else {
          logger.warn('Leaderboard submission failed', 'Leaderboard', {
            status: response.status,
            error: result.error || result.message,
          });
          return {
            success: false,
            message: result.message || 'Submission failed',
            error: result.error || `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error submitting to leaderboard', 'Leaderboard', error);
        return {
          success: false,
          message: 'Failed to connect to leaderboard server',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Poll for auth token after email confirmation
  ipcMain.handle(
    'leaderboard:pollAuthStatus',
    async (
      _event,
      clientToken: string
    ): Promise<{
      status: 'pending' | 'confirmed' | 'expired' | 'error';
      authToken?: string;
      message?: string;
      error?: string;
    }> => {
      try {
        logger.debug('Polling leaderboard auth status', 'Leaderboard');

        const response = await fetch(
          `https://runmaestro.ai/api/m4estr0/auth-status?clientToken=${encodeURIComponent(clientToken)}`,
          {
            headers: {
              'User-Agent': `Maestro/${app.getVersion()}`,
            },
          }
        );

        const result = await response.json() as {
          status: 'pending' | 'confirmed' | 'expired';
          authToken?: string;
          message?: string;
        };

        if (response.ok) {
          if (result.status === 'confirmed' && result.authToken) {
            logger.info('Leaderboard auth token received', 'Leaderboard');
          }
          return {
            status: result.status,
            authToken: result.authToken,
            message: result.message,
          };
        } else {
          return {
            status: 'error',
            error: result.message || `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error polling leaderboard auth status', 'Leaderboard', error);
        return {
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Get leaderboard entries
  ipcMain.handle(
    'leaderboard:get',
    async (
      _event,
      options?: { limit?: number }
    ): Promise<{
      success: boolean;
      entries?: Array<{
        rank: number;
        displayName: string;
        githubUsername?: string;
        avatarUrl?: string;
        badgeLevel: number;
        badgeName: string;
        cumulativeTimeMs: number;
        totalRuns: number;
      }>;
      error?: string;
    }> => {
      try {
        const limit = options?.limit || 50;
        const response = await fetch(`https://runmaestro.ai/api/leaderboard?limit=${limit}`, {
          headers: {
            'User-Agent': `Maestro/${app.getVersion()}`,
          },
        });

        if (response.ok) {
          const data = await response.json() as { entries?: unknown[] };
          return { success: true, entries: data.entries as Array<{
            rank: number;
            displayName: string;
            githubUsername?: string;
            avatarUrl?: string;
            badgeLevel: number;
            badgeName: string;
            cumulativeTimeMs: number;
            totalRuns: number;
          }> };
        } else {
          return {
            success: false,
            error: `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error fetching leaderboard', 'Leaderboard', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Get longest runs leaderboard
  ipcMain.handle(
    'leaderboard:getLongestRuns',
    async (
      _event,
      options?: { limit?: number }
    ): Promise<{
      success: boolean;
      entries?: Array<{
        rank: number;
        displayName: string;
        githubUsername?: string;
        avatarUrl?: string;
        longestRunMs: number;
        runDate: string;
      }>;
      error?: string;
    }> => {
      try {
        const limit = options?.limit || 50;
        const response = await fetch(`https://runmaestro.ai/api/longest-runs?limit=${limit}`, {
          headers: {
            'User-Agent': `Maestro/${app.getVersion()}`,
          },
        });

        if (response.ok) {
          const data = await response.json() as { entries?: unknown[] };
          return { success: true, entries: data.entries as Array<{
            rank: number;
            displayName: string;
            githubUsername?: string;
            avatarUrl?: string;
            longestRunMs: number;
            runDate: string;
          }> };
        } else {
          return {
            success: false,
            error: `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error fetching longest runs leaderboard', 'Leaderboard', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );
}

// Handle process output streaming (set up after initialization)
function setupProcessListeners() {
  if (processManager) {
    processManager.on('data', (sessionId: string, data: string) => {
      // Handle group chat moderator output
      // Session ID format: group-chat-{groupChatId}-moderator-{uuid}
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        // Emit the moderator's response as a group chat message
        const moderatorMessage = {
          timestamp: new Date().toISOString(),
          from: 'moderator',
          content: data,
        };
        groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);
        // Route the response (handles @mentions and logging)
        routeModeratorResponse(groupChatId, data, processManager ?? undefined).catch(err => {
          logger.error('[GroupChat] Failed to route moderator response', 'ProcessListener', { error: String(err) });
        });
        return; // Don't send to regular process:data handler
      }

      mainWindow?.webContents.send('process:data', sessionId, data);

      // Broadcast to web clients - extract base session ID (remove -ai or -terminal suffix)
      // IMPORTANT: Skip PTY terminal output (-terminal suffix) as it contains raw ANSI codes.
      // Web interface terminal commands use runCommand() which emits with plain session IDs.
      if (webServer) {
        // Don't broadcast raw PTY terminal output to web clients
        if (sessionId.endsWith('-terminal')) {
          console.log(`[WebBroadcast] SKIPPING PTY terminal output for web: session=${sessionId}`);
          return;
        }

        // Extract base session ID and tab ID from formats: {id}-ai-{tabId}, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
        const baseSessionId = sessionId.replace(/-ai-[^-]+$|-batch-\d+$|-synopsis-\d+$/, '');
        const isAiOutput = sessionId.includes('-ai-') || sessionId.includes('-batch-') || sessionId.includes('-synopsis-');

        // Extract tab ID from session ID format: {id}-ai-{tabId}
        const tabIdMatch = sessionId.match(/-ai-([^-]+)$/);
        const tabId = tabIdMatch ? tabIdMatch[1] : undefined;

        const msgId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log(`[WebBroadcast] Broadcasting session_output: msgId=${msgId}, session=${baseSessionId}, tabId=${tabId || 'none'}, source=${isAiOutput ? 'ai' : 'terminal'}, dataLen=${data.length}`);
        webServer.broadcastToSessionClients(baseSessionId, {
          type: 'session_output',
          sessionId: baseSessionId,
          tabId,
          data,
          source: isAiOutput ? 'ai' : 'terminal',
          timestamp: Date.now(),
          msgId,
        });
      }
    });

    processManager.on('exit', (sessionId: string, code: number) => {
      // Handle group chat moderator exit - set state back to idle
      // Session ID format: group-chat-{groupChatId}-moderator-{uuid}
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
        // Don't send to regular exit handler
        return;
      }

      mainWindow?.webContents.send('process:exit', sessionId, code);

      // Broadcast exit to web clients
      if (webServer) {
        // Extract base session ID from formats: {id}-ai-{tabId}, {id}-terminal, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
        const baseSessionId = sessionId.replace(/-ai-[^-]+$|-terminal$|-batch-\d+$|-synopsis-\d+$/, '');
        webServer.broadcastToSessionClients(baseSessionId, {
          type: 'session_exit',
          sessionId: baseSessionId,
          exitCode: code,
          timestamp: Date.now(),
        });
      }
    });

    processManager.on('session-id', (sessionId: string, agentSessionId: string) => {
      mainWindow?.webContents.send('process:session-id', sessionId, agentSessionId);
    });

    // Handle slash commands from Claude Code init message
    processManager.on('slash-commands', (sessionId: string, slashCommands: string[]) => {
      mainWindow?.webContents.send('process:slash-commands', sessionId, slashCommands);
    });

    // Handle stderr separately from runCommand (for clean command execution)
    processManager.on('stderr', (sessionId: string, data: string) => {
      mainWindow?.webContents.send('process:stderr', sessionId, data);
    });

    // Handle command exit (from runCommand - separate from PTY exit)
    processManager.on('command-exit', (sessionId: string, code: number) => {
      mainWindow?.webContents.send('process:command-exit', sessionId, code);
    });

    // Handle usage statistics from AI responses
    processManager.on('usage', (sessionId: string, usageStats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      totalCostUsd: number;
      contextWindow: number;
      reasoningTokens?: number;  // Separate reasoning tokens (Codex o3/o4-mini)
    }) => {
      mainWindow?.webContents.send('process:usage', sessionId, usageStats);
    });

    // Handle agent errors (auth expired, token exhaustion, rate limits, etc.)
    processManager.on('agent-error', (sessionId: string, agentError: {
      type: string;
      message: string;
      recoverable: boolean;
      agentId: string;
      sessionId?: string;
      timestamp: number;
      raw?: {
        exitCode?: number;
        stderr?: string;
        stdout?: string;
        errorLine?: string;
      };
    }) => {
      logger.info(`Agent error detected: ${agentError.type}`, 'AgentError', {
        sessionId,
        agentId: agentError.agentId,
        errorType: agentError.type,
        message: agentError.message,
        recoverable: agentError.recoverable,
      });
      mainWindow?.webContents.send('agent:error', sessionId, agentError);
    });
  }
}
