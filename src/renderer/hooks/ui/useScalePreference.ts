/**
 * Persisted zoom state for a surface: one clamped multiplier, stepped up and
 * down, remembered under a localStorage key.
 *
 * This is the engine behind `useFontScale` (reading panes) and the staged-image
 * organizer's thumbnail zoom. Both want the same three behaviors and had the
 * same two traps, so they share one implementation:
 *
 *   - Rounding is not cosmetic. Repeated `+= 0.1` on a float lands on values
 *     like `1.0000000000000002`, which then gets persisted and rendered inside
 *     a `calc()`.
 *   - A missing or hostile Storage (private mode, storage-blocked renderer,
 *     jsdom under test) must cost the user their persistence, not their pane.
 *
 * The multiplier is applied by the caller to whatever base size its surface
 * uses, so `1` always means "the surface's own size".
 */

import { useCallback, useMemo, useState } from 'react';
import { safeLocalStorage } from '../../utils/safeLocalStorage';

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

function loadScale(storageKey: string, range: ScaleRange): number {
	const raw = safeLocalStorage()?.getItem(storageKey) ?? null;
	if (raw === null) return range.initial;
	return clampScale(Number(raw), range);
}

export interface UseScalePreferenceReturn {
	/** Current multiplier (1 = the surface's own base size). */
	scale: number;
	/** Step one increment up (`1`) or down (`-1`). */
	adjustScale: (direction: -1 | 1) => void;
	/** Back to the range's initial value. */
	resetScale: () => void;
	canDecrease: boolean;
	canIncrease: boolean;
}

/**
 * @param storageKey localStorage key, e.g. `stagedImages.thumbnailScale`.
 * @param range      bounds and step for this surface.
 */
export function useScalePreference(
	storageKey: string,
	range: ScaleRange
): UseScalePreferenceReturn {
	const [scale, setScale] = useState<number>(() => loadScale(storageKey, range));

	// Callers pass the range as an object literal, so depend on its VALUES
	// rather than its identity - otherwise every render rebuilds the callbacks.
	const { min, max, step, initial } = range;
	const bounds = useMemo<ScaleRange>(
		() => ({ min, max, step, initial }),
		[min, max, step, initial]
	);

	const persist = useCallback(
		(next: number) => {
			safeLocalStorage()?.setItem(storageKey, String(next));
			return next;
		},
		[storageKey]
	);

	const adjustScale = useCallback(
		(direction: -1 | 1) => {
			setScale((prev) => persist(clampScale(prev + direction * bounds.step, bounds)));
		},
		[persist, bounds]
	);

	const resetScale = useCallback(() => {
		setScale(() => persist(bounds.initial));
	}, [persist, bounds]);

	return {
		scale,
		adjustScale,
		resetScale,
		canDecrease: scale > bounds.min,
		canIncrease: scale < bounds.max,
	};
}
