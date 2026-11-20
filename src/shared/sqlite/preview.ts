/**
 * SQLite Preview Detection
 *
 * `.db` is not a format. Berkeley DB, LevelDB, Realm, and plenty of app-private
 * stores use the same extension, and so does a SQLCipher database, whose bytes
 * are encrypted from the first page. The extension only says "this might be a
 * database worth a look"; the file's own header decides whether it is SQLite.
 *
 * Every SQLite 3 database starts with the 16-byte string `SQLite format 3\0`
 * (https://www.sqlite.org/fileformat.html#magic_header_string). A file that
 * fails this check is not ours to open: it falls through to the existing
 * binary card exactly as before. That includes SQLCipher, which cannot be told
 * apart from any other non-SQLite binary by its header alone.
 *
 * A file that passes comes back from `fs:readFile` as a `maestro-sqlite://`
 * marker rather than as content (see the marker section at the end).
 *
 * This module is pure (no Node, no DOM) so the renderer and the CLI can share
 * the rule. Reading the header off disk lives in `src/main/sqlite/`.
 */

import { getFileExtension } from '../fileCategories';
import { createPreviewMarkerCodec } from '../previewMarker';

/** The 16 bytes every SQLite 3 database file begins with (`SQLite format 3\0`). */
export const SQLITE_HEADER_MAGIC: readonly number[] = Object.freeze([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

/** How many leading bytes {@link hasSqliteHeader} needs to decide. */
export const SQLITE_HEADER_LENGTH = SQLITE_HEADER_MAGIC.length;

/**
 * Extensions worth sniffing for a SQLite header.
 *
 * The extension gates the sniff, never the verdict: a `.db` that fails the
 * header check is not SQLite, whatever it is called.
 */
const SQLITE_CANDIDATE_EXTENSIONS = new Set(['db', 'db3', 'sqlite', 'sqlite3', 's3db', 'sl3']);

/**
 * Whether a path's extension makes it worth reading its header.
 *
 * Uses the canonical {@link getFileExtension}, so an extension that only
 * appears in a parent directory (`/data/app.db/LOCK`) does not count.
 */
export function isSqliteCandidateFile(filePath: string): boolean {
	return SQLITE_CANDIDATE_EXTENSIONS.has(getFileExtension(filePath));
}

/**
 * Whether `bytes` begins with the SQLite 3 magic header.
 *
 * Takes any byte array (a Node `Buffer` is a `Uint8Array`) holding at least the
 * first {@link SQLITE_HEADER_LENGTH} bytes of the file. Anything shorter is not
 * a database: an empty file and a truncated header both fail.
 */
export function hasSqliteHeader(bytes: ArrayLike<number>): boolean {
	if (bytes.length < SQLITE_HEADER_LENGTH) return false;
	for (let i = 0; i < SQLITE_HEADER_LENGTH; i++) {
		if (bytes[i] !== SQLITE_HEADER_MAGIC[i]) return false;
	}
	return true;
}

// ─── Preview marker ───────────────────────────────────────────────────────────
//
// A database never crosses `fs:readFile` as content: it is binary, can be far
// larger than RAM, and may be someone's live application database. A read that
// proves the header hands back this marker instead (see src/shared/previewMarker.ts),
// and the SQLite viewer queries the file over its own IPC using the tab's path.

/** Marker scheme stored in a file tab's `content` in place of database bytes. */
export const SQLITE_SCHEME = 'maestro-sqlite';

const sqliteMarker = createPreviewMarkerCodec(SQLITE_SCHEME);

/** Build the marker a SQLite read returns in place of file content. */
export function buildSqlitePreviewMarker(filePath: string): string {
	return sqliteMarker.build(filePath);
}

/** Cheap check for "is this `fs:readFile` result a SQLite marker". */
export function isSqlitePreviewMarker(value: string | null | undefined): boolean {
	return sqliteMarker.is(value);
}

/** Recover the path from a marker, or `null` when it is malformed or another format's. */
export function parseSqlitePreviewMarker(value: string): string | null {
	return sqliteMarker.parse(value);
}
