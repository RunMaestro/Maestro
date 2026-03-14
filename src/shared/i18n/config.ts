/**
 * i18n Configuration
 *
 * Initializes i18next with react-i18next for internationalization support.
 * Uses browser language detector for automatic locale detection.
 *
 * English translations are bundled statically (always available as fallback).
 * All other languages are lazy-loaded via dynamic imports on first use,
 * keeping the initial bundle small and language switching on-demand.
 *
 * Supported languages: en, es, fr, de, zh, hi, ar, bn, pt
 * Namespaces: common, settings, modals, menus, notifications, accessibility, shortcuts
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';

// Only English is bundled statically (always needed as fallback, ~184KB)
import commonEn from './locales/en/common.json';
import settingsEn from './locales/en/settings.json';
import modalsEn from './locales/en/modals.json';
import menusEn from './locales/en/menus.json';
import notificationsEn from './locales/en/notifications.json';
import accessibilityEn from './locales/en/accessibility.json';
import shortcutsEn from './locales/en/shortcuts.json';

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'hi', 'ar', 'bn', 'pt'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const I18N_NAMESPACES = [
	'common',
	'settings',
	'modals',
	'menus',
	'notifications',
	'accessibility',
	'shortcuts',
] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/** localStorage key used to persist the user's language preference */
export const LANGUAGE_STORAGE_KEY = 'maestro-language';

/** RTL languages in our supported set */
export const RTL_LANGUAGES: SupportedLanguage[] = ['ar'];

/** Native display names for each supported language */
export const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
	en: 'English',
	es: 'Español',
	fr: 'Français',
	de: 'Deutsch',
	zh: '中文',
	hi: 'हिन्दी',
	ar: 'العربية',
	bn: 'বাংলা',
	pt: 'Português',
};

const isDev = process.env.NODE_ENV === 'development';

/**
 * Initialize i18next with all plugins and configuration.
 * Returns a promise that resolves when i18n is ready.
 *
 * English resources are bundled statically (~184KB) for instant fallback.
 * All other languages are lazy-loaded via dynamic imports on first use —
 * Vite code-splits each language into a separate chunk (~20-40KB each).
 */
export function initI18n(): Promise<typeof i18n> {
	return i18n
		.use(LanguageDetector)
		.use(initReactI18next)
		.use(
			resourcesToBackend(
				(language: string, namespace: string) => import(`./locales/${language}/${namespace}.json`)
			)
		)
		.init({
			// English is always bundled — other languages loaded on demand by the backend
			resources: {
				en: {
					common: commonEn,
					settings: settingsEn,
					modals: modalsEn,
					menus: menusEn,
					notifications: notificationsEn,
					accessibility: accessibilityEn,
					shortcuts: shortcutsEn,
				},
			},
			partialBundledLanguages: true,

			fallbackLng: 'en',
			supportedLngs: [...SUPPORTED_LANGUAGES],

			ns: [...I18N_NAMESPACES],
			defaultNS: 'common',

			interpolation: {
				escapeValue: false, // React already escapes rendered output
			},

			// Log missing keys in development so translators can track gaps
			saveMissing: isDev,
			missingKeyHandler: isDev
				? (lngs, ns, key, fallbackValue) => {
						console.warn(
							`[i18n] Missing key: "${ns}:${key}" for language(s): ${(lngs as string[]).join(', ')} (fallback: "${fallbackValue}")`
						);
					}
				: false,

			// On interpolation failure (missing variable), show key in dev, fallback in prod
			missingInterpolationHandler: isDev
				? (text, value) => {
						console.warn(`[i18n] Missing interpolation value: "${value}" in "${text}"`);
						return text;
					}
				: undefined,

			detection: {
				order: ['localStorage', 'navigator'],
				lookupLocalStorage: LANGUAGE_STORAGE_KEY,
			},

			// Don't suspend on missing translations — fall back to English while loading
			react: {
				useSuspense: false,
			},
		})
		.then(() => i18n);
}

export default i18n;
