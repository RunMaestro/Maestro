/**
 * SQLite Integrity Check
 *
 * The viewer's integrity flag. `PRAGMA quick_check` / `integrity_check` read
 * every page of the file, and better-sqlite3 cannot interrupt a statement, so
 * on the main process a large database would hold every IPC call until the
 * check finished. Each check therefore runs in a child process with its own
 * read-only connection (sqlite-integrity-task.ts), and main only ever sees
 * the verdict (sqlite-worker-runner.ts runs it).
 *
 *   - One check per database and mode at a time: a second caller (another
 *     tab, the CLI) shares the one in flight.
 *   - A check stops when its database is released: closing the tab, or the
 *     idle reaper, kills the process and rejects the caller.
 *   - Under vitest no compiled entry exists, so the check runs inline
 *     there (see sqlite-worker-runner.ts).
 */

import type { SqliteIntegrityMode, SqliteIntegrityResult } from '../../shared/sqlite/types';
import { reportSqliteBusy } from './sqlite-connection';
import { getSqliteDatabase } from './sqlite-database';
import { startSqliteWorkerTask } from './sqlite-worker-runner';

/** Checks in flight, keyed by handle and mode. */
const inFlight = new Map<string, Promise<SqliteIntegrityResult>>();

/** The error a caller sees when its database closed mid-check. */
export const SQLITE_INTEGRITY_STOPPED_MESSAGE = 'Integrity check stopped: the database was closed.';

/**
 * Check an open database's integrity off the main process. `quick` is linear
 * in the file's size; `full` also verifies every index against its table.
 */
export function checkSqliteIntegrity(
	handle: string,
	mode: SqliteIntegrityMode
): Promise<SqliteIntegrityResult> {
	const key = `${handle}:${mode}`;
	const running = inFlight.get(key);
	if (running) return running;

	const database = getSqliteDatabase(handle);
	const { result } = startSqliteWorkerTask(
		database,
		{ kind: 'integrity', task: { filePath: database.displayPath, mode } },
		{ closedMessage: SQLITE_INTEGRITY_STOPPED_MESSAGE, label: 'Integrity check' }
	);
	const tracked = reportSqliteBusy('read', () => result).finally(() => inFlight.delete(key));
	inFlight.set(key, tracked);
	return tracked;
}
