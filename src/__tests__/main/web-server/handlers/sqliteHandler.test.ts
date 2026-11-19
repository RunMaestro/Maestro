// Covers the sqlite_list_objects WebSocket message that backs `maestro-cli
// sqlite tables`. It opens the database through the viewer's own open path,
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
vi.mock('../../../../main/sqlite/sqlite-objects', () => objects);

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
