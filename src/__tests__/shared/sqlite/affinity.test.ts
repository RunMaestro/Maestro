import { describe, expect, it } from 'vitest';

import {
	isNumericSqliteAffinity,
	sqliteRowidValueProblem,
	sqliteStoredValueProblem,
} from '../../../shared/sqlite/affinity';

describe('isNumericSqliteAffinity', () => {
	it('is INTEGER, REAL, and NUMERIC', () => {
		expect(['INTEGER', 'REAL', 'NUMERIC'].every((a) => isNumericSqliteAffinity(a as never))).toBe(
			true
		);
		expect(isNumericSqliteAffinity('TEXT')).toBe(false);
		expect(isNumericSqliteAffinity('BLOB')).toBe(false);
	});
});

describe('sqliteRowidValueProblem', () => {
	it('takes a whole number, however it is written', () => {
		expect(sqliteRowidValueProblem('id', { type: 'number', text: '42' })).toBeNull();
		expect(sqliteRowidValueProblem('id', { type: 'number', text: ' -7 ' })).toBeNull();
		expect(sqliteRowidValueProblem('id', { type: 'number', text: '1e3' })).toBeNull();
		expect(
			sqliteRowidValueProblem('id', { type: 'number', text: '9223372036854775807' })
		).toBeNull();
	});

	it('names the column and the value SQLite would answer with "datatype mismatch"', () => {
		expect(sqliteRowidValueProblem('id', { type: 'number', text: '3.5' })).toBe(
			"id is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers; 3.5 is not one."
		);
		expect(sqliteRowidValueProblem('id', { type: 'text', text: 'abc' })).toBe(
			"id is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers; the text 'abc' is not one."
		);
		expect(sqliteRowidValueProblem('id', { type: 'null', text: '' })).toBe(
			"id is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers, never NULL."
		);
	});
});

describe('sqliteStoredValueProblem', () => {
	it('passes a value stored as it was given', () => {
		expect(sqliteStoredValueProblem('c', 'TEXT', 'ada', 'text', 'ada')).toBeNull();
		expect(sqliteStoredValueProblem('c', 'INTEGER', 'abc', 'text', 'abc')).toBeNull();
		expect(sqliteStoredValueProblem('c', 'BLOB', '007', 'text', '007')).toBeNull();
		expect(sqliteStoredValueProblem('c', 'INTEGER', 7n, 'integer', 7n)).toBeNull();
		expect(sqliteStoredValueProblem('c', 'REAL', 7.5, 'real', 7.5)).toBeNull();
		expect(sqliteStoredValueProblem('c', 'INTEGER', null, 'null', null)).toBeNull();
	});

	it('treats a whole number stored as a REAL, or the reverse, as the same number', () => {
		expect(sqliteStoredValueProblem('c', 'REAL', 7n, 'real', 7)).toBeNull();
		expect(sqliteStoredValueProblem('c', 'INTEGER', 7, 'integer', 7n)).toBeNull();
		expect(
			sqliteStoredValueProblem('c', 'INTEGER', 9007199254740993n, 'integer', 9007199254740993n)
		).toBeNull();
	});

	it('refuses text the affinity turned into a number', () => {
		expect(sqliteStoredValueProblem('zip', 'INTEGER', '007', 'integer', 7n)).toBe(
			"zip has INTEGER affinity, so SQLite would store the text '007' as the integer 7. Nothing was changed; to store a number, give it as a number."
		);
		expect(sqliteStoredValueProblem('n', 'NUMERIC', '3.0e+5', 'integer', 300000n)).toMatch(
			/the text '3\.0e\+5' as the integer 300000/
		);
		expect(sqliteStoredValueProblem('r', 'REAL', '1.50', 'real', 1.5)).toMatch(
			/the text '1\.50' as the real number 1\.5/
		);
	});

	it('refuses a number the affinity turned into text', () => {
		expect(sqliteStoredValueProblem('code', 'TEXT', 7, 'text', '7.0')).toBe(
			"code has TEXT affinity, so SQLite would store the number 7 as the text '7.0'. Nothing was changed; to store text, give it as text."
		);
	});

	it('refuses an integer a REAL column cannot hold exactly', () => {
		expect(sqliteStoredValueProblem('r', 'REAL', 9007199254740993n, 'real', 2 ** 53)).toBe(
			'r has REAL affinity, so SQLite would store the number 9007199254740993 as the real number 9007199254740992. Nothing was changed; give a number it can hold.'
		);
	});

	it('quotes a long text value cut', () => {
		const long = `${'word '.repeat(20)}end`;
		const problem = sqliteStoredValueProblem('c', 'INTEGER', long, 'integer', 1n) ?? '';
		expect(problem).toContain("the text 'word word");
		expect(problem).toContain("…' as the integer 1");
	});
});
