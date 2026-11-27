/**
 * Builds a runmaestro.ai URL with the user's current theme as a query parameter.
 * The website reads ?theme=<themeId> on mount and applies it immediately.
 */

import { useSettingsStore } from '../stores/settingsStore';
import { THEMES } from '../../shared/themes';

/**
 * The live privacy page. Every Privacy entry point (About modal, Settings ->
 * About, command palette) opens this URL rather than a bundled copy, so the
 * app always shows the current text.
 */
export const MAESTRO_PRIVACY_URL = 'https://runmaestro.ai/privacy/';

export function buildMaestroUrl(base: string): string {
	const themeId = useSettingsStore.getState().activeThemeId;
	const url = new URL(base);
	if (themeId && themeId !== 'custom') {
		url.searchParams.set('theme', themeId);
	} else {
		const theme = THEMES[themeId];
		if (theme?.mode) {
			url.searchParams.set('theme', theme.mode === 'light' ? 'light' : 'dark');
		}
	}
	return url.toString();
}
