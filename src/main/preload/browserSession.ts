/**
 * Preload API for Browser Session operations
 *
 * Provides the window.maestro.browserSession namespace for:
 * - Clearing per-partition browsing data (cookies, storage, cache) of
 *   embedded browser tabs
 */

import { ipcRenderer } from 'electron';

export interface BrowserSessionApi {
	clearSessionData: (partition: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Creates the Browser Session API object for preload exposure
 */
export function createBrowserSessionApi(): BrowserSessionApi {
	return {
		clearSessionData: (partition: string): Promise<{ ok: boolean; error?: string }> =>
			ipcRenderer.invoke('browser:clearSessionData', partition),
	};
}
