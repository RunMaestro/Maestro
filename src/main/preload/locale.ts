/**
 * Preload API for locale detection and language preference
 *
 * Provides the window.maestro.locale namespace for:
 * - Detecting system locale from the main process
 * - Persisting the user's language preference
 */

import { ipcRenderer } from 'electron';

/**
 * Creates the locale API object for preload exposure
 */
export function createLocaleApi() {
	return {
		/**
		 * Get the detected system locale mapped to a supported language code.
		 * Uses Electron's app.getLocale() and app.getPreferredSystemLanguages().
		 * @returns A supported language code (e.g., 'en', 'zh', 'pt')
		 */
		getSystem: (): Promise<string> => ipcRenderer.invoke('locale:get-system'),

		/**
		 * Store the user's language preference in the settings store.
		 * @param language - A supported language code
		 * @returns Success/error result
		 */
		set: (language: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('locale:set', language),
	};
}

export type LocaleApi = ReturnType<typeof createLocaleApi>;
