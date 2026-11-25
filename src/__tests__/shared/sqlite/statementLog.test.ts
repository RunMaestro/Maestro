import { describe, expect, it } from 'vitest';

import {
	SQLITE_STATEMENT_LOG_ERROR_CHARS,
	SQLITE_STATEMENT_LOG_MAX_ENTRIES,
	SQLITE_STATEMENT_LOG_MAX_FILES,
	SQLITE_STATEMENT_LOG_MAX_SQL_CHARS,
	SQLITE_STATEMENT_LOG_VALUE_CHARS,
	addSqliteStatementLogEntry,
	emptySqliteStatementLogStore,
	formatSqliteParameterValue,
	formatSqliteStatementLogOutcome,
	parseSqliteStatementLogStore,
	pruneSqliteStatementLogStore,
	sqliteLogLiteral,
	sqliteRowKeyText,
	sqliteRowWriteStatement,
	sqliteStatementLogStanding,
	sqliteStatementLogStandingText,
	sqliteStatementLogTransactionEnds,
} from '../../../shared/sqlite/statementLog';
import type { SqliteStatementLogEntry } from '../../../shared/sqlite/types';

function entry(overrides: Partial<SqliteStatementLogEntry> = {}): SqliteStatementLogEntry {
	return {
		id: 'e1',
		kind: 'query',
		sql: 'DELETE FROM t',
		params: {},
		table: null,
		transactionId: null,
		at: 1,
		outcome: { ok: true, changes: 1, otherChanges: 0, schemaChanges: [] },
		...overrides,
	};
}

describe('sqliteLogLiteral', () => {
	it('writes each kind of value as SQL text', () => {
		expect(sqliteLogLiteral(null)).toBe('NULL');
		expect(sqliteLogLiteral({ type: 'null', text: 'ignored' })).toBe('NULL');
		expect(sqliteLogLiteral({ type: 'integer', text: '9007199254740993' })).toBe(
			'9007199254740993'
		);
		expect(sqliteLogLiteral({ type: 'number', text: ' 2.5 ' })).toBe('2.5');
		expect(sqliteLogLiteral({ type: 'text', text: "O'Brien" })).toBe("'O''Brien'");
		expect(sqliteLogLiteral({ type: 'blob', text: '89504e47' })).toBe("X'89504e47'");
	});

	it('cuts a long value and says how long it was', () => {
		const long = sqliteLogLiteral({ type: 'text', text: 'a'.repeat(5000) });
		expect(long.startsWith(`'${'a'.repeat(SQLITE_STATEMENT_LOG_VALUE_CHARS)}...'`)).toBe(true);
		expect(long).toContain('/* 5,000 characters, cut */');
		const blob = sqliteLogLiteral({ type: 'blob', text: 'ab'.repeat(1000) });
		expect(blob).toContain('/* 1,000 bytes, cut */');
	});
});

describe('sqliteRowWriteStatement', () => {
	it('spells a cell edit, an insert, and a delete as a person would type them', () => {
		expect(
			sqliteRowWriteStatement({
				kind: 'cell',
				table: 'users',
				column: 'name',
				row: { kind: 'primary-key', values: { id: { type: 'integer', text: '3' } } },
				value: { type: 'text', text: 'Bob' },
			})
		).toBe("UPDATE users SET name = 'Bob' WHERE id = 3");
		expect(
			sqliteRowWriteStatement({
				kind: 'insert',
				table: 'order items',
				values: { qty: { type: 'number', text: '2' }, note: null },
			})
		).toBe('INSERT INTO "order items" (qty, note) VALUES (2, NULL)');
		expect(sqliteRowWriteStatement({ kind: 'insert', table: 't', values: {} })).toBe(
			'INSERT INTO t DEFAULT VALUES'
		);
		expect(
			sqliteRowWriteStatement({
				kind: 'insert',
				table: 't',
				values: { a: { type: 'blob', text: '00' } },
				rowid: '7',
			})
		).toBe("INSERT INTO t (rowid, a) VALUES (7, X'00')");
		expect(
			sqliteRowWriteStatement({
				kind: 'delete',
				table: 'select',
				row: { kind: 'rowid', rowid: '7' },
			})
		).toBe('DELETE FROM "select" WHERE rowid = 7');
	});

	it('names a composite key with every column, and a NULL with IS', () => {
		expect(
			sqliteRowKeyText({
				kind: 'primary-key',
				values: { a: { type: 'text', text: 'x' }, b: null },
			})
		).toBe("a = 'x' AND b IS NULL");
	});
});

describe('addSqliteStatementLogEntry', () => {
	it('puts the entry on top, never merging a repeat, and caps the log', () => {
		let entries: SqliteStatementLogEntry[] = [];
		for (let index = 0; index < SQLITE_STATEMENT_LOG_MAX_ENTRIES + 5; index += 1) {
			entries = addSqliteStatementLogEntry(entries, entry({ id: `e${index}`, at: index }));
		}
		expect(entries).toHaveLength(SQLITE_STATEMENT_LOG_MAX_ENTRIES);
		expect(entries[0].id).toBe(`e${SQLITE_STATEMENT_LOG_MAX_ENTRIES + 4}`);
	});

	it('keeps a long statement cut (never skipped), and cuts a long error', () => {
		const [kept] = addSqliteStatementLogEntry(
			[],
			entry({
				sql: `  ${'x'.repeat(SQLITE_STATEMENT_LOG_MAX_SQL_CHARS + 10)}  `,
				outcome: { ok: false, error: 'e'.repeat(SQLITE_STATEMENT_LOG_ERROR_CHARS + 10) },
			})
		);
		expect(kept.sql).toContain('/* cut: the statement was');
		expect(kept.outcome.ok === false && kept.outcome.error.length).toBe(
			SQLITE_STATEMENT_LOG_ERROR_CHARS
		);
	});
});

describe('the store', () => {
	it('keeps only the most recently written databases', () => {
		const store = emptySqliteStatementLogStore();
		for (let index = 0; index < SQLITE_STATEMENT_LOG_MAX_FILES + 2; index += 1) {
			store.files[`/db/${index}.db`] = { usedAt: index, entries: [entry()] };
		}
		const pruned = pruneSqliteStatementLogStore(store);
		expect(Object.keys(pruned.files)).toHaveLength(SQLITE_STATEMENT_LOG_MAX_FILES);
		expect(pruned.files['/db/0.db']).toBeUndefined();
		expect(pruneSqliteStatementLogStore(emptySqliteStatementLogStore())).toEqual(
			emptySqliteStatementLogStore()
		);
	});

	it('parses a stored file, dropping a bad entry and keeping its neighbours', () => {
		const good = entry({
			kind: 'commit',
			transactionId: 't1',
			note: 'Committed.',
			backupPath: '/b.db',
			params: { ':id': { type: 'number', text: '3' } },
			outcome: {
				ok: true,
				changes: 2,
				otherChanges: 1,
				schemaChanges: [{ change: 'created', type: 'table', name: 'logs' }],
			},
		});
		const parsed = parseSqliteStatementLogStore({
			files: {
				'/a.db': { usedAt: 5, entries: [good, { ...good, kind: 'nonsense' }, 'junk'] },
				'/b.db': { entries: [{ ...good, outcome: { ok: true } }] },
				'/c.db': 'junk',
			},
		});
		expect(parsed.files['/a.db']).toEqual({ usedAt: 5, entries: [good] });
		expect(parsed.files['/b.db']).toBeUndefined();
		expect(parsed.files['/c.db']).toBeUndefined();
		expect(parseSqliteStatementLogStore('junk')).toEqual(emptySqliteStatementLogStore());
	});
});

describe('where a write stands', () => {
	const log = [
		entry({ id: 'c', kind: 'commit', transactionId: 'committed', sql: 'COMMIT' }),
		entry({ id: 'w1', transactionId: 'committed' }),
		entry({ id: 'r', kind: 'rollback', transactionId: 'rolled', sql: 'ROLLBACK' }),
		entry({ id: 'w2', transactionId: 'rolled' }),
		entry({ id: 'w3', transactionId: 'open' }),
		entry({ id: 'f', outcome: { ok: false, error: 'UNIQUE constraint failed' } }),
		entry({ id: 'plain' }),
		entry({
			id: 'refused-commit',
			kind: 'commit',
			transactionId: 'open',
			outcome: { ok: false, error: 'FOREIGN KEY constraint failed' },
		}),
	];
	const ends = sqliteStatementLogTransactionEnds(log);
	const standing = (id: string) =>
		sqliteStatementLogStanding(log.find((item) => item.id === id) as SqliteStatementLogEntry, ends);

	it('reads each transaction end, ignoring a refused Commit', () => {
		expect([...ends.entries()]).toEqual([
			['committed', 'commit'],
			['rolled', 'rollback'],
		]);
	});

	it('says whether each write is in the file', () => {
		expect(standing('w1')).toBe('in-file');
		expect(standing('w2')).toBe('rolled-back');
		expect(standing('w3')).toBe('uncommitted');
		expect(standing('f')).toBe('failed');
		expect(standing('plain')).toBe('in-file');
		expect(standing('c')).toBe('in-file');
		expect(standing('refused-commit')).toBe('failed');
		expect(sqliteStatementLogStandingText('rolled-back')).toBe('rolled back, not in the file');
		expect(sqliteStatementLogStandingText('uncommitted')).toBe('in a transaction, not committed');
		expect(sqliteStatementLogStandingText('in-file')).toBe('');
	});
});

describe('formatSqliteStatementLogOutcome', () => {
	it('says what each kind of entry did', () => {
		expect(formatSqliteStatementLogOutcome(entry())).toBe('changed 1 row');
		expect(
			formatSqliteStatementLogOutcome(
				entry({ outcome: { ok: true, changes: 1, otherChanges: 2, schemaChanges: [] } })
			)
		).toBe('changed 1 row (+2 by triggers)');
		expect(
			formatSqliteStatementLogOutcome(
				entry({
					outcome: {
						ok: true,
						changes: 0,
						otherChanges: 0,
						schemaChanges: [{ change: 'created', type: 'table', name: 'logs' }],
					},
				})
			)
		).toBe('created table logs');
		expect(formatSqliteStatementLogOutcome(entry({ kind: 'begin' }))).toBe('began a transaction');
		expect(formatSqliteStatementLogOutcome(entry({ kind: 'rollback' }))).toBe('rolled back');
		expect(
			formatSqliteStatementLogOutcome(
				entry({
					kind: 'commit',
					outcome: { ok: true, changes: 3, otherChanges: 0, schemaChanges: [] },
				})
			)
		).toBe('committed: changed 3 rows');
		expect(formatSqliteStatementLogOutcome(entry({ outcome: { ok: false, error: 'nope' } }))).toBe(
			'failed'
		);
	});

	it('writes a parameter value for a listing', () => {
		expect(formatSqliteParameterValue({ type: 'null', text: '' })).toBe('NULL');
		expect(formatSqliteParameterValue({ type: 'text', text: 'a"b' })).toBe('"a\\"b"');
		expect(formatSqliteParameterValue({ type: 'number', text: '42' })).toBe('"42" (number)');
	});
});
