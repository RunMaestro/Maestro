/**
 * Helpers for the curated WebSettings payload that the desktop broadcasts
 * to connected web/mobile clients. Single source of truth so both the
 * web-server-factory (web→desktop write path) and the persistence handler
 * (desktop→web write path) can build an identical snapshot.
 */

import type { SettingsStoreInterface } from '../stores/types';
import type { Shortcut } from '../../shared/shortcut-types';
import type { WebSettings } from './types';

/**
 * Settings keys whose changes should be broadcast to web clients so they
 * see desktop-originated edits live (instead of only on reconnect/reload).
 *
 * Keep in sync with the keys read by buildWebSettingsSnapshot — adding a
 * field there means adding its underlying key here.
 */
export const WEB_SETTINGS_BROADCAST_KEYS: ReadonlySet<string> = new Set([
	'activeThemeId',
	'fontSize',
	'enterToSendAI',
	'defaultSaveToHistory',
	'defaultShowThinking',
	'osNotificationsEnabled',
	'audioFeedbackEnabled',
	'colorBlindMode',
	'conductorProfile',
	'maxOutputLines',
	'shortcuts',
]);

/**
 * Read the curated WebSettings shape from the settings store. Defaults
 * mirror metadata defaults so a missing/unset value reaches the client
 * with the same fallback the desktop UI uses.
 */
export function buildWebSettingsSnapshot(settingsStore: SettingsStoreInterface): WebSettings {
	return {
		theme: settingsStore.get('activeThemeId', 'dracula') as string,
		fontSize: settingsStore.get('fontSize', 14) as number,
		enterToSendAI: settingsStore.get('enterToSendAI', false) as boolean,
		defaultSaveToHistory: settingsStore.get('defaultSaveToHistory', true) as boolean,
		defaultShowThinking: settingsStore.get('defaultShowThinking', 'off') as string,
		autoScroll: true,
		notificationsEnabled: settingsStore.get('osNotificationsEnabled', true) as boolean,
		audioFeedbackEnabled: settingsStore.get('audioFeedbackEnabled', false) as boolean,
		colorBlindMode: settingsStore.get('colorBlindMode', 'false') as string,
		conductorProfile: settingsStore.get('conductorProfile', '') as string,
		maxOutputLines: settingsStore.get('maxOutputLines', null) as number | null,
		shortcuts: settingsStore.get('shortcuts', {}) as Record<string, Shortcut>,
	};
}
