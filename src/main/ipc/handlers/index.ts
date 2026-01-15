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
import { registerGitHandlers, GitHandlerDependencies } from './git';
import { registerAutorunHandlers } from './autorun';
import { registerPlaybooksHandlers } from './playbooks';
import { registerHistoryHandlers } from './history';
import { registerAgentsHandlers, AgentsHandlerDependencies } from './agents';
import { registerProcessHandlers, ProcessHandlerDependencies } from './process';
import { registerPersistenceHandlers, PersistenceHandlerDependencies, MaestroSettings, SessionsData, GroupsData } from './persistence';
import { registerSystemHandlers, setupLoggerEventForwarding, SystemHandlerDependencies } from './system';
import { registerClaudeHandlers, ClaudeHandlerDependencies } from './claude';
import { registerAgentSessionsHandlers, AgentSessionsHandlerDependencies } from './agentSessions';
import { registerGroupChatHandlers, GroupChatHandlerDependencies } from './groupChat';
import { registerDebugHandlers, DebugHandlerDependencies } from './debug';
import { registerSpeckitHandlers } from './speckit';
import { registerOpenSpecHandlers } from './openspec';
import { registerContextHandlers, ContextHandlerDependencies, cleanupAllGroomingSessions, getActiveGroomingSessionCount } from './context';
import { registerMarketplaceHandlers, MarketplaceHandlerDependencies } from './marketplace';
import { registerStatsHandlers, StatsHandlerDependencies } from './stats';
import { registerDocumentGraphHandlers, DocumentGraphHandlerDependencies } from './documentGraph';
import { registerSshRemoteHandlers, SshRemoteHandlerDependencies } from './ssh-remote';
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
export { registerAgentSessionsHandlers };
export { registerGroupChatHandlers };
export { registerDebugHandlers };
export { registerSpeckitHandlers };
export { registerOpenSpecHandlers };
export { registerContextHandlers, cleanupAllGroomingSessions, getActiveGroomingSessionCount };
export { registerMarketplaceHandlers };
export type { MarketplaceHandlerDependencies };
export { registerStatsHandlers };
export { registerDocumentGraphHandlers };
export { registerSshRemoteHandlers };
export type { AgentsHandlerDependencies };
export type { ProcessHandlerDependencies };
export type { PersistenceHandlerDependencies };
export type { SystemHandlerDependencies };
export type { ClaudeHandlerDependencies };
export type { AgentSessionsHandlerDependencies };
export type { GroupChatHandlerDependencies };
export type { DebugHandlerDependencies };
export type { ContextHandlerDependencies };
export type { StatsHandlerDependencies };
export type { DocumentGraphHandlerDependencies };
export type { SshRemoteHandlerDependencies };
export type { GitHandlerDependencies };
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
  contextUsage?: number;
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
  registerGitHandlers({
    settingsStore: deps.settingsStore,
  });
  registerAutorunHandlers(deps);
  registerPlaybooksHandlers(deps);
  registerHistoryHandlers();
  registerAgentsHandlers({
    getAgentDetector: deps.getAgentDetector,
    agentConfigsStore: deps.agentConfigsStore,
    settingsStore: deps.settingsStore,
  });
  registerProcessHandlers({
    getProcessManager: deps.getProcessManager,
    getAgentDetector: deps.getAgentDetector,
    agentConfigsStore: deps.agentConfigsStore,
    settingsStore: deps.settingsStore,
    getMainWindow: deps.getMainWindow,
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
  registerGroupChatHandlers({
    getMainWindow: deps.getMainWindow,
    // ProcessManager is structurally compatible with the group chat's IProcessManager interface
    getProcessManager: deps.getProcessManager as unknown as GroupChatHandlerDependencies['getProcessManager'],
    getAgentDetector: deps.getAgentDetector,
  });
  registerDebugHandlers({
    getMainWindow: deps.getMainWindow,
    getAgentDetector: deps.getAgentDetector,
    getProcessManager: deps.getProcessManager,
    getWebServer: deps.getWebServer,
    settingsStore: deps.settingsStore,
    sessionsStore: deps.sessionsStore,
    groupsStore: deps.groupsStore,
    // bootstrapStore is optional - not available in HandlerDependencies
  });
  // Register spec-kit handlers (no dependencies needed)
  registerSpeckitHandlers();
  // Register OpenSpec handlers (no dependencies needed)
  registerOpenSpecHandlers();
  registerContextHandlers({
    getMainWindow: deps.getMainWindow,
    getProcessManager: deps.getProcessManager,
    getAgentDetector: deps.getAgentDetector,
  });
  // Register marketplace handlers
  registerMarketplaceHandlers({
    app: deps.app,
  });
  // Register stats handlers for usage tracking
  registerStatsHandlers({
    getMainWindow: deps.getMainWindow,
    settingsStore: deps.settingsStore,
  });
  // Register document graph handlers for file watching
  registerDocumentGraphHandlers({
    getMainWindow: deps.getMainWindow,
    app: deps.app,
  });
  // Register SSH remote handlers
  registerSshRemoteHandlers({
    settingsStore: deps.settingsStore,
  });
  // Setup logger event forwarding to renderer
  setupLoggerEventForwarding(deps.getMainWindow);
}
