/**
 * A small per-device state file that holds a secret: the two pieces every such
 * store needs, so none of them grows a private copy.
 *
 *   createPrivateStateFile()   one JSON file in Maestro's data folder, readable
 *                              by its owner only, changed one read-modify-write
 *                              at a time through an atomic rename. A file that
 *                              is not JSON is moved aside, never written over.
 *   sealSecret / unsealSecret  one secret inside it, never as readable text:
 *                              sealed by the OS where it has a key store, and
 *                              obscured where it has none. The stored record
 *                              says which, so a surface can tell the person.
 *
 * The model server's port and key (`local-models/server/config-store.ts`) and
 * System One's engine settings and keys (`local-models/system-one/
 * config-store.ts`) are both built on these.
 *
 * What a caller still decides: what the file holds (`normalize`), and what a
 * secret that will not open means for its feature. `unsealSecret` throws a
 * `SealedSecretError` that says which way it failed and never falls back to
 * anything. Do not write over a secret that could not be opened unless the
 * person asked for a new one: another start (a keyring that is locked today, a
 * build signed with another key) may still be able to read it.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { assertSerializedJsonIsSafe, parseJsonWithBom } from '../../shared/jsonUtils';
import { isSecretStorage, type SecretStorage } from '../../shared/secretStorage';
import { corruptStorePath } from '../stores/corrupt-store-recovery';
import { atomicWriteFile, createKeyedWriteQueue } from './atomic-json-store';
import { logger } from './logger';
import { obscuringSeal, type SealProvider } from './safe-storage-seal';

// ---------------------------------------------------------------------------
// A secret
// ---------------------------------------------------------------------------

/** A secret as it is written to disk. */
export interface StoredSecret {
	/** Base64 of the sealed bytes. */
	sealed: string;
	storage: SecretStorage;
}

export function isStoredSecret(value: unknown): value is StoredSecret {
	const record = value as Partial<StoredSecret> | null;
	return (
		typeof record?.sealed === 'string' &&
		record.sealed.length > 0 &&
		isSecretStorage(record.storage)
	);
}

/**
 * Why a secret could not be sealed or opened.
 *
 *   - `seal-failed`       - the seal threw while sealing a new secret.
 *   - `store-unavailable` - the secret was sealed by the OS key store, and the
 *                           OS offers none now.
 *   - `unreadable`        - the seal is there and the bytes do not open under it
 *                           (the key store was reset, the file came from another
 *                           machine or another build, or it was edited).
 */
export type SealedSecretErrorKind = 'seal-failed' | 'store-unavailable' | 'unreadable';

export class SealedSecretError extends Error {
	readonly kind: SealedSecretErrorKind;

	constructor(kind: SealedSecretErrorKind, message: string, cause?: unknown) {
		super(message);
		this.name = 'SealedSecretError';
		this.kind = kind;
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

export function isSealedSecretError(error: unknown): error is SealedSecretError {
	return error instanceof SealedSecretError;
}

/** The seal a record was made with: the OS's, or the obscuring one. */
function sealFor(storage: SecretStorage, osSeal: SealProvider): SealProvider {
	return storage === 'os' ? osSeal : obscuringSeal();
}

/**
 * Seal a secret for the file: with the OS key store when it has one, else
 * obscured, which is still never readable text. The record's `storage` says
 * which was used. Throws `seal-failed`.
 */
export function sealSecret(secret: string, osSeal: SealProvider): StoredSecret {
	const storage: SecretStorage = osSeal.available() ? 'os' : 'obscured';
	try {
		return { sealed: sealFor(storage, osSeal).seal(secret).toString('base64'), storage };
	} catch (error) {
		throw new SealedSecretError(
			'seal-failed',
			error instanceof Error ? error.message : String(error),
			error
		);
	}
}

/** Open a stored secret. Throws `store-unavailable` or `unreadable`; never guesses. */
export function unsealSecret(stored: StoredSecret, osSeal: SealProvider): string {
	const seal = sealFor(stored.storage, osSeal);
	if (stored.storage === 'os' && !seal.available()) {
		throw new SealedSecretError(
			'store-unavailable',
			"The secret is sealed with this system's key store, which is not available now."
		);
	}
	try {
		return seal.unseal(Buffer.from(stored.sealed, 'base64'));
	} catch (error) {
		throw new SealedSecretError('unreadable', 'The secret could not be unsealed.', error);
	}
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export interface PrivateStateFileOptions<T> {
	/** The file, relative to the data folder. Must end in `.json`. */
	fileName: string;
	/**
	 * Turn whatever the file held into a usable state: keep the fields that are
	 * usable and drop the rest. Called with `{}` when there is no file.
	 */
	normalize: (parsed: unknown) => T;
	logContext: string;
	/** What starting from an empty file costs, for the warning logged when one was moved aside. */
	whenCorrupt: string;
}

export interface PrivateStateFile<T> {
	path(dataDir: string): string;
	/** The state now. Waits for a change in flight, so it never reads a half-made one. */
	read(dataDir: string): Promise<T>;
	/**
	 * One read-modify-write, run after every earlier one has finished. `save`
	 * writes the next state; a change that never calls it leaves the file alone.
	 */
	update<R>(
		dataDir: string,
		change: (state: T, save: (next: T) => Promise<void>) => Promise<R>
	): Promise<R>;
}

export function createPrivateStateFile<T>(
	options: PrivateStateFileOptions<T>
): PrivateStateFile<T> {
	const writes = createKeyedWriteQueue();
	const filePath = (dataDir: string): string => path.join(dataDir, options.fileName);

	async function load(dataDir: string): Promise<T> {
		const file = filePath(dataDir);
		let text: string;
		try {
			text = await fs.readFile(file, 'utf-8');
		} catch (error) {
			// No file is the state of a feature that was never set up.
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return options.normalize({});
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = parseJsonWithBom(text);
		} catch {
			const sidecar = corruptStorePath(file);
			await fs.rename(file, sidecar);
			logger.warn(
				`${options.fileName} was not JSON. It was moved to ${path.basename(sidecar)}, and ${options.whenCorrupt}.`,
				options.logContext
			);
			return options.normalize({});
		}
		return options.normalize(parsed);
	}

	async function store(dataDir: string, state: T): Promise<void> {
		const file = filePath(dataDir);
		const serialized = JSON.stringify(state, null, 2);
		assertSerializedJsonIsSafe(serialized, file);
		await fs.mkdir(dataDir, { recursive: true });
		// A temp file left by a crash would keep its old mode through the write.
		await fs.rm(`${file}.tmp`, { force: true });
		await atomicWriteFile(file, serialized, { mode: 0o600 });
	}

	return {
		path: filePath,
		read: (dataDir) => writes.enqueue(filePath(dataDir), () => load(dataDir)),
		update: (dataDir, change) =>
			writes.enqueue(filePath(dataDir), async () =>
				change(await load(dataDir), (next) => store(dataDir, next))
			),
	};
}
