/**
 * One value out of a fixed set of string options, remembered across mounts
 * under a localStorage key.
 *
 * The enum counterpart to `usePersistedToggle`: same job (a view preference the
 * user sets by clicking - a sort mode, a view density - that must survive the
 * surface unmounting but is not worth a Settings row or a store slice), for the
 * cases where the answer is one of three words rather than yes/no.
 *
 * The stored string is validated against the option list on read, so a value
 * left behind by an older build (or hand-edited in devtools) falls back to the
 * default instead of putting the surface into a mode it no longer has a control
 * for.
 */

import { useCallback, useState } from 'react';
import { safeLocalStorage } from '../../utils/safeLocalStorage';

function load<T extends string>(storageKey: string, options: readonly T[], fallback: T): T {
	const raw = safeLocalStorage()?.getItem(storageKey) ?? null;
	if (raw === null) return fallback;
	return (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export interface UsePersistedChoiceReturn<T extends string> {
	value: T;
	setValue: (next: T) => void;
}

/**
 * @param storageKey    localStorage key, e.g. `extensions.sort`.
 * @param options       every accepted value; anything else on disk is ignored.
 * @param defaultValue  value used when nothing valid is stored.
 */
export function usePersistedChoice<T extends string>(
	storageKey: string,
	options: readonly T[],
	defaultValue: T
): UsePersistedChoiceReturn<T> {
	const [value, setStateValue] = useState<T>(() => load(storageKey, options, defaultValue));

	const setValue = useCallback(
		(next: T) => {
			safeLocalStorage()?.setItem(storageKey, next);
			setStateValue(next);
		},
		[storageKey]
	);

	return { value, setValue };
}
