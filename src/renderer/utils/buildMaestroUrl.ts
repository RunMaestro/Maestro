/**
 * Builds a runmaestro.ai URL with the user's current theme as a query parameter.
 * The website reads ?theme=<themeId> on mount and applies it immediately.
 */

import { useSettingsStore } from '../stores/settingsStore';
import { THEMES } from '../../shared/themes';

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
