import { describe, expect, it } from 'vitest';

import {
	SQLITE_OBJECT_KINDS,
	formatSqliteRowCount,
	groupSqliteObjects,
	sqliteConvergingRowTotal,
	sqliteObjectTags,
} from '../../../shared/sqlite/objects';
import { quoteSqliteIdentifier } from '../../../shared/sqlite/sql';
import type { SqliteObjectSummary } from '../../../shared/sqlite/types';

function object(overrides: Partial<SqliteObjectSummary>): SqliteObjectSummary {
	return {
		name: 'users',
		kind: 'table',
		tableName: 'users',
		internal: false,
		countable: true,
		hasStorage: true,
		...overrides,
	};
}

describe('groupSqliteObjects', () => {
	const objects = [
		object({ name: 'orders' }),
		object({ name: 'Accounts' }),
		object({ name: 'by_email', kind: 'index', countable: false }),
		object({ name: 'sqlite_sequence', internal: true }),
		object({ name: 'audit', kind: 'trigger', countable: false, hasStorage: false }),
	];

	it('groups in rail order and keeps an entry for every kind', () => {
		const groups = groupSqliteObjects(objects, false);
		expect(groups.map((group) => group.kind)).toEqual([...SQLITE_OBJECT_KINDS]);
		expect(groups.find((group) => group.kind === 'view')?.objects).toEqual([]);
	});

	it('sorts names case-insensitively within a kind', () => {
		const tables = groupSqliteObjects(objects, false)[0].objects.map((entry) => entry.name);
		expect(tables).toEqual(['Accounts', 'orders']);
	});

	it('drops internal objects unless asked for them', () => {
		expect(groupSqliteObjects(objects, false)[0].objects.map((entry) => entry.name)).not.toContain(
			'sqlite_sequence'
		);
		expect(groupSqliteObjects(objects, true)[0].objects.map((entry) => entry.name)).toContain(
			'sqlite_sequence'
		);
	});
});

describe('formatSqliteRowCount', () => {
	it('formats an exact count', () => {
		expect(formatSqliteRowCount({ rowCount: 1204, rowCountCapped: false })).toBe('1,204');
	});

	it('marks a capped count as a lower bound', () => {
		expect(formatSqliteRowCount({ rowCount: 100000, rowCountCapped: true })).toBe('100,000+');
	});

	it('shows zero rows as zero, not as nothing', () => {
		expect(formatSqliteRowCount({ rowCount: 0, rowCountCapped: false })).toBe('0');
	});

	it('returns null when there is no count', () => {
		expect(formatSqliteRowCount(undefined)).toBeNull();
		expect(formatSqliteRowCount({ rowCount: null, rowCountCapped: false })).toBeNull();
	});
});

describe('sqliteConvergingRowTotal', () => {
	const total = (input: Parameters<typeof sqliteConvergingRowTotal>[0]) =>
		formatSqliteRowCount(sqliteConvergingRowTotal(input));

	it('knows nothing before the first window or any count', () => {
		expect(sqliteConvergingRowTotal({ loaded: 0, hasMore: null, count: null })).toEqual({
			rowCount: null,
			rowCountCapped: false,
		});
	});

	it('is a lower bound from the loaded rows while more follow', () => {
		expect(total({ loaded: 300, hasMore: true, count: null })).toBe('300+');
	});

	it('grows with the count, taking the larger of the two bounds', () => {
		expect(total({ loaded: 300, hasMore: true, count: { matched: 40_000, complete: false } })).toBe(
			'40,000+'
		);
		expect(total({ loaded: 600, hasMore: true, count: { matched: 20, complete: false } })).toBe(
			'600+'
		);
		expect(total({ loaded: 0, hasMore: null, count: { matched: 20, complete: false } })).toBe(
			'20+'
		);
	});

	it('is exact once the count settles', () => {
		expect(
			total({ loaded: 300, hasMore: true, count: { matched: 1_204_331, complete: true } })
		).toBe('1,204,331');
	});

	it('is exact once paging reaches the last row, whatever the count says', () => {
		expect(total({ loaded: 12, hasMore: false, count: null })).toBe('12');
		expect(total({ loaded: 12, hasMore: false, count: { matched: 5, complete: false } })).toBe(
			'12'
		);
		expect(total({ loaded: 0, hasMore: false, count: null })).toBe('0');
	});
});

describe('sqliteObjectTags', () => {
	it('names each table flavour', () => {
		expect(sqliteObjectTags(object({ tableType: 'virtual' }))).toEqual(['virtual']);
		expect(sqliteObjectTags(object({ tableType: 'shadow' }))).toEqual(['shadow']);
		expect(sqliteObjectTags(object({ withoutRowid: true, strict: true }))).toEqual([
			'without rowid',
			'strict',
		]);
		expect(sqliteObjectTags(object({ tableType: 'table' }))).toEqual([]);
	});
});

describe('quoteSqliteIdentifier', () => {
	it('wraps a plain name in double quotes', () => {
		expect(quoteSqliteIdentifier('users')).toBe('"users"');
	});

	it('doubles embedded double quotes so the name stays one identifier', () => {
		expect(quoteSqliteIdentifier('we"ird')).toBe('"we""ird"');
		expect(quoteSqliteIdentifier('"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"');
	});

	it('keeps spaces and keywords inside the quotes', () => {
		expect(quoteSqliteIdentifier('order items')).toBe('"order items"');
		expect(quoteSqliteIdentifier('select')).toBe('"select"');
	});
});
