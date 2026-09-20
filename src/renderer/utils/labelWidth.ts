/**
 * Estimating how wide a list of labels needs its container to be, for surfaces
 * that size themselves to their longest entry (a dropdown, a menu, a ToC).
 *
 * This is deliberately an ESTIMATE from character count rather than a real
 * measurement. Measuring means either a canvas `measureText` with the surface's
 * exact resolved font, or an off-screen render and a `getBoundingClientRect` -
 * both need a live layout, so neither works while computing an initial size,
 * and neither produces anything in jsdom. A per-character average is stable,
 * synchronous, testable, and wrong by a few pixels, which is the right trade
 * for a size the user can drag afterwards.
 */

/**
 * Average character advance of a proportional UI font as a fraction of its font
 * size. Latin text in the system UI stack sits near 0.5em; 0.55 leans wide on
 * purpose, because a label that overflows its container is a visible bug and a
 * container a few pixels too wide is not.
 */
const AVERAGE_CHAR_WIDTH_RATIO = 0.55;

export interface LabelWidthOptions {
	/** Size the labels render at, in px: `text-xs` is 12, `text-sm` is 14. */
	fontSizePx: number;
	/** Everything in the row that is not the label: padding, icons, gaps, borders. */
	chromePx?: number;
	/** Floor, for when every label is short. */
	minPx?: number;
	/** Ceiling, so one pathological label cannot size the surface to the screen. */
	maxPx?: number;
}

function clampWidth(width: number, { minPx, maxPx }: LabelWidthOptions): number {
	let next = width;
	if (maxPx !== undefined) next = Math.min(next, maxPx);
	// Min wins over max, so a caller that passes a floor above its ceiling gets
	// the floor rather than a container too small for its own content.
	if (minPx !== undefined) next = Math.max(next, minPx);
	return Math.ceil(next);
}

/** Width a container needs to show `label` in full, chrome included. */
export function estimateLabelWidth(label: string, options: LabelWidthOptions): number {
	const { fontSizePx, chromePx = 0 } = options;
	const text = label.length * fontSizePx * AVERAGE_CHAR_WIDTH_RATIO;
	return clampWidth(text + chromePx, options);
}

/**
 * Width a container needs to show its widest label in full. Returns the floor
 * (or the chrome alone) for an empty list, so a surface with nothing in it yet
 * still opens at a sane size.
 */
export function widestLabelWidth(labels: Iterable<string>, options: LabelWidthOptions): number {
	let longest = 0;
	for (const label of labels) {
		longest = Math.max(longest, label.length);
	}
	return estimateLabelWidth('x'.repeat(longest), options);
}
