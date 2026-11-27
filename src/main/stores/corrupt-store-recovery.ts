/**
 * Recovery for an unreadable store file.
 *
 * Every `electron-store` instance is constructed with a `deserialize` hook, and
 * `conf` calls it from the `store` getter - which runs inside the Store
 * constructor and again on every single `get`/`set`. A `SyntaxError` there is
 * rethrown (conf only swallows it when `clearInvalidConfig` is set, which we do
 * not use because it silently discards the document), so one torn file bricks
 * the app permanently: `initializeStores()` throws before a window is ever
 * created, the user sees a crash, relaunching re-reads the same bytes, and
 * nothing on the restart path ever repairs the file.
 *
 * That is not hypothetical. A field crash showed an 8 MB `maestro-sessions.json`
 * truncated mid-write ("Unterminated string in JSON at position 7949418")
 * reporting the same unhandled `SyntaxError` hundreds of times in a few hours.
 *
 * Sessions are now written atomically (temp file + rename, see
 * `stores/deferred-writes.ts`), which removes our own hand as a cause. It does
 * not remove the others: `syncPath` is user-configurable and routinely points at
 * a cloud-sync folder (Dropbox, iCloud, OneDrive) that merges, truncates and
 * half-materializes files on its own schedule, and disk-level corruption and
 * ENOSPC are always available.
 *
 * So the read side has to survive it. A corrupt file is moved aside to a
 * `.corrupt-<stamp>.json` sidecar and the store falls back to its defaults: the
 * app starts, and the user's data is still on disk under a name that says what
 * happened. Deleting the file instead - or letting the next write overwrite it -
 * would turn a recoverable incident into permanent loss of every agent, tab and
 * transcript in that file.
 */

import fs from 'fs';
import path from 'path';

import { corruptStorePath, parseStoreJson } from '../../shared/maestro-lib/store/corrupt-store';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'Stores';

// The classification (`parseStoreJson`) and sidecar naming (`corruptStorePath`)
// live in the library so a read-only client reports exactly the files this
// module would quarantine. Re-exported for existing importers.
export { corruptStorePath };

/**
 * Move an unparseable store file aside so the next read starts clean.
 *
 * Rename first: it is atomic, costs nothing on a multi-megabyte file, and
 * preserves the bytes exactly. If it fails (a cloud-sync folder holding a lock,
 * a read-only volume), fall back to writing the contents we already have in
 * memory. Only if BOTH fail is the document actually at risk, and that is
 * logged as an error rather than swallowed.
 *
 * Exported for a plain JSON file that is not an `electron-store` (the prompt
 * manager's `core-prompts-customizations.json`) and so has no `deserialize` hook.
 *
 * @returns the sidecar path when the document was preserved, otherwise null
 */
/** Append a numeric suffix (`-2`, `-3`, ...) before the extension when `basePath` already exists. */
function sidecarCandidate(basePath: string, attempt: number): string {
	if (attempt === 1) return basePath;
	const ext = path.extname(basePath);
	return `${basePath.slice(0, basePath.length - ext.length)}-${attempt}${ext}`;
}

export function quarantineCorruptStore(storePath: string, contents: string): string | null {
	const baseSidecarPath = corruptStorePath(storePath);
	const MAX_ATTEMPTS = 100;

	// Prefer moving the original file without clobbering an existing sidecar
	// created in the same second: `linkSync` fails with EEXIST if the destination
	// already exists, so two corruptions in one second each keep their own copy.
	let renameErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const candidate = sidecarCandidate(baseSidecarPath, attempt);
		try {
			fs.linkSync(storePath, candidate);
			try {
				fs.unlinkSync(storePath);
				return candidate;
			} catch (unlinkErr) {
				// A hard link shares the same inode as `storePath`; if removing the
				// original fails, a later write to `storePath` would overwrite the
				// sidecar too. Remove the link and fall through to an independent copy.
				try {
					fs.unlinkSync(candidate);
				} catch {
					// Best-effort cleanup of the unused hard link.
				}
				renameErr = unlinkErr;
				break;
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'EEXIST') continue;
			// Volumes that disallow hard links (FAT/exFAT/network mounts) fall back
			// to rename only when the destination does not already exist.
			if (!fs.existsSync(candidate)) {
				try {
					fs.renameSync(storePath, candidate);
					return candidate;
				} catch (rErr) {
					renameErr = rErr;
					break;
				}
			}
			renameErr = err;
			break;
		}
	}

	if (renameErr) {
		logger.warn(
			`Could not rename unreadable store ${storePath}: ${(renameErr as Error).message}. Writing a copy instead.`,
			LOG_CONTEXT
		);
	}

	let lastWriteErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const candidate = sidecarCandidate(baseSidecarPath, attempt);
		try {
			fs.writeFileSync(candidate, contents, { encoding: 'utf-8', flag: 'wx' });
			return candidate;
		} catch (writeErr) {
			if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
			lastWriteErr = writeErr;
			break;
		}
	}

	logger.error(
		`Could not preserve unreadable store ${storePath}: ${((lastWriteErr ?? renameErr) as Error)?.message ?? 'sidecar destination exhausted'}. The file is left in place.`,
		LOG_CONTEXT
	);
	return null;
}

/**
 * Build the `deserialize` hook for one `electron-store` file.
 *
 * Parses exactly as before in the normal case. On a `SyntaxError` - the whole
 * class of "these bytes are not JSON" - the file is quarantined and an empty
 * document is returned, so conf applies the store's defaults and startup
 * continues. Any other error is rethrown untouched: an unreadable disk or a
 * bug in our own hook is not something to paper over, and Sentry should see it.
 *
 * @param storePath absolute path of the file this store reads and writes
 */
export function createStoreDeserializer<T = Record<string, unknown>>(
	storePath: string
): (value: string) => T {
	return (value: string): T => {
		const parsed = parseStoreJson<T>(value);
		if (parsed.ok) return parsed.value;

		const err = parsed.error;
		const sidecarPath = quarantineCorruptStore(storePath, value);
		logger.error(
			`Store ${path.basename(storePath)} is not valid JSON (${err.message}). ` +
				(sidecarPath
					? `Moved to ${path.basename(sidecarPath)} and started from defaults.`
					: `Could not move it aside; started from defaults.`),
			LOG_CONTEXT
		);
		// Reported, not thrown: a corrupt store is now survivable, but we still
		// want to know how often it happens and to what file.
		void captureException(err, {
			operation: 'store:deserialize',
			storeFile: path.basename(storePath),
			byteLength: value.length,
			quarantined: sidecarPath !== null,
		});
		return {} as T;
	};
}
