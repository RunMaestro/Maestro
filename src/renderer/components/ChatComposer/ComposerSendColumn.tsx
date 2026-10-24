/**
 * ComposerSendColumn - the column beside a composer: the notification
 * settings bell over the Send button.
 *
 * Shared by the AI composer and the Group Chat composer, so it knows nothing
 * about sessions, tabs or rooms. Each surface says what Send means through
 * props: the title, whether it is disabled, its tint, and (AI only) a menu that
 * a click opens instead of sending.
 */

import { memo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Bell } from 'lucide-react';
import type { Theme } from '../../types';
import { NotificationPopover } from '../NotificationPopover';

export interface ComposerSendMenu {
	/**
	 * Whether this surface has a menu at all right now. Drives `aria-haspopup`
	 * and `aria-expanded`; with it false the button is a plain Send button.
	 */
	available: boolean;
	/** Read at click time: true opens the menu instead of sending. */
	shouldOpen: () => boolean;
	/** The menu itself, anchored to the Send button. */
	render: (anchorRef: RefObject<HTMLButtonElement>, onClose: () => void) => ReactNode;
}

export interface ComposerSendColumnProps {
	theme: Theme;
	onSend: () => void;
	sendTitle: string;
	/** Disabled Send draws in the border color and ignores clicks. */
	sendDisabled?: boolean;
	/** `warning` is the room's "this will queue" tint. Defaults to `accent`. */
	sendTone?: 'accent' | 'warning';
	sendMenu?: ComposerSendMenu;
	/** Extra classes for the column, e.g. its alignment in the surface's row. */
	className?: string;
}

export const ComposerSendColumn = memo(function ComposerSendColumn({
	theme,
	onSend,
	sendTitle,
	sendDisabled = false,
	sendTone = 'accent',
	sendMenu,
	className,
}: ComposerSendColumnProps) {
	const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
	const [sendMenuOpen, setSendMenuOpen] = useState(false);
	const notificationBtnRef = useRef<HTMLButtonElement>(null);
	const sendBtnRef = useRef<HTMLButtonElement>(null);

	const handleSendClick = () => {
		if (sendMenuOpen) {
			setSendMenuOpen(false);
			return;
		}
		if (sendMenu?.shouldOpen()) {
			setSendMenuOpen(true);
			return;
		}
		onSend();
	};

	const menuAvailable = !!sendMenu?.available;

	return (
		<div className={`flex flex-shrink-0 flex-col gap-2${className ? ` ${className}` : ''}`}>
			<button
				ref={notificationBtnRef}
				type="button"
				onClick={() => setNotificationPopoverOpen((prev) => !prev)}
				className="p-2 rounded-lg border transition-all"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
				}}
				title="Notification Settings"
			>
				<Bell className="w-4 h-4" />
			</button>
			{notificationPopoverOpen && (
				<NotificationPopover
					theme={theme}
					anchorRef={notificationBtnRef}
					onClose={() => setNotificationPopoverOpen(false)}
				/>
			)}
			<button
				ref={sendBtnRef}
				type="button"
				onClick={handleSendClick}
				disabled={sendDisabled}
				className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
				style={{
					backgroundColor: sendDisabled
						? theme.colors.border
						: sendTone === 'warning'
							? theme.colors.warning
							: theme.colors.accent,
					color: sendDisabled ? theme.colors.textDim : theme.colors.accentForeground,
				}}
				title={sendTitle}
				aria-haspopup={menuAvailable ? 'menu' : undefined}
				aria-expanded={menuAvailable ? sendMenuOpen : undefined}
			>
				<ArrowUp className="w-4 h-4" />
			</button>
			{sendMenuOpen && sendMenu?.render(sendBtnRef, () => setSendMenuOpen(false))}
		</div>
	);
});
