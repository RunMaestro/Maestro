import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import * as Sentry from '@sentry/electron/main';
import { IPCMode } from '@sentry/electron/main';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { logger } from './utils/logger';
import { tunnelManager } from './tunnel-manager';
import { powerManager } from './power-manager';
import { getThemeById } from './themes';
import Store from 'electron-store';
import { getHistoryManager } from './history-manager';
import { registerGitHandlers, registerAutorunHandlers, registerPlaybooksHandlers, registerHistoryHandlers, registerAgentsHandlers, registerProcessHandlers, registerPersistenceHandlers, registerSystemHandlers, registerClaudeHandlers, registerAgentSessionsHandlers, registerGroupChatHandlers, registerDebugHandlers, registerSpeckitHandlers, registerOpenSpecHandlers, registerContextHandlers, registerMarketplaceHandlers, registerStatsHandlers, registerDocumentGraphHandlers, registerSshRemoteHandlers, setupLoggerEventForwarding, cleanupAllGroomingSessions, getActiveGroomingSessionCount } from './ipc/handlers';
import { initializeStatsDB, closeStatsDB, getStatsDB } from './stats-db';
import { groupChatEmitters } from './ipc/handlers/groupChat';
import { routeModeratorResponse, routeAgentResponse, setGetSessionsCallback, setGetCustomEnvVarsCallback, setGetAgentConfigCallback, markParticipantResponded, spawnModeratorSynthesis, getGroupChatReadOnlyState, respawnParticipantWithRecovery } from './group-chat/group-chat-router';
import { updateParticipant, loadGroupChat, updateGroupChat } from './group-chat/group-chat-storage';
import { needsSessionRecovery, initiateSessionRecovery } from './group-chat/session-recovery';
import { initializeSessionStorages } from './storage';
import { initializeOutputParsers, getOutputParser } from './parsers';
import { DEMO_MODE, DEMO_DATA_PATH } from './constants';
import type { SshRemoteConfig } from '../shared/types';
import { initAutoUpdater } from './auto-updater';
import { readDirRemote, readFileRemote, statRemote, directorySizeRemote } from './utils/remote-fs';
import { checkWslEnvironment } from './utils/wslDetector';

// ============================================================================
// Custom Storage Location Configuration
// ============================================================================
// This bootstrap store is ALWAYS local - it tells us where to find the main data
// Users can choose a custom folder (e.g., iCloud Drive, Dropbox, OneDrive) to sync settings
interface BootstrapSettings {
  customSyncPath?: string;
  iCloudSyncEnabled?: boolean; // Legacy - kept for backwards compatibility during migration
}

// ============================================================================
// Data Directory Configuration (MUST happen before any Store initialization)
// ============================================================================
const isDevelopment = process.env.NODE_ENV === 'development';

// Capture the production data path before any modification
// Used for stores that should be shared between dev and prod (e.g., agent configs)
const productionDataPath = app.getPath('userData');

// Demo mode: use a separate data directory for fresh demos
if (DEMO_MODE) {
  app.setPath('userData', DEMO_DATA_PATH);
  console.log(`[DEMO MODE] Using data directory: ${DEMO_DATA_PATH}`);
}

// Development mode: use a separate data directory to allow running alongside production
// This prevents database lock conflicts (e.g., Service Worker storage)
// Set USE_PROD_DATA=1 to use the production data directory instead (requires closing production app)
if (isDevelopment && !DEMO_MODE && !process.env.USE_PROD_DATA) {
  const devDataPath = path.join(app.getPath('userData'), '..', 'maestro-dev');
  app.setPath('userData', devDataPath);
  console.log(`[DEV MODE] Using data directory: ${devDataPath}`);
} else if (isDevelopment && process.env.USE_PROD_DATA) {
  console.log(`[DEV MODE] Using production data directory: ${app.getPath('userData')}`);
}

// ============================================================================
// Store Initialization (after userData path is configured)
// ============================================================================

const bootstrapStore = new Store<BootstrapSettings>({
  name: 'maestro-bootstrap',
  cwd: app.getPath('userData'),
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
// If no custom sync path, use the current userData path (dev or prod depending on mode)
const syncPath = getSyncPath() || app.getPath('userData');

// Log the paths being used for debugging session persistence issues
console.log(`[STARTUP] userData path: ${app.getPath('userData')}`);
console.log(`[STARTUP] syncPath (sessions/settings): ${syncPath}`);
console.log(`[STARTUP] productionDataPath (agent configs): ${productionDataPath}`);

// Initialize Sentry for crash reporting
// Only enable in production - skip during development to avoid noise from hot-reload artifacts
// Check if crash reporting is enabled (default: true for opt-out behavior)
const crashReportingStore = new Store<{ crashReportingEnabled: boolean }>({
  name: 'maestro-settings',
  cwd: syncPath, // Use same path as main settings store
});
const crashReportingEnabled = crashReportingStore.get('crashReportingEnabled', true);

if (crashReportingEnabled && !isDevelopment) {
  Sentry.init({
    dsn: 'https://2303c5f787f910863d83ed5d27ce8ed2@o4510554134740992.ingest.us.sentry.io/4510554135789568',
    // Set release version for better debugging
    release: app.getVersion(),
    // Use Classic IPC mode to avoid "sentry-ipc:// URL scheme not supported" errors
    // See: https://github.com/getsentry/sentry-electron/issues/661
    ipcMode: IPCMode.Classic,
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
  // SSH remote execution
  sshRemotes: SshRemoteConfig[];
  defaultSshRemoteId: string | null;
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
    sshRemotes: [],
    defaultSshRemoteId: null,
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

// Agent configs are ALWAYS stored in the production path, even in dev mode
// This ensures agent paths, custom args, and env vars are shared between dev and prod
// (They represent machine-level configuration, not session/project data)
const agentConfigsStore = new Store<AgentConfigsData>({
  name: 'maestro-agent-configs',
  cwd: productionDataPath,
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

// Generic agent session origins store - supports all agents (Codex, OpenCode, etc.)
// Structure: { [agentId]: { [projectPath]: { [sessionId]: { origin, sessionName, starred } } } }
interface AgentSessionOriginsData {
  origins: Record<string, Record<string, Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>>>;
}
const agentSessionOriginsStore = new Store<AgentSessionOriginsData>({
  name: 'maestro-agent-session-origins',
  cwd: syncPath, // Use iCloud/custom sync path if configured
  defaults: {
    origins: {},
  },
});

/**
 * Get SSH remote configuration by ID.
 * Returns undefined if not found.
 */
function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
  const sshRemotes = store.get('sshRemotes', []) as SshRemoteConfig[];
  return sshRemotes.find((r) => r.id === sshRemoteId);
}

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
        // Note: 'thinking' logs are already excluded since they have a distinct source type
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
        // Worktree subagent support
        parentSessionId: s.parentSessionId || null,
        worktreeBranch: s.worktreeBranch || null,
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
    // Filter out thinking and tool logs - these should never be shown on the web interface
    let aiLogs: any[] = [];
    const targetTabId = tabId || session.activeTabId;
    if (session.aiTabs && session.aiTabs.length > 0) {
      const targetTab = session.aiTabs.find((t: any) => t.id === targetTabId) || session.aiTabs[0];
      const rawLogs = targetTab?.logs || [];
      // Web interface should never show thinking/tool logs regardless of desktop settings
      aiLogs = rawLogs.filter((log: any) => log.source !== 'thinking' && log.source !== 'tool');
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

  // Check for WSL + Windows mount issues early
  checkWslEnvironment(process.cwd());

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

  // Initialize stats database for usage tracking
  logger.info('Initializing stats database', 'Startup');
  try {
    initializeStatsDB();
    logger.info('Stats database initialized', 'Startup');
  } catch (error) {
    // Stats initialization failed - log error but continue with app startup
    // Stats will be unavailable but the app will still function
    logger.error(`Failed to initialize stats database: ${error}`, 'Startup');
    logger.warn('Continuing without stats - usage tracking will be unavailable', 'Startup');
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

// Track if quit has been confirmed by user (or no busy agents)
let quitConfirmed = false;

// Handle quit confirmation from renderer
ipcMain.on('app:quitConfirmed', () => {
  logger.info('Quit confirmed by renderer', 'Window');
  quitConfirmed = true;
  app.quit();
});

// Handle quit cancellation (user declined)
ipcMain.on('app:quitCancelled', () => {
  logger.info('Quit cancelled by renderer', 'Window');
  // Nothing to do - app stays running
});

// IMPORTANT: This handler must be synchronous for event.preventDefault() to work!
// Async handlers return a Promise immediately, which breaks preventDefault in Electron.
app.on('before-quit', (event) => {
  // If quit not yet confirmed, intercept and ask renderer
  if (!quitConfirmed) {
    event.preventDefault();

    // Ask renderer to check for busy agents
    if (mainWindow && !mainWindow.isDestroyed()) {
      logger.info('Requesting quit confirmation from renderer', 'Window');
      mainWindow.webContents.send('app:requestQuitConfirmation');
    } else {
      // No window, just quit
      quitConfirmed = true;
      app.quit();
    }
    return;
  }

  // Quit confirmed - proceed with cleanup (async operations are fire-and-forget)
  logger.info('Application shutting down', 'Shutdown');

  // Stop history manager watcher
  getHistoryManager().stopWatching();

  // Stop CLI activity watcher
  if (cliActivityWatcher) {
    cliActivityWatcher.close();
    cliActivityWatcher = null;
  }

  // Clean up active grooming sessions (context merge/transfer operations)
  const groomingSessionCount = getActiveGroomingSessionCount();
  if (groomingSessionCount > 0 && processManager) {
    logger.info(`Cleaning up ${groomingSessionCount} active grooming session(s)`, 'Shutdown');
    // Fire and forget - don't await
    cleanupAllGroomingSessions(processManager).catch(err => {
      logger.error(`Error cleaning up grooming sessions: ${err}`, 'Shutdown');
    });
  }

  // Clean up all running processes
  logger.info('Killing all running processes', 'Shutdown');
  processManager?.killAll();

  // Stop tunnel and web server (fire and forget)
  logger.info('Stopping tunnel', 'Shutdown');
  tunnelManager.stop().catch(err => {
    logger.error(`Error stopping tunnel: ${err}`, 'Shutdown');
  });

  logger.info('Stopping web server', 'Shutdown');
  webServer?.stop().catch(err => {
    logger.error(`Error stopping web server: ${err}`, 'Shutdown');
  });

  // Close stats database
  logger.info('Closing stats database', 'Shutdown');
  closeStatsDB();

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
  // Always store state even if no clients are connected, so new clients get initial state
  ipcMain.handle('web:broadcastAutoRunState', async (_, sessionId: string, state: {
    isRunning: boolean;
    totalTasks: number;
    completedTasks: number;
    currentTaskIndex: number;
    isStopping?: boolean;
  } | null) => {
    if (webServer) {
      // Always call broadcastAutoRunState - it stores the state for new clients
      // and broadcasts to any currently connected clients
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

  // Broadcast session state change to web clients (for real-time busy/idle updates)
  // This is called directly from the renderer to bypass debounced persistence
  // which resets state to 'idle' before saving
  ipcMain.handle('web:broadcastSessionState', async (_, sessionId: string, state: string, additionalData?: {
    name?: string;
    toolType?: string;
    inputMode?: string;
    cwd?: string;
  }) => {
    if (webServer && webServer.getWebClientCount() > 0) {
      webServer.broadcastSessionStateChange(sessionId, state, additionalData);
      return true;
    }
    return false;
  });

  // Git operations - extracted to src/main/ipc/handlers/git.ts
  registerGitHandlers({
    settingsStore: store,
  });

  // Auto Run operations - extracted to src/main/ipc/handlers/autorun.ts
  registerAutorunHandlers({
    mainWindow,
    getMainWindow: () => mainWindow,
    app,
    settingsStore: store,
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
    getMainWindow: () => mainWindow,
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
  // Pass the shared claudeSessionOriginsStore so session names/stars are consistent
  initializeSessionStorages({ claudeSessionOriginsStore });
  registerAgentSessionsHandlers({ getMainWindow: () => mainWindow, agentSessionOriginsStore });

  // Helper to get agent config values (custom args/env vars, model, etc.)
  const getAgentConfigForAgent = (agentId: string): Record<string, any> => {
    const allConfigs = agentConfigsStore.get('configs', {});
    return allConfigs[agentId] || {};
  };

  // Helper to get custom env vars for an agent
  const getCustomEnvVarsForAgent = (agentId: string): Record<string, string> | undefined => {
    return getAgentConfigForAgent(agentId).customEnvVars as Record<string, string> | undefined;
  };

  // Register Group Chat handlers
  registerGroupChatHandlers({
    getMainWindow: () => mainWindow,
    getProcessManager: () => processManager,
    getAgentDetector: () => agentDetector,
    getCustomEnvVars: getCustomEnvVarsForAgent,
    getAgentConfig: getAgentConfigForAgent,
  });

  // Register Debug Package handlers
  registerDebugHandlers({
    getMainWindow: () => mainWindow,
    getAgentDetector: () => agentDetector,
    getProcessManager: () => processManager,
    getWebServer: () => webServer,
    settingsStore: store,
    sessionsStore,
    groupsStore,
    bootstrapStore,
  });

  // Register Spec Kit handlers (no dependencies needed)
  registerSpeckitHandlers();

  // Register OpenSpec handlers (no dependencies needed)
  registerOpenSpecHandlers();

  // Register Context Merge handlers for session context transfer and grooming
  registerContextHandlers({
    getMainWindow: () => mainWindow,
    getProcessManager: () => processManager,
    getAgentDetector: () => agentDetector,
  });

  // Register Marketplace handlers for fetching and importing playbooks
  registerMarketplaceHandlers({
    app,
  });

  // Register Stats handlers for usage tracking
  registerStatsHandlers({
    getMainWindow: () => mainWindow,
    settingsStore: store,
  });

  // Register Document Graph handlers for file watching
  registerDocumentGraphHandlers({
    getMainWindow: () => mainWindow,
    app,
  });

  // Register SSH Remote handlers for managing SSH configurations
  registerSshRemoteHandlers({
    settingsStore: store,
  });

  // Set up callback for group chat router to lookup sessions for auto-add @mentions
  setGetSessionsCallback(() => {
    const sessions = sessionsStore.get('sessions', []);
    return sessions.map((s: any) => {
      // Resolve SSH remote name if session has SSH config
      let sshRemoteName: string | undefined;
      if (s.sessionSshRemoteConfig?.enabled && s.sessionSshRemoteConfig.remoteId) {
        const sshConfig = getSshRemoteById(s.sessionSshRemoteConfig.remoteId);
        sshRemoteName = sshConfig?.name;
      }
      return {
        id: s.id,
        name: s.name,
        toolType: s.toolType,
        cwd: s.cwd || s.fullPath || process.env.HOME || '/tmp',
        customArgs: s.customArgs,
        customEnvVars: s.customEnvVars,
        customModel: s.customModel,
        sshRemoteName,
      };
    });
  });

  // Set up callback for group chat router to lookup custom env vars for agents
  setGetCustomEnvVarsCallback(getCustomEnvVarsForAgent);
  setGetAgentConfigCallback(getAgentConfigForAgent);

  // Setup logger event forwarding to renderer
  setupLoggerEventForwarding(() => mainWindow);

  // File system operations
  ipcMain.handle('fs:homeDir', () => {
    return os.homedir();
  });

  ipcMain.handle('fs:readDir', async (_, dirPath: string, sshRemoteId?: string) => {
    // SSH remote: dispatch to remote fs operations
    if (sshRemoteId) {
      const sshConfig = getSshRemoteById(sshRemoteId);
      if (!sshConfig) {
        throw new Error(`SSH remote not found: ${sshRemoteId}`);
      }
      const result = await readDirRemote(dirPath, sshConfig);
      if (!result.success) {
        throw new Error(result.error || 'Failed to read remote directory');
      }
      // Map remote entries to match local format (isFile derived from !isDirectory && !isSymlink)
      // Include full path for recursive directory scanning (e.g., document graph)
      // Use POSIX path joining for remote paths (always forward slashes)
      return result.data!.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: !entry.isDirectory && !entry.isSymlink,
        path: dirPath.endsWith('/') ? `${dirPath}${entry.name}` : `${dirPath}/${entry.name}`,
      }));
    }

    // Local: use standard fs operations
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Convert Dirent objects to plain objects for IPC serialization
    // Include full path for recursive directory scanning (e.g., document graph)
    return entries.map((entry: any) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      path: path.join(dirPath, entry.name),
    }));
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string, sshRemoteId?: string) => {
    try {
      // SSH remote: dispatch to remote fs operations
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }
        const result = await readFileRemote(filePath, sshConfig);
        if (!result.success) {
          throw new Error(result.error || 'Failed to read remote file');
        }
        // For images over SSH, we'd need to base64 encode on remote and decode here
        // For now, return raw content (text files work, binary images may have issues)
        const ext = filePath.split('.').pop()?.toLowerCase();
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
        const isImage = imageExtensions.includes(ext || '');
        if (isImage) {
          // The remote readFile returns raw bytes as string - convert to base64 data URL
          const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
          const base64 = Buffer.from(result.data!, 'binary').toString('base64');
          return `data:${mimeType};base64,${base64}`;
        }
        return result.data!;
      }

      // Local: use standard fs operations
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

  ipcMain.handle('fs:stat', async (_, filePath: string, sshRemoteId?: string) => {
    try {
      // SSH remote: dispatch to remote fs operations
      if (sshRemoteId) {
        const sshConfig = getSshRemoteById(sshRemoteId);
        if (!sshConfig) {
          throw new Error(`SSH remote not found: ${sshRemoteId}`);
        }
        const result = await statRemote(filePath, sshConfig);
        if (!result.success) {
          throw new Error(result.error || 'Failed to get remote file stats');
        }
        // Map remote stat result to match local format
        // Note: remote stat doesn't provide createdAt (birthtime), use mtime as fallback
        const mtimeDate = new Date(result.data!.mtime);
        return {
          size: result.data!.size,
          createdAt: mtimeDate.toISOString(), // Fallback: use mtime for createdAt
          modifiedAt: mtimeDate.toISOString(),
          isDirectory: result.data!.isDirectory,
          isFile: !result.data!.isDirectory,
        };
      }

      // Local: use standard fs operations
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

  // Calculate total size of a directory recursively
  // Respects the same ignore patterns as loadFileTree (node_modules, __pycache__)
  ipcMain.handle('fs:directorySize', async (_, dirPath: string, sshRemoteId?: string) => {
    // SSH remote: dispatch to remote fs operations
    if (sshRemoteId) {
      const sshConfig = getSshRemoteById(sshRemoteId);
      if (!sshConfig) {
        throw new Error(`SSH remote not found: ${sshRemoteId}`);
      }
      const result = await directorySizeRemote(dirPath, sshConfig);
      if (!result.success) {
        throw new Error(result.error || 'Failed to get remote directory size');
      }
      // Remote directorySizeRemote only returns totalSize (via du -sb)
      // File/folder counts are not available without recursive listing
      return {
        totalSize: result.data!,
        fileCount: 0, // Not available from remote du command
        folderCount: 0, // Not available from remote du command
      };
    }

    // Local: use standard fs operations
    let totalSize = 0;
    let fileCount = 0;
    let folderCount = 0;

    const calculateSize = async (currentPath: string, depth: number = 0): Promise<void> => {
      // Limit recursion depth to match file tree loading
      if (depth >= 10) return;

      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          // Skip common ignore patterns (same as loadFileTree)
          if (entry.name === 'node_modules' || entry.name === '__pycache__') {
            continue;
          }

          const fullPath = path.join(currentPath, entry.name);

          if (entry.isDirectory()) {
            folderCount++;
            await calculateSize(fullPath, depth + 1);
          } else if (entry.isFile()) {
            fileCount++;
            try {
              const stats = await fs.stat(fullPath);
              totalSize += stats.size;
            } catch {
              // Skip files we can't stat (permissions, etc.)
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    await calculateSize(dirPath);

    return {
      totalSize,
      fileCount,
      folderCount
    };
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to write file: ${error}`);
    }
  });

  // Fetch image from URL and return as base64 data URL (avoids CORS issues)
  ipcMain.handle('fs:fetchImageAsBase64', async (_, url: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString('base64');
      // Determine mime type from content-type header or URL
      const contentType = response.headers.get('content-type') || 'image/png';
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      // Return null on failure - let caller handle gracefully
      logger.warn(`Failed to fetch image from ${url}: ${error}`, 'fs:fetchImageAsBase64');
      return null;
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
        // Handle stdin errors (EPIPE if process terminates before write completes)
        child.stdin.on('error', (err) => {
          const errorCode = (err as NodeJS.ErrnoException).code;
          if (errorCode === 'EPIPE') {
            logger.debug('TTS stdin EPIPE - process closed before write completed', 'TTS');
          } else {
            logger.error('TTS stdin error', 'TTS', { error: String(err), code: errorCode });
          }
        });
        console.log('[TTS Main] Writing to stdin:', text);
        child.stdin.write(text, 'utf8', (err) => {
          if (err) {
            console.error('[TTS Main] stdin write error:', err);
          } else {
            console.log('[TTS Main] stdin write completed, ending stream');
          }
          child.stdin!.end();
        });
      } else {
        console.error('[TTS Main] No stdin available on child process');
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

      child.on('close', (code, signal) => {
        console.log('[TTS Main] Process exited with code:', code, 'signal:', signal);
        // Always log close event for debugging production issues
        logger.info('TTS process closed', 'TTS', {
          ttsId,
          exitCode: code,
          signal,
          stderr: stderrOutput || '(none)',
          command: fullCommand,
        });
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
        // Delta mode for multi-device aggregation
        deltaMs?: number;     // Time in milliseconds to ADD to server-side cumulative total
        deltaRuns?: number;   // Number of runs to ADD to server-side total runs count
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
      // Server-side totals for multi-device sync
      serverTotals?: {
        cumulativeTimeMs: number;
        totalRuns: number;
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
          // Server-side totals for multi-device sync
          serverTotals?: {
            cumulativeTimeMs: number;
            totalRuns: number;
          };
        };

        if (response.ok) {
          logger.info('Leaderboard submission successful', 'Leaderboard', {
            pendingEmailConfirmation: result.pendingEmailConfirmation,
            ranking: result.ranking,
            serverTotals: result.serverTotals,
          });
          return {
            success: true,
            message: result.message || 'Submission received',
            pendingEmailConfirmation: result.pendingEmailConfirmation,
            ranking: result.ranking,
            serverTotals: result.serverTotals,
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

  // Resend confirmation email (self-service auth token recovery)
  ipcMain.handle(
    'leaderboard:resendConfirmation',
    async (
      _event,
      data: {
        email: string;
        clientToken: string;
      }
    ): Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }> => {
      try {
        logger.info('Requesting leaderboard confirmation resend', 'Leaderboard', {
          email: data.email.substring(0, 3) + '***',
        });

        const response = await fetch('https://runmaestro.ai/api/m4estr0/resend-confirmation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Maestro/${app.getVersion()}`,
          },
          body: JSON.stringify({
            email: data.email,
            clientToken: data.clientToken,
          }),
        });

        const result = await response.json() as {
          success?: boolean;
          message?: string;
          error?: string;
        };

        if (response.ok && result.success) {
          logger.info('Leaderboard confirmation email resent', 'Leaderboard');
          return {
            success: true,
            message: result.message || 'Confirmation email sent. Please check your inbox.',
          };
        } else {
          return {
            success: false,
            error: result.error || result.message || `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error resending leaderboard confirmation', 'Leaderboard', error);
        return {
          success: false,
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

  // Sync user stats from server (for new device installations)
  ipcMain.handle(
    'leaderboard:sync',
    async (
      _event,
      data: {
        email: string;
        authToken: string;
      }
    ): Promise<{
      success: boolean;
      found: boolean;
      message?: string;
      error?: string;
      errorCode?: 'EMAIL_NOT_CONFIRMED' | 'INVALID_TOKEN' | 'MISSING_FIELDS';
      data?: {
        displayName: string;
        badgeLevel: number;
        badgeName: string;
        cumulativeTimeMs: number;
        totalRuns: number;
        longestRunMs: number | null;
        longestRunDate: string | null;
        keyboardLevel: number | null;
        coveragePercent: number | null;
        ranking: {
          cumulative: { rank: number; total: number };
          longestRun: { rank: number; total: number } | null;
        };
      };
    }> => {
      try {
        logger.info('Syncing leaderboard stats from server', 'Leaderboard', {
          email: data.email.substring(0, 3) + '***',
        });

        const response = await fetch('https://runmaestro.ai/api/m4estr0/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `Maestro/${app.getVersion()}`,
          },
          body: JSON.stringify({
            email: data.email,
            authToken: data.authToken,
          }),
        });

        const result = await response.json() as {
          success: boolean;
          found?: boolean;
          message?: string;
          error?: string;
          errorCode?: string;
          data?: {
            displayName: string;
            badgeLevel: number;
            badgeName: string;
            cumulativeTimeMs: number;
            totalRuns: number;
            longestRunMs: number | null;
            longestRunDate: string | null;
            keyboardLevel: number | null;
            coveragePercent: number | null;
            ranking: {
              cumulative: { rank: number; total: number };
              longestRun: { rank: number; total: number } | null;
            };
          };
        };

        if (response.ok && result.success) {
          if (result.found && result.data) {
            logger.info('Leaderboard sync successful', 'Leaderboard', {
              badgeLevel: result.data.badgeLevel,
              cumulativeTimeMs: result.data.cumulativeTimeMs,
            });
            return {
              success: true,
              found: true,
              data: result.data,
            };
          } else {
            logger.info('Leaderboard sync: user not found', 'Leaderboard');
            return {
              success: true,
              found: false,
              message: result.message || 'No existing registration found',
            };
          }
        } else if (response.status === 401) {
          logger.warn('Leaderboard sync: invalid token', 'Leaderboard');
          return {
            success: false,
            found: false,
            error: result.error || 'Invalid authentication token',
            errorCode: 'INVALID_TOKEN',
          };
        } else if (response.status === 403) {
          logger.warn('Leaderboard sync: email not confirmed', 'Leaderboard');
          return {
            success: false,
            found: false,
            error: result.error || 'Email not yet confirmed',
            errorCode: 'EMAIL_NOT_CONFIRMED',
          };
        } else if (response.status === 400) {
          return {
            success: false,
            found: false,
            error: result.error || 'Missing required fields',
            errorCode: 'MISSING_FIELDS',
          };
        } else {
          return {
            success: false,
            found: false,
            error: result.error || `Server error: ${response.status}`,
          };
        }
      } catch (error) {
        logger.error('Error syncing from leaderboard server', 'Leaderboard', error);
        return {
          success: false,
          found: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );
}

// Buffer for group chat output (keyed by sessionId)
// We buffer output and only route it on process exit to avoid duplicate messages from streaming chunks
const groupChatOutputBuffers = new Map<string, string>();

/**
 * Extract text content from agent JSON output format.
 * Uses the registered output parser for the given agent type.
 * Different agents have different output formats:
 * - Claude: { type: 'result', result: '...' } and { type: 'assistant', message: { content: ... } }
 * - OpenCode: { type: 'text', part: { text: '...' } } and { type: 'step_finish', part: { reason: 'stop' } }
 *
 * @param rawOutput - The raw JSONL output from the agent
 * @param agentType - The agent type (e.g., 'claude-code', 'opencode')
 * @returns Extracted text content
 */
function extractTextFromAgentOutput(rawOutput: string, agentType: string): string {
  const parser = getOutputParser(agentType);

  // If no parser found, try a generic extraction
  if (!parser) {
    logger.warn(`No parser found for agent type '${agentType}', using generic extraction`, '[GroupChat]');
    return extractTextGeneric(rawOutput);
  }

  const lines = rawOutput.split('\n');

  // Check if this looks like JSONL output (first non-empty line starts with '{')
  // If not JSONL, return the raw output as-is (it's already parsed text from process-manager)
  const firstNonEmptyLine = lines.find(line => line.trim());
  if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
    logger.debug(`[GroupChat] Input is not JSONL, returning as plain text (len=${rawOutput.length})`, '[GroupChat]');
    return rawOutput;
  }

  const textParts: string[] = [];
  let resultText: string | null = null;
  let _resultMessageCount = 0;
  let _textMessageCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    const event = parser.parseJsonLine(line);
    if (!event) continue;

    // Extract text based on event type
    if (event.type === 'result' && event.text) {
      // Result message is the authoritative final response - save it
      resultText = event.text;
      _resultMessageCount++;
    }

    if (event.type === 'text' && event.text) {
      textParts.push(event.text);
      _textMessageCount++;
    }
  }

  // Prefer result message if available (it contains the complete formatted response)
  if (resultText) {
    return resultText;
  }

  // Fallback: if no result message, concatenate streaming text parts with newlines
  // to preserve paragraph structure from partial streaming events
  return textParts.join('\n');
}

/**
 * Extract text content from stream-json output (JSONL).
 * Uses the agent-specific parser when the agent type is known.
 */
function extractTextFromStreamJson(rawOutput: string, agentType?: string): string {
  if (agentType) {
    return extractTextFromAgentOutput(rawOutput, agentType);
  }

  return extractTextGeneric(rawOutput);
}

/**
 * Generic text extraction fallback for unknown agent types.
 * Tries common patterns for JSON output.
 */
function extractTextGeneric(rawOutput: string): string {
  const lines = rawOutput.split('\n');

  // Check if this looks like JSONL output (first non-empty line starts with '{')
  // If not JSONL, return the raw output as-is (it's already parsed text)
  const firstNonEmptyLine = lines.find(line => line.trim());
  if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
    return rawOutput;
  }

  const textParts: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line);

      // Try common patterns
      if (msg.result) return msg.result;
      if (msg.text) textParts.push(msg.text);
      if (msg.part?.text) textParts.push(msg.part.text);
      if (msg.message?.content) {
        const content = msg.message.content;
        if (typeof content === 'string') {
          textParts.push(content);
        }
      }
    } catch {
      // Not valid JSON - include raw text if it looks like content
      if (!line.startsWith('{') && !line.includes('session_id') && !line.includes('sessionID')) {
        textParts.push(line);
      }
    }
  }

  // Join with newlines to preserve paragraph structure
  return textParts.join('\n');
}

/**
 * Parses a group chat participant session ID to extract groupChatId and participantName.
 * Handles hyphenated participant names by matching against UUID or timestamp suffixes.
 *
 * Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
 * Examples:
 * - group-chat-abc123-participant-Claude-1702934567890
 * - group-chat-abc123-participant-OpenCode-Ollama-550e8400-e29b-41d4-a716-446655440000
 *
 * @returns null if not a participant session ID, otherwise { groupChatId, participantName }
 */
function parseParticipantSessionId(sessionId: string): { groupChatId: string; participantName: string } | null {
  // First check if this is a participant session ID at all
  if (!sessionId.includes('-participant-')) {
    return null;
  }

  // Try matching with UUID suffix first (36 chars: 8-4-4-4-12 format)
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidMatch = sessionId.match(/^group-chat-(.+)-participant-(.+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (uuidMatch) {
    return { groupChatId: uuidMatch[1], participantName: uuidMatch[2] };
  }

  // Try matching with timestamp suffix (13 digits)
  const timestampMatch = sessionId.match(/^group-chat-(.+)-participant-(.+)-(\d{13,})$/);
  if (timestampMatch) {
    return { groupChatId: timestampMatch[1], participantName: timestampMatch[2] };
  }

  // Fallback: try the old pattern for backwards compatibility (non-hyphenated names)
  const fallbackMatch = sessionId.match(/^group-chat-(.+)-participant-([^-]+)-/);
  if (fallbackMatch) {
    return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
  }

  return null;
}

// Handle process output streaming (set up after initialization)
function setupProcessListeners() {
  if (processManager) {
    processManager.on('data', (sessionId: string, data: string) => {
      // Handle group chat moderator output - buffer it
      // Session ID format: group-chat-{groupChatId}-moderator-{uuid} or group-chat-{groupChatId}-moderator-synthesis-{uuid}
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        console.log(`[GroupChat:Debug] MODERATOR DATA received for chat ${groupChatId}`);
        console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
        console.log(`[GroupChat:Debug] Data length: ${data.length}`);
        // Buffer the output - will be routed on process exit
        const existing = groupChatOutputBuffers.get(sessionId) || '';
        groupChatOutputBuffers.set(sessionId, existing + data);
        console.log(`[GroupChat:Debug] Buffered total: ${(existing + data).length} chars`);
        return; // Don't send to regular process:data handler
      }

      // Handle group chat participant output - buffer it
      // Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
      const participantInfo = parseParticipantSessionId(sessionId);
      if (participantInfo) {
        console.log(`[GroupChat:Debug] PARTICIPANT DATA received`);
        console.log(`[GroupChat:Debug] Chat: ${participantInfo.groupChatId}, Participant: ${participantInfo.participantName}`);
        console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
        console.log(`[GroupChat:Debug] Data length: ${data.length}`);
        // Buffer the output - will be routed on process exit
        const existing = groupChatOutputBuffers.get(sessionId) || '';
        groupChatOutputBuffers.set(sessionId, existing + data);
        console.log(`[GroupChat:Debug] Buffered total: ${(existing + data).length} chars`);
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

        // Don't broadcast background batch/synopsis output to web clients
        // These are internal Auto Run operations that should only appear in history, not as chat messages
        if (sessionId.includes('-batch-') || sessionId.includes('-synopsis-')) {
          console.log(`[WebBroadcast] SKIPPING batch/synopsis output for web: session=${sessionId}`);
          return;
        }

        // Extract base session ID and tab ID from format: {id}-ai-{tabId}
        const baseSessionId = sessionId.replace(/-ai-[^-]+$/, '');
        const isAiOutput = sessionId.includes('-ai-');

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
      // Remove power block reason for this session
      // This allows system sleep when no AI sessions are active
      powerManager.removeBlockReason(`session:${sessionId}`);

      // Handle group chat moderator exit - route buffered output and set state back to idle
      // Session ID format: group-chat-{groupChatId}-moderator-{uuid}
      // This handles BOTH initial moderator responses AND synthesis responses.
      // The routeModeratorResponse function will check for @mentions:
      // - If @mentions present: route to agents (continue conversation)
      // - If no @mentions: final response to user (conversation complete for this turn)
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        console.log(`[GroupChat:Debug] ========== MODERATOR PROCESS EXIT ==========`);
        console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
        console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
        console.log(`[GroupChat:Debug] Exit code: ${code}`);
        logger.debug(`[GroupChat] Moderator exit: groupChatId=${groupChatId}`, 'ProcessListener', { sessionId });
        // Route the buffered output now that process is complete
        const bufferedOutput = groupChatOutputBuffers.get(sessionId);
        console.log(`[GroupChat:Debug] Buffered output length: ${bufferedOutput?.length ?? 0}`);
        if (bufferedOutput) {
          console.log(`[GroupChat:Debug] Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`);
          logger.debug(`[GroupChat] Moderator has buffered output (${bufferedOutput.length} chars)`, 'ProcessListener', { groupChatId });
          void (async () => {
            try {
              const chat = await loadGroupChat(groupChatId);
              console.log(`[GroupChat:Debug] Chat loaded for parsing: ${chat?.name || 'null'}`);
              const agentType = chat?.moderatorAgentId;
              console.log(`[GroupChat:Debug] Agent type for parsing: ${agentType}`);
              const parsedText = extractTextFromStreamJson(bufferedOutput, agentType);
              console.log(`[GroupChat:Debug] Parsed text length: ${parsedText.length}`);
              console.log(`[GroupChat:Debug] Parsed text preview: "${parsedText.substring(0, 300)}${parsedText.length > 300 ? '...' : ''}"`);
              if (parsedText.trim()) {
                console.log(`[GroupChat:Debug] Routing moderator response...`);
                logger.info(`[GroupChat] Routing moderator response (${parsedText.length} chars)`, 'ProcessListener', { groupChatId });
                const readOnly = getGroupChatReadOnlyState(groupChatId);
                console.log(`[GroupChat:Debug] Read-only state: ${readOnly}`);
                routeModeratorResponse(groupChatId, parsedText, processManager ?? undefined, agentDetector ?? undefined, readOnly).catch(err => {
                  console.error(`[GroupChat:Debug] ERROR routing moderator response:`, err);
                  logger.error('[GroupChat] Failed to route moderator response', 'ProcessListener', { error: String(err) });
                });
              } else {
                console.log(`[GroupChat:Debug] WARNING: Parsed text is empty!`);
                logger.warn('[GroupChat] Moderator output parsed to empty string', 'ProcessListener', { groupChatId, bufferedLength: bufferedOutput.length });
              }
            } catch (err) {
              console.error(`[GroupChat:Debug] ERROR loading chat:`, err);
              logger.error('[GroupChat] Failed to load chat for moderator output parsing', 'ProcessListener', { error: String(err) });
              const parsedText = extractTextFromStreamJson(bufferedOutput);
              if (parsedText.trim()) {
                const readOnly = getGroupChatReadOnlyState(groupChatId);
                routeModeratorResponse(groupChatId, parsedText, processManager ?? undefined, agentDetector ?? undefined, readOnly).catch(routeErr => {
                  console.error(`[GroupChat:Debug] ERROR routing moderator response (fallback):`, routeErr);
                  logger.error('[GroupChat] Failed to route moderator response', 'ProcessListener', { error: String(routeErr) });
                });
              }
            }
          })().finally(() => {
            groupChatOutputBuffers.delete(sessionId);
            console.log(`[GroupChat:Debug] Cleared output buffer for session`);
          });
        } else {
          console.log(`[GroupChat:Debug] WARNING: No buffered output!`);
          logger.warn('[GroupChat] Moderator exit with no buffered output', 'ProcessListener', { groupChatId, sessionId });
        }
        groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
        console.log(`[GroupChat:Debug] Emitted state change: idle`);
        console.log(`[GroupChat:Debug] =============================================`);
        // Don't send to regular exit handler
        return;
      }

      // Handle group chat participant exit - route buffered output and update participant state
      // Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
      const participantExitInfo = parseParticipantSessionId(sessionId);
      if (participantExitInfo) {
        const { groupChatId, participantName } = participantExitInfo;
        console.log(`[GroupChat:Debug] ========== PARTICIPANT PROCESS EXIT ==========`);
        console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
        console.log(`[GroupChat:Debug] Participant: ${participantName}`);
        console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
        console.log(`[GroupChat:Debug] Exit code: ${code}`);
        logger.debug(`[GroupChat] Participant exit: ${participantName} (groupChatId=${groupChatId})`, 'ProcessListener', { sessionId });

        // Emit participant state change to show this participant is done working
        groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'idle');
        console.log(`[GroupChat:Debug] Emitted participant state: idle`);

        // Route the buffered output now that process is complete
        // IMPORTANT: We must wait for the response to be logged before triggering synthesis
        // to avoid a race condition where synthesis reads the log before the response is written
        const bufferedOutput = groupChatOutputBuffers.get(sessionId);
        console.log(`[GroupChat:Debug] Buffered output length: ${bufferedOutput?.length ?? 0}`);

        // Helper function to mark participant and potentially trigger synthesis
        const markAndMaybeSynthesize = () => {
          const isLastParticipant = markParticipantResponded(groupChatId, participantName);
          console.log(`[GroupChat:Debug] Is last participant to respond: ${isLastParticipant}`);
          if (isLastParticipant && processManager && agentDetector) {
            // All participants have responded - spawn moderator synthesis round
            console.log(`[GroupChat:Debug] All participants responded - spawning synthesis round...`);
            logger.info('[GroupChat] All participants responded, spawning moderator synthesis', 'ProcessListener', { groupChatId });
            spawnModeratorSynthesis(groupChatId, processManager, agentDetector).catch(err => {
              console.error(`[GroupChat:Debug] ERROR spawning synthesis:`, err);
              logger.error('[GroupChat] Failed to spawn moderator synthesis', 'ProcessListener', { error: String(err), groupChatId });
            });
          } else if (!isLastParticipant) {
            // More participants pending
            console.log(`[GroupChat:Debug] Waiting for more participants to respond...`);
          }
        };

        if (bufferedOutput) {
          console.log(`[GroupChat:Debug] Raw buffered output preview: "${bufferedOutput.substring(0, 300)}${bufferedOutput.length > 300 ? '...' : ''}"`);

          // Handle session recovery and normal processing in an async IIFE
          void (async () => {
            // Check if this is a session_not_found error - if so, recover and retry
            const chat = await loadGroupChat(groupChatId);
            const agentType = chat?.participants.find(p => p.name === participantName)?.agentId;

            if (needsSessionRecovery(bufferedOutput, agentType)) {
              console.log(`[GroupChat:Debug] Session not found error detected for ${participantName} - initiating recovery`);
              logger.info('[GroupChat] Session recovery needed', 'ProcessListener', { groupChatId, participantName });

              // Clear the buffer first
              groupChatOutputBuffers.delete(sessionId);

              // Initiate recovery (clears agentSessionId)
              await initiateSessionRecovery(groupChatId, participantName);

              // Re-spawn the participant with recovery context
              if (processManager && agentDetector) {
                console.log(`[GroupChat:Debug] Re-spawning ${participantName} with recovery context...`);
                try {
                  await respawnParticipantWithRecovery(
                    groupChatId,
                    participantName,
                    processManager,
                    agentDetector
                  );
                  console.log(`[GroupChat:Debug] Successfully re-spawned ${participantName} for recovery`);
                  // Don't mark as responded yet - the recovery spawn will complete and trigger this
                } catch (respawnErr) {
                  console.error(`[GroupChat:Debug] Failed to respawn ${participantName}:`, respawnErr);
                  logger.error('[GroupChat] Failed to respawn participant for recovery', 'ProcessListener', {
                    error: String(respawnErr),
                    participant: participantName,
                  });
                  // Mark as responded since recovery failed
                  markAndMaybeSynthesize();
                }
              } else {
                console.log(`[GroupChat:Debug] Cannot respawn - processManager or agentDetector not available`);
                markAndMaybeSynthesize();
              }
              console.log(`[GroupChat:Debug] ===============================================`);
              return;
            }

            // Normal processing - parse and route the response
            try {
              console.log(`[GroupChat:Debug] Chat loaded for participant parsing: ${chat?.name || 'null'}`);
              console.log(`[GroupChat:Debug] Agent type for parsing: ${agentType}`);
              const parsedText = extractTextFromStreamJson(bufferedOutput, agentType);
              console.log(`[GroupChat:Debug] Parsed text length: ${parsedText.length}`);
              console.log(`[GroupChat:Debug] Parsed text preview: "${parsedText.substring(0, 200)}${parsedText.length > 200 ? '...' : ''}"`);
              if (parsedText.trim()) {
                console.log(`[GroupChat:Debug] Routing agent response from ${participantName}...`);
                // Await the response logging before marking participant as responded
                await routeAgentResponse(groupChatId, participantName, parsedText, processManager ?? undefined);
                console.log(`[GroupChat:Debug] Successfully routed agent response from ${participantName}`);
              } else {
                console.log(`[GroupChat:Debug] WARNING: Parsed text is empty for ${participantName}!`);
              }
            } catch (err) {
              console.error(`[GroupChat:Debug] ERROR loading chat for participant:`, err);
              logger.error('[GroupChat] Failed to load chat for participant output parsing', 'ProcessListener', { error: String(err), participant: participantName });
              try {
                const parsedText = extractTextFromStreamJson(bufferedOutput);
                if (parsedText.trim()) {
                  await routeAgentResponse(groupChatId, participantName, parsedText, processManager ?? undefined);
                }
              } catch (routeErr) {
                console.error(`[GroupChat:Debug] ERROR routing agent response (fallback):`, routeErr);
                logger.error('[GroupChat] Failed to route agent response', 'ProcessListener', { error: String(routeErr), participant: participantName });
              }
            }
          })().finally(() => {
            groupChatOutputBuffers.delete(sessionId);
            console.log(`[GroupChat:Debug] Cleared output buffer for participant session`);
            // Mark participant and trigger synthesis AFTER logging is complete
            markAndMaybeSynthesize();
          });
        } else {
          console.log(`[GroupChat:Debug] WARNING: No buffered output for participant ${participantName}!`);
          // No output to log, so mark participant as responded immediately
          markAndMaybeSynthesize();
        }
        console.log(`[GroupChat:Debug] ===============================================`);
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
      // Handle group chat participant session ID - store the agent's session ID
      // Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
      const participantSessionInfo = parseParticipantSessionId(sessionId);
      if (participantSessionInfo) {
        const { groupChatId, participantName } = participantSessionInfo;
        // Update the participant with the agent's session ID
        updateParticipant(groupChatId, participantName, { agentSessionId }).then(async () => {
          // Emit participants changed so UI updates with the new session ID
          const chat = await loadGroupChat(groupChatId);
          if (chat) {
            groupChatEmitters.emitParticipantsChanged?.(groupChatId, chat.participants);
          }
        }).catch(err => {
          logger.error('[GroupChat] Failed to update participant agentSessionId', 'ProcessListener', { error: String(err), participant: participantName });
        });
        // Don't return - still send to renderer for logging purposes
      }

      // Handle group chat moderator session ID - store the real agent session ID
      // Session ID format: group-chat-{groupChatId}-moderator-{timestamp}
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-\d+$/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        // Update the group chat with the moderator's real agent session ID
        // Store in moderatorAgentSessionId (not moderatorSessionId which is the routing prefix)
        updateGroupChat(groupChatId, { moderatorAgentSessionId: agentSessionId }).then(() => {
          // Emit session ID change event so UI updates with the new session ID
          groupChatEmitters.emitModeratorSessionIdChanged?.(groupChatId, agentSessionId);
        }).catch((err: unknown) => {
          logger.error('[GroupChat] Failed to update moderator agent session ID', 'ProcessListener', { error: String(err), groupChatId });
        });
        // Don't return - still send to renderer for logging purposes
      }

      mainWindow?.webContents.send('process:session-id', sessionId, agentSessionId);
    });

    // Handle slash commands from Claude Code init message
    processManager.on('slash-commands', (sessionId: string, slashCommands: string[]) => {
      mainWindow?.webContents.send('process:slash-commands', sessionId, slashCommands);
    });

    // Handle thinking/streaming content chunks from AI agents
    // Emitted when agents produce partial text events (isPartial: true)
    // Renderer decides whether to display based on tab's showThinking setting
    processManager.on('thinking-chunk', (sessionId: string, content: string) => {
      mainWindow?.webContents.send('process:thinking-chunk', sessionId, content);
    });

    // Handle tool execution events (OpenCode, Codex)
    processManager.on('tool-execution', (sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => {
      mainWindow?.webContents.send('process:tool-execution', sessionId, toolEvent);
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
      // Handle group chat participant usage - update participant stats
      const participantUsageInfo = parseParticipantSessionId(sessionId);
      if (participantUsageInfo) {
        const { groupChatId, participantName } = participantUsageInfo;

        // Calculate context usage percentage
        const totalTokens = usageStats.inputTokens + usageStats.outputTokens;
        const contextUsage = usageStats.contextWindow > 0
          ? Math.round((totalTokens / usageStats.contextWindow) * 100)
          : 0;

        // Update participant with usage stats
        updateParticipant(groupChatId, participantName, {
          contextUsage,
          tokenCount: totalTokens,
          totalCost: usageStats.totalCostUsd,
        }).then(async () => {
          // Emit participants changed so UI updates
          const chat = await loadGroupChat(groupChatId);
          if (chat) {
            groupChatEmitters.emitParticipantsChanged?.(groupChatId, chat.participants);
          }
        }).catch(err => {
          logger.error('[GroupChat] Failed to update participant usage', 'ProcessListener', {
            error: String(err),
            participant: participantName,
          });
        });
        // Still send to renderer for consistency
      }

      // Handle group chat moderator usage - emit for UI
      const moderatorMatch = sessionId.match(/^group-chat-(.+)-moderator-/);
      if (moderatorMatch) {
        const groupChatId = moderatorMatch[1];
        // Calculate context usage percentage for moderator display
        const totalTokens = usageStats.inputTokens + usageStats.outputTokens;
        const contextUsage = usageStats.contextWindow > 0
          ? Math.round((totalTokens / usageStats.contextWindow) * 100)
          : 0;

        // Emit moderator usage for the moderator card
        groupChatEmitters.emitModeratorUsage?.(groupChatId, {
          contextUsage,
          totalCost: usageStats.totalCostUsd,
          tokenCount: totalTokens,
        });
      }

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

    // Handle query-complete events for stats tracking
    // This is emitted when a batch mode AI query completes (user or auto)
    processManager.on('query-complete', (_sessionId: string, queryData: {
      sessionId: string;
      agentType: string;
      source: 'user' | 'auto';
      startTime: number;
      duration: number;
      projectPath?: string;
      tabId?: string;
    }) => {
      try {
        const db = getStatsDB();
        if (db.isReady()) {
          const id = db.insertQueryEvent({
            sessionId: queryData.sessionId,
            agentType: queryData.agentType,
            source: queryData.source,
            startTime: queryData.startTime,
            duration: queryData.duration,
            projectPath: queryData.projectPath,
            tabId: queryData.tabId,
          });
          logger.debug(`Recorded query event: ${id}`, '[Stats]', {
            sessionId: queryData.sessionId,
            agentType: queryData.agentType,
            source: queryData.source,
            duration: queryData.duration,
          });
          // Broadcast stats update to renderer for real-time dashboard refresh
          mainWindow?.webContents.send('stats:updated');
        }
      } catch (error) {
        logger.error(`Failed to record query event: ${error}`, '[Stats]', {
          sessionId: queryData.sessionId,
        });
      }
    });
  }
}
