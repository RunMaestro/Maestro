import { contextBridge, ipcRenderer } from 'electron';

// Type definitions that match renderer types
interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  prompt?: string;
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
    kill: (sessionId: string) => ipcRenderer.invoke('process:kill', sessionId),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('process:resize', sessionId, cols, rows),

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
  },

  // Git API
  git: {
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
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

  // Agent API
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect'),
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
    kill: (sessionId: string) => Promise<boolean>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onSessionId: (callback: (sessionId: string, claudeSessionId: string) => void) => () => void;
  };
  git: {
    status: (cwd: string) => Promise<string>;
    diff: (cwd: string, file?: string) => Promise<string>;
    isRepo: (cwd: string) => Promise<boolean>;
  };
  fs: {
    readDir: (dirPath: string) => Promise<DirectoryEntry[]>;
    readFile: (filePath: string) => Promise<string>;
  };
  webserver: {
    getUrl: () => Promise<string>;
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
  };
}

declare global {
  interface Window {
    maestro: MaestroAPI;
  }
}
