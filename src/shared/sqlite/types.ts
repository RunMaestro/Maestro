/**
 * SQLite Preview Types
 *
 * The wire contract between the main-process SQLite engine (src/main/sqlite/)
 * and the renderer's SQLite viewer.
 *
 * As with parquet (src/shared/parquet/types.ts), bytes never cross IPC: the
 * database stays behind a read-only connection in the main process, and the
 * renderer addresses it by the opaque `handle` it got back from opening it.
 */

/** What opening a database returns. Later calls name the database by `handle`. */
export interface SqliteDatabaseInfo {
	/** Opaque id of the main-process connection. */
	handle: string;
	/** Path as the user knows it. */
	displayPath: string;
	/** Size of the main database file at open, excluding any `-wal` sidecar. */
	fileBytes: number;
}
