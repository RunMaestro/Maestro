import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('maestro', {
  // Settings API
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // Process/Session API
  process: {
    spawn: (config: any) => ipcRenderer.invoke('process:spawn', config),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('process:write', sessionId, data),
    kill: (sessionId: string) => ipcRenderer.invoke('process:kill', sessionId),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('process:resize', sessionId, cols, rows),

    // Event listeners
    onData: (callback: (sessionId: string, data: string) => void) => {
      ipcRenderer.on('process:data', (_, sessionId, data) => callback(sessionId, data));
    },
    onExit: (callback: (sessionId: string, code: number) => void) => {
      ipcRenderer.on('process:exit', (_, sessionId, code) => callback(sessionId, code));
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

  // Tunnel API
  tunnel: {
    start: (port: number, provider: string) => ipcRenderer.invoke('tunnel:start', port, provider),
    stop: (sessionId: string) => ipcRenderer.invoke('tunnel:stop', sessionId),
  },

  // Web Server API
  webserver: {
    getUrl: () => ipcRenderer.invoke('webserver:getUrl'),
  },

  // Agent API
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect'),
    get: (agentId: string) => ipcRenderer.invoke('agents:get', agentId),
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
});

// Type definitions for TypeScript
export interface MaestroAPI {
  settings: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<boolean>;
    getAll: () => Promise<any>;
  };
  process: {
    spawn: (config: any) => Promise<{ pid: number; success: boolean }>;
    write: (sessionId: string, data: string) => Promise<boolean>;
    kill: (sessionId: string) => Promise<boolean>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
    onData: (callback: (sessionId: string, data: string) => void) => void;
    onExit: (callback: (sessionId: string, code: number) => void) => void;
  };
  git: {
    status: (cwd: string) => Promise<string>;
    diff: (cwd: string, file?: string) => Promise<string>;
    isRepo: (cwd: string) => Promise<boolean>;
  };
  fs: {
    readDir: (dirPath: string) => Promise<any[]>;
    readFile: (filePath: string) => Promise<string>;
  };
  tunnel: {
    start: (port: number, provider: string) => Promise<{ url: string; active: boolean }>;
    stop: (sessionId: string) => Promise<boolean>;
  };
  webserver: {
    getUrl: () => Promise<string>;
  };
  agents: {
    detect: () => Promise<any[]>;
    get: (agentId: string) => Promise<any>;
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
}

declare global {
  interface Window {
    maestro: MaestroAPI;
  }
}
