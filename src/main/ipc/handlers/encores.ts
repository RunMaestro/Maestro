/**
 * Plugin IPC Handlers
 *
 * Provides handlers for querying and managing encores from the renderer process.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { getEncoreManager } from '../../encore-manager';
import type { EncoreIpcBridge } from '../../encore-ipc-bridge';

const LOG_CONTEXT = '[Encores]';

// ============================================================================
// Dependencies Interface
// ============================================================================

export interface EncoreHandlerDependencies {
	ipcBridge?: EncoreIpcBridge;
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
 * Get the EncoreManager, throwing if not initialized.
 */
function requireEncoreManager() {
	const manager = getEncoreManager();
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
export function registerEncoreHandlers(deps: EncoreHandlerDependencies): void {
	const { ipcBridge } = deps;

	// EncoreManager must already be created and initialized by main startup
	// (see index.ts — createEncoreManager + initialize runs before this)
	if (!getEncoreManager()) {
		logger.error('registerEncoreHandlers called before EncoreManager was initialized', LOG_CONTEXT);
	}

	// -------------------------------------------------------------------------
	// encores:getAll — returns all LoadedEncore[]
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:getAll',
		createIpcHandler(handlerOpts('getAll', false), async () => {
			const pm = requireEncoreManager();
			return { encores: pm.getEncores() };
		})
	);

	// -------------------------------------------------------------------------
	// encores:enable — enables an encore by ID
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:enable',
		createIpcHandler(handlerOpts('enable'), async (id: string) => {
			const pm = requireEncoreManager();
			const result = await pm.enableEncore(id);
			return { enabled: result };
		})
	);

	// -------------------------------------------------------------------------
	// encores:disable — disables an encore by ID
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:disable',
		createIpcHandler(handlerOpts('disable'), async (id: string) => {
			const pm = requireEncoreManager();
			const result = await pm.disableEncore(id);
			return { disabled: result };
		})
	);

	// -------------------------------------------------------------------------
	// encores:getDir — returns the encores directory path
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:getDir',
		createIpcHandler(handlerOpts('getDir', false), async () => {
			const pm = requireEncoreManager();
			return { dir: pm.getEncoresDir() };
		})
	);

	// -------------------------------------------------------------------------
	// encores:refresh — re-scans encores directory
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:refresh',
		createIpcHandler(handlerOpts('refresh'), async () => {
			const pm = requireEncoreManager();
			await pm.initialize();
			return { encores: pm.getEncores() };
		})
	);

	// -------------------------------------------------------------------------
	// encores:settings:get — get all settings for an encore
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:settings:get',
		createIpcHandler(handlerOpts('settings:get', false), async (encoreId: string) => {
			const pm = requireEncoreManager();
			return { settings: pm.getAllEncoreSettings(encoreId) };
		})
	);

	// -------------------------------------------------------------------------
	// encores:settings:set — set a single encore setting
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:settings:set',
		createIpcHandler(handlerOpts('settings:set'), async (encoreId: string, key: string, value: unknown) => {
			const pm = requireEncoreManager();
			pm.setEncoreSetting(encoreId, key, value);
			return { set: true };
		})
	);

	// -------------------------------------------------------------------------
	// encores:bridge:invoke — invoke a handler registered by a main-process encore
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:bridge:invoke',
		createIpcHandler(handlerOpts('bridge:invoke', false), async (encoreId: string, channel: string, ...args: unknown[]) => {
			if (!ipcBridge) {
				throw new Error('Plugin IPC bridge not initialized');
			}
			const result = await ipcBridge.invoke(encoreId, channel, ...args);
			return { result } as Record<string, unknown>;
		})
	);

	// -------------------------------------------------------------------------
	// encores:bridge:send — fire-and-forget message to a main-process encore
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'encores:bridge:send',
		createIpcHandler(handlerOpts('bridge:send', false), async (encoreId: string, channel: string, ...args: unknown[]) => {
			if (!ipcBridge) {
				throw new Error('Plugin IPC bridge not initialized');
			}
			ipcBridge.send(encoreId, channel, ...args);
			return {} as Record<string, unknown>;
		})
	);

	logger.debug(`${LOG_CONTEXT} Plugin IPC handlers registered`);
}
