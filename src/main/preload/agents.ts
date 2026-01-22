/**
 * Preload API for agent management
 *
 * Provides the window.maestro.agents namespace for:
 * - Detecting available agents (Claude Code, Codex, OpenCode, etc.)
 * - Managing agent configurations and custom paths
 * - Getting agent capabilities
 * - Discovering slash commands and models
 */

import { ipcRenderer } from 'electron';

/**
 * Capability flags that determine what features are available for each agent.
 * This is a simplified version for the renderer - full definition in agent-capabilities.ts
 */
export interface AgentCapabilities {
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

/**
 * Agent configuration
 */
export interface AgentConfig {
	id: string;
	name: string;
	command: string;
	args?: string[];
	available: boolean;
	path?: string;
	capabilities?: AgentCapabilities;
}

/**
 * Agent refresh result
 */
export interface AgentRefreshResult {
	agents: AgentConfig[];
	debugInfo: unknown;
}

/**
 * Creates the agents API object for preload exposure
 */
export function createAgentsApi() {
	return {
		/**
		 * Detect available agents
		 */
		detect: (sshRemoteId?: string): Promise<AgentConfig[]> =>
			ipcRenderer.invoke('agents:detect', sshRemoteId),

		/**
		 * Refresh agent detection (optionally for a specific agent)
		 */
		refresh: (agentId?: string, sshRemoteId?: string): Promise<AgentRefreshResult> =>
			ipcRenderer.invoke('agents:refresh', agentId, sshRemoteId),

		/**
		 * Get a specific agent's configuration
		 */
		get: (agentId: string): Promise<AgentConfig | null> =>
			ipcRenderer.invoke('agents:get', agentId),

		/**
		 * Get an agent's capabilities
		 */
		getCapabilities: (agentId: string): Promise<AgentCapabilities> =>
			ipcRenderer.invoke('agents:getCapabilities', agentId),

		/**
		 * Get an agent's full configuration
		 */
		getConfig: (agentId: string): Promise<Record<string, unknown>> =>
			ipcRenderer.invoke('agents:getConfig', agentId),

		/**
		 * Set an agent's configuration
		 */
		setConfig: (agentId: string, config: Record<string, unknown>): Promise<boolean> =>
			ipcRenderer.invoke('agents:setConfig', agentId, config),

		/**
		 * Get a specific configuration value for an agent
		 */
		getConfigValue: (agentId: string, key: string): Promise<unknown> =>
			ipcRenderer.invoke('agents:getConfigValue', agentId, key),

		/**
		 * Set a specific configuration value for an agent
		 */
		setConfigValue: (agentId: string, key: string, value: unknown): Promise<boolean> =>
			ipcRenderer.invoke('agents:setConfigValue', agentId, key, value),

		/**
		 * Set a custom path for an agent
		 */
		setCustomPath: (agentId: string, customPath: string | null): Promise<boolean> =>
			ipcRenderer.invoke('agents:setCustomPath', agentId, customPath),

		/**
		 * Get the custom path for an agent
		 */
		getCustomPath: (agentId: string): Promise<string | null> =>
			ipcRenderer.invoke('agents:getCustomPath', agentId),

		/**
		 * Get all custom paths for all agents
		 */
		getAllCustomPaths: (): Promise<Record<string, string>> =>
			ipcRenderer.invoke('agents:getAllCustomPaths'),

		/**
		 * Set custom CLI arguments that are appended to all agent invocations
		 */
		setCustomArgs: (agentId: string, customArgs: string | null): Promise<boolean> =>
			ipcRenderer.invoke('agents:setCustomArgs', agentId, customArgs),

		/**
		 * Get custom CLI arguments for an agent
		 */
		getCustomArgs: (agentId: string): Promise<string | null> =>
			ipcRenderer.invoke('agents:getCustomArgs', agentId),

		/**
		 * Get all custom arguments for all agents
		 */
		getAllCustomArgs: (): Promise<Record<string, string>> =>
			ipcRenderer.invoke('agents:getAllCustomArgs'),

		/**
		 * Set custom environment variables that are passed to all agent invocations
		 */
		setCustomEnvVars: (
			agentId: string,
			customEnvVars: Record<string, string> | null
		): Promise<boolean> => ipcRenderer.invoke('agents:setCustomEnvVars', agentId, customEnvVars),

		/**
		 * Get custom environment variables for an agent
		 */
		getCustomEnvVars: (agentId: string): Promise<Record<string, string> | null> =>
			ipcRenderer.invoke('agents:getCustomEnvVars', agentId),

		/**
		 * Get all custom environment variables for all agents
		 */
		getAllCustomEnvVars: (): Promise<Record<string, Record<string, string>>> =>
			ipcRenderer.invoke('agents:getAllCustomEnvVars'),

		/**
		 * Discover available models for agents that support model selection
		 * (e.g., OpenCode with Ollama)
		 */
		getModels: (agentId: string, forceRefresh?: boolean): Promise<string[]> =>
			ipcRenderer.invoke('agents:getModels', agentId, forceRefresh),

		/**
		 * Discover available slash commands for an agent by spawning it briefly
		 * Returns array of command names (e.g., ['compact', 'help', 'my-custom-command'])
		 */
		discoverSlashCommands: (
			agentId: string,
			cwd: string,
			customPath?: string
		): Promise<string[] | null> =>
			ipcRenderer.invoke('agents:discoverSlashCommands', agentId, cwd, customPath),
	};
}

/**
 * TypeScript type for the agents API
 */
export type AgentsApi = ReturnType<typeof createAgentsApi>;
