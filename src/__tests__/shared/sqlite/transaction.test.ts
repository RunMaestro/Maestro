import { describe, expect, it } from 'vitest';

import {
	SQLITE_TRANSACTION_IDLE_MS,
	formatSqliteTransaction,
	formatSqliteTransactionChanges,
	sqliteTransactionEndReason,
} from '../../../shared/sqlite/transaction';
import { sqliteTransactionRefusal } from '../../../shared/sqlite/query';
import type { SqliteTransactionState } from '../../../shared/sqlite/types';

function state(overrides: Partial<SqliteTransactionState> = {}): SqliteTransactionState {
	return {
		transactionId: 'x1',
		startedAt: 1,
		expiresAt: 1 + SQLITE_TRANSACTION_IDLE_MS,
		statements: 0,
		changes: 0,
		otherChanges: 0,
		schemaChanges: [],
		...overrides,
	};
}

describe('formatSqliteTransactionChanges', () => {
	it('says an empty transaction changed nothing', () => {
		expect(formatSqliteTransactionChanges(state())).toBe('0 statements: 0 rows changed');
	});

	it('counts statements, rows, and rows triggers and foreign-key actions changed', () => {
		expect(
			formatSqliteTransactionChanges(state({ statements: 2, changes: 1_234, otherChanges: 1 }))
		).toBe('2 statements: 1,234 rows changed, and 1 other row by triggers and foreign-key actions');
		expect(formatSqliteTransactionChanges(state({ statements: 1, changes: 1 }))).toBe(
			'1 statement: 1 row changed'
		);
	});

	it('names the schema it changed, without a rows part when no row changed', () => {
		expect(
			formatSqliteTransactionChanges(
				state({
					statements: 1,
					schemaChanges: [{ change: 'created', type: 'index', name: 'logs_at' }],
				})
			)
		).toBe('1 statement: created index logs_at');
		expect(
			formatSqliteTransactionChanges(
				state({
					statements: 3,
					changes: 4,
					schemaChanges: [
						{ change: 'created', type: 'table', name: 'logs' },
						{ change: 'altered', type: 'table', name: 'users' },
					],
				})
			)
		).toBe('3 statements: 4 rows changed; created table logs; altered table users');
	});
});

describe('formatSqliteTransaction', () => {
	it('says the transaction is open and that nothing is in the file yet', () => {
		expect(formatSqliteTransaction(state({ statements: 1, changes: 3 }))).toBe(
			'Transaction open, 1 statement: 3 rows changed. Nothing is in the file until Commit.'
		);
	});
});

describe('sqliteTransactionEndReason', () => {
	const held = state({ statements: 2, changes: 3 });

	it('says a commit put the changes in the file', () => {
		expect(sqliteTransactionEndReason({ committed: true }, held)).toBe(
			'Committed 2 statements: 3 rows changed. These changes are now in the file.'
		);
	});

	it('says why each rollback happened and that nothing was kept', () => {
		const reason = (cause: Parameters<typeof sqliteTransactionEndReason>[0]) =>
			sqliteTransactionEndReason(cause, held);
		expect(reason({ committed: false, cause: 'rollback' })).toBe(
			'Rolled back. Nothing it held was kept (2 statements: 3 rows changed).'
		);
		expect(reason({ committed: false, cause: 'idle' })).toMatch(
			/^Rolled back after 10 minutes with no statement, Commit, or Roll back\./
		);
		expect(reason({ committed: false, cause: 'locked' })).toMatch(/because editing was locked/);
		expect(reason({ committed: false, cause: 'closed' })).toMatch(/database was closed/);
		expect(reason({ committed: false, cause: 'stopped' })).toMatch(/was stopped/);
		expect(reason({ committed: false, cause: 'timeout' })).toMatch(/ran past 60 s/);
		expect(reason({ committed: false, cause: 'sqlite' })).toMatch(
			/^SQLite rolled the whole transaction back/
		);
		expect(reason({ committed: false, cause: 'crashed' })).toMatch(/ended unexpectedly/);
	});
});

describe('sqliteTransactionRefusal', () => {
	it('points a typed BEGIN at the transaction the viewer keeps', () => {
		expect(sqliteTransactionRefusal('BEGIN')).toMatch(
			/^BEGIN is refused here: .* use Begin transaction, then Commit or Roll back\.$/
		);
	});
});
