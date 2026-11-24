import { describe, expect, it } from 'vitest';

import {
	EMPTY_SQLITE_INSERT_FIELD,
	sqliteInsertColumns,
	sqliteInsertField,
	sqliteInsertValues,
	type SqliteInsertColumn,
} from '../../../../renderer/components/SqliteViewer/sqliteRowInsert';
import type { SqliteEditability } from '../../../../shared/sqlite/types';

const BY_ROWID: SqliteEditability = {
	editable: true,
	identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
	readOnlyColumns: [{ name: 'total', reason: 'total is a generated column.' }],
};

const COLUMNS = [
	{ name: 'id', declaredType: 'INTEGER' },
	{ name: 'name', declaredType: 'TEXT' },
	{ name: 'age', declaredType: 'INT' },
	{ name: 'extra', declaredType: null },
	{ name: 'total', declaredType: 'REAL' },
];

describe('sqliteInsertColumns', () => {
	it('marks the rowid column and the generated ones', () => {
		expect(sqliteInsertColumns(COLUMNS, BY_ROWID)).toEqual([
			{ name: 'id', declaredType: 'INTEGER', readOnlyReason: null, isRowid: true },
			{ name: 'name', declaredType: 'TEXT', readOnlyReason: null, isRowid: false },
			{ name: 'age', declaredType: 'INT', readOnlyReason: null, isRowid: false },
			{ name: 'extra', declaredType: null, readOnlyReason: null, isRowid: false },
			{
				name: 'total',
				declaredType: 'REAL',
				readOnlyReason: 'total is a generated column.',
				isRowid: false,
			},
		]);
	});

	it('marks nothing while the editability is unknown or read-only', () => {
		const columns = sqliteInsertColumns(COLUMNS, null);
		expect(columns.every((column) => !column.isRowid && column.readOnlyReason === null)).toBe(true);
	});
});

describe('sqliteInsertField', () => {
	it('leaves a column the form has not touched to its default', () => {
		expect(sqliteInsertField({}, 'name')).toBe(EMPTY_SQLITE_INSERT_FIELD);
		expect(sqliteInsertField({ name: { mode: 'null', text: 'x' } }, 'name')).toEqual({
			mode: 'null',
			text: 'x',
		});
		// An inherited name is not a field.
		expect(sqliteInsertField({}, 'constructor')).toBe(EMPTY_SQLITE_INSERT_FIELD);
	});
});

describe('sqliteInsertValues', () => {
	const columns: SqliteInsertColumn[] = sqliteInsertColumns(COLUMNS, BY_ROWID);

	it('names no column for an untouched form, so every one takes its default', () => {
		expect(sqliteInsertValues(columns, {}, false)).toEqual({ values: {} });
	});

	it('binds each value by its column affinity, the way a cell edit into an empty cell binds', () => {
		expect(
			sqliteInsertValues(
				columns,
				{
					name: { mode: 'value', text: '007' },
					age: { mode: 'value', text: ' 42 ' },
					extra: { mode: 'value', text: 'free text' },
					id: { mode: 'default', text: '99' },
				},
				false
			)
		).toEqual({
			values: {
				name: { type: 'text', text: '007' },
				age: { type: 'number', text: '42' },
				extra: { type: 'text', text: 'free text' },
			},
		});
	});

	it('keeps an emptied TEXT field as an empty string, and NULL as NULL', () => {
		expect(
			sqliteInsertValues(
				columns,
				{ name: { mode: 'value', text: '' }, age: { mode: 'null', text: '12' } },
				false
			)
		).toEqual({
			values: { name: { type: 'text', text: '' }, age: { type: 'null', text: '' } },
		});
	});

	it('lets the rowid column be NULL, which SQLite takes as "the next rowid"', () => {
		expect(sqliteInsertValues(columns, { id: { mode: 'null', text: '' } }, false)).toEqual({
			values: { id: { type: 'null', text: '' } },
		});
	});

	it('refuses, by column, what a cell edit would refuse', () => {
		expect(sqliteInsertValues(columns, { age: { mode: 'value', text: 'abc' } }, false)).toEqual({
			problem:
				"age has INTEGER affinity, and 'abc' is not a number, so SQLite would keep it as TEXT. Enter a number, or set NULL.",
		});
		expect(sqliteInsertValues(columns, { id: { mode: 'value', text: '2.5' } }, false)).toEqual({
			problem:
				"id is the table's INTEGER PRIMARY KEY, which is each row's rowid, so it holds only whole numbers; 2.5 is not one.",
		});
		expect(
			sqliteInsertValues(columns, { age: { mode: 'value', text: '99999999999999999999' } }, false)
		).toEqual({ problem: expect.stringContaining('age:') });
		expect(sqliteInsertValues(columns, { total: { mode: 'value', text: '1' } }, false)).toEqual({
			problem: 'total is a generated column.',
		});
	});

	it("reads a STRICT table's declared types for the affinity", () => {
		const strictColumns = sqliteInsertColumns([{ name: 'any', declaredType: 'ANY' }], BY_ROWID);
		// ANY is BLOB affinity in a STRICT table: text that looks like a number stays text.
		expect(sqliteInsertValues(strictColumns, { any: { mode: 'value', text: '7' } }, true)).toEqual({
			values: { any: { type: 'text', text: '7' } },
		});
	});
});
