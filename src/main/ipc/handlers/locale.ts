/**
 * IPC Handlers for locale detection and language preference
 *
 * Provides system locale detection via Electron's app.getLocale() and
 * app.getPreferredSystemLanguages(), plus user language preference persistence.
 */

import { ipcMain, App } from 'electron';
import Store from 'electron-store';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../../shared/i18n/config';
import { changeMainLanguage } from '../../i18n';
import { logger } from '../../utils/logger';

export interface LocaleHandlerDependencies {
	app: App;
	settingsStore: Store<any>;
}

/**
 * Map a BCP 47 language tag (e.g., 'zh-CN', 'pt-BR', 'en-US') to one of
 * our supported language codes. Returns undefined if no match is found.
 */
function mapToSupportedLanguage(tag: string): SupportedLanguage | undefined {
	const lower = tag.toLowerCase();

	// Try exact match first
	if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lower)) {
		return lower as SupportedLanguage;
	}

	// Extract the primary language subtag (before the first hyphen)
	const primary = lower.split('-')[0];
	if ((SUPPORTED_LANGUAGES as readonly string[]).includes(primary)) {
		return primary as SupportedLanguage;
	}

	return undefined;
}

/**
 * Detect the best supported language from Electron's system locale APIs.
 * Tries app.getPreferredSystemLanguages() first (ordered by user preference),
 * then falls back to app.getLocale(), and finally to 'en'.
 */
function getSystemLocale(app: App): SupportedLanguage {
	// Try preferred system languages first (ordered by user preference)
	try {
		const preferred = app.getPreferredSystemLanguages();
		for (const lang of preferred) {
			const mapped = mapToSupportedLanguage(lang);
			if (mapped) {
				logger.debug(`System locale detected: ${mapped} (from preferred: ${lang})`, 'Locale');
				return mapped;
			}
		}
	} catch {
		// getPreferredSystemLanguages may not be available on all platforms
	}

	// Fall back to app.getLocale()
	const locale = app.getLocale();
	const mapped = mapToSupportedLanguage(locale);
	if (mapped) {
		logger.debug(`System locale detected: ${mapped} (from app.getLocale: ${locale})`, 'Locale');
		return mapped;
	}

	logger.debug(`No supported locale found, falling back to 'en'`, 'Locale');
	return 'en';
}

export function registerLocaleHandlers(deps: LocaleHandlerDependencies): void {
	const { app, settingsStore } = deps;

	/**
	 * locale:get-system — Returns the detected system locale mapped to a supported language code.
	 */
	ipcMain.handle('locale:get-system', async () => {
		return getSystemLocale(app);
	});

	/**
	 * locale:set — Stores the user's language preference in the settings store.
	 * Note: Maestro uses custom (non-native) menus, so no Electron Menu.setApplicationMenu()
	 * update is needed here. If native menus are added in the future, rebuild them with
	 * translated labels when this handler is called.
	 */
	ipcMain.handle('locale:set', async (_, language: string) => {
		if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(language)) {
			logger.warn(`Attempted to set unsupported language: ${language}`, 'Locale');
			return { success: false, error: `Unsupported language: ${language}` };
		}
		settingsStore.set('language', language);
		await changeMainLanguage(language as SupportedLanguage);
		logger.info(`Language preference set to: ${language}`, 'Locale');
		return { success: true };
	});
}
