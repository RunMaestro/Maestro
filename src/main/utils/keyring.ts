/**
 * The one adapter over `@napi-rs/keyring`.
 *
 * Two callers need an OS credential entry for completely different reasons - the
 * plugin authorization ledger's freshness anchor and A Cappella's API keys - and
 * both need the same three properties, which is why the loader lives here rather
 * than being written twice:
 *
 *   1. **Lazy.** The native module is `require`d on first use, not at import, so
 *      app startup does not depend on a keyring being present.
 *   2. **Never throws.** A machine with no keyring daemon (headless Linux, a
 *      locked login keychain) gets `null` back and the caller degrades. A missing
 *      credential store is a capability the machine lacks, not a crash.
 *   3. **One module id.** A second `require('@napi-rs/keyring')` elsewhere would
 *      be a second place to keep the packaging config honest.
 */

/** The slice of `@napi-rs/keyring`'s `Entry` this codebase uses. */
export interface KeyringEntry {
	getPassword(): string | null;
	setPassword(password: string): void;
	deletePassword(): boolean;
}

export interface KeyringModule {
	Entry: new (service: string, account: string) => KeyringEntry;
}

/** Loads the native module, or null when it is absent or will not load. */
export type KeyringModuleLoader = () => KeyringModule | null;

/**
 * The production loader. Uses `require` rather than a dynamic import because the
 * main bundle is CommonJS and this must stay synchronous: a caller asking whether
 * a credential exists cannot be made async by the loader's module system.
 */
export const loadKeyringModule: KeyringModuleLoader = () => {
	try {
		const mod = require('@napi-rs/keyring') as Partial<KeyringModule>;
		return typeof mod.Entry === 'function' ? (mod as KeyringModule) : null;
	} catch {
		return null;
	}
};

/**
 * One credential entry, or null when this machine has no usable keyring.
 *
 * `loadModule` is injectable for tests; production always uses
 * {@link loadKeyringModule}.
 */
export function createKeyringEntry(
	service: string,
	account: string,
	loadModule: KeyringModuleLoader = loadKeyringModule
): KeyringEntry | null {
	try {
		const mod = loadModule();
		if (!mod) return null;
		return new mod.Entry(service, account);
	} catch {
		return null;
	}
}
