/**
 * Shared font-zoom state for reading surfaces (Director's Notes synopsis, file
 * preview panes, ...).
 *
 * The scale is a plain multiplier applied by the caller to whatever base font
 * size its surface uses, so em-based children scale proportionally. It is
 * persisted to localStorage under a per-surface key: the chosen size is a
 * reading preference the user expects to survive a reopen, but it is not a
 * product setting worth a Settings row.
 *
 * This is a preset over `useScalePreference`, which owns the clamping,
 * rounding, and storage handling shared with the staged-image thumbnail zoom.
 */

import { clampScale, useScalePreference, type ScaleRange } from './useScalePreference';

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 2.0;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1.0;

const FONT_SCALE_RANGE: ScaleRange = {
	min: FONT_SCALE_MIN,
	max: FONT_SCALE_MAX,
	step: FONT_SCALE_STEP,
	initial: FONT_SCALE_DEFAULT,
};

/** Clamp to the supported range and round to two decimals. */
export function clampFontScale(value: number): number {
	return clampScale(value, FONT_SCALE_RANGE);
}

export interface UseFontScaleReturn {
	/** Current multiplier (1 = the surface's own base size). */
	fontScale: number;
	/** Step one increment up (`1`) or down (`-1`). */
	adjustFontScale: (direction: -1 | 1) => void;
	/** Back to 100%. */
	resetFontScale: () => void;
	canDecrease: boolean;
	canIncrease: boolean;
}

/**
 * Font-zoom state persisted under `storageKey`.
 *
 * @param storageKey localStorage key, e.g. `directorNotes.fontScale`.
 */
export function useFontScale(storageKey: string): UseFontScaleReturn {
	const { scale, adjustScale, resetScale, canDecrease, canIncrease } = useScalePreference(
		storageKey,
		FONT_SCALE_RANGE
	);

	return {
		fontScale: scale,
		adjustFontScale: adjustScale,
		resetFontScale: resetScale,
		canDecrease,
		canIncrease,
	};
}
