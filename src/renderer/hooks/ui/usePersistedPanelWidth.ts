/**
 * One panel width in pixels, remembered across mounts under a localStorage key.
 *
 * The numeric counterpart to `usePersistedToggle`, for a width the user sets by
 * dragging a surface that lives INSIDE another surface - a preview pane in a
 * modal, a split inside a panel - where the value must survive the surface
 * unmounting but is not worth a Settings row or a store slice. Pairs with
 * `useResizablePanel`: pass `setWidth` from here and omit its `settingsKey`.
 *
 * The stored value is clamped on read, so bounds that tighten in a later build
 * can't restore a pane wider than its own container.
 *
 * A missing or hostile Storage (private mode, storage-blocked renderer, jsdom
 * under test) costs the user their persistence, not their pane.
 */

import { useCallback, useState } from 'react';

/** `localStorage`, or null where there isn't one. */
function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function clampWidth(value: number, minWidth: number, maxWidth: number): number {
	return Math.round(Math.max(minWidth, Math.min(maxWidth, value)));
}

function load(
	storageKey: string,
	defaultWidth: number,
	minWidth: number,
	maxWidth: number
): number {
	const raw = storage()?.getItem(storageKey) ?? null;
	if (raw === null) return clampWidth(defaultWidth, minWidth, maxWidth);
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return clampWidth(defaultWidth, minWidth, maxWidth);
	return clampWidth(parsed, minWidth, maxWidth);
}

export interface UsePersistedPanelWidthOptions {
	/** Width used when nothing is stored. */
	defaultWidth: number;
	/** Smallest width the pane may be restored or set to. */
	minWidth: number;
	/** Largest width the pane may be restored or set to. */
	maxWidth: number;
}

export interface UsePersistedPanelWidthReturn {
	width: number;
	/** Commit a new width - clamped, stored, and returned on the next render. */
	setWidth: (next: number) => void;
	/** Forget the stored width and snap back to the default. */
	reset: () => void;
}

export function usePersistedPanelWidth(
	storageKey: string,
	{ defaultWidth, minWidth, maxWidth }: UsePersistedPanelWidthOptions
): UsePersistedPanelWidthReturn {
	const [width, setStateWidth] = useState<number>(() =>
		load(storageKey, defaultWidth, minWidth, maxWidth)
	);

	const setWidth = useCallback(
		(next: number) => {
			const clamped = clampWidth(next, minWidth, maxWidth);
			storage()?.setItem(storageKey, String(clamped));
			setStateWidth(clamped);
		},
		[storageKey, minWidth, maxWidth]
	);

	const reset = useCallback(() => {
		storage()?.removeItem(storageKey);
		setStateWidth(clampWidth(defaultWidth, minWidth, maxWidth));
	}, [storageKey, defaultWidth, minWidth, maxWidth]);

	return { width, setWidth, reset };
}
