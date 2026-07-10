/**
 * useResolvedTheme - the single source of truth for resolving the active Theme
 * from settings. Handles the custom theme, built-in themes, plugin-contributed
 * themes, and a dracula fallback so a removed plugin theme never yields an
 * undefined theme.
 *
 * Both renderer roots use this: the main App (App.tsx) and the cadenza HUD root
 * (cadenzaHud.tsx). Previously the HUD re-derived a lossy subset that only
 * handled `custom`/built-in and returned `undefined` for a plugin theme id.
 */

import { useMemo } from 'react';
import { THEMES } from '../../constants/themes';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePluginContributions } from '../usePluginContributions';
import { resolvePluginTheme } from '../../utils/pluginThemes';
import type { Theme } from '../../types';

export function useResolvedTheme(): Theme {
	const activeThemeId = useSettingsStore((s) => s.activeThemeId);
	const customThemeColors = useSettingsStore((s) => s.customThemeColors);
	// Empty buckets when the plugins Encore flag is off, so this is inert by default.
	const pluginContributions = usePluginContributions();

	return useMemo(() => {
		if (activeThemeId === 'custom') {
			return { ...THEMES.custom, colors: customThemeColors };
		}
		const builtIn = THEMES[activeThemeId];
		if (builtIn) return builtIn;
		// A plugin-contributed theme may be active (its id is outside the built-in
		// union). Resolve it from contributions; fall back to dracula so the app
		// never renders with an undefined theme if the plugin was removed.
		const pluginTheme = pluginContributions.themes.find((t) => t.id === activeThemeId);
		return pluginTheme ? resolvePluginTheme(pluginTheme) : THEMES.dracula;
	}, [activeThemeId, customThemeColors, pluginContributions.themes]);
}
