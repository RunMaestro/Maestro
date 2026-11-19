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
const schema = vi.hoisted(() => ({
	readSqliteObjectSchema: vi.fn(),
	readSqliteColumnCatalog: vi.fn(),
}));
const rows = vi.hoisted(() => ({ readSqliteRows: vi.fn() }));
const count = vi.hoisted(() => ({ countSqliteRows: vi.fn() }));
const blob = vi.hoisted(() => ({ saveSqliteBlob: vi.fn() }));
const summary = vi.hoisted(() => ({ readSqliteDatabaseSummary: vi.fn() }));
const integrity = vi.hoisted(() => ({ checkSqliteIntegrity: vi.fn() }));
const query = vi.hoisted(() => ({
	runSqliteQuery: vi.fn(),
	cancelSqliteQuery: vi.fn(),
	exportSqliteQuery: vi.fn(),
}));
const history = vi.hoisted(() => ({
	readSqliteQueryHistory: vi.fn(),
	forgetSqliteQueryHistory: vi.fn(),
}));

vi.mock('../../../../main/sqlite/sqlite-objects', () => objects);
vi.mock('../../../../main/sqlite/sqlite-schema', () => schema);
vi.mock('../../../../main/sqlite/sqlite-rows', () => rows);
vi.mock('../../../../main/sqlite/sqlite-count', () => count);
vi.mock('../../../../main/sqlite/sqlite-blob', () => blob);
vi.mock('../../../../main/sqlite/sqlite-summary', () => summary);
vi.mock('../../../../main/sqlite/sqlite-integrity', () => integrity);
vi.mock('../../../../main/sqlite/sqlite-query', () => query);
vi.mock('../../../../main/sqlite/sqlite-query-history', () => history);

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
			'sqlite:cancelQuery',
			'sqlite:checkIntegrity',
			'sqlite:close',
			'sqlite:countRows',
			'sqlite:exportQuery',
			'sqlite:forgetQueryHistory',
			'sqlite:listObjects',
			'sqlite:open',
			'sqlite:readColumns',
			'sqlite:readObjectStats',
			'sqlite:readQueryHistory',
			'sqlite:readRows',
			'sqlite:readSchema',
			'sqlite:readSummary',
			'sqlite:runQuery',
			'sqlite:saveBlob',
		]);
	});

	it('reads the database summary by handle', async () => {
		summary.readSqliteDatabaseSummary.mockReturnValue({ pageSize: 4096 });
		await expect(invoke('sqlite:readSummary', 'h1')).resolves.toEqual({ pageSize: 4096 });
		expect(summary.readSqliteDatabaseSummary).toHaveBeenCalledWith('h1');
	});

	it('checks integrity by handle and mode, treating anything but full as quick', async () => {
		integrity.checkSqliteIntegrity.mockResolvedValue({ ok: true });
		await expect(invoke('sqlite:checkIntegrity', 'h1', 'full')).resolves.toEqual({ ok: true });
		await invoke('sqlite:checkIntegrity', 'h1', 'bogus');
		expect(integrity.checkSqliteIntegrity).toHaveBeenNthCalledWith(1, 'h1', 'full');
		expect(integrity.checkSqliteIntegrity).toHaveBeenNthCalledWith(2, 'h1', 'quick');
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

	it('reads the column catalog for SQL completion by handle', async () => {
		const catalog = { objects: [{ name: 'users', kind: 'table', internal: false, columns: [] }] };
		schema.readSqliteColumnCatalog.mockReturnValue(catalog);
		await expect(invoke('sqlite:readColumns', 'h1')).resolves.toEqual(catalog);
		expect(schema.readSqliteColumnCatalog).toHaveBeenCalledWith('h1');
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

	it('counts rows with the default budget, passing the cursor through', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			filter: 'status = active',
			cursor: { matched: 10, scanned: 40, afterRowid: '40' },
		};
		const result = { name: 'users', matched: 12, complete: true, cursor: null };
		count.countSqliteRows.mockReturnValue(result);
		await expect(invoke('sqlite:countRows', request)).resolves.toEqual(result);
		// No budget argument: the IPC surface cannot widen how long main is held.
		expect(count.countSqliteRows).toHaveBeenCalledWith(request);
	});

	it('saves a BLOB with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			name: 'media',
			column: 'data',
			rowid: '7',
			expected: { bytes: 16, head: '89504e47' },
			destPath: '/tmp/logo.png',
		};
		const saved = { path: '/tmp/logo.png', bytes: 16, rowid: '7' };
		blob.saveSqliteBlob.mockResolvedValue(saved);
		await expect(invoke('sqlite:saveBlob', request)).resolves.toEqual(saved);
		expect(blob.saveSqliteBlob).toHaveBeenCalledWith(request);
	});

	it('runs a query with the request passed through whole, and stops one by id', async () => {
		const request = { handle: 'h1', sql: 'SELECT 1', offset: 0, limit: 500, queryId: 'q1' };
		const result = {
			statement: 'SELECT',
			columns: [{ name: '1', declaredType: null }],
			rows: [[1]],
			offset: 0,
			hasMore: false,
			returnsRows: true,
			elapsedMs: 0,
		};
		query.runSqliteQuery.mockResolvedValue(result);
		await expect(invoke('sqlite:runQuery', request)).resolves.toEqual(result);
		expect(query.runSqliteQuery).toHaveBeenCalledWith(request);

		query.cancelSqliteQuery.mockReturnValue(true);
		await expect(invoke('sqlite:cancelQuery', 'q1')).resolves.toBe(true);
		expect(query.cancelSqliteQuery).toHaveBeenCalledWith('q1');
	});

	it('exports a query with the request passed through whole', async () => {
		const request = {
			handle: 'h1',
			sql: 'SELECT * FROM t',
			destPath: '/tmp/out.csv',
			format: 'csv',
			queryId: 'e1',
		};
		const exported = {
			path: '/tmp/out.csv',
			format: 'csv',
			rows: 3,
			columns: 2,
			bytes: 40,
			elapsedMs: 1,
		};
		query.exportSqliteQuery.mockResolvedValue(exported);
		await expect(invoke('sqlite:exportQuery', request)).resolves.toEqual(exported);
		expect(query.exportSqliteQuery).toHaveBeenCalledWith(request);
	});

	it('reads the query history by handle, and forgets one entry or all of them', async () => {
		const left = { path: '/data/app.db', entries: [] };
		history.readSqliteQueryHistory.mockResolvedValue(left);
		await expect(invoke('sqlite:readQueryHistory', 'h1')).resolves.toEqual(left);
		expect(history.readSqliteQueryHistory).toHaveBeenCalledWith('h1');

		history.forgetSqliteQueryHistory.mockResolvedValue(left);
		await expect(invoke('sqlite:forgetQueryHistory', 'h1', 'id-1')).resolves.toEqual(left);
		expect(history.forgetSqliteQueryHistory).toHaveBeenCalledWith('h1', 'id-1');
		await invoke('sqlite:forgetQueryHistory', 'h1', undefined);
		expect(history.forgetSqliteQueryHistory).toHaveBeenLastCalledWith('h1', null);
	});

	it('closes by handle', async () => {
		await invoke('sqlite:close', 'h1');
		expect(database.closeSqliteDatabase).toHaveBeenCalledWith('h1');
	});
});
