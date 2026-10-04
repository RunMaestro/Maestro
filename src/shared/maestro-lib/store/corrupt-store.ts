/**
 * The pure half of corrupt-store handling, shared by the desktop and the TUI.
 *
 * What counts as a corrupt store, and where its quarantined copy is named, is
 * one decision. The desktop acts on it by moving the file aside and starting
 * from defaults (`src/main/stores/corrupt-store-recovery.ts`); a read-only
 * client such as the TUI only REPORTS it and leaves the bytes exactly where
 * they are, because the desktop is the one owner allowed to touch them. Both
 * classify through `parseStoreJson`, so they cannot disagree about whether a
 * file is corrupt.
 */

import * as path from 'path';

import { parseJsonWithBom } from '../../jsonUtils';
import { fileTimestampSlug } from '../../formatters';

/**
 * Sidecar path for a store file that could not be parsed.
 *
 * Stamped rather than fixed so a second incident cannot overwrite the first
 * quarantine, which would be the one way the desktop's recovery could still
 * lose data.
 */
export function corruptStorePath(storePath: string, now: Date = new Date()): string {
	const dir = path.dirname(storePath);
	const base = path.basename(storePath, '.json');
	return path.join(dir, `${base}.corrupt-${fileTimestampSlug(now)}.json`);
}

/** A store file's bytes, classified: parsed JSON, or proof the bytes are not JSON. */
export type StoreParseResult<T> = { ok: true; value: T } | { ok: false; error: SyntaxError };

/**
 * Parse a store file's contents (BOM tolerated, as electron-store writes none
 * but editors and sync clients sometimes add one).
 *
 * A `SyntaxError` - the whole class of "these bytes are not JSON" - is the one
 * failure classified as corruption and returned. Anything else is rethrown: it
 * is not a property of the file, and hiding it would hide a bug.
 */
export function parseStoreJson<T = unknown>(content: string): StoreParseResult<T> {
	try {
		return { ok: true, value: parseJsonWithBom<T>(content) };
	} catch (err) {
		if (err instanceof SyntaxError) return { ok: false, error: err };
		throw err;
	}
}
