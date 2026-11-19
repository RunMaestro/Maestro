/**
 * SQLite WebSocket handlers, the CLI half of the SQLite viewer:
 *
 *   - `sqlite_read_summary`: the summary strip and integrity flag (`maestro-cli sqlite info`).
 *   - `sqlite_list_objects`: the table-list rail (`maestro-cli sqlite tables`).
 *   - `sqlite_read_schema`: one object's schema pane (`maestro-cli sqlite schema`).
 *   - `sqlite_read_rows`: one window of the table view (`maestro-cli sqlite rows`).
 *   - `sqlite_count_rows`: the table view's row count, settled (`maestro-cli sqlite count`).
 *   - `sqlite_save_blob`: one BLOB cell written to a file (`maestro-cli sqlite blob`).
 *   - `sqlite_run_query`: Query mode's Run, one read-only statement with its
 *     parameter values, or its plan (`maestro-cli sqlite query --param`, `--plan`).
 *     With `enableEditing: true` (`--enable-editing`) the read-only assertion
 *     is lifted for that one run, behind the same per-call unlock as
 *     `sqlite_update_cell`: a statement that changes the database runs once,
 *     after the once-per-session backup, and its result carries `write`.
 *     With `dryRun: true` as well (`--dry-run`), it is tried and rolled back
 *     instead, and its result carries `dryRun`.
 *   - `sqlite_run_transaction`: Query mode's Begin transaction, statements
 *     run in it, and Commit or Roll back, as ONE call
 *     (`maestro-cli sqlite transaction`): the CLI has no tab to keep a
 *     transaction open in. Behind the same per-call unlock; the first
 *     statement that fails stops it and rolls it back.
 *   - `sqlite_export_query`: Query mode's Export, the statement's whole result
 *     written to a file (`maestro-cli sqlite query --output`).
 *   - `sqlite_query_history`: Query mode's History rail, read, one entry
 *     forgotten (by id or a unique start of one), or cleared
 *     (`maestro-cli sqlite history`).
 *   - `sqlite_update_cell`: the table view's cell edit, one single-row UPDATE
 *     (`maestro-cli sqlite set`). The CLI has no tab and so no editing grant:
 *     the message must say `enableEditing: true` (the verb's per-call unlock
 *     flag), and the handler enables editing for this one call, writes
 *     through `updateSqliteCell()` (same gate, same once-per-session backup),
 *     and disables it again, whatever happened.
 *   - `sqlite_insert_row` / `sqlite_delete_row`: the table view's Insert row
 *     and the record view's Delete row (`maestro-cli sqlite insert`,
 *     `sqlite delete`), through `insertSqliteRow()` / `deleteSqliteRow()`
 *     behind the same per-call unlock.
 *     An update or delete may carry `version` (`--if-version`): the row's
 *     version from `sqlite rows --json`, checked in the write's own `WHERE`.
 *   - `sqlite_undo_edit`: the viewer's Undo (`maestro-cli sqlite undo`): the
 *     `undo` step a write's result returned, applied through
 *     `undoSqliteEdit()` behind the same per-call unlock. Main keeps no undo
 *     state, so a step from an earlier CLI write undoes it just as well.
 *
 * The CLI cannot link better-sqlite3 (it is a plain-Node bundle with no native
 * modules), so it asks the running app. The answer comes from the SAME
 * functions the `sqlite:*` IPC handlers call: `openSqliteDatabase()` for the
 * read-only connection, `readSqliteDatabaseSummary()` and
 * `checkSqliteIntegrity()` for the summary strip, `listSqliteObjects()` for the rail, the budgeted
 * stats reader for the row counts and sizes, `readSqliteObjectSchema()` for
 * the schema pane, `readSqliteRows()` for the table view, and the budgeted
 * row counter run to the end for the footer's count, `saveSqliteBlob()`
 * for the record view's Save to file, `runSqliteQuery()` for Query mode's
 * Run (which records it in the same history the rail shows),
 * `exportSqliteQuery()` for its Export, and `readSqliteQueryHistory()` /
 * `forgetSqliteQueryHistory()` for its History rail, so the CLI prints what
 * the viewer shows; `enableSqliteEditing()`, `updateSqliteCell()`, and
 * `disableSqliteEditing()` make the cell edit.
 * The BLOB and an export are written by the app, to the absolute path the
 * CLI resolved, the way `profiling_stop` writes its bundle: their bytes
 * never ride the socket.
 *
 * The connection is NOT closed afterwards. It may be the one a preview tab is
 * already using (opens on the same file share a connection), and closing it
 * would strand that tab; the idle reaper releases it once nothing uses it.
 */

import { saveSqliteBlob } from '../../../sqlite/sqlite-blob';
import { countAllSqliteRows } from '../../../sqlite/sqlite-count';
import { openSqliteDatabase } from '../../../sqlite/sqlite-database';
import { disableSqliteEditing, enableSqliteEditing } from '../../../sqlite/sqlite-editing';
import { checkSqliteIntegrity } from '../../../sqlite/sqlite-integrity';
import { listSqliteObjects, readAllSqliteObjectStats } from '../../../sqlite/sqlite-objects';
import { exportSqliteQuery, runSqliteQuery } from '../../../sqlite/sqlite-query';
import {
	beginSqliteTransaction,
	endSqliteTransaction,
	readSqliteTransaction,
} from '../../../sqlite/sqlite-transaction';
import {
	forgetSqliteQueryHistory,
	readSqliteQueryHistory,
} from '../../../sqlite/sqlite-query-history';
import {
	deleteSqliteRow,
	insertSqliteRow,
	undoSqliteEdit,
	updateSqliteCell,
} from '../../../sqlite/sqlite-row-edit';
import { readSqliteRows } from '../../../sqlite/sqlite-rows';
import { readSqliteObjectSchema } from '../../../sqlite/sqlite-schema';
import { readSqliteDatabaseSummary } from '../../../sqlite/sqlite-summary';
import type {
	SqliteIntegrityMode,
	SqliteObjectKind,
	SqliteParameterValue,
	SqliteParameterValues,
	SqliteRowKey,
	SqliteSortSpec,
	SqliteTransactionEnd,
	SqliteTransactionScript,
	SqliteUndoStep,
} from '../../../../shared/sqlite/types';
import { SQLITE_OBJECT_KINDS } from '../../../../shared/sqlite/objects';
import { SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE } from '../../../../shared/sqlite/schema';
import { isTabularExportFormat } from '../../../../shared/tabularExport';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const SORT_SHAPE_ERROR = 'sort must be { column, direction: "asc" | "desc" }';

/** A message's `sort`: null when absent, undefined when malformed. */
function parseSort(value: unknown): SqliteSortSpec | null | undefined {
	if (value === undefined || value === null) return null;
	const raw = value as Partial<SqliteSortSpec>;
	if (typeof raw.column !== 'string' || (raw.direction !== 'asc' && raw.direction !== 'desc')) {
		return undefined;
	}
	return { column: raw.column, direction: raw.direction };
}

/** A message's `filter`: null when absent, undefined when not a string. */
function parseFilter(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	return typeof value === 'string' ? value : undefined;
}

export async function handleSqliteReadSummary(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_summary_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	if (!filePath) {
		reply({ success: false, error: 'Missing required "path" for sqlite_read_summary' });
		return;
	}
	// Optional: without it the reply carries the header facts only.
	const integrity: SqliteIntegrityMode | null =
		message.integrity === 'quick' || message.integrity === 'full' ? message.integrity : null;
	if (integrity === null && message.integrity !== undefined && message.integrity !== null) {
		reply({ success: false, error: 'integrity must be "quick" or "full"' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const summary = readSqliteDatabaseSummary(database.handle);
		const result = integrity ? await checkSqliteIntegrity(database.handle, integrity) : null;
		reply({ success: true, database, summary, integrity: result });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteListObjects(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_objects_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	if (!filePath) {
		reply({ success: false, error: 'Missing required "path" for sqlite_list_objects' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const list = listSqliteObjects(database.handle);
		const stats = await readAllSqliteObjectStats(
			database.handle,
			list.objects.map((object) => object.name)
		);
		reply({ success: true, database, list, stats });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteReadSchema(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_schema_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	if (!filePath || !name) {
		reply({ success: false, error: 'Missing required "path" or "name" for sqlite_read_schema' });
		return;
	}
	const kind: SqliteObjectKind | undefined = SQLITE_OBJECT_KINDS.find(
		(entry) => entry === message.kind
	);
	if (message.kind !== undefined && !kind) {
		reply({ success: false, error: `Unknown object kind: ${String(message.kind)}` });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const schema = readSqliteObjectSchema(database.handle, name, kind);
		reply({ success: true, database, schema });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteReadRows(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_rows_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	if (!filePath || !name) {
		reply({ success: false, error: 'Missing required "path" or "name" for sqlite_read_rows' });
		return;
	}
	const offset = message.offset === undefined ? 0 : message.offset;
	const limit = message.limit === undefined ? 50 : message.limit;
	const sort = parseSort(message.sort);
	if (sort === undefined) {
		reply({ success: false, error: SORT_SHAPE_ERROR });
		return;
	}
	const filter = parseFilter(message.filter);
	if (filter === undefined) {
		reply({ success: false, error: 'filter must be a string' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const page = readSqliteRows({
			handle: database.handle,
			name,
			offset: offset as number,
			limit: limit as number,
			sort,
			filter,
		});
		reply({ success: true, database, page });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteCountRows(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_count_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	if (!filePath || !name) {
		reply({ success: false, error: 'Missing required "path" or "name" for sqlite_count_rows' });
		return;
	}
	const filter = parseFilter(message.filter);
	if (filter === undefined) {
		reply({ success: false, error: 'filter must be a string' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		// Counted batch by batch with a yield between, so a huge table does not
		// hold the main process; the reply carries the settled count.
		const count = await countAllSqliteRows({ handle: database.handle, name, filter });
		reply({ success: true, database, count });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteSaveBlob(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_blob_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	const column = typeof message.column === 'string' ? message.column : '';
	const destPath = typeof message.destPath === 'string' ? message.destPath : '';
	if (!filePath || !name || !column || !destPath) {
		reply({
			success: false,
			error: 'Missing required "path", "name", "column", or "destPath" for sqlite_save_blob',
		});
		return;
	}
	const rowid =
		typeof message.rowid === 'string' || typeof message.rowid === 'number'
			? String(message.rowid)
			: null;
	const offset = typeof message.offset === 'number' ? message.offset : null;
	if (rowid === null && offset === null) {
		reply({ success: false, error: 'sqlite_save_blob needs a "rowid" or an "offset"' });
		return;
	}
	const sort = parseSort(message.sort);
	if (sort === undefined) {
		reply({ success: false, error: SORT_SHAPE_ERROR });
		return;
	}
	const filter = parseFilter(message.filter);
	if (filter === undefined) {
		reply({ success: false, error: 'filter must be a string' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const saved = await saveSqliteBlob({
			handle: database.handle,
			name,
			column,
			rowid,
			offset,
			sort,
			filter,
			destPath,
		});
		reply({ success: true, database, saved });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteRunQuery(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_query_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const sql = typeof message.sql === 'string' ? message.sql : '';
	if (!filePath || !sql.trim()) {
		reply({ success: false, error: 'Missing required "path" or "sql" for sqlite_run_query' });
		return;
	}

	// No queryId: a CLI run is stopped by its timeout, or by closing the app.
	const run = (handle: string, editToken?: string) =>
		runSqliteQuery({
			handle,
			sql,
			offset: message.offset === undefined ? 0 : (message.offset as number),
			limit: message.limit === undefined ? 50 : (message.limit as number),
			// Shape and values are checked by the run, which refuses a bad one.
			params: (message.params ?? undefined) as SqliteParameterValues | undefined,
			plan: message.plan === true,
			...(editToken ? { editToken } : {}),
			// Refused by the run without an editing grant (`--dry-run` needs `--enable-editing`).
			...(message.dryRun === true ? { dryRun: true } : {}),
		});

	// `--enable-editing`: the read-only assertion is lifted for this one run,
	// through the same per-call unlock the CLI's other write verbs use.
	if (message.enableEditing === true) {
		await writeWithCliUnlock(message, filePath, reply, run);
		return;
	}
	try {
		const database = await openSqliteDatabase(filePath);
		const result = await run(database.handle);
		reply({ success: true, database, result });
	} catch (error) {
		reply(sqliteFailureReply(error));
	}
}

export async function handleSqliteRunTransaction(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'sqlite_transaction_result',
			...payload,
			requestId: message.requestId,
		});
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const statements = Array.isArray(message.statements) ? message.statements : [];
	const action = message.end;
	if (
		!filePath ||
		statements.length === 0 ||
		!statements.every((sql) => typeof sql === 'string' && sql.trim() !== '')
	) {
		reply({
			success: false,
			error:
				'Missing required "path" or "statements" (non-empty statement texts) for sqlite_run_transaction',
		});
		return;
	}
	if (action !== 'commit' && action !== 'rollback') {
		reply({ success: false, error: 'end must be "commit" or "rollback"' });
		return;
	}
	const limit = message.limit === undefined ? 50 : (message.limit as number);

	await writeWithCliUnlock(
		message,
		filePath,
		reply,
		async (handle, editToken): Promise<SqliteTransactionScript> => {
			const begun = await beginSqliteTransaction({ handle, editToken });
			const { transactionId } = begun;
			const steps: SqliteTransactionScript['steps'] = [];
			let failed: SqliteTransactionScript['failed'] = null;
			for (const [index, sql] of (statements as string[]).entries()) {
				try {
					steps.push(await runSqliteQuery({ handle, editToken, sql, limit, transactionId }));
				} catch (error) {
					failed = { index, ...failureOf(error) };
					break;
				}
			}
			// SQLite may have rolled it back with the failure already.
			const ended = (): SqliteTransactionEnd | null =>
				readSqliteTransaction({ handle, editToken }).lastEnd;
			if (!readSqliteTransaction({ handle, editToken }).transaction) {
				const end = ended();
				if (!end) throw new Error('The transaction ended without a record of how.');
				return { begun, steps, failed, end };
			}
			const end = failed ? 'rollback' : action;
			try {
				return {
					begun,
					steps,
					failed,
					end: await endSqliteTransaction({ handle, editToken, transactionId, action: end }),
				};
			} catch (error) {
				// A Commit SQLite refused (a deferred foreign key) kept the transaction: discard it.
				const rolledBack = await endSqliteTransaction({
					handle,
					editToken,
					transactionId,
					action: 'rollback',
				});
				return { begun, steps, failed: { index: null, ...failureOf(error) }, end: rolledBack };
			}
		}
	);
}

/** A failure's message, and a syntax error's offset in its statement. */
function failureOf(error: unknown): { error: string; errorOffset?: number } {
	const offset = (error as { offset?: unknown } | null)?.offset;
	return {
		error: error instanceof Error ? error.message : String(error),
		...(typeof offset === 'number' ? { errorOffset: offset } : {}),
	};
}

/**
 * A failed call's reply: the message, and a syntax error's offset in the
 * statement (`errorOffset`), so the CLI can point at the token.
 */
function sqliteFailureReply(error: unknown): Record<string, unknown> {
	return { success: false, ...failureOf(error) };
}

export async function handleSqliteExportQuery(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_export_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const sql = typeof message.sql === 'string' ? message.sql : '';
	const destPath = typeof message.destPath === 'string' ? message.destPath : '';
	if (!filePath || !sql.trim() || !destPath) {
		reply({
			success: false,
			error: 'Missing required "path", "sql", or "destPath" for sqlite_export_query',
		});
		return;
	}
	if (message.format !== undefined && !isTabularExportFormat(message.format)) {
		reply({ success: false, error: 'format must be "csv" or "jsonl"' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		// No queryId: a CLI export is stopped by its timeout, or by closing the app.
		const exported = await exportSqliteQuery({
			handle: database.handle,
			sql,
			destPath,
			...(message.format !== undefined ? { format: message.format } : {}),
			params: (message.params ?? undefined) as SqliteParameterValues | undefined,
		});
		reply({ success: true, database, exported });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteQueryHistory(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_history_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	if (!filePath) {
		reply({ success: false, error: 'Missing required "path" for sqlite_query_history' });
		return;
	}
	if (message.forget !== undefined && typeof message.forget !== 'string') {
		reply({ success: false, error: 'forget must be a history entry id' });
		return;
	}
	if (message.forget !== undefined && message.clear === true) {
		reply({ success: false, error: 'Give "forget" or "clear", not both' });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const before = await readSqliteQueryHistory(database.handle);
		let history = before;
		if (typeof message.forget === 'string') {
			// An id or a unique start of one: the CLI lists the first eight characters.
			const prefix = message.forget;
			const matches = before.entries.filter((entry) => entry.id.startsWith(prefix));
			if (!prefix || matches.length !== 1) {
				reply({
					success: false,
					error:
						matches.length > 1
							? `${prefix} starts more than one history entry; give more of the id`
							: `No history entry ${prefix} for ${filePath}`,
				});
				return;
			}
			history = await forgetSqliteQueryHistory(database.handle, matches[0].id);
		} else if (message.clear === true) {
			history = await forgetSqliteQueryHistory(database.handle, null);
		}
		reply({
			success: true,
			database,
			history,
			removed: before.entries.length - history.entries.length,
		});
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function handleSqliteUpdateCell(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_update_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	const column = typeof message.column === 'string' ? message.column : '';
	if (!filePath || !name || !column || !message.row || !message.value) {
		reply({
			success: false,
			error: 'Missing required "path", "name", "column", "row", or "value" for sqlite_update_cell',
		});
		return;
	}
	// Key and value shapes are checked by the edit, which refuses a bad one.
	await writeWithCliUnlock(message, filePath, reply, (handle, editToken) =>
		updateSqliteCell({
			handle,
			editToken,
			name,
			column,
			row: message.row as SqliteRowKey,
			// The version shape is checked by the edit too (absent: key alone).
			version: message.version as string | undefined,
			value: message.value as SqliteParameterValue,
		})
	);
}

/**
 * Make one write for a CLI verb, which has no tab and so no editing grant:
 * refuse unless the message says `enableEditing: true` (the verb's per-call
 * unlock flag), then enable editing on the file, write, and disable it
 * again, whatever happened. Replies with the write's result or its error.
 */
async function writeWithCliUnlock<T>(
	message: WebClientMessage,
	filePath: string,
	reply: (payload: Record<string, unknown>) => void,
	write: (handle: string, editToken: string) => Promise<T>
): Promise<void> {
	if (message.enableEditing !== true) {
		reply({ success: false, error: SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE });
		return;
	}
	try {
		const database = await openSqliteDatabase(filePath);
		const grant = await enableSqliteEditing(database.handle);
		try {
			const result = await write(database.handle, grant.editToken);
			reply({ success: true, database, result });
		} finally {
			disableSqliteEditing(database.handle, grant.editToken);
		}
	} catch (error) {
		reply(sqliteFailureReply(error));
	}
}

export async function handleSqliteInsertRow(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_insert_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	const values = message.values ?? {};
	if (!filePath || !name || typeof values !== 'object' || Array.isArray(values)) {
		reply({
			success: false,
			error:
				'Missing required "path" or "name", or "values" is not an object, for sqlite_insert_row',
		});
		return;
	}
	// Value shapes are checked by the insert, which refuses a bad one.
	await writeWithCliUnlock(message, filePath, reply, (handle, editToken) =>
		insertSqliteRow({
			handle,
			editToken,
			name,
			values: values as Record<string, SqliteParameterValue>,
		})
	);
}

export async function handleSqliteDeleteRow(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_delete_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const name = typeof message.name === 'string' ? message.name : '';
	if (!filePath || !name || !message.row) {
		reply({
			success: false,
			error: 'Missing required "path", "name", or "row" for sqlite_delete_row',
		});
		return;
	}
	// The key's shape is checked by the delete, which refuses a bad one.
	await writeWithCliUnlock(message, filePath, reply, (handle, editToken) =>
		deleteSqliteRow({
			handle,
			editToken,
			name,
			row: message.row as SqliteRowKey,
			version: message.version as string | undefined,
		})
	);
}

export async function handleSqliteUndoEdit(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'sqlite_undo_result', ...payload, requestId: message.requestId });
	};

	const filePath = typeof message.path === 'string' ? message.path : '';
	const step = message.step;
	if (!filePath || !step || typeof step !== 'object' || Array.isArray(step)) {
		reply({
			success: false,
			error: 'Missing required "path" or "step" (an object) for sqlite_undo_edit',
		});
		return;
	}
	// The step's shape is checked by the undo, which refuses a bad one.
	await writeWithCliUnlock(message, filePath, reply, (handle, editToken) =>
		undoSqliteEdit({ handle, editToken, step: step as SqliteUndoStep })
	);
}
