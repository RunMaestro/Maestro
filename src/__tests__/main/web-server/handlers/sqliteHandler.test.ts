// Covers the sqlite_read_summary, sqlite_list_objects, sqlite_read_schema,
// sqlite_read_rows, sqlite_count_rows, sqlite_save_blob, and sqlite_run_query
// WebSocket messages that back `maestro-cli sqlite info`, `sqlite tables`,
// `sqlite schema`, `sqlite rows`, `sqlite count`, `sqlite blob`, and `sqlite query`. It opens the database through the viewer's own open path,
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
const queries = vi.hoisted(() => ({ runSqliteQuery: vi.fn() }));
vi.mock('../../../../main/sqlite/sqlite-query', () => queries);

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
