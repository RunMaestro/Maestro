import { useCallback, useState } from 'react';

/**
 * Shared font-zoom state for reading surfaces (Director's Notes synopsis, file
 * preview panes, ...).
 *
 * The scale is a plain multiplier applied by the caller to whatever base font
 * size its surface uses, so em-based children scale proportionally. It is
 * persisted to localStorage under a per-surface key: the chosen size is a
 * reading preference the user expects to survive a reopen, but it is not a
 * product setting worth a Settings row.
 */

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 2.0;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1.0;

/**
 * Clamp to the supported range and round to two decimals. Rounding matters:
 * repeated `+= 0.1` on a float lands on values like `1.0000000000000002`,
 * which would then be persisted and rendered inside a `calc()`.
 */
export function clampFontScale(value: number): number {
	if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT;
	const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
	return Math.round(clamped * 100) / 100;
}

/**
 * `localStorage`, or null where there isn't one.
 *
 * Font zoom is a comfort preference on a reading pane, so a Storage that is
 * missing or refuses access (private mode, a renderer with storage blocked,
 * jsdom under test) must cost the user their persistence, not their pane. The
 * hook runs during render of surfaces as large as the whole file preview.
 */
function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function loadFontScale(storageKey: string): number {
	const raw = storage()?.getItem(storageKey) ?? null;
	if (raw === null) return FONT_SCALE_DEFAULT;
	return clampFontScale(Number(raw));
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
	const [fontScale, setFontScale] = useState<number>(() => loadFontScale(storageKey));

	const persist = useCallback(
		(next: number) => {
			storage()?.setItem(storageKey, String(next));
			return next;
		},
		[storageKey]
	);

	const adjustFontScale = useCallback(
		(direction: -1 | 1) => {
			setFontScale((prev) => persist(clampFontScale(prev + direction * FONT_SCALE_STEP)));
		},
		[persist]
	);

	const resetFontScale = useCallback(() => {
		setFontScale(() => persist(FONT_SCALE_DEFAULT));
	}, [persist]);

	return {
		fontScale,
		adjustFontScale,
		resetFontScale,
		canDecrease: fontScale > FONT_SCALE_MIN,
		canIncrease: fontScale < FONT_SCALE_MAX,
	};
}
