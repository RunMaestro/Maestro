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
import type { AgentCapabilities, AgentConfig } from '../../shared/types';
import {
	SNAPSHOT_UPDATED_CHANNEL,
	type AgentCapabilitiesSnapshot,
	type AgentCapabilitiesSnapshotMap,
	type SnapshotUpdatedPayload,
} from '../../shared/agentCapabilities';

// Re-export for consumers that import from preload
export type { AgentCapabilities, AgentConfig } from '../../shared/types';
export type {
	AgentCapabilitiesSnapshot,
	AgentCapabilitiesSnapshotMap,
	AgentStatus,
	SnapshotUpdatedPayload,
} from '../../shared/agentCapabilities';

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
		 * Get a specific agent's configuration.
		 * When sshRemoteId is provided, detects the agent on the remote host
		 * instead of locally (with a 10s timeout).
		 */
		get: (agentId: string, sshRemoteId?: string): Promise<AgentConfig | null> =>
			ipcRenderer.invoke('agents:get', agentId, sshRemoteId),

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
		getModels: (agentId: string, forceRefresh?: boolean, sshRemoteId?: string): Promise<string[]> =>
			ipcRenderer.invoke('agents:getModels', agentId, forceRefresh, sshRemoteId),

		/**
		 * Discover available values for a dynamic select config option
		 */
		getConfigOptions: (
			agentId: string,
			optionKey: string,
			forceRefresh?: boolean
		): Promise<string[]> =>
			ipcRenderer.invoke('agents:getConfigOptions', agentId, optionKey, forceRefresh),

		/**
		 * Discover available slash commands for an agent.
		 * Returns objects with name, optional prompt (OpenCode custom commands),
		 * and optional description (Claude Code skill frontmatter).
		 */
		discoverSlashCommands: (
			agentId: string,
			cwd: string,
			customPath?: string,
			sshRemoteId?: string
		): Promise<{ name: string; prompt?: string; description?: string }[] | null> =>
			ipcRenderer.invoke('agents:discoverSlashCommands', agentId, cwd, customPath, sshRemoteId),

		/**
		 * Get the persisted capability snapshot for an agent in a given
		 * environment (local or per-SSH-remote). Returns null when no
		 * snapshot exists yet — callers should fall back to detect().
		 */
		getSnapshot: (
			agentId: string,
			sshRemoteId?: string
		): Promise<AgentCapabilitiesSnapshot | null> =>
			ipcRenderer.invoke('agents:getSnapshot', agentId, sshRemoteId),

		/** Read every persisted snapshot — used to hydrate the renderer at startup. */
		getAllSnapshots: (): Promise<AgentCapabilitiesSnapshotMap> =>
			ipcRenderer.invoke('agents:getAllSnapshots'),

		/**
		 * Clear an agent's snapshot and re-run detection. Resolves with the
		 * post-detection snapshot (or null when nothing was written, e.g.
		 * the terminal agent or an unknown id).
		 */
		reprobe: (agentId: string, sshRemoteId?: string): Promise<AgentCapabilitiesSnapshot | null> =>
			ipcRenderer.invoke('agents:reprobe', agentId, sshRemoteId),

		/**
		 * Subscribe to live snapshot mutations. Returns an unsubscribe fn.
		 * The renderer mirror calls this once at startup and updates state
		 * in place — no polling needed.
		 */
		onSnapshotUpdated: (callback: (payload: SnapshotUpdatedPayload) => void): (() => void) => {
			const handler = (_: unknown, payload: SnapshotUpdatedPayload) => callback(payload);
			ipcRenderer.on(SNAPSHOT_UPDATED_CHANNEL, handler);
			return () => ipcRenderer.removeListener(SNAPSHOT_UPDATED_CHANNEL, handler);
		},
	};
}

/**
 * TypeScript type for the agents API
 */
export type AgentsApi = ReturnType<typeof createAgentsApi>;
