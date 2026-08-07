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
