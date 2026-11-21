// Source: src/__tests__/main/preload/process/groupCrudRemote.test.ts
// Source: src/__tests__/main/preload/process/notificationRemote.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { createGroupCrudRemoteApi } from '../../../../main/preload/process/groupCrudRemote';
import { createNotificationRemoteApi } from '../../../../main/preload/process/notificationRemote';
const mockIpcRenderer = vi.hoisted(() => ({
	on: vi.fn(),
	removeListener: vi.fn(),
	send: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer: mockIpcRenderer }));
beforeEach(() => {
	for (const mock of Object.values(mockIpcRenderer)) mock.mockReset();
});
describe('groupCrudRemote', () => {
	const mockOn = ipcRenderer.on;
	const mockRemoveListener = ipcRenderer.removeListener;

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
});
describe('notificationRemote', () => {
	beforeEach(() => vi.clearAllMocks());

	describe('notification inbox preload bridge', () => {
		it('returns the resulting store snapshot and unregisters the request listener', async () => {
			const result = { success: true, unreadCount: 0, notifications: [] };
			const callback = vi.fn().mockReturnValue(result);
			const cleanup = createNotificationRemoteApi().onRemoteNotificationInbox(callback);
			const handler = vi.mocked(ipcRenderer.on).mock.calls[0][1];
			await handler({} as never, { action: 'clear' }, 'response-channel');
			expect(callback).toHaveBeenCalledWith({ action: 'clear' });
			expect(ipcRenderer.send).toHaveBeenCalledWith('response-channel', result);
			cleanup();
			expect(ipcRenderer.removeListener).toHaveBeenCalledWith('remote:notificationInbox', handler);
		});

		it('returns a failure to the requester when the store operation throws', async () => {
			createNotificationRemoteApi().onRemoteNotificationInbox(async () => {
				throw new Error('Inbox failed');
			});
			const handler = vi.mocked(ipcRenderer.on).mock.calls[0][1];
			await handler({} as never, { action: 'read-all' }, 'response-channel');
			expect(ipcRenderer.send).toHaveBeenCalledWith('response-channel', {
				success: false,
				error: 'Inbox failed',
			});
		});
	});
});
