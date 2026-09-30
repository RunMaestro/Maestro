/**
 * NotificationCenter - the bell in the Main Panel header and the popover it opens.
 *
 * A toast is gone once it leaves the screen. This is where it goes: every toast
 * is also recorded in `notificationStore.history`, and the popover lists that
 * history newest first with an Unread / All filter, Mark all as read, and Clear
 * all. Clicking an entry marks it read and does what clicking the toast itself
 * would have done.
 *
 * The popover is portaled and positioned from the bell's measured rect - see
 * `useAnchoredMenuPosition` for why `absolute` and bare `fixed` both fail
 * inside the header.
 */

import { memo, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, Check, Info, Sparkles, XCircle } from 'lucide-react';
import type { Theme } from '../types';
import {
	notifyToast,
	selectUnreadNotificationCount,
	useNotificationStore,
	type NotificationRecord,
	type ToastColor,
} from '../stores/notificationStore';
import { runToastClick } from '../services/toastClickActions';
import { jumpToAgent } from '../services/agentNavigation';
import { formatRelativeTime } from '../../shared/formatters';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useAnchoredMenuPosition } from '../hooks/ui/useAnchoredMenuPosition';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { SegmentedControl } from './ui/SegmentedControl';
import { toastAccentColor } from './Toast';

type NotificationFilter = 'unread' | 'all';

const FILTER_OPTIONS: ReadonlyArray<{ value: NotificationFilter; label: string }> = [
	{ value: 'unread', label: 'Unread' },
	{ value: 'all', label: 'All' },
];

/** Same glyph per color as the floating toast, so an entry reads as the toast it was. */
function NotificationIcon({ color }: { color: ToastColor }) {
	const className = 'w-3.5 h-3.5';
	switch (color) {
		case 'green':
			return <Check className={className} />;
		case 'red':
			return <XCircle className={className} />;
		case 'yellow':
			return <Info className={className} />;
		case 'orange':
			return <AlertTriangle className={className} />;
		case 'theme':
		default:
			return <Sparkles className={className} />;
	}
}

/**
 * Jump to the agent a notification came from. History outlives agents, so a
 * missing one is an ordinary outcome here and has to be said out loud.
 */
function jumpToNotificationSource(sessionId: string, tabId?: string): void {
	if (jumpToAgent(sessionId, { tabId })) return;
	notifyToast({
		color: 'yellow',
		title: 'Agent Not Found',
		message: 'The agent this notification came from no longer exists.',
		skipHistory: true,
	});
}

interface NotificationCenterProps {
	theme: Theme;
}

export const NotificationCenter = memo(function NotificationCenter({
	theme,
}: NotificationCenterProps) {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const open = useNotificationStore((s) => s.notificationCenterOpen);
	const setOpen = useNotificationStore((s) => s.setNotificationCenterOpen);
	const unreadCount = useNotificationStore(selectUnreadNotificationCount);
	const close = useCallback(() => setOpen(false), [setOpen]);

	const label = unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications';

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={() => setOpen(!open)}
				className="relative p-2 rounded hover:bg-white/5 shrink-0"
				title={label}
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				data-testid="notification-center-button"
			>
				<Bell className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				{unreadCount > 0 && (
					<span
						className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-3xs font-bold leading-[14px] text-center"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						data-testid="notification-center-badge"
						aria-hidden="true"
					>
						{unreadCount > 99 ? '99+' : unreadCount}
					</span>
				)}
			</button>
			{open && <NotificationCenterPopover theme={theme} anchorRef={anchorRef} onClose={close} />}
		</>
	);
});

interface NotificationCenterPopoverProps {
	theme: Theme;
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	onClose: () => void;
}

function NotificationCenterPopover({ theme, anchorRef, onClose }: NotificationCenterPopoverProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, { align: 'end' });

	// Escape closes the popover before any modal underneath it.
	useModalLayer(MODAL_PRIORITIES.NOTIFICATION_CENTER, 'Notification Center', onClose);
	useClickOutside<HTMLElement>([menuRef, anchorRef], onClose, true, {
		delay: true,
		eventType: 'click',
	});

	const history = useNotificationStore((s) => s.history);
	const markNotificationRead = useNotificationStore((s) => s.markNotificationRead);
	const markAllNotificationsRead = useNotificationStore((s) => s.markAllNotificationsRead);
	const clearNotificationHistory = useNotificationStore((s) => s.clearNotificationHistory);
	const unreadCount = useNotificationStore(selectUnreadNotificationCount);

	// Open on what needs attention; with nothing unread, the history is the
	// only thing there is to look at.
	const [filter, setFilter] = useState<NotificationFilter>(() =>
		unreadCount > 0 ? 'unread' : 'all'
	);
	const visible = filter === 'unread' ? history.filter((n) => !n.read) : history;

	const handleActivate = (record: NotificationRecord) => {
		markNotificationRead(record.id);
		if (runToastClick(record, { onSessionClick: jumpToNotificationSource })) {
			onClose();
		}
	};

	const actionStyle = (enabled: boolean) => ({
		color: enabled ? theme.colors.accent : theme.colors.textDim,
		opacity: enabled ? 1 : 0.5,
	});

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[100] w-[22rem] max-w-[calc(100vw-1rem)] flex flex-col rounded-lg shadow-xl overflow-hidden select-none"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				maxHeight: 'min(32rem, calc(100vh - 5rem))',
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
			}}
			role="dialog"
			aria-label="Notifications"
			data-testid="notification-center"
		>
			<div
				className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Notifications
				</span>
				<SegmentedControl
					value={filter}
					onChange={setFilter}
					options={FILTER_OPTIONS}
					theme={theme}
					ariaLabel="Filter notifications"
					testId="notification-center-filter"
				/>
			</div>

			{visible.length === 0 ? (
				<div
					className="px-3 py-8 text-center text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid="notification-center-empty"
				>
					{filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
				</div>
			) : (
				<ul className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
					{visible.map((record) => {
						const accent = toastAccentColor(record.color, theme);
						const source = [record.group, record.project, record.tabName]
							.filter(Boolean)
							.join(' · ');
						return (
							<li key={record.id}>
								<button
									type="button"
									onClick={() => handleActivate(record)}
									className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-b hover:bg-white/5"
									style={{ borderColor: theme.colors.border }}
									data-testid="notification-center-item"
									data-read={record.read}
								>
									<span
										className="shrink-0 p-1 rounded mt-0.5"
										style={{ color: accent, backgroundColor: `${accent}20` }}
									>
										<NotificationIcon color={record.color} />
									</span>
									<span className="flex-1 min-w-0">
										<span
											className="flex items-baseline justify-between gap-2 text-2xs"
											style={{ color: theme.colors.textDim }}
										>
											<span className="truncate">{source}</span>
											<span
												className="shrink-0"
												title={new Date(record.timestamp).toLocaleString()}
											>
												{formatRelativeTime(record.timestamp)}
											</span>
										</span>
										<span
											className={`block text-xs break-words ${record.read ? 'font-medium' : 'font-bold'}`}
											style={{ color: theme.colors.textMain }}
										>
											{record.title}
										</span>
										{record.message && (
											<span
												className="block text-xs mt-0.5 break-words line-clamp-3"
												style={{ color: theme.colors.textDim }}
											>
												{record.message}
											</span>
										)}
									</span>
									{!record.read && (
										<span
											className="shrink-0 w-2 h-2 rounded-full mt-1.5"
											style={{ backgroundColor: theme.colors.accent }}
											aria-label="Unread"
										/>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}

			<div
				className="flex items-center justify-between gap-2 px-3 py-2 text-xs shrink-0"
				style={{ borderTop: `1px solid ${theme.colors.border}` }}
			>
				<button
					type="button"
					onClick={markAllNotificationsRead}
					disabled={unreadCount === 0}
					className="hover:underline disabled:no-underline disabled:cursor-default"
					style={actionStyle(unreadCount > 0)}
					data-testid="notification-center-mark-all-read"
				>
					Mark all as read
				</button>
				<button
					type="button"
					onClick={clearNotificationHistory}
					disabled={history.length === 0}
					className="hover:underline disabled:no-underline disabled:cursor-default"
					style={actionStyle(history.length > 0)}
					data-testid="notification-center-clear-all"
				>
					Clear all
				</button>
			</div>
		</div>,
		document.body
	);
}
