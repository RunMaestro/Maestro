import { ipcMain } from 'electron';
import Store from 'electron-store';
import { AgentDetector } from '../../agent-detector';
import { getAgentCapabilities } from '../../agent-capabilities';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, requireDependency, CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[AgentDetector]';
const CONFIG_LOG_CONTEXT = '[AgentConfig]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, context = LOG_CONTEXT): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
  context,
  operation,
});

/**
 * Interface for agent configuration store data
 */
interface AgentConfigsData {
  configs: Record<string, Record<string, any>>;
}

/**
 * Dependencies required for agents handler registration
 */
export interface AgentsHandlerDependencies {
  getAgentDetector: () => AgentDetector | null;
  agentConfigsStore: Store<AgentConfigsData>;
}

/**
 * Helper to strip non-serializable functions from agent configs.
 * Agent configs can have function properties that cannot be sent over IPC:
 * - argBuilder in configOptions
 * - resumeArgs, modelArgs, workingDirArgs on the agent config
 */
function stripAgentFunctions(agent: any) {
  if (!agent) return null;

  // Destructure to remove function properties from agent config
  const {
    resumeArgs,
    modelArgs,
    workingDirArgs,
    ...serializableAgent
  } = agent;

  return {
    ...serializableAgent,
    configOptions: agent.configOptions?.map((opt: any) => {
      const { argBuilder, ...serializableOpt } = opt;
      return serializableOpt;
    })
  };
}

/**
 * Register all Agent-related IPC handlers.
 *
 * These handlers provide agent detection and configuration management:
 * - Agent detection: detect, refresh, get
 * - Configuration: getConfig, setConfig, getConfigValue, setConfigValue
 * - Custom paths: setCustomPath, getCustomPath, getAllCustomPaths
 */
export function registerAgentsHandlers(deps: AgentsHandlerDependencies): void {
  const { getAgentDetector, agentConfigsStore } = deps;

  // Detect all available agents
  ipcMain.handle(
    'agents:detect',
    withIpcErrorLogging(handlerOpts('detect'), async () => {
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
      logger.info('Detecting available agents', LOG_CONTEXT);
      const agents = await agentDetector.detectAgents();
      logger.info(`Detected ${agents.length} agents`, LOG_CONTEXT, {
        agents: agents.map((a) => a.id),
      });
      // Strip argBuilder functions before sending over IPC
      return agents.map(stripAgentFunctions);
    })
  );

  // Refresh agent detection with debug info (clears cache and returns detailed error info)
  ipcMain.handle(
    'agents:refresh',
    withIpcErrorLogging(handlerOpts('refresh'), async (agentId?: string) => {
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

      // Clear the cache to force re-detection
      agentDetector.clearCache();

      // Get environment info for debugging
      const envPath = process.env.PATH || '';
      const homeDir = process.env.HOME || '';

      // Detect all agents fresh
      const agents = await agentDetector.detectAgents();

      // If a specific agent was requested, return detailed debug info
      if (agentId) {
        const agent = agents.find((a) => a.id === agentId);
        const command = process.platform === 'win32' ? 'where' : 'which';

        // Try to find the binary manually to get error info
        const debugInfo = {
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
          debugInfo.error =
            result.exitCode !== 0
              ? `${command} ${agent?.binaryName || agentId} failed (exit code ${result.exitCode}): ${result.stderr || 'Binary not found in PATH'}`
              : null;
        }

        logger.info(`Agent refresh debug info for ${agentId}`, LOG_CONTEXT, debugInfo);
        return { agents: agents.map(stripAgentFunctions), debugInfo };
      }

      logger.info(`Refreshed agent detection`, LOG_CONTEXT, {
        agents: agents.map((a) => ({ id: a.id, available: a.available, path: a.path })),
      });
      return { agents: agents.map(stripAgentFunctions), debugInfo: null };
    })
  );

  // Get a specific agent by ID
  ipcMain.handle(
    'agents:get',
    withIpcErrorLogging(handlerOpts('get'), async (agentId: string) => {
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
      logger.debug(`Getting agent: ${agentId}`, LOG_CONTEXT);
      const agent = await agentDetector.getAgent(agentId);
      // Strip argBuilder functions before sending over IPC
      return stripAgentFunctions(agent);
    })
  );

  // Get capabilities for a specific agent
  ipcMain.handle(
    'agents:getCapabilities',
    withIpcErrorLogging(handlerOpts('getCapabilities'), async (agentId: string) => {
      logger.debug(`Getting capabilities for agent: ${agentId}`, LOG_CONTEXT);
      return getAgentCapabilities(agentId);
    })
  );

  // Get all configuration for an agent
  ipcMain.handle(
    'agents:getConfig',
    withIpcErrorLogging(handlerOpts('getConfig', CONFIG_LOG_CONTEXT), async (agentId: string) => {
      const allConfigs = agentConfigsStore.get('configs', {});
      return allConfigs[agentId] || {};
    })
  );

  // Set all configuration for an agent
  ipcMain.handle(
    'agents:setConfig',
    withIpcErrorLogging(
      handlerOpts('setConfig', CONFIG_LOG_CONTEXT),
      async (agentId: string, config: Record<string, unknown>) => {
        const allConfigs = agentConfigsStore.get('configs', {});
        allConfigs[agentId] = config;
        agentConfigsStore.set('configs', allConfigs);
        logger.info(`Updated config for agent: ${agentId}`, CONFIG_LOG_CONTEXT, config);
        return true;
      }
    )
  );

  // Get a specific configuration value for an agent
  ipcMain.handle(
    'agents:getConfigValue',
    withIpcErrorLogging(handlerOpts('getConfigValue', CONFIG_LOG_CONTEXT), async (agentId: string, key: string) => {
      const allConfigs = agentConfigsStore.get('configs', {});
      const agentConfig = allConfigs[agentId] || {};
      return agentConfig[key];
    })
  );

  // Set a specific configuration value for an agent
  ipcMain.handle(
    'agents:setConfigValue',
    withIpcErrorLogging(
      handlerOpts('setConfigValue', CONFIG_LOG_CONTEXT),
      async (agentId: string, key: string, value: unknown) => {
        const allConfigs = agentConfigsStore.get('configs', {});
        if (!allConfigs[agentId]) {
          allConfigs[agentId] = {};
        }
        allConfigs[agentId][key] = value;
        agentConfigsStore.set('configs', allConfigs);
        logger.debug(`Updated config ${key} for agent ${agentId}`, CONFIG_LOG_CONTEXT, { value });
        return true;
      }
    )
  );

  // Set custom path for an agent - used when agent is not in standard PATH locations
  ipcMain.handle(
    'agents:setCustomPath',
    withIpcErrorLogging(
      handlerOpts('setCustomPath', CONFIG_LOG_CONTEXT),
      async (agentId: string, customPath: string | null) => {
        const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

        const allConfigs = agentConfigsStore.get('configs', {});
        if (!allConfigs[agentId]) {
          allConfigs[agentId] = {};
        }

        if (customPath) {
          allConfigs[agentId].customPath = customPath;
          logger.info(`Set custom path for agent ${agentId}: ${customPath}`, CONFIG_LOG_CONTEXT);
        } else {
          delete allConfigs[agentId].customPath;
          logger.info(`Cleared custom path for agent ${agentId}`, CONFIG_LOG_CONTEXT);
        }

        agentConfigsStore.set('configs', allConfigs);

        // Update agent detector with all custom paths
        const allCustomPaths: Record<string, string> = {};
        for (const [id, config] of Object.entries(allConfigs)) {
          if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
            allCustomPaths[id] = config.customPath as string;
          }
        }
        agentDetector.setCustomPaths(allCustomPaths);

        return true;
      }
    )
  );

  // Get custom path for an agent
  ipcMain.handle(
    'agents:getCustomPath',
    withIpcErrorLogging(handlerOpts('getCustomPath', CONFIG_LOG_CONTEXT), async (agentId: string) => {
      const allConfigs = agentConfigsStore.get('configs', {});
      return allConfigs[agentId]?.customPath || null;
    })
  );

  // Get all custom paths for agents
  ipcMain.handle(
    'agents:getAllCustomPaths',
    withIpcErrorLogging(handlerOpts('getAllCustomPaths', CONFIG_LOG_CONTEXT), async () => {
      const allConfigs = agentConfigsStore.get('configs', {});
      const customPaths: Record<string, string> = {};
      for (const [agentId, config] of Object.entries(allConfigs)) {
        if (config && typeof config === 'object' && 'customPath' in config && config.customPath) {
          customPaths[agentId] = config.customPath as string;
        }
      }
      return customPaths;
    })
  );

  // Set custom CLI arguments for an agent - arbitrary args appended to all agent invocations
  ipcMain.handle(
    'agents:setCustomArgs',
    withIpcErrorLogging(
      handlerOpts('setCustomArgs', CONFIG_LOG_CONTEXT),
      async (agentId: string, customArgs: string | null) => {
        const allConfigs = agentConfigsStore.get('configs', {});
        if (!allConfigs[agentId]) {
          allConfigs[agentId] = {};
        }

        if (customArgs && customArgs.trim()) {
          allConfigs[agentId].customArgs = customArgs.trim();
          logger.info(`Set custom args for agent ${agentId}: ${customArgs}`, CONFIG_LOG_CONTEXT);
        } else {
          delete allConfigs[agentId].customArgs;
          logger.info(`Cleared custom args for agent ${agentId}`, CONFIG_LOG_CONTEXT);
        }

        agentConfigsStore.set('configs', allConfigs);
        return true;
      }
    )
  );

  // Get custom CLI arguments for an agent
  ipcMain.handle(
    'agents:getCustomArgs',
    withIpcErrorLogging(handlerOpts('getCustomArgs', CONFIG_LOG_CONTEXT), async (agentId: string) => {
      const allConfigs = agentConfigsStore.get('configs', {});
      return allConfigs[agentId]?.customArgs || null;
    })
  );

  // Get all custom CLI arguments for agents
  ipcMain.handle(
    'agents:getAllCustomArgs',
    withIpcErrorLogging(handlerOpts('getAllCustomArgs', CONFIG_LOG_CONTEXT), async () => {
      const allConfigs = agentConfigsStore.get('configs', {});
      const customArgs: Record<string, string> = {};
      for (const [agentId, config] of Object.entries(allConfigs)) {
        if (config && typeof config === 'object' && 'customArgs' in config && config.customArgs) {
          customArgs[agentId] = config.customArgs as string;
        }
      }
      return customArgs;
    })
  );

  // Discover available models for an agent that supports model selection
  ipcMain.handle(
    'agents:getModels',
    withIpcErrorLogging(handlerOpts('getModels'), async (agentId: string, forceRefresh?: boolean) => {
      const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
      logger.info(`Discovering models for agent: ${agentId}`, LOG_CONTEXT, { forceRefresh });
      const models = await agentDetector.discoverModels(agentId, forceRefresh ?? false);
      return models;
    })
  );
}
