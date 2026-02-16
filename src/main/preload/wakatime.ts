/**
 * Preload API for WakaTime operations
 *
 * Provides the window.maestro.wakatime namespace for:
 * - CLI availability checking
 * - API key validation
 */

import { ipcRenderer } from 'electron';

export interface WakatimeApi {
	checkCli: () => Promise<{ available: boolean; version?: string }>;
	validateApiKey: (key: string) => Promise<{ valid: boolean }>;
}

/**
 * Creates the WakaTime API object for preload exposure
 */
export function createWakatimeApi(): WakatimeApi {
	return {
		checkCli: (): Promise<{ available: boolean; version?: string }> =>
			ipcRenderer.invoke('wakatime:checkCli'),

		validateApiKey: (key: string): Promise<{ valid: boolean }> =>
			ipcRenderer.invoke('wakatime:validateApiKey', key),
	};
}
