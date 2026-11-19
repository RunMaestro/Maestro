import { describe, expect, it } from 'vitest';

import { formatSqliteCell } from '../../../shared/sqlite/cells';

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
