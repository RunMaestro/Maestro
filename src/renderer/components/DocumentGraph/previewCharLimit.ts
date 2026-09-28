/**
 * The Document Graph's preview-length control: how much body text a document
 * node draws under its title.
 *
 * `0` means "Off", and it is not merely "a very short preview" - a node at 0
 * loses its body box entirely and renders as a filename pill. That makes it
 * the densest view rather than the emptiest one, which is why it sits at the
 * bottom of the `P` cycle rather than being clamped away as an invalid length.
 *
 * The slider offers every 50-character step; the `P` key walks a shorter ladder
 * of useful stops so one hand on the keyboard can go from pills to full text in
 * a few presses. Both write the same value, so they cannot disagree.
 */

/** Sentinel limit meaning "draw filename pills, no body text". */
export const PREVIEW_CHAR_LIMIT_OFF = 0;

/** Smallest value the slider offers (the Off sentinel). */
export const PREVIEW_CHAR_LIMIT_MIN = PREVIEW_CHAR_LIMIT_OFF;

/** Largest preview length the slider offers. */
export const PREVIEW_CHAR_LIMIT_MAX = 500;

/** Slider granularity. */
export const PREVIEW_CHAR_LIMIT_STEP = 50;

/**
 * The stops the `P` key walks, ascending. These are the slider's own tick
 * labels plus the Off sentinel - a key that stepped all eleven slider values
 * would take too many presses to be worth reaching for.
 */
export const PREVIEW_CHAR_LIMIT_CYCLE = [PREVIEW_CHAR_LIMIT_OFF, 50, 100, 200, 350, 500] as const;

/**
 * The next limit on the `P` cycle: longer previews each press, wrapping from
 * the longest back to Off. A value the slider produced between two stops (150,
 * say) advances to the next stop above it rather than snapping backwards.
 */
export function nextPreviewCharLimit(current: number): number {
	if (!Number.isFinite(current)) return PREVIEW_CHAR_LIMIT_CYCLE[0];
	// Clamp before stepping. A negative value already renders as Off, so finding
	// "the first stop above -40" would land back on Off and read as a dead key.
	const from = clampPreviewCharLimit(current);
	const next = PREVIEW_CHAR_LIMIT_CYCLE.find((stop) => stop > from);
	return next ?? PREVIEW_CHAR_LIMIT_CYCLE[0];
}

/** Clamp an arbitrary number onto the slider's range. */
export function clampPreviewCharLimit(value: number): number {
	if (!Number.isFinite(value)) return PREVIEW_CHAR_LIMIT_CYCLE[0];
	return Math.max(PREVIEW_CHAR_LIMIT_MIN, Math.min(PREVIEW_CHAR_LIMIT_MAX, Math.floor(value)));
}

/** True when nodes should render as filename pills with no body. */
export function isPreviewOff(limit: number): boolean {
	return !Number.isFinite(limit) || limit <= PREVIEW_CHAR_LIMIT_OFF;
}

/** How the limit reads in a button, a slider readout, or a tooltip. */
export function formatPreviewCharLimit(limit: number): string {
	return isPreviewOff(limit) ? 'Off' : String(limit);
}
