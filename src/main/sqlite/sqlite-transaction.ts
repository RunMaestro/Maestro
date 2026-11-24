/**
 * SQLite Explicit Transactions
 *
 * Query mode's Begin transaction, Commit, and Roll back: one transaction held
 * open across several statements a person runs, then kept or discarded as a
 * whole. Shared by the `sqlite:*Transaction` IPC handlers and the
 * `sqlite_run_transaction` WS handler (`maestro-cli sqlite transaction`), so
 * both go through the same gate, child, and end.
 *
 * A transaction belongs to one tab's editing grant (`editToken`), at most one
 * per grant and one per file:
 *
 *   - Begin passes the write gate and takes the session's backup
 *     (`beginSqliteWorkerWrite()`: the transaction may commit), marks the
 *     file's write lock held (`holdSqliteTransaction()`: every other write to
 *     the file is refused from here), and starts a SQLite child that holds
 *     `BEGIN IMMEDIATE` on a writable connection (`openSqliteTransactionTask()`
 *     through `startSqliteWorkerSession()`). A child, as for every Query-mode
 *     write, because better-sqlite3 cannot interrupt a statement.
 *   - Every Run of that tab with `transactionId` goes to the child
 *     (`runInSqliteTransaction()`, called by `runSqliteQuery()`), reads
 *     included, one at a time, each with the query timeout. Its result says
 *     what the statement changed and what the transaction holds so far.
 *   - Commit sends `COMMIT`. When SQLite refuses it but keeps the transaction
 *     (a deferred foreign key, a busy file), it stays open for Roll back or
 *     another try. Roll back sends `ROLLBACK`.
 *   - It is rolled back, and the end says why (`sqliteTransactionEndReason()`),
 *     when: its tab locks or its database closes (the grant's revocation),
 *     `SQLITE_TRANSACTION_IDLE_MS` pass with no request (it holds the write
 *     lock someone's application may be waiting on), a statement in it is
 *     stopped (Stop, or a run under the same `queryId`) or times out (the only
 *     way to stop a statement is to kill the child), SQLite rolls it back
 *     itself after a failure, or the child dies. A graceful `ROLLBACK` is sent
 *     when nothing is in flight; otherwise the child is killed, and SQLite's
 *     journal rolls the transaction back.
 *
 * The end of the tab's last transaction is kept for `readSqliteTransaction()`,
 * so a panel that finds its transaction gone can say how it ended.
 *
 * The database's statement log (sqlite-statement-log.ts) records the Begin,
 * every write run in it (under its id), and the end, however it came:
 * `finish()` is the one place an end is recorded, and an end call answers
 * only once it is logged. A statement that fails in it changed nothing and
 * is not logged; when SQLite rolled the transaction back for it, the logged
 * end says so. A Commit SQLite refused but kept open is logged as failed.
 */

import { randomUUID } from 'crypto';

import { sqliteStatementParameterValues } from '../../shared/sqlite/history';
import { SQLITE_QUERY_TIMEOUT_MS } from '../../shared/sqlite/query';
import {
	SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE,
	SQLITE_TRANSACTION_BUSY_MESSAGE,
	SQLITE_TRANSACTION_GONE_MESSAGE,
	SQLITE_TRANSACTION_IDLE_MS,
	SQLITE_TRANSACTION_STOPPED_MESSAGE,
	sqliteTransactionEndReason,
	type SqliteTransactionRollbackCause,
} from '../../shared/sqlite/transaction';
import type {
	SqliteQueryResult,
	SqliteTransactionEnd,
	SqliteTransactionEndRequest,
	SqliteTransactionRequest,
	SqliteTransactionState,
	SqliteTransactionStatus,
} from '../../shared/sqlite/types';
import { logger } from '../utils/logger';
import { reportSqliteBusy } from './sqlite-connection';
import {
	beginSqliteWorkerWrite,
	holdSqliteTransaction,
	onSqliteEditingRevoked,
	requireSqliteEditing,
} from './sqlite-editing';
import {
	SQLITE_QUERY_REFUSED,
	type SqliteTransactionReply,
	type SqliteTransactionRunTask,
	type SqliteTransactionTotals,
} from './sqlite-query-task';
import {
	logSqliteStatement,
	sqliteLoggedBackup,
	sqliteLoggedChanges,
	sqliteLoggedFailure,
} from './sqlite-statement-log';
import { startSqliteWorkerSession, type SqliteWorkerSession } from './sqlite-worker-runner';
import type { SqliteWorkerSessionReply } from './sqlite-worker-task';

/** How long a graceful `ROLLBACK` may take before the child is killed instead. */
const GRACEFUL_ROLLBACK_MS = 5_000;

/** Ended transactions kept for `readSqliteTransaction()`, newest last. */
const MAX_KEPT_ENDS = 64;

interface OpenTransaction {
	handle: string;
	editToken: string;
	/** The database's path, which its statement log is kept under. */
	databasePath: string;
	transactionId: string;
	startedAt: number;
	expiresAt: number;
	totals: SqliteTransactionTotals;
	/** `BEGIN IMMEDIATE` succeeded: from here its end is recorded. */
	began: boolean;
	session: SqliteWorkerSession<'transaction'>;
	/** The request in flight, so the end it causes is told right. */
	pendingOp: 'run' | 'commit' | 'rollback' | null;
	/** Why it is being rolled back, set by whoever started the rollback. */
	cause: SqliteTransactionRollbackCause | null;
	/** How it ended, once it has. */
	end: SqliteTransactionEnd | null;
	/** Settles once its end is in the statement log, so an end call answers after it. */
	endLogged: Promise<void>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	requestTimer: ReturnType<typeof setTimeout> | null;
	releaseHold: () => void;
	unhook: () => void;
}

/** Open transactions by edit token: one per tab grant. */
const openTransactions = new Map<string, OpenTransaction>();

/** The last end per edit token, oldest first, capped at `MAX_KEPT_ENDS`. */
const lastEnds = new Map<string, SqliteTransactionEnd>();

/** A refusal raised before anything ran: never recorded in the query history. */
function refused(message: string): Error {
	return Object.assign(new Error(message), { code: SQLITE_QUERY_REFUSED });
}

function stateOf(entry: OpenTransaction): SqliteTransactionState {
	return {
		transactionId: entry.transactionId,
		startedAt: entry.startedAt,
		expiresAt: entry.expiresAt,
		statements: entry.totals.statements,
		changes: entry.totals.changes,
		otherChanges: entry.totals.otherChanges,
		schemaChanges: [...entry.totals.schemaChanges],
	};
}

function clearTimers(entry: OpenTransaction): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	if (entry.requestTimer) clearTimeout(entry.requestTimer);
	entry.idleTimer = null;
	entry.requestTimer = null;
}

/** Start the idle clock again: nothing is in flight, and the transaction is still open. */
function armIdle(entry: OpenTransaction): void {
	if (openTransactions.get(entry.editToken) !== entry) return;
	clearTimers(entry);
	entry.expiresAt = Date.now() + SQLITE_TRANSACTION_IDLE_MS;
	entry.idleTimer = setTimeout(() => rollBack(entry, 'idle'), SQLITE_TRANSACTION_IDLE_MS);
}

/**
 * Send one request to the child, with the query timeout and no idle clock
 * while it runs. A request that outlives the timeout rolls the whole
 * transaction back. A failure that leaves the transaction open re-arms it.
 */
function send(
	entry: OpenTransaction,
	op: Parameters<SqliteWorkerSession<'transaction'>['request']>[0]
): Promise<SqliteTransactionReply> {
	clearTimers(entry);
	entry.pendingOp = op.op;
	entry.requestTimer = setTimeout(() => rollBack(entry, 'timeout'), SQLITE_QUERY_TIMEOUT_MS);
	return entry.session.request(op).then(
		(reply) => {
			entry.totals = reply.totals;
			armIdle(entry);
			return reply;
		},
		(error: unknown) => {
			armIdle(entry);
			throw error;
		}
	);
}

/**
 * Roll the transaction back for `cause`: a graceful `ROLLBACK` when nothing
 * is in flight, else kill the child (SQLite's journal rolls it back). The
 * request in flight, if any, is rejected in the cause's words.
 */
function rollBack(entry: OpenTransaction, cause: SqliteTransactionRollbackCause): void {
	if (entry.end || entry.cause) return;
	entry.cause = cause;
	clearTimers(entry);
	const reason = sqliteTransactionEndReason({ committed: false, cause }, stateOf(entry));
	if (entry.session.busy || cause === 'stopped' || cause === 'timeout') {
		entry.session.stop(cause === 'stopped' ? SQLITE_TRANSACTION_STOPPED_MESSAGE : reason);
		return;
	}
	entry.pendingOp = 'rollback';
	const fallback = setTimeout(() => entry.session.stop(reason), GRACEFUL_ROLLBACK_MS);
	entry.session.request({ op: 'rollback' }).then(
		() => clearTimeout(fallback),
		(error: unknown) => {
			// Killing the child rolls back just as surely.
			clearTimeout(fallback);
			logger.warn('A graceful ROLLBACK failed; stopping the transaction', 'SqliteTransaction', {
				error: error instanceof Error ? error.message : String(error),
			});
			entry.session.stop(reason);
		}
	);
}

/**
 * The session ended, however it ended: release the write lock and the grant
 * hook, and record how it ended. `reply` is the child's last reply when it
 * closed the session itself.
 */
function finish(
	entry: OpenTransaction,
	error: Error | null,
	reply: SqliteWorkerSessionReply | null
): void {
	clearTimers(entry);
	entry.releaseHold();
	entry.unhook();
	if (openTransactions.get(entry.editToken) === entry) openTransactions.delete(entry.editToken);
	// A Begin that failed opened nothing: its caller hears why, and there is no end to keep.
	if (!entry.began) return;
	if (reply?.ok) entry.totals = (reply.result as SqliteTransactionReply).totals;
	const committed = error === null && reply?.ok === true && entry.pendingOp === 'commit';
	let cause: SqliteTransactionRollbackCause;
	if (entry.cause) cause = entry.cause;
	else if (error) cause = 'crashed';
	else if (entry.pendingOp === 'rollback') cause = 'rollback';
	// The child closed after a failed run or commit: SQLite ended the transaction.
	else cause = 'sqlite';
	const state = stateOf(entry);
	const end: SqliteTransactionEnd = {
		transactionId: entry.transactionId,
		outcome: committed ? 'committed' : 'rolled-back',
		reason: sqliteTransactionEndReason(
			committed ? { committed: true } : { committed: false, cause },
			state
		),
		transaction: state,
		endedAt: Date.now(),
	};
	entry.end = end;
	entry.endLogged = logSqliteStatement(entry.databasePath, {
		kind: committed ? 'commit' : 'rollback',
		sql: committed ? 'COMMIT' : 'ROLLBACK',
		params: {},
		table: null,
		transactionId: entry.transactionId,
		at: end.endedAt,
		outcome: sqliteLoggedChanges(state.changes, state.otherChanges, state.schemaChanges),
		note: end.reason,
	});
	lastEnds.delete(entry.editToken);
	lastEnds.set(entry.editToken, end);
	if (lastEnds.size > MAX_KEPT_ENDS) {
		const oldest = lastEnds.keys().next().value;
		if (oldest !== undefined) lastEnds.delete(oldest);
	}
}

/** The open transaction `transactionId` of this grant, or a refusal saying it is gone and how it ended. */
function liveTransaction(editToken: string, transactionId: unknown): OpenTransaction {
	const entry = openTransactions.get(editToken);
	if (entry && entry.transactionId === transactionId) return entry;
	const end = lastEnds.get(editToken);
	throw refused(
		end && end.transactionId === transactionId
			? `${SQLITE_TRANSACTION_GONE_MESSAGE} ${end.reason}`
			: SQLITE_TRANSACTION_GONE_MESSAGE
	);
}

/**
 * Begin an explicit transaction for this tab's grant and hold it open.
 * Resolves its state, with `backup` when Begin took the session's backup.
 * Refused without a live grant, when the tab already has one open, when
 * another tab's transaction holds the file, and when the file is busy.
 */
export async function beginSqliteTransaction(
	request: SqliteTransactionRequest
): Promise<SqliteTransactionState> {
	const { handle, editToken } = request;
	const database = requireSqliteEditing(handle, editToken);
	if (openTransactions.has(editToken)) throw new Error(SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE);

	return reportSqliteBusy('write', async () => {
		const write = await beginSqliteWorkerWrite(handle, editToken);
		if (openTransactions.has(editToken)) throw new Error(SQLITE_TRANSACTION_ALREADY_OPEN_MESSAGE);
		// No await from the gate to here: the grant is still live.
		const releaseHold = holdSqliteTransaction(handle, editToken);
		const startedAt = Date.now();
		const entry = {
			handle,
			editToken,
			databasePath: database.displayPath,
			transactionId: randomUUID(),
			startedAt,
			expiresAt: startedAt + SQLITE_TRANSACTION_IDLE_MS,
			totals: { statements: 0, changes: 0, otherChanges: 0, schemaChanges: [] },
			began: false,
			pendingOp: null,
			cause: null,
			end: null,
			endLogged: Promise.resolve(),
			idleTimer: null,
			requestTimer: null,
			releaseHold,
			unhook: () => undefined,
		} as Omit<OpenTransaction, 'session'> as OpenTransaction;
		openTransactions.set(editToken, entry);
		entry.session = startSqliteWorkerSession(
			database,
			{ session: 'transaction', task: { target: write.target } },
			{
				closedMessage: sqliteTransactionEndReason(
					{ committed: false, cause: 'closed' },
					stateOf(entry)
				),
				label: 'The transaction',
				onEnd: (error, reply) => finish(entry, error, reply),
			}
		);
		entry.unhook = onSqliteEditingRevoked(handle, editToken, (reason) =>
			rollBack(entry, reason === 'closed' ? 'closed' : 'locked')
		);
		// A failed BEGIN ends the session, which releases everything above.
		entry.totals = await entry.session.opened;
		entry.began = true;
		armIdle(entry);
		await logSqliteStatement(entry.databasePath, {
			kind: 'begin',
			sql: 'BEGIN IMMEDIATE',
			params: {},
			table: null,
			transactionId: entry.transactionId,
			at: Date.now(),
			outcome: sqliteLoggedChanges(0, 0),
			...sqliteLoggedBackup(write.backupCreated ? write.backup : undefined),
		});
		return { ...stateOf(entry), ...(write.backupCreated ? { backup: write.backup } : {}) };
	});
}

/**
 * Run one statement inside this grant's open transaction
 * (`SqliteQueryRequest.transactionId`). `runSqliteQuery()` calls this after
 * its own checks and tracks `stop` under the run's `queryId`: stopping a
 * statement kills the child, which rolls the whole transaction back. A
 * failure that ended the transaction (SQLite rolled it back) says so.
 */
export function runInSqliteTransaction(
	request: { handle: string; editToken?: string | null; transactionId?: string | null },
	task: SqliteTransactionRunTask
): { result: Promise<SqliteQueryResult>; stop: () => void } {
	let entry: OpenTransaction;
	try {
		try {
			requireSqliteEditing(request.handle, request.editToken);
		} catch (error) {
			throw refused(error instanceof Error ? error.message : String(error));
		}
		entry = liveTransaction(request.editToken as string, request.transactionId);
		if (entry.session.busy) throw refused(SQLITE_TRANSACTION_BUSY_MESSAGE);
		if (entry.cause) throw refused(SQLITE_TRANSACTION_GONE_MESSAGE);
	} catch (error) {
		return { result: Promise.reject(error), stop: () => undefined };
	}

	const result = reportSqliteBusy('write', () => send(entry, { op: 'run', task })).then(
		async (reply): Promise<SqliteQueryResult> => {
			if (!reply.result) throw new Error('The transaction answered a statement with no result.');
			// A write is logged under the transaction; whether it reaches the
			// file is its end's to say. A read changed nothing and is not.
			if (reply.writes) {
				await logSqliteStatement(entry.databasePath, {
					kind: 'query',
					sql: task.sql,
					params: sqliteStatementParameterValues(task.sql, task.params),
					table: null,
					transactionId: entry.transactionId,
					at: Date.now(),
					outcome: sqliteLoggedChanges(
						reply.changes ?? 0,
						reply.otherChanges ?? 0,
						reply.schemaChanges ?? []
					),
				});
			}
			return {
				...reply.result,
				inTransaction: {
					writes: reply.writes === true,
					changes: reply.changes ?? 0,
					otherChanges: reply.otherChanges ?? 0,
					transaction: stateOf(entry),
				},
			};
		},
		(error: unknown) => {
			// SQLite rolled the transaction back with this failure: say so beside its words.
			if (!entry.end || entry.cause) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw Object.assign(new Error(`${message} ${entry.end.reason}`), {
				code: (error as { code?: unknown } | null)?.code,
			});
		}
	);
	return { result, stop: () => rollBack(entry, 'stopped') };
}

/**
 * Commit or roll back this grant's open transaction. Resolves how it ended.
 * A Commit SQLite refuses (a deferred foreign key, a busy file) rejects with
 * SQLite's words; the transaction then stays open when SQLite kept it.
 */
export async function endSqliteTransaction(
	request: SqliteTransactionEndRequest
): Promise<SqliteTransactionEnd> {
	const { handle, editToken, transactionId, action } = request;
	if (action !== 'commit' && action !== 'rollback') {
		throw new Error('A transaction ends with "commit" or "rollback".');
	}
	requireSqliteEditing(handle, editToken);
	const entry = liveTransaction(editToken, transactionId);
	if (entry.session.busy) throw new Error(SQLITE_TRANSACTION_BUSY_MESSAGE);
	if (entry.cause) throw new Error(SQLITE_TRANSACTION_GONE_MESSAGE);
	if (action === 'rollback') entry.cause = 'rollback';
	try {
		await reportSqliteBusy('write', () => send(entry, { op: action }));
	} catch (error) {
		// A failed ROLLBACK still closed the connection, which rolls back.
		if (action === 'rollback' && entry.end) {
			await entry.endLogged;
			return entry.end;
		}
		// A COMMIT SQLite refused but kept open was tried: the log says so.
		if (action === 'commit' && !entry.end) {
			await logSqliteStatement(entry.databasePath, {
				kind: 'commit',
				sql: 'COMMIT',
				params: {},
				table: null,
				transactionId: entry.transactionId,
				at: Date.now(),
				outcome: sqliteLoggedFailure(error),
			});
		}
		await entry.endLogged;
		throw error;
	}
	if (!entry.end) throw new Error(`The transaction did not end on ${action}.`);
	await entry.endLogged;
	return entry.end;
}

/** This grant's open transaction, and how its last one ended. */
export function readSqliteTransaction(request: SqliteTransactionRequest): SqliteTransactionStatus {
	requireSqliteEditing(request.handle, request.editToken);
	const entry = openTransactions.get(request.editToken);
	return {
		transaction: entry && !entry.cause ? stateOf(entry) : null,
		lastEnd: lastEnds.get(request.editToken) ?? null,
	};
}

/** Test seam: whether this grant has a transaction open. */
export function hasOpenSqliteTransaction(editToken: string): boolean {
	return openTransactions.has(editToken);
}
