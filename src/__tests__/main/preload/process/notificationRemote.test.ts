import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcRenderer } from 'electron';
import { createNotificationRemoteApi } from '../../../../main/preload/process/notificationRemote';

vi.mock('electron', () => ({
	ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

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
