/**
 * Preload API for Encore operations
 *
 * Provides the window.maestro.encores namespace for:
 * - Listing all discovered encores
 * - Enabling/disabling encores
 * - Getting the encores directory path
 * - Refreshing the encore list
 */

import { ipcRenderer } from 'electron';

export interface EncoreBridgeApi {
	invoke: (encoreId: string, channel: string, ...args: unknown[]) => Promise<unknown>;
	send: (encoreId: string, channel: string, ...args: unknown[]) => void;
}

export interface EncoreSettingsApi {
	get: (encoreId: string) => Promise<unknown>;
	set: (encoreId: string, key: string, value: unknown) => Promise<unknown>;
}

export interface EncoresApi {
	getAll: () => Promise<unknown>;
	enable: (id: string) => Promise<unknown>;
	disable: (id: string) => Promise<unknown>;
	getDir: () => Promise<unknown>;
	refresh: () => Promise<unknown>;
	settings: EncoreSettingsApi;
	bridge: EncoreBridgeApi;
}

/**
 * Creates the Encores API object for preload exposure
 */
export function createEncoresApi(): EncoresApi {
	return {
		getAll: () => ipcRenderer.invoke('encores:getAll'),

		enable: (id: string) => ipcRenderer.invoke('encores:enable', id),

		disable: (id: string) => ipcRenderer.invoke('encores:disable', id),

		getDir: () => ipcRenderer.invoke('encores:getDir'),

		refresh: () => ipcRenderer.invoke('encores:refresh'),

		settings: {
			get: (encoreId: string) => ipcRenderer.invoke('encores:settings:get', encoreId),
			set: (encoreId: string, key: string, value: unknown) => ipcRenderer.invoke('encores:settings:set', encoreId, key, value),
		},

		bridge: {
			invoke: (encoreId: string, channel: string, ...args: unknown[]) =>
				ipcRenderer.invoke('encores:bridge:invoke', encoreId, channel, ...args),
			send: (encoreId: string, channel: string, ...args: unknown[]) => {
				ipcRenderer.invoke('encores:bridge:send', encoreId, channel, ...args);
			},
		},
	};
}
