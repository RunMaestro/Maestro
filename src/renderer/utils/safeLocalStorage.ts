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
