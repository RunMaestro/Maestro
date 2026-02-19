/**
 * Plugin Manager
 *
 * Orchestrates the plugin lifecycle: discovery, enabling, and disabling.
 * Uses a singleton-via-getter pattern consistent with other Maestro managers.
 */

import type { App } from 'electron';
import { logger } from './utils/logger';
import { getPluginsDir, discoverPlugins } from './plugin-loader';
import type { LoadedPlugin } from '../shared/plugin-types';
import type { PluginHost } from './plugin-host';

const LOG_CONTEXT = '[Plugins]';

/**
 * Manages the lifecycle of all plugins.
 */
export class PluginManager {
	private plugins: Map<string, LoadedPlugin> = new Map();
	private pluginsDir: string;
	private host: PluginHost | null = null;

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
	 * Discover and load all plugins from the plugins directory.
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
	 * Transitions a plugin from 'discovered' to 'active'.
	 * Actual activation logic will be added in Phase 03.
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
			this.host.createPluginContext(plugin);
		}

		plugin.state = 'active';
		logger.info(`Plugin '${id}' enabled`, LOG_CONTEXT);
		return true;
	}

	/**
	 * Transitions a plugin from 'active' to 'disabled'.
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
			this.host.destroyPluginContext(id);
		}

		plugin.state = 'disabled';
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
