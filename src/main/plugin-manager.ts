/**
 * Plugin Manager
 *
 * Orchestrates the plugin lifecycle: discovery, enabling, and disabling.
 * Uses a singleton-via-getter pattern consistent with other Maestro managers.
 */

import type { App } from 'electron';
import type Store from 'electron-store';
import { logger } from './utils/logger';
import { getPluginsDir, discoverPlugins } from './plugin-loader';
import type { LoadedPlugin } from '../shared/plugin-types';
import type { PluginHost } from './plugin-host';
import type { MaestroSettings } from './stores/types';

const LOG_CONTEXT = '[Plugins]';

/**
 * Manages the lifecycle of all plugins.
 */
export class PluginManager {
	private plugins: Map<string, LoadedPlugin> = new Map();
	private pluginsDir: string;
	private host: PluginHost | null = null;
	private settingsStore: Store<MaestroSettings> | null = null;

	constructor(app: App) {
		this.pluginsDir = getPluginsDir(app);
	}

	/**
	 * Sets the PluginHost used to create/destroy plugin contexts.
	 */
	setHost(host: PluginHost): void {
		this.host = host;
	}

	/**
	 * Sets the settings store for tracking user-explicit disables.
	 */
	setSettingsStore(store: Store<MaestroSettings>): void {
		this.settingsStore = store;
	}

	/**
	 * Discover and load all plugins from the plugins directory.
	 * First-party plugins are auto-enabled unless explicitly disabled by user.
	 */
	async initialize(): Promise<void> {
		const discovered = await discoverPlugins(this.pluginsDir);

		this.plugins.clear();
		for (const plugin of discovered) {
			this.plugins.set(plugin.manifest.id, plugin);
		}

		const errorCount = discovered.filter((p) => p.state === 'error').length;
		const okCount = discovered.length - errorCount;
		logger.info(
			`Plugin system initialized: ${okCount} valid, ${errorCount} with errors`,
			LOG_CONTEXT
		);

		// Auto-enable first-party plugins that haven't been explicitly disabled
		for (const plugin of discovered) {
			if (plugin.state !== 'discovered') continue;
			if (!this.isFirstParty(plugin)) continue;
			if (this.isUserDisabled(plugin.manifest.id)) continue;

			logger.info(`Auto-enabling first-party plugin '${plugin.manifest.id}'`, LOG_CONTEXT);
			await this.enablePlugin(plugin.manifest.id);
		}
	}

	/**
	 * Checks if a plugin is first-party (auto-enable candidate).
	 */
	private isFirstParty(plugin: LoadedPlugin): boolean {
		return plugin.manifest.firstParty === true || plugin.manifest.author === 'Maestro Core';
	}

	/**
	 * Checks if a user has explicitly disabled a plugin.
	 */
	private isUserDisabled(pluginId: string): boolean {
		if (!this.settingsStore) return false;
		return this.settingsStore.get(`plugin:${pluginId}:userDisabled` as any) === true;
	}

	/**
	 * Returns all discovered plugins.
	 */
	getPlugins(): LoadedPlugin[] {
		return Array.from(this.plugins.values());
	}

	/**
	 * Returns a specific plugin by ID.
	 */
	getPlugin(id: string): LoadedPlugin | undefined {
		return this.plugins.get(id);
	}

	/**
	 * Returns plugins with state 'active'.
	 */
	getActivePlugins(): LoadedPlugin[] {
		return this.getPlugins().filter((p) => p.state === 'active');
	}

	/**
	 * Transitions a plugin from 'discovered' or 'disabled' to 'active'.
	 * Calls PluginHost.activatePlugin() which loads and runs the module's activate().
	 */
	async enablePlugin(id: string): Promise<boolean> {
		const plugin = this.plugins.get(id);
		if (!plugin) {
			logger.warn(`Cannot enable unknown plugin '${id}'`, LOG_CONTEXT);
			return false;
		}

		if (plugin.state !== 'discovered' && plugin.state !== 'disabled') {
			logger.warn(
				`Cannot enable plugin '${id}' in state '${plugin.state}'`,
				LOG_CONTEXT
			);
			return false;
		}

		if (this.host) {
			await this.host.activatePlugin(plugin);
			// activatePlugin sets state to 'active' or 'error'
		} else {
			plugin.state = 'active';
		}

		logger.info(`Plugin '${id}' enabled (state: ${plugin.state})`, LOG_CONTEXT);
		return plugin.state === 'active';
	}

	/**
	 * Transitions a plugin from 'active' to 'disabled'.
	 * Calls PluginHost.deactivatePlugin() which runs deactivate() and cleans up.
	 */
	async disablePlugin(id: string): Promise<boolean> {
		const plugin = this.plugins.get(id);
		if (!plugin) {
			logger.warn(`Cannot disable unknown plugin '${id}'`, LOG_CONTEXT);
			return false;
		}

		if (plugin.state !== 'active') {
			logger.warn(
				`Cannot disable plugin '${id}' in state '${plugin.state}'`,
				LOG_CONTEXT
			);
			return false;
		}

		if (this.host) {
			await this.host.deactivatePlugin(id);
		}

		plugin.state = 'disabled';

		// Track user-explicit disable
		if (this.settingsStore) {
			this.settingsStore.set(`plugin:${id}:userDisabled` as any, true as any);
		}

		logger.info(`Plugin '${id}' disabled`, LOG_CONTEXT);
		return true;
	}

	/**
	 * Returns the plugins directory path.
	 */
	getPluginsDir(): string {
		return this.pluginsDir;
	}
}

// ============================================================================
// Singleton access (consistent with other Maestro managers)
// ============================================================================

let pluginManagerInstance: PluginManager | null = null;

/**
 * Get the PluginManager singleton.
 * Returns null if not yet initialized via createPluginManager().
 */
export function getPluginManager(): PluginManager | null {
	return pluginManagerInstance;
}

/**
 * Create and store the PluginManager singleton.
 * Call this once during app initialization.
 */
export function createPluginManager(app: App): PluginManager {
	pluginManagerInstance = new PluginManager(app);
	return pluginManagerInstance;
}
