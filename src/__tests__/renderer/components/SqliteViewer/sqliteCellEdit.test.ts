import { describe, expect, it } from 'vitest';

import {
	sqliteCellEditRefusal,
	sqliteCellEditText,
	sqliteCellEditValue,
	sqliteRowKeyAt,
} from '../../../../renderer/components/SqliteViewer/sqliteCellEdit';
import type { SqliteEditability } from '../../../../shared/sqlite/types';

const BY_ROWID: SqliteEditability = {
	editable: true,
	identity: { kind: 'rowid', alias: 'rowid', rowidColumn: 'id' },
	readOnlyColumns: [{ name: 'total', reason: 'total is a generated column.' }],
};

const BY_KEY: SqliteEditability = {
	editable: true,
	identity: { kind: 'primary-key', columns: ['org', 'name'], keyMayBeNull: true },
	readOnlyColumns: [],
};

const VIEW: SqliteEditability = { editable: false, code: 'view', reason: 'active is a view.' };

describe('sqliteRowKeyAt', () => {
	it("names a loaded row by its page's rowid", () => {
		expect(sqliteRowKeyAt(BY_ROWID, ['4', '9'], null, 1)).toEqual({ kind: 'rowid', rowid: '9' });
		expect(sqliteRowKeyAt(BY_ROWID, ['4'], null, 3)).toBeNull();
		expect(sqliteRowKeyAt(BY_ROWID, null, null, 0)).toBeNull();
	});

	it('names a loaded row by its whole primary key, column by column', () => {
		const keys = [
			[
				{ type: 'integer' as const, text: '3' },
				{ type: 'text' as const, text: 'ada' },
			],
		];
		expect(sqliteRowKeyAt(BY_KEY, null, keys, 0)).toEqual({
			kind: 'primary-key',
			values: { org: { type: 'integer', text: '3' }, name: { type: 'text', text: 'ada' } },
		});
		// A key with the wrong number of values names nothing.
		expect(sqliteRowKeyAt(BY_KEY, null, [[null]], 0)).toBeNull();
	});

	it('names nothing for an object that cannot be edited', () => {
		expect(sqliteRowKeyAt(VIEW, ['1'], null, 0)).toBeNull();
		expect(sqliteRowKeyAt(null, ['1'], null, 0)).toBeNull();
	});
});

describe('sqliteCellEditRefusal', () => {
	const key = { kind: 'rowid' as const, rowid: '1' };

	it('lets an ordinary cell be edited', () => {
		expect(sqliteCellEditRefusal(BY_ROWID, 'email', 'a@b.c', key)).toBeNull();
		expect(sqliteCellEditRefusal(BY_ROWID, 'email', null, key)).toBeNull();
		expect(
			sqliteCellEditRefusal(BY_ROWID, 'n', { kind: 'integer', text: '9007199254740993' }, key)
		).toBeNull();
	});

	it('refuses what main would refuse, with the reason', () => {
		expect(sqliteCellEditRefusal(VIEW, 'email', 'x', key)).toBe('active is a view.');
		expect(sqliteCellEditRefusal(BY_ROWID, 'total', 3, key)).toBe('total is a generated column.');
		expect(sqliteCellEditRefusal(null, 'email', 'x', key)).toBe('The table is still loading.');
		expect(sqliteCellEditRefusal(BY_ROWID, 'email', 'x', null)).toContain('without its key');
		expect(
			sqliteCellEditRefusal(BY_KEY, 'role', 'x', {
				kind: 'primary-key',
				values: { org: null, name: { type: 'text', text: 'ada' } },
			})
		).toContain("This row's primary key holds NULL");
	});

	it('refuses a BLOB and a TEXT value the page cut, rather than saving part of it', () => {
		expect(
			sqliteCellEditRefusal(BY_ROWID, 'logo', { kind: 'blob', head: '89', bytes: 2048 }, key)
		).toContain('logo holds a BLOB, which cannot be edited as text');
		expect(
			sqliteCellEditRefusal(BY_ROWID, 'body', { kind: 'text', head: 'abc', length: 5000 }, key)
		).toBe(
			'body holds 5,000 characters, more than the grid shows, so editing it here would cut it.'
		);
	});
});

describe('sqliteCellEditText', () => {
	it('opens the editor with the value as typed, NULL as empty', () => {
		expect(sqliteCellEditText(null)).toBe('');
		expect(sqliteCellEditText('')).toBe('');
		expect(sqliteCellEditText(1.5)).toBe('1.5');
		expect(sqliteCellEditText({ kind: 'integer', text: '9007199254740993' })).toBe(
			'9007199254740993'
		);
		expect(sqliteCellEditText('ada')).toBe('ada');
	});
});

describe('sqliteCellEditValue', () => {
	it('writes nothing when the text is what the editor opened with', () => {
		expect(sqliteCellEditValue(null, '')).toBeNull();
		expect(sqliteCellEditValue('ada', 'ada')).toBeNull();
		expect(sqliteCellEditValue(42, '42')).toBeNull();
	});

	it('keeps a number a number while the text is still one', () => {
		expect(sqliteCellEditValue(42, ' 43 ')).toEqual({ type: 'number', text: '43' });
		expect(sqliteCellEditValue({ kind: 'integer', text: '9007199254740993' }, '1e3')).toEqual({
			type: 'number',
			text: '1e3',
		});
		expect(sqliteCellEditValue(42, 'forty-two')).toEqual({ type: 'text', text: 'forty-two' });
	});

	it('binds everything else as TEXT, verbatim, for the column affinity to convert', () => {
		expect(sqliteCellEditValue('ada', ' grace ')).toEqual({ type: 'text', text: ' grace ' });
		expect(sqliteCellEditValue(null, '7')).toEqual({ type: 'text', text: '7' });
		expect(sqliteCellEditValue('ada', '')).toEqual({ type: 'text', text: '' });
	});
});
