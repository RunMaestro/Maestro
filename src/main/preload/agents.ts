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
import { subscribeIpc } from './ipcSubscription';
import type { AgentCapabilities, AgentConfig } from '../../shared/types';
import {
	SNAPSHOT_UPDATED_CHANNEL,
	type AgentCapabilitiesSnapshot,
	type AgentCapabilitiesSnapshotMap,
	type SnapshotUpdatedPayload,
} from '../../shared/agentCapabilities';
import type { UsageSnapshot } from '../agents/claude-mode-selector';
import type { CodexUsageSnapshot } from '../stores/codexUsageStore';
import type { KnownAuthDirs } from '../../shared/authPaths';

// Re-export for consumers that import from preload. `AgentStatus` is
// re-exported only (no local usage in this file); TypeScript's
// `export type {...}` resolves it transitively from the source module
// without needing a separate import. Importing it would trip
// `@typescript-eslint/no-unused-vars` and TS6133.
export type { AgentCapabilities, AgentConfig } from '../../shared/types';
export type {
	AgentCapabilitiesSnapshot,
	AgentCapabilitiesSnapshotMap,
	AgentStatus,
	SnapshotUpdatedPayload,
} from '../../shared/agentCapabilities';
export type { UsageSnapshot } from '../agents/claude-mode-selector';
export type { CodexUsageSnapshot } from '../stores/codexUsageStore';

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
		 * Return locally configured Claude and Codex account paths without
		 * enumerating provider directories on disk.
		 */
		getKnownAuthDirs: (): Promise<KnownAuthDirs> => ipcRenderer.invoke('agents:getKnownAuthDirs'),

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
		 * snapshot exists yet - callers should fall back to detect().
		 */
		getSnapshot: (
			agentId: string,
			sshRemoteId?: string
		): Promise<AgentCapabilitiesSnapshot | null> =>
			ipcRenderer.invoke('agents:getSnapshot', agentId, sshRemoteId),

		/** Read every persisted snapshot - used to hydrate the renderer at startup. */
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
		 * in place - no polling needed.
		 */
		onSnapshotUpdated: (callback: (payload: SnapshotUpdatedPayload) => void): (() => void) =>
			subscribeIpc(SNAPSHOT_UPDATED_CHANNEL, callback),

		/**
		 * Resolve the auto-detected maestro-p binary path bundled with the app.
		 * Returns null when no bundled script is present (typical for dev builds
		 * without an `npm run build` artifact).
		 */
		getMaestroPDetectedPath: (): Promise<string | null> =>
			ipcRenderer.invoke('agents:getMaestroPDetectedPath'),

		/**
		 * Whether `maestro-p` is on the PATH of an SSH remote (used to disable the
		 * TUI token-source option when the remote can't run it). Returns a fresh
		 * cached result or probes on demand; `null` when it can't be determined.
		 * Pass `force` to bypass the cache and re-probe immediately (Refresh button).
		 */
		getRemoteMaestroPAvailable: (sshRemoteId: string, force?: boolean): Promise<boolean | null> =>
			ipcRenderer.invoke('agents:getRemoteMaestroPAvailable', sshRemoteId, force),

		/**
		 * Fetch the live Claude plan usage snapshot map keyed by canonical
		 * `CLAUDE_CONFIG_DIR`. Used by the renderer-side claudeUsageStore to
		 * mirror main-process state for the mode badge and Usage Dashboard.
		 */
		getClaudeUsageSnapshots: (): Promise<Record<string, UsageSnapshot>> =>
			ipcRenderer.invoke('agents:getClaudeUsageSnapshots'),

		/**
		 * Discover local Claude account keys that can be sampled for quota status.
		 */
		getClaudeUsageAccountKeys: (): Promise<string[]> =>
			ipcRenderer.invoke('agents:getClaudeUsageAccountKeys'),

		/**
		 * Best-effort epoch-ms estimate of when a paused agent's provider limit
		 * window reopens (Claude only - undefined for other providers). Used by
		 * auto-resume to schedule the next probe; callers treat it as advisory.
		 */
		getLimitResetAt: (agentId: string, claudeConfigDir?: string): Promise<number | undefined> =>
			ipcRenderer.invoke('agents:getLimitResetAt', agentId, claudeConfigDir),

		/**
		 * Fetch sanitized Codex quota snapshots keyed by canonical CODEX_HOME.
		 * Main owns auth.json reads and quota endpoint calls.
		 */
		getCodexUsageSnapshots: (): Promise<Record<string, CodexUsageSnapshot>> =>
			ipcRenderer.invoke('agents:getCodexUsageSnapshots'),

		/**
		 * Discover local CODEX_HOME account keys that can be sampled for quota status.
		 */
		getCodexUsageAccountKeys: (): Promise<string[]> =>
			ipcRenderer.invoke('agents:getCodexUsageAccountKeys'),

		/**
		 * Trigger a fresh `runStartupUsageSampling()` pass on main so every known
		 * `CLAUDE_CONFIG_DIR` account re-samples `maestro-p --status` and the
		 * snapshot store is rewritten. The dashboard / settings refresh button
		 * calls this and then pulls the updated map back into the renderer
		 * mirror via `claudeUsageStore.refresh()`.
		 */
		refreshClaudeUsageSnapshots: (): Promise<{ refreshed: number }> =>
			ipcRenderer.invoke('claude:usage:refresh-all'),

		/**
		 * Trigger a fresh Codex quota sampling pass on main, then let renderer
		 * stores pull the sanitized snapshot map.
		 */
		refreshCodexUsageSnapshots: (): Promise<{ refreshed: number }> =>
			ipcRenderer.invoke('codex:usage:refresh-all'),
	};
}

/**
 * TypeScript type for the agents API
 */
export type AgentsApi = ReturnType<typeof createAgentsApi>;
