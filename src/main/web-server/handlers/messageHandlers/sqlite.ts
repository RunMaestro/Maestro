/**
 * SQLite WebSocket handlers, the CLI half of the SQLite viewer:
 *
 *   - `sqlite_read_summary`: the summary strip and integrity flag (`maestro-cli sqlite info`).
 *   - `sqlite_list_objects`: the table-list rail (`maestro-cli sqlite tables`).
 *   - `sqlite_read_schema`: one object's schema pane (`maestro-cli sqlite schema`).
 *   - `sqlite_read_rows`: one window of the table view (`maestro-cli sqlite rows`).
 *   - `sqlite_count_rows`: the table view's row count, settled (`maestro-cli sqlite count`).
 *   - `sqlite_save_blob`: one BLOB cell written to a file (`maestro-cli sqlite blob`).
 *
 * The CLI cannot link better-sqlite3 (it is a plain-Node bundle with no native
 * modules), so it asks the running app. The answer comes from the SAME
 * functions the `sqlite:*` IPC handlers call: `openSqliteDatabase()` for the
 * read-only connection, `readSqliteDatabaseSummary()` and
 * `checkSqliteIntegrity()` for the summary strip, `listSqliteObjects()` for the rail, the budgeted
 * stats reader for the row counts and sizes, `readSqliteObjectSchema()` for
 * the schema pane, `readSqliteRows()` for the table view, and the budgeted
 * row counter run to the end for the footer's count, and `saveSqliteBlob()`
 * for the record view's Save to file, so the CLI prints what the viewer shows.
 * The BLOB is written by the app, to the absolute path the CLI resolved, the
 * way `profiling_stop` writes its bundle: its bytes never ride the socket.
 *
 * The connection is NOT closed afterwards. It may be the one a preview tab is
 * already using (opens on the same file share a connection), and closing it
 * would strand that tab; the idle reaper releases it once nothing uses it.
 */

import { saveSqliteBlob } from '../../../sqlite/sqlite-blob';
import { countAllSqliteRows } from '../../../sqlite/sqlite-count';
import { openSqliteDatabase } from '../../../sqlite/sqlite-database';
import { checkSqliteIntegrity } from '../../../sqlite/sqlite-integrity';
import { listSqliteObjects, readAllSqliteObjectStats } from '../../../sqlite/sqlite-objects';
import { readSqliteRows } from '../../../sqlite/sqlite-rows';
import { readSqliteObjectSchema } from '../../../sqlite/sqlite-schema';
import { readSqliteDatabaseSummary } from '../../../sqlite/sqlite-summary';
import type {
	SqliteIntegrityMode,
	SqliteObjectKind,
	SqliteSortSpec,
} from '../../../../shared/sqlite/types';
import { SQLITE_OBJECT_KINDS } from '../../../../shared/sqlite/objects';
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
