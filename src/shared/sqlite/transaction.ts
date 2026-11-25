/**
 * Query mode's explicit transaction: one transaction held open across
 * several statements, then committed or rolled back as a whole.
 *
 * With the tab's editing unlock on, Begin transaction (`maestro-cli sqlite
 * transaction`) opens `BEGIN IMMEDIATE` in a SQLite child process of its own
 * (src/main/sqlite/sqlite-transaction.ts) after the write gate and the
 * session's backup. Every Run then goes to that connection, reads included,
 * so a statement sees what the ones before it changed. The result of each
 * says what it changed and what the transaction holds so far
 * (`formatSqliteTransaction()`), and nothing reaches the file until Commit.
 * Roll back, Lock, closing the database, a stopped statement, and
 * `SQLITE_TRANSACTION_IDLE_MS` with nothing done all roll it back
 * (`sqliteTransactionEndReason()` says which).
 *
 * While it is open it holds the file's write lock, so every other write to
 * the file, from any tab, is refused (`SQLITE_TRANSACTION_OPEN_MESSAGE`), and
 * other programs wait on it. That is why it rolls back on its own when idle.
 *
 * Shared by main (which keeps the transaction), the Query panel, and the CLI.
 */

import { formatCount } from '../formatters';
import { sqliteSchemaChangesText } from './dryRun';
import { SQLITE_QUERY_TIMEOUT_MS } from './query';
import type { SqliteTransactionState } from './types';

/**
 * How long an open transaction may sit with no statement, Commit, or Roll
 * back before it is rolled back. It holds the file's write lock, which keeps
 * every other writer (often a live application) waiting.
 */
export const SQLITE_TRANSACTION_IDLE_MS = 10 * 60_000;

/** Another write to a file that has a transaction open (any tab, any write path). */
export const SQLITE_TRANSACTION_OPEN_MESSAGE =
	'A transaction is open on this database in Query mode and holds its write lock. Commit it or roll it back first.';

/** Begin, when this tab already has a transaction open. */
export const SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE =
	'A transaction is already open in this tab. Commit it or roll it back first.';

/** A run, Commit, or Roll back that names no transaction open in this tab. */
export const SQLITE_TRANSACTION_GONE_MESSAGE =
	'That transaction is no longer open, so nothing ran in it.';

/** A run or an end while a statement still runs in the transaction. */
export const SQLITE_TRANSACTION_BUSY_MESSAGE =
	'A statement is still running in this transaction. Wait for it, or Stop it (which rolls the whole transaction back).';

/** A statement in the transaction was stopped: the only way to stop it ends the transaction. */
export const SQLITE_TRANSACTION_STOPPED_MESSAGE =
	'The statement was stopped, and with it the whole transaction: every statement run in it was rolled back.';

/** Why a transaction ended without a Commit. */
export type SqliteTransactionRollbackCause =
	| 'rollback'
	| 'idle'
	| 'locked'
	| 'closed'
	| 'stopped'
	| 'timeout'
	| 'sqlite'
	| 'crashed';

function plural(count: number, one: string, many = `${one}s`): string {
	return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * What a transaction holds: "2 statements: 5 rows changed, and 3 other rows
 * by triggers and foreign-key actions; created index logs_at". Shared by the
 * panel's transaction strip, the end reasons, and the CLI.
 */
export function formatSqliteTransactionChanges(state: SqliteTransactionState): string {
	const parts: string[] = [];
	if (state.changes > 0 || state.schemaChanges.length === 0) {
		parts.push(`${plural(state.changes, 'row')} changed`);
	}
	if (state.otherChanges > 0) {
		parts.push(
			`${parts.length > 0 ? 'and ' : ''}${plural(state.otherChanges, 'other row')} by triggers and foreign-key actions`
		);
	}
	const rows = parts.join(', ');
	const schema = sqliteSchemaChangesText(state.schemaChanges, true).join('; ');
	const what = [rows, schema].filter(Boolean).join('; ');
	return `${plural(state.statements, 'statement')}: ${what}`;
}

/** The open transaction, as the panel's strip and the CLI say it. */
export function formatSqliteTransaction(state: SqliteTransactionState): string {
	return `Transaction open, ${formatSqliteTransactionChanges(state)}. Nothing is in the file until Commit.`;
}

/** Why and how a transaction ended, one sentence, for a commit or each kind of rollback. */
export function sqliteTransactionEndReason(
	outcome: { committed: true } | { committed: false; cause: SqliteTransactionRollbackCause },
	state: SqliteTransactionState
): string {
	const held = formatSqliteTransactionChanges(state);
	if (outcome.committed) return `Committed ${held}. These changes are now in the file.`;
	const why: Record<SqliteTransactionRollbackCause, string> = {
		rollback: 'Rolled back',
		idle: `Rolled back after ${Math.round(SQLITE_TRANSACTION_IDLE_MS / 60_000)} minutes with no statement, Commit, or Roll back`,
		locked: 'Rolled back because editing was locked',
		closed: 'Rolled back because the database was closed',
		stopped: 'Rolled back because a statement in it was stopped',
		timeout: `Rolled back because a statement in it ran past ${Math.round(SQLITE_QUERY_TIMEOUT_MS / 1000)} s`,
		sqlite: 'SQLite rolled the whole transaction back when the statement failed',
		crashed: 'Rolled back because its process ended unexpectedly',
	};
	return `${why[outcome.cause]}. Nothing it held was kept (${held}).`;
}
