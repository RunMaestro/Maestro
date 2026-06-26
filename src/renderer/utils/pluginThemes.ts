/**
 * Renderer-side adapter that turns plugin theme contributions into full Theme
 * objects, using built-in themes as the base palette per mode. Centralized so
 * the active-theme resolver (App.tsx) and the theme picker (AppStandaloneModals)
 * agree on how a plugin theme is materialized.
 */

import { THEMES } from '../constants/themes';
import type { Theme } from '../types';
import type { ThemeContribution } from '../../shared/plugins/contributions';
import { pluginThemeToTheme, pluginThemesToRecord } from '../../shared/plugins/theme-bridge';

// Base palettes a plugin theme inherits omitted keys from. Dracula is the
// canonical dark base; github-light the canonical light base.
const DARK_BASE = THEMES.dracula.colors;
const LIGHT_BASE = THEMES['github-light'].colors;

/** Convert all plugin theme contributions into a `Record<id, Theme>`. */
export function pluginThemesRecord(
	contributions: readonly ThemeContribution[]
): Record<string, Theme> {
	return pluginThemesToRecord(contributions, DARK_BASE, LIGHT_BASE);
}

/** Resolve a single plugin theme contribution to a full Theme by its mode. */
export function resolvePluginTheme(contribution: ThemeContribution): Theme {
	return pluginThemeToTheme(contribution, contribution.mode === 'light' ? LIGHT_BASE : DARK_BASE);
}
