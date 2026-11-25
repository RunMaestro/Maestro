/**
 * SQLite Query History
 *
 * Every database's query history, in one JSON file in the app's data
 * directory (`sqlite-query-history.json`), keyed by the database's path. What
 * an entry holds and when a run becomes one are the shared rules in
 * src/shared/sqlite/history.ts; this module is the file.
 *
 * Written only by this process: the viewer's runs and `maestro-cli sqlite
 * query` both reach `runSqliteQuery()` here, which records the run before it
 * answers. The file itself (read once, one write queue, atomic replace, a
 * torn file moved to a `.corrupt-<stamp>.json` sidecar) is
 * `createJsonStoreFile()`, shared with the statement log.
 *
 * Nothing here may make a query fail: a history that cannot be written is
 * logged and reported, and the run still answers.
 */

import { randomUUID } from 'crypto';
import path from 'path';

import {
	addSqliteQueryHistoryRun,
	emptySqliteQueryHistoryStore,
	isRecordableSqliteQuery,
	parseSqliteQueryHistoryStore,
	pruneSqliteQueryHistoryStore,
	type SqliteQueryHistoryRun,
} from '../../shared/sqlite/history';
import type { SqliteQueryHistory, SqliteQueryHistoryEntry } from '../../shared/sqlite/types';
import { getAppUserDataDir } from '../utils/app-user-data';
import { createJsonStoreFile } from '../utils/json-store-file';
import { getSqliteDatabase } from './sqlite-database';

/** The store file's name in the app's data directory. */
export const SQLITE_QUERY_HISTORY_FILE = 'sqlite-query-history.json';

/** One history file: read, record, and forget. */
export interface SqliteQueryHistoryFile {
	/** The database's entries, newest first. */
	read: (databasePath: string) => Promise<SqliteQueryHistoryEntry[]>;
	/** Record one run. Does nothing for a statement too long (or too empty) to keep. */
	record: (databasePath: string, run: SqliteQueryHistoryRun) => Promise<void>;
	/** Forget one entry, or every entry with `entryId` null. Resolves how many went. */
	forget: (databasePath: string, entryId: string | null) => Promise<number>;
}

/** A history kept in `filePath`. The app's own is `getSqliteQueryHistory()`. */
export function createSqliteQueryHistoryFile(filePath: () => string): SqliteQueryHistoryFile {
	const file = createJsonStoreFile({
		filePath,
		empty: emptySqliteQueryHistoryStore,
		parse: parseSqliteQueryHistoryStore,
		logContext: 'SqliteQueryHistory',
	});

	return {
		read: (databasePath) => file.read((store) => [...(store.files[databasePath]?.entries ?? [])]),

		record: (databasePath, run) =>
			file.update((store) => {
				if (!isRecordableSqliteQuery(run.sql)) return { store: null, result: undefined };
				const entries = addSqliteQueryHistoryRun(
					store.files[databasePath]?.entries ?? [],
					run,
					randomUUID
				);
				return {
					store: pruneSqliteQueryHistoryStore({
						version: 1,
						files: { ...store.files, [databasePath]: { usedAt: run.ranAt, entries } },
					}),
					result: undefined,
				};
			}),

		forget: (databasePath, entryId) =>
			file.update((store) => {
				const kept = store.files[databasePath];
				if (!kept) return { store: null, result: 0 };
				const entries =
					entryId === null ? [] : kept.entries.filter((entry) => entry.id !== entryId);
				const removed = kept.entries.length - entries.length;
				if (removed === 0) return { store: null, result: 0 };
				const files = { ...store.files };
				if (entries.length === 0) delete files[databasePath];
				else files[databasePath] = { ...kept, entries };
				return { store: { version: 1, files }, result: removed };
			}),
	};
}

let appHistory: SqliteQueryHistoryFile | null = null;

/** The app's query history, in its data directory. */
export function getSqliteQueryHistory(): SqliteQueryHistoryFile {
	appHistory ??= createSqliteQueryHistoryFile(() =>
		path.join(getAppUserDataDir(), SQLITE_QUERY_HISTORY_FILE)
	);
	return appHistory;
}

/**
 * An open database's history, newest first (Query mode's History rail,
 * `maestro-cli sqlite history`).
 */
export async function readSqliteQueryHistory(handle: string): Promise<SqliteQueryHistory> {
	const { displayPath } = getSqliteDatabase(handle);
	return { path: displayPath, entries: await getSqliteQueryHistory().read(displayPath) };
}

/**
 * Forget one entry of an open database's history, or all of it with
 * `entryId` null, and resolve the history left.
 */
export async function forgetSqliteQueryHistory(
	handle: string,
	entryId: string | null
): Promise<SqliteQueryHistory> {
	if (entryId !== null && typeof entryId !== 'string') {
		throw new Error('A history entry id must be a string, or null to clear the history.');
	}
	const { displayPath } = getSqliteDatabase(handle);
	const history = getSqliteQueryHistory();
	await history.forget(displayPath, entryId);
	return { path: displayPath, entries: await history.read(displayPath) };
}
