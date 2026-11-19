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
 *
 * Parameters (`?`, `:id`) are found and bound here too
 * (`sqliteQueryParameters()`, `sqliteQueryBinding()`), so a value a person
 * types is always bound by the driver and never spliced into the text.
 */

import { sqliteNumberBindValue, sqliteNumberTextProblem, type SqliteBindValue } from './filter';
import { sqliteTokens } from './tokens';
import type { SqliteParameterValue, SqliteParameterValues, SqliteQueryParameter } from './types';

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
 * How long one export may run, statement and file together, before it is
 * stopped. Longer than a Run's: an export reads every row, not one window.
 */
export const SQLITE_EXPORT_TIMEOUT_MS = 10 * 60_000;

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

/** How one run treats the statement it is given. */
export interface SqliteRunOptions {
	/**
	 * Run `EXPLAIN QUERY PLAN <statement>` instead of the statement: SQLite
	 * reports how it would find the rows (which indexes, which full scans,
	 * which temporary sorts) and reads none of them. Query mode's Plan toggle,
	 * `maestro-cli sqlite query --plan`.
	 */
	plan?: boolean;
	/**
	 * The tab's "Enable editing" unlock is on (`maestro-cli sqlite query
	 * --enable-editing`): a statement that changes the database may run, so
	 * the text is judged by `sqliteEditingQueryRefusal()` instead of the
	 * read-only allowlist. Main still checks the grant itself.
	 */
	editing?: boolean;
}

/**
 * Transaction control a run refuses even with editing on. Each run is its own
 * transaction (committed when the statement succeeds, rolled back when it
 * fails or is stopped), and its connection closes after it, so a `BEGIN`
 * would only ever be rolled back.
 */
export const SQLITE_TRANSACTION_KEYWORDS: readonly string[] = [
	'BEGIN',
	'COMMIT',
	'END',
	'ROLLBACK',
	'SAVEPOINT',
	'RELEASE',
];

const TRANSACTION_KEYWORD_SET: ReadonlySet<string> = new Set(SQLITE_TRANSACTION_KEYWORDS);

/** Why `BEGIN` / `COMMIT` and the like are refused with editing on. */
export function sqliteTransactionRefusal(keyword: string): string {
	return `${keyword} is refused here: each run is its own transaction, committed when the statement succeeds and rolled back when it fails or is stopped.`;
}

/** `VACUUM INTO` writes a copy of the database to another file. */
export const SQLITE_VACUUM_INTO_MESSAGE =
	'VACUUM INTO writes a copy of the database to another file, so it is refused here. A plain VACUUM runs.';

/**
 * Why a statement will not run with editing on, judged by its text alone, or
 * null when it may go on to the driver. Writes are allowed; what stays
 * refused is what reaches past this one file or this one run: `ATTACH` /
 * `DETACH` and `VACUUM INTO` (other files, outside the backup), and
 * transaction control (`SQLITE_TRANSACTION_KEYWORDS`). With `plan`, an
 * EXPLAIN is refused as it is read-only.
 */
export function sqliteEditingQueryRefusal(
	sql: string,
	options: SqliteRunOptions = {}
): string | null {
	if (!sql.trim()) return 'Write a statement to run.';
	const keyword = sqliteLeadingKeyword(sql);
	if (!keyword) return 'This does not start with a statement keyword.';
	if (keyword === 'ATTACH' || keyword === 'DETACH') {
		return `${keyword} opens or closes another database file, so it is refused here, even with editing enabled.`;
	}
	if (TRANSACTION_KEYWORD_SET.has(keyword)) return sqliteTransactionRefusal(keyword);
	if (
		keyword === 'VACUUM' &&
		sqliteTokens(sql).some((token) => token.kind === 'word' && token.text.toUpperCase() === 'INTO')
	) {
		return SQLITE_VACUUM_INTO_MESSAGE;
	}
	if (options.plan && keyword === 'EXPLAIN') return SQLITE_PLAN_OF_EXPLAIN_MESSAGE;
	return null;
}

/**
 * The text-only refusal a Query-mode run applies: the read-only allowlist
 * (`sqliteReadOnlyRefusal()`), or, with `options.editing`, the editing rules
 * (`sqliteEditingQueryRefusal()`). Shared by the panel (which refuses before
 * any process starts), the CLI, and the run itself.
 */
export function sqliteQueryRefusal(sql: string, options: SqliteRunOptions = {}): string | null {
	return options.editing
		? sqliteEditingQueryRefusal(sql, options)
		: sqliteReadOnlyRefusal(sql, options);
}

/**
 * Whether a statement SQLite has prepared would change the database when it
 * runs: the driver says it is not read-only (`stmt.readonly`), or its
 * leading keyword is not a read keyword (SQLite calls `REINDEX` read-only,
 * yet it rewrites indexes). An EXPLAIN never runs what it explains, so it
 * never writes, whatever SQLite says of it. Main uses this to send a run
 * with editing on to the write path (gate, backup, writable connection) or
 * the read-only one.
 */
export function isSqliteWriteStatement(sql: string, statementReadonly: boolean): boolean {
	const keyword = sqliteLeadingKeyword(sql);
	if (keyword === 'EXPLAIN') return false;
	return !statementReadonly || !isSqliteReadOnlyKeyword(keyword);
}

/**
 * A later window of a statement that changed the database. A window past the
 * first re-runs the statement, which would make the change again.
 */
export const SQLITE_WRITE_RERUN_MESSAGE =
	'A statement that changes the database runs once, so its later rows cannot be read again. Run it again to see a fresh result.';

/** A statement that changed the database was stopped (Stop, a newer run, the timeout). */
export const SQLITE_WRITE_STOPPED_MESSAGE =
	'The statement was stopped. A statement stopped before it finished changes nothing.';

/** Editing was locked while a statement that changes the database ran. */
export const SQLITE_WRITE_LOCKED_MESSAGE =
	'Editing was locked while the statement ran, so it was stopped. A statement stopped before it finished changes nothing.';

/** The database was closed (the tab closed, the idle reaper) while a statement that changes it ran. */
export const SQLITE_WRITE_CLOSED_MESSAGE =
	'The database was closed while the statement ran, so it was stopped. A statement stopped before it finished changes nothing.';

/** A statement that changes the database outlived `SQLITE_QUERY_TIMEOUT_MS` and was stopped. */
export function sqliteWriteTimeoutMessage(timeoutMs = SQLITE_QUERY_TIMEOUT_MS): string {
	return `The statement was stopped after ${Math.round(timeoutMs / 1000)} s. A statement stopped before it finished changes nothing.`;
}

/** Why the Plan toggle cannot explain a statement that is already an EXPLAIN. */
export const SQLITE_PLAN_OF_EXPLAIN_MESSAGE =
	'This statement is already an EXPLAIN, so it has no plan of its own. Turn Plan off to run it as written.';

/**
 * Why a statement will not run read-only, judged by its text alone, or null
 * when the text may go on to the driver. The driver can still refuse it
 * (`stmt.readonly` false, two statements); see `SQLITE_NOT_READ_ONLY_MESSAGE`.
 * With `plan`, the statement is judged as written (so planning a DELETE is
 * refused as a DELETE), and one that is already an EXPLAIN is refused too,
 * since SQLite cannot explain an EXPLAIN.
 */
export function sqliteReadOnlyRefusal(sql: string, options: SqliteRunOptions = {}): string | null {
	if (!sql.trim()) return 'Write a statement to run.';
	const keyword = sqliteLeadingKeyword(sql);
	if (isSqliteReadOnlyKeyword(keyword)) {
		return options.plan && keyword === 'EXPLAIN' ? SQLITE_PLAN_OF_EXPLAIN_MESSAGE : null;
	}
	const allowed = SQLITE_READ_ONLY_KEYWORDS.join(', ');
	if (keyword === 'ATTACH' || keyword === 'DETACH') {
		return `${keyword} opens or closes another database file, so it is refused here. Queries are read-only: ${allowed}.`;
	}
	if (!keyword)
		return `This does not start with a statement keyword. Queries start with ${allowed}.`;
	return `${keyword} is not a read-only statement. Queries here are read-only: ${allowed}.`;
}

/**
 * The text a run prepares: the statement, trimmed, behind
 * `EXPLAIN QUERY PLAN` when `plan` is set. Its parameters are the
 * statement's own, so they bind the same way either way.
 */
export function sqliteStatementToRun(sql: string, options: SqliteRunOptions = {}): string {
	const statement = sql.trim();
	return options.plan ? `EXPLAIN QUERY PLAN ${statement}` : statement;
}

/** The driver reported the statement would write (a write PRAGMA, `WITH ... DELETE`). */
export const SQLITE_NOT_READ_ONLY_MESSAGE =
	'This statement would change the database, so it is refused here. Queries are read-only until editing is enabled.';

/** `prepare()` found a second statement after the first. */
export const SQLITE_ONE_STATEMENT_MESSAGE =
	'Run one statement at a time: the text holds more than one.';

/** The run outlived `SQLITE_QUERY_TIMEOUT_MS` and was stopped. */
export function sqliteQueryTimeoutMessage(timeoutMs = SQLITE_QUERY_TIMEOUT_MS): string {
	return `The query was stopped after ${Math.round(timeoutMs / 1000)} s. Narrow it (a WHERE, a LIMIT) and run it again.`;
}

/** The run was stopped by the user, by a newer run, or by closing the database. */
export const SQLITE_QUERY_STOPPED_MESSAGE = 'The query was stopped.';

/** An export outlived `SQLITE_EXPORT_TIMEOUT_MS` and was stopped. */
export function sqliteExportTimeoutMessage(timeoutMs = SQLITE_EXPORT_TIMEOUT_MS): string {
	return `The export was stopped after ${Math.round(timeoutMs / 60_000)} min. Narrow the statement (a WHERE, a LIMIT) and export again.`;
}

/** An export was stopped by the user or by closing the database. */
export const SQLITE_EXPORT_STOPPED_MESSAGE = 'The export was stopped.';

/** A statement mixed `?` with `?NNN`; see `sqliteQueryParameters()`. */
export const SQLITE_MIXED_PARAMETERS_MESSAGE =
	'This statement mixes ? with numbered parameters (?1, ?2), which cannot be bound reliably. Number every parameter or none.';

/** The parameters a statement binds and anything that stops them binding. */
export interface SqliteQueryParameterScan {
	/** In order of first appearance, one per name. */
	parameters: SqliteQueryParameter[];
	/** Why the parameters cannot be bound as written, or null. */
	problem: string | null;
}

/**
 * The parameters a statement holds, read from its text the way SQLite's
 * tokenizer reads them (`sqliteTokens()`, shared with the error locator):
 * `?`, `?NNN`, and `:name`, `@name`, `$name`, `#name`,
 * skipping string literals, quoted names (`"..."`, `` `...` ``, `[...]`), and
 * comments. Shared by the Query panel (one value box per parameter, live as
 * the text changes), `maestro-cli sqlite query --param`, and the run itself,
 * which binds what this finds; the driver still checks the count, so a
 * statement this misreads fails with SQLite's own error rather than binding
 * the wrong value.
 *
 * A name used twice is one parameter. So are `:id` and `@id`: better-sqlite3
 * binds both from the same key. A bare `?` mixed with `?NNN` is reported as a
 * problem, because the driver binds bare values by position into the gaps
 * the numbered ones leave and would put a value where it was not meant.
 */
export function sqliteQueryParameters(sql: string): SqliteQueryParameterScan {
	const parameters: SqliteQueryParameter[] = [];
	const bindKeys = new Set<string>();
	const labels = new Set<string>();
	const numbered = new Set<number>();
	let anonymous = 0;
	let hasNumbered = false;
	for (const token of sqliteTokens(sql)) {
		if (token.kind !== 'parameter') continue;
		const label = token.text;
		if (label === '?') {
			anonymous++;
			const anonymousLabel = `?${anonymous}`;
			// Taken only by a `?NNN` in a statement that is refused anyway.
			if (!labels.has(anonymousLabel)) {
				labels.add(anonymousLabel);
				parameters.push({ label: anonymousLabel, anonymous: true });
			}
		} else if (label.startsWith('?')) {
			const position = Number(label.slice(1));
			hasNumbered = true;
			if (!numbered.has(position) && !bindKeys.has(label.slice(1)) && !labels.has(label)) {
				numbered.add(position);
				bindKeys.add(label.slice(1));
				labels.add(label);
				parameters.push({ label, anonymous: false });
			}
		} else if (!bindKeys.has(label.slice(1))) {
			bindKeys.add(label.slice(1));
			parameters.push({ label, anonymous: false });
		}
	}
	const problem = anonymous > 0 && hasNumbered ? SQLITE_MIXED_PARAMETERS_MESSAGE : null;
	return { parameters, problem };
}

/**
 * The value a typed value binds as, or why it cannot bind: TEXT as is, NULL,
 * or a number (an integer exactly, a `bigint` past 2^53, or a double). A
 * number SQLite could not hold as written (past the 64-bit integer range,
 * too large, or more digits than a REAL keeps) is refused rather than bound
 * rounded (`sqliteNumberTextProblem()`).
 * `label` names it in the problem: a parameter (`:id`) or a column. Shared by
 * the Query panel's parameters and the table view's cell edit.
 */
export function sqliteParameterBindValue(
	label: string,
	value: SqliteParameterValue | null | undefined
): { value: SqliteBindValue } | { problem: string } {
	if (!value || typeof value !== 'object' || typeof value.text !== 'string') {
		return { problem: `Give ${label} a value.` };
	}
	if (value.type === 'null') return { value: null };
	if (value.type === 'text') return { value: value.text };
	if (value.type !== 'number') {
		return { problem: `${label} has an unknown type; use text, number, or null.` };
	}
	const number = sqliteNumberBindValue(value.text.trim());
	if (number === null) {
		const shown = value.text.trim() ? `"${value.text}" is not a number` : 'it is empty';
		return { problem: `${label} is set to Number, but ${shown}.` };
	}
	const inexact = sqliteNumberTextProblem(value.text.trim());
	if (inexact) return { problem: `${label} is set to Number, but ${inexact}` };
	return { value: number };
}

/** What a statement's parameters bind as: driver arguments, or why they cannot bind. */
export type SqliteQueryBinding =
	| { args: Array<SqliteBindValue[] | Record<string, SqliteBindValue>>; problem: null }
	| { args: null; problem: string };

/**
 * The arguments that bind `values` to the parameters of `sql`, in the shape
 * better-sqlite3 takes them: an array for bare `?` values in order, an
 * object for named and numbered ones keyed by the name without its sigil.
 * Never splices a value into the text. `problem` is set, and nothing binds,
 * when a parameter has no value, a Number value is not a number, or the
 * statement mixes `?` with `?NNN`. Used by the run (which refuses on a
 * problem) and by the Query panel (which shows the problem without starting
 * a process).
 */
export function sqliteQueryBinding(
	sql: string,
	values: SqliteParameterValues | null | undefined
): SqliteQueryBinding {
	const scan = sqliteQueryParameters(sql);
	if (scan.problem) return { args: null, problem: scan.problem };
	const source = values && typeof values === 'object' ? values : {};
	const positional: SqliteBindValue[] = [];
	// No prototype, so a parameter called `:__proto__` is just a key.
	const named: Record<string, SqliteBindValue> = Object.create(null);
	for (const parameter of scan.parameters) {
		const given = Object.prototype.hasOwnProperty.call(source, parameter.label)
			? source[parameter.label]
			: undefined;
		const bound = sqliteParameterBindValue(parameter.label, given);
		if ('problem' in bound) return { args: null, problem: bound.problem };
		if (parameter.anonymous) positional.push(bound.value);
		else named[parameter.label.slice(1)] = bound.value;
	}
	const args: Array<SqliteBindValue[] | Record<string, SqliteBindValue>> = [];
	if (positional.length > 0) args.push(positional);
	if (Object.keys(named).length > 0) args.push(named);
	return { args, problem: null };
}
