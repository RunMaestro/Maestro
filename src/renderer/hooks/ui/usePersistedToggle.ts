/**
 * One boolean, remembered across mounts under a localStorage key.
 *
 * For view preferences a user sets by clicking - a banner collapsed, a section
 * folded away - where the state must survive the surface unmounting (a panel
 * tab switch, a re-render triggered by new data) but is not worth a Settings
 * row or a store slice.
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

function load(storageKey: string, fallback: boolean): boolean {
	const raw = storage()?.getItem(storageKey) ?? null;
	if (raw === null) return fallback;
	return raw === 'true';
}

export interface UsePersistedToggleReturn {
	value: boolean;
	setValue: (next: boolean) => void;
	toggle: () => void;
}

/**
 * @param storageKey     localStorage key, e.g. `autoRun.humanStepBanner.collapsed`.
 * @param defaultValue   value used when nothing is stored.
 */
export function usePersistedToggle(
	storageKey: string,
	defaultValue = false
): UsePersistedToggleReturn {
	const [value, setStateValue] = useState<boolean>(() => load(storageKey, defaultValue));

	const setValue = useCallback(
		(next: boolean) => {
			storage()?.setItem(storageKey, String(next));
			setStateValue(next);
		},
		[storageKey]
	);

	const toggle = useCallback(() => {
		setStateValue((prev) => {
			storage()?.setItem(storageKey, String(!prev));
			return !prev;
		});
	}, [storageKey]);

	return { value, setValue, toggle };
}
