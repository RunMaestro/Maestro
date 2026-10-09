import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationInbox } from '../../../cli/commands/notification-inbox';
import { withMaestroClient } from '../../../cli/services/maestro-client';
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

describe('notification inbox CLI', () => {
	const sendCommand = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(withMaestroClient).mockImplementation((action) => action({ sendCommand } as never));
	});
	afterEach(() => vi.restoreAllMocks());
	it('requests the desktop history and prints its verified snapshot as JSON', async () => {
		const result = {
			success: true,
			open: false,
			unreadCount: 1,
			notifications: [{ id: 'n1', read: false }],
		};
		sendCommand.mockResolvedValue(result);
		await notificationInbox({ action: 'list', unread: true }, { json: true });
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'notification_inbox', action: 'list', unread: true },
			'notification_inbox_result'
		);
		expect(console.log).toHaveBeenCalledWith(JSON.stringify(result));
		expect(process.exit).not.toHaveBeenCalled();
	});
	it('reports failure rather than treating delivery as success', async () => {
		sendCommand.mockResolvedValue({ success: false, error: 'Notification not found' });
		await notificationInbox({ action: 'read', id: 'gone' }, { json: true });
		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ success: false, error: 'Notification not found' })
		);
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
