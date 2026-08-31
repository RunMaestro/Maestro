/**
 * Density ladder for the History filter pills (USER / AGENT / AUTO / CUE).
 *
 * The pills share their toolbar row with the search and help buttons, and the
 * row neither wraps nor scrolls. Nothing in it shrinks, so once the pills grew
 * past the space available the overflow spilled out of both ends of a centred
 * row and the two buttons were simply cut off - a control the user cannot see
 * is a control they do not have.
 *
 * A static width threshold cannot decide this. What the row needs depends on
 * the interface font (the root is a proportional face now, whose uppercase
 * glyphs are far wider per em than the monospace the sizes were tuned against),
 * on the Cmd+= zoom, and on whether Cue is on - three or four pills. The panel
 * width knows none of that, which is why the pills fitted at one setting and
 * clipped at another with the same number in `rightPanelWidth`.
 *
 * So the row measures, and this module turns the two measurements into a rung.
 * Pure, and separate from the component, so the arithmetic can be tested
 * without a layout engine.
 */

import { RIGHT_PANEL_PILL_FONT_REM } from '../../constants/rightPanel';

/** One rung of the ladder. All lengths are rem, so zoom still scales them. */
export type PillDensity = {
	/** Label size. */
	fontRem: number;
	/** Horizontal padding per side (Tailwind `px-3` / `px-2` / `px-1.5`). */
	padXRem: number;
	/** Whether the entry-type icon is drawn. */
	icon: boolean;
};

/**
 * How the pills give up width, widest first.
 *
 * The order is what the row can afford to lose, not what is easiest to change.
 * The icon goes first because it carries no information the pill does not
 * already spell out in words, and dropping it frees more room than any type
 * step does (the glyph plus its gap is over an em per pill). Padding goes next.
 * The label size moves last, and only two steps, because it is the one thing
 * here that costs legibility rather than air.
 *
 * The line height is fixed at every rung (see `RIGHT_PANEL_PILL_LINE_HEIGHT`),
 * so the pills keep one height and the toolbar does not change shape as the
 * panel is dragged.
 */
export const PILL_DENSITIES: readonly PillDensity[] = [
	{ fontRem: RIGHT_PANEL_PILL_FONT_REM, padXRem: 0.75, icon: true },
	{ fontRem: RIGHT_PANEL_PILL_FONT_REM, padXRem: 0.75, icon: false },
	{ fontRem: RIGHT_PANEL_PILL_FONT_REM, padXRem: 0.5, icon: false },
	{ fontRem: RIGHT_PANEL_PILL_FONT_REM * (8 / 9), padXRem: 0.5, icon: false },
	{ fontRem: RIGHT_PANEL_PILL_FONT_REM * (7 / 9), padXRem: 0.375, icon: false },
];

/**
 * The rung to assume before the row has measured itself, when the caller's
 * static `compact` prediction says the panel is narrow. Text-only at tight
 * padding is the common answer at a narrow width, so starting here means the
 * measurement usually confirms the first paint rather than correcting it.
 */
export const COMPACT_PRIOR_INDEX = 2;

/** Icon box (`w-3`) and the gap between it and the label (`gap-1.5`), in rem. */
const ICON_REM = 0.75;
const ICON_GAP_REM = 0.375;
/** Gap between pills (`gap-2`), in rem. */
const PILL_GAP_REM = 0.5;
/** Both 1px borders on a pill. */
const PILL_BORDER_PX = 2;
/** Slack for sub-pixel rounding in the two measurements. */
const FIT_SLACK_PX = 2;

/**
 * Width the row needs at a given rung, in px.
 *
 * `labelsWidthPx` is the measured width of every label rendered together at the
 * BASE size, so the text term is a straight ratio: label advance scales
 * linearly with font size, and the tracking is in `em` so it scales with it.
 * Everything else on a pill is rem-based and therefore scales with the root
 * font, which is why the chrome is computed from `remPx` rather than from pixel
 * literals - a literal would be right only at a 16px interface font.
 */
export function pillRowWidthPx(
	density: PillDensity,
	labelsWidthPx: number,
	count: number,
	remPx: number
): number {
	const text = labelsWidthPx * (density.fontRem / RIGHT_PANEL_PILL_FONT_REM);
	const perPillRem = density.padXRem * 2 + (density.icon ? ICON_REM + ICON_GAP_REM : 0);
	const chrome = count * (perPillRem * remPx + PILL_BORDER_PX);
	const gaps = Math.max(0, count - 1) * PILL_GAP_REM * remPx;
	return text + chrome + gaps;
}

export type PillDensityInput = {
	/** Width the row has been granted, px. 0 means "not measured yet". */
	availableWidth: number;
	/** Measured width of all labels at the base size, px. 0 means "not measured yet". */
	labelsWidth: number;
	/** How many pills are on screen - three without Cue, four with it. */
	count: number;
	/** Computed root font size, px. */
	remPx: number;
	/** The caller's static narrow-panel prediction, used only before measuring. */
	compact: boolean;
	/** False when the row does not own the leftover width, so measuring is meaningless. */
	enabled: boolean;
};

/**
 * Pick the widest rung that fits.
 *
 * Falls back to the caller's `compact` prediction while either measurement is
 * still 0, and to the last rung when even that overflows - at which point the
 * row's `overflow-hidden` keeps the pills off the buttons rather than the other
 * way round.
 */
export function resolvePillDensity({
	availableWidth,
	labelsWidth,
	count,
	remPx,
	compact,
	enabled,
}: PillDensityInput): PillDensity {
	if (!enabled || availableWidth <= 0 || labelsWidth <= 0) {
		return PILL_DENSITIES[compact ? COMPACT_PRIOR_INDEX : 0];
	}
	const budget = availableWidth - FIT_SLACK_PX;
	const fit = PILL_DENSITIES.find((d) => pillRowWidthPx(d, labelsWidth, count, remPx) <= budget);
	return fit ?? PILL_DENSITIES[PILL_DENSITIES.length - 1];
}
