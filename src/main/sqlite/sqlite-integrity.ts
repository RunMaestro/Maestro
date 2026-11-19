/**
 * SQLite Integrity Check
 *
 * The viewer's integrity flag. `PRAGMA quick_check` / `integrity_check` read
 * every page of the file, and better-sqlite3 cannot interrupt a statement, so
 * on the main process a large database would hold every IPC call until the
 * check finished. Each check therefore runs on a worker thread with its own
 * read-only connection (sqlite-integrity-task.ts), and main only ever sees
 * the verdict.
 *
 *   - One check per database and mode at a time: a second caller (another
 *     tab, the CLI) shares the one in flight.
 *   - A check stops when its database is released: closing the tab, or the
 *     idle reaper, terminates the worker and rejects the caller.
 *   - Under vitest the sources are `.ts` and no compiled worker sits beside
 *     this file, so the check runs inline there. The packaged and dev builds
 *     compile the worker with the rest of the main process.
 */

import { existsSync } from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

import type { SqliteIntegrityMode, SqliteIntegrityResult } from '../../shared/sqlite/types';
import { getSqliteDatabase, type OpenSqliteDatabase } from './sqlite-database';
import { runSqliteIntegrityCheck, type SqliteIntegrityReply } from './sqlite-integrity-task';

const WORKER_SCRIPT = path.join(__dirname, 'sqlite-integrity-worker.js');

/** Checks in flight, keyed by handle and mode. */
const inFlight = new Map<string, Promise<SqliteIntegrityResult>>();

/** The error a caller sees when its database closed mid-check. */
export const SQLITE_INTEGRITY_STOPPED_MESSAGE = 'Integrity check stopped: the database was closed.';

function runOnWorker(
	database: OpenSqliteDatabase,
	mode: SqliteIntegrityMode
): Promise<SqliteIntegrityResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(WORKER_SCRIPT, {
			workerData: { filePath: database.displayPath, mode },
		});
		let settled = false;
		const settle = (finish: () => void) => {
			if (settled) return;
			settled = true;
			database.releaseHooks.delete(stop);
			finish();
		};
		function stop() {
			settle(() => reject(new Error(SQLITE_INTEGRITY_STOPPED_MESSAGE)));
			void worker.terminate();
		}
		database.releaseHooks.add(stop);

		worker.once('message', (reply: SqliteIntegrityReply) =>
			settle(() => {
				if (reply.ok) resolve(reply.result);
				else
					reject(
						Object.assign(
							new Error(reply.error.message),
							reply.error.code ? { code: reply.error.code } : {}
						)
					);
			})
		);
		worker.once('error', (error) => settle(() => reject(error)));
		worker.once('exit', (code) =>
			settle(() =>
				reject(new Error(`Integrity check ended (exit code ${code}) without a verdict.`))
			)
		);
	});
}

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
	const check = existsSync(WORKER_SCRIPT)
		? runOnWorker(database, mode)
		: Promise.resolve().then(() =>
				runSqliteIntegrityCheck({ filePath: database.displayPath, mode })
			);
	const tracked = check.finally(() => inFlight.delete(key));
	inFlight.set(key, tracked);
	return tracked;
}
