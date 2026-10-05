import type { QuickAction } from '../types';
import type { ToastPosition } from '../../../../shared/toastPosition';
import {
	TOAST_POSITIONS,
	TOAST_POSITION_LABELS,
	isTopToastPosition,
} from '../../../../shared/toastPosition';

interface BuildNotificationCommandsArgs {
	/** Number of toasts currently on screen. */
	visibleToastCount: number;
	clearToasts: () => void;
	clearAllNotificationsShortcut?: QuickAction['shortcut'];
	/** Corner the toast stack is pinned to right now. */
	toastPosition: ToastPosition;
	setToastPosition: (value: ToastPosition) => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Bulk escape hatch for a stacked-up toast queue.
 *
 * Sticky (dismissible) toasts have no auto-dismiss timer, so a burst of them -
 * or a misbehaving integration firing them in a loop - leaves a wall of cards
 * that can only be cleared one close button at a time.
 *
 * Always offered, even with an empty queue. Unlike the media-player restore
 * command (which is a recovery affordance you only reach for while something is
 * playing), this is a command users go hunting for by name. Hiding it at zero
 * makes the search that should find it come back empty, which reads as "the
 * feature doesn't exist" rather than "there is nothing to clear". The count
 * lives in the subtext instead, and clearing an empty queue is a harmless no-op.
 */
export function buildNotificationCommands({
	visibleToastCount,
	clearToasts,
	clearAllNotificationsShortcut,
	toastPosition,
	setToastPosition,
	setQuickActionOpen,
}: BuildNotificationCommandsArgs): QuickAction[] {
	return [
		{
			id: 'clear-all-notifications',
			label: 'Clear All Notifications',
			shortcut: clearAllNotificationsShortcut,
			subtext:
				visibleToastCount > 0
					? `Dismiss ${visibleToastCount} visible toast${visibleToastCount === 1 ? '' : 's'}`
					: 'No notifications on screen',
			action: () => {
				clearToasts();
				setQuickActionOpen(false);
			},
		},
		// One command per corner, all four always listed so a search for any corner
		// name finds it. The current corner stays in the list (marked in the
		// subtext) rather than vanishing, which would read as a missing option.
		// setToastPosition fires its own preview toast, so the move is visible.
		...TOAST_POSITIONS.map(
			(position): QuickAction => ({
				id: `toast-position-${position}`,
				label: `Move Toast Notifications to ${TOAST_POSITION_LABELS[position]}`,
				subtext:
					position === toastPosition
						? 'Current position'
						: isTopToastPosition(position)
							? 'Toasts stack downward from this corner'
							: 'Toasts stack upward from this corner',
				action: () => {
					setToastPosition(position);
					setQuickActionOpen(false);
				},
			})
		),
	];
}
