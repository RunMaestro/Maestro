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
 * answers. So the file is read once and kept in memory, every change goes
 * through one write queue, and each write replaces the file atomically
 * (temp file + rename), so a crash mid-write leaves the old history whole.
 *
 * A file that is not JSON is moved aside to a `.corrupt-<stamp>.json`
 * sidecar (`corruptStorePath()`) and the history starts empty, the way the
 * app's stores recover, rather than being overwritten by the next run.
 *
 * Nothing here may make a query fail: a history that cannot be written is
 * logged and reported, and the run still answers.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { corruptStorePath, parseStoreJson } from '../../shared/maestro-lib/store/corrupt-store';
import {
	addSqliteQueryHistoryRun,
	emptySqliteQueryHistoryStore,
	isRecordableSqliteQuery,
	parseSqliteQueryHistoryStore,
	pruneSqliteQueryHistoryStore,
	type SqliteQueryHistoryRun,
	type SqliteQueryHistoryStore,
} from '../../shared/sqlite/history';
import type { SqliteQueryHistory, SqliteQueryHistoryEntry } from '../../shared/sqlite/types';
import { getAppUserDataDir } from '../utils/app-user-data';
import { atomicWriteJson, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { getSqliteDatabase } from './sqlite-database';

/** The store file's name in the app's data directory. */
export const SQLITE_QUERY_HISTORY_FILE = 'sqlite-query-history.json';

const LOG_CONTEXT = 'SqliteQueryHistory';
const QUEUE_KEY = 'history';

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
	const queue = createKeyedWriteQueue();
	let loaded: SqliteQueryHistoryStore | null = null;

	async function load(): Promise<SqliteQueryHistoryStore> {
		if (loaded) return loaded;
		const file = filePath();
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			loaded = emptySqliteQueryHistoryStore();
			return loaded;
		}
		const parsed = parseStoreJson<unknown>(text);
		if (!parsed.ok) {
			const aside = corruptStorePath(file);
			logger.warn(`Query history is not JSON; moved it to ${aside}`, LOG_CONTEXT, {
				error: parsed.error.message,
			});
			await fs.rename(file, aside);
			loaded = emptySqliteQueryHistoryStore();
			return loaded;
		}
		loaded = parseSqliteQueryHistoryStore(parsed.value);
		return loaded;
	}

	async function save(store: SqliteQueryHistoryStore): Promise<void> {
		const file = filePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await atomicWriteJson(file, store);
		loaded = store;
	}

	return {
		read: (databasePath) =>
			queue.enqueue(QUEUE_KEY, async () => [
				...((await load()).files[databasePath]?.entries ?? []),
			]),

		record: (databasePath, run) =>
			queue.enqueue(QUEUE_KEY, async () => {
				if (!isRecordableSqliteQuery(run.sql)) return;
				const store = await load();
				const entries = addSqliteQueryHistoryRun(
					store.files[databasePath]?.entries ?? [],
					run,
					randomUUID
				);
				await save(
					pruneSqliteQueryHistoryStore({
						version: 1,
						files: { ...store.files, [databasePath]: { usedAt: run.ranAt, entries } },
					})
				);
			}),

		forget: (databasePath, entryId) =>
			queue.enqueue(QUEUE_KEY, async () => {
				const store = await load();
				const file = store.files[databasePath];
				if (!file) return 0;
				const entries =
					entryId === null ? [] : file.entries.filter((entry) => entry.id !== entryId);
				const removed = file.entries.length - entries.length;
				if (removed === 0) return 0;
				const files = { ...store.files };
				if (entries.length === 0) delete files[databasePath];
				else files[databasePath] = { ...file, entries };
				await save({ version: 1, files });
				return removed;
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
