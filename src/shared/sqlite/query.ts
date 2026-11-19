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

import { sqliteNumberBindValue, type SqliteBindValue } from './filter';
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

/** The value one parameter binds as, or why it cannot bind. */
function parameterBindValue(
	parameter: SqliteQueryParameter,
	value: SqliteParameterValue | undefined
): { value: SqliteBindValue } | { problem: string } {
	if (!value || typeof value !== 'object' || typeof value.text !== 'string') {
		return { problem: `Give ${parameter.label} a value.` };
	}
	if (value.type === 'null') return { value: null };
	if (value.type === 'text') return { value: value.text };
	if (value.type !== 'number') {
		return { problem: `${parameter.label} has an unknown type; use text, number, or null.` };
	}
	const number = sqliteNumberBindValue(value.text.trim());
	if (number === null) {
		const shown = value.text.trim() ? `"${value.text}" is not a number` : 'it is empty';
		return { problem: `${parameter.label} is set to Number, but ${shown}.` };
	}
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
		const bound = parameterBindValue(parameter, given);
		if ('problem' in bound) return { args: null, problem: bound.problem };
		if (parameter.anonymous) positional.push(bound.value);
		else named[parameter.label.slice(1)] = bound.value;
	}
	const args: Array<SqliteBindValue[] | Record<string, SqliteBindValue>> = [];
	if (positional.length > 0) args.push(positional);
	if (Object.keys(named).length > 0) args.push(named);
	return { args, problem: null };
}
