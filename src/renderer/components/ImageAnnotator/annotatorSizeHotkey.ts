/**
 * annotatorSizeHotkey - `+` / `-` size nudging for the image annotator.
 *
 * The decision half is pure so it can be tested without mounting the modal:
 * which direction a key means, and what the next size is once clamped. The
 * routing half (selected text vs selected shape vs the stored default) stays in
 * `ImageAnnotator`, where the annotator state lives.
 */

/** Grow keys. `=` is the unshifted face of `+` on a US layout. */
const SIZE_UP_KEYS = new Set(['+', '=']);
/** Shrink keys. `_` is the shifted face of `-`. */
const SIZE_DOWN_KEYS = new Set(['-', '_']);

/**
 * `1` to grow, `-1` to shrink, `null` when the key isn't a size hotkey.
 */
export function sizeHotkeyDirection(key: string): 1 | -1 | null {
	if (SIZE_UP_KEYS.has(key)) return 1;
	if (SIZE_DOWN_KEYS.has(key)) return -1;
	return null;
}

/**
 * Applies one step in `direction` to `current` and clamps to [`min`, `max`] -
 * the same bounds the drawer's slider enforces, so a hotkey can never push a
 * value the slider would refuse.
 */
export function nudgeSize(
	current: number,
	direction: 1 | -1,
	step: number,
	min: number,
	max: number
): number {
	return Math.max(min, Math.min(max, current + direction * step));
}
