/**
 * One panel dimension in pixels, remembered across mounts (and app restarts)
 * under a localStorage key.
 *
 * The numeric counterpart to `usePersistedToggle`, for a size the user sets by
 * dragging a surface that lives INSIDE another surface - a preview pane in a
 * modal, a split inside a panel, a dropdown's height - where the value must
 * survive the surface unmounting but is not worth a Settings row or a store
 * slice. `usePersistedPanelSize` is axis-agnostic; `usePersistedPanelWidth`
 * names it for the width case and pairs with `useResizablePanel` (pass
 * `setWidth` from here and omit its `settingsKey`).
 *
 * The stored value is clamped on read, so bounds that tighten in a later build
 * can't restore a pane larger than its own container. Bounds that depend on the
 * live viewport do NOT belong here: clamp at render instead, so a size picked on
 * a big monitor comes back when the window returns to one.
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

function clampSize(value: number, minSize: number, maxSize: number): number {
	return Math.round(Math.max(minSize, Math.min(maxSize, value)));
}

/** The stored size, or null when nothing usable is stored. */
function readStored(storageKey: string): number | null {
	const raw = storage()?.getItem(storageKey) ?? null;
	if (raw === null) return null;
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface UsePersistedPanelSizeOptions {
	/** Size used when nothing is stored. */
	defaultSize: number;
	/** Smallest size the pane may be restored or set to. */
	minSize: number;
	/** Largest size the pane may be restored or set to. */
	maxSize: number;
}

export interface UsePersistedPanelSizeReturn {
	size: number;
	/** Commit a new size - clamped, stored, and returned on the next render. */
	setSize: (next: number) => void;
	/** Forget the stored size and snap back to the default. */
	reset: () => void;
	/** True when a user-picked size is stored (so a reset would change something). */
	isCustomized: boolean;
}

export function usePersistedPanelSize(
	storageKey: string,
	{ defaultSize, minSize, maxSize }: UsePersistedPanelSizeOptions
): UsePersistedPanelSizeReturn {
	const [stored, setStored] = useState<number | null>(() => readStored(storageKey));

	const setSize = useCallback(
		(next: number) => {
			const clamped = clampSize(next, minSize, maxSize);
			storage()?.setItem(storageKey, String(clamped));
			setStored(clamped);
		},
		[storageKey, minSize, maxSize]
	);

	const reset = useCallback(() => {
		storage()?.removeItem(storageKey);
		setStored(null);
	}, [storageKey]);

	return {
		size: clampSize(stored ?? defaultSize, minSize, maxSize),
		setSize,
		reset,
		isCustomized: stored !== null,
	};
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
	const { size, setSize, reset } = usePersistedPanelSize(storageKey, {
		defaultSize: defaultWidth,
		minSize: minWidth,
		maxSize: maxWidth,
	});
	return { width: size, setWidth: setSize, reset };
}
