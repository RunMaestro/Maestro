/**
 * IPC Handler Registration Module
 *
 * This module consolidates all IPC handler registrations, extracted from the main index.ts
 * to improve code organization and maintainability.
 *
 * Each handler module exports a register function that sets up the relevant ipcMain.handle calls.
 */

import { BrowserWindow, App } from 'electron';
import Store from 'electron-store';
import { registerGitHandlers } from './git';
import { registerAutorunHandlers } from './autorun';
import { registerPlaybooksHandlers } from './playbooks';
import { registerHistoryHandlers } from './history';
import { registerAgentsHandlers, AgentsHandlerDependencies } from './agents';
import { registerProcessHandlers, ProcessHandlerDependencies } from './process';
import { registerPersistenceHandlers, PersistenceHandlerDependencies, MaestroSettings, SessionsData, GroupsData } from './persistence';
import { registerSystemHandlers, setupLoggerEventForwarding, SystemHandlerDependencies } from './system';
import { registerClaudeHandlers, ClaudeHandlerDependencies } from './claude';
import { AgentDetector } from '../../agent-detector';
import { ProcessManager } from '../../process-manager';
import { WebServer } from '../../web-server';
import { tunnelManager as tunnelManagerInstance } from '../../tunnel-manager';

// Type for tunnel manager instance
type TunnelManagerType = typeof tunnelManagerInstance;

// Re-export individual handlers for selective registration
export { registerGitHandlers };
export { registerAutorunHandlers };
export { registerPlaybooksHandlers };
export { registerHistoryHandlers };
export { registerAgentsHandlers };
export { registerProcessHandlers };
export { registerPersistenceHandlers };
export { registerSystemHandlers, setupLoggerEventForwarding };
export { registerClaudeHandlers };
export type { AgentsHandlerDependencies };
export type { ProcessHandlerDependencies };
export type { PersistenceHandlerDependencies };
export type { SystemHandlerDependencies };
export type { ClaudeHandlerDependencies };
export type { MaestroSettings, SessionsData, GroupsData };

/**
 * Interface for agent configuration store data
 */
interface AgentConfigsData {
  configs: Record<string, Record<string, any>>;
}

/**
 * Interface for Claude session origins store
 */
type ClaudeSessionOrigin = 'user' | 'auto';
interface ClaudeSessionOriginInfo {
  origin: ClaudeSessionOrigin;
  sessionName?: string;
  starred?: boolean;
}
interface ClaudeSessionOriginsData {
  origins: Record<string, Record<string, ClaudeSessionOrigin | ClaudeSessionOriginInfo>>;
}

/**
 * Dependencies required for handler registration
 */
export interface HandlerDependencies {
  mainWindow: BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
  app: App;
  // Agents-specific dependencies
  getAgentDetector: () => AgentDetector | null;
  agentConfigsStore: Store<AgentConfigsData>;
  // Process-specific dependencies
  getProcessManager: () => ProcessManager | null;
  settingsStore: Store<MaestroSettings>;
  // Persistence-specific dependencies
  sessionsStore: Store<SessionsData>;
  groupsStore: Store<GroupsData>;
  getWebServer: () => WebServer | null;
  // System-specific dependencies
  tunnelManager: TunnelManagerType;
  // Claude-specific dependencies
  claudeSessionOriginsStore: Store<ClaudeSessionOriginsData>;
}

/**
 * Register all IPC handlers.
 * Call this once during app initialization.
 */
export function registerAllHandlers(deps: HandlerDependencies): void {
  registerGitHandlers();
  registerAutorunHandlers(deps);
  registerPlaybooksHandlers(deps);
  registerHistoryHandlers();
  registerAgentsHandlers({
    getAgentDetector: deps.getAgentDetector,
    agentConfigsStore: deps.agentConfigsStore,
  });
  registerProcessHandlers({
    getProcessManager: deps.getProcessManager,
    getAgentDetector: deps.getAgentDetector,
    agentConfigsStore: deps.agentConfigsStore,
    settingsStore: deps.settingsStore,
  });
  registerPersistenceHandlers({
    settingsStore: deps.settingsStore,
    sessionsStore: deps.sessionsStore,
    groupsStore: deps.groupsStore,
    getWebServer: deps.getWebServer,
  });
  registerSystemHandlers({
    getMainWindow: deps.getMainWindow,
    app: deps.app,
    settingsStore: deps.settingsStore,
    tunnelManager: deps.tunnelManager,
    getWebServer: deps.getWebServer,
  });
  registerClaudeHandlers({
    claudeSessionOriginsStore: deps.claudeSessionOriginsStore,
    getMainWindow: deps.getMainWindow,
  });
  // Setup logger event forwarding to renderer
  setupLoggerEventForwarding(deps.getMainWindow);
}
