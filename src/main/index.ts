import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { SessionWebServerManager } from './session-web-server';
import { AgentDetector } from './agent-detector';
import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
import { detectShells } from './utils/shellDetector';
import { getThemeById } from './themes';
import Store from 'electron-store';

// Type definitions
interface MaestroSettings {
  activeThemeId: string;
  llmProvider: string;
  modelSlug: string;
  apiKey: string;
  tunnelProvider: string;
  tunnelApiKey: string;
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
    tunnelProvider: 'ngrok',
    tunnelApiKey: '',
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
let sessionWebServerManager: SessionWebServerManager | null = null;
let agentDetector: AgentDetector | null = null;

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
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
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
  webServer = new WebServer(8000);
  agentDetector = new AgentDetector();

  // Initialize web server auth from stored settings
  const webAuthEnabled = store.get('webAuthEnabled', false);
  const webAuthToken = store.get('webAuthToken', null);
  webServer.setAuthConfig({
    enabled: webAuthEnabled,
    token: webAuthToken,
  });
  logger.info(`Web server auth initialized: enabled=${webAuthEnabled}`, 'WebServer');

  // Set up callback for web server to fetch sessions list
  webServer.setGetSessionsCallback(() => {
    const sessions = sessionsStore.get('sessions', []);
    return sessions.map((s: any) => ({
      id: s.id,
      name: s.name,
      toolType: s.toolType,
      state: s.state,
      inputMode: s.inputMode,
      cwd: s.cwd,
    }));
  });

  // Set up callback for web server to fetch single session details
  webServer.setGetSessionDetailCallback((sessionId: string) => {
    const sessions = sessionsStore.get('sessions', []);
    const session = sessions.find((s: any) => s.id === sessionId);
    if (!session) return null;
    return {
      id: session.id,
      name: session.name,
      toolType: session.toolType,
      state: session.state,
      inputMode: session.inputMode,
      cwd: session.cwd,
      aiLogs: session.aiLogs || [],
      shellLogs: session.shellLogs || [],
      usageStats: session.usageStats,
      claudeSessionId: session.claudeSessionId,
      isGitRepo: session.isGitRepo,
    };
  });

  // Set up callback for web server to fetch current theme
  webServer.setGetThemeCallback(() => {
    const themeId = store.get('activeThemeId', 'dracula');
    return getThemeById(themeId);
  });

  // Initialize session web server manager with callbacks
  sessionWebServerManager = new SessionWebServerManager(
    // getSessionData callback - fetch session from store
    (sessionId: string) => {
      const sessions = sessionsStore.get('sessions', []);
      const session = sessions.find((s: any) => s.id === sessionId);
      if (!session) return null;
      return {
        id: session.id,
        name: session.name,
        toolType: session.toolType,
        state: session.state,
        inputMode: session.inputMode,
        cwd: session.cwd,
        aiLogs: session.aiLogs || [],
        shellLogs: session.shellLogs || [],
      };
    },
    // writeToSession callback - write to process
    (sessionId: string, data: string) => {
      if (!processManager) return false;
      return processManager.write(sessionId, data);
    }
  );
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

  // Start web server for remote access
  logger.info('Starting web server on port 8000', 'WebServer');
  webServer.start();

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
  // Clean up all running processes
  logger.info('Killing all running processes', 'Shutdown');
  processManager?.killAll();
  logger.info('Stopping session web servers', 'Shutdown');
  await sessionWebServerManager?.stopAll();
  logger.info('Stopping web server', 'Shutdown');
  webServer?.stop();
  logger.info('Shutdown complete', 'Shutdown');
});

function setupIpcHandlers() {
  // Settings management
  ipcMain.handle('settings:get', async (_, key: string) => {
    const value = store.get(key);
    logger.debug(`Settings read: ${key}`, 'Settings', { key, value });
    return value;
  });

  ipcMain.handle('settings:set', async (_, key: string, value: any) => {
    store.set(key, value);
    logger.info(`Settings updated: ${key}`, 'Settings', { key, value });

    // Broadcast theme changes to connected web clients
    if (key === 'activeThemeId' && webServer && webServer.getWebClientCount() > 0) {
      const theme = getThemeById(value);
      if (theme) {
        webServer.broadcastThemeChange(theme);
        logger.info(`Broadcasted theme change to web clients: ${value}`, 'WebServer');
      }
    }

    return true;
  });

  ipcMain.handle('settings:getAll', async () => {
    const settings = store.store;
    logger.debug('All settings retrieved', 'Settings', { count: Object.keys(settings).length });
    return settings;
  });

  // Sessions persistence
  ipcMain.handle('sessions:getAll', async () => {
    return sessionsStore.get('sessions', []);
  });

  ipcMain.handle('sessions:setAll', async (_, sessions: any[]) => {
    // Get previous sessions to detect changes
    const previousSessions = sessionsStore.get('sessions', []);
    const previousSessionMap = new Map(previousSessions.map((s: any) => [s.id, s]));
    const currentSessionMap = new Map(sessions.map((s: any) => [s.id, s]));

    // Detect and broadcast changes to web clients
    if (webServer && webServer.getWebClientCount() > 0) {
      // Check for state changes in existing sessions
      for (const session of sessions) {
        const prevSession = previousSessionMap.get(session.id);
        if (prevSession) {
          // Session exists - check if state changed
          if (prevSession.state !== session.state ||
              prevSession.inputMode !== session.inputMode ||
              prevSession.name !== session.name) {
            webServer.broadcastSessionStateChange(session.id, session.state, {
              name: session.name,
              toolType: session.toolType,
              inputMode: session.inputMode,
              cwd: session.cwd,
            });
          }
        } else {
          // New session added
          webServer.broadcastSessionAdded({
            id: session.id,
            name: session.name,
            toolType: session.toolType,
            state: session.state,
            inputMode: session.inputMode,
            cwd: session.cwd,
          });
        }
      }

      // Check for removed sessions
      for (const prevSession of previousSessions) {
        if (!currentSessionMap.has(prevSession.id)) {
          webServer.broadcastSessionRemoved(prevSession.id);
        }
      }
    }

    sessionsStore.set('sessions', sessions);
    return true;
  });

  // Groups persistence
  ipcMain.handle('groups:getAll', async () => {
    return groupsStore.get('groups', []);
  });

  ipcMain.handle('groups:setAll', async (_, groups: any[]) => {
    groupsStore.set('groups', groups);
    return true;
  });

  // Session/Process management
  ipcMain.handle('process:spawn', async (_, config: {
    sessionId: string;
    toolType: string;
    cwd: string;
    command: string;
    args: string[];
    prompt?: string;
    shell?: string;
    images?: string[]; // Base64 data URLs for images
  }) => {
    if (!processManager) throw new Error('Process manager not initialized');
    if (!agentDetector) throw new Error('Agent detector not initialized');

    // Get agent definition to access config options
    const agent = await agentDetector.getAgent(config.toolType);
    let finalArgs = [...config.args];

    // Build additional args from agent configuration
    if (agent && agent.configOptions) {
      const agentConfig = agentConfigsStore.get('configs', {})[config.toolType] || {};

      for (const option of agent.configOptions) {
        if (option.argBuilder) {
          // Get config value, fallback to default
          const value = agentConfig[option.key] !== undefined
            ? agentConfig[option.key]
            : option.default;

          // Build args from this config value
          const additionalArgs = option.argBuilder(value);
          finalArgs = [...finalArgs, ...additionalArgs];
        }
      }
    }

    // If no shell is specified and this is a terminal session, use the default shell from settings
    const shellToUse = config.shell || (config.toolType === 'terminal' ? store.get('defaultShell', 'zsh') : undefined);

    logger.info(`Spawning process: ${config.command}`, 'ProcessManager', {
      sessionId: config.sessionId,
      toolType: config.toolType,
      cwd: config.cwd,
      command: config.command,
      args: finalArgs,
      requiresPty: agent?.requiresPty || false,
      shell: shellToUse
    });

    const result = processManager.spawn({
      ...config,
      args: finalArgs,
      requiresPty: agent?.requiresPty,
      prompt: config.prompt,
      shell: shellToUse
    });

    logger.info(`Process spawned successfully`, 'ProcessManager', {
      sessionId: config.sessionId,
      pid: result.pid
    });
    return result;
  });

  ipcMain.handle('process:write', async (_, sessionId: string, data: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    logger.debug(`Writing to process: ${sessionId}`, 'ProcessManager', { sessionId, dataLength: data.length });
    return processManager.write(sessionId, data);
  });

  ipcMain.handle('process:interrupt', async (_, sessionId: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    logger.info(`Interrupting process: ${sessionId}`, 'ProcessManager', { sessionId });
    return processManager.interrupt(sessionId);
  });

  ipcMain.handle('process:kill', async (_, sessionId: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    logger.info(`Killing process: ${sessionId}`, 'ProcessManager', { sessionId });
    return processManager.kill(sessionId);
  });

  ipcMain.handle('process:resize', async (_, sessionId: string, cols: number, rows: number) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.resize(sessionId, cols, rows);
  });

  // Run a single command and capture only stdout/stderr (no PTY echo/prompts)
  ipcMain.handle('process:runCommand', async (_, config: {
    sessionId: string;
    command: string;
    cwd: string;
    shell?: string;
  }) => {
    if (!processManager) throw new Error('Process manager not initialized');

    // Get the shell from settings if not provided
    // Shell name (e.g., 'zsh') will be resolved to full path in process-manager
    const shell = config.shell || store.get('defaultShell', 'zsh');

    logger.debug(`Running command: ${config.command}`, 'ProcessManager', {
      sessionId: config.sessionId,
      cwd: config.cwd,
      shell
    });

    return processManager.runCommand(
      config.sessionId,
      config.command,
      config.cwd,
      shell
    );
  });

  // Git operations
  ipcMain.handle('git:status', async (_, cwd: string) => {
    const result = await execFileNoThrow('git', ['status', '--porcelain'], cwd);
    return { stdout: result.stdout, stderr: result.stderr };
  });

  ipcMain.handle('git:diff', async (_, cwd: string, file?: string) => {
    const args = file ? ['diff', file] : ['diff'];
    const result = await execFileNoThrow('git', args, cwd);
    return { stdout: result.stdout, stderr: result.stderr };
  });

  ipcMain.handle('git:isRepo', async (_, cwd: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    try {
      const result = await execFileNoThrow('git', ['rev-parse', '--is-inside-work-tree'], cwd);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle('git:numstat', async (_, cwd: string) => {
    const result = await execFileNoThrow('git', ['diff', '--numstat'], cwd);
    return { stdout: result.stdout, stderr: result.stderr };
  });

  ipcMain.handle('git:branch', async (_, cwd: string) => {
    const result = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return { stdout: result.stdout.trim(), stderr: result.stderr };
  });

  ipcMain.handle('git:remote', async (_, cwd: string) => {
    const result = await execFileNoThrow('git', ['remote', 'get-url', 'origin'], cwd);
    return { stdout: result.stdout.trim(), stderr: result.stderr };
  });

  ipcMain.handle('git:info', async (_, cwd: string) => {
    // Get comprehensive git info in a single call
    const [branchResult, remoteResult, statusResult, behindAheadResult] = await Promise.all([
      execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      execFileNoThrow('git', ['remote', 'get-url', 'origin'], cwd),
      execFileNoThrow('git', ['status', '--porcelain'], cwd),
      execFileNoThrow('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd)
    ]);

    // Parse behind/ahead counts
    let behind = 0;
    let ahead = 0;
    if (behindAheadResult.exitCode === 0 && behindAheadResult.stdout.trim()) {
      const parts = behindAheadResult.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
    }

    // Count uncommitted changes
    const uncommittedChanges = statusResult.stdout.trim()
      ? statusResult.stdout.trim().split('\n').filter(l => l.length > 0).length
      : 0;

    return {
      branch: branchResult.stdout.trim(),
      remote: remoteResult.stdout.trim(),
      behind,
      ahead,
      uncommittedChanges
    };
  });

  ipcMain.handle('git:log', async (_, cwd: string, options?: { limit?: number; search?: string }) => {
    // Get git log with formatted output for parsing
    // Format: hash|author|date|refs|subject
    const limit = options?.limit || 100;
    const args = [
      'log',
      `--max-count=${limit}`,
      '--pretty=format:%H|%an|%ad|%D|%s',
      '--date=iso-strict'
    ];

    // Add search filter if provided
    if (options?.search) {
      args.push('--all', `--grep=${options.search}`, '-i');
    }

    const result = await execFileNoThrow('git', args, cwd);

    if (result.exitCode !== 0) {
      return { entries: [], error: result.stderr };
    }

    const entries = result.stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [hash, author, date, refs, ...subjectParts] = line.split('|');
        return {
          hash,
          shortHash: hash?.slice(0, 7),
          author,
          date,
          refs: refs ? refs.split(', ').filter(r => r.trim()) : [],
          subject: subjectParts.join('|'), // In case subject contains |
        };
      });

    return { entries, error: null };
  });

  ipcMain.handle('git:show', async (_, cwd: string, hash: string) => {
    // Get the full diff for a specific commit
    const result = await execFileNoThrow('git', ['show', '--stat', '--patch', hash], cwd);
    return { stdout: result.stdout, stderr: result.stderr };
  });

  // File system operations
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

  // Tunnel management - per-session local web server
  ipcMain.handle('tunnel:start', async (_, sessionId: string) => {
    if (!sessionWebServerManager) {
      throw new Error('Session web server manager not initialized');
    }
    logger.info(`Starting tunnel for session ${sessionId}`, 'Tunnel');
    const result = await sessionWebServerManager.startServer(sessionId);
    logger.info(`Tunnel started for session ${sessionId}: ${result.url}`, 'Tunnel');
    return result;
  });

  ipcMain.handle('tunnel:stop', async (_, sessionId: string) => {
    if (!sessionWebServerManager) {
      throw new Error('Session web server manager not initialized');
    }
    logger.info(`Stopping tunnel for session ${sessionId}`, 'Tunnel');
    await sessionWebServerManager.stopServer(sessionId);
    logger.info(`Tunnel stopped for session ${sessionId}`, 'Tunnel');
    return true;
  });

  ipcMain.handle('tunnel:getStatus', async (_, sessionId: string) => {
    if (!sessionWebServerManager) {
      return { active: false };
    }
    return sessionWebServerManager.getStatus(sessionId);
  });

  // Web server management
  ipcMain.handle('webserver:getUrl', async () => {
    return webServer?.getUrl();
  });

  // Web server authentication management
  ipcMain.handle('webserver:getAuthConfig', async () => {
    return webServer?.getAuthConfig() || { enabled: false, token: null };
  });

  ipcMain.handle('webserver:setAuthEnabled', async (_, enabled: boolean) => {
    if (!webServer) throw new Error('Web server not initialized');

    const currentConfig = webServer.getAuthConfig();
    let token = currentConfig.token;

    // Generate a new token if enabling auth and no token exists
    if (enabled && !token) {
      const { WebServer } = await import('./web-server');
      token = WebServer.generateToken();
      store.set('webAuthToken', token);
    }

    webServer.setAuthConfig({ enabled, token });
    store.set('webAuthEnabled', enabled);

    logger.info(`Web server auth ${enabled ? 'enabled' : 'disabled'}`, 'WebServer');
    return { enabled, token };
  });

  ipcMain.handle('webserver:generateNewToken', async () => {
    if (!webServer) throw new Error('Web server not initialized');

    const { WebServer } = await import('./web-server');
    const newToken = WebServer.generateToken();
    const currentConfig = webServer.getAuthConfig();

    webServer.setAuthConfig({ ...currentConfig, token: newToken });
    store.set('webAuthToken', newToken);

    logger.info('Generated new web auth token', 'WebServer');
    return newToken;
  });

  ipcMain.handle('webserver:setAuthToken', async (_, token: string | null) => {
    if (!webServer) throw new Error('Web server not initialized');

    const currentConfig = webServer.getAuthConfig();
    webServer.setAuthConfig({ ...currentConfig, token });
    store.set('webAuthToken', token);

    logger.info('Updated web auth token', 'WebServer');
    return true;
  });

  ipcMain.handle('webserver:getConnectedClients', async () => {
    return webServer?.getWebClientCount() || 0;
  });

  // Helper to strip non-serializable functions from agent configs
  const stripAgentFunctions = (agent: any) => {
    if (!agent) return null;

    return {
      ...agent,
      configOptions: agent.configOptions?.map((opt: any) => {
        const { argBuilder, ...serializableOpt } = opt;
        return serializableOpt;
      })
    };
  };

  // Agent management
  ipcMain.handle('agents:detect', async () => {
    if (!agentDetector) throw new Error('Agent detector not initialized');
    logger.info('Detecting available agents', 'AgentDetector');
    const agents = await agentDetector.detectAgents();
    logger.info(`Detected ${agents.length} agents`, 'AgentDetector', {
      agents: agents.map(a => a.id)
    });
    // Strip argBuilder functions before sending over IPC
    return agents.map(stripAgentFunctions);
  });

  // Refresh agent detection with debug info (clears cache and returns detailed error info)
  ipcMain.handle('agents:refresh', async (_event, agentId?: string) => {
    if (!agentDetector) throw new Error('Agent detector not initialized');

    // Clear the cache to force re-detection
    agentDetector.clearCache();

    // Get environment info for debugging
    const envPath = process.env.PATH || '';
    const homeDir = process.env.HOME || '';

    // Detect all agents fresh
    const agents = await agentDetector.detectAgents();

    // If a specific agent was requested, return detailed debug info
    if (agentId) {
      const agent = agents.find(a => a.id === agentId);
      const command = process.platform === 'win32' ? 'where' : 'which';

      // Try to find the binary manually to get error info
      let debugInfo = {
        agentId,
        available: agent?.available || false,
        path: agent?.path || null,
        binaryName: agent?.binaryName || agentId,
        envPath,
        homeDir,
        platform: process.platform,
        whichCommand: command,
        error: null as string | null,
      };

      if (!agent?.available) {
        // Try running which/where to get error output
        const result = await execFileNoThrow(command, [agent?.binaryName || agentId]);
        debugInfo.error = result.exitCode !== 0
          ? `${command} ${agent?.binaryName || agentId} failed (exit code ${result.exitCode}): ${result.stderr || 'Binary not found in PATH'}`
          : null;
      }

      logger.info(`Agent refresh debug info for ${agentId}`, 'AgentDetector', debugInfo);
      return { agents: agents.map(stripAgentFunctions), debugInfo };
    }

    logger.info(`Refreshed agent detection`, 'AgentDetector', {
      agents: agents.map(a => ({ id: a.id, available: a.available, path: a.path }))
    });
    return { agents: agents.map(stripAgentFunctions), debugInfo: null };
  });

  ipcMain.handle('agents:get', async (_event, agentId: string) => {
    if (!agentDetector) throw new Error('Agent detector not initialized');
    logger.debug(`Getting agent: ${agentId}`, 'AgentDetector');
    const agent = await agentDetector.getAgent(agentId);
    // Strip argBuilder functions before sending over IPC
    return stripAgentFunctions(agent);
  });

  // Agent configuration management
  ipcMain.handle('agents:getConfig', async (_event, agentId: string) => {
    const allConfigs = agentConfigsStore.get('configs', {});
    return allConfigs[agentId] || {};
  });

  ipcMain.handle('agents:setConfig', async (_event, agentId: string, config: Record<string, any>) => {
    const allConfigs = agentConfigsStore.get('configs', {});
    allConfigs[agentId] = config;
    agentConfigsStore.set('configs', allConfigs);
    logger.info(`Updated config for agent: ${agentId}`, 'AgentConfig', config);
    return true;
  });

  ipcMain.handle('agents:getConfigValue', async (_event, agentId: string, key: string) => {
    const allConfigs = agentConfigsStore.get('configs', {});
    const agentConfig = allConfigs[agentId] || {};
    return agentConfig[key];
  });

  ipcMain.handle('agents:setConfigValue', async (_event, agentId: string, key: string, value: any) => {
    const allConfigs = agentConfigsStore.get('configs', {});
    if (!allConfigs[agentId]) {
      allConfigs[agentId] = {};
    }
    allConfigs[agentId][key] = value;
    agentConfigsStore.set('configs', allConfigs);
    logger.debug(`Updated config ${key} for agent ${agentId}`, 'AgentConfig', { value });
    return true;
  });

  // Folder selection dialog
  ipcMain.handle('dialog:selectFolder', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // Font detection
  ipcMain.handle('fonts:detect', async () => {
    try {
      // Use fc-list on all platforms (faster than system_profiler on macOS)
      // macOS: 0.74s (was 8.77s with system_profiler) - 11.9x faster
      // Linux/Windows: 0.5-0.6s
      const result = await execFileNoThrow('fc-list', [':', 'family']);

      if (result.exitCode === 0 && result.stdout) {
        // Parse font list and deduplicate
        const fonts = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line: string) => line.trim())
          .filter(font => font.length > 0);

        // Deduplicate fonts (fc-list can return duplicates)
        return [...new Set(fonts)];
      }

      // Fallback if fc-list not available (rare on modern systems)
      return ['Monaco', 'Menlo', 'Courier New', 'Consolas', 'Roboto Mono', 'Fira Code', 'JetBrains Mono'];
    } catch (error) {
      console.error('Font detection error:', error);
      // Return common monospace fonts as fallback
      return ['Monaco', 'Menlo', 'Courier New', 'Consolas', 'Roboto Mono', 'Fira Code', 'JetBrains Mono'];
    }
  });

  // Shell detection
  ipcMain.handle('shells:detect', async () => {
    try {
      logger.info('Detecting available shells', 'ShellDetector');
      const shells = await detectShells();
      logger.info(`Detected ${shells.filter(s => s.available).length} available shells`, 'ShellDetector', {
        shells: shells.filter(s => s.available).map(s => s.id)
      });
      return shells;
    } catch (error) {
      logger.error('Shell detection error', 'ShellDetector', error);
      // Return default shell list with all marked as unavailable
      return [
        { id: 'zsh', name: 'Zsh', available: false },
        { id: 'bash', name: 'Bash', available: false },
        { id: 'sh', name: 'Bourne Shell (sh)', available: false },
        { id: 'fish', name: 'Fish', available: false },
        { id: 'tcsh', name: 'Tcsh', available: false },
      ];
    }
  });

  // Shell operations
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  // DevTools operations
  ipcMain.handle('devtools:open', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools();
    }
  });

  ipcMain.handle('devtools:close', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.closeDevTools();
    }
  });

  ipcMain.handle('devtools:toggle', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
    }
  });

  // Logger operations
  ipcMain.handle('logger:log', async (_event, level: string, message: string, context?: string, data?: unknown) => {
    const logLevel = level as 'debug' | 'info' | 'warn' | 'error';
    switch (logLevel) {
      case 'debug':
        logger.debug(message, context, data);
        break;
      case 'info':
        logger.info(message, context, data);
        break;
      case 'warn':
        logger.warn(message, context, data);
        break;
      case 'error':
        logger.error(message, context, data);
        break;
    }
  });

  ipcMain.handle('logger:getLogs', async (_event, filter?: { level?: string; context?: string; limit?: number }) => {
    const typedFilter = filter ? {
      level: filter.level as 'debug' | 'info' | 'warn' | 'error' | undefined,
      context: filter.context,
      limit: filter.limit,
    } : undefined;
    return logger.getLogs(typedFilter);
  });

  ipcMain.handle('logger:clearLogs', async () => {
    logger.clearLogs();
  });

  ipcMain.handle('logger:setLogLevel', async (_event, level: string) => {
    const logLevel = level as 'debug' | 'info' | 'warn' | 'error';
    logger.setLogLevel(logLevel);
    store.set('logLevel', logLevel);
  });

  ipcMain.handle('logger:getLogLevel', async () => {
    return logger.getLogLevel();
  });

  ipcMain.handle('logger:setMaxLogBuffer', async (_event, max: number) => {
    logger.setMaxLogBuffer(max);
    store.set('maxLogBuffer', max);
  });

  ipcMain.handle('logger:getMaxLogBuffer', async () => {
    return logger.getMaxLogBuffer();
  });

  // Claude Code sessions API
  // Sessions are stored in ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
  ipcMain.handle('claude:listSessions', async (_event, projectPath: string) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      // Encode the project path the same way Claude Code does
      const encodedPath = projectPath.replace(/\//g, '-');
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

            // Extract first user message content - parse only first few lines
            for (let i = 0; i < Math.min(lines.length, 20); i++) {
              try {
                const entry = JSON.parse(lines[i]);
                if (entry.type === 'user' && entry.message?.content) {
                  firstUserMessage = typeof entry.message.content === 'string'
                    ? entry.message.content
                    : JSON.stringify(entry.message.content);
                  timestamp = entry.timestamp || timestamp;
                  break; // Found first user message, stop parsing
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

            // Calculate cost estimate using Claude Sonnet 4 pricing:
            // Input: $3 per million tokens, Output: $15 per million tokens
            // Cache read: $0.30 per million, Cache creation: $3.75 per million
            const inputCost = (totalInputTokens / 1_000_000) * 3;
            const outputCost = (totalOutputTokens / 1_000_000) * 15;
            const cacheReadCost = (totalCacheReadTokens / 1_000_000) * 0.30;
            const cacheCreationCost = (totalCacheCreationTokens / 1_000_000) * 3.75;
            const costUsd = inputCost + outputCost + cacheReadCost + cacheCreationCost;

            // Extract last timestamp from the session to calculate duration
            let lastTimestamp = timestamp;
            for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
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
              firstMessage: firstUserMessage.slice(0, 200), // Truncate for display
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

  ipcMain.handle('claude:readSessionMessages', async (_event, projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) => {
    try {
      const os = await import('os');
      const homeDir = os.default.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

      const encodedPath = projectPath.replace(/\//g, '-');
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

      const encodedPath = projectPath.replace(/\//g, '-');
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

  // History persistence (per-project and optionally per-session)
  ipcMain.handle('history:getAll', async (_event, projectPath?: string, sessionId?: string) => {
    const allEntries = historyStore.get('entries', []);
    let filteredEntries = allEntries;

    if (projectPath) {
      // Filter by project path
      filteredEntries = filteredEntries.filter(entry => entry.projectPath === projectPath);
    }

    if (sessionId) {
      // Filter by session ID - only show entries from this session OR entries without a sessionId (legacy)
      filteredEntries = filteredEntries.filter(entry => !entry.sessionId || entry.sessionId === sessionId);
    }

    return filteredEntries;
  });

  ipcMain.handle('history:add', async (_event, entry: HistoryEntry) => {
    const entries = historyStore.get('entries', []);
    entries.unshift(entry); // Add to beginning (most recent first)
    // Keep only last 1000 entries to prevent unbounded growth
    const trimmedEntries = entries.slice(0, 1000);
    historyStore.set('entries', trimmedEntries);
    logger.info(`Added history entry: ${entry.type}`, 'History', { summary: entry.summary });
    return true;
  });

  ipcMain.handle('history:clear', async (_event, projectPath?: string) => {
    if (projectPath) {
      // Clear only entries for this project
      const entries = historyStore.get('entries', []);
      const filtered = entries.filter(entry => entry.projectPath !== projectPath);
      historyStore.set('entries', filtered);
      logger.info(`Cleared history for project: ${projectPath}`, 'History');
    } else {
      // Clear all entries
      historyStore.set('entries', []);
      logger.info('Cleared all history', 'History');
    }
    return true;
  });

  ipcMain.handle('history:delete', async (_event, entryId: string) => {
    const entries = historyStore.get('entries', []);
    const filtered = entries.filter(entry => entry.id !== entryId);
    if (filtered.length === entries.length) {
      logger.warn(`History entry not found: ${entryId}`, 'History');
      return false;
    }
    historyStore.set('entries', filtered);
    logger.info(`Deleted history entry: ${entryId}`, 'History');
    return true;
  });

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

  ipcMain.handle('claude:getSessionOrigins', async (_event, projectPath: string) => {
    const origins = claudeSessionOriginsStore.get('origins', {});
    return origins[projectPath] || {};
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

  // Audio feedback using system TTS command (non-blocking)
  ipcMain.handle('notification:speak', async (_event, text: string, command?: string) => {
    console.log('[TTS Main] notification:speak called, text length:', text?.length, 'command:', command);
    try {
      const { spawn } = await import('child_process');
      const fullCommand = command || 'say'; // Default to macOS 'say' command
      console.log('[TTS Main] Using fullCommand:', fullCommand);

      // Parse command string to extract command and arguments
      // Handles paths with spaces if quoted, and preserves arguments
      const parts = fullCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [fullCommand];
      const ttsCommand = parts[0].replace(/^"|"$/g, ''); // Remove surrounding quotes if present
      const ttsArgs = parts.slice(1).map(arg => arg.replace(/^"|"$/g, '')); // Remove quotes from args

      // Add the text as the final argument (this is how most TTS commands work)
      ttsArgs.push(text);

      console.log('[TTS Main] Spawning:', ttsCommand, 'with args count:', ttsArgs.length);

      // Spawn the TTS process without waiting for it to complete (non-blocking)
      // This runs in the background and won't block the main process
      const child = spawn(ttsCommand, ttsArgs, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true, // Run independently
      });

      child.on('error', (err) => {
        console.error('[TTS Main] Spawn error:', err);
      });

      // Unref to allow the parent to exit independently
      child.unref();

      console.log('[TTS Main] Process spawned successfully');
      logger.debug('Started audio feedback', 'Notification', { command: ttsCommand, args: ttsArgs.length, textLength: text.length });
      return { success: true };
    } catch (error) {
      console.error('[TTS Main] Error starting audio feedback:', error);
      logger.error('Error starting audio feedback', 'Notification', error);
      return { success: false, error: String(error) };
    }
  });
}

// Handle process output streaming (set up after initialization)
function setupProcessListeners() {
  if (processManager) {
    processManager.on('data', (sessionId: string, data: string) => {
      console.log('[IPC] Forwarding process:data to renderer:', { sessionId, dataLength: data.length, hasMainWindow: !!mainWindow });
      mainWindow?.webContents.send('process:data', sessionId, data);
    });

    processManager.on('exit', (sessionId: string, code: number) => {
      mainWindow?.webContents.send('process:exit', sessionId, code);
    });

    processManager.on('session-id', (sessionId: string, claudeSessionId: string) => {
      mainWindow?.webContents.send('process:session-id', sessionId, claudeSessionId);
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
      console.log('[IPC] Forwarding process:usage to renderer:', { sessionId, usageStats });
      mainWindow?.webContents.send('process:usage', sessionId, usageStats);
    });
  }
}
