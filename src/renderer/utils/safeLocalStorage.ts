/**
 * `localStorage`, or null where there isn't one.
 *
 * Reading the global itself can THROW (a storage-blocked renderer, Safari
 * private mode, a jsdom test without a Storage implementation), so every
 * persisted-view-preference hook needs the same guarded accessor. It lived
 * three times over as a private `storage()` before it was pulled here.
 *
 * The contract every caller relies on: a missing or hostile Storage costs the
 * user their persistence, never their pane. Callers optional-chain through the
 * result rather than branching on it.
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
