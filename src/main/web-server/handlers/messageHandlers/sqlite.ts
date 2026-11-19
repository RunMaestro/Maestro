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
	forgetSqliteQueryHistory,
	readSqliteQueryHistory,
} from '../../../sqlite/sqlite-query-history';
import { updateSqliteCell } from '../../../sqlite/sqlite-row-edit';
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

	try {
		const database = await openSqliteDatabase(filePath);
		// No queryId: a CLI run is stopped by its timeout, or by closing the app.
		const result = await runSqliteQuery({
			handle: database.handle,
			sql,
			offset: message.offset === undefined ? 0 : (message.offset as number),
			limit: message.limit === undefined ? 50 : (message.limit as number),
			// Shape and values are checked by the run, which refuses a bad one.
			params: (message.params ?? undefined) as SqliteParameterValues | undefined,
			plan: message.plan === true,
		});
		reply({ success: true, database, result });
	} catch (error) {
		// A syntax error's offset in `sql`, so the CLI can point at the token.
		const offset = (error as { offset?: unknown } | null)?.offset;
		reply({
			success: false,
			error: error instanceof Error ? error.message : String(error),
			...(typeof offset === 'number' ? { errorOffset: offset } : {}),
		});
	}
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
	if (message.enableEditing !== true) {
		reply({ success: false, error: SQLITE_CLI_UNLOCK_REQUIRED_MESSAGE });
		return;
	}

	try {
		const database = await openSqliteDatabase(filePath);
		const grant = await enableSqliteEditing(database.handle);
		try {
			// Key and value shapes are checked by the edit, which refuses a bad one.
			const result = await updateSqliteCell({
				handle: database.handle,
				editToken: grant.editToken,
				name,
				column,
				row: message.row as SqliteRowKey,
				value: message.value as SqliteParameterValue,
			});
			reply({ success: true, database, result });
		} finally {
			disableSqliteEditing(database.handle, grant.editToken);
		}
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
