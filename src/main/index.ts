import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { getThemeById } from './themes';
import Store from 'electron-store';
import { registerGitHandlers, registerAutorunHandlers, registerHistoryHandlers, registerAgentsHandlers, registerProcessHandlers, registerPersistenceHandlers, registerSystemHandlers, setupLoggerEventForwarding } from './ipc/handlers';
import { DEMO_MODE, DEMO_DATA_PATH, CLAUDE_SESSION_PARSE_LIMITS, CLAUDE_PRICING } from './constants';
import {
  SessionStatsCache,
  GlobalStatsCache,
  STATS_CACHE_VERSION,
  GLOBAL_STATS_CACHE_VERSION,
  encodeClaudeProjectPath,
  loadStatsCache,
  saveStatsCache,
  loadGlobalStatsCache,
  saveGlobalStatsCache,
} from './utils/statsCache';

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
  defaultAgent: string;
  fontSize: number;
  fontFamily: string;
  customFonts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  defaultShell: string;
  // Web interface authentication
  webAuthEnabled: boolean;
  webAuthToken: string | null;
}

const store = new Store<MaestroSettings>({
  name: 'maestro-settings',
  defaults: {
    activeThemeId: 'dracula',
    llmProvider: 'openrouter',
    modelSlug: 'anthropic/claude-3.5-sonnet',
    apiKey: '',
    shortcuts: {},
    defaultAgent: 'claude-code',
    fontSize: 14,
    fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
    customFonts: [],
    logLevel: 'info',
    defaultShell: 'zsh',
    webAuthEnabled: false,
    webAuthToken: null,
  },
});

// Helper: Extract semantic text from message content
// Skips images, tool_use, and tool_result - only returns actual text content
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part: { type?: string }) => part.type === 'text')
      .map((part: { type?: string; text?: string }) => part.text || '')
      .filter((text: string) => text.trim());
    return textParts.join(' ');
  }
  return '';
}

// Sessions store
interface SessionsData {
  sessions: any[];
}

const sessionsStore = new Store<SessionsData>({
  name: 'maestro-sessions',
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
  defaults: {
    groups: [],
  },
});

interface AgentConfigsData {
  configs: Record<string, Record<string, any>>; // agentId -> config key-value pairs
}

const agentConfigsStore = new Store<AgentConfigsData>({
  name: 'maestro-agent-configs',
  defaults: {
    configs: {},
  },
});

// Window state store (for remembering window size/position)
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
  defaults: {
    width: 1400,
    height: 900,
    isMaximized: false,
    isFullScreen: false,
  },
});

// History entries store (per-project history for AUTO and USER entries)
interface HistoryEntry {
  id: string;
  type: 'AUTO' | 'USER';
  timestamp: number;
  summary: string;
  fullResponse?: string;
  claudeSessionId?: string;
  sessionName?: string; // User-defined session name
  projectPath: string;
  sessionId?: string; // Maestro session ID for isolation
  contextUsage?: number; // Context window usage percentage at time of entry
  usageStats?: { // Token usage and cost at time of entry
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    contextWindow: number;
  };
  success?: boolean; // For AUTO entries: whether the task completed successfully
  elapsedTimeMs?: number; // Time taken to complete this task in milliseconds
  validated?: boolean; // For AUTO entries: whether a human has validated the task completion
}

interface HistoryData {
  entries: HistoryEntry[];
}

const historyStore = new Store<HistoryData>({
  name: 'maestro-history',
  defaults: {
    entries: [],
  },
});

// Claude session origins store - tracks which Claude sessions were created by Maestro
// and their origin type (user-initiated vs auto/batch)
type ClaudeSessionOrigin = 'user' | 'auto';
interface ClaudeSessionOriginInfo {
  origin: ClaudeSessionOrigin;
  sessionName?: string; // User-defined session name from Maestro
  starred?: boolean;    // Whether the session is starred
}
interface ClaudeSessionOriginsData {
  // Map of projectPath -> { claudeSessionId -> origin info }
  origins: Record<string, Record<string, ClaudeSessionOrigin | ClaudeSessionOriginInfo>>;
}

const claudeSessionOriginsStore = new Store<ClaudeSessionOriginsData>({
  name: 'maestro-claude-session-origins',
  defaults: {
    origins: {},
  },
});

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;
let historyFileWatcherInterval: NodeJS.Timeout | null = null;
let lastHistoryFileMtime: number = 0;
let historyNeedsReload: boolean = false;
let cliActivityWatcher: fsSync.FSWatcher | null = null;

/**
 * Create and configure the web server with all necessary callbacks.
 * Called when user enables the web interface.
 */
function createWebServer(): WebServer {
  const server = new WebServer(); // Random port with auto-generated security token

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
        claudeSessionId: tab.claudeSessionId || null,
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
        claudeSessionId: s.claudeSessionId || null,
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
      claudeSessionId: session.claudeSessionId,
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
  server.setGetHistoryCallback((projectPath?: string, sessionId?: string) => {
    const allEntries = historyStore.get('entries', []);
    let filteredEntries = allEntries;

    // Filter by project path if provided
    if (projectPath) {
      filteredEntries = filteredEntries.filter(
        (entry: HistoryEntry) => entry.projectPath === projectPath
      );
    }

    // Filter by session ID if provided (excludes entries from other sessions)
    if (sessionId) {
      filteredEntries = filteredEntries.filter(
        (entry: HistoryEntry) => !entry.sessionId || entry.sessionId === sessionId
      );
    }

    return filteredEntries;
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
    const claudeSessionId = session?.claudeSessionId || 'none';

    // Forward to renderer - it will handle spawn, state, and everything else
    // This ensures web commands go through exact same code path as desktop commands
    // Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
    logger.info(`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${claudeSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`, 'WebServer');
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

app.whenReady().then(() => {
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

  // Set up IPC handlers
  logger.debug('Setting up IPC handlers', 'Startup');
  setupIpcHandlers();

  // Set up process event listeners
  logger.debug('Setting up process event listeners', 'Startup');
  setupProcessListeners();

  // Create main window
  logger.info('Creating main window', 'Startup');
  createWindow();

  // Start history file watcher (polls every 60 seconds for external changes)
  startHistoryFileWatcher();

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
  // Stop history file watcher
  if (historyFileWatcherInterval) {
    clearInterval(historyFileWatcherInterval);
    historyFileWatcherInterval = null;
  }
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
 * Start watching the history file for external changes (e.g., from CLI).
 * Polls every 60 seconds and notifies renderer if file was modified.
 */
function startHistoryFileWatcher() {
  const historyFilePath = historyStore.path;

  // Get initial mtime
  try {
    const stats = fsSync.statSync(historyFilePath);
    lastHistoryFileMtime = stats.mtimeMs;
  } catch {
    // File doesn't exist yet, that's fine
    lastHistoryFileMtime = 0;
  }

  // Poll every 60 seconds
  historyFileWatcherInterval = setInterval(() => {
    try {
      const stats = fsSync.statSync(historyFilePath);
      if (stats.mtimeMs > lastHistoryFileMtime) {
        lastHistoryFileMtime = stats.mtimeMs;
        // File was modified externally - mark for reload on next getAll
        historyNeedsReload = true;
        logger.debug('History file changed externally, notifying renderer', 'HistoryWatcher');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('history:externalChange');
        }
      }
    } catch {
      // File might not exist, ignore
    }
  }, 60000); // 60 seconds

  logger.info('History file watcher started', 'Startup');
}

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

  // History operations - extracted to src/main/ipc/handlers/history.ts
  registerHistoryHandlers({
    historyStore,
    getHistoryNeedsReload: () => historyNeedsReload,
    setHistoryNeedsReload: (value: boolean) => { historyNeedsReload = value; },
  });

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

  // Live session management - toggle sessions as live/offline in web interface
  ipcMain.handle('live:toggle', async (_, sessionId: string, claudeSessionId?: string) => {
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
      logger.info(`Enabling live mode for session ${sessionId} (claude: ${claudeSessionId || 'none'})`, 'Live');
      webServer.setSessionLive(sessionId, claudeSessionId);
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

  // Claude Code sessions API
  // Sessions are stored in ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
  ipcMain.handle('claude:listSessions', async (_event, projectPath: string) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = encodeClaudeProjectPath(projectPath);
      const projectDir = path.join(claudeProjectsDir, encodedPath);

      logger.info(`Claude sessions lookup - projectPath: ${projectPath}, encodedPath: ${encodedPath}, projectDir: ${projectDir}`, 'ClaudeSessions');

      // Check if the directory exists
      try {
        await fs.access(projectDir);
        logger.info(`Claude sessions directory exists: ${projectDir}`, 'ClaudeSessions');
      } catch (err) {
        logger.info(`No Claude sessions directory found for project: ${projectPath} (tried: ${projectDir}), error: ${err}`, 'ClaudeSessions');
        return [];
      }

      // List all .jsonl files in the directory
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
      logger.info(`Found ${files.length} files, ${sessionFiles.length} .jsonl sessions`, 'ClaudeSessions');

      // Get metadata for each session (read just the first few lines)
      const sessions = await Promise.all(
        sessionFiles.map(async (filename) => {
          const sessionId = filename.replace('.jsonl', '');
          const filePath = path.join(projectDir, filename);

          try {
            const stats = await fs.stat(filePath);

            // Read first line to get initial message/timestamp
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());

            let firstUserMessage = '';
            let timestamp = stats.mtime.toISOString();

            // Fast regex-based extraction to avoid parsing JSON for every line
            // Count user and assistant messages using "type":"user" and "type":"assistant" patterns
            const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
            const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
            const messageCount = userMessageCount + assistantMessageCount;

            // Extract first meaningful message content - parse only first few lines
            // Skip image-only messages, tool_use, and tool_result content
            // Try user messages first, then fall back to assistant messages
            for (let i = 0; i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES); i++) {
              try {
                const entry = JSON.parse(lines[i]);
                // Try user messages first
                if (entry.type === 'user' && entry.message?.content) {
                  const textContent = extractTextFromContent(entry.message.content);
                  if (textContent.trim()) {
                    firstUserMessage = textContent;
                    timestamp = entry.timestamp || timestamp;
                    break;
                  }
                }
                // Fall back to assistant messages if no user text found yet
                if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
                  const textContent = extractTextFromContent(entry.message.content);
                  if (textContent.trim()) {
                    firstUserMessage = textContent;
                    timestamp = entry.timestamp || timestamp;
                    // Don't break - keep looking for a user message
                  }
                }
              } catch {
                // Skip malformed lines
              }
            }

            // Fast regex-based token extraction for cost calculation
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalCacheReadTokens = 0;
            let totalCacheCreationTokens = 0;

            // Match "input_tokens":NUMBER pattern
            const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
            for (const m of inputMatches) totalInputTokens += parseInt(m[1], 10);

            // Match "output_tokens":NUMBER pattern
            const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
            for (const m of outputMatches) totalOutputTokens += parseInt(m[1], 10);

            // Match "cache_read_input_tokens":NUMBER pattern
            const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
            for (const m of cacheReadMatches) totalCacheReadTokens += parseInt(m[1], 10);

            // Match "cache_creation_input_tokens":NUMBER pattern
            const cacheCreationMatches = content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
            for (const m of cacheCreationMatches) totalCacheCreationTokens += parseInt(m[1], 10);

            // Calculate cost estimate using Claude Sonnet 4 pricing
            const inputCost = (totalInputTokens / 1_000_000) * CLAUDE_PRICING.INPUT_PER_MILLION;
            const outputCost = (totalOutputTokens / 1_000_000) * CLAUDE_PRICING.OUTPUT_PER_MILLION;
            const cacheReadCost = (totalCacheReadTokens / 1_000_000) * CLAUDE_PRICING.CACHE_READ_PER_MILLION;
            const cacheCreationCost = (totalCacheCreationTokens / 1_000_000) * CLAUDE_PRICING.CACHE_CREATION_PER_MILLION;
            const costUsd = inputCost + outputCost + cacheReadCost + cacheCreationCost;

            // Extract last timestamp from the session to calculate duration
            let lastTimestamp = timestamp;
            for (let i = lines.length - 1; i >= Math.max(0, lines.length - CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES); i--) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry.timestamp) {
                  lastTimestamp = entry.timestamp;
                  break;
                }
              } catch {
                // Skip malformed lines
              }
            }

            // Calculate duration in seconds
            const startTime = new Date(timestamp).getTime();
            const endTime = new Date(lastTimestamp).getTime();
            const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

            return {
              sessionId,
              projectPath,
              timestamp,
              modifiedAt: stats.mtime.toISOString(),
              firstMessage: firstUserMessage.slice(0, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH), // Truncate for display
              messageCount,
              sizeBytes: stats.size,
              costUsd,
              // Token details for context window info
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cacheReadTokens: totalCacheReadTokens,
              cacheCreationTokens: totalCacheCreationTokens,
              durationSeconds,
            };
          } catch (error) {
            logger.error(`Error reading session file: ${filename}`, 'ClaudeSessions', error);
            return null;
          }
        })
      );

      // Filter out nulls and sort by modified date (most recent first)
      const validSessions = sessions
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

      // Get Maestro session origins to identify which sessions were created via Maestro
      const origins = claudeSessionOriginsStore.get('origins', {});
      const projectOrigins = origins[projectPath] || {};

      // Add origin info and session name to each session
      const sessionsWithOrigins = validSessions.map(session => {
        const originData = projectOrigins[session.sessionId];
        // Handle both old string format and new object format
        const origin = typeof originData === 'string' ? originData : originData?.origin;
        const sessionName = typeof originData === 'object' ? originData?.sessionName : undefined;
        return {
          ...session,
          origin: origin as ClaudeSessionOrigin | undefined,
          sessionName,
        };
      });

      logger.info(`Found ${validSessions.length} Claude sessions for project`, 'ClaudeSessions', { projectPath });
      return sessionsWithOrigins;
    } catch (error) {
      logger.error('Error listing Claude sessions', 'ClaudeSessions', error);
      return [];
    }
  });

  // Paginated version of claude:listSessions for better performance with many sessions
  // Returns sessions sorted by modifiedAt (most recent first) with cursor-based pagination
  ipcMain.handle('claude:listSessionsPaginated', async (_event, projectPath: string, options?: {
    cursor?: string;      // Last sessionId from previous page (null for first page)
    limit?: number;       // Number of sessions to return (default 100)
  }) => {
    const { cursor, limit = 100 } = options || {};

    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = encodeClaudeProjectPath(projectPath);
      const projectDir = path.join(claudeProjectsDir, encodedPath);

      // Check if the directory exists
      try {
        await fs.access(projectDir);
      } catch {
        return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
      }

      // List all .jsonl files and get their stats (fast - no file content reading)
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      // Get file stats for all sessions (just mtime for sorting, no content reading)
      const fileStats = await Promise.all(
        sessionFiles.map(async (filename) => {
          const sessionId = filename.replace('.jsonl', '');
          const filePath = path.join(projectDir, filename);
          try {
            const stats = await fs.stat(filePath);
            return {
              sessionId,
              filename,
              filePath,
              modifiedAt: stats.mtime.getTime(),
              sizeBytes: stats.size,
            };
          } catch {
            return null;
          }
        })
      );

      // Filter out nulls and sort by modified date (most recent first)
      const sortedFiles = fileStats
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => b.modifiedAt - a.modifiedAt);

      const totalCount = sortedFiles.length;

      // Find cursor position
      let startIndex = 0;
      if (cursor) {
        const cursorIndex = sortedFiles.findIndex(f => f.sessionId === cursor);
        startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      }

      // Get the slice for this page
      const pageFiles = sortedFiles.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < totalCount;
      const nextCursor = hasMore ? pageFiles[pageFiles.length - 1]?.sessionId : null;

      // Get Maestro session origins
      const origins = claudeSessionOriginsStore.get('origins', {});
      const projectOrigins = origins[projectPath] || {};

      // Now read full content only for the sessions in this page
      const sessions = await Promise.all(
        pageFiles.map(async (fileInfo) => {
          try {
            const content = await fs.readFile(fileInfo.filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());

            let firstUserMessage = '';
            let timestamp = new Date(fileInfo.modifiedAt).toISOString();

            // Fast regex-based extraction
            const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
            const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
            const messageCount = userMessageCount + assistantMessageCount;

            // Extract first meaningful message content - parse only first few lines
            // Skip image-only messages, tool_use, and tool_result content
            // Try user messages first, then fall back to assistant messages
            for (let i = 0; i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES); i++) {
              try {
                const entry = JSON.parse(lines[i]);
                // Try user messages first
                if (entry.type === 'user' && entry.message?.content) {
                  const textContent = extractTextFromContent(entry.message.content);
                  if (textContent.trim()) {
                    firstUserMessage = textContent;
                    timestamp = entry.timestamp || timestamp;
                    break;
                  }
                }
                // Fall back to assistant messages if no user text found yet
                if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
                  const textContent = extractTextFromContent(entry.message.content);
                  if (textContent.trim()) {
                    firstUserMessage = textContent;
                    timestamp = entry.timestamp || timestamp;
                    // Don't break - keep looking for a user message
                  }
                }
              } catch {
                // Skip malformed lines
              }
            }

            // Fast regex-based token extraction for cost calculation
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalCacheReadTokens = 0;
            let totalCacheCreationTokens = 0;

            const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
            for (const m of inputMatches) totalInputTokens += parseInt(m[1], 10);

            const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
            for (const m of outputMatches) totalOutputTokens += parseInt(m[1], 10);

            const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
            for (const m of cacheReadMatches) totalCacheReadTokens += parseInt(m[1], 10);

            const cacheCreationMatches = content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
            for (const m of cacheCreationMatches) totalCacheCreationTokens += parseInt(m[1], 10);

            // Calculate cost estimate
            const inputCost = (totalInputTokens / 1_000_000) * CLAUDE_PRICING.INPUT_PER_MILLION;
            const outputCost = (totalOutputTokens / 1_000_000) * CLAUDE_PRICING.OUTPUT_PER_MILLION;
            const cacheReadCost = (totalCacheReadTokens / 1_000_000) * CLAUDE_PRICING.CACHE_READ_PER_MILLION;
            const cacheCreationCost = (totalCacheCreationTokens / 1_000_000) * CLAUDE_PRICING.CACHE_CREATION_PER_MILLION;
            const costUsd = inputCost + outputCost + cacheReadCost + cacheCreationCost;

            // Extract last timestamp for duration
            let lastTimestamp = timestamp;
            for (let i = lines.length - 1; i >= Math.max(0, lines.length - CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES); i--) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry.timestamp) {
                  lastTimestamp = entry.timestamp;
                  break;
                }
              } catch {
                // Skip malformed lines
              }
            }

            const startTime = new Date(timestamp).getTime();
            const endTime = new Date(lastTimestamp).getTime();
            const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

            // Get origin info
            const originData = projectOrigins[fileInfo.sessionId];
            const origin = typeof originData === 'string' ? originData : originData?.origin;
            const sessionName = typeof originData === 'object' ? originData?.sessionName : undefined;

            return {
              sessionId: fileInfo.sessionId,
              projectPath,
              timestamp,
              modifiedAt: new Date(fileInfo.modifiedAt).toISOString(),
              firstMessage: firstUserMessage.slice(0, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH),
              messageCount,
              sizeBytes: fileInfo.sizeBytes,
              costUsd,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cacheReadTokens: totalCacheReadTokens,
              cacheCreationTokens: totalCacheCreationTokens,
              durationSeconds,
              origin: origin as ClaudeSessionOrigin | undefined,
              sessionName,
            };
          } catch (error) {
            logger.error(`Error reading session file: ${fileInfo.filename}`, 'ClaudeSessions', error);
            return null;
          }
        })
      );

      const validSessions = sessions.filter((s): s is NonNullable<typeof s> => s !== null);

      logger.info(`Paginated Claude sessions - returned ${validSessions.length} of ${totalCount} total`, 'ClaudeSessions', { projectPath, cursor, limit });

      return {
        sessions: validSessions,
        hasMore,
        totalCount,
        nextCursor,
      };
    } catch (error) {
      logger.error('Error listing Claude sessions (paginated)', 'ClaudeSessions', error);
      return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
    }
  });

  // Get aggregate stats for ALL sessions in a project (uses cache for speed)
  // Only recalculates stats for new or modified session files
  ipcMain.handle('claude:getProjectStats', async (_event, projectPath: string) => {
    // Helper to send progressive updates to renderer
    const sendUpdate = (stats: {
      totalSessions: number;
      totalMessages: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      totalTokens: number;
      oldestTimestamp: string | null;
      processedCount: number;
      isComplete: boolean;
    }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:projectStatsUpdate', { projectPath, ...stats });
      }
    };

    // Helper to parse a single session file and extract stats
    const parseSessionFile = async (_filePath: string, content: string, fileStat: { size: number }) => {
      // Count messages using regex (fast)
      const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
      const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
      const messages = userMessageCount + assistantMessageCount;

      // Extract tokens for cost calculation
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;

      const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
      for (const m of inputMatches) inputTokens += parseInt(m[1], 10);

      const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
      for (const m of outputMatches) outputTokens += parseInt(m[1], 10);

      const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
      for (const m of cacheReadMatches) cacheReadTokens += parseInt(m[1], 10);

      const cacheCreationMatches = content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
      for (const m of cacheCreationMatches) cacheCreationTokens += parseInt(m[1], 10);

      // Calculate cost
      const inputCost = (inputTokens / 1_000_000) * CLAUDE_PRICING.INPUT_PER_MILLION;
      const outputCost = (outputTokens / 1_000_000) * CLAUDE_PRICING.OUTPUT_PER_MILLION;
      const cacheReadCost = (cacheReadTokens / 1_000_000) * CLAUDE_PRICING.CACHE_READ_PER_MILLION;
      const cacheCreationCost = (cacheCreationTokens / 1_000_000) * CLAUDE_PRICING.CACHE_CREATION_PER_MILLION;
      const costUsd = inputCost + outputCost + cacheReadCost + cacheCreationCost;

      // Find oldest timestamp
      let oldestTimestamp: string | null = null;
      const lines = content.split('\n').filter(l => l.trim());
      for (let j = 0; j < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.OLDEST_TIMESTAMP_SCAN_LINES); j++) {
        try {
          const entry = JSON.parse(lines[j]);
          if (entry.timestamp) {
            oldestTimestamp = entry.timestamp;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }

      return {
        messages,
        costUsd,
        sizeBytes: fileStat.size,
        tokens: inputTokens + outputTokens,
        oldestTimestamp,
      };
    };

    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      const encodedPath = encodeClaudeProjectPath(projectPath);
      const projectDir = path.join(claudeProjectsDir, encodedPath);

      // Check if the directory exists
      try {
        await fs.access(projectDir);
      } catch {
        return { totalSessions: 0, totalMessages: 0, totalCostUsd: 0, totalSizeBytes: 0, totalTokens: 0, oldestTimestamp: null };
      }

      // Load existing cache
      const cache = await loadStatsCache(projectPath);

      // List all .jsonl files with their stats
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
      const totalSessions = sessionFiles.length;

      // Track which sessions need to be parsed
      const sessionsToProcess: { filename: string; filePath: string; mtimeMs: number }[] = [];
      const currentSessionIds = new Set<string>();

      // Check each file against cache
      for (const filename of sessionFiles) {
        const sessionId = filename.replace('.jsonl', '');
        currentSessionIds.add(sessionId);
        const filePath = path.join(projectDir, filename);

        try {
          const fileStat = await fs.stat(filePath);
          const cachedSession = cache?.sessions[sessionId];

          // Need to process if: no cache, or file modified since cache
          if (!cachedSession || cachedSession.fileMtimeMs < fileStat.mtimeMs) {
            sessionsToProcess.push({ filename, filePath, mtimeMs: fileStat.mtimeMs });
          }
        } catch {
          // Skip files we can't stat
        }
      }

      // Initialize new cache or reuse existing
      const newCache: SessionStatsCache = {
        sessions: {},
        totals: {
          totalSessions: 0,
          totalMessages: 0,
          totalCostUsd: 0,
          totalSizeBytes: 0,
          totalTokens: 0,
          oldestTimestamp: null,
        },
        lastUpdated: Date.now(),
        version: STATS_CACHE_VERSION,
      };

      // Copy over cached sessions that still exist
      if (cache) {
        for (const sessionId of Object.keys(cache.sessions)) {
          if (currentSessionIds.has(sessionId)) {
            newCache.sessions[sessionId] = cache.sessions[sessionId];
          }
        }
      }

      // If we have cached data and no updates needed, send immediately
      if (sessionsToProcess.length === 0 && cache) {
        logger.info(`Using cached project stats for ${totalSessions} sessions (no changes)`, 'ClaudeSessions', { projectPath });
        sendUpdate({
          ...cache.totals,
          processedCount: totalSessions,
          isComplete: true,
        });
        return cache.totals;
      }

      // Send initial update with cached data if available
      if (cache && Object.keys(newCache.sessions).length > 0) {
        // Calculate totals from cached sessions
        let cachedMessages = 0, cachedCost = 0, cachedSize = 0, cachedTokens = 0;
        let cachedOldest: string | null = null;
        for (const session of Object.values(newCache.sessions)) {
          cachedMessages += session.messages;
          cachedCost += session.costUsd;
          cachedSize += session.sizeBytes;
          cachedTokens += session.tokens;
          if (session.oldestTimestamp && (!cachedOldest || session.oldestTimestamp < cachedOldest)) {
            cachedOldest = session.oldestTimestamp;
          }
        }
        sendUpdate({
          totalSessions,
          totalMessages: cachedMessages,
          totalCostUsd: cachedCost,
          totalSizeBytes: cachedSize,
          totalTokens: cachedTokens,
          oldestTimestamp: cachedOldest,
          processedCount: Object.keys(newCache.sessions).length,
          isComplete: false,
        });
      }

      // Process new/modified files in batches
      const batchSize = CLAUDE_SESSION_PARSE_LIMITS.STATS_BATCH_SIZE;
      let processedNew = 0;

      for (let i = 0; i < sessionsToProcess.length; i += batchSize) {
        const batch = sessionsToProcess.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async ({ filename, filePath, mtimeMs }) => {
            const sessionId = filename.replace('.jsonl', '');
            try {
              const fileStat = await fs.stat(filePath);
              const content = await fs.readFile(filePath, 'utf-8');
              const stats = await parseSessionFile(filePath, content, fileStat);

              newCache.sessions[sessionId] = {
                ...stats,
                fileMtimeMs: mtimeMs,
              };
            } catch {
              // Skip files that can't be read
            }
          })
        );

        processedNew += batch.length;

        // Calculate current totals and send update
        let totalMessages = 0, totalCostUsd = 0, totalSizeBytes = 0, totalTokens = 0;
        let oldestTimestamp: string | null = null;
        for (const session of Object.values(newCache.sessions)) {
          totalMessages += session.messages;
          totalCostUsd += session.costUsd;
          totalSizeBytes += session.sizeBytes;
          totalTokens += session.tokens;
          if (session.oldestTimestamp && (!oldestTimestamp || session.oldestTimestamp < oldestTimestamp)) {
            oldestTimestamp = session.oldestTimestamp;
          }
        }

        sendUpdate({
          totalSessions,
          totalMessages,
          totalCostUsd,
          totalSizeBytes,
          totalTokens,
          oldestTimestamp,
          processedCount: Object.keys(newCache.sessions).length,
          isComplete: processedNew >= sessionsToProcess.length,
        });
      }

      // Calculate final totals
      let totalMessages = 0, totalCostUsd = 0, totalSizeBytes = 0, totalTokens = 0;
      let oldestTimestamp: string | null = null;
      for (const session of Object.values(newCache.sessions)) {
        totalMessages += session.messages;
        totalCostUsd += session.costUsd;
        totalSizeBytes += session.sizeBytes;
        totalTokens += session.tokens;
        if (session.oldestTimestamp && (!oldestTimestamp || session.oldestTimestamp < oldestTimestamp)) {
          oldestTimestamp = session.oldestTimestamp;
        }
      }

      newCache.totals = { totalSessions, totalMessages, totalCostUsd, totalSizeBytes, totalTokens, oldestTimestamp };

      // Save cache
      await saveStatsCache(projectPath, newCache);

      const cachedCount = Object.keys(newCache.sessions).length - sessionsToProcess.length;
      logger.info(`Computed project stats: ${sessionsToProcess.length} new/modified, ${cachedCount} cached`, 'ClaudeSessions', { projectPath });

      return newCache.totals;
    } catch (error) {
      logger.error('Error computing project stats', 'ClaudeSessions', error);
      return { totalSessions: 0, totalMessages: 0, totalCostUsd: 0, totalSizeBytes: 0, totalTokens: 0, oldestTimestamp: null };
    }
  });

  // Get all session timestamps for activity graph (lightweight, from cache or quick scan)
  ipcMain.handle('claude:getSessionTimestamps', async (_event, projectPath: string) => {
    try {
      // First try to get from cache
      const cache = await loadStatsCache(projectPath);
      if (cache && Object.keys(cache.sessions).length > 0) {
        // Return timestamps from cache
        const timestamps = Object.values(cache.sessions)
          .map(s => s.oldestTimestamp)
          .filter((t): t is string => t !== null);
        return { timestamps };
      }

      // Fall back to quick scan of session files (just read first line for timestamp)
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      const encodedPath = encodeClaudeProjectPath(projectPath);
      const projectDir = path.join(claudeProjectsDir, encodedPath);

      try {
        await fs.access(projectDir);
      } catch {
        return { timestamps: [] };
      }

      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      const timestamps: string[] = [];
      await Promise.all(
        sessionFiles.map(async (filename) => {
          const filePath = path.join(projectDir, filename);
          try {
            // Read only first few KB to get the timestamp
            const handle = await fs.open(filePath, 'r');
            const buffer = Buffer.alloc(1024);
            await handle.read(buffer, 0, 1024, 0);
            await handle.close();

            const firstLine = buffer.toString('utf-8').split('\n')[0];
            if (firstLine) {
              const entry = JSON.parse(firstLine);
              if (entry.timestamp) {
                timestamps.push(entry.timestamp);
              }
            }
          } catch {
            // Skip files that can't be read
          }
        })
      );

      return { timestamps };
    } catch (error) {
      logger.error('Error getting session timestamps', 'ClaudeSessions', error);
      return { timestamps: [] };
    }
  });

  // Get global stats across ALL Claude projects (uses cache for speed)
  // Only recalculates stats for new or modified session files
  ipcMain.handle('claude:getGlobalStats', async () => {
    // Helper to calculate cost from tokens
    const calculateCost = (input: number, output: number, cacheRead: number, cacheCreation: number) => {
      const inputCost = (input / 1_000_000) * 3;
      const outputCost = (output / 1_000_000) * 15;
      const cacheReadCost = (cacheRead / 1_000_000) * 0.30;
      const cacheCreationCost = (cacheCreation / 1_000_000) * 3.75;
      return inputCost + outputCost + cacheReadCost + cacheCreationCost;
    };

    // Helper to send update to renderer
    const sendUpdate = (stats: {
      totalSessions: number;
      totalMessages: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      isComplete: boolean;
    }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude:globalStatsUpdate', stats);
      }
    };

    // Helper to calculate totals from cache
    const calculateTotals = (cache: GlobalStatsCache) => {
      let totalSessions = 0, totalMessages = 0, totalInputTokens = 0, totalOutputTokens = 0;
      let totalCacheReadTokens = 0, totalCacheCreationTokens = 0, totalSizeBytes = 0;

      for (const session of Object.values(cache.sessions)) {
        totalSessions++;
        totalMessages += session.messages;
        totalInputTokens += session.inputTokens;
        totalOutputTokens += session.outputTokens;
        totalCacheReadTokens += session.cacheReadTokens;
        totalCacheCreationTokens += session.cacheCreationTokens;
        totalSizeBytes += session.sizeBytes;
      }

      const totalCostUsd = calculateCost(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens);
      return { totalSessions, totalMessages, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalCostUsd, totalSizeBytes };
    };

    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      // Check if the projects directory exists
      try {
        await fs.access(claudeProjectsDir);
      } catch {
        logger.info('No Claude projects directory found', 'ClaudeSessions');
        const emptyStats = {
          totalSessions: 0,
          totalMessages: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalCostUsd: 0,
          totalSizeBytes: 0,
          isComplete: true,
        };
        sendUpdate(emptyStats);
        return emptyStats;
      }

      // Load existing cache
      const cache = await loadGlobalStatsCache();

      // Initialize new cache
      const newCache: GlobalStatsCache = {
        sessions: {},
        totals: {
          totalSessions: 0,
          totalMessages: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalCostUsd: 0,
          totalSizeBytes: 0,
        },
        lastUpdated: Date.now(),
        version: GLOBAL_STATS_CACHE_VERSION,
      };

      // List all project directories
      const projectDirs = await fs.readdir(claudeProjectsDir);

      // Track all current session keys and which need processing
      const currentSessionKeys = new Set<string>();
      const sessionsToProcess: { key: string; filePath: string; mtimeMs: number }[] = [];

      // First pass: identify which sessions need processing
      for (const projectDir of projectDirs) {
        const projectPath = path.join(claudeProjectsDir, projectDir);

        try {
          const stat = await fs.stat(projectPath);
          if (!stat.isDirectory()) continue;

          const files = await fs.readdir(projectPath);
          const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

          for (const filename of sessionFiles) {
            const sessionKey = `${projectDir}/${filename}`;
            currentSessionKeys.add(sessionKey);
            const filePath = path.join(projectPath, filename);

            try {
              const fileStat = await fs.stat(filePath);
              const cached = cache?.sessions[sessionKey];

              if (!cached || cached.fileMtimeMs < fileStat.mtimeMs) {
                sessionsToProcess.push({ key: sessionKey, filePath, mtimeMs: fileStat.mtimeMs });
              } else {
                // Copy cached session
                newCache.sessions[sessionKey] = cached;
              }
            } catch {
              // Skip files we can't stat
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }

      // If no changes needed, return cached data immediately
      if (sessionsToProcess.length === 0 && cache && Object.keys(newCache.sessions).length > 0) {
        const totals = calculateTotals(newCache);
        logger.info(`Using cached global stats: ${totals.totalSessions} sessions (no changes)`, 'ClaudeSessions');
        sendUpdate({ ...totals, isComplete: true });
        return { ...totals, isComplete: true };
      }

      // Send initial update with cached data
      if (Object.keys(newCache.sessions).length > 0) {
        const cachedTotals = calculateTotals(newCache);
        sendUpdate({ ...cachedTotals, isComplete: false });
      }

      // Process new/modified sessions
      let processedCount = 0;
      const batchSize = 50;

      for (let i = 0; i < sessionsToProcess.length; i += batchSize) {
        const batch = sessionsToProcess.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async ({ key, filePath, mtimeMs }) => {
            try {
              const fileStat = await fs.stat(filePath);
              const content = await fs.readFile(filePath, 'utf-8');

              // Count messages
              const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
              const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
              const messages = userMessageCount + assistantMessageCount;

              // Extract tokens
              let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;

              const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
              for (const m of inputMatches) inputTokens += parseInt(m[1], 10);

              const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
              for (const m of outputMatches) outputTokens += parseInt(m[1], 10);

              const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
              for (const m of cacheReadMatches) cacheReadTokens += parseInt(m[1], 10);

              const cacheCreationMatches = content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
              for (const m of cacheCreationMatches) cacheCreationTokens += parseInt(m[1], 10);

              newCache.sessions[key] = {
                messages,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
                sizeBytes: fileStat.size,
                fileMtimeMs: mtimeMs,
              };
            } catch {
              // Skip files we can't read
            }
          })
        );

        processedCount += batch.length;

        // Send progress update
        const currentTotals = calculateTotals(newCache);
        sendUpdate({ ...currentTotals, isComplete: processedCount >= sessionsToProcess.length });
      }

      // Calculate final totals
      const finalTotals = calculateTotals(newCache);
      newCache.totals = finalTotals;

      // Save cache
      await saveGlobalStatsCache(newCache);

      const cachedCount = Object.keys(newCache.sessions).length - sessionsToProcess.length;
      logger.info(`Global stats: ${sessionsToProcess.length} new/modified, ${cachedCount} cached, $${finalTotals.totalCostUsd.toFixed(2)}`, 'ClaudeSessions');

      return { ...finalTotals, isComplete: true };
    } catch (error) {
      logger.error('Error getting global Claude stats', 'ClaudeSessions', error);
      const errorStats = {
        totalSessions: 0,
        totalMessages: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalCostUsd: 0,
        totalSizeBytes: 0,
        isComplete: true,
      };
      sendUpdate(errorStats);
      return errorStats;
    }
  });

  ipcMain.handle('claude:readSessionMessages', async (_event, projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = encodeClaudeProjectPath(projectPath);
      const sessionFile = path.join(claudeProjectsDir, encodedPath, `${sessionId}.jsonl`);

      const content = await fs.readFile(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Parse all messages
      const messages: Array<{
        type: string;
        role?: string;
        content: string;
        timestamp: string;
        uuid: string;
        toolUse?: any;
      }> = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' || entry.type === 'assistant') {
            let content = '';
            let toolUse = undefined;

            if (entry.message?.content) {
              if (typeof entry.message.content === 'string') {
                content = entry.message.content;
              } else if (Array.isArray(entry.message.content)) {
                // Handle array content (text blocks, tool use blocks)
                const textBlocks = entry.message.content.filter((b: any) => b.type === 'text');
                const toolBlocks = entry.message.content.filter((b: any) => b.type === 'tool_use');

                content = textBlocks.map((b: any) => b.text).join('\n');
                if (toolBlocks.length > 0) {
                  toolUse = toolBlocks;
                }
              }
            }

            // Only include messages that have actual text content (skip tool-only and empty messages)
            if (content && content.trim()) {
              messages.push({
                type: entry.type,
                role: entry.message?.role,
                content,
                timestamp: entry.timestamp,
                uuid: entry.uuid,
                toolUse,
              });
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Apply offset and limit for lazy loading (read from end)
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 20;

      // Return messages from the end (most recent)
      const startIndex = Math.max(0, messages.length - offset - limit);
      const endIndex = messages.length - offset;
      const slice = messages.slice(startIndex, endIndex);

      return {
        messages: slice,
        total: messages.length,
        hasMore: startIndex > 0,
      };
    } catch (error) {
      logger.error('Error reading Claude session messages', 'ClaudeSessions', { sessionId, error });
      return { messages: [], total: 0, hasMore: false };
    }
  });

  // Delete a message pair (user message and its response) from Claude session
  // Can match by UUID or by content (for messages created in current session without UUID)
  ipcMain.handle('claude:deleteMessagePair', async (
    _event,
    projectPath: string,
    sessionId: string,
    userMessageUuid: string,
    fallbackContent?: string // Optional: message content to match if UUID not found
  ) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = encodeClaudeProjectPath(projectPath);
      const sessionFile = path.join(claudeProjectsDir, encodedPath, `${sessionId}.jsonl`);

      const content = await fs.readFile(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Parse all lines and find the user message
      const parsedLines: Array<{ line: string; entry: any }> = [];
      let userMessageIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          parsedLines.push({ line: lines[i], entry });

          // First try to match by UUID
          if (entry.uuid === userMessageUuid && entry.type === 'user') {
            userMessageIndex = parsedLines.length - 1;
          }
        } catch {
          // Keep malformed lines as-is
          parsedLines.push({ line: lines[i], entry: null });
        }
      }

      // If UUID match failed and we have fallback content, try matching by content
      if (userMessageIndex === -1 && fallbackContent) {
        // Normalize content for comparison (trim whitespace)
        const normalizedFallback = fallbackContent.trim();

        // Search from the end (most recent first) for a matching user message
        for (let i = parsedLines.length - 1; i >= 0; i--) {
          const entry = parsedLines[i].entry;
          if (entry?.type === 'user') {
            // Extract text content from message
            let messageText = '';
            if (entry.message?.content) {
              if (typeof entry.message.content === 'string') {
                messageText = entry.message.content;
              } else if (Array.isArray(entry.message.content)) {
                const textBlocks = entry.message.content.filter((b: any) => b.type === 'text');
                messageText = textBlocks.map((b: any) => b.text).join('\n');
              }
            }

            if (messageText.trim() === normalizedFallback) {
              userMessageIndex = i;
              logger.info('Found message by content match', 'ClaudeSessions', { sessionId, index: i });
              break;
            }
          }
        }
      }

      if (userMessageIndex === -1) {
        logger.warn('User message not found for deletion', 'ClaudeSessions', { sessionId, userMessageUuid, hasFallback: !!fallbackContent });
        return { success: false, error: 'User message not found' };
      }

      // Find the end of the response (next user message or end of file)
      // We need to delete from userMessageIndex to the next user message (exclusive)
      let endIndex = parsedLines.length;
      for (let i = userMessageIndex + 1; i < parsedLines.length; i++) {
        if (parsedLines[i].entry?.type === 'user') {
          endIndex = i;
          break;
        }
      }

      // Remove the message pair
      const linesToKeep = [
        ...parsedLines.slice(0, userMessageIndex),
        ...parsedLines.slice(endIndex)
      ];

      // Write back to file
      const newContent = linesToKeep.map(p => p.line).join('\n') + '\n';
      await fs.writeFile(sessionFile, newContent, 'utf-8');

      logger.info(`Deleted message pair from Claude session`, 'ClaudeSessions', {
        sessionId,
        userMessageUuid,
        linesRemoved: endIndex - userMessageIndex
      });

      return { success: true, linesRemoved: endIndex - userMessageIndex };
    } catch (error) {
      logger.error('Error deleting message from Claude session', 'ClaudeSessions', { sessionId, userMessageUuid, error });
      return { success: false, error: String(error) };
    }
  });

  // Search through Claude session content
  ipcMain.handle('claude:searchSessions', async (
    _event,
    projectPath: string,
    query: string,
    searchMode: 'title' | 'user' | 'assistant' | 'all'
  ) => {
    try {
      if (!query.trim()) {
        return [];
      }

      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = encodeClaudeProjectPath(projectPath);
      const projectDir = path.join(claudeProjectsDir, encodedPath);

      // Check if the directory exists
      try {
        await fs.access(projectDir);
      } catch {
        return [];
      }

      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      const searchLower = query.toLowerCase();
      const matchingSessions: Array<{
        sessionId: string;
        matchType: 'title' | 'user' | 'assistant';
        matchPreview: string;
        matchCount: number;
      }> = [];

      for (const filename of sessionFiles) {
        const sessionId = filename.replace('.jsonl', '');
        const filePath = path.join(projectDir, filename);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());

          let titleMatch = false;
          let userMatches = 0;
          let assistantMatches = 0;
          let matchPreview = '';

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);

              // Extract text content
              let textContent = '';
              if (entry.message?.content) {
                if (typeof entry.message.content === 'string') {
                  textContent = entry.message.content;
                } else if (Array.isArray(entry.message.content)) {
                  textContent = entry.message.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                    .join('\n');
                }
              }

              const textLower = textContent.toLowerCase();

              // Check for title match (first user message)
              if (entry.type === 'user' && !titleMatch && textLower.includes(searchLower)) {
                titleMatch = true;
                if (!matchPreview) {
                  // Find the matching substring with context
                  const idx = textLower.indexOf(searchLower);
                  const start = Math.max(0, idx - 60);
                  const end = Math.min(textContent.length, idx + query.length + 60);
                  matchPreview = (start > 0 ? '...' : '') + textContent.slice(start, end) + (end < textContent.length ? '...' : '');
                }
              }

              // Check for user message matches
              if (entry.type === 'user' && textLower.includes(searchLower)) {
                userMatches++;
                if (!matchPreview && (searchMode === 'user' || searchMode === 'all')) {
                  const idx = textLower.indexOf(searchLower);
                  const start = Math.max(0, idx - 60);
                  const end = Math.min(textContent.length, idx + query.length + 60);
                  matchPreview = (start > 0 ? '...' : '') + textContent.slice(start, end) + (end < textContent.length ? '...' : '');
                }
              }

              // Check for assistant message matches
              if (entry.type === 'assistant' && textLower.includes(searchLower)) {
                assistantMatches++;
                if (!matchPreview && (searchMode === 'assistant' || searchMode === 'all')) {
                  const idx = textLower.indexOf(searchLower);
                  const start = Math.max(0, idx - 60);
                  const end = Math.min(textContent.length, idx + query.length + 60);
                  matchPreview = (start > 0 ? '...' : '') + textContent.slice(start, end) + (end < textContent.length ? '...' : '');
                }
              }
            } catch {
              // Skip malformed lines
            }
          }

          // Determine if this session matches based on search mode
          let matches = false;
          let matchType: 'title' | 'user' | 'assistant' = 'title';
          let matchCount = 0;

          switch (searchMode) {
            case 'title':
              matches = titleMatch;
              matchType = 'title';
              matchCount = titleMatch ? 1 : 0;
              break;
            case 'user':
              matches = userMatches > 0;
              matchType = 'user';
              matchCount = userMatches;
              break;
            case 'assistant':
              matches = assistantMatches > 0;
              matchType = 'assistant';
              matchCount = assistantMatches;
              break;
            case 'all':
              matches = titleMatch || userMatches > 0 || assistantMatches > 0;
              matchType = titleMatch ? 'title' : userMatches > 0 ? 'user' : 'assistant';
              matchCount = userMatches + assistantMatches;
              break;
          }

          if (matches) {
            matchingSessions.push({
              sessionId,
              matchType,
              matchPreview,
              matchCount,
            });
          }
        } catch {
          // Skip files that can't be read
        }
      }

      return matchingSessions;
    } catch (error) {
      logger.error('Error searching Claude sessions', 'ClaudeSessions', error);
      return [];
    }
  });

  // Get available Claude Code slash commands for a project directory
  // Commands come from: user-defined commands, project-level commands, and enabled plugins
  ipcMain.handle('claude:getCommands', async (_event, projectPath: string) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const commands: Array<{ command: string; description: string }> = [];

      // Helper to extract description from markdown file (first line of content or "No description")
      const extractDescription = async (filePath: string): Promise<string> => {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          // First non-empty line after any YAML frontmatter
          const lines = content.split('\n');
          let inFrontmatter = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '---') {
              inFrontmatter = !inFrontmatter;
              continue;
            }
            if (inFrontmatter) continue;
            if (trimmed.length > 0) {
              // Remove markdown formatting and truncate
              return trimmed.replace(/^#+\s*/, '').slice(0, 100);
            }
          }
          return 'No description';
        } catch {
          return 'No description';
        }
      };

      // Helper to scan a commands directory for .md files
      const scanCommandsDir = async (dir: string, prefix: string = '') => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
              const cmdName = entry.name.replace('.md', '');
              const cmdPath = path.join(dir, entry.name);
              const description = await extractDescription(cmdPath);
              const command = prefix ? `/${prefix}:${cmdName}` : `/${cmdName}`;
              commands.push({ command, description });
            }
          }
        } catch {
          // Directory doesn't exist or isn't readable
        }
      };

      // 1. User-defined commands in ~/.claude/commands/
      const userCommandsDir = path.join(homeDir, '.claude', 'commands');
      await scanCommandsDir(userCommandsDir);

      // 2. Project-level commands in <projectPath>/.claude/commands/
      const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
      await scanCommandsDir(projectCommandsDir);

      // 3. Enabled plugins' commands
      // Read enabled plugins from settings
      const settingsPath = path.join(homeDir, '.claude', 'settings.json');
      try {
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        const enabledPlugins = settings.enabledPlugins || {};

        // Read installed plugins to get their install paths
        const installedPluginsPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
        const installedContent = await fs.readFile(installedPluginsPath, 'utf-8');
        const installedPlugins = JSON.parse(installedContent);

        for (const pluginId of Object.keys(enabledPlugins)) {
          if (!enabledPlugins[pluginId]) continue; // Skip disabled plugins

          const pluginInfo = installedPlugins.plugins?.[pluginId];
          if (!pluginInfo?.installPath) continue;

          // Plugin commands are in <installPath>/commands/
          const pluginCommandsDir = path.join(pluginInfo.installPath, 'commands');
          // Extract plugin name (first part before @)
          const pluginName = pluginId.split('@')[0];
          await scanCommandsDir(pluginCommandsDir, pluginName);
        }
      } catch {
        // Settings or installed plugins not readable
      }

      logger.info(`Found ${commands.length} Claude commands for project: ${projectPath}`, 'ClaudeCommands');
      return commands;
    } catch (error) {
      logger.error('Error getting Claude commands', 'ClaudeCommands', error);
      return [];
    }
  });

  // Temp file operations for batch processing
  ipcMain.handle('tempfile:write', async (_event, content: string, filename?: string) => {
    try {
      const os = await import('os');
      const tempDir = os.default.tmpdir();
      const finalFilename = filename || `maestro-scratchpad-${Date.now()}.md`;
      const tempPath = path.join(tempDir, finalFilename);

      await fs.writeFile(tempPath, content, 'utf-8');
      logger.info(`Wrote temp file: ${tempPath}`, 'TempFile', { size: content.length });
      return { success: true, path: tempPath };
    } catch (error) {
      logger.error('Error writing temp file', 'TempFile', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tempfile:read', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      logger.info(`Read temp file: ${filePath}`, 'TempFile', { size: content.length });
      return { success: true, content };
    } catch (error) {
      logger.error('Error reading temp file', 'TempFile', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tempfile:delete', async (_event, filePath: string) => {
    try {
      await fs.unlink(filePath);
      logger.info(`Deleted temp file: ${filePath}`, 'TempFile');
      return { success: true };
    } catch (error) {
      logger.error('Error deleting temp file', 'TempFile', error);
      return { success: false, error: String(error) };
    }
  });

  // CLI activity status (for detecting when CLI is running playbooks)
  ipcMain.handle('cli:getActivity', async () => {
    try {
      const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
      const content = fsSync.readFileSync(cliActivityPath, 'utf-8');
      const data = JSON.parse(content);
      const activities = data.activities || [];

      // Filter out stale activities (processes no longer running)
      const stillRunning = activities.filter((activity: { pid: number }) => {
        try {
          process.kill(activity.pid, 0); // Doesn't kill, just checks if process exists
          return true;
        } catch {
          return false;
        }
      });

      return stillRunning;
    } catch {
      return [];
    }
  });

  // History persistence - extracted to src/main/ipc/handlers/history.ts

  // Claude session origins tracking (distinguishes Maestro-created sessions from CLI sessions)
  ipcMain.handle('claude:registerSessionOrigin', async (_event, projectPath: string, claudeSessionId: string, origin: 'user' | 'auto', sessionName?: string) => {
    const origins = claudeSessionOriginsStore.get('origins', {});
    if (!origins[projectPath]) {
      origins[projectPath] = {};
    }
    // Store as object if sessionName provided, otherwise just origin string for backwards compat
    origins[projectPath][claudeSessionId] = sessionName
      ? { origin, sessionName }
      : origin;
    claudeSessionOriginsStore.set('origins', origins);
    logger.debug(`Registered Claude session origin: ${claudeSessionId} = ${origin}${sessionName ? ` (name: ${sessionName})` : ''}`, 'ClaudeSessionOrigins', { projectPath });
    return true;
  });

  // Update session name for an existing Claude session
  ipcMain.handle('claude:updateSessionName', async (_event, projectPath: string, claudeSessionId: string, sessionName: string) => {
    const origins = claudeSessionOriginsStore.get('origins', {});
    if (!origins[projectPath]) {
      origins[projectPath] = {};
    }
    const existing = origins[projectPath][claudeSessionId];
    // Convert string origin to object format, or update existing object
    if (typeof existing === 'string') {
      origins[projectPath][claudeSessionId] = { origin: existing, sessionName };
    } else if (existing) {
      origins[projectPath][claudeSessionId] = { ...existing, sessionName };
    } else {
      // No existing origin, default to 'user' since they're naming it
      origins[projectPath][claudeSessionId] = { origin: 'user', sessionName };
    }
    claudeSessionOriginsStore.set('origins', origins);
    logger.debug(`Updated Claude session name: ${claudeSessionId} = ${sessionName}`, 'ClaudeSessionOrigins', { projectPath });
    return true;
  });

  // Update starred status for an existing Claude session
  ipcMain.handle('claude:updateSessionStarred', async (_event, projectPath: string, claudeSessionId: string, starred: boolean) => {
    const origins = claudeSessionOriginsStore.get('origins', {});
    if (!origins[projectPath]) {
      origins[projectPath] = {};
    }
    const existing = origins[projectPath][claudeSessionId];
    // Convert string origin to object format, or update existing object
    if (typeof existing === 'string') {
      origins[projectPath][claudeSessionId] = { origin: existing, starred };
    } else if (existing) {
      origins[projectPath][claudeSessionId] = { ...existing, starred };
    } else {
      // No existing origin, default to 'user' since they're starring it
      origins[projectPath][claudeSessionId] = { origin: 'user', starred };
    }
    claudeSessionOriginsStore.set('origins', origins);
    logger.debug(`Updated Claude session starred: ${claudeSessionId} = ${starred}`, 'ClaudeSessionOrigins', { projectPath });
    return true;
  });

  ipcMain.handle('claude:getSessionOrigins', async (_event, projectPath: string) => {
    const origins = claudeSessionOriginsStore.get('origins', {});
    return origins[projectPath] || {};
  });

  // Get all named sessions across all projects (for Tab Switcher "All Named" view)
  ipcMain.handle('claude:getAllNamedSessions', async () => {
    const os = await import('os');
    const homeDir = os.default.homedir();
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

    const allOrigins = claudeSessionOriginsStore.get('origins', {});
    const namedSessions: Array<{
      claudeSessionId: string;
      projectPath: string;
      sessionName: string;
      starred?: boolean;
      lastActivityAt?: number;
    }> = [];

    for (const [projectPath, sessions] of Object.entries(allOrigins)) {
      for (const [claudeSessionId, info] of Object.entries(sessions)) {
        // Handle both old string format and new object format
        if (typeof info === 'object' && info.sessionName) {
          // Try to get last activity time from the session file
          let lastActivityAt: number | undefined;
          try {
            const encodedPath = encodeClaudeProjectPath(projectPath);
            const sessionFile = path.join(claudeProjectsDir, encodedPath, `${claudeSessionId}.jsonl`);
            const stats = await fs.stat(sessionFile);
            lastActivityAt = stats.mtime.getTime();
          } catch {
            // Session file may not exist or be inaccessible
          }

          namedSessions.push({
            claudeSessionId,
            projectPath,
            sessionName: info.sessionName,
            starred: info.starred,
            lastActivityAt,
          });
        }
      }
    }

    return namedSessions;
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

        // Extract base session ID from formats: {id}-ai-{tabId}, {id}-batch-{timestamp}, {id}-synopsis-{timestamp}
        const baseSessionId = sessionId.replace(/-ai-[^-]+$|-batch-\d+$|-synopsis-\d+$/, '');
        const isAiOutput = sessionId.includes('-ai-') || sessionId.includes('-batch-') || sessionId.includes('-synopsis-');
        const msgId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log(`[WebBroadcast] Broadcasting session_output: msgId=${msgId}, session=${baseSessionId}, source=${isAiOutput ? 'ai' : 'terminal'}, dataLen=${data.length}`);
        webServer.broadcastToSessionClients(baseSessionId, {
          type: 'session_output',
          sessionId: baseSessionId,
          data,
          source: isAiOutput ? 'ai' : 'terminal',
          timestamp: Date.now(),
          msgId,
        });
      }
    });

    processManager.on('exit', (sessionId: string, code: number) => {
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

    processManager.on('session-id', (sessionId: string, claudeSessionId: string) => {
      mainWindow?.webContents.send('process:session-id', sessionId, claudeSessionId);
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
    }) => {
      mainWindow?.webContents.send('process:usage', sessionId, usageStats);
    });
  }
}
