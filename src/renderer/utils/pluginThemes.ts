/**
 * Renderer-side adapter that turns plugin theme contributions into full Theme
 * objects, using built-in themes as the base palette per mode. Centralized so
 * the active-theme resolver (App.tsx) and the theme picker (AppStandaloneModals)
 * agree on how a plugin theme is materialized and merged.
 */

import type { Theme } from '../types';
import type { ThemeContribution } from '../../shared/plugins/contributions';
import { pluginThemeToTheme } from '../../shared/plugins/theme-bridge';
import { mergePluginContributions } from './pluginContributionMerge';
import { THEMES } from '../constants/themes';

// Base palettes a plugin theme inherits omitted keys from. Dracula is the
// canonical dark base; github-light the canonical light base.
const DARK_BASE = THEMES.dracula.colors;
const LIGHT_BASE = THEMES['github-light'].colors;

/** Resolve a single plugin theme contribution to a full Theme by its mode. */
export function resolvePluginTheme(contribution: ThemeContribution): Theme {
	return pluginThemeToTheme(contribution, contribution.mode === 'light' ? LIGHT_BASE : DARK_BASE);
}

/**
 * Merge built-in themes with plugin-contributed themes for the theme picker,
 * routed through the shared contribution registry so a built-in always wins an
 * id collision (a plugin can never shadow or impersonate a first-party theme)
 * and an earlier plugin wins a later duplicate. Returns a `Record<id, Theme>`
 * ready to drive the picker. Identical to the built-in map when the plugins
 * Encore flag is off (no contributions to merge).
 */
export function mergePluginThemes(
	builtins: Record<string, Theme>,
	contributions: readonly ThemeContribution[]
): Record<string, Theme> {
	const pluginThemes = contributions.map((c) => ({
		...resolvePluginTheme(c),
		pluginId: c.pluginId,
	}));
	const merged = mergePluginContributions<Theme>(Object.values(builtins), pluginThemes);
	const out: Record<string, Theme> = {};
	for (const { item } of merged.items) out[item.id] = item;
	return out;
}
