import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performNotificationInboxAction } from '../../../renderer/services/notificationInbox';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { notifyToast, useNotificationStore } from '../../../renderer/stores/notificationStore';

const openUrl = vi.fn();
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe('notification inbox operations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ notificationCenterDetails: false });
		useNotificationStore.setState({ notificationCenterExpandedId: null });
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
	it('reports a persistence failure to CLI callers while retaining the resulting snapshot', () => {
		notifyToast({ title: 'Stored', message: '' });
		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Storage denied');
		});
		try {
			expect(performNotificationInboxAction({ action: 'clear' })).toMatchObject({
				success: false,
				historyPersistenceFailed: true,
				notifications: [],
			});
		} finally {
			setItem.mockRestore();
		}
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
	it('dismisses one entry without discarding history or other visible toasts', () => {
		useNotificationStore.getState().setDefaultDuration(0);
		const first = notifyToast({ title: 'First', message: '' });
		const second = notifyToast({ title: 'Second', message: '' });
		const result = performNotificationInboxAction({ action: 'dismiss', id: first });
		expect(result.unreadCount).toBe(1);
		expect(result.notifications).toHaveLength(2);
		expect(useNotificationStore.getState().toasts.map((n) => n.id)).toEqual([second]);
		expect(performNotificationInboxAction({ action: 'dismiss', id: 'gone' }).success).toBe(false);
	});

	it('shares opt-in detail expansion with the CLI and does not mark entries read', () => {
		const id = notifyToast({ title: 'Details', message: 'Full content' });
		expect(performNotificationInboxAction({ action: 'detail', id }).success).toBe(false);
		useSettingsStore.setState({ notificationCenterDetails: true });
		expect(performNotificationInboxAction({ action: 'detail', id })).toMatchObject({
			success: true,
			open: true,
			expandedId: id,
			unreadCount: 1,
		});
		expect(performNotificationInboxAction({ action: 'collapse' }).expandedId).toBe(null);
	});
});
