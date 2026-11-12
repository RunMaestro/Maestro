import { Menu, type BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

/**
 * Wire up the editable-field context menu with spell-check suggestions.
 */
export function attachSpellCheckContextMenu(mainWindow: BrowserWindow): void {
	// Spell check suggestions: Electron renders red squiggles automatically when
	// `spellcheck` is true on a form element, but the right-click "Did you mean..."
	// menu has to be wired up in the main process.
	mainWindow.webContents.on('context-menu', (_event, params) => {
		logger.debug('context-menu fired', 'Window', {
			isEditable: params.isEditable,
			misspelledWord: params.misspelledWord,
			suggestions: params.dictionarySuggestions,
			selectionText: params.selectionText,
		});

		if (!params.isEditable) return;

		const template: Electron.MenuItemConstructorOptions[] = [];

		const suggestions = params.dictionarySuggestions ?? [];
		if (params.misspelledWord) {
			if (suggestions.length === 0) {
				template.push({ label: 'No suggestions', enabled: false });
			} else {
				for (const suggestion of suggestions) {
					template.push({
						label: suggestion,
						click: () => mainWindow.webContents.replaceMisspelling(suggestion),
					});
				}
			}
			template.push(
				{ type: 'separator' },
				{
					label: 'Add to Dictionary',
					click: () =>
						mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
				},
				{ type: 'separator' }
			);
		}

		template.push(
			{ role: 'cut' },
			{ role: 'copy' },
			{ role: 'paste' },
			{ type: 'separator' },
			{ role: 'selectAll' }
		);

		Menu.buildFromTemplate(template).popup({ window: mainWindow });
	});
}
