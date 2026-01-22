/**
 * Preload API for settings and persistence
 *
 * Provides the window.maestro.settings, sessions, and groups namespaces for:
 * - Application settings persistence
 * - Session list persistence
 * - Group list persistence
 */

import { ipcRenderer } from 'electron';
import type { Group } from '../../shared/types';

/**
 * Stored session data for persistence.
 * This is a subset of the full renderer Session type - we use Record<string, unknown>
 * because the preload is just a pass-through bridge and the actual type validation
 * happens at the renderer and main process boundaries.
 */
type StoredSession = Record<string, unknown>;

/**
 * Creates the settings API object for preload exposure
 */
export function createSettingsApi() {
	return {
		get: (key: string) => ipcRenderer.invoke('settings:get', key),
		set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
		getAll: () => ipcRenderer.invoke('settings:getAll'),
	};
}

/**
 * Creates the sessions persistence API object for preload exposure
 */
export function createSessionsApi() {
	return {
		getAll: () => ipcRenderer.invoke('sessions:getAll'),
		setAll: (sessions: StoredSession[]) => ipcRenderer.invoke('sessions:setAll', sessions),
	};
}

/**
 * Creates the groups persistence API object for preload exposure
 */
export function createGroupsApi() {
	return {
		getAll: () => ipcRenderer.invoke('groups:getAll'),
		setAll: (groups: Group[]) => ipcRenderer.invoke('groups:setAll', groups),
	};
}

/**
 * Creates the agent error handling API object for preload exposure
 */
export function createAgentErrorApi() {
	return {
		clearError: (sessionId: string) => ipcRenderer.invoke('agent:clearError', sessionId),
		retryAfterError: (
			sessionId: string,
			options?: {
				prompt?: string;
				newSession?: boolean;
			}
		) => ipcRenderer.invoke('agent:retryAfterError', sessionId, options),
	};
}

export type SettingsApi = ReturnType<typeof createSettingsApi>;
export type SessionsApi = ReturnType<typeof createSessionsApi>;
export type GroupsApi = ReturnType<typeof createGroupsApi>;
export type AgentErrorApi = ReturnType<typeof createAgentErrorApi>;
