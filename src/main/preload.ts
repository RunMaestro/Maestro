import { contextBridge, ipcRenderer } from 'electron';

// Type definitions that match renderer types
interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  prompt?: string;
  shell?: string;
  images?: string[]; // Base64 data URLs for images
}

interface AgentConfig {
  id: string;
  name: string;
  available: boolean;
  path?: string;
}

interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

interface ShellInfo {
  id: string;
  name: string;
  available: boolean;
  path?: string;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('maestro', {
  // Settings API
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // Sessions persistence API
  sessions: {
    getAll: () => ipcRenderer.invoke('sessions:getAll'),
    setAll: (sessions: any[]) => ipcRenderer.invoke('sessions:setAll', sessions),
  },

  // Groups persistence API
  groups: {
    getAll: () => ipcRenderer.invoke('groups:getAll'),
    setAll: (groups: any[]) => ipcRenderer.invoke('groups:setAll', groups),
  },

  // Process/Session API
  process: {
    spawn: (config: ProcessConfig) => ipcRenderer.invoke('process:spawn', config),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('process:write', sessionId, data),
    interrupt: (sessionId: string) => ipcRenderer.invoke('process:interrupt', sessionId),
    kill: (sessionId: string) => ipcRenderer.invoke('process:kill', sessionId),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('process:resize', sessionId, cols, rows),

    // Run a single command and capture only stdout/stderr (no PTY echo/prompts)
    runCommand: (config: { sessionId: string; command: string; cwd: string; shell?: string }) =>
      ipcRenderer.invoke('process:runCommand', config),

    // Event listeners
    onData: (callback: (sessionId: string, data: string) => void) => {
      const handler = (_: any, sessionId: string, data: string) => callback(sessionId, data);
      ipcRenderer.on('process:data', handler);
      return () => ipcRenderer.removeListener('process:data', handler);
    },
    onExit: (callback: (sessionId: string, code: number) => void) => {
      const handler = (_: any, sessionId: string, code: number) => callback(sessionId, code);
      ipcRenderer.on('process:exit', handler);
      return () => ipcRenderer.removeListener('process:exit', handler);
    },
    onSessionId: (callback: (sessionId: string, claudeSessionId: string) => void) => {
      const handler = (_: any, sessionId: string, claudeSessionId: string) => callback(sessionId, claudeSessionId);
      ipcRenderer.on('process:session-id', handler);
      return () => ipcRenderer.removeListener('process:session-id', handler);
    },
    // Stderr listener for runCommand (separate stream)
    onStderr: (callback: (sessionId: string, data: string) => void) => {
      const handler = (_: any, sessionId: string, data: string) => callback(sessionId, data);
      ipcRenderer.on('process:stderr', handler);
      return () => ipcRenderer.removeListener('process:stderr', handler);
    },
    // Command exit listener for runCommand (separate from PTY exit)
    onCommandExit: (callback: (sessionId: string, code: number) => void) => {
      const handler = (_: any, sessionId: string, code: number) => callback(sessionId, code);
      ipcRenderer.on('process:command-exit', handler);
      return () => ipcRenderer.removeListener('process:command-exit', handler);
    },
    // Usage statistics listener for AI responses
    onUsage: (callback: (sessionId: string, usageStats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      totalCostUsd: number;
      contextWindow: number;
    }) => void) => {
      const handler = (_: any, sessionId: string, usageStats: any) => callback(sessionId, usageStats);
      ipcRenderer.on('process:usage', handler);
      return () => ipcRenderer.removeListener('process:usage', handler);
    },
  },

  // Git API
  git: {
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
    numstat: (cwd: string) => ipcRenderer.invoke('git:numstat', cwd),
    branch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd),
    remote: (cwd: string) => ipcRenderer.invoke('git:remote', cwd),
    info: (cwd: string) => ipcRenderer.invoke('git:info', cwd),
    log: (cwd: string, options?: { limit?: number; search?: string }) =>
      ipcRenderer.invoke('git:log', cwd, options),
    show: (cwd: string, hash: string) => ipcRenderer.invoke('git:show', cwd, hash),
  },

  // File System API
  fs: {
    readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  },

  // Web Server API
  webserver: {
    getUrl: () => ipcRenderer.invoke('webserver:getUrl'),
  },

  // Tunnel API - per-session local web server
  tunnel: {
    start: (sessionId: string) => ipcRenderer.invoke('tunnel:start', sessionId),
    stop: (sessionId: string) => ipcRenderer.invoke('tunnel:stop', sessionId),
    getStatus: (sessionId: string) => ipcRenderer.invoke('tunnel:getStatus', sessionId),
  },

  // Agent API
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect'),
    refresh: (agentId?: string) => ipcRenderer.invoke('agents:refresh', agentId),
    get: (agentId: string) => ipcRenderer.invoke('agents:get', agentId),
    getConfig: (agentId: string) => ipcRenderer.invoke('agents:getConfig', agentId),
    setConfig: (agentId: string, config: Record<string, any>) =>
      ipcRenderer.invoke('agents:setConfig', agentId, config),
    getConfigValue: (agentId: string, key: string) =>
      ipcRenderer.invoke('agents:getConfigValue', agentId, key),
    setConfigValue: (agentId: string, key: string, value: any) =>
      ipcRenderer.invoke('agents:setConfigValue', agentId, key, value),
  },

  // Dialog API
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  },

  // Font API
  fonts: {
    detect: () => ipcRenderer.invoke('fonts:detect'),
  },

  // Shells API (terminal shells, not to be confused with shell:openExternal)
  shells: {
    detect: () => ipcRenderer.invoke('shells:detect'),
  },

  // Shell API
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // DevTools API
  devtools: {
    open: () => ipcRenderer.invoke('devtools:open'),
    close: () => ipcRenderer.invoke('devtools:close'),
    toggle: () => ipcRenderer.invoke('devtools:toggle'),
  },

  // Logger API
  logger: {
    log: (level: string, message: string, context?: string, data?: unknown) =>
      ipcRenderer.invoke('logger:log', level, message, context, data),
    getLogs: (filter?: { level?: string; context?: string; limit?: number }) =>
      ipcRenderer.invoke('logger:getLogs', filter),
    clearLogs: () => ipcRenderer.invoke('logger:clearLogs'),
    setLogLevel: (level: string) => ipcRenderer.invoke('logger:setLogLevel', level),
    getLogLevel: () => ipcRenderer.invoke('logger:getLogLevel'),
    setMaxLogBuffer: (max: number) => ipcRenderer.invoke('logger:setMaxLogBuffer', max),
    getMaxLogBuffer: () => ipcRenderer.invoke('logger:getMaxLogBuffer'),
    // Convenience method for logging toast notifications
    toast: (title: string, data?: unknown) =>
      ipcRenderer.invoke('logger:log', 'toast', title, 'Toast', data),
  },

  // Claude Code sessions API
  claude: {
    listSessions: (projectPath: string) =>
      ipcRenderer.invoke('claude:listSessions', projectPath),
    readSessionMessages: (projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) =>
      ipcRenderer.invoke('claude:readSessionMessages', projectPath, sessionId, options),
    searchSessions: (projectPath: string, query: string, searchMode: 'title' | 'user' | 'assistant' | 'all') =>
      ipcRenderer.invoke('claude:searchSessions', projectPath, query, searchMode),
    getCommands: (projectPath: string) =>
      ipcRenderer.invoke('claude:getCommands', projectPath),
    // Session origin tracking (distinguishes Maestro sessions from CLI sessions)
    registerSessionOrigin: (projectPath: string, claudeSessionId: string, origin: 'user' | 'auto', sessionName?: string) =>
      ipcRenderer.invoke('claude:registerSessionOrigin', projectPath, claudeSessionId, origin, sessionName),
    updateSessionName: (projectPath: string, claudeSessionId: string, sessionName: string) =>
      ipcRenderer.invoke('claude:updateSessionName', projectPath, claudeSessionId, sessionName),
    getSessionOrigins: (projectPath: string) =>
      ipcRenderer.invoke('claude:getSessionOrigins', projectPath),
  },

  // Temp file API (for batch processing)
  tempfile: {
    write: (content: string, filename?: string) =>
      ipcRenderer.invoke('tempfile:write', content, filename),
    read: (filePath: string) =>
      ipcRenderer.invoke('tempfile:read', filePath),
    delete: (filePath: string) =>
      ipcRenderer.invoke('tempfile:delete', filePath),
  },

  // History API (per-project persistence)
  history: {
    getAll: (projectPath?: string, sessionId?: string) =>
      ipcRenderer.invoke('history:getAll', projectPath, sessionId),
    add: (entry: { id: string; type: 'AUTO' | 'USER'; timestamp: number; summary: string; claudeSessionId?: string; projectPath: string; sessionId?: string }) =>
      ipcRenderer.invoke('history:add', entry),
    clear: (projectPath?: string) =>
      ipcRenderer.invoke('history:clear', projectPath),
    delete: (entryId: string) =>
      ipcRenderer.invoke('history:delete', entryId),
  },

  // Notification API
  notification: {
    show: (title: string, body: string) =>
      ipcRenderer.invoke('notification:show', title, body),
    speak: (text: string, command?: string) =>
      ipcRenderer.invoke('notification:speak', text, command),
  },
});

// Type definitions for TypeScript
export interface MaestroAPI {
  settings: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<boolean>;
    getAll: () => Promise<Record<string, unknown>>;
  };
  sessions: {
    getAll: () => Promise<any[]>;
    setAll: (sessions: any[]) => Promise<boolean>;
  };
  groups: {
    getAll: () => Promise<any[]>;
    setAll: (groups: any[]) => Promise<boolean>;
  };
  process: {
    spawn: (config: ProcessConfig) => Promise<{ pid: number; success: boolean }>;
    write: (sessionId: string, data: string) => Promise<boolean>;
    interrupt: (sessionId: string) => Promise<boolean>;
    kill: (sessionId: string) => Promise<boolean>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
    runCommand: (config: { sessionId: string; command: string; cwd: string; shell?: string }) => Promise<{ exitCode: number }>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onSessionId: (callback: (sessionId: string, claudeSessionId: string) => void) => () => void;
    onStderr: (callback: (sessionId: string, data: string) => void) => () => void;
    onCommandExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onUsage: (callback: (sessionId: string, usageStats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      totalCostUsd: number;
      contextWindow: number;
    }) => void) => () => void;
  };
  git: {
    status: (cwd: string) => Promise<string>;
    diff: (cwd: string, file?: string) => Promise<string>;
    isRepo: (cwd: string) => Promise<boolean>;
    numstat: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
    branch: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
    remote: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
    info: (cwd: string) => Promise<{
      branch: string;
      remote: string;
      behind: number;
      ahead: number;
      uncommittedChanges: number;
    }>;
    log: (cwd: string, options?: { limit?: number; search?: string }) => Promise<{
      entries: Array<{
        hash: string;
        shortHash: string;
        author: string;
        date: string;
        refs: string[];
        subject: string;
      }>;
      error: string | null;
    }>;
    show: (cwd: string, hash: string) => Promise<{ stdout: string; stderr: string }>;
  };
  fs: {
    readDir: (dirPath: string) => Promise<DirectoryEntry[]>;
    readFile: (filePath: string) => Promise<string>;
  };
  webserver: {
    getUrl: () => Promise<string>;
  };
  tunnel: {
    start: (sessionId: string) => Promise<{ port: number; uuid: string; url: string }>;
    stop: (sessionId: string) => Promise<boolean>;
    getStatus: (sessionId: string) => Promise<{ active: boolean; port?: number; uuid?: string; url?: string }>;
  };
  agents: {
    detect: () => Promise<AgentConfig[]>;
    get: (agentId: string) => Promise<AgentConfig | null>;
    getConfig: (agentId: string) => Promise<Record<string, any>>;
    setConfig: (agentId: string, config: Record<string, any>) => Promise<boolean>;
    getConfigValue: (agentId: string, key: string) => Promise<any>;
    setConfigValue: (agentId: string, key: string, value: any) => Promise<boolean>;
  };
  dialog: {
    selectFolder: () => Promise<string | null>;
  };
  fonts: {
    detect: () => Promise<string[]>;
  };
  shells: {
    detect: () => Promise<ShellInfo[]>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  devtools: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    toggle: () => Promise<void>;
  };
  logger: {
    log: (level: string, message: string, context?: string, data?: unknown) => Promise<void>;
    getLogs: (filter?: { level?: string; context?: string; limit?: number }) => Promise<Array<{
      timestamp: number;
      level: string;
      message: string;
      context?: string;
      data?: unknown;
    }>>;
    clearLogs: () => Promise<void>;
    setLogLevel: (level: string) => Promise<void>;
    getLogLevel: () => Promise<string>;
    setMaxLogBuffer: (max: number) => Promise<void>;
    getMaxLogBuffer: () => Promise<number>;
  };
  claude: {
    listSessions: (projectPath: string) => Promise<Array<{
      sessionId: string;
      projectPath: string;
      timestamp: string;
      modifiedAt: string;
      firstMessage: string;
      messageCount: number;
      sizeBytes: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationSeconds: number;
      origin?: 'user' | 'auto'; // Maestro session origin, undefined for CLI sessions
      sessionName?: string; // User-defined session name from Maestro
    }>>;
    readSessionMessages: (projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) => Promise<{
      messages: Array<{
        type: string;
        role?: string;
        content: string;
        timestamp: string;
        uuid: string;
        toolUse?: any;
      }>;
      total: number;
      hasMore: boolean;
    }>;
    searchSessions: (projectPath: string, query: string, searchMode: 'title' | 'user' | 'assistant' | 'all') => Promise<Array<{
      sessionId: string;
      matchType: 'title' | 'user' | 'assistant';
      matchPreview: string;
      matchCount: number;
    }>>;
    getCommands: (projectPath: string) => Promise<Array<{
      command: string;
      description: string;
    }>>;
    registerSessionOrigin: (projectPath: string, claudeSessionId: string, origin: 'user' | 'auto', sessionName?: string) => Promise<boolean>;
    updateSessionName: (projectPath: string, claudeSessionId: string, sessionName: string) => Promise<boolean>;
    getSessionOrigins: (projectPath: string) => Promise<Record<string, 'user' | 'auto' | { origin: 'user' | 'auto'; sessionName?: string }>>;
  };
  tempfile: {
    write: (content: string, filename?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
    read: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  history: {
    getAll: (projectPath?: string, sessionId?: string) => Promise<Array<{
      id: string;
      type: 'AUTO' | 'USER';
      timestamp: number;
      summary: string;
      claudeSessionId?: string;
      projectPath: string;
      sessionId?: string;
    }>>;
    add: (entry: {
      id: string;
      type: 'AUTO' | 'USER';
      timestamp: number;
      summary: string;
      claudeSessionId?: string;
      projectPath: string;
      sessionId?: string;
    }) => Promise<boolean>;
    clear: (projectPath?: string) => Promise<boolean>;
    delete: (entryId: string) => Promise<boolean>;
  };
  notification: {
    show: (title: string, body: string) => Promise<{ success: boolean; error?: string }>;
    speak: (text: string, command?: string) => Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    maestro: MaestroAPI;
  }
}
