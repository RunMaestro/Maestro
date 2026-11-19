/**
 * SQLite Database Summary
 *
 * The database-wide facts the viewer's summary strip shows: page size and
 * count, free pages, text encoding, journal mode, `user_version`, and
 * `application_id`. Each is a header field read through a pragma, so this
 * answers at once whatever the database's size. The integrity flag beside
 * them is the one fact that is NOT cheap; it lives in sqlite-integrity.ts and
 * runs on a worker thread.
 */

import type { SqliteDatabaseSummary } from '../../shared/sqlite/types';
import { getSqliteDatabase } from './sqlite-database';

/** Read the summary of an open database. Pure header reads: nothing is scanned or written. */
export function readSqliteDatabaseSummary(handle: string): SqliteDatabaseSummary {
	const { db } = getSqliteDatabase(handle);
	const number = (pragma: string): number => Number(db.pragma(pragma, { simple: true }));
	return {
		pageSize: number('page_size'),
		pageCount: number('page_count'),
		freelistCount: number('freelist_count'),
		encoding: String(db.pragma('encoding', { simple: true })),
		// The query form only reports the mode; it never changes it, and a
		// read-only connection could not persist a change anyway.
		journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
		userVersion: number('user_version'),
		applicationId: number('application_id'),
		sqliteVersion: String(db.prepare('SELECT sqlite_version()').pluck().get()),
	};
}
