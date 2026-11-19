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

	it('closes a handle', async () => {
		mockInvoke.mockResolvedValue(undefined);
		await api.close('h1');
		expect(mockInvoke).toHaveBeenCalledWith('sqlite:close', 'h1');
	});
});
