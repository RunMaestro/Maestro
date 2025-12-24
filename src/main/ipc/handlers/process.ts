import { ipcMain } from 'electron';
import Store from 'electron-store';
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
  const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

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
    }) => {
      const processManager = requireProcessManager(getProcessManager);
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

      // Get agent definition to access config options and argument builders
      const agent = await agentDetector.getAgent(config.toolType);
      logger.debug(`Spawn config received`, LOG_CONTEXT, {
        configToolType: config.toolType,
        configCommand: config.command,
        agentId: agent?.id,
        agentCommand: agent?.command,
        agentPath: agent?.path,
        hasAgentSessionId: !!config.agentSessionId,
        hasPrompt: !!config.prompt,
        promptLength: config.prompt?.length,
        promptValue: config.prompt,
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

      // Get contextWindow: session-level override takes priority over agent-level config
      // Falls back to the agent's configOptions default (e.g., 400000 for Codex, 128000 for OpenCode)
      const contextWindow = getContextWindowValue(agent, agentConfigValues, config.sessionCustomContextWindow);

      // Check if ACP mode is enabled for this agent (currently only OpenCode supports it)
      const supportsACP = agent?.capabilities?.supportsACP;
      const useACPConfig = agentConfigValues.useACP;
      const useACP = supportsACP && useACPConfig === true;
      const acpShowStreaming = agentConfigValues.acpShowStreaming === true;
      logger.debug('ACP mode check', LOG_CONTEXT, { 
        toolType: config.toolType,
        supportsACP,
        useACPConfig,
        useACP,
        acpShowStreaming,
        agentConfigValues
      });

      // Build command string for logging (ACP vs CLI format)
      const fullCommand = useACP && config.prompt
        ? `${config.command} acp`
        : `${config.command} ${finalArgs.join(' ')}`;

      logger.info(`Spawning process: ${config.command}`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        toolType: config.toolType,
        cwd: config.cwd,
        command: config.command,
        fullCommand,
        args: useACP && config.prompt ? ['acp'] : finalArgs,
        requiresPty: agent?.requiresPty || false,
        shell: shellToUse,
        ...(agentSessionId && { agentSessionId }),
        ...(config.readOnlyMode && { readOnlyMode: true }),
        ...(config.yoloMode && { yoloMode: true }),
        ...(config.modelId && { modelId: config.modelId }),
        ...(config.prompt && { prompt: config.prompt.length > 500 ? config.prompt.substring(0, 500) + '...' : config.prompt }),
        ...(useACP && { useACP: true, acpShowStreaming })
      });

      if (useACP) {
        logger.info('ACP mode enabled for agent', LOG_CONTEXT, { toolType: config.toolType, acpShowStreaming });
      }

      const result = processManager.spawn({
        ...config,
        args: finalArgs,
        requiresPty: agent?.requiresPty,
        prompt: config.prompt,
        shell: shellToUse,
        shellArgs: shellArgsStr,         // Shell-specific CLI args (for terminal sessions)
        shellEnvVars: shellEnvVars,      // Shell-specific env vars (for terminal sessions)
        contextWindow, // Pass configured context window to process manager
        customEnvVars: effectiveCustomEnvVars, // Pass custom env vars (session-level or agent-level)
        imageArgs: agent?.imageArgs,     // Function to build image CLI args (for Codex, OpenCode)
        noPromptSeparator: agent?.noPromptSeparator, // OpenCode doesn't support '--' before prompt
        useACP,                          // Use ACP protocol if enabled in agent config
        acpShowStreaming,                // Show streaming output in ACP mode
        acpSessionId: config.agentSessionId, // ACP session ID for resume
      });

      logger.info(`Process spawned successfully`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        pid: result.pid
      });
      return result;
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

  // Run a single command and capture only stdout/stderr (no PTY echo/prompts)
  ipcMain.handle(
    'process:runCommand',
    withIpcErrorLogging(handlerOpts('runCommand'), async (config: {
      sessionId: string;
      command: string;
      cwd: string;
      shell?: string;
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

      logger.debug(`Running command: ${config.command}`, LOG_CONTEXT, {
        sessionId: config.sessionId,
        cwd: config.cwd,
        shell,
        hasCustomEnvVars: Object.keys(shellEnvVars).length > 0
      });

      return processManager.runCommand(
        config.sessionId,
        config.command,
        config.cwd,
        shell,
        shellEnvVars
      );
    })
  );
}
