/**
 * Tests for the SQLite preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createSqliteApi } from '../../../main/preload/sqlite';

describe('SQLite Preload API', () => {
	let api: ReturnType<typeof createSqliteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSqliteApi();
	});

	it('opens a database by path', async () => {
		mockInvoke.mockResolvedValue({ handle: 'h1' });
		await api.open('/data/app.db');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:open', '/data/app.db');
	});

	it('reads the database summary by handle', async () => {
		mockInvoke.mockResolvedValue({ pageSize: 4096 });
		await api.readSummary('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readSummary', 'h1');
	});

	it('checks integrity by handle and mode', async () => {
		mockInvoke.mockResolvedValue({ mode: 'full', ok: true, problems: [] });
		await api.checkIntegrity('h1', 'full');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:checkIntegrity', 'h1', 'full');
	});

	it('lists objects by handle', async () => {
		mockInvoke.mockResolvedValue({ objects: [], sizesAvailable: true });
		await api.listObjects('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:listObjects', 'h1');
	});

	it('asks for stats of the named objects', async () => {
		mockInvoke.mockResolvedValue([]);
		await api.readObjectStats('h1', ['users', 'orders']);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readObjectStats', 'h1', ['users', 'orders']);
	});

	it('reads one object schema, passing the kind through', async () => {
		mockInvoke.mockResolvedValue({ name: 'users', kind: 'table' });
		await api.readSchema('h1', 'users', 'table');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readSchema', 'h1', 'users', 'table');
		await api.readSchema('h1', 'users');
		expect(mockInvoke).toHaveBeenLastCalledWith('sqlite:readSchema', 'h1', 'users', undefined);
	});

	it('reads the column catalog by handle', async () => {
		mockInvoke.mockResolvedValue({ objects: [] });
		await api.readColumns('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readColumns', 'h1');
	});

	it('reads a window of rows', async () => {
		const request = { handle: 'h1', name: 'users', offset: 0, limit: 300, sort: null };
		mockInvoke.mockResolvedValue({ name: 'users', rows: [], hasMore: false });
		await api.readRows(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:readRows', request);
	});

	it('counts rows, passing the request through', async () => {
		const request = {
			handle: 'h1',
			name: 'users',
			filter: null,
			cursor: { matched: 1, scanned: 1, afterRowid: '1' },
		};
		mockInvoke.mockResolvedValue({ name: 'users', matched: 2, complete: true, cursor: null });
		await api.countRows(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:countRows', request);
	});

	it('saves a BLOB', async () => {
		const request = {
			handle: 'h1',
			name: 'media',
			column: 'data',
			offset: 3,
			destPath: '/tmp/x.bin',
		};
		mockInvoke.mockResolvedValue({ path: '/tmp/x.bin', bytes: 4, rowid: null });
		await api.saveBlob(request);
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:saveBlob', request);
	});

	it('closes a handle', async () => {
		mockInvoke.mockResolvedValue(undefined);
		await api.close('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:close', 'h1');
	});
});
