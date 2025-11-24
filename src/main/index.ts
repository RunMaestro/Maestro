import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { ProcessManager } from './process-manager';
import { WebServer } from './web-server';
import { AgentDetector } from './agent-detector';
import { execFileNoThrow } from './utils/execFile';
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

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Initialize core services
  processManager = new ProcessManager();
  webServer = new WebServer(8000);
  agentDetector = new AgentDetector();

  // Set up IPC handlers
  setupIpcHandlers();

  // Set up process event listeners
  setupProcessListeners();

  // Create main window
  createWindow();

  // Start web server for remote access
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
  // Clean up all running processes
  processManager?.killAll();
  webServer?.stop();
});

function setupIpcHandlers() {
  // Settings management
  ipcMain.handle('settings:get', async (_, key: string) => {
    return store.get(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: any) => {
    store.set(key, value);
    return true;
  });

  ipcMain.handle('settings:getAll', async () => {
    return store.store;
  });

  // Session/Process management
  ipcMain.handle('process:spawn', async (_, config: {
    sessionId: string;
    toolType: string;
    cwd: string;
    command: string;
    args: string[];
  }) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.spawn(config);
  });

  ipcMain.handle('process:write', async (_, sessionId: string, data: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.write(sessionId, data);
  });

  ipcMain.handle('process:kill', async (_, sessionId: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.kill(sessionId);
  });

  ipcMain.handle('process:resize', async (_, sessionId: string, cols: number, rows: number) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.resize(sessionId, cols, rows);
  });

  // Git operations
  ipcMain.handle('git:status', async (_, cwd: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    return processManager.execCommand('git status --porcelain', cwd);
  });

  ipcMain.handle('git:diff', async (_, cwd: string, file?: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    const command = file ? `git diff ${file}` : 'git diff';
    return processManager.execCommand(command, cwd);
  });

  ipcMain.handle('git:isRepo', async (_, cwd: string) => {
    if (!processManager) throw new Error('Process manager not initialized');
    try {
      await processManager.execCommand('git rev-parse --is-inside-work-tree', cwd);
      return true;
    } catch {
      return false;
    }
  });

  // File system operations
  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    const fs = require('fs').promises;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // Convert Dirent objects to plain objects for IPC serialization
    return entries.map((entry: any) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile()
    }));
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    const fs = require('fs').promises;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  });

  // Tunnel management (placeholder - will integrate ngrok/cloudflare)
  ipcMain.handle('tunnel:start', async (_event, port: number, provider: string) => {
    // TODO: Implement actual tunnel spawning
    console.log(`Starting tunnel on port ${port} with ${provider}`);
    return {
      url: `https://mock-${Math.random().toString(36).substr(2, 9)}.ngrok.io`,
      active: true,
    };
  });

  ipcMain.handle('tunnel:stop', async (_event, sessionId: string) => {
    // TODO: Implement tunnel cleanup
    console.log(`Stopping tunnel for session ${sessionId}`);
    return true;
  });

  // Web server management
  ipcMain.handle('webserver:getUrl', async () => {
    return webServer?.getUrl();
  });

  // Agent management
  ipcMain.handle('agents:detect', async () => {
    if (!agentDetector) throw new Error('Agent detector not initialized');
    return agentDetector.detectAgents();
  });

  ipcMain.handle('agents:get', async (_event, agentId: string) => {
    if (!agentDetector) throw new Error('Agent detector not initialized');
    return agentDetector.getAgent(agentId);
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
  }
}
