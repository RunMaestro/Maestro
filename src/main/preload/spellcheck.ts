/**
 * Preload API for spell-check functionality
 *
 * Provides the window.maestro.spellcheck namespace for:
 * - Getting system locale for spell-checker language
 * - Getting spell-check suggestions for misspelled words
 * - Adding words to the custom dictionary
 * - Setting spell-checker languages
 */

import { ipcRenderer } from 'electron';

/**
 * Misspelled word with suggestions
 */
export interface SpellCheckWord {
	word: string;
	suggestions: string[];
}

/**
 * Creates the spellcheck API object for preload exposure
 */
export function createSpellCheckApi() {
	return {
		/**
		 * Get the system locale (e.g., 'en-US', 'en-GB')
		 */
		getSystemLocale: (): Promise<string> => ipcRenderer.invoke('spellcheck:getLocale'),

		/**
		 * Check if a word is misspelled and get suggestions
		 * Uses Electron's built-in spell checker
		 */
		checkWord: (word: string): Promise<SpellCheckWord> =>
			ipcRenderer.invoke('spellcheck:checkWord', word),

		/**
		 * Get spelling suggestions for a misspelled word
		 */
		getSuggestions: (word: string): Promise<string[]> =>
			ipcRenderer.invoke('spellcheck:suggestions', word),

		/**
		 * Add a word to the custom dictionary
		 * The word will no longer be flagged as misspelled
		 */
		addToDictionary: (word: string): Promise<void> =>
			ipcRenderer.invoke('spellcheck:addWord', word),

		/**
		 * Set the spell-checker languages
		 * @param languages - Array of language codes (e.g., ['en-US', 'en-GB'])
		 */
		setLanguages: (languages: string[]): Promise<void> =>
			ipcRenderer.invoke('spellcheck:setLanguages', languages),

		/**
		 * Get the currently configured spell-checker languages
		 */
		getLanguages: (): Promise<string[]> => ipcRenderer.invoke('spellcheck:getLanguages'),

		/**
		 * Get available dictionaries on the system
		 */
		getAvailableDictionaries: (): Promise<string[]> =>
			ipcRenderer.invoke('spellcheck:getAvailableDictionaries'),
	};
}

/**
 * TypeScript type for the spellcheck API
 */
export type SpellCheckApi = ReturnType<typeof createSpellCheckApi>;
