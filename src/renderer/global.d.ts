/**
 * Global type declarations for the renderer process.
 * This file makes the window.maestro API available throughout the renderer.
 */

// Vite raw imports for .md files
declare module '*.md?raw' {
  const content: string;
  export default content;
}

type AutoRunTreeNode = {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: AutoRunTreeNode[];
};

interface ProcessConfig {
  sessionId: string;
  toolType: string;
  cwd: string;
  command: string;
  args: string[];
  prompt?: string;
  shell?: string;
  images?: string[];
  // Agent-specific spawn options (used to build args via agent config)
  agentSessionId?: string;
  readOnlyMode?: boolean;
  modelId?: string;
  yoloMode?: boolean;
  // Per-session overrides (take precedence over agent-level config)
  sessionCustomPath?: string;
  sessionCustomArgs?: string;
  sessionCustomEnvVars?: Record<string, string>;
  sessionCustomModel?: string;
  sessionCustomContextWindow?: number;
}

interface AgentConfigOption {
  key: string;
  type: 'checkbox' | 'text' | 'number' | 'select';
  label: string;
  description: string;
  default: any;
  options?: string[];
}

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
  supportsContextMerge: boolean;
  supportsContextExport: boolean;
}

interface AgentConfig {
  id: string;
  name: string;
  binaryName?: string;
  available: boolean;
  path?: string;
  command: string;
  args?: string[];
  hidden?: boolean;
  configOptions?: AgentConfigOption[];
  capabilities?: AgentCapabilities;
}

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
  supportsContextMerge: boolean;
  supportsContextExport: boolean;
}

interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

interface ShellInfo {
  id: string;
  name: string;
  available: boolean;
  path?: string;
}

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  reasoningTokens?: number;  // Separate reasoning tokens (Codex o3/o4-mini)
}

type HistoryEntryType = 'AUTO' | 'USER';

/**
 * Result type for reading session messages from agent storage.
 * Used by context merging operations.
 */
interface SessionMessagesResult {
  messages: Array<{
    type: string;
    role?: string;
    content: string;
    timestamp: string;
    uuid: string;
    toolUse?: unknown;
  }>;
  total: number;
  hasMore: boolean;
}

interface MaestroAPI {
  // Context merging API (for session context transfer and grooming)
  context: {
    getStoredSession: (agentId: string, projectRoot: string, sessionId: string) => Promise<SessionMessagesResult | null>;
    // NEW: Single-call grooming (recommended) - spawns batch process and returns response
    groomContext: (projectRoot: string, agentType: string, prompt: string) => Promise<string>;
    // DEPRECATED: Use groomContext instead
    createGroomingSession: (projectRoot: string, agentType: string) => Promise<string>;
    sendGroomingPrompt: (sessionId: string, prompt: string) => Promise<string>;
    cleanupGroomingSession: (sessionId: string) => Promise<void>;
  };
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
    }>>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onSessionId: (callback: (sessionId: string, agentSessionId: string) => void) => () => void;
    onSlashCommands: (callback: (sessionId: string, slashCommands: string[]) => void) => () => void;
    onThinkingChunk: (callback: (sessionId: string, content: string) => void) => () => void;
    onToolExecution: (callback: (sessionId: string, toolEvent: { toolName: string; state?: unknown; timestamp: number }) => void) => () => void;
    onSshRemote: (callback: (sessionId: string, sshRemote: { id: string; name: string; host: string } | null) => void) => () => void;
    onRemoteCommand: (callback: (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void) => () => void;
    onRemoteSwitchMode: (callback: (sessionId: string, mode: 'ai' | 'terminal') => void) => () => void;
    onRemoteInterrupt: (callback: (sessionId: string) => void) => () => void;
    onRemoteSelectSession: (callback: (sessionId: string) => void) => () => void;
    onRemoteSelectTab: (callback: (sessionId: string, tabId: string) => void) => () => void;
    onRemoteNewTab: (callback: (sessionId: string, responseChannel: string) => void) => () => void;
    sendRemoteNewTabResponse: (responseChannel: string, result: { tabId: string } | null) => void;
    onRemoteCloseTab: (callback: (sessionId: string, tabId: string) => void) => () => void;
    onRemoteRenameTab: (callback: (sessionId: string, tabId: string, newName: string) => void) => () => void;
    onStderr: (callback: (sessionId: string, data: string) => void) => () => void;
    onCommandExit: (callback: (sessionId: string, code: number) => void) => () => void;
    onUsage: (callback: (sessionId: string, usageStats: UsageStats) => void) => () => void;
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
      parsedJson?: unknown;
    }) => void) => () => void;
  };
  agentError: {
    clearError: (sessionId: string) => Promise<{ success: boolean }>;
    retryAfterError: (sessionId: string, options?: {
      prompt?: string;
      newSession?: boolean;
    }) => Promise<{ success: boolean }>;
  };
  web: {
    broadcastUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => Promise<void>;
    broadcastAutoRunState: (sessionId: string, state: {
      isRunning: boolean;
      totalTasks: number;
      completedTasks: number;
      currentTaskIndex: number;
      isStopping?: boolean;
    } | null) => Promise<void>;
    broadcastTabsChange: (sessionId: string, aiTabs: Array<{
      id: string;
      agentSessionId: string | null;
      name: string | null;
      starred: boolean;
      inputValue: string;
      usageStats?: UsageStats;
      createdAt: number;
      state: 'idle' | 'busy';
      thinkingStartTime?: number | null;
    }>, activeTabId: string) => Promise<void>;
    broadcastSessionState: (sessionId: string, state: string, additionalData?: {
      name?: string;
      toolType?: string;
      inputMode?: string;
      cwd?: string;
    }) => Promise<boolean>;
  };
  // Git API - all methods accept optional sshRemoteId and remoteCwd for remote execution via SSH
  git: {
    status: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ stdout: string; stderr: string }>;
    diff: (cwd: string, file?: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ stdout: string; stderr: string }>;
    isRepo: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<boolean>;
    numstat: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ stdout: string; stderr: string }>;
    branch: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ stdout: string; stderr: string }>;
    remote: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ stdout: string; stderr: string }>;
    info: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{
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
    branches: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ branches: string[] }>;
    tags: (cwd: string, sshRemoteId?: string, remoteCwd?: string) => Promise<{ tags: string[] }>;
    commitCount: (cwd: string) => Promise<{ count: number; error: string | null }>;
    checkGhCli: (ghPath?: string) => Promise<{ installed: boolean; authenticated: boolean }>;
    createGist: (filename: string, content: string, description: string, isPublic: boolean, ghPath?: string) => Promise<{
      success: boolean;
      gistUrl?: string;
      error?: string;
    }>;
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
    watchWorktreeDirectory: (sessionId: string, worktreePath: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    unwatchWorktreeDirectory: (sessionId: string) => Promise<{
      success: boolean;
    }>;
    removeWorktree: (worktreePath: string, force?: boolean) => Promise<{
      success: boolean;
      error?: string;
      hasUncommittedChanges?: boolean;
    }>;
    onWorktreeDiscovered: (callback: (data: { sessionId: string; worktree: { path: string; name: string; branch: string | null } }) => void) => () => void;
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
    directorySize: (dirPath: string) => Promise<{
      totalSize: number;
      fileCount: number;
      folderCount: number;
    }>;
    fetchImageAsBase64: (url: string) => Promise<string | null>;
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
    stopServer: () => Promise<{ success: boolean; error?: string }>;
  };
  agents: {
    detect: () => Promise<AgentConfig[]>;
    refresh: (agentId?: string) => Promise<{
      agents: AgentConfig[];
      debugInfo: {
        agentId: string;
        available: boolean;
        path: string | null;
        binaryName: string;
        envPath: string;
        homeDir: string;
        platform: string;
        whichCommand: string;
        error: string | null;
      } | null;
    }>;
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
  agentSessions: {
    list: (agentId: string, projectPath: string) => Promise<Array<{
      sessionId: string;
      projectPath: string;
      timestamp: string;
      modifiedAt: string;
      firstMessage: string;
      messageCount: number;
      sizeBytes: number;
      costUsd?: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationSeconds: number;
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
        costUsd?: number;
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
        toolUse?: unknown;
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
    deleteMessagePair: (agentId: string, projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) => Promise<{
      success: boolean;
      error?: string;
      linesRemoved?: number;
    }>;
    hasStorage: (agentId: string) => Promise<boolean>;
    getAvailableStorages: () => Promise<string[]>;
    getGlobalStats: () => Promise<{
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
    }>;
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
    }) => void) => () => void;
    getAllNamedSessions: () => Promise<Array<{
      agentId: string;
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
  dialog: {
    selectFolder: () => Promise<string | null>;
    saveFile: (options: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      title?: string;
    }) => Promise<string | null>;
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
  sshRemote: {
    saveConfig: (config: {
      id?: string;
      name?: string;
      host?: string;
      port?: number;
      username?: string;
      privateKeyPath?: string;
      remoteWorkingDir?: string;
      remoteEnv?: Record<string, string>;
      enabled?: boolean;
    }) => Promise<{
      success: boolean;
      config?: {
        id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        privateKeyPath: string;
        remoteWorkingDir?: string;
        remoteEnv?: Record<string, string>;
        enabled: boolean;
      };
      error?: string;
    }>;
    deleteConfig: (id: string) => Promise<{ success: boolean; error?: string }>;
    getConfigs: () => Promise<{
      success: boolean;
      configs?: Array<{
        id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        privateKeyPath: string;
        remoteWorkingDir?: string;
        remoteEnv?: Record<string, string>;
        enabled: boolean;
      }>;
      error?: string;
    }>;
    getDefaultId: () => Promise<{ success: boolean; id?: string | null; error?: string }>;
    setDefaultId: (id: string | null) => Promise<{ success: boolean; error?: string }>;
    test: (
      configOrId: string | {
        id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        privateKeyPath: string;
        remoteWorkingDir?: string;
        remoteEnv?: Record<string, string>;
        enabled: boolean;
      },
      agentCommand?: string
    ) => Promise<{
      success: boolean;
      result?: {
        success: boolean;
        error?: string;
        remoteInfo?: {
          hostname: string;
          agentVersion?: string;
        };
      };
      error?: string;
    }>;
    getSshConfigHosts: () => Promise<{
      success: boolean;
      hosts: Array<{
        host: string;
        hostName?: string;
        port?: number;
        user?: string;
        identityFile?: string;
        proxyJump?: string;
      }>;
      error?: string;
      configPath: string;
    }>;
  };
  devtools: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    toggle: () => Promise<void>;
  };
  app: {
    onQuitConfirmationRequest: (callback: () => void) => () => void;
    confirmQuit: () => void;
    cancelQuit: () => void;
  };
  logger: {
    log: (level: 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun', message: string, context?: string, data?: unknown) => Promise<void>;
    getLogs: (filter?: { level?: string; context?: string; limit?: number }) => Promise<Array<{
      timestamp: number;
      level: 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun';
      message: string;
      context?: string;
      data?: unknown;
    }>>;
    clearLogs: () => Promise<void>;
    setLogLevel: (level: string) => Promise<void>;
    getLogLevel: () => Promise<string>;
    setMaxLogBuffer: (max: number) => Promise<void>;
    getMaxLogBuffer: () => Promise<number>;
    toast: (title: string, data?: unknown) => Promise<void>;
    autorun: (message: string, context?: string, data?: unknown) => Promise<void>;
    onNewLog: (callback: (log: { timestamp: number; level: 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun'; message: string; context?: string; data?: unknown }) => void) => () => void;
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
      origin?: 'user' | 'auto';
      sessionName?: string;
      starred?: boolean;
    }>>;
    getGlobalStats: () => Promise<{
      totalSessions: number;
      totalMessages: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      isComplete: boolean;
    }>;
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
      totalTokens: number;
      totalCostUsd: number;
      totalSizeBytes: number;
      oldestTimestamp: string | null;
      processedCount: number;
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
    getAllNamedSessions: () => Promise<Array<{
      agentId: string;
      agentSessionId: string;
      projectPath: string;
      sessionName: string;
      starred?: boolean;
      lastActivityAt?: number;
    }>>;
    deleteMessagePair: (projectPath: string, sessionId: string, userMessageUuid: string, fallbackContent?: string) => Promise<{ success: boolean; linesRemoved?: number; error?: string }>;
    getSessionTimestamps: (projectPath: string) => Promise<{ timestamps: string[] }>;
  };
  tempfile: {
    write: (content: string, filename?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
    read: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  history: {
    getAll: (projectPath?: string, sessionId?: string) => Promise<Array<{
      id: string;
      type: HistoryEntryType;
      timestamp: number;
      summary: string;
      fullResponse?: string;
      agentSessionId?: string;
      projectPath: string;
      sessionId?: string;
      sessionName?: string;
      contextUsage?: number;
      usageStats?: UsageStats;
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
        type: HistoryEntryType;
        timestamp: number;
        summary: string;
        fullResponse?: string;
        agentSessionId?: string;
        projectPath: string;
        sessionId?: string;
        sessionName?: string;
        contextUsage?: number;
        usageStats?: UsageStats;
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
      type: HistoryEntryType;
      timestamp: number;
      summary: string;
      fullResponse?: string;
      agentSessionId?: string;
      projectPath: string;
      sessionId?: string;
      sessionName?: string;
      contextUsage?: number;
      usageStats?: UsageStats;
      success?: boolean;
      elapsedTimeMs?: number;
      validated?: boolean;
    }) => Promise<boolean>;
    clear: (projectPath?: string, sessionId?: string) => Promise<boolean>;
    delete: (entryId: string, sessionId?: string) => Promise<boolean>;
    update: (entryId: string, updates: { validated?: boolean }, sessionId?: string) => Promise<boolean>;
    updateSessionName: (agentSessionId: string, sessionName: string) => Promise<number>;
    getFilePath: (sessionId: string) => Promise<string | null>;
    listSessions: () => Promise<string[]>;
    onExternalChange: (handler: () => void) => () => void;
    reload: () => Promise<boolean>;
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
  // Auto Run file operations
  autorun: {
    listDocs: (folderPath: string) => Promise<{
      success: boolean;
      files: string[];
      tree?: AutoRunTreeNode[];
      error?: string;
    }>;
    readDoc: (folderPath: string, filename: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    writeDoc: (folderPath: string, filename: string, content: string) => Promise<{ success: boolean; error?: string }>;
    saveImage: (folderPath: string, docName: string, base64Data: string, extension: string) => Promise<{ success: boolean; relativePath?: string; error?: string }>;
    deleteImage: (folderPath: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
    listImages: (folderPath: string, docName: string) => Promise<{ success: boolean; images?: Array<{ filename: string; relativePath: string }>; error?: string }>;
    deleteFolder: (projectPath: string) => Promise<{ success: boolean; error?: string }>;
    // File watching for live updates
    watchFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
    unwatchFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
    onFileChanged: (handler: (data: { folderPath: string; filename: string; eventType: string }) => void) => () => void;
    // Backup operations for reset-on-completion documents (legacy)
    createBackup: (folderPath: string, filename: string) => Promise<{ success: boolean; backupFilename?: string; error?: string }>;
    restoreBackup: (folderPath: string, filename: string) => Promise<{ success: boolean; error?: string }>;
    deleteBackups: (folderPath: string) => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
    // Working copy operations for reset-on-completion documents (preferred)
    // Creates a copy in /Runs/ subdirectory: {name}-{timestamp}-loop-{N}.md
    createWorkingCopy: (folderPath: string, filename: string, loopNumber: number) => Promise<{ workingCopyPath: string; originalPath: string }>;
  };
  // Playbooks API (saved batch run configurations)
  playbooks: {
    list: (sessionId: string) => Promise<{ success: boolean; playbooks: Array<{
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
    }>; error?: string }>;
    create: (sessionId: string, playbook: {
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
    }) => Promise<{ success: boolean; playbook?: any; error?: string }>;
    update: (sessionId: string, playbookId: string, updates: Partial<{
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
    }>) => Promise<{ success: boolean; playbook?: any; error?: string }>;
    delete: (sessionId: string, playbookId: string) => Promise<{ success: boolean; error?: string }>;
    deleteAll: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    export: (sessionId: string, playbookId: string, autoRunFolderPath: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    import: (sessionId: string, autoRunFolderPath: string) => Promise<{ success: boolean; playbook?: any; importedDocs?: string[]; error?: string }>;
  };
  // Marketplace API (browse and import playbooks from GitHub)
  marketplace: {
    getManifest: () => Promise<{
      success: boolean;
      manifest?: {
        lastUpdated: string;
        playbooks: Array<{
          id: string;
          title: string;
          description: string;
          category: string;
          subcategory?: string;
          author: string;
          authorLink?: string;
          tags?: string[];
          lastUpdated: string;
          path: string;
          documents: Array<{
            filename: string;
            resetOnCompletion: boolean;
          }>;
          loopEnabled: boolean;
          maxLoops?: number | null;
          prompt: string | null;
        }>;
      };
      fromCache?: boolean;
      cacheAge?: number;
      error?: string;
    }>;
    refreshManifest: () => Promise<{
      success: boolean;
      manifest?: {
        lastUpdated: string;
        playbooks: Array<{
          id: string;
          title: string;
          description: string;
          category: string;
          subcategory?: string;
          author: string;
          authorLink?: string;
          tags?: string[];
          lastUpdated: string;
          path: string;
          documents: Array<{
            filename: string;
            resetOnCompletion: boolean;
          }>;
          loopEnabled: boolean;
          maxLoops?: number | null;
          prompt: string | null;
        }>;
      };
      fromCache?: boolean;
      error?: string;
    }>;
    getDocument: (playbookPath: string, filename: string) => Promise<{
      success: boolean;
      content?: string;
      error?: string;
    }>;
    getReadme: (playbookPath: string) => Promise<{
      success: boolean;
      content?: string | null;
      error?: string;
    }>;
    importPlaybook: (playbookId: string, targetFolderName: string, autoRunFolderPath: string, sessionId: string) => Promise<{
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
      };
      importedDocs?: string[];
      error?: string;
    }>;
  };
  // Updates API
  updates: {
    check: (includePrerelease?: boolean) => Promise<{
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      assetsReady: boolean;
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
    setAllowPrerelease: (allow: boolean) => Promise<void>;
  };
  // Debug Package API
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
  // Sync API (custom storage location)
  sync: {
    getDefaultPath: () => Promise<string>;
    getSettings: () => Promise<{ customSyncPath?: string }>;
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
  // CLI activity API
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
  // Group Chat API (multi-agent coordination)
  groupChat: {
    // Storage
    create: (name: string, moderatorAgentId: string, moderatorConfig?: {
      customPath?: string;
      customArgs?: string;
      customEnvVars?: Record<string, string>;
    }) => Promise<{
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
    update: (id: string, updates: {
      name?: string;
      moderatorAgentId?: string;
      moderatorConfig?: {
        customPath?: string;
        customArgs?: string;
        customEnvVars?: Record<string, string>;
      };
    }) => Promise<{
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
    resetParticipantContext: (id: string, name: string, cwd?: string) => Promise<{ newAgentSessionId: string }>;
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
    onParticipantState: (callback: (groupChatId: string, participantName: string, state: 'idle' | 'working') => void) => () => void;
    onModeratorSessionIdChanged: (callback: (groupChatId: string, sessionId: string) => void) => () => void;
  };
  // Leaderboard API
  leaderboard: {
    submit: (data: {
      email: string;
      displayName: string;
      githubUsername?: string;
      twitterHandle?: string;
      linkedinHandle?: string;
      discordUsername?: string;
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
      // Keyboard mastery data (aligned with RunMaestro.ai server schema)
      keyboardMasteryLevel?: number;
      keyboardMasteryTitle?: string;
      keyboardCoveragePercent?: number;
      keyboardKeysUnlocked?: number;
      keyboardTotalKeys?: number;
      // Delta mode for multi-device aggregation
      deltaMs?: number;
      deltaRuns?: number;
    }) => Promise<{
      success: boolean;
      message: string;
      pendingEmailConfirmation?: boolean;
      error?: string;
      authTokenRequired?: boolean;
      requiresConfirmation?: boolean;
      ranking?: {
        cumulative: {
          rank: number;
          total: number;
          previousRank: number | null;
          improved: boolean;
        };
        longestRun?: {
          rank: number;
          total: number;
          previousRank: number | null;
          improved: boolean;
        };
      };
      // Server-side totals for multi-device sync
      serverTotals?: {
        cumulativeTimeMs: number;
        totalRuns: number;
      };
    }>;
    pollAuthStatus: (clientToken: string) => Promise<{
      status: 'pending' | 'confirmed' | 'expired' | 'error';
      authToken?: string;
      message?: string;
      error?: string;
    }>;
    resendConfirmation: (data: { email: string; clientToken: string }) => Promise<{
      success: boolean;
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
  speckit: {
    getMetadata: () => Promise<{
      success: boolean;
      metadata?: {
        lastRefreshed: string;
        commitSha: string;
        sourceVersion: string;
        sourceUrl: string;
      };
      error?: string;
    }>;
    getPrompts: () => Promise<{
      success: boolean;
      commands?: Array<{
        id: string;
        command: string;
        description: string;
        prompt: string;
        isCustom: boolean;
        isModified: boolean;
      }>;
      error?: string;
    }>;
    getCommand: (slashCommand: string) => Promise<{
      success: boolean;
      command?: {
        id: string;
        command: string;
        description: string;
        prompt: string;
        isCustom: boolean;
        isModified: boolean;
      };
      error?: string;
    }>;
    savePrompt: (id: string, content: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    resetPrompt: (id: string) => Promise<{
      success: boolean;
      prompt?: string;
      error?: string;
    }>;
    refresh: () => Promise<{
      success: boolean;
      metadata?: {
        lastRefreshed: string;
        commitSha: string;
        sourceVersion: string;
        sourceUrl: string;
      };
      error?: string;
    }>;
  };
  openspec: {
    getMetadata: () => Promise<{
      success: boolean;
      metadata?: {
        lastRefreshed: string;
        commitSha: string;
        sourceVersion: string;
        sourceUrl: string;
      };
      error?: string;
    }>;
    getPrompts: () => Promise<{
      success: boolean;
      commands?: Array<{
        id: string;
        command: string;
        description: string;
        prompt: string;
        isCustom: boolean;
        isModified: boolean;
      }>;
      error?: string;
    }>;
    getCommand: (slashCommand: string) => Promise<{
      success: boolean;
      command?: {
        id: string;
        command: string;
        description: string;
        prompt: string;
        isCustom: boolean;
        isModified: boolean;
      };
      error?: string;
    }>;
    savePrompt: (id: string, content: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    resetPrompt: (id: string) => Promise<{
      success: boolean;
      prompt?: string;
      error?: string;
    }>;
    refresh: () => Promise<{
      success: boolean;
      metadata?: {
        lastRefreshed: string;
        commitSha: string;
        sourceVersion: string;
        sourceUrl: string;
      };
      error?: string;
    }>;
  };
  // Stats tracking API (global AI interaction statistics)
  stats: {
    // Record a query event (interactive conversation turn)
    recordQuery: (event: {
      sessionId: string;
      agentType: string;
      source: 'user' | 'auto';
      startTime: number;
      duration: number;
      projectPath?: string;
      tabId?: string;
    }) => Promise<string>;
    // Start an Auto Run session (returns session ID)
    startAutoRun: (session: {
      sessionId: string;
      agentType: string;
      documentPath?: string;
      startTime: number;
      tasksTotal?: number;
      projectPath?: string;
    }) => Promise<string>;
    // End an Auto Run session (update duration and completed count)
    endAutoRun: (id: string, duration: number, tasksCompleted: number) => Promise<boolean>;
    // Record an Auto Run task completion
    recordAutoTask: (task: {
      autoRunSessionId: string;
      sessionId: string;
      agentType: string;
      taskIndex: number;
      taskContent?: string;
      startTime: number;
      duration: number;
      success: boolean;
    }) => Promise<string>;
    // Get query events with time range and optional filters
    getStats: (
      range: 'day' | 'week' | 'month' | 'year' | 'all',
      filters?: {
        agentType?: string;
        source?: 'user' | 'auto';
        projectPath?: string;
        sessionId?: string;
      }
    ) => Promise<Array<{
      id: string;
      sessionId: string;
      agentType: string;
      source: 'user' | 'auto';
      startTime: number;
      duration: number;
      projectPath?: string;
      tabId?: string;
    }>>;
    // Get Auto Run sessions within a time range
    getAutoRunSessions: (range: 'day' | 'week' | 'month' | 'year' | 'all') => Promise<Array<{
      id: string;
      sessionId: string;
      agentType: string;
      documentPath?: string;
      startTime: number;
      duration: number;
      tasksTotal?: number;
      tasksCompleted?: number;
      projectPath?: string;
    }>>;
    // Get tasks for a specific Auto Run session
    getAutoRunTasks: (autoRunSessionId: string) => Promise<Array<{
      id: string;
      autoRunSessionId: string;
      sessionId: string;
      agentType: string;
      taskIndex: number;
      taskContent?: string;
      startTime: number;
      duration: number;
      success: boolean;
    }>>;
    // Get aggregated stats for dashboard display
    getAggregation: (range: 'day' | 'week' | 'month' | 'year' | 'all') => Promise<{
      totalQueries: number;
      totalDuration: number;
      avgDuration: number;
      byAgent: Record<string, { count: number; duration: number }>;
      bySource: { user: number; auto: number };
      byDay: Array<{ date: string; count: number; duration: number }>;
    }>;
    // Export query events to CSV
    exportCsv: (range: 'day' | 'week' | 'month' | 'year' | 'all') => Promise<string>;
    // Subscribe to stats updates (for real-time dashboard refresh)
    onStatsUpdate: (callback: () => void) => () => void;
    // Clear old stats data (older than specified number of days)
    clearOldData: (olderThanDays: number) => Promise<{
      success: boolean;
      deletedQueryEvents: number;
      deletedAutoRunSessions: number;
      deletedAutoRunTasks: number;
      error?: string;
    }>;
    // Get database size in bytes
    getDatabaseSize: () => Promise<number>;
  };
  // Document Graph API (file watching for graph visualization)
  documentGraph: {
    watchFolder: (rootPath: string) => Promise<{ success: boolean; error?: string }>;
    unwatchFolder: (rootPath: string) => Promise<{ success: boolean; error?: string }>;
    onFilesChanged: (handler: (data: {
      rootPath: string;
      changes: Array<{
        filePath: string;
        eventType: 'add' | 'change' | 'unlink';
      }>;
    }) => void) => () => void;
  };
}

declare global {
  interface Window {
    maestro: MaestroAPI;
    maestroTest?: {
      addToast: (type: 'success' | 'info' | 'warning' | 'error', title: string, message: string) => void;
      showPromptTooLong: (usageStats: any) => void;
    };
  }
}

export {};
