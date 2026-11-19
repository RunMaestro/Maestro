import { describe, expect, it } from 'vitest';

import {
	SQLITE_NOT_READ_ONLY_MESSAGE,
	SQLITE_ONE_STATEMENT_MESSAGE,
	SQLITE_PLAN_OF_EXPLAIN_MESSAGE,
	sqliteReadOnlyRefusal,
} from '../../../shared/sqlite/query';
import {
	formatSqliteQueryErrorExcerpt,
	formatSqliteQueryErrorPlace,
	splitSqliteErrorOffset,
	sqliteQueryErrorLocation,
	sqliteSyntaxErrorOffset,
	sqliteSyntaxErrorToken,
	withSqliteErrorOffset,
} from '../../../shared/sqlite/queryError';

/** The text a location covers, so a case reads as what is underlined. */
function marked(sql: string, message: string, offset?: number | null): string | null {
	const location = sqliteQueryErrorLocation(sql, message, offset);
	return location ? sql.slice(location.from, location.to) : null;
}

describe('sqliteSyntaxErrorToken', () => {
	it("reads the token from SQLite's syntax error, quotes inside it kept", () => {
		expect(sqliteSyntaxErrorToken('near "FORM": syntax error')).toBe('FORM');
		expect(sqliteSyntaxErrorToken('near ""a b"": syntax error')).toBe('"a b"');
		expect(sqliteSyntaxErrorToken('no such table: t')).toBeNull();
	});
});

describe('sqliteSyntaxErrorOffset', () => {
	/** A parser stand-in: text running past `errorAt` holds the error. */
	const parserFailingAt = (errorAt: number, asked: string[] = []) => {
		return (prefix: string) => {
			asked.push(prefix);
			return prefix.length <= errorAt;
		};
	};

	it('takes the only occurrence without asking', () => {
		const asked: string[] = [];
		const sql = 'SELECT * FORM t';
		expect(
			sqliteSyntaxErrorOffset(sql, 'near "FORM": syntax error', parserFailingAt(9, asked))
		).toBe(9);
		expect(asked).toEqual([]);
	});

	it('finds the occurrence SQLite stopped at among many, by bisection', () => {
		const sql = 'SELECT f(a), f(b), f(c), f(d) FROM t WHERE x IN (1, 2,)';
		const errorAt = sql.lastIndexOf(')');
		const asked: string[] = [];
		expect(
			sqliteSyntaxErrorOffset(sql, 'near ")": syntax error', parserFailingAt(errorAt, asked))
		).toBe(errorAt);
		// Five candidates: a bisection asks about three at most.
		expect(asked.length).toBeLessThanOrEqual(3);

		const early = sql.indexOf(')');
		expect(sqliteSyntaxErrorOffset(sql, 'near ")": syntax error', parserFailingAt(early))).toBe(
			early
		);
	});

	it('ignores the token inside strings and comments', () => {
		const sql = "SELECT ',' /* , */ AS c, id, FROM t";
		expect(
			sqliteSyntaxErrorOffset(sql, 'near "FROM": syntax error', parserFailingAt(sql.length))
		).toBe(sql.indexOf('FROM'));
	});

	it('answers null for another error or a token not in the text', () => {
		expect(sqliteSyntaxErrorOffset('SELECT 1', 'no such table: t', () => true)).toBeNull();
		expect(sqliteSyntaxErrorOffset('SELECT 1', 'near "x": syntax error', () => true)).toBeNull();
	});
});

describe('sqliteQueryErrorLocation', () => {
	it('places a syntax error at the offset SQLite found, else at the first occurrence', () => {
		const sql = 'SELECT a = = 1, b = 2';
		const second = sql.indexOf('=', sql.indexOf('=') + 1);
		expect(sqliteQueryErrorLocation(sql, 'near "=": syntax error', second)).toEqual({
			from: second,
			to: second + 1,
			line: 1,
			column: second + 1,
		});
		expect(sqliteQueryErrorLocation(sql, 'near "=": syntax error')?.from).toBe(sql.indexOf('='));
	});

	it('counts lines and columns from the start of the statement', () => {
		const sql = 'SELECT\n\tid,\n\tFROM t';
		expect(sqliteQueryErrorLocation(sql, 'near "FROM": syntax error')).toMatchObject({
			line: 3,
			column: 2,
		});
	});

	it('places an unreadable token and input that ends too soon', () => {
		expect(marked("SELECT 'abc FROM t", 'unrecognized token: "\'abc FROM t"')).toBe("'abc FROM t");
		expect(marked('SELECT 1abc', 'unrecognized token: "1abc"')).toBe('1abc');
		expect(marked('SELECT * FROM t WHERE  ', 'incomplete input')).toBe('WHERE');
	});

	it('finds a missing table, column, or function by its name, qualified or quoted', () => {
		expect(marked('SELECT * FROM nosuch', 'no such table: nosuch')).toBe('nosuch');
		expect(marked('SELECT * FROM main.nosuch', 'no such table: main.nosuch')).toBe('main.nosuch');
		expect(marked('SELECT EMIAL FROM users', 'no such column: emial')).toBe('EMIAL');
		expect(marked('SELECT email, u.emial FROM users u', 'no such column: u.emial')).toBe('u.emial');
		expect(marked('SELECT "u"."emial" FROM users u', 'no such column: u.emial')).toBe(
			'"u"."emial"'
		);
		expect(marked('SELECT "first name" FROM t', 'no such column: first name')).toBe('"first name"');
		expect(
			marked(
				'SELECT * FROM t WHERE email = "a@b"',
				'no such column: "a@b" - should this be a string literal in single-quotes?'
			)
		).toBe('"a@b"');
		expect(marked('SELECT email FROM a JOIN b', 'ambiguous column name: email')).toBe('email');
		// A call, not the same word used as a name.
		expect(marked('SELECT nofn AS x, nofn(1) FROM t', 'no such function: nofn')).toBe('nofn');
		expect(
			sqliteQueryErrorLocation('SELECT nofn AS x, nofn(1) FROM t', 'no such function: nofn')?.from
		).toBe(18);
		expect(marked('SELECT substr() FROM t', 'wrong number of arguments to function substr()')).toBe(
			'substr'
		);
		expect(marked('SELECT 1 WHERE count(*) > 1', 'misuse of aggregate: count()')).toBe('count');
		expect(marked('SELECT 1 WHERE max(x) > 1', 'misuse of aggregate function max()')).toBe('max');
	});

	it("places this module's own refusals", () => {
		const write = 'DELETE FROM users';
		expect(marked(write, sqliteReadOnlyRefusal(write)!)).toBe('DELETE');
		const explain = 'EXPLAIN SELECT 1';
		expect(marked(explain, SQLITE_PLAN_OF_EXPLAIN_MESSAGE)).toBe('EXPLAIN');
		expect(marked('WITH x AS (SELECT 1) DELETE FROM t', SQLITE_NOT_READ_ONLY_MESSAGE)).toBe(
			'DELETE'
		);
		expect(marked('SELECT 1; SELECT 2 FROM t', SQLITE_ONE_STATEMENT_MESSAGE)).toBe(
			'SELECT 2 FROM t'
		);
	});

	it('answers null for an error that names no place', () => {
		expect(sqliteQueryErrorLocation('SELECT 1', 'integer overflow')).toBeNull();
		expect(sqliteQueryErrorLocation('SELECT 1', 'The query was stopped.')).toBeNull();
		expect(
			sqliteQueryErrorLocation('PRAGMA user_version = 3', SQLITE_NOT_READ_ONLY_MESSAGE)
		).toBeNull();
		expect(sqliteQueryErrorLocation('-- only a comment', 'incomplete input')).toBeNull();
		expect(sqliteQueryErrorLocation('SELECT x FROM t', 'no such table: other')).toBeNull();
	});
});

describe('formatting a location', () => {
	it('names the place, and draws the line with carets under the span', () => {
		const sql = 'SELECT id\n\tFROM users WHERE id IN (1, 2,)';
		const location = sqliteQueryErrorLocation(sql, 'near ")": syntax error', sql.lastIndexOf(')'))!;
		expect(formatSqliteQueryErrorPlace(location)).toBe('Line 2, column 31');
		expect(formatSqliteQueryErrorExcerpt(sql, location)).toEqual([
			'  \tFROM users WHERE id IN (1, 2,)',
			`  \t${' '.repeat(29)}^`,
		]);
	});

	it('underlines a span that runs past its line only to the line end', () => {
		const sql = "SELECT 'abc\nFROM t";
		const location = sqliteQueryErrorLocation(sql, 'unrecognized token: "\'abc\nFROM t"')!;
		expect(formatSqliteQueryErrorExcerpt(sql, location, '')).toEqual([
			"SELECT 'abc",
			'       ^^^^',
		]);
	});
});

describe('the offset on the wire', () => {
	it('rides on the message and comes back off it', () => {
		const text = withSqliteErrorOffset('near "=": syntax error', 12);
		expect(text).not.toBe('near "=": syntax error');
		expect(splitSqliteErrorOffset(text)).toEqual({ message: 'near "=": syntax error', offset: 12 });
	});

	it('leaves a message with no offset as it is', () => {
		expect(withSqliteErrorOffset('no such table: t', null)).toBe('no such table: t');
		expect(withSqliteErrorOffset('no such table: t', -1)).toBe('no such table: t');
		expect(splitSqliteErrorOffset('no such table: t')).toEqual({
			message: 'no such table: t',
			offset: null,
		});
	});
});
