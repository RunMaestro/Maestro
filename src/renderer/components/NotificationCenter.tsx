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

import { NOTIFICATION_HISTORY_PERSISTENCE_ERROR } from '../../shared/notificationInbox';
import { shortcutSuffix } from './ui/ShortcutHint';
import { useSettingsStore } from '../stores/settingsStore';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, Check, Info, Sparkles, X, XCircle } from 'lucide-react';
import type { Theme } from '../types';
import {
	selectUnreadNotificationCount,
	useNotificationStore,
	type ToastColor,
} from '../stores/notificationStore';
import {
	activateNotification,
	openNotificationLink,
	performNotificationInboxAction,
} from '../services/notificationInbox';
import { formatRelativeTime } from '../../shared/formatters';
import { useListNavigation } from '../hooks/keyboard/useListNavigation';
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

interface NotificationCenterProps {
	theme: Theme;
}

/** Header bell with the live unread count and configurable shortcut hint. */
export const NotificationCenter = memo(function NotificationCenter({
	theme,
}: NotificationCenterProps) {
	const open = useNotificationStore((s) => s.notificationCenterOpen);
	const setOpen = useNotificationStore((s) => s.setNotificationCenterOpen);
	const unreadCount = useNotificationStore(selectUnreadNotificationCount);

	const shortcut = useSettingsStore((s) => s.shortcuts.openNotificationCenter);
	const label = unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications';

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="relative p-2 rounded hover:bg-white/5 shrink-0"
				title={`${label}${shortcutSuffix(shortcut?.keys)}`}
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				id="notification-center-trigger"
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
		</>
	);
});

/** App-level host: history remains reachable when the Main Panel header is absent. */
export function NotificationCenterHost({ theme }: NotificationCenterProps) {
	const open = useNotificationStore((s) => s.notificationCenterOpen);
	const setOpen = useNotificationStore((s) => s.setNotificationCenterOpen);
	const close = useCallback(() => setOpen(false), [setOpen]);
	const fallbackRef = useRef<HTMLSpanElement | null>(null);
	const bell = open ? document.getElementById('notification-center-trigger') : null;
	const anchorRef = bell ? { current: bell } : fallbackRef;
	return (
		<>
			<span
				aria-hidden="true"
				className="fixed right-4 top-12 pointer-events-none"
				ref={fallbackRef}
			/>
			{open && <NotificationCenterPopover theme={theme} anchorRef={anchorRef} onClose={close} />}
		</>
	);
}

interface NotificationCenterPopoverProps {
	theme: Theme;
	anchorRef: React.RefObject<HTMLElement | null>;
	onClose: () => void;
}

/** History controls and entry actions, positioned against the bell or the app fallback. */
function NotificationCenterPopover({ theme, anchorRef, onClose }: NotificationCenterPopoverProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, { align: 'end' });

	// Escape closes the popover before any modal underneath it.
	useModalLayer(MODAL_PRIORITIES.NOTIFICATION_CENTER, 'Notification Center', onClose);
	useClickOutside<HTMLElement>([menuRef, anchorRef], onClose, true, {
		delay: true,
		eventType: 'click',
	});

	const large = useSettingsStore((s) => s.notificationCenterLarge);
	const details = useSettingsStore((s) => s.notificationCenterDetails);
	const keyboardNavigation = useSettingsStore((s) => s.notificationCenterKeyboardNavigation);
	const expandedId = useNotificationStore((s) => s.notificationCenterExpandedId);
	const previousFocus = useRef(document.activeElement as HTMLElement | null);
	const history = useNotificationStore((s) => s.history);
	const historyPersistenceFailed = useNotificationStore((s) => s.historyPersistenceFailed);
	const markAllNotificationsRead = useNotificationStore((s) => s.markAllNotificationsRead);
	const clearNotificationHistory = useNotificationStore((s) => s.clearNotificationHistory);
	const unreadCount = useNotificationStore(selectUnreadNotificationCount);

	// Open on what needs attention; with nothing unread, the history is the
	// only thing there is to look at.
	const [filter, setFilter] = useState<NotificationFilter>(() =>
		unreadCount > 0 ? 'unread' : 'all'
	);
	const visible =
		filter === 'unread'
			? history.filter((n) => !n.read || (details && n.id === expandedId))
			: history;
	const canClearHistory = history.length > 0 || historyPersistenceFailed;

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: visible.length,
		onSelect: (index) => activateNotification(visible[index]),
		enablePageNavigation: true,
		enabled: keyboardNavigation,
	});

	// Opt-in focus management also restores the caller when closing without navigation.
	useEffect(() => {
		if (!keyboardNavigation || !ready) return;
		const menu = menuRef.current;
		const first = menu?.querySelector<HTMLElement>('[data-testid="notification-center-item"]');
		(first ?? menu)?.focus();
		return () => {
			if (menu?.contains(document.activeElement) || document.activeElement === document.body) {
				if (previousFocus.current?.isConnected) previousFocus.current.focus();
			}
		};
	}, [keyboardNavigation, ready]);

	useEffect(() => {
		if (!keyboardNavigation || !ready) return;
		const active = document.activeElement;
		// Never pull focus away from filters, links, detail controls, or other surfaces.
		if (
			active !== menuRef.current &&
			active !== document.body &&
			!menuRef.current?.querySelector('[data-testid="notification-center-item"]:focus')
		)
			return;
		const item = menuRef.current?.querySelectorAll<HTMLElement>(
			'[data-testid="notification-center-item"]'
		)[selectedIndex];
		(item ?? menuRef.current)?.focus();
		item?.scrollIntoView?.({ block: 'nearest' });
	}, [keyboardNavigation, ready, selectedIndex, visible]);

	const onEntryKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!keyboardNavigation || event.altKey || event.ctrlKey || event.metaKey) return;
		if (
			!(event.target instanceof HTMLElement) ||
			event.target.dataset.testid !== 'notification-center-item'
		)
			return;
		const record = visible[selectedIndex];
		if (!record) return;
		if (event.key.toLowerCase() === 'r') {
			performNotificationInboxAction({ action: 'read', id: record.id });
		} else if (event.key === 'Delete' || event.key === 'Backspace') {
			performNotificationInboxAction({ action: 'dismiss', id: record.id });
		} else if (event.key.toLowerCase() === 'd' && details) {
			performNotificationInboxAction({
				action: expandedId === record.id ? 'collapse' : 'detail',
				id: record.id,
			});
		} else {
			handleKeyDown(event);
			if (event.defaultPrevented) event.stopPropagation();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	const actionStyle = (enabled: boolean) => ({
		color: enabled ? theme.colors.accent : theme.colors.textDim,
		opacity: enabled ? 1 : 0.5,
	});

	return createPortal(
		<div
			ref={menuRef}
			className={`fixed z-[100] ${large ? 'w-[38rem]' : 'w-[22rem]'} max-w-[calc(100vw-1rem)] flex flex-col rounded-lg shadow-xl overflow-hidden select-none`}
			tabIndex={keyboardNavigation ? -1 : undefined}
			onKeyDown={onEntryKeyDown}
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				maxHeight: large ? 'min(48rem, calc(100vh - 5rem))' : 'min(32rem, calc(100vh - 5rem))',
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
				<button
					type="button"
					onClick={onClose}
					aria-label="Close notifications"
					className="p-1 rounded hover:bg-white/5"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-4 h-4" />
				</button>
				<SegmentedControl
					value={filter}
					onChange={setFilter}
					options={FILTER_OPTIONS}
					theme={theme}
					ariaLabel="Filter notifications"
					testId="notification-center-filter"
				/>
			</div>

			{historyPersistenceFailed && (
				<p
					role="alert"
					className="px-3 py-2 text-xs border-b"
					style={{ color: theme.colors.warning, borderColor: theme.colors.border }}
				>
					{NOTIFICATION_HISTORY_PERSISTENCE_ERROR}
				</p>
			)}
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
					{visible.map((record, index) => {
						const expanded = details && expandedId === record.id;
						const accent = toastAccentColor(record.color, theme);
						const source = [record.group, record.project, record.tabName]
							.filter(Boolean)
							.join(' · ');
						return (
							<li key={record.id} className="border-b" style={{ borderColor: theme.colors.border }}>
								<button
									type="button"
									onClick={() => {
										if (!expanded || !window.getSelection()?.toString())
											activateNotification(record);
									}}
									onFocus={() => {
										if (keyboardNavigation) setSelectedIndex(index);
									}}
									tabIndex={keyboardNavigation ? (index === selectedIndex ? 0 : -1) : undefined}
									className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/5 ${keyboardNavigation ? 'focus-ring-inset' : ''}`}
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
											<span className={expanded ? 'min-w-0 break-words select-text' : 'truncate'}>
												{source}
											</span>
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
												className={`text-xs mt-0.5 break-words ${expanded ? 'block whitespace-pre-wrap select-text' : 'line-clamp-3'}`}
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
								{(details || keyboardNavigation) && (
									<div
										className="flex gap-3 px-3 pb-2 text-xs"
										style={{ color: theme.colors.accent }}
									>
										{details && (
											<button
												type="button"
												className="hover:underline"
												aria-expanded={expanded}
												onClick={() =>
													performNotificationInboxAction({
														action: expanded ? 'collapse' : 'detail',
														id: record.id,
													})
												}
											>
												{expanded ? 'Hide details' : 'Show details'}
											</button>
										)}
										{keyboardNavigation && (
											<>
												<button
													type="button"
													className="hover:underline disabled:opacity-50"
													disabled={record.read}
													title="Mark as read (R)"
													onClick={() =>
														performNotificationInboxAction({ action: 'read', id: record.id })
													}
												>
													Mark as read
												</button>
												<button
													type="button"
													className="hover:underline"
													title="Dismiss (Delete)"
													onClick={() =>
														performNotificationInboxAction({ action: 'dismiss', id: record.id })
													}
												>
													Dismiss
												</button>
											</>
										)}
									</div>
								)}
								{record.actionUrl && (
									<button
										type="button"
										className="mx-3 mb-2 text-xs hover:underline break-all text-left"
										style={{ color: accent }}
										onClick={() => openNotificationLink(record)}
									>
										{record.actionLabel || record.actionUrl}
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{keyboardNavigation && (
				<p className="px-3 py-2 text-xs" style={{ color: theme.colors.textDim }}>
					Arrows: navigate · Enter: open · R: read · Delete: dismiss{details ? ' · D: details' : ''}
				</p>
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
					disabled={!canClearHistory}
					className="hover:underline disabled:no-underline disabled:cursor-default"
					style={actionStyle(canClearHistory)}
					data-testid="notification-center-clear-all"
				>
					Clear all
				</button>
			</div>
		</div>,
		document.body
	);
}
