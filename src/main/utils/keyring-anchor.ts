/**
 * A freshness anchor kept in the operating system's credential store.
 *
 * A sealed file can prove that its contents were not edited. It cannot prove
 * that it is the NEWEST file: an older sealed copy put back in its place opens
 * just as well, and a file that was deleted says nothing at all. An anchor is
 * a few bytes kept outside the data folder, in the OS credential store
 * (Keychain on macOS, Credential Manager on Windows, a keyring on Linux), that
 * a store compares its file against:
 *
 * - `installSecret` binds the file to this anchor, so a file from somewhere
 *   else is not taken for this one.
 * - `epoch` counts the changes that matter. A file whose epoch is behind the
 *   anchor's is an older copy.
 *
 * `AnchorStore` is the injectable form, so a store can be unit-tested with a
 * fake. `createKeyringAnchor` is the production binding over
 * `@napi-rs/keyring`, loaded lazily so a machine without the native module, or
 * without a credential store, gets `available() === false` and not a throw.
 *
 * Three things every caller must plan for:
 * - Reading and writing are synchronous calls into the OS. Keep them off any
 *   hot path, and off app startup where that is possible.
 * - `write` can throw (a locked credential store). `read` and `clear` do not.
 * - The anchor is friction, not a wall: a process that runs as the same OS
 *   user can delete the entry. Say so wherever a guarantee is stated.
 */

/** What an anchor holds. */
export interface Anchor {
	installSecret: string;
	epoch: number;
}

/** Named credential-store slot for the anchor, OUTSIDE the data-dir file tree. */
export interface AnchorStore {
	available(): boolean;
	read(): Anchor | null;
	write(anchor: Anchor): void;
	clear(): void;
}

/**
 * Production `AnchorStore` over a named OS credential entry. `entryFactory`
 * lazily constructs the keyring entry so a missing/unavailable native module
 * degrades to `available() === false` (→ session-only) instead of throwing.
 */
export interface KeyringEntry {
	getPassword(): string | null;
	setPassword(password: string): void;
	deletePassword(): boolean;
}

export function keyringAnchor(entryFactory: () => KeyringEntry | null): AnchorStore {
	let entry: KeyringEntry | null | undefined;
	const get = (): KeyringEntry | null => {
		if (entry === undefined) {
			try {
				entry = entryFactory();
			} catch {
				entry = null;
			}
		}
		return entry;
	};
	return {
		available: () => get() !== null,
		read: () => {
			const e = get();
			if (!e) return null;
			try {
				const raw = e.getPassword();
				if (!raw) return null;
				const parsed: unknown = JSON.parse(raw);
				if (
					typeof parsed !== 'object' ||
					parsed === null ||
					!('installSecret' in parsed) ||
					!('epoch' in parsed) ||
					typeof parsed.installSecret !== 'string' ||
					typeof parsed.epoch !== 'number'
				) {
					return null;
				}
				return { installSecret: parsed.installSecret, epoch: parsed.epoch };
			} catch {
				return null;
			}
		},
		write: (anchor) => {
			const e = get();
			if (!e) return;
			e.setPassword(JSON.stringify(anchor));
		},
		clear: () => {
			const e = get();
			if (!e) return;
			try {
				e.deletePassword();
			} catch {
				/* best-effort */
			}
		},
	};
}

/** A no-op anchor - `available() === false`, so the store runs session-only. */
export function noAnchor(): AnchorStore {
	return {
		available: () => false,
		read: () => null,
		write: () => {},
		clear: () => {},
	};
}

export interface KeyringModule {
	Entry: new (service: string, account: string) => KeyringEntry;
}

/** Lazily adapt `@napi-rs/keyring` without making app startup depend on it. */
export function createKeyringAnchor(
	service: string,
	account: string,
	loadModule: () => KeyringModule | null = () => {
		try {
			const mod = require('@napi-rs/keyring') as Partial<KeyringModule>;
			return typeof mod.Entry === 'function' ? (mod as KeyringModule) : null;
		} catch {
			return null;
		}
	}
): AnchorStore {
	return keyringAnchor(() => {
		const mod = loadModule();
		if (!mod) return null;
		return new mod.Entry(service, account);
	});
}
