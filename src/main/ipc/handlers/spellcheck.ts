/**
 * IPC Handlers for Spell-Check
 *
 * Provides handlers for spell-check functionality using Electron's built-in spell checker.
 * Supports getting suggestions, adding to dictionary, and configuring languages.
 */

import { ipcMain, app, session } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[SpellCheck]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Register all spell-check related IPC handlers.
 */
export function registerSpellCheckHandlers(): void {
	// Get system locale
	ipcMain.handle(
		'spellcheck:getLocale',
		withIpcErrorLogging(handlerOpts('getLocale'), async () => {
			return app.getLocale();
		})
	);

	// Check if a word is misspelled and get suggestions
	// Note: Electron's spell checker API is limited - actual spell checking happens
	// at the webContents level and suggestions appear in the native context menu
	ipcMain.handle(
		'spellcheck:checkWord',
		withIpcErrorLogging(handlerOpts('checkWord'), async (word: string) => {
			// Electron doesn't provide a direct API to check if a word is misspelled
			// The native spell-check with context menu handles this automatically
			// This handler is provided for potential future enhancements
			return {
				word,
				suggestions: [],
			};
		})
	);

	// Get spelling suggestions for a word
	// Note: Electron's spell checker works at the webContents level via context menu
	// This handler provides a programmatic way to get suggestions
	ipcMain.handle(
		'spellcheck:suggestions',
		withIpcErrorLogging(handlerOpts('getSuggestions'), async (word: string) => {
			// Electron's built-in spell checker provides suggestions via webContents.replaceMisspelling()
			// and the context menu. For programmatic access, we need to use the webContents API.
			// Since we don't have direct access to webContents here, we return an empty array
			// and rely on the native spell-check context menu.

			// Note: The actual spell-check suggestions are provided by Electron's native
			// context menu when right-clicking on a misspelled word in a textarea with spellcheck="true"

			logger.debug('Spell-check suggestions requested', LOG_CONTEXT, {
				length: word.length,
			});

			// Return empty - native spell-check handles this via context menu
			return [];
		})
	);

	// Add a word to the custom dictionary
	ipcMain.handle(
		'spellcheck:addWord',
		withIpcErrorLogging(handlerOpts('addWord'), async (word: string) => {
			const ses = session.defaultSession;
			ses.addWordToSpellCheckerDictionary(word);
			logger.info('Added word to spell-checker dictionary', LOG_CONTEXT, {
				length: word.length,
			});
		})
	);

	// Set spell-checker languages
	ipcMain.handle(
		'spellcheck:setLanguages',
		withIpcErrorLogging(handlerOpts('setLanguages'), async (languages: string[]) => {
			const ses = session.defaultSession;
			ses.setSpellCheckerLanguages(languages);
			logger.info(`Spell-checker languages set to: ${languages.join(', ')}`, LOG_CONTEXT);
		})
	);

	// Get currently configured spell-checker languages
	ipcMain.handle(
		'spellcheck:getLanguages',
		withIpcErrorLogging(handlerOpts('getLanguages'), async () => {
			const ses = session.defaultSession;
			return ses.getSpellCheckerLanguages();
		})
	);

	// Get available dictionaries
	ipcMain.handle(
		'spellcheck:getAvailableDictionaries',
		withIpcErrorLogging(handlerOpts('getAvailableDictionaries'), async () => {
			const ses = session.defaultSession;
			return ses.availableSpellCheckerLanguages;
		})
	);

	logger.info('Spell-check IPC handlers registered', LOG_CONTEXT);
}
