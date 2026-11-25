/**
 * Pure helpers over a database's summary (header pragmas) and its integrity
 * check, shared by the main-process reader, the viewer's summary strip, and
 * `maestro-cli sqlite info`, so all three name and read the facts alike.
 */

import { formatDurationHuman } from '../duration';
import { formatCount, formatSize } from '../formatters';
import type { SqliteDatabaseSummary, SqliteIntegrityMode, SqliteIntegrityResult } from './types';

/**
 * Problems an integrity check reports at most. A badly damaged file can
 * produce one line per page; past this many, more detail does not help.
 */
export const SQLITE_INTEGRITY_PROBLEM_CAP = 100;

/**
 * The viewer runs a quick check on open for databases up to this size. The
 * check runs off the main process, but it still reads every page, so a large
 * file waits for the user to ask.
 */
export const SQLITE_AUTO_INTEGRITY_MAX_BYTES = 256 * 1024 * 1024;

/** How each mode is named in a sentence. */
export const SQLITE_INTEGRITY_MODE_LABELS: Record<SqliteIntegrityMode, string> = {
	quick: 'quick check',
	full: 'full check',
};

/** The pragma each mode runs, with its problem cap. */
export function sqliteIntegrityPragma(mode: SqliteIntegrityMode): string {
	const pragma = mode === 'full' ? 'integrity_check' : 'quick_check';
	return `${pragma}(${SQLITE_INTEGRITY_PROBLEM_CAP})`;
}

/**
 * Read the rows an integrity pragma returned. SQLite answers a single `ok`
 * when it finds nothing, and otherwise one row per problem, up to the cap it
 * was given. A reply that fills the cap may have stopped early.
 */
export function parseSqliteIntegrityRows(
	rows: readonly unknown[]
): Pick<SqliteIntegrityResult, 'ok' | 'problems' | 'truncated'> {
	const lines = rows.map((row) => String(row));
	if (lines.length === 1 && lines[0] === 'ok') return { ok: true, problems: [], truncated: false };
	if (lines.length === 0) {
		// Not a reply SQLite gives; never report a file as sound on no evidence.
		return { ok: false, problems: ['The check returned no result.'], truncated: false };
	}
	return { ok: false, problems: lines, truncated: lines.length >= SQLITE_INTEGRITY_PROBLEM_CAP };
}

/** `application_id` as SQLite's own docs write it: eight hex digits. */
export function formatSqliteApplicationId(applicationId: number): string {
	return `0x${(applicationId >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Journal mode for display: `WAL` in capitals, as SQLite's docs write it. */
export function formatSqliteJournalMode(journalMode: string): string {
	return journalMode === 'wal' ? 'WAL' : journalMode;
}

/** One labeled fact of the summary strip. */
export interface SqliteSummaryFact {
	key: string;
	label: string;
	value: string;
	/** Longer explanation for a tooltip. */
	title: string;
}

/**
 * The summary as labeled facts, in reading order. `user_version` and
 * `application_id` are listed only when an application set them, and the free
 * list only when it holds pages, so an ordinary file shows four facts.
 */
export function sqliteSummaryFacts(summary: SqliteDatabaseSummary): SqliteSummaryFact[] {
	const facts: SqliteSummaryFact[] = [
		{
			key: 'pages',
			label: 'Pages',
			value: `${formatCount(summary.pageCount)} x ${formatSize(summary.pageSize)}`,
			title: `${formatCount(summary.pageCount)} pages of ${formatCount(summary.pageSize)} bytes (page_count, page_size)`,
		},
	];
	if (summary.freelistCount > 0) {
		facts.push({
			key: 'freelist',
			label: 'Free',
			value: formatSize(summary.freelistCount * summary.pageSize),
			title: `${formatCount(summary.freelistCount)} unused pages on the free list (freelist_count); VACUUM would return them`,
		});
	}
	facts.push(
		{
			key: 'encoding',
			label: 'Encoding',
			value: summary.encoding,
			title: 'Text encoding of every TEXT value in the file (encoding)',
		},
		{
			key: 'journal',
			label: 'Journal',
			value: formatSqliteJournalMode(summary.journalMode),
			title:
				summary.journalMode === 'wal'
					? 'Write-ahead log: recent writes may sit in the -wal file beside the database (journal_mode)'
					: 'Rollback journal mode as this read-only connection sees it (journal_mode)',
		}
	);
	if (summary.userVersion !== 0) {
		facts.push({
			key: 'user-version',
			label: 'user_version',
			value: String(summary.userVersion),
			title: 'Schema version the application keeps in the header (user_version)',
		});
	}
	if (summary.applicationId !== 0) {
		facts.push({
			key: 'application-id',
			label: 'application_id',
			value: formatSqliteApplicationId(summary.applicationId),
			title: 'File format the application stamped in the header (application_id)',
		});
	}
	return facts;
}

/** Wall time of a check: milliseconds below a second, then seconds and up. */
function formatElapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : formatDurationHuman(ms);
}

/** A check's verdict in one line: `ok (quick check, 12 ms)`, `3 problems (full check, 2s)`. */
export function formatSqliteIntegrity(result: SqliteIntegrityResult): string {
	const how = `${SQLITE_INTEGRITY_MODE_LABELS[result.mode]}, ${formatElapsed(result.elapsedMs)}`;
	if (result.ok) return `ok (${how})`;
	const count = `${formatCount(result.problems.length)}${result.truncated ? '+' : ''}`;
	return `${count} ${result.problems.length === 1 && !result.truncated ? 'problem' : 'problems'} (${how})`;
}
