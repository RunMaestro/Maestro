/**
 * Read-only SQL access to the stats database.
 *
 * Powers `maestro-cli stats-query`, letting an agent or external caller run
 * arbitrary read-only SQL against the Usage Dashboard's SQLite store to answer
 * ad-hoc questions and generate dynamic charts.
 *
 * Safety is enforced on four independent layers so a hostile or malformed
 * query can never mutate the live database the desktop app depends on, nor read
 * files outside it:
 *   1. A dedicated `readonly: true` connection (writes fail at the driver).
 *   2. `db.prepare()` accepts a single statement only - multi-statement input
 *      (e.g. "SELECT 1; DROP TABLE x") throws before execution.
 *   3. A leading-keyword allowlist (SELECT / WITH / PRAGMA / EXPLAIN / VALUES).
 *      Because layer 2 forbids multiple statements, the leading keyword fully
 *      classifies the statement - this is what blocks ATTACH/DETACH, which
 *      better-sqlite3 otherwise reports as `readonly` and would happily run.
 *   4. `stmt.readonly` is asserted true, rejecting any write or write-PRAGMA
 *      the keyword allowlist didn't already exclude.
 */

import Database from 'better-sqlite3';
import { getStatsDB } from './singleton';

/**
 * Statement kinds that are safe to run read-only. ATTACH/DETACH are deliberately
 * absent: SQLite reports them as read-only, but they can open arbitrary files.
 */
const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN', 'VALUES']);

/**
 * Extract the leading SQL keyword, skipping leading line (`--`) and block
 * (slash-star) comments and whitespace. Returns '' when none is found.
 */
function leadingKeyword(sql: string): string {
	let s = sql.trim();
	// Strip leading comments that could otherwise hide the real first keyword.
	for (;;) {
		if (s.startsWith('--')) {
			const nl = s.indexOf('\n');
			s = nl === -1 ? '' : s.slice(nl + 1).trim();
		} else if (s.startsWith('/*')) {
			const end = s.indexOf('*/');
			s = end === -1 ? '' : s.slice(end + 2).trim();
		} else {
			break;
		}
	}
	const match = s.match(/^([a-zA-Z]+)/);
	return match ? match[1].toUpperCase() : '';
}

/** Result of a read-only stats query. */
export interface StatsQueryResult {
	/** Column names in result order. */
	columns: string[];
	/** Returned rows (object per row), capped at MAX_ROWS. */
	rows: Record<string, unknown>[];
	/** Total rows the query produced, before the MAX_ROWS cap. */
	rowCount: number;
	/** True when `rows` was truncated to MAX_ROWS. */
	truncated: boolean;
}

/** Hard cap on rows returned to keep the WS payload bounded. */
export const MAX_ROWS = 10000;

/**
 * Run a single read-only SQL statement against the stats database and return
 * the rows. Throws with a friendly message when the database file does not yet
 * exist (stats never collected) or when the statement is not read-only.
 */
export function runReadonlyStatsQuery(sql: string, params: unknown[] = []): StatsQueryResult {
	const trimmed = sql.trim();
	if (!trimmed) {
		throw new Error('Empty SQL query');
	}

	const keyword = leadingKeyword(trimmed);
	if (!ALLOWED_LEADING_KEYWORDS.has(keyword)) {
		throw new Error(
			`Only read-only queries are permitted (allowed: ${[...ALLOWED_LEADING_KEYWORDS].join(', ')}).`
		);
	}

	const dbPath = getStatsDB().getDbPath();
	let db: Database.Database;
	try {
		// fileMustExist avoids creating an empty DB as a side effect of a query.
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
	} catch {
		throw new Error(
			'Stats database not found. Enable Usage & Stats (encoreFeatures.usageStats) and run some sessions first.'
		);
	}

	try {
		// prepare() throws on multiple statements, giving us free injection-of-a-
		// second-statement protection.
		const stmt = db.prepare(trimmed);

		if (!stmt.readonly) {
			throw new Error('Only read-only queries are permitted (SELECT / read PRAGMA).');
		}

		const allRows = stmt.all(...params) as Record<string, unknown>[];
		const columns = stmt.columns().map((col) => col.name);
		const truncated = allRows.length > MAX_ROWS;

		return {
			columns,
			rows: truncated ? allRows.slice(0, MAX_ROWS) : allRows,
			rowCount: allRows.length,
			truncated,
		};
	} finally {
		db.close();
	}
}
