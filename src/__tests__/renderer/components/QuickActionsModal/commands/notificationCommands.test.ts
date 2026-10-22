import { describe, expect, it, vi } from 'vitest';

const { toggleInAppToasts } = vi.hoisted(() => ({ toggleInAppToasts: vi.fn() }));
vi.mock('../../../../../renderer/services/inAppToasts', () => ({ toggleInAppToasts }));

import { buildNotificationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/notificationCommands';
import type { ToastPosition } from '../../../../../shared/toastPosition';

function harness(
	visibleToastCount: number,
	toastPosition: ToastPosition = 'bottom-right',
	unreadNotificationCount = 0,
	notificationCenterEnabled = true,
	toastsEnabled = true
) {
	const clearToasts = vi.fn();
	const openNotificationCenter = notificationCenterEnabled ? vi.fn() : undefined;
	const setToastPosition = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildNotificationCommands({
		visibleToastCount,
		clearToasts,
		unreadNotificationCount,
		openNotificationCenter,
		toastsEnabled,
		toastPosition,
		setToastPosition,
		setQuickActionOpen,
	});
	const clearAll = actions.find((a) => a.id === 'clear-all-notifications')!;
	const positionActions = actions.filter((a) => a.id.startsWith('toast-position-'));
	return {
		openNotificationCenter,
		actions,
		clearAll,
		positionActions,
		clearToasts,
		setToastPosition,
		setQuickActionOpen,
	};
}

describe('buildNotificationCommands', () => {
	it('still offers the command when no toasts are on screen', () => {
		// Users search the palette for this by name before they know whether it
		// applies. Hiding it at zero makes that search come back empty, which
		// reads as "the feature does not exist".
		expect(harness(0).clearAll).toBeDefined();
	});

	it('says so in the subtext when there is nothing to clear', () => {
		expect(harness(0).clearAll.subtext).toBe('No notifications on screen');
	});

	it('offers the clear command when toasts are stacked up', () => {
		expect(harness(12).clearAll.label).toBe('Clear All Notifications');
	});

	it('reports the pending count in the subtext', () => {
		expect(harness(12).clearAll.subtext).toBe('Dismiss 12 visible toasts');
	});

	it('singularizes the subtext for a lone toast', () => {
		expect(harness(1).clearAll.subtext).toBe('Dismiss 1 visible toast');
	});

	it('clears the queue and closes the palette', () => {
		const { clearAll, clearToasts, setQuickActionOpen } = harness(3);
		clearAll.action();
		expect(clearToasts).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is findable by searching for "notifications"', () => {
		// The label has to contain the word users would type; this pins it against
		// a rename that would make the command unreachable.
		expect(harness(1).clearAll.label.toLowerCase()).toContain('notification');
	});

	describe('toast position', () => {
		it('offers one command per corner', () => {
			expect(harness(0).positionActions.map((a) => a.label)).toEqual([
				'Move Toast Notifications to Top Left',
				'Move Toast Notifications to Top Right',
				'Move Toast Notifications to Bottom Left',
				'Move Toast Notifications to Bottom Right',
			]);
		});

		it('keeps the current corner listed and marks it', () => {
			const { positionActions } = harness(0, 'top-left');
			expect(positionActions.find((a) => a.id === 'toast-position-top-left')?.subtext).toBe(
				'Current position'
			);
			expect(positionActions.find((a) => a.id === 'toast-position-top-right')?.subtext).toBe(
				'Toasts stack downward from this corner'
			);
			expect(positionActions.find((a) => a.id === 'toast-position-bottom-left')?.subtext).toBe(
				'Toasts stack upward from this corner'
			);
		});

		it('moves the stack and closes the palette', () => {
			const { positionActions, setToastPosition, setQuickActionOpen } = harness(0);
			positionActions.find((a) => a.id === 'toast-position-bottom-left')!.action();
			expect(setToastPosition).toHaveBeenCalledWith('bottom-left');
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		});

		it('is findable by searching for "toast" or "notification"', () => {
			for (const action of harness(0).positionActions) {
				expect(action.label.toLowerCase()).toContain('toast');
				expect(action.label.toLowerCase()).toContain('notification');
			}
		});
	});

	it('opens the notification center and closes the palette', () => {
		const { actions, openNotificationCenter, setQuickActionOpen } = harness(0, 'bottom-right', 3);
		const open = actions.find((a) => a.id === 'open-notification-center')!;
		expect(open.subtext).toBe('3 unread notifications');
		open.action();
		expect(openNotificationCenter).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('drops Open Notification Center while its Encore Feature is off', () => {
		const { actions } = harness(0, 'bottom-right', 3, false);
		expect(actions.some((a) => a.id === 'open-notification-center')).toBe(false);
		// The toast commands do not depend on the inbox.
		expect(actions.some((a) => a.id === 'clear-all-notifications')).toBe(true);
	});

	it('says when nothing is unread, and singularizes a lone one', () => {
		const subtext = (unread: number) =>
			harness(0, 'bottom-right', unread).actions.find((a) => a.id === 'open-notification-center')!
				.subtext;
		expect(subtext(0)).toBe('No unread notifications');
		expect(subtext(1)).toBe('1 unread notification');
	});
});

describe('toggle in-app toasts command', () => {
	const find = (enabled: boolean) =>
		harness(0, 'bottom-right', 0, true, enabled).actions.find(
			(a) => a.id === 'toggle-in-app-toasts'
		)!;

	it('offers to turn toasts off while they are on', () => {
		expect(find(true).label).toBe('Turn Off In-App Toasts');
	});

	it('only promises the inbox keeps hidden toasts while the Notification Center is on', () => {
		const subtext = (centerOn: boolean) =>
			harness(0, 'bottom-right', 0, centerOn, true).actions.find(
				(a) => a.id === 'toggle-in-app-toasts'
			)!.subtext;
		expect(subtext(true)).toContain('notification center');
		expect(subtext(false)).toBe('Hide floating toasts');
	});

	it('offers to turn toasts on while they are off', () => {
		expect(find(false).label).toBe('Turn On In-App Toasts');
	});

	it('closes the palette and toggles through the shared service', () => {
		const h = harness(0, 'bottom-right', 0, true, true);
		h.actions.find((a) => a.id === 'toggle-in-app-toasts')!.action();
		expect(h.setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(toggleInAppToasts).toHaveBeenCalledTimes(1);
	});
});
