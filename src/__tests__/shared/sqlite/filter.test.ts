import { describe, expect, it } from 'vitest';

import {
	SQLITE_REGEXP_FUNCTION,
	bindSqliteFilter,
	buildSqliteFilter,
	compileSqliteFilter,
	escapeSqliteLikePattern,
	sqliteFilterParam,
	sqliteRegexpTest,
	type SqliteFilterColumn,
} from '../../../shared/sqlite/filter';

const COLUMNS: SqliteFilterColumn[] = [
	{ name: 'id', affinity: 'INTEGER' },
	{ name: 'name', affinity: 'TEXT' },
	{ name: 'price', affinity: 'REAL' },
	{ name: 'created_at', affinity: 'NUMERIC' },
	{ name: 'extra', affinity: 'BLOB' },
	{ name: 'order id', affinity: 'INTEGER' },
];

const LIKE = "LIKE ? ESCAPE '\\'";
const text = (column: string) =>
	`CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) ELSE CAST(${column} AS TEXT) END`;

function build(source: string) {
	const result = buildSqliteFilter(source, COLUMNS);
	if (result.problem) throw new Error(`unexpected problem: ${result.problem.message}`);
	if (!result.compiled) throw new Error('expected a compiled filter');
	return result.compiled;
}

describe('buildSqliteFilter', () => {
	it('compiles empty text to no filter', () => {
		expect(buildSqliteFilter('   ', COLUMNS)).toEqual({ compiled: null });
	});

	it('returns the binder problem, with its span and suggestion, instead of SQL', () => {
		const result = buildSqliteFilter('nmae = bob', COLUMNS);
		expect(result.compiled).toBeNull();
		expect(result.problem).toMatchObject({
			message: 'No column "nmae". Did you mean "name"?',
			start: 0,
			end: 4,
			suggestion: 'name',
		});
		expect(buildSqliteFilter('name = "open', COLUMNS).problem?.message).toBe('Unterminated string');
	});

	it('never puts a typed value into the SQL text', () => {
		const { where, params } = build(`name = "x'; DROP TABLE users; --" or id = "1; DELETE FROM t"`);
		expect(where).toBe('("name" = ? OR "id" = ?)');
		expect(params).toEqual(["x'; DROP TABLE users; --", '1; DELETE FROM t']);
	});

	it('quotes column names as identifiers, including bracketed names with spaces', () => {
		const { where, params } = build('[order id] = 42');
		expect(where).toBe('"order id" = ?');
		expect(params).toEqual(['42']);
	});

	it('resolves a column case-insensitively to its real name', () => {
		expect(build('NAME = ada').where).toBe('"name" = ?');
	});
});

describe('compileSqliteFilter: comparisons', () => {
	it('maps each operator and binds the literal', () => {
		expect(build('id = 1')).toEqual({ where: '"id" = ?', params: ['1'] });
		expect(build('id != 1').where).toBe('"id" != ?');
		expect(build('id > 1').where).toBe('"id" > ?');
		expect(build('id >= 1').where).toBe('"id" >= ?');
		expect(build('id < 1').where).toBe('"id" < ?');
		expect(build('id <= 1').where).toBe('"id" <= ?');
	});

	it('spells `= null` and `!= null` as IS NULL tests, and ordering against null as false', () => {
		expect(build('name = null')).toEqual({ where: '"name" IS NULL', params: [] });
		expect(build('name != null')).toEqual({ where: '"name" IS NOT NULL', params: [] });
		expect(build('id > null')).toEqual({ where: '0', params: [] });
		expect(build('name is null').where).toBe('"name" IS NULL');
		expect(build('name is not null').where).toBe('"name" IS NOT NULL');
	});

	it('binds IN and BETWEEN values, with a null in the list becoming IS NULL', () => {
		expect(build('id in (1, 2, 3)')).toEqual({
			where: '"id" IN (?, ?, ?)',
			params: ['1', '2', '3'],
		});
		expect(build('name in (a, null)')).toEqual({
			where: '("name" IN (?) OR "name" IS NULL)',
			params: ['a'],
		});
		expect(build('name in (null)').where).toBe('"name" IS NULL');
		expect(build('price between 1 and 9.5')).toEqual({
			where: '"price" BETWEEN ? AND ?',
			params: ['1', '9.5'],
		});
	});

	it('joins and / or with parentheses and keeps their order of bindings', () => {
		expect(build('id > 1 and (name = a or name = b)')).toEqual({
			where: '("id" > ? AND ("name" = ? OR "name" = ?))',
			params: ['1', 'a', 'b'],
		});
	});
});

describe('compileSqliteFilter: null semantics under NOT', () => {
	it('wraps leaves under a NOT so a NULL counts as false, like the Parquet evaluator', () => {
		expect(build('not id > 5').where).toBe('NOT (ifnull("id" > ?, 0))');
		expect(build('not (id > 5 or name = a)').where).toBe(
			'NOT ((ifnull("id" > ?, 0) OR ifnull("name" = ?, 0)))'
		);
	});

	it('leaves a positive predicate bare, so SQLite can still use an index', () => {
		expect(build('id = 5').where).not.toContain('ifnull');
	});

	it('compiles `not in` as a NOT over the two-valued membership test, keeping NULL rows', () => {
		expect(build('name not in (a, b)')).toEqual({
			where: 'NOT (ifnull("name" IN (?, ?), 0))',
			params: ['a', 'b'],
		});
		expect(build('name not in (a, null)').where).toBe(
			'NOT (ifnull(("name" IN (?) OR "name" IS NULL), 0))'
		);
	});
});

describe('compileSqliteFilter: text matching', () => {
	it('matches contains, starts with, and ends with through LIKE with an escape', () => {
		expect(build('name ~ Smith')).toEqual({
			where: `${text('"name"')} ${LIKE}`,
			params: ['%smith%'],
		});
		expect(build('name ^= Ac').params).toEqual(['ac%']);
		expect(build('name $= .com').params).toEqual(['%.com']);
	});

	it("escapes LIKE's wildcards so they match themselves", () => {
		expect(build('name ~ "50%_off"').params).toEqual(['%50\\%\\_off%']);
		expect(escapeSqliteLikePattern('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
	});

	it('negates a match inside the predicate, so a NULL value is still skipped', () => {
		expect(build('name !~ smith').where).toBe(`NOT (${text('"name"')} ${LIKE})`);
	});

	it('runs a regex through the registered function with its pattern and flags bound', () => {
		expect(build('name ~ /^acme-\\d+$/')).toEqual({
			where: `${SQLITE_REGEXP_FUNCTION}(${text('"name"')}, ?, ?)`,
			params: ['^acme-\\d+$', 'i'],
		});
		// An explicit flag list wins over the case-insensitive default, minus `g`.
		expect(build('name = /Acme/gs').params).toEqual(['Acme', 's']);
		expect(build('name != /x/').where).toBe(
			`NOT (${SQLITE_REGEXP_FUNCTION}(${text('"name"')}, ?, ?))`
		);
	});

	it('searches every column for a bare word, skipping BLOB values', () => {
		const { where, params } = build('acme');
		const columns = COLUMNS.map((column) => `"${column.name}"`);
		expect(where).toBe(
			`(${columns.map((column) => `(typeof(${column}) != 'blob' AND ${column} ${LIKE})`).join(' OR ')})`
		);
		expect(params).toEqual(COLUMNS.map(() => '%acme%'));
	});

	it('treats juxtaposed terms as AND', () => {
		expect(build('id = 1 acme').where.startsWith('("id" = ? AND (')).toBe(true);
	});

	it('compiles a bare word over an object with no columns to false', () => {
		const bound = bindSqliteFilter('acme', []);
		expect(bound.node).not.toBeNull();
		expect(compileSqliteFilter(bound.node!, [])).toEqual({ where: '0', params: [] });
	});

	it('refuses an AST bound against other columns', () => {
		const bound = bindSqliteFilter('id = 1', COLUMNS);
		expect(() => compileSqliteFilter(bound.node!, [{ name: 'other', affinity: 'TEXT' }])).toThrow(
			'The filter names a column this object lacks: id'
		);
	});
});

describe('sqliteFilterParam', () => {
	const literal = (value: string, isNull = false) => ({ text: value, value, isNull });

	it('leaves text for SQLite to convert on columns with an affinity', () => {
		expect(sqliteFilterParam(literal('100'), 'INTEGER')).toBe('100');
		expect(sqliteFilterParam(literal('9007199254740993'), 'INTEGER')).toBe('9007199254740993');
		expect(sqliteFilterParam(literal('2024-01-15'), 'NUMERIC')).toBe('2024-01-15');
		expect(sqliteFilterParam(literal('1.5'), 'REAL')).toBe('1.5');
		expect(sqliteFilterParam(literal('100'), 'TEXT')).toBe('100');
	});

	it('binds numbers as numbers where the column has no affinity, exact past 2^53', () => {
		expect(sqliteFilterParam(literal('42'), 'BLOB')).toBe(42);
		expect(sqliteFilterParam(literal('-1.25e2'), 'BLOB')).toBe(-125);
		expect(sqliteFilterParam(literal('9007199254740993'), 'BLOB')).toBe(9007199254740993n);
		expect(sqliteFilterParam(literal('abc'), 'BLOB')).toBe('abc');
	});

	it('reads true and false as 1 and 0 except on a TEXT column', () => {
		expect(sqliteFilterParam(literal('TRUE'), 'NUMERIC')).toBe(1);
		expect(sqliteFilterParam(literal('false'), 'INTEGER')).toBe(0);
		expect(sqliteFilterParam(literal('true'), 'BLOB')).toBe(1);
		expect(sqliteFilterParam(literal('true'), 'TEXT')).toBe('true');
	});

	it('binds an explicit null as null', () => {
		expect(sqliteFilterParam({ text: 'null', value: null, isNull: true }, 'INTEGER')).toBeNull();
	});
});

describe('sqliteRegexpTest', () => {
	it('returns 1, 0, or NULL for a NULL value', () => {
		expect(sqliteRegexpTest('acme-42', '^acme-\\d+$', 'i')).toBe(1);
		expect(sqliteRegexpTest('ACME-42', '^acme-\\d+$', 'i')).toBe(1);
		expect(sqliteRegexpTest('ACME-42', '^acme-\\d+$', '')).toBe(0);
		expect(sqliteRegexpTest(null, 'x', 'i')).toBeNull();
	});

	it('stays stateless when given the global flag', () => {
		expect(sqliteRegexpTest('aa', 'a', 'g')).toBe(1);
		expect(sqliteRegexpTest('aa', 'a', 'g')).toBe(1);
	});

	it('matches a number by its text', () => {
		expect(sqliteRegexpTest(12345, '^123', '')).toBe(1);
	});

	it('throws on an invalid pattern, which SQLite reports as the statement error', () => {
		expect(() => sqliteRegexpTest('x', '(', '')).toThrow();
	});
});
