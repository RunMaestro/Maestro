/**
 * Encore Host
 *
 * Manages encore lifecycle and provides scoped API objects to encores.
 * Each encore receives a EncoreAPI object with only the namespaces
 * permitted by its declared permissions.
 */

import path from 'path';
import fs from 'fs/promises';
import { Notification, type App, type BrowserWindow } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import type { ProcessManager } from './process-manager';
import type Store from 'electron-store';
import type { MaestroSettings, SessionsData } from './stores/types';
import type {
	LoadedEncore,
	EncoreAPI,
	EncoreContext,
	EncoreModule,
	EncoreProcessAPI,
	EncoreProcessControlAPI,
	EncoreStatsAPI,
	EncoreSettingsAPI,
	EncoreStorageAPI,
	EncoreNotificationsAPI,
	EncoreMaestroAPI,
	EncoreIpcBridgeAPI,
} from '../shared/encore-types';
import type { StatsAggregation } from '../shared/stats-types';
import { getStatsDB } from './stats/singleton';
import { EncoreStorage } from './encore-storage';
import type { EncoreIpcBridge } from './encore-ipc-bridge';

const LOG_CONTEXT = '[Encores]';

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface EncoreHostDependencies {
	getProcessManager: () => ProcessManager | null;
	getMainWindow: () => BrowserWindow | null;
	settingsStore: Store<MaestroSettings>;
	sessionsStore?: Store<SessionsData>;
	app: App;
	ipcBridge?: EncoreIpcBridge;
}

// ============================================================================
// EncoreHost
// ============================================================================

export class EncoreHost {
	private deps: EncoreHostDependencies;
	private encoreContexts: Map<string, EncoreContext> = new Map();
	/**
	 * Stores loaded encore module references for deactivation.
	 * TRUST BOUNDARY: Encore modules run in the same Node.js process as Maestro.
	 * For v1, this is acceptable because we only ship trusted/first-party encores.
	 * Third-party sandboxing (e.g., vm2, worker threads) is a v2 concern.
	 */
	private encoreModules: Map<string, EncoreModule> = new Map();
	private encoreStorages: Map<string, EncoreStorage> = new Map();

	constructor(deps: EncoreHostDependencies) {
		this.deps = deps;
	}

	/**
	 * Activates an encore by loading its main entry point and calling activate().
	 * The encore receives a scoped EncoreAPI based on its declared permissions.
	 */
	async activateEncore(encore: LoadedEncore): Promise<void> {
		const encoreId = encore.manifest.id;

		try {
			const entryPoint = path.join(encore.path, encore.manifest.main);

			// Verify the entry point exists
			try {
				await fs.access(entryPoint);
			} catch {
				throw new Error(`Encore entry point not found: ${encore.manifest.main}`);
			}

			// Load the module using require() — encores are Node.js modules for v1 simplicity
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const encoreModule: EncoreModule = require(entryPoint);

			// Create context and activate
			const context = this.createEncoreContext(encore);

			if (typeof encoreModule.activate === 'function') {
				await encoreModule.activate(context.api);
			}

			this.encoreModules.set(encoreId, encoreModule);
			encore.state = 'active';
			logger.info(`Encore '${encoreId}' activated`, LOG_CONTEXT);
		} catch (err) {
			encore.state = 'error';
			encore.error = err instanceof Error ? err.message : String(err);
			logger.error(`Encore '${encoreId}' failed to activate: ${encore.error}`, LOG_CONTEXT);
			await captureException(err, { encoreId });
		}
	}

	/**
	 * Deactivates an encore by calling its deactivate() function and cleaning up.
	 * Deactivation errors are logged but never propagated.
	 */
	async deactivateEncore(encoreId: string): Promise<void> {
		try {
			const encoreModule = this.encoreModules.get(encoreId);
			if (encoreModule && typeof encoreModule.deactivate === 'function') {
				await encoreModule.deactivate();
			}
		} catch (err) {
			logger.error(
				`Encore '${encoreId}' threw during deactivation: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}

		this.encoreModules.delete(encoreId);
		this.encoreStorages.delete(encoreId);
		this.destroyEncoreContext(encoreId);

		// Remove any IPC bridge handlers registered by this encore
		if (this.deps.ipcBridge) {
			this.deps.ipcBridge.unregisterAll(encoreId);
		}
	}

	/**
	 * Creates a scoped API based on the encore's declared permissions.
	 */
	createEncoreContext(encore: LoadedEncore): EncoreContext {
		const eventSubscriptions: Array<() => void> = [];

		const api: EncoreAPI = {
			process: this.createProcessAPI(encore, eventSubscriptions),
			processControl: this.createProcessControlAPI(encore),
			stats: this.createStatsAPI(encore, eventSubscriptions),
			settings: this.createSettingsAPI(encore),
			storage: this.createStorageAPI(encore),
			notifications: this.createNotificationsAPI(encore),
			maestro: this.createMaestroAPI(encore),
			ipcBridge: this.createIpcBridgeAPI(encore),
		};

		const context: EncoreContext = {
			encoreId: encore.manifest.id,
			api,
			cleanup: () => {
				for (const unsub of eventSubscriptions) {
					unsub();
				}
				eventSubscriptions.length = 0;
			},
			eventSubscriptions,
		};

		this.encoreContexts.set(encore.manifest.id, context);
		logger.info(`Encore context created for '${encore.manifest.id}'`, LOG_CONTEXT);
		return context;
	}

	/**
	 * Cleans up event listeners, timers, etc. for an encore.
	 */
	destroyEncoreContext(encoreId: string): void {
		const context = this.encoreContexts.get(encoreId);
		if (!context) {
			logger.warn(`No context to destroy for encore '${encoreId}'`, LOG_CONTEXT);
			return;
		}

		context.cleanup();
		this.encoreContexts.delete(encoreId);
		logger.info(`Encore context destroyed for '${encoreId}'`, LOG_CONTEXT);
	}

	/**
	 * Returns an encore context by ID, if one exists.
	 */
	getEncoreContext(encoreId: string): EncoreContext | undefined {
		return this.encoreContexts.get(encoreId);
	}

	// ========================================================================
	// Private API Factory Methods
	// ========================================================================

	private hasPermission(encore: LoadedEncore, permission: string): boolean {
		return encore.manifest.permissions.includes(permission as any);
	}

	private createProcessAPI(
		encore: LoadedEncore,
		eventSubscriptions: Array<() => void>
	): EncoreProcessAPI | undefined {
		if (!this.hasPermission(encore, 'process:read')) {
			return undefined;
		}

		const getProcessManager = this.deps.getProcessManager;
		const sessionsStore = this.deps.sessionsStore;

		return {
			getActiveProcesses: async () => {
				const pm = getProcessManager();
				if (!pm) return [];
				// Look up session names from the sessions store
				const storedSessions = sessionsStore?.get('sessions', []) ?? [];
				const nameMap = new Map(storedSessions.map((s) => [s.id, s.name]));

				return pm.getAll().map((p) => {
					// Process sessionId format: {baseId}-ai-{tabId}, {baseId}-terminal, etc.
					const baseId = p.sessionId.replace(/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/, '');
					return {
						sessionId: p.sessionId,
						toolType: p.toolType,
						pid: p.pid,
						startTime: p.startTime,
						name: nameMap.get(baseId) || null,
					};
				});
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

	private createProcessControlAPI(encore: LoadedEncore): EncoreProcessControlAPI | undefined {
		if (!this.hasPermission(encore, 'process:write')) {
			return undefined;
		}

		const getProcessManager = this.deps.getProcessManager;
		const encoreId = encore.manifest.id;

		return {
			kill: (sessionId: string) => {
				const pm = getProcessManager();
				if (!pm) return false;
				logger.info(`[Encore:${encoreId}] killed session ${sessionId}`, LOG_CONTEXT);
				return pm.kill(sessionId);
			},

			write: (sessionId: string, data: string) => {
				const pm = getProcessManager();
				if (!pm) return false;
				logger.info(`[Encore:${encoreId}] wrote to session ${sessionId}`, LOG_CONTEXT);
				return pm.write(sessionId, data);
			},
		};
	}

	private createStatsAPI(
		encore: LoadedEncore,
		eventSubscriptions: Array<() => void>
	): EncoreStatsAPI | undefined {
		if (!this.hasPermission(encore, 'stats:read')) {
			return undefined;
		}

		const getMainWindow = this.deps.getMainWindow;

		return {
			getAggregation: async (range: string): Promise<StatsAggregation> => {
				const db = getStatsDB();
				if (!db) {
					throw new Error('Stats database not available');
				}
				return db.getAggregatedStats(range as any);
			},

			onStatsUpdate: (callback) => {
				const win = getMainWindow();
				if (!win) return () => {};
				const listener = (_event: unknown, channel: string) => {
					if (channel === 'stats:updated') callback();
				};
				win.webContents.on('ipc-message', listener);
				const unsub = () => {
					const currentWin = getMainWindow();
					if (currentWin) {
						currentWin.webContents.removeListener('ipc-message', listener);
					}
				};
				eventSubscriptions.push(unsub);
				return unsub;
			},
		};
	}

	private createSettingsAPI(encore: LoadedEncore): EncoreSettingsAPI | undefined {
		const canRead = this.hasPermission(encore, 'settings:read');
		const canWrite = this.hasPermission(encore, 'settings:write');

		if (!canRead && !canWrite) {
			return undefined;
		}

		const store = this.deps.settingsStore;
		const prefix = `encore:${encore.manifest.id}:`;

		return {
			get: async (key: string) => {
				return store.get(`${prefix}${key}` as any);
			},

			set: async (key: string, value: unknown) => {
				if (!canWrite) {
					throw new Error(`Encore '${encore.manifest.id}' does not have 'settings:write' permission`);
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

	private createStorageAPI(encore: LoadedEncore): EncoreStorageAPI | undefined {
		if (!this.hasPermission(encore, 'storage')) {
			return undefined;
		}

		const storageDir = path.join(this.deps.app.getPath('userData'), 'encores', encore.manifest.id, 'data');
		const storage = new EncoreStorage(encore.manifest.id, storageDir);
		this.encoreStorages.set(encore.manifest.id, storage);

		return {
			read: (filename: string) => storage.read(filename),
			write: (filename: string, data: string) => storage.write(filename, data),
			list: () => storage.list(),
			delete: (filename: string) => storage.delete(filename),
		};
	}

	private createIpcBridgeAPI(encore: LoadedEncore): EncoreIpcBridgeAPI | undefined {
		const bridge = this.deps.ipcBridge;
		if (!bridge) {
			return undefined;
		}

		const encoreId = encore.manifest.id;
		const getMainWindow = this.deps.getMainWindow;

		return {
			onMessage: (channel: string, handler: (...args: unknown[]) => unknown) => {
				return bridge.register(encoreId, channel, handler);
			},
			sendToRenderer: (channel: string, ...args: unknown[]) => {
				const win = getMainWindow();
				if (win) {
					win.webContents.send(`encore:${encoreId}:${channel}`, ...args);
				}
			},
		};
	}

	private createNotificationsAPI(encore: LoadedEncore): EncoreNotificationsAPI | undefined {
		if (!this.hasPermission(encore, 'notifications')) {
			return undefined;
		}

		return {
			show: async (title: string, body: string) => {
				new Notification({ title, body }).show();
			},

			playSound: async (sound: string) => {
				const win = this.deps.getMainWindow();
				if (win) {
					win.webContents.send('encore:playSound', sound);
				}
			},
		};
	}

	private createMaestroAPI(encore: LoadedEncore): EncoreMaestroAPI {
		const encoresDir = path.join(this.deps.app.getPath('userData'), 'encores');

		return {
			version: this.deps.app.getVersion(),
			platform: process.platform,
			encoreId: encore.manifest.id,
			encoreDir: encore.path,
			dataDir: path.join(encoresDir, encore.manifest.id, 'data'),
		};
	}
}
