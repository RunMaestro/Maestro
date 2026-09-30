import { describe, expect, it, vi } from 'vitest';
import { buildNotificationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/notificationCommands';

function harness(visibleToastCount: number, unreadNotificationCount = 0) {
	const clearToasts = vi.fn();
	const openNotificationCenter = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildNotificationCommands({
		visibleToastCount,
		clearToasts,
		unreadNotificationCount,
		openNotificationCenter,
		setQuickActionOpen,
	});
	return { actions, clearToasts, openNotificationCenter, setQuickActionOpen };
}

describe('buildNotificationCommands', () => {
	it('still offers the command when no toasts are on screen', () => {
		// Users search the palette for this by name before they know whether it
		// applies. Hiding it at zero makes that search come back empty, which
		// reads as "the feature does not exist".
		const { actions } = harness(0);
		expect(actions).toHaveLength(2);
		expect(actions[0].id).toBe('clear-all-notifications');
	});

	it('says so in the subtext when there is nothing to clear', () => {
		expect(harness(0).actions[0].subtext).toBe('No notifications on screen');
	});

	it('offers the clear command when toasts are stacked up', () => {
		const { actions } = harness(12);
		expect(actions).toHaveLength(2);
		expect(actions[0].id).toBe('clear-all-notifications');
		expect(actions[0].label).toBe('Clear All Notifications');
	});

	it('reports the pending count in the subtext', () => {
		expect(harness(12).actions[0].subtext).toBe('Dismiss 12 visible toasts');
	});

	it('singularizes the subtext for a lone toast', () => {
		expect(harness(1).actions[0].subtext).toBe('Dismiss 1 visible toast');
	});

	it('clears the queue and closes the palette', () => {
		const { actions, clearToasts, setQuickActionOpen } = harness(3);
		actions[0].action();
		expect(clearToasts).toHaveBeenCalledOnce();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is findable by searching for "notifications"', () => {
		// The label has to contain the word users would type; this pins it against
		// a rename that would make the command unreachable.
		expect(harness(1).actions[0].label.toLowerCase()).toContain('notification');
	});

	it('opens the notification center and closes the palette', () => {
		const { actions, openNotificationCenter, setQuickActionOpen } = harness(0, 3);
		const open = actions.find((a) => a.id === 'open-notification-center')!;
		expect(open.subtext).toBe('3 unread notifications');
		open.action();
		expect(openNotificationCenter).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('says when nothing is unread, and singularizes a lone one', () => {
		const subtext = (unread: number) =>
			harness(0, unread).actions.find((a) => a.id === 'open-notification-center')!.subtext;
		expect(subtext(0)).toBe('No unread notifications');
		expect(subtext(1)).toBe('1 unread notification');
	});
});
