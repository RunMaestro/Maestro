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
 * Every window of the app shares the storage, so a change made in one window
 * (a tab window's file preview, say) shows in the others as it happens.
 *
 * The multiplier is applied by the caller to whatever base size its surface
 * uses, so `1` always means "the surface's own size".
 */

import { useCallback, useMemo, useState } from 'react';
import { clampScale, stepScale, type ScaleRange } from '../../../shared/scaleRange';
import { safeStorageGet, safeStorageSet } from '../../utils/safeLocalStorage';
import { useEventListener } from '../utils/useEventListener';

// The arithmetic is shared with the main process (see shared/scaleRange.ts).
export { clampScale, type ScaleRange };

function loadScale(storageKey: string, range: ScaleRange): number {
	const raw = safeStorageGet(storageKey);
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
			safeStorageSet(storageKey, String(next));
			return next;
		},
		[storageKey]
	);

	const adjustScale = useCallback(
		(direction: -1 | 1) => {
			setScale((prev) => persist(stepScale(prev, direction, bounds)));
		},
		[persist, bounds]
	);

	const resetScale = useCallback(() => {
		setScale(() => persist(bounds.initial));
	}, [persist, bounds]);

	// Another window changed it (the `storage` event never fires in the writer).
	useEventListener('storage', (event) => {
		const { key, newValue } = event as StorageEvent;
		if (key !== storageKey) return;
		setScale(newValue === null ? bounds.initial : clampScale(Number(newValue), bounds));
	});

	return {
		scale,
		adjustScale,
		resetScale,
		canDecrease: scale > bounds.min,
		canIncrease: scale < bounds.max,
	};
}
