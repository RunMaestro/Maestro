/**
 * Plugin Host
 *
 * Manages plugin lifecycle and provides scoped API objects to plugins.
 * Each plugin receives a PluginAPI object with only the namespaces
 * permitted by its declared permissions.
 */

import path from 'path';
import fs from 'fs/promises';
import { Notification, type App, type BrowserWindow } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import type { ProcessManager } from './process-manager';
import type Store from 'electron-store';
import type { MaestroSettings } from './stores/types';
import type {
	LoadedPlugin,
	PluginAPI,
	PluginContext,
	PluginModule,
	PluginProcessAPI,
	PluginProcessControlAPI,
	PluginStatsAPI,
	PluginSettingsAPI,
	PluginStorageAPI,
	PluginNotificationsAPI,
	PluginMaestroAPI,
	PluginIpcBridgeAPI,
} from '../shared/plugin-types';
import type { StatsAggregation } from '../shared/stats-types';
import { getStatsDB } from './stats/singleton';
import { PluginStorage } from './plugin-storage';
import type { PluginIpcBridge } from './plugin-ipc-bridge';

const LOG_CONTEXT = '[Plugins]';

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface PluginHostDependencies {
	getProcessManager: () => ProcessManager | null;
	getMainWindow: () => BrowserWindow | null;
	settingsStore: Store<MaestroSettings>;
	app: App;
	ipcBridge?: PluginIpcBridge;
}

// ============================================================================
// PluginHost
// ============================================================================

export class PluginHost {
	private deps: PluginHostDependencies;
	private pluginContexts: Map<string, PluginContext> = new Map();
	/**
	 * Stores loaded plugin module references for deactivation.
	 * TRUST BOUNDARY: Plugin modules run in the same Node.js process as Maestro.
	 * For v1, this is acceptable because we only ship trusted/first-party plugins.
	 * Third-party sandboxing (e.g., vm2, worker threads) is a v2 concern.
	 */
	private pluginModules: Map<string, PluginModule> = new Map();
	private pluginStorages: Map<string, PluginStorage> = new Map();

	constructor(deps: PluginHostDependencies) {
		this.deps = deps;
	}

	/**
	 * Activates a plugin by loading its main entry point and calling activate().
	 * The plugin receives a scoped PluginAPI based on its declared permissions.
	 */
	async activatePlugin(plugin: LoadedPlugin): Promise<void> {
		const pluginId = plugin.manifest.id;

		try {
			const entryPoint = path.join(plugin.path, plugin.manifest.main);

			// Verify the entry point exists
			try {
				await fs.access(entryPoint);
			} catch {
				throw new Error(`Plugin entry point not found: ${plugin.manifest.main}`);
			}

			// Load the module using require() — plugins are Node.js modules for v1 simplicity
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const pluginModule: PluginModule = require(entryPoint);

			// Create context and activate
			const context = this.createPluginContext(plugin);

			if (typeof pluginModule.activate === 'function') {
				await pluginModule.activate(context.api);
			}

			this.pluginModules.set(pluginId, pluginModule);
			plugin.state = 'active';
			logger.info(`Plugin '${pluginId}' activated`, LOG_CONTEXT);
		} catch (err) {
			plugin.state = 'error';
			plugin.error = err instanceof Error ? err.message : String(err);
			logger.error(`Plugin '${pluginId}' failed to activate: ${plugin.error}`, LOG_CONTEXT);
			await captureException(err, { pluginId });
		}
	}

	/**
	 * Deactivates a plugin by calling its deactivate() function and cleaning up.
	 * Deactivation errors are logged but never propagated.
	 */
	async deactivatePlugin(pluginId: string): Promise<void> {
		try {
			const pluginModule = this.pluginModules.get(pluginId);
			if (pluginModule && typeof pluginModule.deactivate === 'function') {
				await pluginModule.deactivate();
			}
		} catch (err) {
			logger.error(
				`Plugin '${pluginId}' threw during deactivation: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}

		this.pluginModules.delete(pluginId);
		this.pluginStorages.delete(pluginId);
		this.destroyPluginContext(pluginId);
	}

	/**
	 * Creates a scoped API based on the plugin's declared permissions.
	 */
	createPluginContext(plugin: LoadedPlugin): PluginContext {
		const eventSubscriptions: Array<() => void> = [];

		const api: PluginAPI = {
			process: this.createProcessAPI(plugin, eventSubscriptions),
			processControl: this.createProcessControlAPI(plugin),
			stats: this.createStatsAPI(plugin, eventSubscriptions),
			settings: this.createSettingsAPI(plugin),
			storage: this.createStorageAPI(plugin),
			notifications: this.createNotificationsAPI(plugin),
			maestro: this.createMaestroAPI(plugin),
			ipcBridge: this.createIpcBridgeAPI(plugin),
		};

		const context: PluginContext = {
			pluginId: plugin.manifest.id,
			api,
			cleanup: () => {
				for (const unsub of eventSubscriptions) {
					unsub();
				}
				eventSubscriptions.length = 0;
			},
			eventSubscriptions,
		};

		this.pluginContexts.set(plugin.manifest.id, context);
		logger.info(`Plugin context created for '${plugin.manifest.id}'`, LOG_CONTEXT);
		return context;
	}

	/**
	 * Cleans up event listeners, timers, etc. for a plugin.
	 */
	destroyPluginContext(pluginId: string): void {
		const context = this.pluginContexts.get(pluginId);
		if (!context) {
			logger.warn(`No context to destroy for plugin '${pluginId}'`, LOG_CONTEXT);
			return;
		}

		context.cleanup();
		this.pluginContexts.delete(pluginId);
		logger.info(`Plugin context destroyed for '${pluginId}'`, LOG_CONTEXT);
	}

	/**
	 * Returns a plugin context by ID, if one exists.
	 */
	getPluginContext(pluginId: string): PluginContext | undefined {
		return this.pluginContexts.get(pluginId);
	}

	// ========================================================================
	// Private API Factory Methods
	// ========================================================================

	private hasPermission(plugin: LoadedPlugin, permission: string): boolean {
		return plugin.manifest.permissions.includes(permission as any);
	}

	private createProcessAPI(
		plugin: LoadedPlugin,
		eventSubscriptions: Array<() => void>
	): PluginProcessAPI | undefined {
		if (!this.hasPermission(plugin, 'process:read')) {
			return undefined;
		}

		const getProcessManager = this.deps.getProcessManager;

		return {
			getActiveProcesses: async () => {
				const pm = getProcessManager();
				if (!pm) return [];
				return pm.getAll().map((p) => ({
					sessionId: p.sessionId,
					toolType: p.toolType,
					pid: p.pid,
					startTime: p.startTime,
				}));
			},

			onData: (callback) => {
				const pm = getProcessManager();
				if (!pm) return () => {};
				const handler = (sessionId: string, data: string) => callback(sessionId, data);
				pm.on('data', handler);
				const unsub = () => pm.removeListener('data', handler);
				eventSubscriptions.push(unsub);
				return unsub;
			},

			onUsage: (callback) => {
				const pm = getProcessManager();
				if (!pm) return () => {};
				const handler = (sessionId: string, stats: any) => callback(sessionId, stats);
				pm.on('usage', handler);
				const unsub = () => pm.removeListener('usage', handler);
				eventSubscriptions.push(unsub);
				return unsub;
			},

			onToolExecution: (callback) => {
				const pm = getProcessManager();
				if (!pm) return () => {};
				const handler = (sessionId: string, tool: any) =>
					callback(sessionId, { toolName: tool.toolName, state: tool.state, timestamp: tool.timestamp });
				pm.on('tool-execution', handler);
				const unsub = () => pm.removeListener('tool-execution', handler);
				eventSubscriptions.push(unsub);
				return unsub;
			},

			onExit: (callback) => {
				const pm = getProcessManager();
				if (!pm) return () => {};
				const handler = (sessionId: string, code: number) => callback(sessionId, code);
				pm.on('exit', handler);
				const unsub = () => pm.removeListener('exit', handler);
				eventSubscriptions.push(unsub);
				return unsub;
			},

			onThinkingChunk: (callback) => {
				const pm = getProcessManager();
				if (!pm) return () => {};
				const handler = (sessionId: string, text: string) => callback(sessionId, text);
				pm.on('thinking-chunk', handler);
				const unsub = () => pm.removeListener('thinking-chunk', handler);
				eventSubscriptions.push(unsub);
				return unsub;
			},
		};
	}

	private createProcessControlAPI(plugin: LoadedPlugin): PluginProcessControlAPI | undefined {
		if (!this.hasPermission(plugin, 'process:write')) {
			return undefined;
		}

		const getProcessManager = this.deps.getProcessManager;
		const pluginId = plugin.manifest.id;

		return {
			kill: (sessionId: string) => {
				const pm = getProcessManager();
				if (!pm) return false;
				logger.info(`[Plugin:${pluginId}] killed session ${sessionId}`, LOG_CONTEXT);
				return pm.kill(sessionId);
			},

			write: (sessionId: string, data: string) => {
				const pm = getProcessManager();
				if (!pm) return false;
				logger.info(`[Plugin:${pluginId}] wrote to session ${sessionId}`, LOG_CONTEXT);
				return pm.write(sessionId, data);
			},
		};
	}

	private createStatsAPI(
		plugin: LoadedPlugin,
		eventSubscriptions: Array<() => void>
	): PluginStatsAPI | undefined {
		if (!this.hasPermission(plugin, 'stats:read')) {
			return undefined;
		}

		const getMainWindow = this.deps.getMainWindow;

		return {
			getAggregation: async (range: string): Promise<StatsAggregation> => {
				const db = getStatsDB();
				if (!db) {
					throw new Error('Stats database not available');
				}
				return db.getAggregation(range as any);
			},

			onStatsUpdate: (callback) => {
				const win = getMainWindow();
				if (!win) return () => {};
				const handler = () => callback();
				win.webContents.on('ipc-message', (_event, channel) => {
					if (channel === 'stats:updated') handler();
				});
				const unsub = () => {};
				eventSubscriptions.push(unsub);
				return unsub;
			},
		};
	}

	private createSettingsAPI(plugin: LoadedPlugin): PluginSettingsAPI | undefined {
		const canRead = this.hasPermission(plugin, 'settings:read');
		const canWrite = this.hasPermission(plugin, 'settings:write');

		if (!canRead && !canWrite) {
			return undefined;
		}

		const store = this.deps.settingsStore;
		const prefix = `plugin:${plugin.manifest.id}:`;

		return {
			get: async (key: string) => {
				return store.get(`${prefix}${key}` as any);
			},

			set: async (key: string, value: unknown) => {
				if (!canWrite) {
					throw new Error(`Plugin '${plugin.manifest.id}' does not have 'settings:write' permission`);
				}
				store.set(`${prefix}${key}` as any, value as any);
			},

			getAll: async () => {
				const all = store.store;
				const result: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(all)) {
					if (k.startsWith(prefix)) {
						result[k.slice(prefix.length)] = v;
					}
				}
				return result;
			},
		};
	}

	private createStorageAPI(plugin: LoadedPlugin): PluginStorageAPI | undefined {
		if (!this.hasPermission(plugin, 'storage')) {
			return undefined;
		}

		const storageDir = path.join(this.deps.app.getPath('userData'), 'plugins', plugin.manifest.id, 'data');
		const storage = new PluginStorage(plugin.manifest.id, storageDir);
		this.pluginStorages.set(plugin.manifest.id, storage);

		return {
			read: (filename: string) => storage.read(filename),
			write: (filename: string, data: string) => storage.write(filename, data),
			list: () => storage.list(),
			delete: (filename: string) => storage.delete(filename),
		};
	}

	private createIpcBridgeAPI(plugin: LoadedPlugin): PluginIpcBridgeAPI | undefined {
		const bridge = this.deps.ipcBridge;
		if (!bridge) {
			return undefined;
		}

		const pluginId = plugin.manifest.id;
		const getMainWindow = this.deps.getMainWindow;

		return {
			onMessage: (channel: string, handler: (...args: unknown[]) => unknown) => {
				return bridge.register(pluginId, channel, handler);
			},
			sendToRenderer: (channel: string, ...args: unknown[]) => {
				const win = getMainWindow();
				if (win) {
					win.webContents.send(`plugin:${pluginId}:${channel}`, ...args);
				}
			},
		};
	}

	private createNotificationsAPI(plugin: LoadedPlugin): PluginNotificationsAPI | undefined {
		if (!this.hasPermission(plugin, 'notifications')) {
			return undefined;
		}

		return {
			show: async (title: string, body: string) => {
				new Notification({ title, body }).show();
			},

			playSound: async (sound: string) => {
				const win = this.deps.getMainWindow();
				if (win) {
					win.webContents.send('plugin:playSound', sound);
				}
			},
		};
	}

	private createMaestroAPI(plugin: LoadedPlugin): PluginMaestroAPI {
		const pluginsDir = path.join(this.deps.app.getPath('userData'), 'plugins');

		return {
			version: this.deps.app.getVersion(),
			platform: process.platform,
			pluginId: plugin.manifest.id,
			pluginDir: plugin.path,
			dataDir: path.join(pluginsDir, plugin.manifest.id, 'data'),
		};
	}
}
