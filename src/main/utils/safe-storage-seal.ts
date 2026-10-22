/**
 * Sealing a string with the key the operating system holds for this app.
 *
 * Electron's `safeStorage` encrypts with a key kept in the Keychain on macOS,
 * by DPAPI on Windows, and in a keyring on Linux. A file sealed with it cannot
 * be read by something that only reads files.
 *
 * `SealProvider` is the injectable form, so a store that seals its own file
 * can be unit-tested with a fake. `safeStorageSeal` is the production binding.
 *
 * Two things every caller must plan for:
 * - `safeStorage` works only after the app's `ready` event. Build a provider
 *   whenever you like, but do not call it before then.
 * - Encryption is not always there. A Linux machine with no keyring has none,
 *   and `available()` says so. A caller decides for itself what it does then.
 *   `obscuringSeal` is what a caller can fall back on so that a file is never
 *   written as readable text.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** Seals and unseals a string with a key the OS holds. */
export interface SealProvider {
	available(): boolean;
	seal(plaintext: string): Buffer;
	unseal(blob: Buffer): string;
}

/** The part of Electron's `safeStorage` a seal needs. */
export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(s: string): Buffer;
	decryptString(b: Buffer): string;
}

/**
 * Production `SealProvider` over Electron `safeStorage`.
 *
 * `available()` never throws: a platform where the check itself fails has no
 * usable encryption, which is the same answer as "not available".
 */
export function safeStorageSeal(safeStorage: SafeStorageLike): SealProvider {
	return {
		available: () => {
			try {
				return safeStorage.isEncryptionAvailable();
			} catch {
				return false;
			}
		},
		seal: (plaintext) => safeStorage.encryptString(plaintext),
		unseal: (blob) => safeStorage.decryptString(blob),
	};
}

/**
 * The key of `obscuringSeal`. It is built into the app on purpose: there is
 * nowhere on a machine with no OS key store to keep a better one.
 */
let obscuringKey: Buffer | undefined;
/** Derived on first use, so importing this module runs no crypto (a test may mock `crypto`). */
function obscuringKeyBytes(): Buffer {
	obscuringKey ??= createHash('sha256').update('maestro:obscuring-seal:v1', 'utf8').digest();
	return obscuringKey;
}
const OBSCURING_IV_BYTES = 12;
const OBSCURING_TAG_BYTES = 16;

/**
 * A `SealProvider` for a machine whose OS offers no encryption. It is always
 * available.
 *
 * What it gives: the text is not readable in the file, so a search of the
 * disk does not turn up what it holds, and a file that was edited by hand
 * does not open (AES-256-GCM checks every byte). The same text seals to
 * different bytes each time.
 *
 * What it does not give: secrecy from anything that can read the app. The key
 * is the same on every machine. Use it only where the alternative is readable
 * text, and tell the person that the file is obscured and not encrypted.
 */
export function obscuringSeal(): SealProvider {
	return {
		available: () => true,
		seal: (plaintext) => {
			const iv = randomBytes(OBSCURING_IV_BYTES);
			const cipher = createCipheriv('aes-256-gcm', obscuringKeyBytes(), iv);
			const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), body]);
		},
		unseal: (blob) => {
			const headerBytes = OBSCURING_IV_BYTES + OBSCURING_TAG_BYTES;
			if (blob.length < headerBytes) throw new Error('The sealed text is too short.');
			const decipher = createDecipheriv(
				'aes-256-gcm',
				obscuringKeyBytes(),
				blob.subarray(0, OBSCURING_IV_BYTES)
			);
			decipher.setAuthTag(blob.subarray(OBSCURING_IV_BYTES, headerBytes));
			return Buffer.concat([
				decipher.update(blob.subarray(headerBytes)),
				decipher.final(),
			]).toString('utf8');
		},
	};
}
