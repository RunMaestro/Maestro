/**
 * Bridge plugin-contributed themes into Maestro's Theme shape.
 *
 * A plugin declares a theme as a loose `{ mode, colors: Record<string,string> }`.
 * The host's renderer needs a full `Theme` with a complete `ThemeColors` palette
 * (13 required keys plus optional ANSI/selection entries). This module overlays
 * the plugin's colors onto a base palette (picked by mode) so a plugin can
 * supply just an accent or two and still produce a coherent, fully-populated
 * theme. Unknown color keys in the contribution are ignored.
 *
 * Pure and bundle-safe (no fs, no Electron). The caller supplies the base
 * palettes, so this module does not depend on the built-in theme table.
 */

import type { Theme, ThemeColors } from '../theme-types';
import type { ThemeContribution } from './contributions';

/**
 * Every key of ThemeColors. Used to filter a plugin's loose color map down to
 * recognized keys (a plugin cannot inject arbitrary properties onto the palette).
 * Kept in sync with the ThemeColors interface in theme-types.ts.
 */
const THEME_COLOR_KEYS: ReadonlyArray<keyof ThemeColors> = [
	'bgMain',
	'bgSidebar',
	'bgActivity',
	'bgTitleBar',
	'border',
	'textMain',
	'textDim',
	'accent',
	'accentDim',
	'accentText',
	'accentForeground',
	'success',
	'warning',
	'error',
	'ansiBlack',
	'ansiRed',
	'ansiGreen',
	'ansiYellow',
	'ansiBlue',
	'ansiMagenta',
	'ansiCyan',
	'ansiWhite',
	'ansiBrightBlack',
	'ansiBrightRed',
	'ansiBrightGreen',
	'ansiBrightYellow',
	'ansiBrightBlue',
	'ansiBrightMagenta',
	'ansiBrightCyan',
	'ansiBrightWhite',
	'selection',
];

const THEME_COLOR_KEY_SET = new Set<string>(THEME_COLOR_KEYS as readonly string[]);

/**
 * Overlay a plugin theme's recognized colors onto a base palette and return a
 * complete Theme. The plugin's namespaced id becomes the Theme id (cast to
 * ThemeId - plugin ids live outside the built-in union but are valid at runtime,
 * mirroring how runtime agents extend AGENT_IDS).
 */
export function pluginThemeToTheme(contribution: ThemeContribution, base: ThemeColors): Theme {
	const colors: ThemeColors = { ...base };
	const writable = colors as unknown as Record<string, string>;
	for (const [key, value] of Object.entries(contribution.colors)) {
		if (typeof value === 'string' && THEME_COLOR_KEY_SET.has(key)) {
			writable[key] = value;
		}
	}
	return {
		id: contribution.id as Theme['id'],
		name: contribution.name,
		mode: contribution.mode,
		colors,
	};
}

/**
 * Convert all plugin theme contributions into a `Record<id, Theme>` ready to
 * merge with the built-in THEMES map. `baseDark`/`baseLight` are full base
 * palettes the host supplies (typically a built-in dark and light theme's
 * colors) so contributed themes inherit sensible values for keys they omit.
 */
export function pluginThemesToRecord(
	contributions: readonly ThemeContribution[],
	baseDark: ThemeColors,
	baseLight: ThemeColors
): Record<string, Theme> {
	const out: Record<string, Theme> = {};
	for (const c of contributions) {
		const base = c.mode === 'light' ? baseLight : baseDark;
		out[c.id] = pluginThemeToTheme(c, base);
	}
	return out;
}
