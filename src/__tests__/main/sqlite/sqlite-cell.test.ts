import { describe, expect, it } from 'vitest';

import { sqliteCellFromHead, sqliteCellFromValue } from '../../../main/sqlite/sqlite-cell';
import { SQLITE_CELL_BLOB_HEAD_BYTES, SQLITE_CELL_TEXT_LIMIT } from '../../../shared/sqlite/cells';

describe('sqliteCellFromHead', () => {
	it('keeps small values as themselves and an unsafe INTEGER as its digits', () => {
		expect(sqliteCellFromHead(null, null)).toBeNull();
		expect(sqliteCellFromHead(1.5, null)).toBe(1.5);
		expect(sqliteCellFromHead(BigInt(42), null)).toBe(42);
		expect(sqliteCellFromHead(BigInt('9007199254740993'), null)).toEqual({
			kind: 'integer',
			text: '9007199254740993',
		});
		expect(sqliteCellFromHead('ada', 3)).toBe('ada');
	});

	it('marks TEXT cut in SQL with its full length, and a BLOB with its size', () => {
		expect(sqliteCellFromHead('abc', 10)).toEqual({ kind: 'text', head: 'abc', length: 10 });
		expect(sqliteCellFromHead(Buffer.from([0x89, 0x50]), 1024)).toEqual({
			kind: 'blob',
			head: '8950',
			bytes: 1024,
		});
	});
});

describe('sqliteCellFromValue', () => {
	it('passes short TEXT through whole', () => {
		expect(sqliteCellFromValue('')).toBe('');
		expect(sqliteCellFromValue('x'.repeat(SQLITE_CELL_TEXT_LIMIT))).toBe(
			'x'.repeat(SQLITE_CELL_TEXT_LIMIT)
		);
	});

	it('cuts long TEXT to the limit in characters, with the full length', () => {
		const cell = sqliteCellFromValue('y'.repeat(SQLITE_CELL_TEXT_LIMIT + 10));
		expect(cell).toEqual({
			kind: 'text',
			head: 'y'.repeat(SQLITE_CELL_TEXT_LIMIT),
			length: SQLITE_CELL_TEXT_LIMIT + 10,
		});
	});

	it('counts and cuts by code point, never splitting a surrogate pair', () => {
		// Each emoji is one character to SQLite and two UTF-16 units to JavaScript.
		const whole = '😀'.repeat(SQLITE_CELL_TEXT_LIMIT);
		expect(sqliteCellFromValue(whole)).toBe(whole);

		const cell = sqliteCellFromValue('😀'.repeat(SQLITE_CELL_TEXT_LIMIT + 1));
		expect(cell).toEqual({
			kind: 'text',
			head: '😀'.repeat(SQLITE_CELL_TEXT_LIMIT),
			length: SQLITE_CELL_TEXT_LIMIT + 1,
		});
	});

	it('keeps a BLOB head and its true size', () => {
		const bytes = Buffer.alloc(SQLITE_CELL_BLOB_HEAD_BYTES + 8, 0xab);
		expect(sqliteCellFromValue(bytes)).toEqual({
			kind: 'blob',
			head: 'ab'.repeat(SQLITE_CELL_BLOB_HEAD_BYTES),
			bytes: SQLITE_CELL_BLOB_HEAD_BYTES + 8,
		});
		expect(sqliteCellFromValue(Buffer.alloc(0))).toEqual({ kind: 'blob', head: '', bytes: 0 });
	});

	it('reads INTEGERs and NULL the way the table view does', () => {
		expect(sqliteCellFromValue(BigInt(7))).toBe(7);
		expect(sqliteCellFromValue(null)).toBeNull();
	});
});
