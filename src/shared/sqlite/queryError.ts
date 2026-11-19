/**
 * Where in a statement a Query-mode error points.
 *
 * SQLite's errors name what went wrong (`near "FORM": syntax error`,
 * `no such column: emial`) but better-sqlite3 does not pass on where. This
 * finds it in the statement's text, so the Query panel can underline the
 * token in the editor and `maestro-cli sqlite query` can print the line with
 * a caret under it, rather than leave the person to hunt for it.
 *
 * A syntax error names a token that may appear more than once (`,`, `)`,
 * `=`). For that one case SQLite itself is asked: `sqliteSyntaxErrorOffset()`
 * prepares the text before each candidate, which the child process running
 * the statement does on its own connection (sqlite-query-task.ts), and the
 * offset it finds rides back with the error. Every other error is placed
 * from its words and the text alone, by `sqliteQueryErrorLocation()`.
 *
 * The offset crosses Electron IPC, which keeps only an error's message, as a
 * suffix on that message (`withSqliteErrorOffset()` /
 * `splitSqliteErrorOffset()`). That suffix is a wire format: never build or
 * parse it anywhere else.
 */

import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	sqliteReadOnlyRefusal,
} from './query';
import { sqliteTokenName, sqliteTokens, type SqliteToken } from './tokens';

/** The span of a statement an error points at, and where it starts as a person counts. */
export interface SqliteQueryErrorLocation {
	/** First character, as a UTF-16 offset into the statement. */
	from: number;
	/** One past the last character; always past `from`. */
	to: number;
	/** 1-based line `from` sits on. */
	line: number;
	/** 1-based column of `from` on that line. */
	column: number;
}

/** SQLite's words for a syntax error at one token. */
const NEAR_SYNTAX_ERROR = /^near "([\s\S]*)": syntax error$/;
/** A token SQLite cannot read at all (an unclosed quote, `1abc`, `!`). */
const UNRECOGNIZED_TOKEN = /^unrecognized token: "([\s\S]*)"$/;
/** The statement ended where SQLite expected more. */
const INCOMPLETE_INPUT = /^incomplete input$/;

/** Errors that name a table, column, or other object, and whether it is called like a function. */
const NAMED_OBJECT_ERRORS: Array<{ pattern: RegExp; call: boolean }> = [
	{ pattern: /^no such table: ([\s\S]+)$/, call: false },
	// A double-quoted string where SQLite (built without double-quoted
	// string literals) reads a name: the quotes and the hint are SQLite's.
	{
		pattern: /^no such column: "([\s\S]*)" - should this be a string literal in single-quotes\?$/,
		call: false,
	},
	{ pattern: /^no such column: ([\s\S]+)$/, call: false },
	{ pattern: /^ambiguous column name: ([\s\S]+)$/, call: false },
	{ pattern: /^no such index: ([\s\S]+)$/, call: false },
	{ pattern: /^no such collation sequence: ([\s\S]+)$/, call: false },
	{ pattern: /^no such window: ([\s\S]+)$/, call: false },
	{ pattern: /^no such function: ([\s\S]+)$/, call: true },
	{ pattern: /^wrong number of arguments to function ([\s\S]+)\(\)$/, call: true },
	{ pattern: /^misuse of aggregate(?: function)?:? ([\s\S]+)\(\)$/, call: true },
	{ pattern: /^misuse of window function ([\s\S]+)\(\)$/, call: true },
];

/** Keywords that make a statement write, for the "would change the database" refusal. */
const WRITE_KEYWORDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

/** The token a syntax error names (`near "X": syntax error`), or null for any other error. */
export function sqliteSyntaxErrorToken(message: string): string | null {
	return NEAR_SYNTAX_ERROR.exec(message.trim())?.[1] ?? null;
}

/**
 * Where the token a syntax error names sits in `sql`, asking SQLite which of
 * its occurrences it stopped at. `parsesSoFar(prefix)` must say whether the
 * text before a point holds no syntax error yet (it prepares, ends early, or
 * fails for a reason other than syntax). Every prefix up to the failing token
 * does and every longer one does not, so the error sits at the last
 * occurrence whose prefix still parses, found by bisection: a handful of
 * prepares, never one per occurrence. Null when the message is not a syntax
 * error or the token is not in the text.
 */
export function sqliteSyntaxErrorOffset(
	sql: string,
	message: string,
	parsesSoFar: (prefix: string) => boolean
): number | null {
	const token = sqliteSyntaxErrorToken(message);
	if (token === null) return null;
	const candidates = sqliteTokens(sql).filter((candidate) => candidate.text === token);
	if (candidates.length === 0) return null;
	let low = 0;
	let high = candidates.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (parsesSoFar(sql.slice(0, candidates[middle].from))) low = middle;
		else high = middle - 1;
	}
	return candidates[low].from;
}

/** Where a span starts, as a person counts lines and columns. */
function locate(sql: string, from: number, to: number): SqliteQueryErrorLocation {
	const before = sql.slice(0, from);
	const lineStart = before.lastIndexOf('\n') + 1;
	return {
		from,
		to: Math.max(to, from + 1),
		line: before.split('\n').length,
		column: from - lineStart + 1,
	};
}

function spanOf(sql: string, first: SqliteToken, last: SqliteToken = first) {
	return locate(sql, first.from, last.to);
}

function sameName(token: SqliteToken | undefined, name: string): boolean {
	const tokenName = token ? sqliteTokenName(token) : null;
	return tokenName !== null && tokenName.toLowerCase() === name.toLowerCase();
}

/**
 * The first place `name` is written as a name: `a.b` as the tokens `a . b`,
 * and, with `call`, followed by `(`. Falls back to the whole text as one
 * (quoted) name, then to its last part alone.
 */
function findName(
	sql: string,
	tokens: SqliteToken[],
	name: string,
	call: boolean
): SqliteQueryErrorLocation | null {
	const attempts = [name.split('.'), [name], [name.split('.').pop() ?? name]];
	for (const parts of attempts) {
		for (let start = 0; start < tokens.length; start++) {
			let end = start;
			let matched = true;
			for (let part = 0; part < parts.length; part++) {
				if (part > 0) {
					if (tokens[end + 1]?.text !== '.') {
						matched = false;
						break;
					}
					end += 2;
				}
				if (!sameName(tokens[end], parts[part])) {
					matched = false;
					break;
				}
			}
			if (matched && (!call || tokens[end + 1]?.text === '(')) {
				return spanOf(sql, tokens[start], tokens[end]);
			}
		}
	}
	return call ? findName(sql, tokens, name, false) : null;
}

/**
 * The span of `sql` that `message` (a run's error, as `splitSqliteErrorOffset()`
 * leaves it) points at, or null when it names no place: a timeout, a Stop, a
 * runtime error such as an integer overflow. `offset` is the one SQLite found
 * for a syntax error (see `sqliteSyntaxErrorOffset()`); without it the first
 * occurrence of the named token is taken.
 *
 * Placed: syntax errors (the token), an unreadable token, input that ends too
 * soon (the last token), a missing table, column, index, collation, window,
 * or function, an ambiguous column, a misused aggregate, and this module's
 * own refusals (the keyword that is not read-only, the write inside a `WITH`,
 * the second statement).
 */
export function sqliteQueryErrorLocation(
	sql: string,
	message: string,
	offset?: number | null
): SqliteQueryErrorLocation | null {
	const text = message.trim();
	const tokens = sqliteTokens(sql);
	if (tokens.length === 0) return null;

	const syntaxToken = sqliteSyntaxErrorToken(text);
	if (syntaxToken !== null) {
		const at =
			typeof offset === 'number' ? tokens.find((token) => token.from === offset) : undefined;
		const token = at ?? tokens.find((candidate) => candidate.text === syntaxToken);
		return token ? spanOf(sql, token) : null;
	}

	const unrecognized = UNRECOGNIZED_TOKEN.exec(text)?.[1];
	if (unrecognized !== undefined) {
		const token = tokens.find((candidate) => candidate.text === unrecognized);
		if (token) return spanOf(sql, token);
		const index = unrecognized ? sql.indexOf(unrecognized) : -1;
		return index === -1 ? null : locate(sql, index, index + unrecognized.length);
	}

	if (INCOMPLETE_INPUT.test(text)) return spanOf(sql, tokens[tokens.length - 1]);

	for (const { pattern, call } of NAMED_OBJECT_ERRORS) {
		const name = pattern.exec(text)?.[1];
		if (name !== undefined) return findName(sql, tokens, name, call);
	}

	if (text === SQLITE_ONE_STATEMENT_MESSAGE) {
		const end = tokens.findIndex((token, index) => token.text === ';' && index < tokens.length - 1);
		return end === -1 ? null : spanOf(sql, tokens[end + 1], tokens[tokens.length - 1]);
	}
	if (text === SQLITE_NOT_READ_ONLY_MESSAGE) {
		const write = tokens.find(
			(token) => token.kind === 'word' && WRITE_KEYWORDS.has(token.text.toUpperCase())
		);
		return write ? spanOf(sql, write) : null;
	}
	if (text === sqliteReadOnlyRefusal(sql) || text === sqliteReadOnlyRefusal(sql, { plan: true })) {
		return spanOf(sql, tokens[0]);
	}
	return null;
}

/** Where a location starts, in words: `Line 2, column 7`. */
export function formatSqliteQueryErrorPlace(location: SqliteQueryErrorLocation): string {
	return `Line ${location.line}, column ${location.column}`;
}

/**
 * The statement's line holding the error, with carets under the span, for a
 * terminal: two lines, indented by `indent`. Whitespace before the span is
 * copied (a tab stays a tab), so the carets line up however the terminal
 * draws tabs. A span that runs past its line is underlined to the line's end.
 */
export function formatSqliteQueryErrorExcerpt(
	sql: string,
	location: SqliteQueryErrorLocation,
	indent = '  '
): string[] {
	const lineStart = location.from - (location.column - 1);
	const newline = sql.indexOf('\n', lineStart);
	const lineEnd = newline === -1 ? sql.length : newline;
	const line = sql.slice(lineStart, lineEnd).replace(/\r$/, '');
	const lead = line.slice(0, location.column - 1).replace(/\S/g, ' ');
	const width = Math.max(1, Math.min(location.to, lineStart + line.length) - location.from);
	return [`${indent}${line}`, `${indent}${lead}${'^'.repeat(width)}`];
}

/** The suffix that carries a syntax error's offset on its message across IPC. */
const OFFSET_SUFFIX = /\n\[at character (\d+)\]$/;

/**
 * An error's message with the offset SQLite stopped at appended, for a hop
 * that keeps only the message (Electron IPC). The message is returned as it
 * is when there is no offset. Read back with `splitSqliteErrorOffset()`.
 */
export function withSqliteErrorOffset(message: string, offset: number | null | undefined): string {
	return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0
		? `${message}\n[at character ${offset}]`
		: message;
}

/** A message from `withSqliteErrorOffset()` split back into the message and its offset. */
export function splitSqliteErrorOffset(text: string): { message: string; offset: number | null } {
	const match = OFFSET_SUFFIX.exec(text);
	if (!match) return { message: text, offset: null };
	return { message: text.slice(0, match.index), offset: Number(match[1]) };
}
