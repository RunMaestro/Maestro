/**
 * One color language for every delegation surface.
 *
 * The Overview's Query Source donut, the split bar, the summary card, and the
 * Activity trend chart all read these colors (accent = interactive, muted
 * slate = Auto Run, warning = Cue) rather than inventing a second mapping for
 * the same three categories. The milestone track is deliberately NOT in this
 * palette: it is an achievement, and it borrows the badge gold instead.
 */

import type { Theme } from '../../types';
import { cssColorToHex, hexToRgb } from '../../../shared/colorContrast';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_BINARY_PALETTE,
} from '../../constants/colorblindPalettes';

export interface DelegationPalette {
	interactive: string;
	autoRun: string;
	cue: string;
	/** Auto Run + Cue drawn as one bar, where the two aren't split apart. */
	delegated: string;
}

/**
 * Mean channel value (0-255) of the theme accent, or null when the accent is
 * not an opaque color the contrast helpers can read. Charts that pair a second
 * color with the accent use it to pick the lighter or darker variant.
 */
export function accentBrightness(theme: Theme): number | null {
	const rgb = hexToRgb(cssColorToHex(theme.colors.accent) ?? '');
	return rgb ? (rgb.r + rgb.g + rgb.b) / 3 : null;
}

/**
 * A muted color for Auto Run that stays legible against any accent: a bright
 * accent gets the darker slate, a dark one the lighter slate.
 */
function mutedAutoColor(theme: Theme): string {
	const brightness = accentBrightness(theme);
	if (brightness === null) return '#6b7280';
	return brightness > 128 ? '#64748b' : '#94a3b8';
}

export function delegationColors(theme: Theme, colorBlindMode = false): DelegationPalette {
	const interactive = colorBlindMode ? COLORBLIND_BINARY_PALETTE.primary : theme.colors.accent;
	const autoRun = colorBlindMode ? COLORBLIND_BINARY_PALETTE.secondary : mutedAutoColor(theme);
	// Teal (Wong index 2) contrasts with the blue/orange binary pair.
	const cue = colorBlindMode ? COLORBLIND_AGENT_PALETTE[2] : theme.colors.warning;
	return { interactive, autoRun, cue, delegated: colorBlindMode ? autoRun : theme.colors.warning };
}

/** Badge gold, the milestone-track fill. Matches the achievement card's language. */
export const DELEGATION_MILESTONE_GOLD = '#FFD700';
