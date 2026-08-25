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
		/** Grab the handler the API registered for `channel`. */
		function registerFor(channel: string): (...args: any[]) => void {
			let registered: ((...args: any[]) => void) | undefined;
			mockOn.mockImplementation((ch: string, handler: (...args: any[]) => void) => {
				if (ch === channel) registered = handler;
			});
			return (...args: any[]) => registered!(...args);
		}

		it('forwards a parent group ID and appearance in their fixed IPC argument positions', () => {
			const callback = vi.fn();
			const fire = registerFor('remote:createGroup');

			api.onRemoteCreateGroup(callback);
			fire({}, 'Project', '📁', 'company', { icon: 'rocket' }, 'response-channel');

			expect(callback).toHaveBeenCalledWith(
				'Project',
				'📁',
				'company',
				{ icon: 'rocket' },
				'response-channel'
			);
		});

		it('substitutes an empty appearance when an older main process omits it', () => {
			const callback = vi.fn();
			const fire = registerFor('remote:createGroup');

			api.onRemoteCreateGroup(callback);
			fire({}, 'Project', '📁', 'company', undefined, 'response-channel');

			expect(callback).toHaveBeenCalledWith('Project', '📁', 'company', {}, 'response-channel');
		});
	});

	describe('onRemoteUpdateGroup', () => {
		it('forwards the group ID and update payload', () => {
			const callback = vi.fn();
			let registered: ((...args: any[]) => void) | undefined;
			mockOn.mockImplementation((ch: string, handler: (...args: any[]) => void) => {
				if (ch === 'remote:updateGroup') registered = handler;
			});

			api.onRemoteUpdateGroup(callback);
			registered!({}, 'group-1', { icon: 'shield', clear: ['color'] }, 'response-channel');

			expect(callback).toHaveBeenCalledWith(
				'group-1',
				{ icon: 'shield', clear: ['color'] },
				'response-channel'
			);
		});

		it('unsubscribes from the IPC channel', () => {
			const unsubscribe = api.onRemoteUpdateGroup(vi.fn());
			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('remote:updateGroup', expect.any(Function));
		});
	});
});
