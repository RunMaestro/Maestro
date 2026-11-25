/**
 * SQLite Statement Log
 *
 * Every write made to a user's database through Maestro, per file, in the
 * order it ran: one JSON file in the app's data directory
 * (`sqlite-statement-log.json`), keyed by the database's path. What an entry
 * holds and which writes become one are the shared rules in
 * src/shared/sqlite/statementLog.ts; this module is the file and the one way
 * to add to it, `logSqliteStatement()`.
 *
 * Recorded by each write path itself, once the write reached the file, so the
 * viewer's edits and the CLI's land in the same list:
 *
 *   - sqlite-row-edit.ts: the cell edit, insert, delete, and undo (their
 *     single-row statement, values written in);
 *   - sqlite-query.ts: a Query-mode write, and a write run inside an explicit
 *     transaction;
 *   - sqlite-transaction.ts: a transaction's Begin and its end, however it
 *     ended (Commit, Roll back, Lock, idle, a stopped statement, a crash).
 *
 * Do NOT record in the IPC or WS handlers, which would log only half the
 * callers, and do NOT keep a second log in the renderer.
 *
 * Each record is announced to `onSqliteStatementLogged()` listeners (the IPC
 * layer forwards it to every window), so a viewer's Log shows a write made by
 * another tab or the CLI as it lands.
 *
 * Nothing here may make a write fail: a log that cannot be written is logged
 * and reported, and the write still answers.
 */

import { randomUUID } from 'crypto';
import path from 'path';

import {
	addSqliteStatementLogEntry,
	emptySqliteStatementLogStore,
	parseSqliteStatementLogStore,
	pruneSqliteStatementLogStore,
	type SqliteStatementLogRecord,
} from '../../shared/sqlite/statementLog';
import type {
	SqliteBackup,
	SqliteSchemaChange,
	SqliteStatementLog,
	SqliteStatementLogEntry,
	SqliteStatementLogOutcome,
} from '../../shared/sqlite/types';
import { getAppUserDataDir } from '../utils/app-user-data';
import { createJsonStoreFile } from '../utils/json-store-file';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getSqliteDatabase } from './sqlite-database';

/** The store file's name in the app's data directory. */
export const SQLITE_STATEMENT_LOG_FILE = 'sqlite-statement-log.json';

/** One log file: read, record, and clear. */
export interface SqliteStatementLogFile {
	/** The database's entries, newest first. */
	read: (databasePath: string) => Promise<SqliteStatementLogEntry[]>;
	/** Add one write, and resolve it as kept. */
	record: (
		databasePath: string,
		record: SqliteStatementLogRecord
	) => Promise<SqliteStatementLogEntry>;
	/** Forget the database's whole log. Resolves how many entries went. */
	clear: (databasePath: string) => Promise<number>;
}

/** A log kept in `filePath`. The app's own is `getSqliteStatementLog()`. */
export function createSqliteStatementLogFile(filePath: () => string): SqliteStatementLogFile {
	const file = createJsonStoreFile({
		filePath,
		empty: emptySqliteStatementLogStore,
		parse: parseSqliteStatementLogStore,
		logContext: 'SqliteStatementLog',
	});

	return {
		read: (databasePath) => file.read((store) => [...(store.files[databasePath]?.entries ?? [])]),

		record: (databasePath, record) =>
			file.update((store) => {
				const entries = addSqliteStatementLogEntry(store.files[databasePath]?.entries ?? [], {
					...record,
					id: randomUUID(),
				});
				return {
					store: pruneSqliteStatementLogStore({
						version: 1,
						files: { ...store.files, [databasePath]: { usedAt: record.at, entries } },
					}),
					result: entries[0],
				};
			}),

		clear: (databasePath) =>
			file.update((store) => {
				const kept = store.files[databasePath];
				if (!kept) return { store: null, result: 0 };
				const files = { ...store.files };
				delete files[databasePath];
				return { store: { version: 1, files }, result: kept.entries.length };
			}),
	};
}

let appLog: SqliteStatementLogFile | null = null;

/** The app's statement log, in its data directory. */
export function getSqliteStatementLog(): SqliteStatementLogFile {
	appLog ??= createSqliteStatementLogFile(() =>
		path.join(getAppUserDataDir(), SQLITE_STATEMENT_LOG_FILE)
	);
	return appLog;
}

const listeners = new Set<(databasePath: string) => void>();

/** Hear each database whose log changed (a write recorded, the log cleared). Returns the unsubscribe. */
export function onSqliteStatementLogged(listener: (databasePath: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(databasePath: string): void {
	for (const listener of listeners) {
		try {
			listener(databasePath);
		} catch (error) {
			logger.warn('A statement log listener failed', 'SqliteStatementLog', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Record one write in the database's log and announce it. A log that cannot
 * be written is reported, never thrown: the write it records already
 * happened, and must still answer.
 */
export async function logSqliteStatement(
	databasePath: string,
	record: SqliteStatementLogRecord
): Promise<void> {
	try {
		await getSqliteStatementLog().record(databasePath, record);
	} catch (error) {
		logger.warn('Could not record a write in the statement log', 'SqliteStatementLog', {
			error: error instanceof Error ? error.message : String(error),
		});
		void captureException(error, { context: 'sqlite-statement-log:record' });
		return;
	}
	announce(databasePath);
}

/** A write that changed rows (and maybe the schema), as the log records it. */
export function sqliteLoggedChanges(
	changes: number,
	otherChanges: number,
	schemaChanges: SqliteSchemaChange[] = []
): SqliteStatementLogOutcome {
	return { ok: true, changes, otherChanges, schemaChanges };
}

/** A write that failed once it reached the file, as the log records it. */
export function sqliteLoggedFailure(error: unknown): SqliteStatementLogOutcome {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** The `backupPath` field for a write that took the session's backup. */
export function sqliteLoggedBackup(backup: SqliteBackup | undefined): { backupPath?: string } {
	return backup ? { backupPath: backup.path } : {};
}

/**
 * An open database's statement log, newest first (the viewer's Log,
 * `maestro-cli sqlite log`).
 */
export async function readSqliteStatementLog(handle: string): Promise<SqliteStatementLog> {
	const { displayPath } = getSqliteDatabase(handle);
	return { path: displayPath, entries: await getSqliteStatementLog().read(displayPath) };
}

/** Forget an open database's whole statement log, and resolve the (empty) log left. */
export async function clearSqliteStatementLog(handle: string): Promise<SqliteStatementLog> {
	const { displayPath } = getSqliteDatabase(handle);
	const log = getSqliteStatementLog();
	if ((await log.clear(displayPath)) > 0) announce(displayPath);
	return { path: displayPath, entries: await log.read(displayPath) };
}
