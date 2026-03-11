/**
 * i18n Configuration
 *
 * Initializes i18next with react-i18next for internationalization support.
 * Uses browser language detector for automatic locale detection and
 * bundled JSON resources for translation strings.
 *
 * Supported languages: en, es, fr, de, zh, hi, ar, bn, pt
 * Namespaces: common, settings, modals, menus, notifications, accessibility
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import English base translations (bundled at build time)
import commonEn from './locales/en/common.json';
import settingsEn from './locales/en/settings.json';
import modalsEn from './locales/en/modals.json';
import menusEn from './locales/en/menus.json';
import notificationsEn from './locales/en/notifications.json';
import accessibilityEn from './locales/en/accessibility.json';

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'hi', 'ar', 'bn', 'pt'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const I18N_NAMESPACES = [
	'common',
	'settings',
	'modals',
	'menus',
	'notifications',
	'accessibility',
] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/** localStorage key used to persist the user's language preference */
export const LANGUAGE_STORAGE_KEY = 'maestro-language';

/** RTL languages in our supported set */
export const RTL_LANGUAGES: SupportedLanguage[] = ['ar'];

/**
 * Initialize i18next with all plugins and configuration.
 * Returns a promise that resolves when i18n is ready.
 *
 * English translations are bundled directly; other languages
 * will be lazy-loaded in future phases.
 */
export function initI18n(): Promise<typeof i18n> {
	return i18n
		.use(LanguageDetector)
		.use(initReactI18next)
		.init({
			// Bundled resources — English loaded at startup, others added lazily
			resources: {
				en: {
					common: commonEn,
					settings: settingsEn,
					modals: modalsEn,
					menus: menusEn,
					notifications: notificationsEn,
					accessibility: accessibilityEn,
				},
			},

			fallbackLng: 'en',
			supportedLngs: [...SUPPORTED_LANGUAGES],

			ns: [...I18N_NAMESPACES],
			defaultNS: 'common',

			interpolation: {
				escapeValue: false, // React already escapes rendered output
			},

			detection: {
				order: ['localStorage', 'navigator'],
				lookupLocalStorage: LANGUAGE_STORAGE_KEY,
			},

			// Don't suspend on missing translations — fall back to English
			react: {
				useSuspense: false,
			},
		})
		.then(() => i18n);
}

export default i18n;
