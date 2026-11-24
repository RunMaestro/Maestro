/**
 * SQLite statement text, split into tokens the way SQLite's own tokenizer
 * splits it: words (keywords and bare names), quoted names, string and BLOB
 * literals, numbers, parameters, and operators, with whitespace and comments
 * dropped.
 *
 * Shared by the parameter scan (`sqliteQueryParameters()`, which binds what
 * it finds) and the error locator (`sqliteQueryErrorLocation()`, which finds
 * the token an error names), so both read a statement the same way. It does
 * not parse: a token stream is all either needs.
 */

/** What one token is. */
export type SqliteTokenKind =
	/** A keyword or a bare name: `SELECT`, `users`, `price$usd`. */
	| 'word'
	/** A quoted name: `"user name"`, `` `id` ``, `[order]`. */
	| 'quoted'
	/** A string literal: `'it''s'`. */
	| 'string'
	/** A BLOB literal: `x'00ff'`. */
	| 'blob'
	/** A number, or a run starting with a digit that SQLite cannot read as one (`1abc`). */
	| 'number'
	/** `?`, `?NNN`, `:name`, `@name`, `$name`, `#name`. */
	| 'parameter'
	/** An operator or punctuation: `(`, `,`, `;`, `.`, `=`, `<>`, `||`, `->>`. */
	| 'symbol';

/** One token: its kind and where it sits in the text, as UTF-16 offsets. */
export interface SqliteToken {
	kind: SqliteTokenKind;
	/** First character of the token. */
	from: number;
	/** One past its last character. */
	to: number;
	/** The token as written, quotes included. */
	text: string;
}

/** Whether a character may sit inside a SQLite identifier or parameter name. */
export function isSqliteIdChar(char: string): boolean {
	return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80;
}

/** Where the quoted run starting at `start` ends (past its closing quote, or the text's end). */
export function skipSqliteQuoted(sql: string, start: number, close: string): number {
	let index = start + 1;
	while (index < sql.length) {
		if (sql[index] === close) {
			// A doubled quote escapes itself; `[...]` has no escape.
			if (close !== ']' && sql[index + 1] === close) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index++;
	}
	return sql.length;
}

/** Operators SQLite reads as one token, longest first. */
const MULTI_CHAR_SYMBOLS = ['->>', '->', '||', '<<', '>>', '<=', '>=', '<>', '==', '!='];

/** Where a number starting at `start` ends, letters stuck to it included. */
function numberEnd(sql: string, start: number): number {
	let index = start;
	if (sql[index] === '0' && /[xX]/.test(sql[index + 1] ?? '')) {
		index += 2;
		while (index < sql.length && /[0-9A-Fa-f_]/.test(sql[index])) index++;
	} else {
		while (index < sql.length && /[0-9_]/.test(sql[index])) index++;
		if (sql[index] === '.') {
			index++;
			while (index < sql.length && /[0-9_]/.test(sql[index])) index++;
		}
		if (/[eE]/.test(sql[index] ?? '') && /[0-9+-]/.test(sql[index + 1] ?? '')) {
			index += 2;
			while (index < sql.length && /[0-9_]/.test(sql[index])) index++;
		}
	}
	// SQLite reads `1abc` as one bad token, not a number then a name.
	while (index < sql.length && isSqliteIdChar(sql[index])) index++;
	return index;
}

/** The token starting at `index`, which is not whitespace and not a comment. */
function tokenAt(sql: string, index: number): { kind: SqliteTokenKind; end: number } {
	const char = sql[index];
	const next = sql[index + 1] ?? '';
	if (char === "'") return { kind: 'string', end: skipSqliteQuoted(sql, index, "'") };
	if (char === '"' || char === '`') {
		return { kind: 'quoted', end: skipSqliteQuoted(sql, index, char) };
	}
	if (char === '[') return { kind: 'quoted', end: skipSqliteQuoted(sql, index, ']') };
	if ((char === 'x' || char === 'X') && next === "'") {
		return { kind: 'blob', end: skipSqliteQuoted(sql, index + 1, "'") };
	}
	if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next))) {
		return { kind: 'number', end: numberEnd(sql, index) };
	}
	if (char === '?') {
		let end = index + 1;
		while (end < sql.length && /[0-9]/.test(sql[end])) end++;
		return { kind: 'parameter', end };
	}
	if (char === ':' || char === '@' || char === '$' || char === '#') {
		// A run of name characters, as SQLite reads it. The bundled SQLite
		// omits Tcl variables, so `$a::b` is `$a` and then a syntax error.
		let end = index + 1;
		while (end < sql.length && isSqliteIdChar(sql[end])) end++;
		if (end > index + 1) return { kind: 'parameter', end };
		return { kind: 'symbol', end: index + 1 };
	}
	if (isSqliteIdChar(char)) {
		// A whole word, so the `$` in `price$usd` is not read as a parameter.
		let end = index + 1;
		while (end < sql.length && isSqliteIdChar(sql[end])) end++;
		return { kind: 'word', end };
	}
	const symbol = MULTI_CHAR_SYMBOLS.find((candidate) => sql.startsWith(candidate, index));
	return { kind: 'symbol', end: index + (symbol?.length ?? 1) };
}

/**
 * The tokens of `sql`, in order, without whitespace or comments (`--` to the
 * end of the line, `/* ... *\/`). An unterminated quote or comment runs to the
 * end of the text, as SQLite reads it.
 */
export function sqliteTokens(sql: string): SqliteToken[] {
	const tokens: SqliteToken[] = [];
	let index = 0;
	while (index < sql.length) {
		const char = sql[index];
		if (/\s/.test(char)) {
			index++;
		} else if (char === '-' && sql[index + 1] === '-') {
			const newline = sql.indexOf('\n', index);
			index = newline === -1 ? sql.length : newline + 1;
		} else if (char === '/' && sql[index + 1] === '*') {
			const end = sql.indexOf('*/', index + 2);
			index = end === -1 ? sql.length : end + 2;
		} else {
			const { kind, end } = tokenAt(sql, index);
			tokens.push({ kind, from: index, to: end, text: sql.slice(index, end) });
			index = end;
		}
	}
	return tokens;
}

/**
 * The name a word or quoted-name token stands for: a word as written, a
 * quoted one without its quotes (a doubled quote read as one). Null for any
 * other token.
 */
export function sqliteTokenName(token: SqliteToken): string | null {
	if (token.kind === 'word') return token.text;
	if (token.kind !== 'quoted') return null;
	const open = token.text[0];
	const close = open === '[' ? ']' : open;
	const inner =
		token.text.endsWith(close) && token.text.length > 1
			? token.text.slice(1, -1)
			: token.text.slice(1);
	return open === '[' ? inner : inner.split(close + close).join(close);
}
