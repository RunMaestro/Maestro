/**
 * SQLite Header Sniff
 *
 * Decides whether a local file is really a SQLite database by reading its
 * first 16 bytes, never by trusting its extension. See
 * `src/shared/sqlite/preview.ts` for why the extension cannot decide.
 *
 * The read is positional and bounded: a multi-gigabyte database costs one
 * 16-byte read, and the file is never opened through SQLite here, so a sniff
 * takes no lock and cannot create a `-wal` or `-shm` sidecar next to someone's
 * live application database.
 */

import { promises as fs } from 'fs';

import {
	hasSqliteHeader,
	isSqliteCandidateFile,
	SQLITE_HEADER_LENGTH,
} from '../../shared/sqlite/preview';

/**
 * Whether the file at `filePath` begins with the SQLite 3 magic header.
 *
 * Filesystem errors (a missing file, a directory, no permission) propagate so
 * the caller keeps its own handling for them; `fs:readFile` turns ENOENT into
 * `null` and must keep doing so for a `.db` that vanished.
 */
export async function hasSqliteHeaderOnDisk(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(SQLITE_HEADER_LENGTH);
		const { bytesRead } = await handle.read(buffer, 0, SQLITE_HEADER_LENGTH, 0);
		return hasSqliteHeader(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

/**
 * Whether a local file should open in the SQLite viewer: its extension makes
 * it a candidate AND its header proves it is SQLite.
 *
 * A candidate that fails the header (Berkeley DB, LevelDB, SQLCipher, an empty
 * placeholder) returns `false` and takes the existing binary path unchanged.
 * Non-candidates are never opened, so ordinary reads pay nothing.
 */
export async function isSqliteDatabaseFile(filePath: string): Promise<boolean> {
	if (!isSqliteCandidateFile(filePath)) return false;
	return hasSqliteHeaderOnDisk(filePath);
}
