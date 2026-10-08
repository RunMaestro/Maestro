import { describe, expect, it, vi } from 'vitest';
import { buildNotificationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/notificationCommands';
import type { ToastPosition } from '../../../../../shared/toastPosition';

function harness(visibleToastCount: number, toastPosition: ToastPosition = 'bottom-right') {
	const clearToasts = vi.fn();
	const setToastPosition = vi.fn();
	const setQuickActionOpen = vi.fn();
	const actions = buildNotificationCommands({
		visibleToastCount,
		clearToasts,
		toastPosition,
		setToastPosition,
		setQuickActionOpen,
	});
	const clearAll = actions.find((a) => a.id === 'clear-all-notifications')!;
	const positionActions = actions.filter((a) => a.id.startsWith('toast-position-'));
	return { actions, clearAll, positionActions, clearToasts, setToastPosition, setQuickActionOpen };
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
});
