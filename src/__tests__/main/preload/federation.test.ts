/**
 * Federation preload API: the History verbs of a mirrored agent.
 *
 * A verb pointed at the wrong channel, or one that drops or reorders an argument, fails
 * silently: the History panel of a mirrored agent shows nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: vi.fn(),
		removeListener: vi.fn(),
	},
}));

import { createFederationApi } from '../../../main/preload/federation';

describe('Federation Preload API', () => {
	let api: ReturnType<typeof createFederationApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createFederationApi();
	});

	it('exposes the History verbs beside the mirror reads', () => {
		expect(Object.keys(api)).toEqual(
			expect.arrayContaining(['historyPage', 'historyGraph', 'historyOffset', 'transcript'])
		);
	});

	it('pages a mirrored agent History with its query, or an empty one', async () => {
		const page = { entries: [], hasMore: false, total: 0, limit: 20, offset: 0 };
		mockInvoke.mockResolvedValueOnce(page);
		const query = { lookbackHours: 24, types: ['USER' as const], hostKey: 'laptop' };
		await expect(api.historyPage('build', 'a1', query)).resolves.toBe(page);
		expect(mockInvoke).toHaveBeenCalledWith('federation:historyPage', 'build', 'a1', query);
		await api.historyPage('build', 'a1');
		expect(mockInvoke).toHaveBeenLastCalledWith('federation:historyPage', 'build', 'a1', {});
	});

	it('reads the graph with the bucket count and lookback in order', async () => {
		await api.historyGraph('build', 'a1', 24, null);
		expect(mockInvoke).toHaveBeenCalledWith('federation:historyGraph', 'build', 'a1', 24, null);
	});

	it('reads the offset with the timestamp, lookback, and types in order', async () => {
		mockInvoke.mockResolvedValueOnce(4);
		await expect(api.historyOffset('build', 'a1', 1234, 48, ['AUTO'])).resolves.toBe(4);
		expect(mockInvoke).toHaveBeenCalledWith('federation:historyOffset', 'build', 'a1', 1234, 48, [
			'AUTO',
		]);
	});
});
