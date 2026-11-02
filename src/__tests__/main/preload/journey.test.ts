/**
 * User Journey preload API.
 *
 * A verb pointed at the wrong channel, or one that drops an argument, fails
 * silently: the promise resolves and nothing is recorded or read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createJourneyApi } from '../../../main/preload/journey';

describe('Journey Preload API', () => {
	let api: ReturnType<typeof createJourneyApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createJourneyApi();
	});

	it('exposes exactly append, read, and getPath', () => {
		expect(Object.keys(api).sort()).toEqual(['append', 'getPath', 'read']);
	});

	it('appends one entry', async () => {
		const entry = { ts: 1, agentId: 'a1', kind: 'file.open' as const, target: '/p/a.ts' };
		mockInvoke.mockResolvedValueOnce(true);
		await expect(api.append(entry)).resolves.toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith('journey:append', entry);
	});

	it('reads with the agent id and options in order', async () => {
		mockInvoke.mockResolvedValueOnce([]);
		await expect(api.read('a1', { tail: 10, kinds: ['file.save'] })).resolves.toEqual([]);
		expect(mockInvoke).toHaveBeenCalledWith('journey:read', 'a1', {
			tail: 10,
			kinds: ['file.save'],
		});
	});

	it('maps getPath to journey:path', async () => {
		mockInvoke.mockResolvedValueOnce('/data/journey/a1.jsonl');
		await expect(api.getPath('a1')).resolves.toBe('/data/journey/a1.jsonl');
		expect(mockInvoke).toHaveBeenCalledWith('journey:path', 'a1');
	});
});
