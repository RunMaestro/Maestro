import { describe, it, expect } from 'vitest';

import {
	formatSqliteColumnReferences,
	formatSqliteEditability,
	formatSqliteForeignKey,
	formatSqliteIndexColumn,
	formatSqliteReference,
	sqliteColumnAffinity,
	sqliteColumnTags,
	sqliteEditabilityLabel,
	sqliteMissingSqlNote,
} from '../../../shared/sqlite/schema';
import type { SqliteColumnSchema } from '../../../shared/sqlite/types';

function column(overrides: Partial<SqliteColumnSchema> = {}): SqliteColumnSchema {
	return {
		name: 'id',
		declaredType: 'INTEGER',
		affinity: 'INTEGER',
		notNull: false,
		defaultValue: null,
		primaryKeyPosition: 0,
		references: [],
		...overrides,
	};
}

describe('sqliteColumnAffinity', () => {
	it.each([
		['INT', 'INTEGER'],
		['integer', 'INTEGER'],
		['TINYINT', 'INTEGER'],
		['UNSIGNED BIG INT', 'INTEGER'],
		['VARCHAR(255)', 'TEXT'],
		['NCHAR(55)', 'TEXT'],
		['CLOB', 'TEXT'],
		['text', 'TEXT'],
		['BLOB', 'BLOB'],
		['', 'BLOB'],
		['   ', 'BLOB'],
		['REAL', 'REAL'],
		['DOUBLE PRECISION', 'REAL'],
		['FLOAT', 'REAL'],
		['NUMERIC', 'NUMERIC'],
		['DECIMAL(10,5)', 'NUMERIC'],
		['BOOLEAN', 'NUMERIC'],
		['DATETIME', 'NUMERIC'],
	])('gives %j the %s affinity', (declared, affinity) => {
		expect(sqliteColumnAffinity(declared)).toBe(affinity);
	});

	it('applies the rules in order and by substring, as SQLite does', () => {
		// Rule 1 beats rule 2: CHARINT holds both INT and CHAR.
		expect(sqliteColumnAffinity('CHARINT')).toBe('INTEGER');
		// POINT contains INT.
		expect(sqliteColumnAffinity('FLOATING POINT')).toBe('INTEGER');
		// STRING matches no rule's substring.
		expect(sqliteColumnAffinity('STRING')).toBe('NUMERIC');
	});

	it('treats ANY as no conversion in a STRICT table and as NUMERIC elsewhere', () => {
		expect(sqliteColumnAffinity('ANY', true)).toBe('BLOB');
		expect(sqliteColumnAffinity('ANY')).toBe('NUMERIC');
		expect(sqliteColumnAffinity('INT', true)).toBe('INTEGER');
	});
});

describe('reference formatting', () => {
	it('names the parent column, or the primary key when the key names none', () => {
		expect(formatSqliteReference({ table: 'users', column: 'email' })).toBe('users.email');
		expect(formatSqliteReference({ table: 'users', column: null })).toBe('users (primary key)');
	});

	it('joins every reference a column makes', () => {
		expect(
			formatSqliteColumnReferences(
				column({
					references: [
						{ table: 'a', column: 'x' },
						{ table: 'b', column: null },
					],
				})
			)
		).toBe('a.x, b (primary key)');
		expect(formatSqliteColumnReferences(column())).toBe('');
	});

	it('spells a whole foreign key with its non-default actions', () => {
		expect(
			formatSqliteForeignKey({
				table: 'pairs',
				from: ['a', 'b'],
				to: ['x', 'y'],
				onUpdate: 'SET NULL',
				onDelete: 'NO ACTION',
			})
		).toBe('(a, b) -> pairs(x, y) ON UPDATE SET NULL');
		expect(
			formatSqliteForeignKey({
				table: 'users',
				from: ['uid'],
				to: [null],
				onUpdate: 'NO ACTION',
				onDelete: 'CASCADE',
			})
		).toBe('(uid) -> users (primary key) ON DELETE CASCADE');
	});
});

describe('column and index labels', () => {
	it('tags constraints a column carries', () => {
		expect(sqliteColumnTags(column({ notNull: true, generated: 'stored', hidden: true }))).toEqual([
			'not null',
			'generated (stored)',
			'hidden',
		]);
		expect(sqliteColumnTags(column())).toEqual([]);
	});

	it('labels an indexed expression', () => {
		expect(formatSqliteIndexColumn({ name: 'email', descending: false, collation: 'BINARY' })).toBe(
			'email'
		);
		expect(formatSqliteIndexColumn({ name: null, descending: false, collation: 'NOCASE' })).toBe(
			'<expression>'
		);
	});

	it('explains a missing CREATE statement only when there is none', () => {
		expect(sqliteMissingSqlNote({ kind: 'table', sql: 'CREATE TABLE t(a)' })).toBeNull();
		expect(sqliteMissingSqlNote({ kind: 'index', sql: null })).toMatch(/UNIQUE or PRIMARY KEY/);
	});
});

describe('editability text', () => {
	it('says a rowid table is keyed by rowid, naming the column that is the rowid', () => {
		const editability = {
			editable: true as const,
			identity: { kind: 'rowid' as const, alias: 'rowid', rowidColumn: 'id' },
			readOnlyColumns: [],
		};
		expect(sqliteEditabilityLabel(editability)).toBe('rows keyed by rowid');
		expect(formatSqliteEditability(editability)).toBe(
			'Editable. An edit names its row by rowid, which is the column id.'
		);
		expect(
			formatSqliteEditability({
				...editability,
				identity: { ...editability.identity, rowidColumn: null },
			})
		).toBe('Editable. An edit names its row by rowid.');
	});

	it('names the primary key, warns about a NULL key, and lists generated columns', () => {
		const editability = {
			editable: true as const,
			identity: { kind: 'primary-key' as const, columns: ['a', 'b'], keyMayBeNull: true },
			readOnlyColumns: [{ name: 'full', reason: 'generated' }],
		};
		expect(sqliteEditabilityLabel(editability)).toBe('rows keyed by primary key');
		expect(formatSqliteEditability(editability)).toBe(
			'Editable. An edit names its row by the primary key (a, b). A row whose key holds NULL cannot be edited. Generated columns cannot be edited: full.'
		);
	});

	it('gives the short code and the whole reason for a read-only object', () => {
		const editability = {
			editable: false as const,
			code: 'virtual-table' as const,
			reason: 'docs is a virtual table (module fts5).',
		};
		expect(sqliteEditabilityLabel(editability)).toBe('read-only: virtual table');
		expect(formatSqliteEditability(editability)).toBe(
			'Read-only. docs is a virtual table (module fts5).'
		);
	});
});
