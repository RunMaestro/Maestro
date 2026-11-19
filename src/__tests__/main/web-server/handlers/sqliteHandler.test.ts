// Covers the sqlite_list_objects, sqlite_read_schema, and sqlite_read_rows
// WebSocket messages that back `maestro-cli sqlite tables`, `sqlite schema`,
// and `sqlite rows`. It opens the database through the viewer's own open path,
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
