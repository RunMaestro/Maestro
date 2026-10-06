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
 * `key`, enumeration). For ordinary localStorage preference get/set, use
 * {@link safeStorageGet} / {@link safeStorageSet}. For a write to any Storage
 * (local or session), use {@link writeStorageValue}. Optional-chaining
 * `getItem`/`setItem` on the accessor result is not enough - a throw from a
 * store initializer or a persist `useEffect` reaches the nearest error
 * boundary and takes the pane down.
 */
export function safeLocalStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * `sessionStorage`, or null where there isn't one.
 *
 * Same guarded accessor as {@link safeLocalStorage}, for the state that belongs
 * to ONE browser tab rather than to the browser: two web-desktop tabs share an
 * origin, so anything written to localStorage by one is read back by the other.
 * It survives a reload (which is what a refocused mobile browser does) and dies
 * with the tab, which is exactly the lifetime of "what is this tab looking at?".
 */
export function safeSessionStorage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

/**
 * Write one value, swallowing a Storage that refuses it.
 *
 * The guarded ACCESSORS above only cover reaching the object; `setItem` itself
 * still throws when the quota is full or the origin is storage-blocked (Safari
 * private mode throws on every write). Since the contract is that persistence
 * failures cost the user their persistence and never their pane, a write is not
 * safe just because it went through a safe accessor.
 */
export function writeStorageValue(storage: Storage | null, key: string, value: string): void {
	if (!storage) return;
	try {
		storage.setItem(key, value);
	} catch {
		/* quota exceeded or storage blocked - the value simply isn't remembered */
	}
}

/**
 * Read one localStorage key, swallowing a Storage that refuses the read.
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
 * Write one localStorage value, swallowing a Storage that refuses it.
 *
 * The realistic throw is `QuotaExceededError` on a full origin, plus Safari
 * private mode historically throwing on every write. A write inside a
 * `useEffect` that escapes reaches the nearest error boundary and unmounts
 * the pane - the exact failure the helper's contract exists to prevent.
 * Implemented over {@link writeStorageValue} so local and session writes
 * share one swallow path.
 */
export function safeStorageSet(key: string, value: string): void {
	writeStorageValue(safeLocalStorage(), key, value);
}
