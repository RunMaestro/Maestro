/**
 * How a secret Maestro stores for the user is kept on disk.
 *
 *   - `os`       - sealed with the key the operating system holds for the app
 *                  (Keychain on macOS, DPAPI on Windows, a keyring on Linux).
 *   - `obscured` - under a key built into the app, on a machine whose OS offers
 *                  no key store (Linux with no keyring). Not readable text in
 *                  the file, and NOT encryption: every surface that shows a
 *                  stored secret says which of the two it is.
 *
 * The sealing itself is `sealSecret` / `unsealSecret` in
 * `src/main/utils/sealed-state-file.ts`. This is the word both processes and the
 * CLI use for the result.
 */
export type SecretStorage = 'os' | 'obscured';

export function isSecretStorage(value: unknown): value is SecretStorage {
	return value === 'os' || value === 'obscured';
}

/** One sentence for a person: where a stored secret is, and how well it is kept. */
export function describeSecretStorage(storage: SecretStorage): string {
	return storage === 'os'
		? 'Stored sealed by the system key store.'
		: 'This system has no key store, so it is stored obscured, not encrypted.';
}
