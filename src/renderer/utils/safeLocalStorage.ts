/**
 * `localStorage`, or null where there isn't one.
 *
 * Reading the global itself can THROW (a storage-blocked renderer, Safari
 * private mode, a jsdom test without a Storage implementation), so every
 * persisted-view-preference hook needs the same guarded accessor. It lived
 * three times over as a private `storage()` before it was pulled here.
 *
 * The contract every caller relies on: a missing or hostile Storage costs the
 * user their persistence, never their pane.
 *
 * Keep this exported for callers that need the raw Storage (`removeItem`,
 * `key`, enumeration). For ordinary preference get/set, use
 * {@link safeStorageGet} / {@link safeStorageSet}: those swallow method-level
 * failures (`QuotaExceededError`, Safari private-mode writes) that this
 * accessor does not. Optional-chaining `getItem`/`setItem` on the result is
 * not enough - a throw from a store initializer or a persist `useEffect`
 * reaches the nearest error boundary and takes the pane down.
 */
export function safeLocalStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * Read one key, swallowing a Storage that refuses the read.
 *
 * {@link safeLocalStorage} only covers reaching the object. `getItem` itself
 * can still throw on a hostile or storage-blocked origin, and a throw from a
 * store initializer or a `useState` lazy init takes the pane down. Returns
 * null when there is no Storage or the read fails, matching a missing key.
 */
export function safeStorageGet(key: string): string | null {
	try {
		return safeLocalStorage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

/**
 * Write one value, swallowing a Storage that refuses it.
 *
 * The realistic throw is `QuotaExceededError` on a full origin, plus Safari
 * private mode historically throwing on every write. A write inside a
 * `useEffect` that escapes reaches the nearest error boundary and unmounts
 * the pane - the exact failure the helper's contract exists to prevent.
 */
export function safeStorageSet(key: string, value: string): void {
	try {
		safeLocalStorage()?.setItem(key, value);
	} catch {
		/* quota exceeded or storage blocked - the value simply isn't remembered */
	}
}
