// Covers the sqlite_read_summary, sqlite_list_objects, sqlite_read_schema,
// sqlite_read_rows, sqlite_count_rows, sqlite_save_blob, sqlite_run_query,
// sqlite_export_query, sqlite_query_history, sqlite_statement_log, sqlite_update_cell, sqlite_insert_row, and sqlite_delete_row
// WebSocket messages that back `maestro-cli sqlite info`, `sqlite tables`,
// `sqlite schema`, `sqlite rows`, `sqlite count`, `sqlite blob`, `sqlite query`
// (with and without `--output`), `sqlite history`, and `sqlite set`. It opens the database through the viewer's own open path,
// answers with the rail's listing and measurements, never closes the shared
// connection, and always echoes the request id so the CLI never hangs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const database = vi.hoisted(() => ({
	openSqliteDatabase: vi.fn(),
	closeSqliteDatabase: vi.fn(),
}));
const objects = vi.hoisted(() => ({
	listSqliteObjects: vi.fn(),
	readAllSqliteObjectStats: vi.fn(),
}));

vi.mock('../../../../main/sqlite/sqlite-database', () => database);
const schemas = vi.hoisted(() => ({ readSqliteObjectSchema: vi.fn() }));

vi.mock('../../../../main/sqlite/sqlite-objects', () => objects);
vi.mock('../../../../main/sqlite/sqlite-schema', () => schemas);
const rows = vi.hoisted(() => ({ readSqliteRows: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-rows', () => rows);
const counts = vi.hoisted(() => ({ countAllSqliteRows: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-count', () => counts);
const blobs = vi.hoisted(() => ({ saveSqliteBlob: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-blob', () => blobs);
const summaries = vi.hoisted(() => ({ readSqliteDatabaseSummary: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-summary', () => summaries);
const integrity = vi.hoisted(() => ({ checkSqliteIntegrity: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-integrity', () => integrity);
const queries = vi.hoisted(() => ({ runSqliteQuery: vi.fn(), exportSqliteQuery: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-query', () => queries);
const histories = vi.hoisted(() => ({
	readSqliteQueryHistory: vi.fn(),
	forgetSqliteQueryHistory: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-query-history', () => histories);
const statementLogs = vi.hoisted(() => ({
	readSqliteStatementLog: vi.fn(),
	clearSqliteStatementLog: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-statement-log', () => statementLogs);
const editing = vi.hoisted(() => ({
	enableSqliteEditing: vi.fn(),
	disableSqliteEditing: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-editing', () => editing);
const rowEdits = vi.hoisted(() => ({
	updateSqliteCell: vi.fn(),
	insertSqliteRow: vi.fn(),
	deleteSqliteRow: vi.fn(),
	undoSqliteEdit: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-row-edit', () => rowEdits);
const transactions = vi.hoisted(() => ({
	beginSqliteTransaction: vi.fn(),
	readSqliteTransaction: vi.fn(),
	endSqliteTransaction: vi.fn(),
}));
vi.mock('../../../../main/sqlite/sqlite-transaction', () => transactions);

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		cli: true,
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('sqlite_read_summary handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const summary = { pageSize: 4096, pageCount: 1, journalMode: 'wal' };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		summaries.readSqliteDatabaseSummary.mockReturnValue(summary);
	});

	it('answers with the header facts and no check unless one is asked for', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_read_summary',
			requestId: 'r1',
			path: '/data/app.db',
		});
		await flush();

		expect(summaries.readSqliteDatabaseSummary).toHaveBeenCalledWith('h1');
		expect(integrity.checkSqliteIntegrity).not.toHaveBeenCalled();
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_summary_result',
			requestId: 'r1',
			success: true,
			database: info,
			summary,
			integrity: null,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('runs the asked-for integrity check and includes its verdict', async () => {
		const verdict = { mode: 'full', ok: false, problems: ['bad'], truncated: false, elapsedMs: 3 };
		integrity.checkSqliteIntegrity.mockResolvedValue(verdict);

		handler.handleMessage(client, {
			type: 'sqlite_read_summary',
			requestId: 'r2',
			path: '/data/app.db',
			integrity: 'full',
		});
		await flush();

		expect(integrity.checkSqliteIntegrity).toHaveBeenCalledWith('h1', 'full');
		expect(lastResponse(client)).toMatchObject({ success: true, integrity: verdict });
	});

	it('refuses an unknown integrity mode and a missing path', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_read_summary',
			requestId: 'r3',
			path: '/data/app.db',
			integrity: 'deep',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'r3',
			success: false,
			error: 'integrity must be "quick" or "full"',
		});

		handler.handleMessage(client, { type: 'sqlite_read_summary', requestId: 'r4' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'r4', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});

	it('reports a failed check with the request id', async () => {
		integrity.checkSqliteIntegrity.mockRejectedValue(new Error('database is locked'));
		handler.handleMessage(client, {
			type: 'sqlite_read_summary',
			requestId: 'r5',
			path: '/data/app.db',
			integrity: 'quick',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_summary_result',
			requestId: 'r5',
			success: false,
			error: 'database is locked',
		});
	});
});

describe('sqlite_list_objects handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('answers with the database, its objects, and their measurements', async () => {
		const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
		const list = {
			objects: [
				{ name: 'users', kind: 'table' },
				{ name: 'users_audit', kind: 'trigger' },
			],
			sizesAvailable: true,
		};
		const stats = [{ name: 'users', rowCount: 3, rowCountCapped: false, sizeBytes: 4096 }];
		database.openSqliteDatabase.mockResolvedValue(info);
		objects.listSqliteObjects.mockReturnValue(list);
		objects.readAllSqliteObjectStats.mockResolvedValue(stats);

		handler.handleMessage(client, {
			type: 'sqlite_list_objects',
			requestId: 'r1',
			path: '/data/app.db',
		});
		await flush();

		expect(database.openSqliteDatabase).toHaveBeenCalledWith('/data/app.db');
		expect(objects.readAllSqliteObjectStats).toHaveBeenCalledWith('h1', ['users', 'users_audit']);
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_objects_result',
			requestId: 'r1',
			success: true,
			database: info,
			list,
			stats,
		});
		// The connection may be a preview tab's; the idle reaper releases it.
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('reports an open failure with the request id', async () => {
		database.openSqliteDatabase.mockRejectedValue(new Error('Not a SQLite database: /data/x.db'));

		handler.handleMessage(client, {
			type: 'sqlite_list_objects',
			requestId: 'r2',
			path: '/data/x.db',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_objects_result',
			requestId: 'r2',
			success: false,
			error: 'Not a SQLite database: /data/x.db',
		});
	});

	it('refuses a message with no path', async () => {
		handler.handleMessage(client, { type: 'sqlite_list_objects', requestId: 'r3' });
		await flush();

		expect(lastResponse(client)).toMatchObject({ requestId: 'r3', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_read_schema handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
	});

	it('answers with the database and the object schema', async () => {
		const schema = { name: 'users', kind: 'table', columns: [], foreignKeys: [], sql: 'CREATE' };
		schemas.readSqliteObjectSchema.mockReturnValue(schema);

		handler.handleMessage(client, {
			type: 'sqlite_read_schema',
			requestId: 's1',
			path: '/data/app.db',
			name: 'users',
			kind: 'table',
		});
		await flush();

		expect(schemas.readSqliteObjectSchema).toHaveBeenCalledWith('h1', 'users', 'table');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_schema_result',
			requestId: 's1',
			success: true,
			database: info,
			schema,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('passes no kind when none was sent', async () => {
		schemas.readSqliteObjectSchema.mockReturnValue({ name: 'users' });
		handler.handleMessage(client, {
			type: 'sqlite_read_schema',
			requestId: 's2',
			path: '/data/app.db',
			name: 'users',
		});
		await flush();
		expect(schemas.readSqliteObjectSchema).toHaveBeenCalledWith('h1', 'users', undefined);
	});

	it('reports a missing object with the request id', async () => {
		schemas.readSqliteObjectSchema.mockImplementation(() => {
			throw new Error('No table, view, index, or trigger is named nope.');
		});
		handler.handleMessage(client, {
			type: 'sqlite_read_schema',
			requestId: 's3',
			path: '/data/app.db',
			name: 'nope',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_schema_result',
			requestId: 's3',
			success: false,
			error: 'No table, view, index, or trigger is named nope.',
		});
	});

	it('refuses a missing name or an unknown kind before opening anything', async () => {
		handler.handleMessage(client, { type: 'sqlite_read_schema', requestId: 's4', path: '/x.db' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 's4', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_read_schema',
			requestId: 's5',
			path: '/x.db',
			name: 'users',
			kind: 'column',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 's5',
			success: false,
			error: 'Unknown object kind: column',
		});
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_read_rows handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
	});

	it('answers with the database and one window, read through the shared reader', async () => {
		const page = { name: 'users', columns: [], rows: [[1]], offset: 10, hasMore: true };
		rows.readSqliteRows.mockReturnValue(page);

		handler.handleMessage(client, {
			type: 'sqlite_read_rows',
			requestId: 'r1',
			path: '/data/app.db',
			name: 'users',
			offset: 10,
			limit: 5,
			sort: { column: 'name', direction: 'desc' },
			filter: 'name ~ smith',
		});
		await flush();

		expect(rows.readSqliteRows).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'users',
			offset: 10,
			limit: 5,
			sort: { column: 'name', direction: 'desc' },
			filter: 'name ~ smith',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_rows_result',
			requestId: 'r1',
			success: true,
			database: info,
			page,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('defaults to the first 50 rows, unsorted and unfiltered', async () => {
		rows.readSqliteRows.mockReturnValue({ name: 'users' });
		handler.handleMessage(client, {
			type: 'sqlite_read_rows',
			requestId: 'r2',
			path: '/data/app.db',
			name: 'users',
		});
		await flush();
		expect(rows.readSqliteRows).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'users',
			offset: 0,
			limit: 50,
			sort: null,
			filter: null,
		});
	});

	it("reports the reader's refusal with the request id", async () => {
		rows.readSqliteRows.mockImplementation(() => {
			throw new Error('users has no column named zzz.');
		});
		handler.handleMessage(client, {
			type: 'sqlite_read_rows',
			requestId: 'r3',
			path: '/data/app.db',
			name: 'users',
			sort: { column: 'zzz', direction: 'asc' },
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_rows_result',
			requestId: 'r3',
			success: false,
			error: 'users has no column named zzz.',
		});
	});

	it('refuses a missing name, a malformed sort, or a non-string filter before opening anything', async () => {
		handler.handleMessage(client, { type: 'sqlite_read_rows', requestId: 'r4', path: '/x.db' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'r4', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_read_rows',
			requestId: 'r5',
			path: '/x.db',
			name: 'users',
			sort: { column: 'name', direction: 'up' },
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'r5',
			success: false,
			error: 'sort must be { column, direction: "asc" | "desc" }',
		});

		handler.handleMessage(client, {
			type: 'sqlite_read_rows',
			requestId: 'r6',
			path: '/x.db',
			name: 'users',
			filter: 42,
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'r6',
			success: false,
			error: 'filter must be a string',
		});
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_count_rows handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
	});

	it('answers with the settled count from the shared counter', async () => {
		const count = { name: 'users', matched: 1204, complete: true, cursor: null, filtered: true };
		counts.countAllSqliteRows.mockResolvedValue(count);

		handler.handleMessage(client, {
			type: 'sqlite_count_rows',
			requestId: 'c1',
			path: '/data/app.db',
			name: 'users',
			filter: 'status = active',
		});
		await flush();

		expect(counts.countAllSqliteRows).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'users',
			filter: 'status = active',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_count_result',
			requestId: 'c1',
			success: true,
			database: info,
			count,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('counts every row when no filter is sent', async () => {
		counts.countAllSqliteRows.mockResolvedValue({ name: 'users', matched: 3, complete: true });
		handler.handleMessage(client, {
			type: 'sqlite_count_rows',
			requestId: 'c2',
			path: '/data/app.db',
			name: 'users',
		});
		await flush();
		expect(counts.countAllSqliteRows).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'users',
			filter: null,
		});
	});

	it("reports the counter's failure with the request id", async () => {
		counts.countAllSqliteRows.mockRejectedValue(new Error('No table or view is named gone.'));
		handler.handleMessage(client, {
			type: 'sqlite_count_rows',
			requestId: 'c3',
			path: '/data/app.db',
			name: 'gone',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_count_result',
			requestId: 'c3',
			success: false,
			error: 'No table or view is named gone.',
		});
	});

	it('refuses a missing name or a non-string filter before opening anything', async () => {
		handler.handleMessage(client, { type: 'sqlite_count_rows', requestId: 'c4', path: '/x.db' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'c4', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_count_rows',
			requestId: 'c5',
			path: '/x.db',
			name: 'users',
			filter: ['x'],
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'c5',
			success: false,
			error: 'filter must be a string',
		});
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_save_blob handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
	});

	it('saves through the shared saver and answers with what was written', async () => {
		const saved = { path: '/tmp/logo.png', bytes: 2048, rowid: '7' };
		blobs.saveSqliteBlob.mockResolvedValue(saved);

		handler.handleMessage(client, {
			type: 'sqlite_save_blob',
			requestId: 'b1',
			path: '/data/app.db',
			name: 'media',
			column: 'data',
			rowid: '7',
			destPath: '/tmp/logo.png',
		});
		await flush();

		expect(blobs.saveSqliteBlob).toHaveBeenCalledWith({
			handle: 'h1',
			name: 'media',
			column: 'data',
			rowid: '7',
			offset: null,
			sort: null,
			filter: null,
			destPath: '/tmp/logo.png',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_blob_result',
			requestId: 'b1',
			success: true,
			database: info,
			saved,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('passes a position with its sort and filter through', async () => {
		blobs.saveSqliteBlob.mockResolvedValue({ path: '/tmp/x.bin', bytes: 1, rowid: null });
		handler.handleMessage(client, {
			type: 'sqlite_save_blob',
			requestId: 'b2',
			path: '/data/app.db',
			name: 'thumbs',
			column: 'img',
			offset: 4,
			sort: { column: 'img', direction: 'desc' },
			filter: 'img is not null',
			destPath: '/tmp/x.bin',
		});
		await flush();
		expect(blobs.saveSqliteBlob).toHaveBeenCalledWith(
			expect.objectContaining({
				rowid: null,
				offset: 4,
				sort: { column: 'img', direction: 'desc' },
				filter: 'img is not null',
			})
		);
	});

	it("reports the saver's failure with the request id", async () => {
		blobs.saveSqliteBlob.mockRejectedValue(new Error('data holds NULL in rowid 7, not a BLOB.'));
		handler.handleMessage(client, {
			type: 'sqlite_save_blob',
			requestId: 'b3',
			path: '/data/app.db',
			name: 'media',
			column: 'data',
			rowid: '7',
			destPath: '/tmp/x.bin',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_blob_result',
			requestId: 'b3',
			success: false,
			error: 'data holds NULL in rowid 7, not a BLOB.',
		});
	});

	it('refuses a missing field, no row, or a bad sort before opening anything', async () => {
		const base = {
			type: 'sqlite_save_blob',
			path: '/data/app.db',
			name: 'media',
			column: 'data',
			destPath: '/tmp/x.bin',
		};
		handler.handleMessage(client, { ...base, requestId: 'b4', column: undefined, rowid: '1' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'b4', success: false });

		handler.handleMessage(client, { ...base, requestId: 'b5' });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'b5',
			success: false,
			error: 'sqlite_save_blob needs a "rowid" or an "offset"',
		});

		handler.handleMessage(client, { ...base, requestId: 'b6', offset: 0, sort: { column: 1 } });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'b6', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_run_query handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const result = {
		statement: 'SELECT',
		columns: [{ name: 'n', declaredType: null }],
		rows: [[1]],
		offset: 0,
		hasMore: false,
		returnsRows: true,
		elapsedMs: 1,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		queries.runSqliteQuery.mockResolvedValue(result);
	});

	it("answers with one window from the viewer's own runner, 50 rows by default", async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q1',
			path: '/data/app.db',
			sql: 'SELECT count(*) AS n FROM users',
		});
		await flush();
		expect(database.openSqliteDatabase).toHaveBeenCalledWith('/data/app.db');
		expect(queries.runSqliteQuery).toHaveBeenCalledWith({
			handle: 'h1',
			sql: 'SELECT count(*) AS n FROM users',
			offset: 0,
			limit: 50,
			plan: false,
		});
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_query_result',
			requestId: 'q1',
			success: true,
			database: info,
			result,
		});
		// The connection may be a preview tab's: never closed here.
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('passes the window through', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q2',
			path: '/data/app.db',
			sql: 'SELECT 1',
			offset: 100,
			limit: 10,
		});
		await flush();
		expect(queries.runSqliteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 100, limit: 10 })
		);
	});

	it('passes the parameter values through for the runner to bind', async () => {
		const params = { ':id': { type: 'number', text: '7' } };
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q2p',
			path: '/data/app.db',
			sql: 'SELECT * FROM users WHERE id = :id',
			params,
		});
		await flush();
		expect(queries.runSqliteQuery).toHaveBeenCalledWith(expect.objectContaining({ params }));
	});

	it('passes --plan through as a boolean, and nothing else as one', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q2plan',
			path: '/data/app.db',
			sql: 'SELECT * FROM users',
			plan: true,
		});
		await flush();
		expect(queries.runSqliteQuery).toHaveBeenLastCalledWith(
			expect.objectContaining({ plan: true })
		);
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q2plan2',
			path: '/data/app.db',
			sql: 'SELECT * FROM users',
			plan: 'yes',
		});
		await flush();
		expect(queries.runSqliteQuery).toHaveBeenLastCalledWith(
			expect.objectContaining({ plan: false })
		);
	});

	it("reports the runner's refusal with the request id", async () => {
		queries.runSqliteQuery.mockRejectedValue(new Error('DELETE is not a read-only statement.'));
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q3',
			path: '/data/app.db',
			sql: 'DELETE FROM users',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_query_result',
			requestId: 'q3',
			success: false,
			error: 'DELETE is not a read-only statement.',
		});
		expect(lastResponse(client)).not.toHaveProperty('errorOffset');
	});

	it("sends a syntax error's offset beside its message, for the CLI's caret", async () => {
		queries.runSqliteQuery.mockRejectedValue(
			Object.assign(new Error('near "FORM": syntax error'), { offset: 9 })
		);
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q6',
			path: '/data/app.db',
			sql: 'SELECT * FORM users',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'q6',
			success: false,
			error: 'near "FORM": syntax error',
			errorOffset: 9,
		});
	});

	it('refuses a missing path or a blank statement before opening anything', async () => {
		handler.handleMessage(client, { type: 'sqlite_run_query', requestId: 'q4', sql: 'SELECT 1' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'q4', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'q5',
			path: '/data/app.db',
			sql: '   ',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'q5', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_run_query handler with --enable-editing', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const written = {
		statement: 'DELETE',
		columns: [],
		rows: [],
		offset: 0,
		hasMore: false,
		returnsRows: false,
		elapsedMs: 2,
		write: { changes: 3, otherChanges: 0, schemaChanges: [] },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
		queries.runSqliteQuery.mockResolvedValue(written);
	});

	it('unlocks for this one run, passes the grant to the runner, and locks again', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'qe1',
			path: '/data/app.db',
			sql: 'DELETE FROM users WHERE id > 1',
			enableEditing: true,
		});
		await flush();
		expect(editing.enableSqliteEditing).toHaveBeenCalledWith('h1');
		expect(queries.runSqliteQuery).toHaveBeenCalledWith({
			handle: 'h1',
			sql: 'DELETE FROM users WHERE id > 1',
			offset: 0,
			limit: 50,
			plan: false,
			editToken: 'cli-token',
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_query_result',
			requestId: 'qe1',
			success: true,
			database: info,
			result: written,
		});
	});

	it('locks again when the run fails, keeping where a syntax error points', async () => {
		queries.runSqliteQuery.mockRejectedValue(
			Object.assign(new Error('near "FORM": syntax error'), { offset: 7 })
		);
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'qe2',
			path: '/data/app.db',
			sql: 'DELETE FORM users',
			enableEditing: true,
		});
		await flush();
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_query_result',
			requestId: 'qe2',
			success: false,
			error: 'near "FORM": syntax error',
			errorOffset: 7,
		});
	});

	it('never unlocks a run that did not ask, and sends it no grant', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'qe3',
			path: '/data/app.db',
			sql: 'SELECT 1',
			enableEditing: 'yes',
		});
		await flush();
		expect(editing.enableSqliteEditing).not.toHaveBeenCalled();
		expect(queries.runSqliteQuery.mock.calls[0][0]).not.toHaveProperty('editToken');
	});

	it('forwards a dry run behind the same per-call unlock, and nothing else as one', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'qe4',
			path: '/data/app.db',
			sql: 'DELETE FROM users',
			enableEditing: true,
			dryRun: true,
		});
		await flush();
		expect(queries.runSqliteQuery).toHaveBeenCalledWith(
			expect.objectContaining({ editToken: 'cli-token', dryRun: true })
		);
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');

		handler.handleMessage(client, {
			type: 'sqlite_run_query',
			requestId: 'qe5',
			path: '/data/app.db',
			sql: 'DELETE FROM users',
			enableEditing: true,
			dryRun: 'yes',
		});
		await flush();
		expect(queries.runSqliteQuery.mock.calls[1][0]).not.toHaveProperty('dryRun');
	});
});

describe('sqlite_export_query handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const exported = {
		path: '/tmp/out.csv',
		format: 'csv',
		rows: 3,
		columns: 2,
		bytes: 40,
		elapsedMs: 1,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		queries.exportSqliteQuery.mockResolvedValue(exported);
	});

	it("writes the file through the viewer's own export, with the values and format given", async () => {
		const params = { ':id': { type: 'number', text: '1' } };
		handler.handleMessage(client, {
			type: 'sqlite_export_query',
			requestId: 'e1',
			path: '/data/app.db',
			sql: 'SELECT * FROM t WHERE id = :id',
			params,
			destPath: '/tmp/out.csv',
			format: 'csv',
		});
		await flush();
		expect(queries.exportSqliteQuery).toHaveBeenCalledWith({
			handle: 'h1',
			sql: 'SELECT * FROM t WHERE id = :id',
			params,
			destPath: '/tmp/out.csv',
			format: 'csv',
		});
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_export_result',
			requestId: 'e1',
			success: true,
			database: info,
			exported,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('leaves the format to the destination when none is given', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_export_query',
			requestId: 'e2',
			path: '/data/app.db',
			sql: 'SELECT 1',
			destPath: '/tmp/out.jsonl',
		});
		await flush();
		expect(queries.exportSqliteQuery.mock.calls[0][0]).not.toHaveProperty('format');
	});

	it('refuses a missing destination or an unknown format before opening anything', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_export_query',
			requestId: 'e3',
			path: '/data/app.db',
			sql: 'SELECT 1',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'e3', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_export_query',
			requestId: 'e4',
			path: '/data/app.db',
			sql: 'SELECT 1',
			destPath: '/tmp/out.xml',
			format: 'xml',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'e4',
			success: false,
			error: 'format must be "csv" or "jsonl"',
		});
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});

	it('answers a failed export with its message', async () => {
		queries.exportSqliteQuery.mockRejectedValue(new Error('no such column: nope'));
		handler.handleMessage(client, {
			type: 'sqlite_export_query',
			requestId: 'e5',
			path: '/data/app.db',
			sql: 'SELECT nope',
			destPath: '/tmp/out.csv',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_export_result',
			requestId: 'e5',
			success: false,
			error: 'no such column: nope',
		});
	});
});

describe('sqlite_query_history handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const entry = (id: string) => ({
		id,
		sql: `SELECT '${id}'`,
		plan: false,
		params: {},
		ranAt: 1,
		runs: 1,
		outcome: { ok: true, rows: 1, hasMore: false, returnsRows: true, elapsedMs: 1 },
	});
	const full = { path: '/data/app.db', entries: [entry('abcd1234-1'), entry('abcd9999-2')] };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		histories.readSqliteQueryHistory.mockResolvedValue(full);
	});

	it('answers with the history and nothing removed', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h1',
			path: '/data/app.db',
		});
		await flush();
		expect(histories.readSqliteQueryHistory).toHaveBeenCalledWith('h1');
		expect(histories.forgetSqliteQueryHistory).not.toHaveBeenCalled();
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_history_result',
			requestId: 'h1',
			success: true,
			database: info,
			history: full,
			removed: 0,
		});
	});

	it('forgets one entry by a unique start of its id', async () => {
		histories.forgetSqliteQueryHistory.mockResolvedValue({
			path: '/data/app.db',
			entries: [entry('abcd9999-2')],
		});
		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h2',
			path: '/data/app.db',
			forget: 'abcd1',
		});
		await flush();
		expect(histories.forgetSqliteQueryHistory).toHaveBeenCalledWith('h1', 'abcd1234-1');
		expect(lastResponse(client)).toMatchObject({ requestId: 'h2', success: true, removed: 1 });
	});

	it('refuses an id that names no entry, or more than one', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h3',
			path: '/data/app.db',
			forget: 'zzzz',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'h3', success: false });

		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h4',
			path: '/data/app.db',
			forget: 'abcd',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'h4',
			success: false,
			error: expect.stringContaining('more than one'),
		});
		expect(histories.forgetSqliteQueryHistory).not.toHaveBeenCalled();
	});

	it('clears the whole history', async () => {
		histories.forgetSqliteQueryHistory.mockResolvedValue({ path: '/data/app.db', entries: [] });
		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h5',
			path: '/data/app.db',
			clear: true,
		});
		await flush();
		expect(histories.forgetSqliteQueryHistory).toHaveBeenCalledWith('h1', null);
		expect(lastResponse(client)).toMatchObject({ requestId: 'h5', success: true, removed: 2 });
	});

	it('refuses forget and clear together, and a missing path', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_query_history',
			requestId: 'h6',
			path: '/data/app.db',
			forget: 'abcd1',
			clear: true,
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'h6', success: false });

		handler.handleMessage(client, { type: 'sqlite_query_history', requestId: 'h7' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'h7', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});
});

describe('sqlite_statement_log handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const write = {
		id: 'w1',
		kind: 'cell',
		sql: "UPDATE users SET email = 'a@b.c' WHERE rowid = 7",
		params: {},
		table: 'users',
		transactionId: null,
		at: 1,
		outcome: { ok: true, changes: 1, otherChanges: 0, schemaChanges: [] },
	};
	const full = { path: '/data/app.db', entries: [write] };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		statementLogs.readSqliteStatementLog.mockResolvedValue(full);
		statementLogs.clearSqliteStatementLog.mockResolvedValue({ path: '/data/app.db', entries: [] });
	});

	it('answers with the log, reading only', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_statement_log',
			requestId: 'l1',
			path: '/data/app.db',
		});
		await flush();
		expect(statementLogs.readSqliteStatementLog).toHaveBeenCalledWith('h1');
		expect(statementLogs.clearSqliteStatementLog).not.toHaveBeenCalled();
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_log_result',
			requestId: 'l1',
			success: true,
			database: info,
			log: full,
			removed: 0,
		});
	});

	it('clears the log and says how many writes went', async () => {
		handler.handleMessage(client, {
			type: 'sqlite_statement_log',
			requestId: 'l2',
			path: '/data/app.db',
			clear: true,
		});
		await flush();
		expect(statementLogs.clearSqliteStatementLog).toHaveBeenCalledWith('h1');
		expect(lastResponse(client)).toMatchObject({ requestId: 'l2', success: true, removed: 1 });
	});

	it('refuses a missing path and a clear that is not a flag', async () => {
		handler.handleMessage(client, { type: 'sqlite_statement_log', requestId: 'l3' });
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'l3', success: false });
		handler.handleMessage(client, {
			type: 'sqlite_statement_log',
			requestId: 'l4',
			path: '/data/app.db',
			clear: 'yes',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({ requestId: 'l4', success: false });
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
	});

	it('answers a failure with its message, keeping the request id', async () => {
		statementLogs.readSqliteStatementLog.mockRejectedValue(new Error('disk on fire'));
		handler.handleMessage(client, {
			type: 'sqlite_statement_log',
			requestId: 'l5',
			path: '/data/app.db',
		});
		await flush();
		expect(lastResponse(client)).toEqual({
			type: 'sqlite_log_result',
			requestId: 'l5',
			success: false,
			error: 'disk on fire',
		});
	});
});

describe('sqlite_update_cell handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const message = {
		type: 'sqlite_update_cell',
		requestId: 'u1',
		path: '/data/app.db',
		name: 'users',
		column: 'email',
		row: { kind: 'rowid', rowid: '7' },
		value: { type: 'text', text: 'a@b.c' },
		enableEditing: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
	});

	it('unlocks for this one call, writes through the shared edit, and locks again', async () => {
		const result = {
			name: 'users',
			column: 'email',
			columns: [{ name: 'email', declaredType: 'TEXT' }],
			row: ['a@b.c'],
			key: { kind: 'rowid', rowid: '7' },
			backup: { path: '/data/app.maestro-backup-x.db', bytes: 4096, createdAt: 1 },
			elapsedMs: 1,
		};
		rowEdits.updateSqliteCell.mockResolvedValue(result);

		handler.handleMessage(client, message);
		await flush();

		expect(editing.enableSqliteEditing).toHaveBeenCalledWith('h1');
		expect(rowEdits.updateSqliteCell).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
			name: 'users',
			column: 'email',
			row: { kind: 'rowid', rowid: '7' },
			value: { type: 'text', text: 'a@b.c' },
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_update_result',
			requestId: 'u1',
			success: true,
			database: info,
			result,
		});
		expect(database.closeSqliteDatabase).not.toHaveBeenCalled();
	});

	it('forwards the row version the CLI read, for the edit to check', async () => {
		rowEdits.updateSqliteCell.mockResolvedValue({});
		handler.handleMessage(client, { ...message, version: 'SeenSeenSeenSeenSeen-2' });
		await flush();
		expect(rowEdits.updateSqliteCell).toHaveBeenCalledWith(
			expect.objectContaining({ version: 'SeenSeenSeenSeenSeen-2' })
		);
	});

	it("locks again when the edit fails, and answers with SQLite's words", async () => {
		rowEdits.updateSqliteCell.mockRejectedValue(new Error('UNIQUE constraint failed: users.email'));
		handler.handleMessage(client, message);
		await flush();
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_update_result',
			requestId: 'u1',
			success: false,
			error: 'UNIQUE constraint failed: users.email',
		});
	});

	it('refuses without the per-call unlock, opening nothing', async () => {
		handler.handleMessage(client, { ...message, enableEditing: undefined });
		await flush();
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
		expect(editing.enableSqliteEditing).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error:
				'This changes the database. Pass --enable-editing to unlock editing for this one call.',
		});
	});

	it('answers with the reason when the file cannot be unlocked', async () => {
		editing.enableSqliteEditing.mockRejectedValue(
			new Error('/data/app.db is on a read-only file system.')
		);
		handler.handleMessage(client, message);
		await flush();
		expect(rowEdits.updateSqliteCell).not.toHaveBeenCalled();
		expect(editing.disableSqliteEditing).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: '/data/app.db is on a read-only file system.',
		});
	});

	it('needs a path, a table, a column, a row, and a value', async () => {
		handler.handleMessage(client, { ...message, row: undefined });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'u1',
			success: false,
			error: 'Missing required "path", "name", "column", "row", or "value" for sqlite_update_cell',
		});
	});
});

describe('sqlite_insert_row handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const message = {
		type: 'sqlite_insert_row',
		requestId: 'i1',
		path: '/data/app.db',
		name: 'users',
		values: { email: { type: 'text', text: 'a@b.c' } },
		enableEditing: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
	});

	it('unlocks for this one call, inserts through the shared path, and locks again', async () => {
		const result = {
			name: 'users',
			columns: [{ name: 'email', declaredType: 'TEXT' }],
			row: ['a@b.c'],
			key: { kind: 'rowid', rowid: '8' },
			otherChanges: 0,
			elapsedMs: 1,
		};
		rowEdits.insertSqliteRow.mockResolvedValue(result);
		handler.handleMessage(client, message);
		await flush();
		expect(rowEdits.insertSqliteRow).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
			name: 'users',
			values: { email: { type: 'text', text: 'a@b.c' } },
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_insert_result',
			requestId: 'i1',
			success: true,
			database: info,
			result,
		});
	});

	it('takes a message with no values as "every column takes its default"', async () => {
		rowEdits.insertSqliteRow.mockResolvedValue({ name: 'users' });
		handler.handleMessage(client, { ...message, values: undefined });
		await flush();
		expect(rowEdits.insertSqliteRow).toHaveBeenCalledWith(expect.objectContaining({ values: {} }));
	});

	it("locks again when SQLite refuses the row, and answers with SQLite's words", async () => {
		rowEdits.insertSqliteRow.mockRejectedValue(new Error('NOT NULL constraint failed: users.name'));
		handler.handleMessage(client, message);
		await flush();
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_insert_result',
			success: false,
			error: 'NOT NULL constraint failed: users.name',
		});
	});

	it('refuses without the per-call unlock, opening nothing', async () => {
		handler.handleMessage(client, { ...message, enableEditing: false });
		await flush();
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error:
				'This changes the database. Pass --enable-editing to unlock editing for this one call.',
		});
	});

	it('needs a path and a table, and values as an object', async () => {
		handler.handleMessage(client, { ...message, values: ['a'] });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'i1',
			success: false,
			error:
				'Missing required "path" or "name", or "values" is not an object, for sqlite_insert_row',
		});
		expect(rowEdits.insertSqliteRow).not.toHaveBeenCalled();
	});
});

describe('sqlite_delete_row handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const message = {
		type: 'sqlite_delete_row',
		requestId: 'd1',
		path: '/data/app.db',
		name: 'users',
		row: { kind: 'rowid', rowid: '7' },
		enableEditing: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
	});

	it('unlocks for this one call, deletes through the shared path, and locks again', async () => {
		const result = { name: 'users', key: message.row, otherChanges: 3, elapsedMs: 1 };
		rowEdits.deleteSqliteRow.mockResolvedValue(result);
		handler.handleMessage(client, message);
		await flush();
		expect(rowEdits.deleteSqliteRow).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
			name: 'users',
			row: { kind: 'rowid', rowid: '7' },
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_delete_result',
			requestId: 'd1',
			success: true,
			result,
		});
	});

	it('forwards the row version the CLI read, for the delete to check', async () => {
		rowEdits.deleteSqliteRow.mockResolvedValue({});
		handler.handleMessage(client, { ...message, version: 'SeenSeenSeenSeenSeen-2' });
		await flush();
		expect(rowEdits.deleteSqliteRow).toHaveBeenCalledWith(
			expect.objectContaining({ version: 'SeenSeenSeenSeenSeen-2' })
		);
	});

	it("locks again when a foreign key refuses the delete, and answers with SQLite's words", async () => {
		rowEdits.deleteSqliteRow.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));
		handler.handleMessage(client, message);
		await flush();
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'FOREIGN KEY constraint failed',
		});
	});

	it('refuses without the per-call unlock, opening nothing', async () => {
		handler.handleMessage(client, { ...message, enableEditing: 'yes' });
		await flush();
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
		expect(rowEdits.deleteSqliteRow).not.toHaveBeenCalled();
	});

	it('needs a path, a table, and a row', async () => {
		handler.handleMessage(client, { ...message, row: undefined });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'd1',
			success: false,
			error: 'Missing required "path", "name", or "row" for sqlite_delete_row',
		});
	});
});

describe('sqlite_undo_edit handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const step = {
		kind: 'restore-cell',
		name: 'users',
		column: 'email',
		row: { kind: 'rowid', rowid: '7' },
		version: 'AfterAfterAfterAfter_1',
		value: { type: 'text', text: 'old@example.com' },
	};
	const message = {
		type: 'sqlite_undo_edit',
		requestId: 'u1',
		path: '/data/app.db',
		step,
		enableEditing: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
	});

	it('unlocks for this one call, undoes through the shared path, and locks again', async () => {
		const result = {
			name: 'users',
			kind: 'restore-cell',
			key: step.row,
			otherChanges: 0,
			elapsedMs: 1,
		};
		rowEdits.undoSqliteEdit.mockResolvedValue(result);
		handler.handleMessage(client, message);
		await flush();
		expect(rowEdits.undoSqliteEdit).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
			step,
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_undo_result',
			requestId: 'u1',
			success: true,
			result,
		});
	});

	it('locks again when the undo is refused, and answers with the reason', async () => {
		rowEdits.undoSqliteEdit.mockRejectedValue(new Error('The row of users changed since'));
		handler.handleMessage(client, message);
		await flush();
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'The row of users changed since',
		});
	});

	it('refuses without the per-call unlock, opening nothing', async () => {
		handler.handleMessage(client, { ...message, enableEditing: undefined });
		await flush();
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
		expect(rowEdits.undoSqliteEdit).not.toHaveBeenCalled();
	});

	it('needs a path and a step object', async () => {
		handler.handleMessage(client, { ...message, step: 'restore-cell' });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'u1',
			success: false,
			error: 'Missing required "path" or "step" (an object) for sqlite_undo_edit',
		});
		expect(rowEdits.undoSqliteEdit).not.toHaveBeenCalled();
	});
});

describe('sqlite_run_transaction handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const info = { handle: 'h1', displayPath: '/data/app.db', fileBytes: 4096 };
	const begun = {
		transactionId: 'x1',
		startedAt: 1,
		expiresAt: 2,
		statements: 0,
		changes: 0,
		otherChanges: 0,
		schemaChanges: [],
		backup: { path: '/data/app.maestro-backup-1.db', bytes: 4096, createdAt: 1 },
	};
	const message = {
		type: 'sqlite_run_transaction',
		requestId: 't1',
		path: '/data/app.db',
		statements: ['UPDATE users SET age = 1', 'SELECT age FROM users'],
		end: 'commit',
		enableEditing: true,
	};
	const step = (statement: string) => ({ statement, rows: [], inTransaction: { writes: true } });
	const ended = (outcome: 'committed' | 'rolled-back') => ({
		transactionId: 'x1',
		outcome,
		reason: outcome === 'committed' ? 'Committed ...' : 'Rolled back ...',
		transaction: begun,
		endedAt: 3,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		database.openSqliteDatabase.mockResolvedValue(info);
		editing.enableSqliteEditing.mockResolvedValue({ handle: 'h1', editToken: 'cli-token' });
		transactions.beginSqliteTransaction.mockResolvedValue(begun);
		transactions.readSqliteTransaction.mockReturnValue({ transaction: begun, lastEnd: null });
		queries.runSqliteQuery.mockImplementation(async (request: { sql: string }) =>
			step(request.sql.split(' ')[0])
		);
	});

	it('begins, runs each statement in the transaction in order, commits, and locks again', async () => {
		transactions.endSqliteTransaction.mockResolvedValue(ended('committed'));
		handler.handleMessage(client, message);
		await flush();
		await flush();

		expect(transactions.beginSqliteTransaction).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
		});
		expect(queries.runSqliteQuery.mock.calls.map(([request]) => request)).toEqual([
			{
				handle: 'h1',
				editToken: 'cli-token',
				sql: 'UPDATE users SET age = 1',
				limit: 50,
				transactionId: 'x1',
			},
			{
				handle: 'h1',
				editToken: 'cli-token',
				sql: 'SELECT age FROM users',
				limit: 50,
				transactionId: 'x1',
			},
		]);
		expect(transactions.endSqliteTransaction).toHaveBeenCalledWith({
			handle: 'h1',
			editToken: 'cli-token',
			transactionId: 'x1',
			action: 'commit',
		});
		expect(editing.disableSqliteEditing).toHaveBeenCalledWith('h1', 'cli-token');
		expect(lastResponse(client)).toMatchObject({
			type: 'sqlite_transaction_result',
			requestId: 't1',
			success: true,
			database: info,
			result: {
				begun,
				steps: [step('UPDATE'), step('SELECT')],
				failed: null,
				end: ended('committed'),
			},
		});
	});

	it('stops at the first failure and rolls back, even when Commit was asked for', async () => {
		queries.runSqliteQuery
			.mockResolvedValueOnce(step('UPDATE'))
			.mockRejectedValueOnce(Object.assign(new Error('near "SELEC": syntax error'), { offset: 0 }));
		transactions.endSqliteTransaction.mockResolvedValue(ended('rolled-back'));
		handler.handleMessage(client, {
			...message,
			statements: [...message.statements, 'DELETE FROM users'],
		});
		await flush();
		await flush();

		expect(queries.runSqliteQuery).toHaveBeenCalledTimes(2);
		expect(transactions.endSqliteTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'rollback' })
		);
		expect(lastResponse(client)).toMatchObject({
			success: true,
			result: {
				steps: [step('UPDATE')],
				failed: { index: 1, error: 'near "SELEC": syntax error', errorOffset: 0 },
				end: { outcome: 'rolled-back' },
			},
		});
	});

	it('reports how SQLite ended a transaction it rolled back itself, without ending it again', async () => {
		queries.runSqliteQuery.mockRejectedValueOnce(new Error('UNIQUE constraint failed: users.id'));
		transactions.readSqliteTransaction.mockReturnValue({
			transaction: null,
			lastEnd: ended('rolled-back'),
		});
		handler.handleMessage(client, message);
		await flush();
		await flush();

		expect(transactions.endSqliteTransaction).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			success: true,
			result: {
				failed: { index: 0, error: 'UNIQUE constraint failed: users.id' },
				end: { outcome: 'rolled-back' },
			},
		});
	});

	it('rolls back a Commit SQLite refused, and says the Commit failed', async () => {
		transactions.endSqliteTransaction
			.mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'))
			.mockResolvedValueOnce(ended('rolled-back'));
		handler.handleMessage(client, message);
		await flush();
		await flush();

		expect(transactions.endSqliteTransaction).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: 'rollback' })
		);
		expect(lastResponse(client)).toMatchObject({
			success: true,
			result: {
				failed: { index: null, error: 'FOREIGN KEY constraint failed' },
				end: { outcome: 'rolled-back' },
			},
		});
	});

	it('refuses without the unlock, without statements, or without an end, opening nothing', async () => {
		handler.handleMessage(client, { ...message, enableEditing: undefined });
		handler.handleMessage(client, { ...message, statements: ['UPDATE t SET a = 1', '  '] });
		handler.handleMessage(client, { ...message, end: 'save' });
		await flush();
		const replies = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
			([raw]) => JSON.parse(raw as string).error
		);
		expect(replies).toEqual([
			expect.stringContaining('--enable-editing'),
			'Missing required "path" or "statements" (non-empty statement texts) for sqlite_run_transaction',
			'end must be "commit" or "rollback"',
		]);
		expect(database.openSqliteDatabase).not.toHaveBeenCalled();
		expect(transactions.beginSqliteTransaction).not.toHaveBeenCalled();
	});
});
