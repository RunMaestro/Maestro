/**
 * Preload API for Plugin operations
 *
 * Provides the window.maestro.plugins namespace for:
 * - Listing all discovered plugins
 * - Enabling/disabling plugins
 * - Getting the plugins directory path
 * - Refreshing the plugin list
 */

import { ipcRenderer } from 'electron';

export interface PluginBridgeApi {
	invoke: (pluginId: string, channel: string, ...args: unknown[]) => Promise<unknown>;
	send: (pluginId: string, channel: string, ...args: unknown[]) => void;
}

export interface PluginsApi {
	getAll: () => Promise<unknown>;
	enable: (id: string) => Promise<unknown>;
	disable: (id: string) => Promise<unknown>;
	getDir: () => Promise<unknown>;
	refresh: () => Promise<unknown>;
	bridge: PluginBridgeApi;
}

/**
 * Creates the Plugins API object for preload exposure
 */
export function createPluginsApi(): PluginsApi {
	return {
		getAll: () => ipcRenderer.invoke('plugins:getAll'),

		enable: (id: string) => ipcRenderer.invoke('plugins:enable', id),

		disable: (id: string) => ipcRenderer.invoke('plugins:disable', id),

		getDir: () => ipcRenderer.invoke('plugins:getDir'),

		refresh: () => ipcRenderer.invoke('plugins:refresh'),

		bridge: {
			invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
				ipcRenderer.invoke('plugins:bridge:invoke', pluginId, channel, ...args),
			send: (pluginId: string, channel: string, ...args: unknown[]) => {
				ipcRenderer.invoke('plugins:bridge:send', pluginId, channel, ...args);
			},
		},
	};
}
