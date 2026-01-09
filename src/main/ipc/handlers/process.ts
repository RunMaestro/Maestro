import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as os from 'os';
import { ProcessManager } from '../../process-manager';
import { AgentDetector } from '../../agent-detector';
import { logger } from '../../utils/logger';
import { buildAgentArgs, applyAgentConfigOverrides, getContextWindowValue } from '../../utils/agent-args';
import {
  withIpcErrorLogging,
  requireProcessManager,
  requireDependency,
  CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { buildSshCommand } from '../../utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';
import { powerManager } from '../../power-manager';

const LOG_CONTEXT = '[ProcessManager]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
  operation: string,
  extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
  context: LOG_CONTEXT,
  operation,
  ...extra,
});

/**
 * Interface for agent configuration store data
 */
interface AgentConfigsData {
  configs: Record<string, Record<string, any>>;
}

/**
 * Interface for Maestro settings store
 */
interface MaestroSettings {
  defaultShell: string;
  customShellPath?: string;  // Custom path to shell binary (overrides auto-detected path)
  shellArgs?: string;        // Additional CLI arguments for shell sessions
  shellEnvVars?: Record<string, string>;  // Environment variables for shell sessions
  // SSH remote execution
  sshRemotes: SshRemoteConfig[];
  defaultSshRemoteId: string | null;
  [key: string]: any;
}

/**
 * Dependencies required for process handler registration
 */
export interface ProcessHandlerDependencies {
  getProcessManager: () => ProcessManager | null;
  getAgentDetector: () => AgentDetector | null;
  agentConfigsStore: Store<AgentConfigsData>;
  settingsStore: Store<MaestroSettings>;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Register all Process-related IPC handlers.
 *
 * These handlers manage process lifecycle operations:
 * - spawn: Start a new process for a session
 * - write: Send input to a process
 * - interrupt: Send SIGINT to a process
 * - kill: Terminate a process
 * - resize: Resize PTY dimensions
 * - getActiveProcesses: List all running processes
 * - runCommand: Execute a single command and capture output
 */
export function registerProcessHandlers(deps: ProcessHandlerDependencies): void {
  const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore, getMainWindow } = deps;

  // Spawn a new process for a session
  // Supports agent-specific argument builders for batch mode, JSON output, resume, read-only mode, YOLO mode
  ipcMain.handle(
    'process:spawn',
    withIpcErrorLogging(handlerOpts('spawn'), async (config: {
      sessionId: string;
      toolType: string;
      cwd: string;
      command: string;
      args: string[];
      prompt?: string;
      shell?: string;
      images?: string[]; // Base64 data URLs for images
      // Agent-specific spawn options (used to build args via agent config)
      agentSessionId?: string;  // For session resume
      readOnlyMode?: boolean;   // For read-only/plan mode
      modelId?: string;         // For model selection
      yoloMode?: boolean;       // For YOLO/full-access mode (bypasses confirmations)
      // Per-session overrides (take precedence over agent-level config)
      sessionCustomPath?: string;     // Session-specific custom path
      sessionCustomArgs?: string;     // Session-specific custom args
      sessionCustomEnvVars?: Record<string, string>; // Session-specific env vars
      sessionCustomModel?: string;    // Session-specific model selection
      sessionCustomContextWindow?: number; // Session-specific context window size
      // Per-session SSH remote config (takes precedence over agent-level SSH config)
      sessionSshRemoteConfig?: {
        enabled: boolean;
        remoteId: string | null;
        workingDirOverride?: string;
      };
      // Stats tracking options
      querySource?: 'user' | 'auto'; // Whether this query is user-initiated or from Auto Run
      tabId?: string; // Tab ID for multi-tab tracking
    }) => {
      const processManager = requireProcessManager(getProcessManager);
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

      // Get agent definition to access config options and argument builders
      const agent = await agentDetector.getAgent(config.toolType);
      // Use INFO level on Windows for better visibility in logs
      const isWindows = process.platform === 'win32';
      const logFn = isWindows ? logger.info.bind(logger) : logger.debug.bind(logger);
      logFn(`Spawn config received`, LOG_CONTEXT, {
        platform: process.platform,
        configToolType: config.toolType,
        configCommand: config.command,
        agentId: agent?.id,
        agentCommand: agent?.command,
        agentPath: agent?.path,
        agentPathExtension: agent?.path ? require('path').extname(agent.path) : 'none',
        hasAgentSessionId: !!config.agentSessionId,
        hasPrompt: !!config.prompt,
        promptLength: config.prompt?.length,
        // On Windows, show prompt preview to help debug truncation issues
        promptPreview: config.prompt && isWindows ? {
          first50: config.prompt.substring(0, 50),
          last50: config.prompt.substring(Math.max(0, config.prompt.length - 50)),
          containsHash: config.prompt.includes('#'),
          containsNewline: config.prompt.includes('\n'),
        } : undefined,
      });
      let finalArgs = buildAgentArgs(agent, {
        baseArgs: config.args,
        prompt: config.prompt,
        cwd: config.cwd,
        readOnlyMode: config.readOnlyMode,
        modelId: config.modelId,
        yoloMode: config.yoloMode,
        agentSessionId: config.agentSessionId,
      });

      // ========================================================================
      // Apply agent config options and session overrides
      // Session-level overrides take precedence over agent-level config
      // ========================================================================
      const allConfigs = agentConfigsStore.get('configs', {});
      const agentConfigValues = allConfigs[config.toolType] || {};
      const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
        agentConfigValues,
        sessionCustomModel: config.sessionCustomModel,
        sessionCustomArgs: config.sessionCustomArgs,
        sessionCustomEnvVars: config.sessionCustomEnvVars,
      });
      finalArgs = configResolution.args;

      if (configResolution.modelSource === 'session' && config.sessionCustomModel) {
        logger.debug(`Using session-level model for ${config.toolType}`, LOG_CONTEXT, { model: config.sessionCustomModel });
      }

      if (configResolution.customArgsSource !== 'none') {
        logger.debug(`Appending custom args for ${config.toolType} (${configResolution.customArgsSource}-level)`, LOG_CONTEXT);
      }

      const effectiveCustomEnvVars = configResolution.effectiveCustomEnvVars;
      if (configResolution.customEnvSource !== 'none' && effectiveCustomEnvVars) {
        logger.debug(`Custom env vars configured for ${config.toolType} (${configResolution.customEnvSource}-level)`, LOG_CONTEXT, { keys: Object.keys(effectiveCustomEnvVars) });
      }

      // If no shell is specified and this is a terminal session, use the default shell from settings
      // For terminal sessions, we also load custom shell path, args, and env vars
      let shellToUse = config.shell || (config.toolType === 'terminal' ? settingsStore.get('defaultShell', 'zsh') : undefined);
      let shellArgsStr: string | undefined;
      let shellEnvVars: Record<string, string> | undefined;

      if (config.toolType === 'terminal') {
        // Custom shell path overrides the detected/selected shell path
        const customShellPath = settingsStore.get('customShellPath', '');
        if (customShellPath && customShellPath.trim()) {
          shellToUse = customShellPath.trim();
          logger.debug('Using custom shell path for terminal', LOG_CONTEXT, { customShellPath });
        }
        // Load additional shell args and env vars
        shellArgsStr = settingsStore.get('shellArgs', '');
        shellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;
      }

      // Extract session ID from args for logging (supports both --resume and --session flags)
      const resumeArgIndex = finalArgs.indexOf('--resume');
      const sessionArgIndex = finalArgs.indexOf('--session');
      const agentSessionId = resumeArgIndex !== -1
        ? finalArgs[resumeArgIndex + 1]
        : sessionArgIndex !== -1
          ? finalArgs[sessionArgIndex + 1]
          : config.agentSessionId;

      logger.info(`Spawning process: ${config.command}`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        toolType: config.toolType,
        cwd: config.cwd,
        command: config.command,
        fullCommand: `${config.command} ${finalArgs.join(' ')}`,
        args: finalArgs,
        requiresPty: agent?.requiresPty || false,
        shell: shellToUse,
        ...(agentSessionId && { agentSessionId }),
        ...(config.readOnlyMode && { readOnlyMode: true }),
        ...(config.yoloMode && { yoloMode: true }),
        ...(config.modelId && { modelId: config.modelId }),
        ...(config.prompt && { prompt: config.prompt.length > 500 ? config.prompt.substring(0, 500) + '...' : config.prompt })
      });

      // Get contextWindow: session-level override takes priority over agent-level config
      // Falls back to the agent's configOptions default (e.g., 400000 for Codex, 128000 for OpenCode)
      const contextWindow = getContextWindowValue(agent, agentConfigValues, config.sessionCustomContextWindow);

      // ========================================================================
      // SSH Remote Execution: Detect and wrap command for remote execution
      // Terminal sessions are always local (they need PTY for shell interaction)
      // ========================================================================
      let commandToSpawn = config.command;
      let argsToSpawn = finalArgs;
      let sshRemoteUsed: SshRemoteConfig | null = null;

      // Only consider SSH remote for non-terminal AI agent sessions
      // SSH is session-level ONLY - no agent-level or global defaults
      if (config.toolType !== 'terminal' && config.sessionSshRemoteConfig) {
        // Session-level SSH config provided - resolve and use it
        logger.debug(`Using session-level SSH config`, LOG_CONTEXT, {
          sessionId: config.sessionId,
          enabled: config.sessionSshRemoteConfig.enabled,
          remoteId: config.sessionSshRemoteConfig.remoteId,
        });

        // Resolve effective SSH remote configuration
        const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
        const sshResult = getSshRemoteConfig(sshStoreAdapter, {
          sessionSshConfig: config.sessionSshRemoteConfig,
        });

        if (sshResult.config) {
          // SSH remote is configured - wrap the command for remote execution
          sshRemoteUsed = sshResult.config;

          // For SSH execution, we need to include the prompt in the args here
          // because ProcessManager.spawn() won't add it (we pass prompt: undefined for SSH)
          // Use promptArgs if available (e.g., OpenCode -p), otherwise use positional arg
          let sshArgs = finalArgs;
          if (config.prompt) {
            if (agent?.promptArgs) {
              sshArgs = [...finalArgs, ...agent.promptArgs(config.prompt)];
            } else if (agent?.noPromptSeparator) {
              sshArgs = [...finalArgs, config.prompt];
            } else {
              sshArgs = [...finalArgs, '--', config.prompt];
            }
          }

          // Build the SSH command that wraps the agent execution
          // The cwd is the local project path which may not exist on remote
          // Remote should use remoteWorkingDir from SSH config if set
          //
          // Determine the command to run on the remote host:
          // 1. If user set a session-specific custom path, use that (they configured it for the remote)
          // 2. Otherwise, use the agent's binaryName (e.g., 'codex', 'claude') and let
          //    the remote shell's PATH resolve it. This avoids using local paths like
          //    '/opt/homebrew/bin/codex' which don't exist on the remote host.
          const remoteCommand = config.sessionCustomPath || agent?.binaryName || config.command;
          const sshCommand = await buildSshCommand(sshResult.config, {
            command: remoteCommand,
            args: sshArgs,
            // Use the local cwd - the SSH command builder will handle remote path resolution
            // If SSH config has remoteWorkingDir, that takes precedence
            cwd: sshResult.config.remoteWorkingDir ? undefined : config.cwd,
            // Pass custom environment variables to the remote command
            env: effectiveCustomEnvVars,
          });

          commandToSpawn = sshCommand.command;
          argsToSpawn = sshCommand.args;

          logger.info(`SSH remote execution configured`, LOG_CONTEXT, {
            sessionId: config.sessionId,
            toolType: config.toolType,
            remoteName: sshResult.config.name,
            remoteHost: sshResult.config.host,
            source: sshResult.source,
            localCommand: config.command,
            remoteCommand: remoteCommand,
            customPath: config.sessionCustomPath || null,
            hasCustomEnvVars: !!effectiveCustomEnvVars && Object.keys(effectiveCustomEnvVars).length > 0,
            sshCommand: `${sshCommand.command} ${sshCommand.args.join(' ')}`,
          });
        }
      }

      const result = processManager.spawn({
        ...config,
        command: commandToSpawn,
        args: argsToSpawn,
        // When using SSH, use user's home directory as local cwd
        // The remote working directory is embedded in the SSH command itself
        // This fixes ENOENT errors when session.cwd is a remote-only path
        cwd: sshRemoteUsed ? os.homedir() : config.cwd,
        // When using SSH, disable PTY (SSH provides its own terminal handling)
        // and env vars are passed via the remote command string
        requiresPty: sshRemoteUsed ? false : agent?.requiresPty,
        // When using SSH, the prompt was already added to sshArgs above before
        // building the SSH command, so don't let ProcessManager add it again
        prompt: sshRemoteUsed ? undefined : config.prompt,
        shell: shellToUse,
        shellArgs: shellArgsStr,         // Shell-specific CLI args (for terminal sessions)
        shellEnvVars: shellEnvVars,      // Shell-specific env vars (for terminal sessions)
        contextWindow, // Pass configured context window to process manager
        // When using SSH, env vars are passed in the remote command string, not locally
        customEnvVars: sshRemoteUsed ? undefined : effectiveCustomEnvVars,
        imageArgs: agent?.imageArgs,     // Function to build image CLI args (for Codex, OpenCode)
        promptArgs: agent?.promptArgs,   // Function to build prompt args (e.g., ['-p', prompt] for OpenCode)
        noPromptSeparator: agent?.noPromptSeparator, // Some agents don't support '--' before prompt
        // Stats tracking: use cwd as projectPath if not explicitly provided
        projectPath: config.cwd,
        // SSH remote context (for SSH-specific error messages)
        sshRemoteId: sshRemoteUsed?.id,
        sshRemoteHost: sshRemoteUsed?.host,
      });

      logger.info(`Process spawned successfully`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        pid: result.pid,
        ...(sshRemoteUsed && { sshRemoteId: sshRemoteUsed.id, sshRemoteName: sshRemoteUsed.name })
      });

      // Add power block reason for AI sessions (not terminals)
      // This prevents system sleep while AI is processing
      if (config.toolType !== 'terminal') {
        powerManager.addBlockReason(`session:${config.sessionId}`);
      }

      // Emit SSH remote status event for renderer to update session state
      // This is emitted for all spawns (sshRemote will be null for local execution)
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        const sshRemoteInfo = sshRemoteUsed ? {
          id: sshRemoteUsed.id,
          name: sshRemoteUsed.name,
          host: sshRemoteUsed.host,
          remoteWorkingDir: sshRemoteUsed.remoteWorkingDir,
        } : null;
        mainWindow.webContents.send('process:ssh-remote', config.sessionId, sshRemoteInfo);
      }

      // Return spawn result with SSH remote info if used
      return {
        ...result,
        sshRemote: sshRemoteUsed ? {
          id: sshRemoteUsed.id,
          name: sshRemoteUsed.name,
          host: sshRemoteUsed.host,
          remoteWorkingDir: sshRemoteUsed.remoteWorkingDir,
        } : undefined,
      };
    })
  );

  // Write data to a process
  ipcMain.handle(
    'process:write',
    withIpcErrorLogging(handlerOpts('write'), async (sessionId: string, data: string) => {
      const processManager = requireProcessManager(getProcessManager);
      logger.debug(`Writing to process: ${sessionId}`, LOG_CONTEXT, { sessionId, dataLength: data.length });
      return processManager.write(sessionId, data);
    })
  );

  // Send SIGINT to a process
  ipcMain.handle(
    'process:interrupt',
    withIpcErrorLogging(handlerOpts('interrupt'), async (sessionId: string) => {
      const processManager = requireProcessManager(getProcessManager);
      logger.info(`Interrupting process: ${sessionId}`, LOG_CONTEXT, { sessionId });
      return processManager.interrupt(sessionId);
    })
  );

  // Kill a process
  ipcMain.handle(
    'process:kill',
    withIpcErrorLogging(handlerOpts('kill'), async (sessionId: string) => {
      const processManager = requireProcessManager(getProcessManager);
      logger.info(`Killing process: ${sessionId}`, LOG_CONTEXT, { sessionId });
      return processManager.kill(sessionId);
    })
  );

  // Resize PTY dimensions
  ipcMain.handle(
    'process:resize',
    withIpcErrorLogging(handlerOpts('resize'), async (sessionId: string, cols: number, rows: number) => {
      const processManager = requireProcessManager(getProcessManager);
      return processManager.resize(sessionId, cols, rows);
    })
  );

  // Get all active processes managed by the ProcessManager
  ipcMain.handle(
    'process:getActiveProcesses',
    withIpcErrorLogging(handlerOpts('getActiveProcesses'), async () => {
      const processManager = requireProcessManager(getProcessManager);
      const processes = processManager.getAll();
      // Return serializable process info (exclude non-serializable PTY/child process objects)
      return processes.map(p => ({
        sessionId: p.sessionId,
        toolType: p.toolType,
        pid: p.pid,
        cwd: p.cwd,
        isTerminal: p.isTerminal,
        isBatchMode: p.isBatchMode || false,
        startTime: p.startTime,
        command: p.command,
        args: p.args,
      }));
    })
  );

  // Spawn a terminal PTY for a specific tab (xterm.js integration)
  // This creates a persistent PTY shell for terminal tab emulation
  ipcMain.handle(
    'process:spawnTerminalTab',
    withIpcErrorLogging(handlerOpts('spawnTerminalTab'), async (config: {
      sessionId: string;
      cwd: string;
      shell?: string;
      shellArgs?: string;
      shellEnvVars?: Record<string, string>;
      cols?: number;
      rows?: number;
    }) => {
      const processManager = requireProcessManager(getProcessManager);

      // If no shell specified, use defaults from settings
      let shellToUse = config.shell || settingsStore.get('defaultShell', 'zsh');

      // Custom shell path overrides the detected/selected shell path
      const customShellPath = settingsStore.get('customShellPath', '');
      if (customShellPath && customShellPath.trim()) {
        shellToUse = customShellPath.trim();
      }

      // Get shell args and env vars from settings if not provided
      const shellArgs = config.shellArgs || settingsStore.get('shellArgs', '');
      const shellEnvVars = config.shellEnvVars || settingsStore.get('shellEnvVars', {}) as Record<string, string>;

      logger.info('Spawning terminal tab', LOG_CONTEXT, {
        sessionId: config.sessionId,
        cwd: config.cwd,
        shell: shellToUse,
        cols: config.cols,
        rows: config.rows,
      });

      try {
        const result = processManager.spawnTerminalTab({
          sessionId: config.sessionId,
          cwd: config.cwd,
          shell: shellToUse,
          shellArgs,
          shellEnvVars,
          cols: config.cols,
          rows: config.rows,
        });
        return result;
      } catch (error) {
        logger.error('Failed to spawn terminal tab', LOG_CONTEXT, { error: String(error) });
        throw error;
      }
    })
  );

  // Run a single command and capture only stdout/stderr (no PTY echo/prompts)
  // Supports SSH remote execution when sessionSshRemoteConfig is provided
  ipcMain.handle(
    'process:runCommand',
    withIpcErrorLogging(handlerOpts('runCommand'), async (config: {
      sessionId: string;
      command: string;
      cwd: string;
      shell?: string;
      // Per-session SSH remote config (same as process:spawn)
      sessionSshRemoteConfig?: {
        enabled: boolean;
        remoteId: string | null;
        workingDirOverride?: string;
      };
    }) => {
      const processManager = requireProcessManager(getProcessManager);

      // Get the shell from settings if not provided
      // Custom shell path takes precedence over the selected shell ID
      let shell = config.shell || settingsStore.get('defaultShell', 'zsh');
      const customShellPath = settingsStore.get('customShellPath', '');
      if (customShellPath && customShellPath.trim()) {
        shell = customShellPath.trim();
      }

      // Get shell env vars for passing to runCommand
      const shellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;

      // ========================================================================
      // SSH Remote Execution: Resolve SSH config if provided
      // ========================================================================
      let sshRemoteConfig: SshRemoteConfig | null = null;

      if (config.sessionSshRemoteConfig?.enabled && config.sessionSshRemoteConfig?.remoteId) {
        const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
        const sshResult = getSshRemoteConfig(sshStoreAdapter, {
          sessionSshConfig: config.sessionSshRemoteConfig,
        });

        if (sshResult.config) {
          sshRemoteConfig = sshResult.config;
          logger.info(`Terminal command will execute via SSH`, LOG_CONTEXT, {
            sessionId: config.sessionId,
            remoteName: sshResult.config.name,
            remoteHost: sshResult.config.host,
            source: sshResult.source,
          });
        }
      }

      logger.debug(`Running command: ${config.command}`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        cwd: config.cwd,
        shell,
        hasCustomEnvVars: Object.keys(shellEnvVars).length > 0,
        sshRemote: sshRemoteConfig?.name || null,
      });

      return processManager.runCommand(
        config.sessionId,
        config.command,
        config.cwd,
        shell,
        shellEnvVars,
        sshRemoteConfig
      );
    })
  );
}
