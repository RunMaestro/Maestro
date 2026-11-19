import { describe, expect, it } from 'vitest';

import { formatSqliteCell, formatSqliteRecordValue } from '../../../shared/sqlite/cells';

describe('formatSqliteCell', () => {
	it('spells NULL out as a placeholder, distinct from an empty string', () => {
		expect(formatSqliteCell(null)).toEqual({ text: 'NULL', placeholder: true });
		expect(formatSqliteCell('')).toEqual({ text: '', placeholder: false });
	});

	it('shows numbers and text as themselves', () => {
		expect(formatSqliteCell(42)).toEqual({ text: '42', placeholder: false });
		expect(formatSqliteCell(1.5)).toEqual({ text: '1.5', placeholder: false });
		expect(formatSqliteCell('banana')).toEqual({ text: 'banana', placeholder: false });
	});

	it('shows a big integer exactly', () => {
		expect(formatSqliteCell({ kind: 'integer', text: '9007199254740993' })).toEqual({
			text: '9007199254740993',
			placeholder: false,
		});
	});

	it('ends cut text in an ellipsis', () => {
		expect(formatSqliteCell({ kind: 'text', head: 'abc', length: 9000 })).toEqual({
			text: 'abc…',
			placeholder: false,
		});
	});

	it('summarizes a BLOB by size, as a placeholder', () => {
		expect(formatSqliteCell({ kind: 'blob', head: 'dead', bytes: 2048 })).toEqual({
			text: 'BLOB 2.0 KB',
			placeholder: true,
		});
	});
});

describe('formatSqliteRecordValue', () => {
	it('shows whole values as the grid does, with NULL spelled out', () => {
		expect(formatSqliteRecordValue(null)).toBe('NULL');
		expect(formatSqliteRecordValue('')).toBe('');
		expect(formatSqliteRecordValue(42)).toBe('42');
		expect(formatSqliteRecordValue('line one\nline two')).toBe('line one\nline two');
		expect(formatSqliteRecordValue({ kind: 'integer', text: '9007199254740993' })).toBe(
			'9007199254740993'
		);
	});

	it('says how much of a cut text value arrived', () => {
		expect(formatSqliteRecordValue({ kind: 'text', head: 'abc', length: 9000 })).toBe(
			'abc…\n\n(9,000 characters; the first 3 are shown)'
		);
	});

	it('shows a BLOB as its size over its leading bytes in spaced hex', () => {
		expect(formatSqliteRecordValue({ kind: 'blob', head: 'deadbeef', bytes: 2048 })).toBe(
			'BLOB 2.0 KB\nde ad be ef …'
		);
	});

	it('drops the ellipsis when the whole BLOB arrived, and the hex line when it is empty', () => {
		expect(formatSqliteRecordValue({ kind: 'blob', head: 'cafe', bytes: 2 })).toBe(
			'BLOB 2 B\nca fe'
		);
		expect(formatSqliteRecordValue({ kind: 'blob', head: '', bytes: 0 })).toBe('BLOB 0 B');
	});
});
