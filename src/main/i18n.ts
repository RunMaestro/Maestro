/**
 * Main Process i18n
 *
 * Provides translation support for main-process user-facing strings
 * (dialog titles, notification text, error messages).
 *
 * Uses a separate i18next instance from the renderer — only loads
 * the 'common' and 'notifications' namespaces to stay lightweight.
 *
 * Resources are statically imported (not loaded via fs-backend) for
 * reliable path resolution across development and packaged builds.
 */

import i18next, { type Resource } from 'i18next';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../shared/i18n/config';
import { logger } from './utils/logger';

// Static imports: common namespace (all languages)
import commonEn from '../shared/i18n/locales/en/common.json';
import commonEs from '../shared/i18n/locales/es/common.json';
import commonFr from '../shared/i18n/locales/fr/common.json';
import commonDe from '../shared/i18n/locales/de/common.json';
import commonZh from '../shared/i18n/locales/zh/common.json';
import commonHi from '../shared/i18n/locales/hi/common.json';
import commonAr from '../shared/i18n/locales/ar/common.json';
import commonBn from '../shared/i18n/locales/bn/common.json';
import commonPt from '../shared/i18n/locales/pt/common.json';

// Static imports: notifications namespace (all languages)
import notificationsEn from '../shared/i18n/locales/en/notifications.json';
import notificationsEs from '../shared/i18n/locales/es/notifications.json';
import notificationsFr from '../shared/i18n/locales/fr/notifications.json';
import notificationsDe from '../shared/i18n/locales/de/notifications.json';
import notificationsZh from '../shared/i18n/locales/zh/notifications.json';
import notificationsHi from '../shared/i18n/locales/hi/notifications.json';
import notificationsAr from '../shared/i18n/locales/ar/notifications.json';
import notificationsBn from '../shared/i18n/locales/bn/notifications.json';
import notificationsPt from '../shared/i18n/locales/pt/notifications.json';

/** Dedicated i18next instance for the main process (separate from renderer) */
const mainI18n = i18next.createInstance();

const MAIN_NAMESPACES = ['common', 'notifications'] as const;

const resources: Resource = {
	en: { common: commonEn, notifications: notificationsEn },
	es: { common: commonEs, notifications: notificationsEs },
	fr: { common: commonFr, notifications: notificationsFr },
	de: { common: commonDe, notifications: notificationsDe },
	zh: { common: commonZh, notifications: notificationsZh },
	hi: { common: commonHi, notifications: notificationsHi },
	ar: { common: commonAr, notifications: notificationsAr },
	bn: { common: commonBn, notifications: notificationsBn },
	pt: { common: commonPt, notifications: notificationsPt },
};

/**
 * Initialize the main process i18n instance.
 * Call after the settings store is available so the stored language preference can be read.
 *
 * @param language - Initial language (from settings store). Defaults to 'en'.
 */
export async function initMainI18n(language?: string): Promise<void> {
	const lng =
		language && (SUPPORTED_LANGUAGES as readonly string[]).includes(language) ? language : 'en';

	await mainI18n.init({
		resources,
		lng,
		fallbackLng: 'en',
		supportedLngs: [...SUPPORTED_LANGUAGES],
		ns: [...MAIN_NAMESPACES],
		defaultNS: 'common',
		interpolation: {
			escapeValue: false,
		},
	});

	logger.info(`Main process i18n initialized (language: ${mainI18n.language})`, 'i18n');
}

/**
 * Change the main process i18n language at runtime.
 * Called from the locale:set IPC handler when the user switches languages.
 */
export async function changeMainLanguage(language: SupportedLanguage): Promise<void> {
	await mainI18n.changeLanguage(language);
	logger.debug(`Main process language changed to: ${language}`, 'i18n');
}

/**
 * Translation function for main-process code.
 * Wraps the main i18next instance's t() for use outside the React render tree.
 *
 * Usage:
 *   mainT('common:save')                    → "Save" (en) / "Guardar" (es)
 *   mainT('notifications:task.completed_title') → "Task Complete" (en)
 *   mainT('common:dialog.save_file')        → "Save File" (en)
 */
export function mainT(key: string, options?: Record<string, unknown>): string {
	// Cast to bypass strict typed-key checking (same pattern as shared/formatters.ts)
	return (mainI18n.t as (key: string, options?: Record<string, unknown>) => string)(key, options);
}

/** Expose the underlying instance for testing and advanced use cases */
export { mainI18n };
