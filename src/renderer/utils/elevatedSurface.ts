/**
 * One look for everything that floats above the app: dropdowns, popovers,
 * context menus, hover cards, autocomplete lists, and tooltips with body text.
 *
 * These surfaces used to paint themselves with one of the base surface tokens
 * (`bgSidebar`, `bgActivity`, `bgMain`) and a `theme.colors.border` edge. A
 * popover opened over a surface of the same token then had the same fill as
 * everything behind it, and the border is too faint to separate them (1.0-1.6:1
 * against `bgActivity` on most bundled themes), so the menu's edge disappeared.
 *
 * The fill steps one rung PAST `bgActivity` toward `textMain`. `bgActivity` is
 * the outermost base surface on every bundled theme (it has the lowest text
 * contrast of the three), so one more step in the same direction differs from
 * all three bases: lighter on dark themes, darker on light ones, with no mode
 * check. The blend is small because dim text pays for it (Dracula's `textDim`
 * loses about a third of a contrast point); the border and the shadow do most
 * of the separating.
 *
 * A theme that declares `surfaceElevated` wins outright, the same rule as the
 * other optional slots in `useThemeStyles`. Custom themes may use any CSS
 * colour: the blend helpers return their first argument when a value is not
 * hex, so such a theme degrades to `bgActivity` with its own border rather than
 * breaking.
 */
import type { CSSProperties } from 'react';
import type { Theme, ThemeColors } from '../types';
import { blendColors, relativeLuminance } from '../../shared/colorContrast';

/** How far the fill moves from `bgActivity` toward `textMain`. */
const ELEVATED_FILL_RATIO = 0.05;
/** How far the edge moves from `border` toward `textMain`. */
const ELEVATED_BORDER_RATIO = 0.35;

/** Two-layer drop shadow: a wide soft one for lift, a tight one for the edge. */
const SHADOW_ON_DARK = '0 10px 28px rgb(0 0 0 / 0.5), 0 2px 6px rgb(0 0 0 / 0.3)';
const SHADOW_ON_LIGHT = '0 10px 28px rgb(0 0 0 / 0.16), 0 2px 6px rgb(0 0 0 / 0.1)';

export interface ElevatedSurfaceColors {
	/** Fill for the floating surface. */
	background: string;
	/** Edge color, with real contrast against `background`. */
	border: string;
	/** `box-shadow` value tuned to the fill's lightness. */
	shadow: string;
}

/**
 * The elevated fill, edge, and shadow for a palette. Pure, so the CSS variable
 * `--surface-elevated` (published by `useThemeStyles`) and the inline styles
 * below always agree.
 */
export function getElevatedSurfaceColors(
	colors: Pick<ThemeColors, 'bgActivity' | 'textMain' | 'border' | 'surfaceElevated'>
): ElevatedSurfaceColors {
	const background =
		colors.surfaceElevated ?? blendColors(colors.bgActivity, colors.textMain, ELEVATED_FILL_RATIO);
	const border = blendColors(colors.border, colors.textMain, ELEVATED_BORDER_RATIO);
	const luminance = relativeLuminance(background);
	const shadow = luminance !== null && luminance > 0.4 ? SHADOW_ON_LIGHT : SHADOW_ON_DARK;
	return { background, border, shadow };
}

/**
 * Spread into a floating surface's `style`: fill, a 1px edge, and the shadow.
 * Drop any `border` / `shadow-*` utility classes and `borderColor` /
 * `backgroundColor` entries at the call site, since this sets all of them.
 */
export function elevatedSurfaceStyle(theme: Theme): CSSProperties {
	const { background, border, shadow } = getElevatedSurfaceColors(theme.colors);
	return {
		backgroundColor: background,
		border: `1px solid ${border}`,
		boxShadow: shadow,
	};
}
