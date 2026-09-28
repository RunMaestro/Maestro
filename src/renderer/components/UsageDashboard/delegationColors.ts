/**
 * One color language for every delegation surface.
 *
 * The Overview donut already taught these colors (accent = interactive, muted
 * slate = Auto Run, warning = Cue), so the split bar, the summary card, and the
 * Activity trend chart reuse them rather than inventing a second mapping for
 * the same three categories. The milestone track is deliberately NOT in this
 * palette: it is an achievement, and it borrows the badge gold instead.
 */

import type { Theme } from '../../types';
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
 * A muted color for Auto Run that stays legible against any accent.
 *
 * Mirrors `getAutoColor` in SourceDistributionChart: a bright theme gets the
 * darker slate, a dark theme the lighter one. Kept as its own function here so
 * the chart's private helper doesn't have to become an export just to be shared
 * with three new surfaces.
 */
function mutedAutoColor(theme: Theme): string {
	const accent = theme.colors.accent;
	let rgb: { r: number; g: number; b: number } | null = null;

	if (accent.startsWith('#') && accent.length >= 7) {
		rgb = {
			r: parseInt(accent.slice(1, 3), 16),
			g: parseInt(accent.slice(3, 5), 16),
			b: parseInt(accent.slice(5, 7), 16),
		};
	} else if (accent.startsWith('rgb')) {
		const parts = accent.match(/\d+/g);
		if (parts && parts.length >= 3) {
			rgb = { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) };
		}
	}

	if (!rgb || Number.isNaN(rgb.r) || Number.isNaN(rgb.g) || Number.isNaN(rgb.b)) {
		return '#6b7280';
	}
	const avg = (rgb.r + rgb.g + rgb.b) / 3;
	return avg > 128 ? '#64748b' : '#94a3b8';
}

export function delegationColors(theme: Theme, colorBlindMode = false): DelegationPalette {
	const interactive = colorBlindMode ? COLORBLIND_BINARY_PALETTE.primary : theme.colors.accent;
	const autoRun = colorBlindMode ? COLORBLIND_BINARY_PALETTE.secondary : mutedAutoColor(theme);
	// Teal (Wong index 2) is the third color the donut already uses for Cue.
	const cue = colorBlindMode ? COLORBLIND_AGENT_PALETTE[2] : theme.colors.warning;
	return { interactive, autoRun, cue, delegated: colorBlindMode ? autoRun : theme.colors.warning };
}

/** Badge gold, the milestone-track fill. Matches the achievement card's language. */
export const DELEGATION_MILESTONE_GOLD = '#FFD700';
