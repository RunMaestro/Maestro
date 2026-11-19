/**
 * Read-only SQL statements: which ones may run, and the limits a run keeps.
 *
 * Shared by the SQLite viewer's Query mode (src/main/sqlite/sqlite-query.ts),
 * `maestro-cli sqlite query`, and `maestro-cli stats-query`
 * (src/main/stats/readonly-query.ts), so every place that runs SQL a person
 * typed refuses the same statements with the same words.
 *
 * The leading keyword is one layer of several. It is what blocks `ATTACH`
 * and `DETACH`, which SQLite reports as read-only although they open other
 * files, and it turns a write into a plain refusal before the driver sees
 * it. The driver's own checks (a `readonly` connection, one statement per
 * `prepare()`, `stmt.readonly`) still stand behind it.
 */

/**
 * Statement kinds a read-only run accepts, in the order a refusal lists them.
 * `ATTACH` / `DETACH` are absent on purpose: see the module comment.
 */
export const SQLITE_READ_ONLY_KEYWORDS: readonly string[] = [
	'SELECT',
	'WITH',
	'PRAGMA',
	'EXPLAIN',
	'VALUES',
];

const READ_ONLY_KEYWORD_SET: ReadonlySet<string> = new Set(SQLITE_READ_ONLY_KEYWORDS);

/** Rows one Query-mode window shows before the grid asks for more. */
export const SQLITE_QUERY_PAGE_ROWS = 500;

/** Most rows one call returns, whatever the caller asks for. */
export const SQLITE_QUERY_MAX_LIMIT = 1000;

/**
 * How long one statement may run before it is stopped. Statements run in a
 * child process that is killed at this point, so a runaway query (an
 * unbounded `WITH RECURSIVE`, a cross join of two big tables) costs a wait,
 * never a frozen app.
 */
export const SQLITE_QUERY_TIMEOUT_MS = 60_000;

/**
 * The statement's first keyword, upper case, after any leading whitespace,
 * line comments (`--`), and block comments. Empty when the text starts with
 * anything else (a stray `;`, a quote) or holds only comments.
 */
export function sqliteLeadingKeyword(sql: string): string {
	let text = sql.trim();
	for (;;) {
		if (text.startsWith('--')) {
			const newline = text.indexOf('\n');
			text = newline === -1 ? '' : text.slice(newline + 1).trim();
		} else if (text.startsWith('/*')) {
			const end = text.indexOf('*/');
			text = end === -1 ? '' : text.slice(end + 2).trim();
		} else {
			break;
		}
	}
	const match = /^[A-Za-z]+/.exec(text);
	return match ? match[0].toUpperCase() : '';
}

/** Whether a statement's leading keyword is one a read-only run accepts. */
export function isSqliteReadOnlyKeyword(keyword: string): boolean {
	return READ_ONLY_KEYWORD_SET.has(keyword.toUpperCase());
}

/**
 * Why a statement will not run read-only, judged by its text alone, or null
 * when the text may go on to the driver. The driver can still refuse it
 * (`stmt.readonly` false, two statements); see `SQLITE_NOT_READ_ONLY_MESSAGE`.
 */
export function sqliteReadOnlyRefusal(sql: string): string | null {
	if (!sql.trim()) return 'Write a statement to run.';
	const keyword = sqliteLeadingKeyword(sql);
	if (isSqliteReadOnlyKeyword(keyword)) return null;
	const allowed = SQLITE_READ_ONLY_KEYWORDS.join(', ');
	if (keyword === 'ATTACH' || keyword === 'DETACH') {
		return `${keyword} opens or closes another database file, so it is refused here. Queries are read-only: ${allowed}.`;
	}
	if (!keyword)
		return `This does not start with a statement keyword. Queries start with ${allowed}.`;
	return `${keyword} is not a read-only statement. Queries here are read-only: ${allowed}.`;
}

/** The driver reported the statement would write (a write PRAGMA, `WITH ... DELETE`). */
export const SQLITE_NOT_READ_ONLY_MESSAGE =
	'This statement would change the database, so it is refused here. Queries are read-only.';

/** `prepare()` found a second statement after the first. */
export const SQLITE_ONE_STATEMENT_MESSAGE =
	'Run one statement at a time: the text holds more than one.';

/** The run outlived `SQLITE_QUERY_TIMEOUT_MS` and was stopped. */
export function sqliteQueryTimeoutMessage(timeoutMs = SQLITE_QUERY_TIMEOUT_MS): string {
	return `The query was stopped after ${Math.round(timeoutMs / 1000)} s. Narrow it (a WHERE, a LIMIT) and run it again.`;
}

/** The run was stopped by the user, by a newer run, or by closing the database. */
export const SQLITE_QUERY_STOPPED_MESSAGE = 'The query was stopped.';
