import { describe, expect, it } from 'vitest';

import {
	isSqliteCellNullChord,
	sqliteCellEditDraft,
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
		expect(sqliteCellEditValue(null, NULL_DRAFT)).toBeNull();
		expect(sqliteCellEditValue('', text(''))).toBeNull();
		expect(sqliteCellEditValue('ada', text('ada'))).toBeNull();
		expect(sqliteCellEditValue(42, text('42'))).toBeNull();
		// NULL kept what was typed before it was set; still NULL, still nothing.
		expect(sqliteCellEditValue(null, { text: 'typed', isNull: true })).toBeNull();
	});

	it('binds NULL only for a NULL draft, whatever text it kept', () => {
		expect(sqliteCellEditValue('ada', NULL_DRAFT)).toEqual({ type: 'null', text: '' });
		expect(sqliteCellEditValue('', NULL_DRAFT)).toEqual({ type: 'null', text: '' });
		expect(sqliteCellEditValue(42, { text: '42', isNull: true })).toEqual({
			type: 'null',
			text: '',
		});
	});

	it('writes an empty string, never NULL, for an emptied box', () => {
		expect(sqliteCellEditValue('ada', text(''))).toEqual({ type: 'text', text: '' });
		// A NULL cell whose NULL was turned off (or typed over, then cleared).
		expect(sqliteCellEditValue(null, text(''))).toEqual({ type: 'text', text: '' });
		expect(sqliteCellEditValue(42, text(''))).toEqual({ type: 'text', text: '' });
	});

	it('keeps a number a number while the text is still one', () => {
		expect(sqliteCellEditValue(42, text(' 43 '))).toEqual({ type: 'number', text: '43' });
		expect(sqliteCellEditValue({ kind: 'integer', text: '9007199254740993' }, text('1e3'))).toEqual(
			{ type: 'number', text: '1e3' }
		);
		expect(sqliteCellEditValue(42, text('forty-two'))).toEqual({
			type: 'text',
			text: 'forty-two',
		});
	});

	it('binds everything else as TEXT, verbatim, for the column affinity to convert', () => {
		expect(sqliteCellEditValue('ada', text(' grace '))).toEqual({ type: 'text', text: ' grace ' });
		expect(sqliteCellEditValue(null, text('7'))).toEqual({ type: 'text', text: '7' });
	});
});
