/**
 * Preload API for automatic tab naming
 *
 * Provides the window.maestro.tabNaming namespace for:
 * - Generating descriptive tab names from user's first message
 */

import { ipcRenderer } from 'electron';

/**
 * Configuration for tab name generation request
 */
export interface TabNamingConfig {
	/** The user's first message to analyze */
	userMessage: string;
	/** The agent type to use (e.g., 'claude-code') */
	agentType: string;
	/** Working directory for the session */
	cwd: string;
	/** Optional session-level model override */
	sessionCustomModel?: string;
	/** Optional SSH remote configuration */
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Tab Naming API exposed to the renderer process
 */
export interface TabNamingApi {
	/**
	 * Generate a descriptive tab name from the user's first message.
	 * This spawns an ephemeral agent session that analyzes the message
	 * and returns a short, relevant tab name.
	 *
	 * @param config - Configuration for the tab naming request
	 * @returns The generated tab name, or null if generation failed
	 */
	generateTabName: (config: TabNamingConfig) => Promise<string | null>;
}

/**
 * Create the tab naming API for exposure via contextBridge
 */
export function createTabNamingApi(): TabNamingApi {
	return {
		generateTabName: (config: TabNamingConfig) =>
			ipcRenderer.invoke('tabNaming:generateTabName', config),
	};
}
