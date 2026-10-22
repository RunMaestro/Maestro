/**
 * The arithmetic behind every zoom control: one clamped, rounded multiplier.
 *
 * It lives in `shared` because not every scale is renderer state. Most are
 * (`useScalePreference` keeps them in localStorage), but Quick Chat's text
 * zoom is owned by the main process so `maestro-cli quick-chat font` can set
 * and read it. Both sides have to agree on the range and the rounding, so they
 * read one copy.
 *
 * Rounding is not cosmetic: repeated `+= 0.1` on a float lands on values like
 * `1.0000000000000002`, which then gets persisted and rendered.
 */

export interface ScaleRange {
	min: number;
	max: number;
	step: number;
	/** Value used when nothing is stored, and the target of a reset. */
	initial: number;
}

/** Clamp into `range` and round to two decimals. */
export function clampScale(value: number, range: ScaleRange): number {
	if (!Number.isFinite(value)) return range.initial;
	const clamped = Math.min(range.max, Math.max(range.min, value));
	return Math.round(clamped * 100) / 100;
}

/** One step up (`1`) or down (`-1`) from `value`, clamped. */
export function stepScale(value: number, direction: -1 | 1, range: ScaleRange): number {
	return clampScale(value + direction * range.step, range);
}

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 2.0;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1.0;

/** The range every text zoom uses: 70% to 200% in 10% steps. */
export const FONT_SCALE_RANGE: Readonly<ScaleRange> = {
	min: FONT_SCALE_MIN,
	max: FONT_SCALE_MAX,
	step: FONT_SCALE_STEP,
	initial: FONT_SCALE_DEFAULT,
};

/** Clamp a text zoom to the supported range and round to two decimals. */
export function clampFontScale(value: number): number {
	return clampScale(value, FONT_SCALE_RANGE);
}
