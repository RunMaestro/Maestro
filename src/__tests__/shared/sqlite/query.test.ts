import { describe, expect, it } from 'vitest';

import {
	SQLITE_MIXED_PARAMETERS_MESSAGE,
	SQLITE_PLAN_OF_EXPLAIN_MESSAGE,
	SQLITE_READ_ONLY_KEYWORDS,
	isSqliteReadOnlyKeyword,
	sqliteLeadingKeyword,
	sqliteQueryBinding,
	sqliteQueryParameters,
	sqliteQueryTimeoutMessage,
	sqliteReadOnlyRefusal,
	sqliteStatementToRun,
} from '../../../shared/sqlite/query';

describe('sqliteLeadingKeyword', () => {
	it('reads the first keyword, upper case', () => {
		expect(sqliteLeadingKeyword('select * from t')).toBe('SELECT');
		expect(sqliteLeadingKeyword('  \n\tWith x AS (SELECT 1) SELECT * FROM x')).toBe('WITH');
	});

	it('skips line and block comments that could hide the real keyword', () => {
		expect(sqliteLeadingKeyword('-- a note\nDELETE FROM t')).toBe('DELETE');
		expect(sqliteLeadingKeyword('/* select */ DROP TABLE t')).toBe('DROP');
		expect(sqliteLeadingKeyword('/* a */ -- b\n /* c */ pragma table_info(t)')).toBe('PRAGMA');
	});

	it('is empty when no keyword starts the text', () => {
		expect(sqliteLeadingKeyword('')).toBe('');
		expect(sqliteLeadingKeyword('-- only a comment')).toBe('');
		expect(sqliteLeadingKeyword('/* unterminated')).toBe('');
		expect(sqliteLeadingKeyword(';SELECT 1')).toBe('');
	});
});

describe('sqliteReadOnlyRefusal', () => {
	it('lets every read-only statement kind through', () => {
		for (const keyword of SQLITE_READ_ONLY_KEYWORDS) {
			expect(isSqliteReadOnlyKeyword(keyword.toLowerCase())).toBe(true);
			expect(sqliteReadOnlyRefusal(`${keyword} 1`)).toBeNull();
		}
	});

	it('refuses writes by name, listing what is allowed', () => {
		const refusal = sqliteReadOnlyRefusal('delete from users');
		expect(refusal).toBe(
			'DELETE is not a read-only statement. Queries here are read-only: SELECT, WITH, PRAGMA, EXPLAIN, VALUES.'
		);
		for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'VACUUM INTO "x.db"']) {
			expect(sqliteReadOnlyRefusal(sql)).toMatch(/is not a read-only statement/);
		}
	});

	it('refuses ATTACH and DETACH, which open other files', () => {
		expect(sqliteReadOnlyRefusal("ATTACH '/etc/x.db' AS x")).toMatch(/^ATTACH opens or closes/);
		expect(sqliteReadOnlyRefusal('detach x')).toMatch(/^DETACH opens or closes/);
	});

	it('asks for a statement when there is none', () => {
		expect(sqliteReadOnlyRefusal('   ')).toBe('Write a statement to run.');
		expect(sqliteReadOnlyRefusal('-- nothing yet')).toMatch(/does not start with a statement/);
	});
});

describe('sqliteReadOnlyRefusal with plan', () => {
	it('lets a read through, judged as written', () => {
		expect(sqliteReadOnlyRefusal('SELECT * FROM t', { plan: true })).toBeNull();
		expect(
			sqliteReadOnlyRefusal('-- note\nWITH x AS (SELECT 1) SELECT 1', { plan: true })
		).toBeNull();
	});

	it('refuses to plan a write, by its own keyword', () => {
		expect(sqliteReadOnlyRefusal('DELETE FROM t', { plan: true })).toMatch(
			/^DELETE is not a read-only statement/
		);
		expect(sqliteReadOnlyRefusal("ATTACH 'x.db' AS x", { plan: true })).toMatch(/^ATTACH/);
	});

	it('refuses to plan a statement that is already an EXPLAIN', () => {
		expect(sqliteReadOnlyRefusal('explain query plan select 1', { plan: true })).toBe(
			SQLITE_PLAN_OF_EXPLAIN_MESSAGE
		);
		expect(sqliteReadOnlyRefusal('/* x */ EXPLAIN SELECT 1', { plan: true })).toBe(
			SQLITE_PLAN_OF_EXPLAIN_MESSAGE
		);
		// Without the toggle an EXPLAIN runs as written.
		expect(sqliteReadOnlyRefusal('EXPLAIN SELECT 1')).toBeNull();
	});

	it('still asks for a statement when there is none', () => {
		expect(sqliteReadOnlyRefusal('  ', { plan: true })).toBe('Write a statement to run.');
	});
});

describe('sqliteStatementToRun', () => {
	it('trims the statement and leaves it as written by default', () => {
		expect(sqliteStatementToRun('  SELECT 1  ')).toBe('SELECT 1');
		expect(sqliteStatementToRun('SELECT 1', { plan: false })).toBe('SELECT 1');
	});

	it('puts EXPLAIN QUERY PLAN in front for a plan, keeping comments and parameters', () => {
		expect(sqliteStatementToRun(' SELECT * FROM t WHERE id = :id ', { plan: true })).toBe(
			'EXPLAIN QUERY PLAN SELECT * FROM t WHERE id = :id'
		);
		expect(sqliteStatementToRun('-- note\nSELECT 1', { plan: true })).toBe(
			'EXPLAIN QUERY PLAN -- note\nSELECT 1'
		);
	});
});

describe('sqliteQueryTimeoutMessage', () => {
	it('names the timeout in seconds', () => {
		expect(sqliteQueryTimeoutMessage(60_000)).toMatch(/stopped after 60 s/);
	});
});

describe('sqliteQueryParameters', () => {
	const labels = (sql: string) => sqliteQueryParameters(sql).parameters.map((p) => p.label);

	it('numbers bare ? by order and keeps named ones as written', () => {
		expect(sqliteQueryParameters('SELECT * FROM t WHERE a = ? AND b = :b OR c = ?')).toEqual({
			parameters: [
				{ label: '?1', anonymous: true },
				{ label: ':b', anonymous: false },
				{ label: '?2', anonymous: true },
			],
			problem: null,
		});
		expect(labels('SELECT @a, $b, #c, :d$e, :é')).toEqual(['@a', '$b', '#c', ':d$e', ':é']);
	});

	it('lists a name used twice once, and :id with @id once (the driver binds both from one key)', () => {
		expect(labels('SELECT :id, :id, @id, ?2, ?02, ?1')).toEqual([':id', '?2', '?1']);
	});

	it('skips strings, quoted names, comments, and the $ inside a word', () => {
		expect(
			labels(
				`SELECT 'a ? :b', "c:d", \`e?\`, [f@g], price$usd -- ? :h\n/* :i ? */ FROM t WHERE x = :real`
			)
		).toEqual([':real']);
		expect(labels("SELECT 'it''s ?', :after")).toEqual([':after']);
		expect(labels('SELECT 1 -- trailing ?')).toEqual([]);
		expect(labels("SELECT 'unterminated ?")).toEqual([]);
	});

	it('ignores a sigil with no name after it', () => {
		expect(labels('SELECT : , @ , $')).toEqual([]);
	});

	it('reports a bare ? mixed with ?NNN, whichever comes first', () => {
		expect(sqliteQueryParameters('SELECT ?, ?2').problem).toBe(SQLITE_MIXED_PARAMETERS_MESSAGE);
		expect(sqliteQueryParameters('SELECT ?1, ?').problem).toBe(SQLITE_MIXED_PARAMETERS_MESSAGE);
		// One entry per label even then, so a list keyed by label stays unique.
		expect(labels('SELECT ?, ?1')).toEqual(['?1']);
		expect(sqliteQueryParameters('SELECT ?, :a').problem).toBeNull();
	});
});

describe('sqliteQueryBinding', () => {
	const text = (value: string) => ({ type: 'text' as const, text: value });
	const number = (value: string) => ({ type: 'number' as const, text: value });

	it('binds bare ? as an array in order and named ones as an object without the sigil', () => {
		const binding = sqliteQueryBinding('SELECT ?, :a, ?', {
			'?1': text('one'),
			':a': number('2'),
			'?2': { type: 'null', text: 'ignored' },
		});
		expect(binding.problem).toBeNull();
		expect(binding.args?.[0]).toEqual(['one', null]);
		expect({ ...(binding.args?.[1] as object) }).toEqual({ a: 2 });
	});

	it('binds no arguments for a statement without parameters', () => {
		expect(sqliteQueryBinding('SELECT 1', undefined)).toEqual({ args: [], problem: null });
	});

	it('binds a number exactly: an integer past 2^53 as a bigint, a decimal as a double', () => {
		const binding = sqliteQueryBinding('SELECT :big, :small, :real', {
			':big': number('9007199254740993'),
			':small': number(' -7 '),
			':real': number('1.5e3'),
		});
		expect({ ...(binding.args?.[0] as object) }).toEqual({
			big: 9007199254740993n,
			small: -7,
			real: 1500,
		});
	});

	it('binds empty text as empty text, not NULL', () => {
		expect(sqliteQueryBinding('SELECT ?', { '?1': text('') }).args).toEqual([['']]);
	});

	it('keys a parameter called __proto__ like any other', () => {
		const binding = sqliteQueryBinding('SELECT :__proto__', { ':__proto__': text('p') });
		expect(Object.keys(binding.args?.[0] as object)).toEqual(['__proto__']);
	});

	it('refuses, naming the parameter, a missing value, a bad number, or an unknown type', () => {
		expect(sqliteQueryBinding('SELECT :id', {}).problem).toBe('Give :id a value.');
		expect(sqliteQueryBinding('SELECT ?', null).problem).toBe('Give ?1 a value.');
		expect(sqliteQueryBinding('SELECT :n', { ':n': number('abc') }).problem).toBe(
			':n is set to Number, but "abc" is not a number.'
		);
		expect(sqliteQueryBinding('SELECT :n', { ':n': number('  ') }).problem).toBe(
			':n is set to Number, but it is empty.'
		);
		expect(
			sqliteQueryBinding('SELECT :n', {
				':n': { type: 'blob', text: '' } as unknown as ReturnType<typeof text>,
			}).problem
		).toBe(':n has an unknown type; use text, number, or null.');
	});

	it('refuses a statement that mixes ? with ?NNN before looking at values', () => {
		expect(sqliteQueryBinding('SELECT ?, ?2', {})).toEqual({
			args: null,
			problem: SQLITE_MIXED_PARAMETERS_MESSAGE,
		});
	});
});
