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
 * This module is pure (no Node, no DOM) so the renderer and the CLI can share
 * the rule. Reading the header off disk lives in `src/main/sqlite/`.
 */

import { getFileExtension } from '../fileCategories';

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
