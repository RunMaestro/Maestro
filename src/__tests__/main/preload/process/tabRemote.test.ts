/**
 * Tests for process/tabRemote preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createTabRemoteApi } from '../../../../main/preload/process/tabRemote';

describe('Process TabRemote Preload API', () => {
	let api: ReturnType<typeof createTabRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createTabRemoteApi();
	});

	it('forwards the optional desktop tab inventory with remote selection events', () => {
		const callback = vi.fn();
		const tabs = [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: 'New tab',
				starred: false,
				inputValue: '',
				createdAt: 1700000000000,
				state: 'idle' as const,
			},
		];

		api.onRemoteSelectTab(callback);
		const handler = mockOn.mock.calls.find(([channel]) => channel === 'remote:selectTab')?.[1];
		handler({}, 'session-1', 'tab-1', tabs, true);

		expect(callback).toHaveBeenCalledWith('session-1', 'tab-1', tabs, true);
	});

	describe('sendRemoteNewTabResponse', () => {
		it('should send response via ipcRenderer.send', () => {
			api.sendRemoteNewTabResponse('response-channel', { tabId: 'tab-123' });

			expect(mockSend).toHaveBeenCalledWith('response-channel', { tabId: 'tab-123' });
		});

		it('should send null result', () => {
			api.sendRemoteNewTabResponse('response-channel', null);

			expect(mockSend).toHaveBeenCalledWith('response-channel', null);
		});
	});
});
