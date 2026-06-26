/**
 * Preload API for the plugin subsystem (window.maestro.plugins).
 *
 * Phase 0 is list-only management: enumerate discovered plugins, toggle them,
 * and install/uninstall by path. No plugin code executes yet. All channels are
 * gated in the main process on the `plugins` Encore flag; when it is off they
 * reject with 'PluginsDisabled', which callers treat as "feature off".
 *
 * NOTE: this object becomes part of the permanent, semver-managed public host
 * contract the moment the first plugin ships. Add to it additively; do not
 * remove or change the meaning of an existing method without a host-API major.
 */

import { ipcRenderer } from 'electron';
import type { PluginListSnapshot } from '../ipc/handlers/plugins';
import type { InstallResult } from '../plugins/plugin-manager';
import type { AggregatedContributions } from '../../shared/plugins/contributions';

/** Creates the plugins API object for contextBridge exposure. */
export function createPluginsApi() {
	return {
		/**
		 * List discovered plugins (re-reads disk) plus the host API version the UI
		 * should display. Each record carries its manifest (or null when invalid),
		 * load status, enable toggle, and any validation/compat errors.
		 */
		list: (): Promise<PluginListSnapshot> => ipcRenderer.invoke('plugins:list'),

		/** Enable or disable a plugin by id; returns the updated snapshot. */
		setEnabled: (id: string, enabled: boolean): Promise<PluginListSnapshot> =>
			ipcRenderer.invoke('plugins:set-enabled', id, enabled),

		/** Install a plugin by copying a directory that contains a plugin.json. */
		install: (sourceDir: string): Promise<InstallResult> =>
			ipcRenderer.invoke('plugins:install', sourceDir),

		/** Uninstall a plugin by id (removes its directory and forgets its toggle). */
		uninstall: (id: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('plugins:uninstall', id),

		/**
		 * Tier 0 contributions (themes, prompts, settings, command macros)
		 * aggregated across all active plugins, plus per-plugin errors. This is the
		 * read seam host registries consume plugin-supplied data from.
		 */
		contributions: (): Promise<AggregatedContributions> =>
			ipcRenderer.invoke('plugins:contributions'),
	};
}

export type PluginsApi = ReturnType<typeof createPluginsApi>;
