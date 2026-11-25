/**
 * Classifying errors thrown by `better-sqlite3`.
 */

/**
 * True when `err` is SQLite saying the file itself is damaged: `SQLITE_CORRUPT`
 * ("database disk image is malformed", plus its extended codes) or
 * `SQLITE_NOTADB` ("file is not a database"). better-sqlite3 puts the result
 * code on `SqliteError.code`.
 *
 * These do not heal on a retry or a restart: the same bytes fail the same way
 * on every boot, so they are the only errors that justify moving a database
 * aside. Everything else is not the file's fault and must leave it alone: lock
 * contention (`SQLITE_BUSY`), a full disk, a permission error, and above all a
 * native addon that failed to load (`ERR_DLOPEN_FAILED`, a NODE_MODULE_VERSION
 * mismatch), which throws from the first `new Database()` of a healthy file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code !== 'string') return false;
	return (
		code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_')
	);
}

/**
 * True when `err` is SQLite saying another connection holds the lock it needs
 * and the busy timeout ran out: `SQLITE_BUSY` and its extended codes
 * (`SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_TIMEOUT`).
 *
 * Not `SQLITE_LOCKED`: that is a conflict inside one connection (or one shared
 * cache), never another process, and waiting does not clear it.
 */
export function isSqliteBusyError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'));
}
