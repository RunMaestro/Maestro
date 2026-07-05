/**
 * Browser Session IPC Handlers
 *
 * Provides IPC handlers for clearing per-partition browsing data
 * (cookies, storage, cache) of embedded browser tabs.
 *
 * Usage:
 * - window.maestro.browserSession.clearSessionData(partition)
 */

import { ipcMain, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { logger } from '../../utils/logger';
import { isAllowedBrowserTabPartition } from '../../../shared/browserTabPartition';

const LOG_CONTEXT = '[BrowserSession]';

// clearSessionData is validated against the FULL minted partition shape (see
// src/shared/browserTabPartition.ts), shared with the will-attach-webview gate
// in window-manager.ts and the renderer-side minting in
// src/renderer/utils/browserTabPersistence.ts. Anything else (the default
// session, other persist: partitions, malformed keys) is rejected so a
// misbehaving caller cannot wipe unrelated storage.

/**
 * Register all browser session IPC handlers.
 *
 * Handlers:
 * - browser:clearSessionData - Clear all storage data and cache for a browser tab partition
 */
export function registerBrowserSessionHandlers(): void {
	// Clear storage data (cookies, localStorage, IndexedDB, ...) and HTTP cache
	// for a single browser tab partition. Destructive, so the handler validates
	// the SENDER too: only a top-level window webContents (the trusted app
	// renderer) may invoke it: a webview guest that somehow reached ipcRenderer
	// is rejected outright.
	ipcMain.handle(
		'browser:clearSessionData',
		async (
			event: IpcMainInvokeEvent,
			partition: string
		): Promise<{ ok: boolean; error?: string }> => {
			if (event.sender.getType() !== 'window') {
				logger.warn(
					`${LOG_CONTEXT} clearSessionData rejected: sender type '${event.sender.getType()}' is not a window`,
					'BrowserSession'
				);
				return { ok: false, error: 'Not allowed from this context' };
			}
			if (typeof partition !== 'string' || !isAllowedBrowserTabPartition(partition)) {
				return { ok: false, error: 'Invalid browser tab partition' };
			}

			try {
				const tabSession = session.fromPartition(partition);
				await tabSession.clearStorageData();
				await tabSession.clearCache();
				return { ok: true };
			} catch (error) {
				logger.error(
					`${LOG_CONTEXT} clearSessionData failed: ${error instanceof Error ? error.message : String(error)}`,
					'BrowserSession'
				);
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
	);
}
