/**
 * Tests for the parquet preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createParquetApi } from '../../../main/preload/parquet';

describe('Parquet Preload API', () => {
	let api: ReturnType<typeof createParquetApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createParquetApi();
	});

	it('opens a local file', async () => {
		mockInvoke.mockResolvedValue({ handle: 'h1' });
		await api.open('/data/events.parquet');
		expect(mockInvoke).toHaveBeenCalledWith('parquet:open', '/data/events.parquet', undefined);
	});

	it('forwards the SSH remote id so remote files resolve on the right host', async () => {
		mockInvoke.mockResolvedValue({ handle: 'h1' });
		await api.open('/data/events.parquet', 'remote-7');
		expect(mockInvoke).toHaveBeenCalledWith('parquet:open', '/data/events.parquet', 'remote-7');
	});

	it('sends a query as a single request object', async () => {
		mockInvoke.mockResolvedValue({ rows: [] });
		const request = { handle: 'h1', filter: 'a = 1', offset: 0, limit: 100 };
		await api.query(request);
		expect(mockInvoke).toHaveBeenCalledWith('parquet:query', request);
	});

	it('exports the match set', async () => {
		mockInvoke.mockResolvedValue({ path: '/tmp/out.csv', rows: 3, truncated: false });
		const options = { handle: 'h1', filter: '', destPath: '/tmp/out.csv', format: 'csv' as const };
		const result = await api.export(options);
		expect(mockInvoke).toHaveBeenCalledWith('parquet:export', options);
		expect(result.rows).toBe(3);
	});

	it('closes a handle', async () => {
		mockInvoke.mockResolvedValue(undefined);
		await api.close('h1');
		expect(mockInvoke).toHaveBeenCalledWith('parquet:close', 'h1');
	});
});
