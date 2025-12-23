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
  // Agent-specific spawn options (used to build args via agent config)
  agentSessionId?: string;  // For session resume (uses agent's resumeArgs builder)
  readOnlyMode?: boolean;   // For read-only/plan mode (uses agent's readOnlyArgs)
  modelId?: string;         // For model selection (uses agent's modelArgs builder)
  yoloMode?: boolean;       // For YOLO/full-access mode (uses agent's yoloModeArgs)
}

/**
 * Capability flags that determine what features are available for each agent.
 * This is a simplified version for the renderer - full definition in agent-capabilities.ts
 */
interface AgentCapabilities {
  supportsResume: boolean;
  supportsReadOnlyMode: boolean;
  supportsJsonOutput: boolean;
  supportsSessionId: boolean;
  supportsImageInput: boolean;
  supportsImageInputOnResume: boolean;
  supportsSlashCommands: boolean;
  supportsSessionStorage: boolean;
  supportsCostTracking: boolean;
  supportsUsageStats: boolean;
  supportsBatchMode: boolean;
  requiresPromptToStart: boolean;
  supportsStreaming: boolean;
  supportsResultMessages: boolean;
  supportsModelSelection: boolean;
  supportsStreamJsonInput: boolean;
}

interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  available: boolean;
  path?: string;
  capabilities?: AgentCapabilities;
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

// Helper to log deprecation warnings
const logDeprecationWarning = (method: string, replacement?: string) => {
  const message = replacement
    ? `[Deprecation Warning] window.maestro.claude.${method}() is deprecated. Use window.maestro.agentSessions.${replacement}() instead.`
    : `[Deprecation Warning] window.maestro.claude.${method}() is deprecated. Use the agentSessions API instead.`;
  console.warn(message);
};

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

    // Get all active processes from ProcessManager
    getActiveProcesses: () => ipcRenderer.invoke('process:getActiveProcesses'),

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
    onSessionId: (callback: (sessionId: string, agentSessionId: string) => void) => {
      const handler = (_: any, sessionId: string, agentSessionId: string) => callback(sessionId, agentSessionId);
      ipcRenderer.on('process:session-id', handler);
      return () => ipcRenderer.removeListener('process:session-id', handler);
    },
    onSlashCommands: (callback: (sessionId: string, slashCommands: string[]) => void) => {
      const handler = (_: any, sessionId: string, slashCommands: string[]) => callback(sessionId, slashCommands);
      ipcRenderer.on('process:slash-commands', handler);
      return () => ipcRenderer.removeListener('process:slash-commands', handler);
    },
    // Thinking/streaming content chunks from AI agents
    // Emitted when agents produce partial text events (isPartial: true)
    // Renderer decides whether to display based on tab's showThinking setting
    onThinkingChunk: (callback: (sessionId: string, content: string) => void) => {
      const handler = (_: any, sessionId: string, content: string) => callback(sessionId, content);
      ipcRenderer.on('process:thinking-chunk', handler);
      return () => ipcRenderer.removeListener('process:thinking-chunk', handler);
    },
    onToolExecution: (callback: (sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => void) => {
      const handler = (_: any, sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => callback(sessionId, toolEvent);
      ipcRenderer.on('process:tool-execution', handler);
      return () => ipcRenderer.removeListener('process:tool-execution', handler);
    },
    // Remote command execution from web interface
    // This allows web commands to go through the same code path as desktop commands
    // inputMode is optional - if provided, renderer should use it instead of session state
    onRemoteCommand: (callback: (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void) => {
      console.log('[Preload] Registering onRemoteCommand listener');
      const handler = (_: any, sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
        console.log('[Preload] Received remote:executeCommand IPC:', { sessionId, command: command?.substring(0, 50), inputMode });
        callback(sessionId, command, inputMode);
      };
      ipcRenderer.on('remote:executeCommand', handler);
      return () => ipcRenderer.removeListener('remote:executeCommand', handler);
    },
    // Remote mode switch from web interface - forwards to desktop's toggleInputMode logic
    onRemoteSwitchMode: (callback: (sessionId: string, mode: 'ai' | 'terminal') => void) => {
      console.log('[Preload] Registering onRemoteSwitchMode listener');
      const handler = (_: any, sessionId: string, mode: 'ai' | 'terminal') => {
        console.log('[Preload] Received remote:switchMode IPC:', { sessionId, mode });
        callback(sessionId, mode);
      };
      ipcRenderer.on('remote:switchMode', handler);
      return () => ipcRenderer.removeListener('remote:switchMode', handler);
    },
    // Remote interrupt from web interface - forwards to desktop's handleInterrupt logic
    onRemoteInterrupt: (callback: (sessionId: string) => void) => {
      const handler = (_: any, sessionId: string) => callback(sessionId);
      ipcRenderer.on('remote:interrupt', handler);
      return () => ipcRenderer.removeListener('remote:interrupt', handler);
    },
    // Remote session selection from web interface - forwards to desktop's setActiveSessionId logic
    // Optional tabId to also switch to a specific tab within the session
    onRemoteSelectSession: (callback: (sessionId: string, tabId?: string) => void) => {
      console.log('[Preload] Registering onRemoteSelectSession listener');
      const handler = (_: any, sessionId: string, tabId?: string) => {
        console.log('[Preload] Received remote:selectSession IPC:', { sessionId, tabId });
        callback(sessionId, tabId);
      };
      ipcRenderer.on('remote:selectSession', handler);
      return () => ipcRenderer.removeListener('remote:selectSession', handler);
    },
    // Remote tab selection from web interface
    onRemoteSelectTab: (callback: (sessionId: string, tabId: string) => void) => {
      const handler = (_: any, sessionId: string, tabId: string) => callback(sessionId, tabId);
      ipcRenderer.on('remote:selectTab', handler);
      return () => ipcRenderer.removeListener('remote:selectTab', handler);
    },
    // Remote new tab from web interface
    onRemoteNewTab: (callback: (sessionId: string, responseChannel: string) => void) => {
      const handler = (_: any, sessionId: string, responseChannel: string) => callback(sessionId, responseChannel);
      ipcRenderer.on('remote:newTab', handler);
      return () => ipcRenderer.removeListener('remote:newTab', handler);
    },
    // Send response for remote new tab
    sendRemoteNewTabResponse: (responseChannel: string, result: { tabId: string } | null) => {
      ipcRenderer.send(responseChannel, result);
    },
    // Remote close tab from web interface
    onRemoteCloseTab: (callback: (sessionId: string, tabId: string) => void) => {
      const handler = (_: any, sessionId: string, tabId: string) => callback(sessionId, tabId);
      ipcRenderer.on('remote:closeTab', handler);
      return () => ipcRenderer.removeListener('remote:closeTab', handler);
    },
    // Remote rename tab from web interface
    onRemoteRenameTab: (callback: (sessionId: string, tabId: string, newName: string) => void) => {
      const handler = (_: any, sessionId: string, tabId: string, newName: string) => callback(sessionId, tabId, newName);
      ipcRenderer.on('remote:renameTab', handler);
      return () => ipcRenderer.removeListener('remote:renameTab', handler);
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
      reasoningTokens?: number;  // Separate reasoning tokens (Codex o3/o4-mini)
    }) => void) => {
      const handler = (_: any, sessionId: string, usageStats: any) => callback(sessionId, usageStats);
      ipcRenderer.on('process:usage', handler);
      return () => ipcRenderer.removeListener('process:usage', handler);
    },
    // Agent error event listener (auth expired, token exhaustion, rate limits, etc.)
    onAgentError: (callback: (sessionId: string, error: {
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
    }) => void) => {
      const handler = (_: any, sessionId: string, error: any) => callback(sessionId, error);
      ipcRenderer.on('agent:error', handler);
      return () => ipcRenderer.removeListener('agent:error', handler);
    },
  },

  // Agent Error Handling API
  agentError: {
    // Clear an error state for a session (called after recovery action)
    clearError: (sessionId: string) =>
      ipcRenderer.invoke('agent:clearError', sessionId),
    // Retry the last operation after an error
    retryAfterError: (sessionId: string, options?: {
      prompt?: string;
      newSession?: boolean;
    }) =>
      ipcRenderer.invoke('agent:retryAfterError', sessionId, options),
  },

  // Web interface API
  web: {
    // Broadcast user input to web clients (for keeping web interface in sync)
    broadcastUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') =>
      ipcRenderer.invoke('web:broadcastUserInput', sessionId, command, inputMode),
    // Broadcast AutoRun state to web clients (for showing task progress on mobile)
    broadcastAutoRunState: (sessionId: string, state: {
      isRunning: boolean;
      totalTasks: number;
      completedTasks: number;
      currentTaskIndex: number;
      isStopping?: boolean;
    } | null) =>
      ipcRenderer.invoke('web:broadcastAutoRunState', sessionId, state),
    // Broadcast tab changes to web clients (for tab sync)
    broadcastTabsChange: (sessionId: string, aiTabs: Array<{
      id: string;
      agentSessionId: string | null;
      name: string | null;
      starred: boolean;
      inputValue: string;
      usageStats?: any;
      createdAt: number;
      state: 'idle' | 'busy';
      thinkingStartTime?: number | null;
    }>, activeTabId: string) =>
      ipcRenderer.invoke('web:broadcastTabsChange', sessionId, aiTabs, activeTabId),
  },

  // Git API
  git: {
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
    isRepo: (cwd: string) => ipcRenderer.invoke('git:isRepo', cwd),
    numstat: (cwd: string) => ipcRenderer.invoke('git:numstat', cwd),
    branch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd),
    branches: (cwd: string) => ipcRenderer.invoke('git:branches', cwd),
    tags: (cwd: string) => ipcRenderer.invoke('git:tags', cwd),
    remote: (cwd: string) => ipcRenderer.invoke('git:remote', cwd),
    info: (cwd: string) => ipcRenderer.invoke('git:info', cwd),
    log: (cwd: string, options?: { limit?: number; search?: string }) =>
      ipcRenderer.invoke('git:log', cwd, options),
    commitCount: (cwd: string) =>
      ipcRenderer.invoke('git:commitCount', cwd) as Promise<{ count: number; error: string | null }>,
    show: (cwd: string, hash: string) => ipcRenderer.invoke('git:show', cwd, hash),
    showFile: (cwd: string, ref: string, filePath: string) =>
      ipcRenderer.invoke('git:showFile', cwd, ref, filePath) as Promise<{ content?: string; error?: string }>,
    // Git worktree operations for Auto Run parallelization
    worktreeInfo: (worktreePath: string) =>
      ipcRenderer.invoke('git:worktreeInfo', worktreePath) as Promise<{
        success: boolean;
        exists?: boolean;
        isWorktree?: boolean;
        currentBranch?: string;
        repoRoot?: string;
        error?: string;
      }>,
    getRepoRoot: (cwd: string) =>
      ipcRenderer.invoke('git:getRepoRoot', cwd) as Promise<{
        success: boolean;
        root?: string;
        error?: string;
      }>,
    worktreeSetup: (mainRepoCwd: string, worktreePath: string, branchName: string) =>
      ipcRenderer.invoke('git:worktreeSetup', mainRepoCwd, worktreePath, branchName) as Promise<{
        success: boolean;
        created?: boolean;
        currentBranch?: string;
        requestedBranch?: string;
        branchMismatch?: boolean;
        error?: string;
      }>,
    worktreeCheckout: (worktreePath: string, branchName: string, createIfMissing: boolean) =>
      ipcRenderer.invoke('git:worktreeCheckout', worktreePath, branchName, createIfMissing) as Promise<{
        success: boolean;
        hasUncommittedChanges: boolean;
        error?: string;
      }>,
    createPR: (worktreePath: string, baseBranch: string, title: string, body: string, ghPath?: string) =>
      ipcRenderer.invoke('git:createPR', worktreePath, baseBranch, title, body, ghPath) as Promise<{
        success: boolean;
        prUrl?: string;
        error?: string;
      }>,
    getDefaultBranch: (cwd: string) =>
      ipcRenderer.invoke('git:getDefaultBranch', cwd) as Promise<{
        success: boolean;
        branch?: string;
        error?: string;
      }>,
    checkGhCli: (ghPath?: string) =>
      ipcRenderer.invoke('git:checkGhCli', ghPath) as Promise<{
        installed: boolean;
        authenticated: boolean;
      }>,
    // List all worktrees for a git repository
    listWorktrees: (cwd: string) =>
      ipcRenderer.invoke('git:listWorktrees', cwd) as Promise<{
        worktrees: Array<{
          path: string;
          head: string;
          branch: string | null;
          isBare: boolean;
        }>;
      }>,
    // Scan a directory for subdirectories that are git repositories or worktrees
    scanWorktreeDirectory: (parentPath: string) =>
      ipcRenderer.invoke('git:scanWorktreeDirectory', parentPath) as Promise<{
        gitSubdirs: Array<{
          path: string;
          name: string;
          isWorktree: boolean;
          branch: string | null;
          repoRoot: string | null;
        }>;
      }>,
    // Watch a worktree directory for new worktrees
    watchWorktreeDirectory: (sessionId: string, worktreePath: string) =>
      ipcRenderer.invoke('git:watchWorktreeDirectory', sessionId, worktreePath) as Promise<{
        success: boolean;
        error?: string;
      }>,
    // Stop watching a worktree directory
    unwatchWorktreeDirectory: (sessionId: string) =>
      ipcRenderer.invoke('git:unwatchWorktreeDirectory', sessionId) as Promise<{
        success: boolean;
      }>,
    // Listen for discovered worktrees
    onWorktreeDiscovered: (callback: (data: { sessionId: string; worktree: { path: string; name: string; branch: string | null } }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; worktree: { path: string; name: string; branch: string | null } }) => callback(data);
      ipcRenderer.on('worktree:discovered', handler);
      return () => ipcRenderer.removeListener('worktree:discovered', handler);
    },
  },

  // File System API
  fs: {
    homeDir: () => ipcRenderer.invoke('fs:homeDir') as Promise<string>,
    readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('fs:writeFile', filePath, content) as Promise<{ success: boolean }>,
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
  },

  // Web Server API
  webserver: {
    getUrl: () => ipcRenderer.invoke('webserver:getUrl'),
    getConnectedClients: () => ipcRenderer.invoke('webserver:getConnectedClients'),
  },

  // Live Session API - toggle sessions as live/offline in web interface
  live: {
    toggle: (sessionId: string, agentSessionId?: string) =>
      ipcRenderer.invoke('live:toggle', sessionId, agentSessionId),
    getStatus: (sessionId: string) => ipcRenderer.invoke('live:getStatus', sessionId),
    getDashboardUrl: () => ipcRenderer.invoke('live:getDashboardUrl'),
    getLiveSessions: () => ipcRenderer.invoke('live:getLiveSessions'),
    broadcastActiveSession: (sessionId: string) =>
      ipcRenderer.invoke('live:broadcastActiveSession', sessionId),
    disableAll: () => ipcRenderer.invoke('live:disableAll'),
    startServer: () => ipcRenderer.invoke('live:startServer'),
    stopServer: () => ipcRenderer.invoke('live:stopServer'),
  },

  // Agent API
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect'),
    refresh: (agentId?: string) => ipcRenderer.invoke('agents:refresh', agentId),
    get: (agentId: string) => ipcRenderer.invoke('agents:get', agentId),
    getCapabilities: (agentId: string) => ipcRenderer.invoke('agents:getCapabilities', agentId),
    getConfig: (agentId: string) => ipcRenderer.invoke('agents:getConfig', agentId),
    setConfig: (agentId: string, config: Record<string, any>) =>
      ipcRenderer.invoke('agents:setConfig', agentId, config),
    getConfigValue: (agentId: string, key: string) =>
      ipcRenderer.invoke('agents:getConfigValue', agentId, key),
    setConfigValue: (agentId: string, key: string, value: any) =>
      ipcRenderer.invoke('agents:setConfigValue', agentId, key, value),
    setCustomPath: (agentId: string, customPath: string | null) =>
      ipcRenderer.invoke('agents:setCustomPath', agentId, customPath),
    getCustomPath: (agentId: string) =>
      ipcRenderer.invoke('agents:getCustomPath', agentId),
    getAllCustomPaths: () => ipcRenderer.invoke('agents:getAllCustomPaths'),
    // Custom CLI arguments that are appended to all agent invocations
    setCustomArgs: (agentId: string, customArgs: string | null) =>
      ipcRenderer.invoke('agents:setCustomArgs', agentId, customArgs),
    getCustomArgs: (agentId: string) =>
      ipcRenderer.invoke('agents:getCustomArgs', agentId) as Promise<string | null>,
    getAllCustomArgs: () =>
      ipcRenderer.invoke('agents:getAllCustomArgs') as Promise<Record<string, string>>,
    // Custom environment variables that are passed to all agent invocations
    setCustomEnvVars: (agentId: string, customEnvVars: Record<string, string> | null) =>
      ipcRenderer.invoke('agents:setCustomEnvVars', agentId, customEnvVars),
    getCustomEnvVars: (agentId: string) =>
      ipcRenderer.invoke('agents:getCustomEnvVars', agentId) as Promise<Record<string, string> | null>,
    getAllCustomEnvVars: () =>
      ipcRenderer.invoke('agents:getAllCustomEnvVars') as Promise<Record<string, Record<string, string>>>,
    // Discover available models for agents that support model selection (e.g., OpenCode with Ollama)
    getModels: (agentId: string, forceRefresh?: boolean) =>
      ipcRenderer.invoke('agents:getModels', agentId, forceRefresh) as Promise<string[]>,
    // Discover available slash commands for an agent by spawning it briefly
    // Returns array of command names (e.g., ['compact', 'help', 'my-custom-command'])
    discoverSlashCommands: (agentId: string, cwd: string, customPath?: string) =>
      ipcRenderer.invoke('agents:discoverSlashCommands', agentId, cwd, customPath) as Promise<string[] | null>,
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

  // Tunnel API (Cloudflare tunnel support)
  tunnel: {
    isCloudflaredInstalled: () => ipcRenderer.invoke('tunnel:isCloudflaredInstalled'),
    start: () => ipcRenderer.invoke('tunnel:start'),
    stop: () => ipcRenderer.invoke('tunnel:stop'),
    getStatus: () => ipcRenderer.invoke('tunnel:getStatus'),
  },

  // Sync API (custom storage location for cross-device sync)
  sync: {
    getDefaultPath: () => ipcRenderer.invoke('sync:getDefaultPath') as Promise<string>,
    getSettings: () => ipcRenderer.invoke('sync:getSettings') as Promise<{
      customSyncPath?: string;
    }>,
    getCurrentStoragePath: () => ipcRenderer.invoke('sync:getCurrentStoragePath') as Promise<string>,
    selectSyncFolder: () => ipcRenderer.invoke('sync:selectSyncFolder') as Promise<string | null>,
    setCustomPath: (customPath: string | null) => ipcRenderer.invoke('sync:setCustomPath', customPath) as Promise<{
      success: boolean;
      migrated?: number;
      errors?: string[];
      requiresRestart?: boolean;
      error?: string;
    }>,
  },

  // DevTools API
  devtools: {
    open: () => ipcRenderer.invoke('devtools:open'),
    close: () => ipcRenderer.invoke('devtools:close'),
    toggle: () => ipcRenderer.invoke('devtools:toggle'),
  },

  // Updates API
  updates: {
    check: () => ipcRenderer.invoke('updates:check') as Promise<{
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      versionsBehind: number;
      releases: Array<{
        tag_name: string;
        name: string;
        body: string;
        html_url: string;
        published_at: string;
      }>;
      releasesUrl: string;
      error?: string;
    }>,
    // Auto-updater APIs (electron-updater)
    download: () => ipcRenderer.invoke('updates:download') as Promise<{ success: boolean; error?: string }>,
    install: () => ipcRenderer.invoke('updates:install') as Promise<void>,
    getStatus: () => ipcRenderer.invoke('updates:getStatus') as Promise<{
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
      info?: { version: string };
      progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
      error?: string;
    }>,
    // Subscribe to update status changes
    onStatus: (callback: (status: {
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
      info?: { version: string };
      progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
      error?: string;
    }) => void) => {
      const handler = (_: any, status: any) => callback(status);
      ipcRenderer.on('updates:status', handler);
      return () => ipcRenderer.removeListener('updates:status', handler);
    },
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
    // Convenience method for Auto Run workflow logging (cannot be turned off)
    autorun: (message: string, context?: string, data?: unknown) =>
      ipcRenderer.invoke('logger:log', 'autorun', message, context || 'AutoRun', data),
    // Subscribe to new log entries in real-time
    onNewLog: (callback: (log: { timestamp: number; level: string; message: string; context?: string; data?: unknown }) => void) => {
      const handler = (_: any, log: any) => callback(log);
      ipcRenderer.on('logger:newLog', handler);
      return () => ipcRenderer.removeListener('logger:newLog', handler);
    },
  },

  // Claude Code sessions API
  // DEPRECATED: Use agentSessions API instead for new code
  claude: {
    listSessions: (projectPath: string) => {
      logDeprecationWarning('listSessions', 'list');
      return ipcRenderer.invoke('claude:listSessions', projectPath);
    },
    // Paginated version for better performance with many sessions
    listSessionsPaginated: (projectPath: string, options?: { cursor?: string; limit?: number }) => {
      logDeprecationWarning('listSessionsPaginated', 'listPaginated');
      return ipcRenderer.invoke('claude:listSessionsPaginated', projectPath, options);
    },
    // Get aggregate stats for all sessions in a project (streams progressive updates)
    getProjectStats: (projectPath: string) => {
      logDeprecationWarning('getProjectStats');
      return ipcRenderer.invoke('claude:getProjectStats', projectPath);
    },
    // Get all session timestamps for activity graph (lightweight)
    getSessionTimestamps: (projectPath: string) => {
      logDeprecationWarning('getSessionTimestamps');
      return ipcRenderer.invoke('claude:getSessionTimestamps', projectPath) as Promise<{ timestamps: string[] }>;
    },
    onProjectStatsUpdate: (callback: (stats: {
      projectPath: string;
      totalSessions: number;
      totalMessages: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      oldestTimestamp: string | null;
      processedCount: number;
      isComplete: boolean;
    }) => void) => {
      logDeprecationWarning('onProjectStatsUpdate');
      const handler = (_: any, stats: any) => callback(stats);
      ipcRenderer.on('claude:projectStatsUpdate', handler);
      return () => ipcRenderer.removeListener('claude:projectStatsUpdate', handler);
    },
    getGlobalStats: () => {
      logDeprecationWarning('getGlobalStats');
      return ipcRenderer.invoke('claude:getGlobalStats');
    },
    onGlobalStatsUpdate: (callback: (stats: {
      totalSessions: number;
      totalMessages: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      isComplete: boolean;
    }) => void) => {
      logDeprecationWarning('onGlobalStatsUpdate');
      const handler = (_: any, stats: any) => callback(stats);
      ipcRenderer.on('claude:globalStatsUpdate', handler);
      return () => ipcRenderer.removeListener('claude:globalStatsUpdate', handler);
    },
    readSessionMessages: (projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) => {
      logDeprecationWarning('readSessionMessages', 'read');
      return ipcRenderer.invoke('claude:readSessionMessages', projectPath, sessionId, options);
    },
    searchSessions: (projectPath: string, query: string, searchMode: 'title' | 'user' | 'assistant' | 'all') => {
      logDeprecationWarning('searchSessions', 'search');
      return ipcRenderer.invoke('claude:searchSessions', projectPath, query, searchMode);
    },
    getCommands: (projectPath: string) => {
      logDeprecationWarning('getCommands');
      return ipcRenderer.invoke('claude:getCommands', projectPath);
    },
    // Session origin tracking (distinguishes Maestro sessions from CLI sessions)
    registerSessionOrigin: (projectPath: string, agentSessionId: string, origin: 'user' | 'auto', sessionName?: string) => {
      logDeprecationWarning('registerSessionOrigin');
      return ipcRenderer.invoke('claude:registerSessionOrigin', projectPath, agentSessionId, origin, sessionName);
    },
    updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) => {
      logDeprecationWarning('updateSessionName');
      return ipcRenderer.invoke('claude:updateSessionName', projectPath, agentSessionId, sessionName);
    },
    updateSessionStarred: (projectPath: string, agentSessionId: string, starred: boolean) => {
      logDeprecationWarning('updateSessionStarred');
      return ipcRenderer.invoke('claude:updateSessionStarred', projectPath, agentSessionId, starred);
    },
    getSessionOrigins: (projectPath: string) => {
      logDeprecationWarning('getSessionOrigins');
      return ipcRenderer.invoke('claude:getSessionOrigins', projectPath);
    },
    getAllNamedSessions: () => {
      logDeprecationWarning('getAllNamedSessions');
      return ipcRenderer.invoke('claude:getAllNamedSessions') as Promise<Array<{
        agentSessionId: string;
        projectPath: string;
        sessionName: string;
        starred?: boolean;
        lastActivityAt?: number;
      }>>;
    },
    deleteMessagePair: (projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) => {
      logDeprecationWarning('deleteMessagePair', 'deleteMessagePair');
      return ipcRenderer.invoke('claude:deleteMessagePair', projectPath, sessionId, userMessageUuid, fallbackContent);
    },
  },

  // Agent Sessions API (generic multi-agent session storage)
  // This is the preferred API for new code. The claude.* API is deprecated.
  agentSessions: {
    // List all sessions for an agent
    list: (agentId: string, projectPath: string) =>
      ipcRenderer.invoke('agentSessions:list', agentId, projectPath),
    // List sessions with pagination
    listPaginated: (agentId: string, projectPath: string, options?: { cursor?: string; limit?: number }) =>
      ipcRenderer.invoke('agentSessions:listPaginated', agentId, projectPath, options),
    // Read session messages
    read: (agentId: string, projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) =>
      ipcRenderer.invoke('agentSessions:read', agentId, projectPath, sessionId, options),
    // Search sessions
    search: (agentId: string, projectPath: string, query: string, searchMode: 'title' | 'user' | 'assistant' | 'all') =>
      ipcRenderer.invoke('agentSessions:search', agentId, projectPath, query, searchMode),
    // Get session file path
    getPath: (agentId: string, projectPath: string, sessionId: string) =>
      ipcRenderer.invoke('agentSessions:getPath', agentId, projectPath, sessionId),
    // Delete a message pair from a session
    deleteMessagePair: (agentId: string, projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) =>
      ipcRenderer.invoke('agentSessions:deleteMessagePair', agentId, projectPath, sessionId, userMessageUuid, fallbackContent),
    // Check if an agent has session storage support
    hasStorage: (agentId: string) =>
      ipcRenderer.invoke('agentSessions:hasStorage', agentId),
    // Get list of agent IDs that have session storage
    getAvailableStorages: () =>
      ipcRenderer.invoke('agentSessions:getAvailableStorages'),
    // Get global stats aggregated from all providers
    getGlobalStats: () =>
      ipcRenderer.invoke('agentSessions:getGlobalStats'),
    // Get all named sessions across all providers
    getAllNamedSessions: () =>
      ipcRenderer.invoke('agentSessions:getAllNamedSessions') as Promise<Array<{
        agentId: string;
        agentSessionId: string;
        projectPath: string;
        sessionName: string;
        starred?: boolean;
        lastActivityAt?: number;
      }>>,
    // Subscribe to global stats updates (streaming)
    onGlobalStatsUpdate: (callback: (stats: {
      totalSessions: number;
      totalMessages: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      hasCostData: boolean;
      totalSizeBytes: number;
      isComplete: boolean;
      byProvider: Record<string, {
        sessions: number;
        messages: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        hasCostData: boolean;
      }>;
    }) => void) => {
      const handler = (_: unknown, stats: Parameters<typeof callback>[0]) => callback(stats);
      ipcRenderer.on('agentSessions:globalStatsUpdate', handler);
      return () => ipcRenderer.removeListener('agentSessions:globalStatsUpdate', handler);
    },
    // Register a session's origin (user-initiated vs auto/batch)
    // Currently delegates to claude: handlers for backwards compatibility
    registerSessionOrigin: (projectPath: string, agentSessionId: string, origin: 'user' | 'auto', sessionName?: string) =>
      ipcRenderer.invoke('claude:registerSessionOrigin', projectPath, agentSessionId, origin, sessionName),
    // Update a session's display name
    updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) =>
      ipcRenderer.invoke('claude:updateSessionName', projectPath, agentSessionId, sessionName),
    // Generic session origins API (for non-Claude agents like Codex, OpenCode)
    // Get session origins (names, starred status) for an agent/project
    getOrigins: (agentId: string, projectPath: string) =>
      ipcRenderer.invoke('agentSessions:getOrigins', agentId, projectPath) as Promise<Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>>,
    // Set session name for any agent
    setSessionName: (agentId: string, projectPath: string, sessionId: string, sessionName: string | null) =>
      ipcRenderer.invoke('agentSessions:setSessionName', agentId, projectPath, sessionId, sessionName),
    // Set session starred status for any agent
    setSessionStarred: (agentId: string, projectPath: string, sessionId: string, starred: boolean) =>
      ipcRenderer.invoke('agentSessions:setSessionStarred', agentId, projectPath, sessionId, starred),
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
    // Paginated API for large datasets
    getAllPaginated: (options?: {
      projectPath?: string;
      sessionId?: string;
      pagination?: { limit?: number; offset?: number };
    }) => ipcRenderer.invoke('history:getAllPaginated', options),
    add: (entry: {
      id: string;
      type: 'AUTO' | 'USER';
      timestamp: number;
      summary: string;
      fullResponse?: string;
      agentSessionId?: string;
      projectPath: string;
      sessionId?: string;
      sessionName?: string;
      contextUsage?: number;
      usageStats?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        totalCostUsd: number;
        contextWindow: number;
      };
      success?: boolean;
      elapsedTimeMs?: number;
      validated?: boolean;
    }) =>
      ipcRenderer.invoke('history:add', entry),
    clear: (projectPath?: string) =>
      ipcRenderer.invoke('history:clear', projectPath),
    delete: (entryId: string, sessionId?: string) =>
      ipcRenderer.invoke('history:delete', entryId, sessionId),
    update: (entryId: string, updates: { validated?: boolean }, sessionId?: string) =>
      ipcRenderer.invoke('history:update', entryId, updates, sessionId),
    // Update sessionName for all entries matching a agentSessionId (used when renaming tabs)
    updateSessionName: (agentSessionId: string, sessionName: string) =>
      ipcRenderer.invoke('history:updateSessionName', agentSessionId, sessionName),
    // NEW: Get history file path for AI context integration
    getFilePath: (sessionId: string) =>
      ipcRenderer.invoke('history:getFilePath', sessionId),
    // NEW: List sessions with history
    listSessions: () =>
      ipcRenderer.invoke('history:listSessions'),
    onExternalChange: (handler: () => void) => {
      const wrappedHandler = () => handler();
      ipcRenderer.on('history:externalChange', wrappedHandler);
      return () => ipcRenderer.removeListener('history:externalChange', wrappedHandler);
    },
    reload: () => ipcRenderer.invoke('history:reload'),
  },

  // CLI activity API (for detecting when CLI is running playbooks)
  cli: {
    getActivity: () => ipcRenderer.invoke('cli:getActivity'),
    onActivityChange: (handler: () => void) => {
      const wrappedHandler = () => handler();
      ipcRenderer.on('cli:activityChange', wrappedHandler);
      return () => ipcRenderer.removeListener('cli:activityChange', wrappedHandler);
    },
  },

  // Notification API
  notification: {
    show: (title: string, body: string) =>
      ipcRenderer.invoke('notification:show', title, body),
    speak: (text: string, command?: string) =>
      ipcRenderer.invoke('notification:speak', text, command),
    stopSpeak: (ttsId: number) =>
      ipcRenderer.invoke('notification:stopSpeak', ttsId),
    onTtsCompleted: (handler: (ttsId: number) => void) => {
      const wrappedHandler = (_event: Electron.IpcRendererEvent, ttsId: number) => handler(ttsId);
      ipcRenderer.on('tts:completed', wrappedHandler);
      return () => ipcRenderer.removeListener('tts:completed', wrappedHandler);
    },
  },

  // Attachments API (per-session image storage for scratchpad)
  attachments: {
    save: (sessionId: string, base64Data: string, filename: string) =>
      ipcRenderer.invoke('attachments:save', sessionId, base64Data, filename),
    load: (sessionId: string, filename: string) =>
      ipcRenderer.invoke('attachments:load', sessionId, filename),
    delete: (sessionId: string, filename: string) =>
      ipcRenderer.invoke('attachments:delete', sessionId, filename),
    list: (sessionId: string) =>
      ipcRenderer.invoke('attachments:list', sessionId),
    getPath: (sessionId: string) =>
      ipcRenderer.invoke('attachments:getPath', sessionId),
  },

  // Auto Run API (file-system-based document runner)
  autorun: {
    listDocs: (folderPath: string) =>
      ipcRenderer.invoke('autorun:listDocs', folderPath),
    readDoc: (folderPath: string, filename: string) =>
      ipcRenderer.invoke('autorun:readDoc', folderPath, filename),
    writeDoc: (folderPath: string, filename: string, content: string) =>
      ipcRenderer.invoke('autorun:writeDoc', folderPath, filename, content),
    saveImage: (
      folderPath: string,
      docName: string,
      base64Data: string,
      extension: string
    ) =>
      ipcRenderer.invoke(
        'autorun:saveImage',
        folderPath,
        docName,
        base64Data,
        extension
      ),
    deleteImage: (folderPath: string, relativePath: string) =>
      ipcRenderer.invoke('autorun:deleteImage', folderPath, relativePath),
    listImages: (folderPath: string, docName: string) =>
      ipcRenderer.invoke('autorun:listImages', folderPath, docName),
    deleteFolder: (projectPath: string) =>
      ipcRenderer.invoke('autorun:deleteFolder', projectPath),
    // File watching for live updates
    watchFolder: (folderPath: string) =>
      ipcRenderer.invoke('autorun:watchFolder', folderPath),
    unwatchFolder: (folderPath: string) =>
      ipcRenderer.invoke('autorun:unwatchFolder', folderPath),
    onFileChanged: (handler: (data: { folderPath: string; filename: string; eventType: string }) => void) => {
      const wrappedHandler = (_event: Electron.IpcRendererEvent, data: { folderPath: string; filename: string; eventType: string }) => handler(data);
      ipcRenderer.on('autorun:fileChanged', wrappedHandler);
      return () => ipcRenderer.removeListener('autorun:fileChanged', wrappedHandler);
    },
    // Backup operations for reset-on-completion documents
    createBackup: (folderPath: string, filename: string) =>
      ipcRenderer.invoke('autorun:createBackup', folderPath, filename),
    restoreBackup: (folderPath: string, filename: string) =>
      ipcRenderer.invoke('autorun:restoreBackup', folderPath, filename),
    deleteBackups: (folderPath: string) =>
      ipcRenderer.invoke('autorun:deleteBackups', folderPath),
  },

  // Playbooks API (saved batch run configurations)
  playbooks: {
    list: (sessionId: string) =>
      ipcRenderer.invoke('playbooks:list', sessionId),
    create: (
      sessionId: string,
      playbook: {
        name: string;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      }
    ) => ipcRenderer.invoke('playbooks:create', sessionId, playbook),
    update: (
      sessionId: string,
      playbookId: string,
      updates: Partial<{
        name: string;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        updatedAt: number;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      }>
    ) => ipcRenderer.invoke('playbooks:update', sessionId, playbookId, updates),
    delete: (sessionId: string, playbookId: string) =>
      ipcRenderer.invoke('playbooks:delete', sessionId, playbookId),
    deleteAll: (sessionId: string) =>
      ipcRenderer.invoke('playbooks:deleteAll', sessionId),
    export: (sessionId: string, playbookId: string, autoRunFolderPath: string) =>
      ipcRenderer.invoke('playbooks:export', sessionId, playbookId, autoRunFolderPath),
    import: (sessionId: string, autoRunFolderPath: string) =>
      ipcRenderer.invoke('playbooks:import', sessionId, autoRunFolderPath),
  },

  // Debug Package API (generate support bundles for bug reporting)
  debug: {
    createPackage: (options?: {
      includeLogs?: boolean;
      includeErrors?: boolean;
      includeSessions?: boolean;
      includeGroupChats?: boolean;
      includeBatchState?: boolean;
    }) => ipcRenderer.invoke('debug:createPackage', options),
    previewPackage: () => ipcRenderer.invoke('debug:previewPackage'),
  },

  // Group Chat API (multi-agent coordination)
  groupChat: {
    // Storage
    create: (
      name: string,
      moderatorAgentId: string,
      moderatorConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string> }
    ) =>
      ipcRenderer.invoke('groupChat:create', name, moderatorAgentId, moderatorConfig),
    list: () =>
      ipcRenderer.invoke('groupChat:list'),
    load: (id: string) =>
      ipcRenderer.invoke('groupChat:load', id),
    delete: (id: string) =>
      ipcRenderer.invoke('groupChat:delete', id),
    rename: (id: string, name: string) =>
      ipcRenderer.invoke('groupChat:rename', id, name),
    update: (
      id: string,
      updates: {
        name?: string;
        moderatorAgentId?: string;
        moderatorConfig?: { customPath?: string; customArgs?: string; customEnvVars?: Record<string, string> };
      }
    ) =>
      ipcRenderer.invoke('groupChat:update', id, updates),

    // Chat log
    appendMessage: (id: string, from: string, content: string) =>
      ipcRenderer.invoke('groupChat:appendMessage', id, from, content),
    getMessages: (id: string) =>
      ipcRenderer.invoke('groupChat:getMessages', id),
    saveImage: (id: string, imageData: string, filename: string) =>
      ipcRenderer.invoke('groupChat:saveImage', id, imageData, filename),

    // Moderator
    startModerator: (id: string) =>
      ipcRenderer.invoke('groupChat:startModerator', id),
    sendToModerator: (id: string, message: string, images?: string[], readOnly?: boolean) =>
      ipcRenderer.invoke('groupChat:sendToModerator', id, message, images, readOnly),
    stopModerator: (id: string) =>
      ipcRenderer.invoke('groupChat:stopModerator', id),
    getModeratorSessionId: (id: string) =>
      ipcRenderer.invoke('groupChat:getModeratorSessionId', id),

    // Participants
    addParticipant: (id: string, name: string, agentId: string, cwd?: string) =>
      ipcRenderer.invoke('groupChat:addParticipant', id, name, agentId, cwd),
    sendToParticipant: (id: string, name: string, message: string, images?: string[]) =>
      ipcRenderer.invoke('groupChat:sendToParticipant', id, name, message, images),
    removeParticipant: (id: string, name: string) =>
      ipcRenderer.invoke('groupChat:removeParticipant', id, name),

    // History
    getHistory: (id: string) =>
      ipcRenderer.invoke('groupChat:getHistory', id),
    addHistoryEntry: (id: string, entry: {
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }) =>
      ipcRenderer.invoke('groupChat:addHistoryEntry', id, entry),
    deleteHistoryEntry: (groupChatId: string, entryId: string) =>
      ipcRenderer.invoke('groupChat:deleteHistoryEntry', groupChatId, entryId),
    clearHistory: (id: string) =>
      ipcRenderer.invoke('groupChat:clearHistory', id),
    getHistoryFilePath: (id: string) =>
      ipcRenderer.invoke('groupChat:getHistoryFilePath', id),

    // Export
    getImages: (id: string) =>
      ipcRenderer.invoke('groupChat:getImages', id) as Promise<Record<string, string>>,

    // Events
    onMessage: (callback: (groupChatId: string, message: {
      timestamp: string;
      from: string;
      content: string;
    }) => void) => {
      const handler = (_: any, groupChatId: string, message: any) => callback(groupChatId, message);
      ipcRenderer.on('groupChat:message', handler);
      return () => ipcRenderer.removeListener('groupChat:message', handler);
    },
    onStateChange: (callback: (groupChatId: string, state: 'idle' | 'moderator-thinking' | 'agent-working') => void) => {
      const handler = (_: any, groupChatId: string, state: 'idle' | 'moderator-thinking' | 'agent-working') => callback(groupChatId, state);
      ipcRenderer.on('groupChat:stateChange', handler);
      return () => ipcRenderer.removeListener('groupChat:stateChange', handler);
    },
    onParticipantsChanged: (callback: (groupChatId: string, participants: Array<{
      name: string;
      agentId: string;
      sessionId: string;
      addedAt: number;
    }>) => void) => {
      const handler = (_: any, groupChatId: string, participants: any[]) => callback(groupChatId, participants);
      ipcRenderer.on('groupChat:participantsChanged', handler);
      return () => ipcRenderer.removeListener('groupChat:participantsChanged', handler);
    },
    onModeratorUsage: (callback: (groupChatId: string, usage: {
      contextUsage: number;
      totalCost: number;
      tokenCount: number;
    }) => void) => {
      const handler = (_: any, groupChatId: string, usage: any) => callback(groupChatId, usage);
      ipcRenderer.on('groupChat:moderatorUsage', handler);
      return () => ipcRenderer.removeListener('groupChat:moderatorUsage', handler);
    },
    onHistoryEntry: (callback: (groupChatId: string, entry: {
      id: string;
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }) => void) => {
      const handler = (_: any, groupChatId: string, entry: any) => callback(groupChatId, entry);
      ipcRenderer.on('groupChat:historyEntry', handler);
      return () => ipcRenderer.removeListener('groupChat:historyEntry', handler);
    },
    onParticipantState: (callback: (groupChatId: string, participantName: string, state: 'idle' | 'working') => void) => {
      const handler = (_: any, groupChatId: string, participantName: string, state: 'idle' | 'working') => callback(groupChatId, participantName, state);
      ipcRenderer.on('groupChat:participantState', handler);
      return () => ipcRenderer.removeListener('groupChat:participantState', handler);
    },
    onModeratorSessionIdChanged: (callback: (groupChatId: string, sessionId: string) => void) => {
      const handler = (_: any, groupChatId: string, sessionId: string) => callback(groupChatId, sessionId);
      ipcRenderer.on('groupChat:moderatorSessionIdChanged', handler);
      return () => ipcRenderer.removeListener('groupChat:moderatorSessionIdChanged', handler);
    },
  },

  // Leaderboard API (runmaestro.ai integration)
  leaderboard: {
    submit: (data: {
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
      currentRunMs?: number;
      theme?: string;
      clientToken?: string;
      authToken?: string;
    }) => ipcRenderer.invoke('leaderboard:submit', data),
    pollAuthStatus: (clientToken: string) =>
      ipcRenderer.invoke('leaderboard:pollAuthStatus', clientToken),
    get: (options?: { limit?: number }) =>
      ipcRenderer.invoke('leaderboard:get', options),
    getLongestRuns: (options?: { limit?: number }) =>
      ipcRenderer.invoke('leaderboard:getLongestRuns', options),
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
    getActiveProcesses: () => Promise<Array<{
      sessionId: string;
      toolType: string;
      pid: number;
      cwd: string;
      isTerminal: boolean;
      isBatchMode: boolean;
      startTime: number;
      command?: string;
      args?: string[];
    }>>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onSessionId: (callback: (sessionId: string, agentSessionId: string) => void) => () => void;
    onSlashCommands: (callback: (sessionId: string, slashCommands: string[]) => void) => () => void;
    onThinkingChunk: (callback: (sessionId: string, content: string) => void) => () => void;
    onToolExecution: (callback: (sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => void) => () => void;
    onRemoteCommand: (callback: (sessionId: string, command: string) => void) => () => void;
    onRemoteSwitchMode: (callback: (sessionId: string, mode: 'ai' | 'terminal') => void) => () => void;
    onRemoteInterrupt: (callback: (sessionId: string) => void) => () => void;
    onRemoteSelectSession: (callback: (sessionId: string) => void) => () => void;
    onStderr: (callback: (sessionId: string, data: string) => void) => () => void;
    onCommandExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onUsage: (callback: (sessionId: string, usageStats: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      totalCostUsd: number;
      contextWindow: number;
      reasoningTokens?: number;
    }) => void) => () => void;
    onAgentError: (callback: (sessionId: string, error: {
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
    }) => void) => () => void;
  };
  agentError: {
    clearError: (sessionId: string) => Promise<{ success: boolean }>;
    retryAfterError: (sessionId: string, options?: {
      prompt?: string;
      newSession?: boolean;
    }) => Promise<{ success: boolean }>;
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
    showFile: (cwd: string, ref: string, filePath: string) => Promise<{ content?: string; error?: string }>;
    // Git worktree operations for Auto Run parallelization
    worktreeInfo: (worktreePath: string) => Promise<{
      success: boolean;
      exists?: boolean;
      isWorktree?: boolean;
      currentBranch?: string;
      repoRoot?: string;
      error?: string;
    }>;
    getRepoRoot: (cwd: string) => Promise<{
      success: boolean;
      root?: string;
      error?: string;
    }>;
    worktreeSetup: (mainRepoCwd: string, worktreePath: string, branchName: string) => Promise<{
      success: boolean;
      created?: boolean;
      currentBranch?: string;
      requestedBranch?: string;
      branchMismatch?: boolean;
      error?: string;
    }>;
    worktreeCheckout: (worktreePath: string, branchName: string, createIfMissing: boolean) => Promise<{
      success: boolean;
      hasUncommittedChanges: boolean;
      error?: string;
    }>;
    createPR: (worktreePath: string, baseBranch: string, title: string, body: string, ghPath?: string) => Promise<{
      success: boolean;
      prUrl?: string;
      error?: string;
    }>;
    getDefaultBranch: (cwd: string) => Promise<{
      success: boolean;
      branch?: string;
      error?: string;
    }>;
    checkGhCli: (ghPath?: string) => Promise<{
      installed: boolean;
      authenticated: boolean;
    }>;
    listWorktrees: (cwd: string) => Promise<{
      worktrees: Array<{
        path: string;
        head: string;
        branch: string | null;
        isBare: boolean;
      }>;
    }>;
    scanWorktreeDirectory: (parentPath: string) => Promise<{
      gitSubdirs: Array<{
        path: string;
        name: string;
        isWorktree: boolean;
        branch: string | null;
        repoRoot: string | null;
      }>;
    }>;
  };
  fs: {
    homeDir: () => Promise<string>;
    readDir: (dirPath: string) => Promise<DirectoryEntry[]>;
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean }>;
    stat: (filePath: string) => Promise<{
      size: number;
      createdAt: string;
      modifiedAt: string;
      isDirectory: boolean;
      isFile: boolean;
    }>;
  };
  webserver: {
    getUrl: () => Promise<string>;
    getConnectedClients: () => Promise<number>;
  };
  live: {
    toggle: (sessionId: string, agentSessionId?: string) => Promise<{ live: boolean; url: string | null }>;
    getStatus: (sessionId: string) => Promise<{ live: boolean; url: string | null }>;
    getDashboardUrl: () => Promise<string | null>;
    getLiveSessions: () => Promise<Array<{ sessionId: string; agentSessionId?: string; enabledAt: number }>>;
    broadcastActiveSession: (sessionId: string) => Promise<void>;
    disableAll: () => Promise<{ success: boolean; count: number }>;
    startServer: () => Promise<{ success: boolean; url?: string; error?: string }>;
    stopServer: () => Promise<{ success: boolean }>;
  };
  agents: {
    detect: () => Promise<AgentConfig[]>;
    get: (agentId: string) => Promise<AgentConfig | null>;
    getCapabilities: (agentId: string) => Promise<AgentCapabilities>;
    getConfig: (agentId: string) => Promise<Record<string, any>>;
    setConfig: (agentId: string, config: Record<string, any>) => Promise<boolean>;
    getConfigValue: (agentId: string, key: string) => Promise<any>;
    setConfigValue: (agentId: string, key: string, value: any) => Promise<boolean>;
    setCustomPath: (agentId: string, customPath: string | null) => Promise<boolean>;
    getCustomPath: (agentId: string) => Promise<string | null>;
    getAllCustomPaths: () => Promise<Record<string, string>>;
    setCustomArgs: (agentId: string, customArgs: string | null) => Promise<boolean>;
    getCustomArgs: (agentId: string) => Promise<string | null>;
    getAllCustomArgs: () => Promise<Record<string, string>>;
    setCustomEnvVars: (agentId: string, customEnvVars: Record<string, string> | null) => Promise<boolean>;
    getCustomEnvVars: (agentId: string) => Promise<Record<string, string> | null>;
    getAllCustomEnvVars: () => Promise<Record<string, Record<string, string>>>;
    getModels: (agentId: string, forceRefresh?: boolean) => Promise<string[]>;
    discoverSlashCommands: (agentId: string, cwd: string, customPath?: string) => Promise<string[] | null>;
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
  tunnel: {
    isCloudflaredInstalled: () => Promise<boolean>;
    start: () => Promise<{ success: boolean; url?: string; error?: string }>;
    stop: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<{ isRunning: boolean; url: string | null; error: string | null }>;
  };
  sync: {
    getDefaultPath: () => Promise<string>;
    getSettings: () => Promise<{
      customSyncPath?: string;
    }>;
    getCurrentStoragePath: () => Promise<string>;
    selectSyncFolder: () => Promise<string | null>;
    setCustomPath: (customPath: string | null) => Promise<{
      success: boolean;
      migrated?: number;
      errors?: string[];
      requiresRestart?: boolean;
      error?: string;
    }>;
  };
  devtools: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    toggle: () => Promise<void>;
  };
  updates: {
    check: () => Promise<{
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      versionsBehind: number;
      releases: Array<{
        tag_name: string;
        name: string;
        body: string;
        html_url: string;
        published_at: string;
      }>;
      releasesUrl: string;
      error?: string;
    }>;
    download: () => Promise<{ success: boolean; error?: string }>;
    install: () => Promise<void>;
    getStatus: () => Promise<{
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
      info?: { version: string };
      progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
      error?: string;
    }>;
    onStatus: (callback: (status: {
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
      info?: { version: string };
      progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
      error?: string;
    }) => void) => () => void;
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
    onNewLog: (callback: (log: { timestamp: number; level: string; message: string; context?: string; data?: unknown }) => void) => () => void;
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
    // Paginated version for better performance with many sessions
    listSessionsPaginated: (projectPath: string, options?: { cursor?: string; limit?: number }) => Promise<{
      sessions: Array<{
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
        origin?: 'user' | 'auto';
        sessionName?: string;
      }>;
      hasMore: boolean;
      totalCount: number;
      nextCursor: string | null;
    }>;
    // Get aggregate stats for all sessions in a project
    getProjectStats: (projectPath: string) => Promise<{
      totalSessions: number;
      totalMessages: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      oldestTimestamp: string | null;
    }>;
    onProjectStatsUpdate: (callback: (stats: {
      projectPath: string;
      totalSessions: number;
      totalMessages: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      oldestTimestamp: string | null;
      processedCount: number;
      isComplete: boolean;
    }) => void) => () => void;
    onGlobalStatsUpdate: (callback: (stats: {
      totalSessions: number;
      totalMessages: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      isComplete: boolean;
    }) => void) => () => void;
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
    registerSessionOrigin: (projectPath: string, agentSessionId: string, origin: 'user' | 'auto', sessionName?: string) => Promise<boolean>;
    updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) => Promise<boolean>;
    updateSessionStarred: (projectPath: string, agentSessionId: string, starred: boolean) => Promise<boolean>;
    getSessionOrigins: (projectPath: string) => Promise<Record<string, 'user' | 'auto' | { origin: 'user' | 'auto'; sessionName?: string; starred?: boolean }>>;
    deleteMessagePair: (projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) => Promise<{ success: boolean; linesRemoved?: number; error?: string }>;
  };
  agentSessions: {
    list: (agentId: string, projectPath: string) => Promise<Array<{
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
      origin?: 'user' | 'auto';
      sessionName?: string;
      starred?: boolean;
    }>>;
    listPaginated: (agentId: string, projectPath: string, options?: { cursor?: string; limit?: number }) => Promise<{
      sessions: Array<{
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
        origin?: 'user' | 'auto';
        sessionName?: string;
        starred?: boolean;
      }>;
      hasMore: boolean;
      totalCount: number;
      nextCursor: string | null;
    }>;
    read: (agentId: string, projectPath: string, sessionId: string, options?: { offset?: number; limit?: number }) => Promise<{
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
    search: (agentId: string, projectPath: string, query: string, searchMode: 'title' | 'user' | 'assistant' | 'all') => Promise<Array<{
      sessionId: string;
      matchType: 'title' | 'user' | 'assistant';
      matchPreview: string;
      matchCount: number;
    }>>;
    getPath: (agentId: string, projectPath: string, sessionId: string) => Promise<string | null>;
    deleteMessagePair: (agentId: string, projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) => Promise<{ success: boolean; linesRemoved?: number; error?: string }>;
    hasStorage: (agentId: string) => Promise<boolean>;
    getAvailableStorages: () => Promise<string[]>;
    getAllNamedSessions: () => Promise<Array<{
      agentSessionId: string;
      projectPath: string;
      sessionName: string;
      starred?: boolean;
      lastActivityAt?: number;
    }>>;
    registerSessionOrigin: (projectPath: string, agentSessionId: string, origin: 'user' | 'auto', sessionName?: string) => Promise<boolean>;
    updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) => Promise<boolean>;
    // Generic session origins API (for non-Claude agents like Codex, OpenCode)
    getOrigins: (agentId: string, projectPath: string) => Promise<Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>>;
    setSessionName: (agentId: string, projectPath: string, sessionId: string, sessionName: string | null) => Promise<void>;
    setSessionStarred: (agentId: string, projectPath: string, sessionId: string, starred: boolean) => Promise<void>;
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
      fullResponse?: string;
      agentSessionId?: string;
      projectPath: string;
      sessionId?: string;
      sessionName?: string;
      contextUsage?: number;
      usageStats?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        totalCostUsd: number;
        contextWindow: number;
      };
      success?: boolean;
      elapsedTimeMs?: number;
      validated?: boolean;
    }>>;
    getAllPaginated: (options?: {
      projectPath?: string;
      sessionId?: string;
      pagination?: { limit?: number; offset?: number };
    }) => Promise<{
      entries: Array<{
        id: string;
        type: 'AUTO' | 'USER';
        timestamp: number;
        summary: string;
        fullResponse?: string;
        agentSessionId?: string;
        projectPath: string;
        sessionId?: string;
        sessionName?: string;
        contextUsage?: number;
        usageStats?: {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          totalCostUsd: number;
          contextWindow: number;
        };
        success?: boolean;
        elapsedTimeMs?: number;
        validated?: boolean;
      }>;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    }>;
    add: (entry: {
      id: string;
      type: 'AUTO' | 'USER';
      timestamp: number;
      summary: string;
      fullResponse?: string;
      agentSessionId?: string;
      projectPath: string;
      sessionId?: string;
      sessionName?: string;
      contextUsage?: number;
      usageStats?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        totalCostUsd: number;
        contextWindow: number;
      };
      success?: boolean;
      elapsedTimeMs?: number;
      validated?: boolean;
    }) => Promise<boolean>;
    clear: (projectPath?: string) => Promise<boolean>;
    delete: (entryId: string, sessionId?: string) => Promise<boolean>;
    update: (entryId: string, updates: { validated?: boolean }, sessionId?: string) => Promise<boolean>;
    // Update sessionName for all entries matching a agentSessionId (used when renaming tabs)
    updateSessionName: (agentSessionId: string, sessionName: string) => Promise<number>;
    onExternalChange: (handler: () => void) => () => void;
    reload: () => Promise<boolean>;
    // NEW: Get history file path for AI context integration
    getFilePath: (sessionId: string) => Promise<string | null>;
    // NEW: List sessions with history
    listSessions: () => Promise<string[]>;
  };
  cli: {
    getActivity: () => Promise<Array<{
      sessionId: string;
      playbookId: string;
      playbookName: string;
      startedAt: number;
      pid: number;
      currentTask?: string;
      currentDocument?: string;
    }>>;
    onActivityChange: (handler: () => void) => () => void;
  };
  notification: {
    show: (title: string, body: string) => Promise<{ success: boolean; error?: string }>;
    speak: (text: string, command?: string) => Promise<{ success: boolean; ttsId?: number; error?: string }>;
    stopSpeak: (ttsId: number) => Promise<{ success: boolean; error?: string }>;
    onTtsCompleted: (handler: (ttsId: number) => void) => () => void;
  };
  attachments: {
    save: (sessionId: string, base64Data: string, filename: string) => Promise<{ success: boolean; path?: string; filename?: string; error?: string }>;
    load: (sessionId: string, filename: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
    delete: (sessionId: string, filename: string) => Promise<{ success: boolean; error?: string }>;
    list: (sessionId: string) => Promise<{ success: boolean; files: string[]; error?: string }>;
    getPath: (sessionId: string) => Promise<{ success: boolean; path: string }>;
  };
  autorun: {
    listDocs: (
      folderPath: string
    ) => Promise<{ success: boolean; files: string[]; error?: string }>;
    readDoc: (
      folderPath: string,
      filename: string
    ) => Promise<{ success: boolean; content?: string; error?: string }>;
    writeDoc: (
      folderPath: string,
      filename: string,
      content: string
    ) => Promise<{ success: boolean; error?: string }>;
    saveImage: (
      folderPath: string,
      docName: string,
      base64Data: string,
      extension: string
    ) => Promise<{ success: boolean; relativePath?: string; error?: string }>;
    deleteImage: (
      folderPath: string,
      relativePath: string
    ) => Promise<{ success: boolean; error?: string }>;
    listImages: (
      folderPath: string,
      docName: string
    ) => Promise<{
      success: boolean;
      images?: { filename: string; relativePath: string }[];
      error?: string;
    }>;
    deleteFolder: (
      projectPath: string
    ) => Promise<{ success: boolean; error?: string }>;
    watchFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
    unwatchFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
    onFileChanged: (handler: (data: { folderPath: string; filename: string; eventType: string }) => void) => () => void;
    createBackup: (folderPath: string, filename: string) => Promise<{ success: boolean; backupFilename?: string; error?: string }>;
    restoreBackup: (folderPath: string, filename: string) => Promise<{ success: boolean; error?: string }>;
    deleteBackups: (folderPath: string) => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
  };
  playbooks: {
    list: (sessionId: string) => Promise<{
      success: boolean;
      playbooks: Array<{
        id: string;
        name: string;
        createdAt: number;
        updatedAt: number;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      }>;
      error?: string;
    }>;
    create: (
      sessionId: string,
      playbook: {
        name: string;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      }
    ) => Promise<{
      success: boolean;
      playbook?: {
        id: string;
        name: string;
        createdAt: number;
        updatedAt: number;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      };
      error?: string;
    }>;
    update: (
      sessionId: string,
      playbookId: string,
      updates: Partial<{
        name: string;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        updatedAt: number;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      }>
    ) => Promise<{
      success: boolean;
      playbook?: {
        id: string;
        name: string;
        createdAt: number;
        updatedAt: number;
        documents: Array<{ filename: string; resetOnCompletion: boolean }>;
        loopEnabled: boolean;
        maxLoops?: number | null;
        prompt: string;
        worktreeSettings?: {
          branchNameTemplate: string;
          createPROnCompletion: boolean;
          prTargetBranch?: string;
        };
      };
      error?: string;
    }>;
    delete: (sessionId: string, playbookId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    deleteAll: (sessionId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
  };
  debug: {
    createPackage: (options?: {
      includeLogs?: boolean;
      includeErrors?: boolean;
      includeSessions?: boolean;
      includeGroupChats?: boolean;
      includeBatchState?: boolean;
    }) => Promise<{
      success: boolean;
      path?: string;
      filesIncluded: string[];
      totalSizeBytes: number;
      cancelled?: boolean;
      error?: string;
    }>;
    previewPackage: () => Promise<{
      success: boolean;
      categories: Array<{
        id: string;
        name: string;
        included: boolean;
        sizeEstimate: string;
      }>;
      error?: string;
    }>;
  };
  groupChat: {
    // Storage
    create: (name: string, moderatorAgentId: string) => Promise<{
      id: string;
      name: string;
      moderatorAgentId: string;
      moderatorSessionId: string;
      participants: Array<{
        name: string;
        agentId: string;
        sessionId: string;
        addedAt: number;
      }>;
      logPath: string;
      imagesDir: string;
      createdAt: number;
    }>;
    list: () => Promise<Array<{
      id: string;
      name: string;
      moderatorAgentId: string;
      moderatorSessionId: string;
      participants: Array<{
        name: string;
        agentId: string;
        sessionId: string;
        addedAt: number;
      }>;
      logPath: string;
      imagesDir: string;
      createdAt: number;
    }>>;
    load: (id: string) => Promise<{
      id: string;
      name: string;
      moderatorAgentId: string;
      moderatorSessionId: string;
      participants: Array<{
        name: string;
        agentId: string;
        sessionId: string;
        addedAt: number;
      }>;
      logPath: string;
      imagesDir: string;
      createdAt: number;
    } | null>;
    delete: (id: string) => Promise<boolean>;
    rename: (id: string, name: string) => Promise<{
      id: string;
      name: string;
      moderatorAgentId: string;
      moderatorSessionId: string;
      participants: Array<{
        name: string;
        agentId: string;
        sessionId: string;
        addedAt: number;
      }>;
      logPath: string;
      imagesDir: string;
      createdAt: number;
    }>;

    // Chat log
    appendMessage: (id: string, from: string, content: string) => Promise<void>;
    getMessages: (id: string) => Promise<Array<{
      timestamp: string;
      from: string;
      content: string;
    }>>;
    saveImage: (id: string, imageData: string, filename: string) => Promise<string>;

    // Moderator
    startModerator: (id: string) => Promise<string>;
    sendToModerator: (id: string, message: string, images?: string[], readOnly?: boolean) => Promise<void>;
    stopModerator: (id: string) => Promise<void>;
    getModeratorSessionId: (id: string) => Promise<string | null>;

    // Participants
    addParticipant: (id: string, name: string, agentId: string, cwd?: string) => Promise<{
      name: string;
      agentId: string;
      sessionId: string;
      addedAt: number;
    }>;
    sendToParticipant: (id: string, name: string, message: string, images?: string[]) => Promise<void>;
    removeParticipant: (id: string, name: string) => Promise<void>;

    // History
    getHistory: (id: string) => Promise<Array<{
      id: string;
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }>>;
    addHistoryEntry: (id: string, entry: {
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }) => Promise<{
      id: string;
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }>;
    deleteHistoryEntry: (groupChatId: string, entryId: string) => Promise<boolean>;
    clearHistory: (id: string) => Promise<void>;
    getHistoryFilePath: (id: string) => Promise<string | null>;

    // Export
    getImages: (id: string) => Promise<Record<string, string>>;

    // Events
    onMessage: (callback: (groupChatId: string, message: {
      timestamp: string;
      from: string;
      content: string;
    }) => void) => () => void;
    onStateChange: (callback: (groupChatId: string, state: 'idle' | 'moderator-thinking' | 'agent-working') => void) => () => void;
    onParticipantsChanged: (callback: (groupChatId: string, participants: Array<{
      name: string;
      agentId: string;
      sessionId: string;
      addedAt: number;
    }>) => void) => () => void;
    onModeratorUsage: (callback: (groupChatId: string, usage: {
      contextUsage: number;
      totalCost: number;
      tokenCount: number;
    }) => void) => () => void;
    onHistoryEntry: (callback: (groupChatId: string, entry: {
      id: string;
      timestamp: number;
      summary: string;
      participantName: string;
      participantColor: string;
      type: 'delegation' | 'response' | 'synthesis' | 'error';
      elapsedTimeMs?: number;
      tokenCount?: number;
      cost?: number;
      fullResponse?: string;
    }) => void) => () => void;
    onParticipantState?: (callback: (groupChatId: string, participantName: string, state: 'idle' | 'working') => void) => () => void;
    onModeratorSessionIdChanged?: (callback: (groupChatId: string, sessionId: string) => void) => () => void;
  };
  leaderboard: {
    submit: (data: {
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
      currentRunMs?: number;
      clientToken?: string;
      authToken?: string;
    }) => Promise<{
      success: boolean;
      message: string;
      pendingEmailConfirmation?: boolean;
      error?: string;
      authTokenRequired?: boolean;
    }>;
    pollAuthStatus: (clientToken: string) => Promise<{
      status: 'pending' | 'confirmed' | 'expired' | 'error';
      authToken?: string;
      message?: string;
      error?: string;
    }>;
    get: (options?: { limit?: number }) => Promise<{
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
    }>;
    getLongestRuns: (options?: { limit?: number }) => Promise<{
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
    }>;
  };
}

declare global {
  interface Window {
    maestro: MaestroAPI;
  }
}
