/**
 * useResolvedTheme - the single source of truth for resolving the active Theme
 * from settings. Handles the custom theme, built-in themes, plugin-contributed
 * themes, and a dracula fallback so a removed plugin theme never yields an
 * undefined theme.
 *
 * Both renderer roots use this: the main App (App.tsx) and the cadenza HUD root
 * (cadenzaHud.tsx). Previously the HUD re-derived a lossy subset that only
 * handled `custom`/built-in and returned `undefined` for a plugin theme id.
 *
 * With `themeFollowSystem` on, the theme id comes from `lightThemeId` or
 * `darkThemeId` by this client's own `prefers-color-scheme`, so the desktop and
 * a phone on the web interface can show different themes from one setting.
 */

import { useMemo } from 'react';
import { THEMES } from '../../constants/themes';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePluginContributions } from '../usePluginContributions';
import { resolvePluginTheme } from '../../utils/pluginThemes';
import { usePrefersDarkColorScheme } from './usePrefersDarkColorScheme';
import type { Theme } from '../../types';

/** The theme id to render, given the appearance settings and the device's appearance. */
export function pickThemeIdForAppearance(
	settings: {
		activeThemeId: string;
		themeFollowSystem: boolean;
		lightThemeId: string;
		darkThemeId: string;
	},
	prefersDark: boolean
): string {
	if (!settings.themeFollowSystem) return settings.activeThemeId;
	return prefersDark ? settings.darkThemeId : settings.lightThemeId;
}

export function useResolvedTheme(): Theme {
	const activeThemeId = useSettingsStore((s) => s.activeThemeId);
	const themeFollowSystem = useSettingsStore((s) => s.themeFollowSystem);
	const lightThemeId = useSettingsStore((s) => s.lightThemeId);
	const darkThemeId = useSettingsStore((s) => s.darkThemeId);
	const customThemeColors = useSettingsStore((s) => s.customThemeColors);
	const prefersDark = usePrefersDarkColorScheme();
	// Empty buckets when the plugins Encore flag is off, so this is inert by default.
	const pluginContributions = usePluginContributions();

	const themeId = pickThemeIdForAppearance(
		{ activeThemeId, themeFollowSystem, lightThemeId, darkThemeId },
		prefersDark
	);

	return useMemo(() => {
		if (themeId === 'custom') {
			return { ...THEMES.custom, colors: customThemeColors };
		}
		const builtIn = THEMES[themeId as keyof typeof THEMES];
		if (builtIn) return builtIn;
		// A plugin-contributed theme may be active (its id is outside the built-in
		// union). Resolve it from contributions; fall back to dracula so the app
		// never renders with an undefined theme if the plugin was removed.
		const pluginTheme = pluginContributions.themes.find((t) => t.id === themeId);
		return pluginTheme ? resolvePluginTheme(pluginTheme) : THEMES.dracula;
	}, [themeId, customThemeColors, pluginContributions.themes]);
}
