import { describe, expect, it } from 'vitest';

import { sqliteTokenName, sqliteTokens } from '../../../shared/sqlite/tokens';

const kinds = (sql: string) => sqliteTokens(sql).map((token) => [token.kind, token.text]);

describe('sqliteTokens', () => {
	it('splits words, symbols, numbers, and strings, dropping whitespace', () => {
		expect(kinds("SELECT id, 'a b' FROM t WHERE n >= 1.5e3")).toEqual([
			['word', 'SELECT'],
			['word', 'id'],
			['symbol', ','],
			['string', "'a b'"],
			['word', 'FROM'],
			['word', 't'],
			['word', 'WHERE'],
			['word', 'n'],
			['symbol', '>='],
			['number', '1.5e3'],
		]);
	});

	it('keeps offsets into the text as written', () => {
		const sql = '  SELECT\n\tx';
		expect(sqliteTokens(sql).map(({ from, to }) => sql.slice(from, to))).toEqual(['SELECT', 'x']);
		expect(sqliteTokens(sql)[1]).toMatchObject({ from: 10, to: 11 });
	});

	it('drops line and block comments', () => {
		expect(kinds('SELECT -- a\n1 /* b ; c */ , 2')).toEqual([
			['word', 'SELECT'],
			['number', '1'],
			['symbol', ','],
			['number', '2'],
		]);
	});

	it('reads quoted names, doubled quotes, and BLOB literals as one token', () => {
		expect(kinds(`"a ""b""" [c d] \`e\` 'it''s' x'00ff'`)).toEqual([
			['quoted', '"a ""b"""'],
			['quoted', '[c d]'],
			['quoted', '`e`'],
			['string', "'it''s'"],
			['blob', "x'00ff'"],
		]);
	});

	it('reads multi-character operators whole, longest first', () => {
		expect(kinds('a == b <> c || d ->> e -> f != g').map(([, text]) => text)).toEqual([
			'a',
			'==',
			'b',
			'<>',
			'c',
			'||',
			'd',
			'->>',
			'e',
			'->',
			'f',
			'!=',
			'g',
		]);
	});

	it('reads parameters, and a sigil with no name as a symbol', () => {
		expect(kinds('? ?2 :id @n $v #h : price$usd')).toEqual([
			['parameter', '?'],
			['parameter', '?2'],
			['parameter', ':id'],
			['parameter', '@n'],
			['parameter', '$v'],
			['parameter', '#h'],
			['symbol', ':'],
			['word', 'price$usd'],
		]);
	});

	it('reads a number with letters stuck to it as one bad token, and hex numbers', () => {
		expect(kinds('1abc 0x1F .5')).toEqual([
			['number', '1abc'],
			['number', '0x1F'],
			['number', '.5'],
		]);
	});

	it('runs an unterminated quote or comment to the end of the text', () => {
		expect(kinds("SELECT 'abc FROM t")).toEqual([
			['word', 'SELECT'],
			['string', "'abc FROM t"],
		]);
		expect(kinds('SELECT 1 /* open')).toEqual([
			['word', 'SELECT'],
			['number', '1'],
		]);
	});
});

describe('sqliteTokenName', () => {
	it('reads a word as written and a quoted name without its quotes', () => {
		const names = sqliteTokens('users "user ""name""" [a"b] `c` \'s\' 1').map(sqliteTokenName);
		expect(names).toEqual(['users', 'user "name"', 'a"b', 'c', null, null]);
	});
});
