/**
 * Tests for the SQLite IPC handlers: each channel forwards to the main-process
 * function the viewer and the CLI share.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(channel, handler);
		},
	},
}));

const database = vi.hoisted(() => ({
	openSqliteDatabase: vi.fn(),
	closeSqliteDatabase: vi.fn(),
}));
const objects = vi.hoisted(() => ({
	listSqliteObjects: vi.fn(),
	readSqliteObjectStats: vi.fn(),
}));

vi.mock('../../../../main/sqlite/sqlite-database', () => database);
const schema = vi.hoisted(() => ({ readSqliteObjectSchema: vi.fn() }));
const rows = vi.hoisted(() => ({ readSqliteRows: vi.fn() }));

vi.mock('../../../../main/sqlite/sqlite-objects', () => objects);
vi.mock('../../../../main/sqlite/sqlite-schema', () => schema);
vi.mock('../../../../main/sqlite/sqlite-rows', () => rows);

import { registerSqliteHandlers } from '../../../../main/ipc/handlers/sqlite';

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

describe('SQLite IPC handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();
		registerSqliteHandlers();
	});

	it('registers the channels the viewer uses', () => {
		expect([...handlers.keys()].sort()).toEqual([
			'sqlite:close',
			'sqlite:listObjects',
			'sqlite:open',
			'sqlite:readObjectStats',
			'sqlite:readRows',
			'sqlite:readSchema',
		]);
	});

	it('opens by path', async () => {
		database.openSqliteDatabase.mockResolvedValue({ handle: 'h1' });
		await expect(invoke('sqlite:open', '/data/app.db')).resolves.toEqual({ handle: 'h1' });
		expect(database.openSqliteDatabase).toHaveBeenCalledWith('/data/app.db');
	});

	it('lists objects and reads stats by handle', async () => {
		objects.listSqliteObjects.mockReturnValue({ objects: [], sizesAvailable: true });
		objects.readSqliteObjectStats.mockReturnValue([]);
		await invoke('sqlite:listObjects', 'h1');
		await invoke('sqlite:readObjectStats', 'h1', ['users']);
		expect(objects.listSqliteObjects).toHaveBeenCalledWith('h1');
		expect(objects.readSqliteObjectStats).toHaveBeenCalledWith('h1', ['users']);
	});

	it('reads one object schema by handle, name, and kind', async () => {
		schema.readSqliteObjectSchema.mockReturnValue({ name: 'users', kind: 'table' });
		await expect(invoke('sqlite:readSchema', 'h1', 'users', 'table')).resolves.toEqual({
			name: 'users',
			kind: 'table',
		});
		expect(schema.readSqliteObjectSchema).toHaveBeenCalledWith('h1', 'users', 'table');
	});

	it('reads a window of rows with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			offset: 300,
			limit: 300,
			sort: { column: 'name', direction: 'desc' },
		};
		rows.readSqliteRows.mockReturnValue({ name: 'users', rows: [], hasMore: false });
		await expect(invoke('sqlite:readRows', request)).resolves.toEqual({
			name: 'users',
			rows: [],
			hasMore: false,
		});
		expect(rows.readSqliteRows).toHaveBeenCalledWith(request);
	});

	it('closes by handle', async () => {
		await invoke('sqlite:close', 'h1');
		expect(database.closeSqliteDatabase).toHaveBeenCalledWith('h1');
	});
});
