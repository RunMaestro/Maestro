import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
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

let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager | null = null;
let webServer: WebServer | null = null;
let agentDetector: AgentDetector | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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

  logger.info('Browser window created', 'Window', {
    size: '1400x900',
    mode: process.env.NODE_ENV || 'production'
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
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

app.whenReady().then(() => {
  // Load logger settings first
  const logLevel = store.get('logLevel', 'info');
  logger.setLogLevel(logLevel);

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

app.on('before-quit', () => {
  logger.info('Application shutting down', 'Shutdown');
  // Clean up all running processes
  logger.info('Killing all running processes', 'Shutdown');
  processManager?.killAll();
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

    logger.info(`Spawning process: ${config.command}`, 'ProcessManager', {
      sessionId: config.sessionId,
      toolType: config.toolType,
      cwd: config.cwd,
      command: config.command,
      args: finalArgs,
      requiresPty: agent?.requiresPty || false
    });

    const result = processManager.spawn({
      ...config,
      args: finalArgs,
      requiresPty: agent?.requiresPty,
      prompt: config.prompt
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

  ipcMain.handle('process:kill', async (_, sessionId: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    logger.info(`Killing process: ${sessionId}`, 'ProcessManager', { sessionId });
    return processManager.kill(sessionId);
  });

  ipcMain.handle('process:resize', async (_, sessionId: string, cols: number, rows: number) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.resize(sessionId, cols, rows);
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
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  });

  // Tunnel management
  // NOTE: Tunnel feature is planned for Phase 6 (see PRD.md and CLAUDE.md:385)
  // When implemented, will support ngrok/cloudflare for remote access
  // Remove this comment when implementing the feature

  // Web server management
  ipcMain.handle('webserver:getUrl', async () => {
    return webServer?.getUrl();
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
}

// Handle process output streaming (set up after initialization)
function setupProcessListeners() {
  if (processManager) {
    processManager.on('data', (sessionId: string, data: string) => {
      mainWindow?.webContents.send('process:data', sessionId, data);
    });

    processManager.on('exit', (sessionId: string, code: number) => {
      mainWindow?.webContents.send('process:exit', sessionId, code);
    });

    processManager.on('session-id', (sessionId: string, claudeSessionId: string) => {
      mainWindow?.webContents.send('process:session-id', sessionId, claudeSessionId);
    });
  }
}
