/**
 * i18n Type Definitions
 *
 * Provides typed namespace unions and key helpers for type-safe translations.
 * Used alongside resources.d.ts to enable autocompletion on t() calls.
 */

import type { I18nNamespace } from './config';

import type commonEn from './locales/en/common.json';
import type settingsEn from './locales/en/settings.json';
import type modalsEn from './locales/en/modals.json';
import type menusEn from './locales/en/menus.json';
import type notificationsEn from './locales/en/notifications.json';
import type accessibilityEn from './locales/en/accessibility.json';
import type shortcutsEn from './locales/en/shortcuts.json';

/** Map each namespace to its translation key set (derived from English base files) */
export interface I18nResources {
	common: typeof commonEn;
	settings: typeof settingsEn;
	modals: typeof modalsEn;
	menus: typeof menusEn;
	notifications: typeof notificationsEn;
	accessibility: typeof accessibilityEn;
	shortcuts: typeof shortcutsEn;
}

/** Extract valid translation keys for a given namespace */
export type TranslationKey<NS extends I18nNamespace> = keyof I18nResources[NS] & string;
