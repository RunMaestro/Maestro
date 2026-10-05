import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performNotificationInboxAction } from '../../../renderer/services/notificationInbox';
import { notifyToast, useNotificationStore } from '../../../renderer/stores/notificationStore';

const openUrl = vi.fn();
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe('notification inbox operations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useNotificationStore.setState({ history: [], toasts: [], notificationCenterOpen: false });
		useNotificationStore.getState().setDefaultDuration(-1);
		useNotificationStore.getState().setOsNotifications(false);
	});
	it('reads and clears the same history seen by the UI, and returns current unread counts', () => {
		const first = notifyToast({ title: 'First', message: '' });
		const second = notifyToast({ title: 'Second', message: '' });
		expect(performNotificationInboxAction({ action: 'open' })).toMatchObject({
			success: true,
			open: true,
			unreadCount: 2,
		});
		expect(performNotificationInboxAction({ action: 'read', id: first }).unreadCount).toBe(1);
		expect(
			performNotificationInboxAction({ action: 'list', unread: true }).notifications?.map(
				(n) => n.id
			)
		).toEqual([second]);
		expect(performNotificationInboxAction({ action: 'read-all' }).unreadCount).toBe(0);
		expect(useNotificationStore.getState().history.every((n) => n.read)).toBe(true);
		expect(performNotificationInboxAction({ action: 'clear' }).notifications).toEqual([]);
		expect(performNotificationInboxAction({ action: 'close' }).open).toBe(false);
	});
	it('shares entry activation while keeping inline links independent and callbacks off the wire', () => {
		const onClick = vi.fn();
		const id = notifyToast({
			title: 'PR',
			message: '',
			actionUrl: 'https://example.com/pr',
			onClick,
		});
		expect(
			performNotificationInboxAction({ action: 'list' }).notifications?.[0]
		).not.toHaveProperty('onClick');
		performNotificationInboxAction({ action: 'link', id });
		expect(openUrl).toHaveBeenCalledWith('https://example.com/pr');
		expect(onClick).not.toHaveBeenCalled();
		performNotificationInboxAction({ action: 'activate', id });
		expect(onClick).toHaveBeenCalledOnce();
	});
	it('reports stale IDs and entries without a link', () => {
		expect(performNotificationInboxAction({ action: 'read', id: 'gone' })).toMatchObject({
			success: false,
		});
		const id = notifyToast({ title: 'Plain', message: '' });
		expect(performNotificationInboxAction({ action: 'link', id })).toMatchObject({
			success: false,
		});
	});
});
