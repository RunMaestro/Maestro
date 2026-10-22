/**
 * Tests for the cotExport preload API.
 *
 * Verifies each method on window.maestro.cotExport invokes the matching
 * `cotExport:*` channel from COT_EXPORT_CHANNELS with the expected arguments
 * and returns the invoke result unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createCotExportApi } from '../../../main/preload/cotExport';
import { COT_EXPORT_CHANNELS } from '../../../shared/cotExport/channels';

describe('cotExport Preload API', () => {
	let api: ReturnType<typeof createCotExportApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createCotExportApi();
	});

	it('get invokes cotExport:get with the agent id', async () => {
		const config = { enabled: false, folder: null, updatedAt: 0 };
		mockInvoke.mockResolvedValue(config);

		await expect(api.get('agent-1')).resolves.toBe(config);
		expect(mockInvoke).toHaveBeenCalledWith(COT_EXPORT_CHANNELS.get, 'agent-1');
	});

	it('set forwards the complete choice', async () => {
		const result = { ok: false, reason: 'Pick a folder first.' };
		mockInvoke.mockResolvedValue(result);

		await expect(api.set('agent-1', { enabled: true, folder: '/logs' })).resolves.toBe(result);
		expect(mockInvoke).toHaveBeenCalledWith(COT_EXPORT_CHANNELS.set, 'agent-1', {
			enabled: true,
			folder: '/logs',
		});
	});

	it('status invokes cotExport:status with the agent id', async () => {
		const status = { enabled: true, folder: '/logs', turnsToday: 3, unencrypted: false };
		mockInvoke.mockResolvedValue(status);

		await expect(api.status('agent-1')).resolves.toBe(status);
		expect(mockInvoke).toHaveBeenCalledWith(COT_EXPORT_CHANNELS.status, 'agent-1');
	});

	it('validateFolder forwards the agent id and folder', async () => {
		const validation = { ok: true, resolved: '/logs' };
		mockInvoke.mockResolvedValue(validation);

		await expect(api.validateFolder('agent-1', '/logs')).resolves.toBe(validation);
		expect(mockInvoke).toHaveBeenCalledWith(COT_EXPORT_CHANNELS.validateFolder, 'agent-1', '/logs');
	});

	it('verify invokes cotExport:verify with the agent id', async () => {
		const results = [{ folder: '/logs', ok: true }];
		mockInvoke.mockResolvedValue(results);

		await expect(api.verify('agent-1')).resolves.toBe(results);
		expect(mockInvoke).toHaveBeenCalledWith(COT_EXPORT_CHANNELS.verify, 'agent-1');
	});

	it('uses only the channel names from COT_EXPORT_CHANNELS', async () => {
		mockInvoke.mockResolvedValue(undefined);

		await api.get('a');
		await api.set('a', { enabled: false, folder: null });
		await api.status('a');
		await api.validateFolder('a', '/x');
		await api.verify('a');

		const channels = mockInvoke.mock.calls.map((call) => call[0]);
		expect(channels).toEqual([
			'cotExport:get',
			'cotExport:set',
			'cotExport:status',
			'cotExport:validateFolder',
			'cotExport:verify',
		]);
	});
});
