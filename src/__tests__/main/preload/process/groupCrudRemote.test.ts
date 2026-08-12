/**
 * Tests for process/groupCrudRemote preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createGroupCrudRemoteApi } from '../../../../main/preload/process/groupCrudRemote';

describe('Process GroupCrudRemote Preload API', () => {
	let api: ReturnType<typeof createGroupCrudRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createGroupCrudRemoteApi();
	});

	describe('onRemoteCreateGroup', () => {
		it('forwards a parent group ID in its fixed IPC argument position', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				name: string,
				emoji: string | undefined,
				parentGroupId: string | undefined,
				responseChannel: string
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:createGroup') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCreateGroup(callback);
			registeredHandler!({}, 'Project', '📁', 'company', 'response-channel');

			expect(callback).toHaveBeenCalledWith('Project', '📁', 'company', 'response-channel');
		});
	});
});
