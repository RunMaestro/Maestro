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
		/** Listen for external settings file changes (e.g., from maestro-cli) */
		onExternalChange: (handler: () => void) => {
			const wrappedHandler = () => handler();
			ipcRenderer.on('settings:externalChange', wrappedHandler);
			return () => ipcRenderer.removeListener('settings:externalChange', wrappedHandler);
		},
	};
}

/**
 * Creates the sessions persistence API object for preload exposure
 */
export function createSessionsApi() {
	return {
		getAll: () => ipcRenderer.invoke('sessions:getAll'),
		setAll: (sessions: StoredSession[]) => ipcRenderer.invoke('sessions:setAll', sessions),
		/**
		 * Incremental persistence: merge `updates` into the stored sessions and
		 * remove any whose id is in `removeIds`. Preferred over `setAll` for
		 * debounced flushes - avoids cloning + serializing the entire sessions
		 * tree on every change.
		 */
		setMany: (updates: StoredSession[], removeIds: string[] = []) =>
			ipcRenderer.invoke('sessions:setMany', updates, removeIds),
		getActiveSessionId: () => ipcRenderer.invoke('sessions:getActiveSessionId') as Promise<string>,
		setActiveSessionId: (id: string) => ipcRenderer.invoke('sessions:setActiveSessionId', id),
		/**
		 * Listen for main-side focus requests (plugin `sessions.focus` verb). The
		 * main store write alone is invisible to the live renderer store, so the
		 * renderer must apply the jump itself through the canonical helpers.
		 */
		onFocusRequest: (handler: (payload: { sessionId: string; tabId?: string }) => void) => {
			const wrappedHandler = (_: unknown, payload: { sessionId: string; tabId?: string }) =>
				handler(payload);
			ipcRenderer.on('sessions:focus-request', wrappedHandler);
			return () => ipcRenderer.removeListener('sessions:focus-request', wrappedHandler);
		},
		/**
		 * Listen for agents another client added or closed. Desktop windows and
		 * web-desktop clients each hold their own session tree and flush it to the
		 * same store, so without this push a client only learns what the others did
		 * by reloading - and its stale copy resurrects agents they closed.
		 */
		onLifecycleSync: (
			handler: (payload: { added: StoredSession[]; removedIds: string[] }) => void
		) => {
			const wrappedHandler = (
				_: unknown,
				payload: { added: StoredSession[]; removedIds: string[] }
			) => handler(payload);
			ipcRenderer.on('sessions:lifecycleSync', wrappedHandler);
			return () => ipcRenderer.removeListener('sessions:lifecycleSync', wrappedHandler);
		},
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
