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

const LOG_CONTEXT = '[BrowserSession]';

// Only the two partition schemes minted for embedded browser tabs may be
// cleared, validated against the FULL minted shape (not just a prefix).
// Mirrors the will-attach-webview gate in
// src/main/app-lifecycle/window-manager.ts and the renderer-side minting in
// src/renderer/utils/browserTabPersistence.ts (sanitizer emits [A-Za-z0-9_-];
// ephemeral adds a -<random8 lowercase alnum> suffix). Anything else (the
// default session, other persist: partitions, malformed keys) is rejected so
// a misbehaving caller cannot wipe unrelated storage.
const PERSISTENT_BROWSER_TAB_PARTITION_PATTERN = /^persist:maestro-browser-session-[A-Za-z0-9_-]+$/;
const EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN = /^maestro-ephemeral-[A-Za-z0-9_-]+-[a-z0-9]{8}$/;

function isAllowedBrowserTabPartition(partition: string): boolean {
	return (
		PERSISTENT_BROWSER_TAB_PARTITION_PATTERN.test(partition) ||
		EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN.test(partition)
	);
}

/**
 * Register all browser session IPC handlers.
 *
 * Handlers:
 * - browser:clearSessionData — Clear all storage data and cache for a browser tab partition
 */
export function registerBrowserSessionHandlers(): void {
	// Clear storage data (cookies, localStorage, IndexedDB, ...) and HTTP cache
	// for a single browser tab partition. Destructive, so the handler validates
	// the SENDER too: only a top-level window webContents (the trusted app
	// renderer) may invoke it — a webview guest that somehow reached ipcRenderer
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
