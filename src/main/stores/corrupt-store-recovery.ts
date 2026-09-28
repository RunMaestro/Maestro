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

import { parseJsonWithBom } from '../../shared/jsonUtils';
import { fileTimestampSlug } from '../../shared/formatters';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'Stores';

/**
 * Sidecar path for a store file that could not be parsed.
 *
 * Stamped rather than fixed so a second incident cannot overwrite the first
 * quarantine, which would be the one way this recovery could still lose data.
 */
export function corruptStorePath(storePath: string, now: Date = new Date()): string {
	const dir = path.dirname(storePath);
	const base = path.basename(storePath, '.json');
	return path.join(dir, `${base}.corrupt-${fileTimestampSlug(now)}.json`);
}

/**
 * Move an unparseable store file aside so the next read starts clean.
 *
 * Rename first: it is atomic, costs nothing on a multi-megabyte file, and
 * preserves the bytes exactly. If it fails (a cloud-sync folder holding a lock,
 * a read-only volume), fall back to writing the contents we already have in
 * memory. Only if BOTH fail is the document actually at risk, and that is
 * logged as an error rather than swallowed.
 *
 * @returns the sidecar path when the document was preserved, otherwise null
 */
function quarantineCorruptStore(storePath: string, contents: string): string | null {
	const sidecarPath = corruptStorePath(storePath);

	try {
		fs.renameSync(storePath, sidecarPath);
		return sidecarPath;
	} catch (renameErr) {
		logger.warn(
			`Could not rename unreadable store ${storePath}: ${(renameErr as Error).message}. Writing a copy instead.`,
			LOG_CONTEXT
		);
	}

	try {
		fs.writeFileSync(sidecarPath, contents, 'utf-8');
		return sidecarPath;
	} catch (writeErr) {
		logger.error(
			`Could not preserve unreadable store ${storePath}: ${(writeErr as Error).message}. The file is left in place.`,
			LOG_CONTEXT
		);
		return null;
	}
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
		try {
			return parseJsonWithBom<T>(value);
		} catch (err) {
			if (!(err instanceof SyntaxError)) throw err;

			const sidecarPath = quarantineCorruptStore(storePath, value);
			logger.error(
				`Store ${path.basename(storePath)} is not valid JSON (${(err as Error).message}). ` +
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
		}
	};
}
