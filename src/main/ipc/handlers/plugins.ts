/**
 * Plugin IPC Handlers
 *
 * Provides handlers for querying and managing plugins from the renderer process.
 */

import { ipcMain, App } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { getPluginManager, createPluginManager } from '../../plugin-manager';
import type { PluginIpcBridge } from '../../plugin-ipc-bridge';

const LOG_CONTEXT = '[Plugins]';

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface PluginHandlerDependencies {
	app: App;
	ipcBridge?: PluginIpcBridge;
}

/**
 * Helper to create handler options with consistent context.
 */
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Get the PluginManager, throwing if not initialized.
 */
function requirePluginManager() {
	const manager = getPluginManager();
	if (!manager) {
		throw new Error('Plugin manager not initialized');
	}
	return manager;
}

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all Plugin-related IPC handlers.
 */
export function registerPluginHandlers(deps: PluginHandlerDependencies): void {
	const { app, ipcBridge } = deps;

	// Ensure PluginManager is created (initialization happens in main startup)
	let manager = getPluginManager();
	if (!manager) {
		manager = createPluginManager(app);
		manager.initialize().catch((err) => {
			logger.error(`Failed to initialize plugin manager: ${err}`, LOG_CONTEXT);
		});
	}

	// -------------------------------------------------------------------------
	// plugins:getAll — returns all LoadedPlugin[]
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:getAll',
		createIpcHandler(handlerOpts('getAll', false), async () => {
			const pm = requirePluginManager();
			return { plugins: pm.getPlugins() };
		})
	);

	// -------------------------------------------------------------------------
	// plugins:enable — enables a plugin by ID
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:enable',
		createIpcHandler(handlerOpts('enable'), async (id: string) => {
			const pm = requirePluginManager();
			const result = await pm.enablePlugin(id);
			return { enabled: result };
		})
	);

	// -------------------------------------------------------------------------
	// plugins:disable — disables a plugin by ID
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:disable',
		createIpcHandler(handlerOpts('disable'), async (id: string) => {
			const pm = requirePluginManager();
			const result = await pm.disablePlugin(id);
			return { disabled: result };
		})
	);

	// -------------------------------------------------------------------------
	// plugins:getDir — returns the plugins directory path
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:getDir',
		createIpcHandler(handlerOpts('getDir', false), async () => {
			const pm = requirePluginManager();
			return { dir: pm.getPluginsDir() };
		})
	);

	// -------------------------------------------------------------------------
	// plugins:refresh — re-scans plugins directory
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:refresh',
		createIpcHandler(handlerOpts('refresh'), async () => {
			const pm = requirePluginManager();
			await pm.initialize();
			return { plugins: pm.getPlugins() };
		})
	);

	// -------------------------------------------------------------------------
	// plugins:bridge:invoke — invoke a handler registered by a main-process plugin
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:bridge:invoke',
		createIpcHandler(handlerOpts('bridge:invoke', false), async (pluginId: string, channel: string, ...args: unknown[]) => {
			if (!ipcBridge) {
				throw new Error('Plugin IPC bridge not initialized');
			}
			const result = await ipcBridge.invoke(pluginId, channel, ...args);
			return { result } as Record<string, unknown>;
		})
	);

	// -------------------------------------------------------------------------
	// plugins:bridge:send — fire-and-forget message to a main-process plugin
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'plugins:bridge:send',
		createIpcHandler(handlerOpts('bridge:send', false), async (pluginId: string, channel: string, ...args: unknown[]) => {
			if (!ipcBridge) {
				throw new Error('Plugin IPC bridge not initialized');
			}
			ipcBridge.send(pluginId, channel, ...args);
			return {} as Record<string, unknown>;
		})
	);

	logger.debug(`${LOG_CONTEXT} Plugin IPC handlers registered`);
}
