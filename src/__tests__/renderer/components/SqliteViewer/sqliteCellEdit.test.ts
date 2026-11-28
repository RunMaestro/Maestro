import { describe, expect, it } from 'vitest';

import {
	isSqliteCellNullChord,
	sqliteCellEditDraft,
	sqliteCellEditRefusal,
	sqliteCellEditText,
	sqliteCellEditTypeHint,
	sqliteCellEditValue,
	sqliteCellEditValueProblem,
	sqliteRowKeyAt,
	sqliteRowKeyRefusal,
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

describe('sqliteRowKeyRefusal', () => {
	it('lets a row with a whole key through', () => {
		expect(sqliteRowKeyRefusal({ kind: 'rowid', rowid: '7' })).toBeNull();
		expect(
			sqliteRowKeyRefusal({
				kind: 'primary-key',
				values: { org: { type: 'integer', text: '3' } },
			})
		).toBeNull();
	});

	it('refuses a row with no key, or one whose primary key holds NULL', () => {
		expect(sqliteRowKeyRefusal(null)).toContain('came back without its key');
		expect(sqliteRowKeyRefusal({ kind: 'primary-key', values: { org: null } })).toContain(
			'NULL never equals anything'
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

describe('sqliteCellEditDraft', () => {
	it('opens a NULL as NULL and an empty string as text, so the two never look alike', () => {
		expect(sqliteCellEditDraft(null)).toEqual({ text: '', isNull: true });
		expect(sqliteCellEditDraft('')).toEqual({ text: '', isNull: false });
		expect(sqliteCellEditDraft(0)).toEqual({ text: '0', isNull: false });
	});
});

describe('isSqliteCellNullChord', () => {
	const press = (overrides: Partial<Parameters<typeof isSqliteCellNullChord>[0]>) =>
		isSqliteCellNullChord({
			key: 'Backspace',
			altKey: true,
			metaKey: true,
			ctrlKey: false,
			shiftKey: false,
			...overrides,
		});

	it('is Alt+Cmd+Backspace, or Alt+Ctrl+Backspace off macOS', () => {
		expect(press({})).toBe(true);
		expect(press({ metaKey: false, ctrlKey: true })).toBe(true);
	});

	it('leaves the text-editing chords alone, and never matches Remove Agent', () => {
		expect(press({ altKey: false })).toBe(false); // Cmd+Backspace: delete to line start
		expect(press({ metaKey: false })).toBe(false); // Alt+Backspace: delete a word
		expect(press({ altKey: false, shiftKey: true })).toBe(false); // Cmd+Shift+Backspace
		expect(press({ shiftKey: true })).toBe(false);
		expect(press({ key: 'Delete' })).toBe(false);
	});
});

describe('sqliteCellEditValue', () => {
	const text = (value: string) => ({ text: value, isNull: false });
	const NULL_DRAFT = { text: '', isNull: true };

	it('writes nothing when the draft is what the editor opened with', () => {
		expect(sqliteCellEditValue(null, NULL_DRAFT, 'TEXT')).toBeNull();
		expect(sqliteCellEditValue('', text(''), 'TEXT')).toBeNull();
		expect(sqliteCellEditValue('ada', text('ada'), 'TEXT')).toBeNull();
		expect(sqliteCellEditValue(42, text('42'), 'INTEGER')).toBeNull();
		// NULL kept what was typed before it was set; still NULL, still nothing.
		expect(sqliteCellEditValue(null, { text: 'typed', isNull: true }, 'TEXT')).toBeNull();
	});

	it('binds NULL only for a NULL draft, whatever text it kept', () => {
		expect(sqliteCellEditValue('ada', NULL_DRAFT, 'TEXT')).toEqual({ type: 'null', text: '' });
		expect(sqliteCellEditValue('', NULL_DRAFT, 'TEXT')).toEqual({ type: 'null', text: '' });
		expect(sqliteCellEditValue(42, { text: '42', isNull: true }, 'INTEGER')).toEqual({
			type: 'null',
			text: '',
		});
	});

	it('writes an empty string, never NULL, for an emptied box', () => {
		expect(sqliteCellEditValue('ada', text(''), 'TEXT')).toEqual({ type: 'text', text: '' });
		// A NULL cell whose NULL was turned off (or typed over, then cleared).
		expect(sqliteCellEditValue(null, text(''), 'TEXT')).toEqual({ type: 'text', text: '' });
		expect(sqliteCellEditValue(42, text(''), 'INTEGER')).toEqual({ type: 'text', text: '' });
	});

	it('binds numeric text as a number in an INTEGER, REAL, or NUMERIC column', () => {
		expect(sqliteCellEditValue(42, text(' 43 '), 'INTEGER')).toEqual({
			type: 'number',
			text: '43',
		});
		// Even when the cell held NULL or text: the column wants numbers.
		expect(sqliteCellEditValue(null, text('7'), 'NUMERIC')).toEqual({ type: 'number', text: '7' });
		expect(sqliteCellEditValue('n/a', text('1.5'), 'REAL')).toEqual({
			type: 'number',
			text: '1.5',
		});
		expect(sqliteCellEditValue(42, text('forty-two'), 'INTEGER')).toEqual({
			type: 'text',
			text: 'forty-two',
		});
	});

	it('binds everything as text, verbatim, in a TEXT column', () => {
		expect(sqliteCellEditValue('ada', text(' grace '), 'TEXT')).toEqual({
			type: 'text',
			text: ' grace ',
		});
		// '007' stays '007'; a number would come back as '7'.
		expect(sqliteCellEditValue('001', text('007'), 'TEXT')).toEqual({ type: 'text', text: '007' });
	});

	it('keeps the type a value already has in a column with no affinity', () => {
		expect(
			sqliteCellEditValue({ kind: 'integer', text: '9007199254740993' }, text('1e3'), 'BLOB')
		).toEqual({ type: 'number', text: '1e3' });
		expect(sqliteCellEditValue(42, text('forty-two'), 'BLOB')).toEqual({
			type: 'text',
			text: 'forty-two',
		});
		expect(sqliteCellEditValue('5', text('6'), 'BLOB')).toEqual({ type: 'text', text: '6' });
		expect(sqliteCellEditValue(null, text('7'), 'BLOB')).toEqual({ type: 'text', text: '7' });
	});
});

describe('sqliteCellEditValueProblem', () => {
	const column = (affinity: 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB', isRowid = false) => ({
		name: 'qty',
		affinity,
		isRowid,
	});

	it('passes a value the column stores as entered', () => {
		expect(
			sqliteCellEditValueProblem(column('INTEGER'), 5, { type: 'number', text: '6' })
		).toBeNull();
		expect(
			sqliteCellEditValueProblem(column('TEXT'), 'a', { type: 'text', text: '007' })
		).toBeNull();
		expect(sqliteCellEditValueProblem(column('BLOB'), 5, { type: 'text', text: 'x' })).toBeNull();
		expect(sqliteCellEditValueProblem(column('INTEGER'), 5, { type: 'null', text: '' })).toBeNull();
	});

	it('refuses text that is not a number in a numeric column, an emptied box included', () => {
		expect(sqliteCellEditValueProblem(column('INTEGER'), 5, { type: 'text', text: 'five' })).toBe(
			"qty has INTEGER affinity, and 'five' is not a number, so SQLite would keep it as TEXT. Enter a number, or set NULL."
		);
		expect(sqliteCellEditValueProblem(column('REAL'), null, { type: 'text', text: '' })).toBe(
			'qty has REAL affinity, and an empty string is not a number, so SQLite would keep it as TEXT. Enter a number, or set NULL.'
		);
	});

	it('lets text stay text where the cell already holds text', () => {
		expect(
			sqliteCellEditValueProblem(column('NUMERIC'), 'n/a', { type: 'text', text: 'unknown' })
		).toBeNull();
		expect(
			sqliteCellEditValueProblem(
				column('INTEGER'),
				{ kind: 'text', head: 'x', length: 9000 },
				{ type: 'text', text: 'y' }
			)
		).toBeNull();
	});

	it('refuses a number SQLite would store rounded', () => {
		expect(sqliteCellEditValueProblem(column('REAL'), 1, { type: 'number', text: '1e400' })).toBe(
			'qty: 1e400 is too large for SQLite to store as a number.'
		);
		expect(
			sqliteCellEditValueProblem(column('INTEGER'), 1, {
				type: 'number',
				text: '9223372036854775808',
			})
		).toMatch(/^qty: 9223372036854775808 is past the 64-bit integer range/);
	});

	it('takes only a whole number in the rowid column', () => {
		const rowid = column('INTEGER', true);
		expect(sqliteCellEditValueProblem(rowid, 1, { type: 'number', text: '2' })).toBeNull();
		expect(sqliteCellEditValueProblem(rowid, 1, { type: 'number', text: '2.5' })).toMatch(
			/only whole numbers; 2\.5 is not one\.$/
		);
		expect(sqliteCellEditValueProblem(rowid, 1, { type: 'null', text: '' })).toMatch(
			/never NULL\.$/
		);
	});
});

describe('sqliteCellEditTypeHint', () => {
	it('names the declared type, the affinity, and what it does to the text typed', () => {
		expect(sqliteCellEditTypeHint('qty', 'INT', 'INTEGER')).toBe(
			'qty (INT, INTEGER affinity): a number is stored as a number; text that is not one is refused.'
		);
		expect(sqliteCellEditTypeHint('name', 'VARCHAR(20)', 'TEXT')).toBe(
			'name (VARCHAR(20), TEXT affinity): everything is stored as text, numbers included.'
		);
		expect(sqliteCellEditTypeHint('extra', null, 'BLOB')).toBe(
			'extra (BLOB affinity): no conversion, so a value keeps the type it is entered as.'
		);
	});
});
