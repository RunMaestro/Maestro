import { memo, useRef, useState } from 'react';
import { ArrowUp, Bell } from 'lucide-react';
import type { Theme } from '../../../types';
import { NotificationPopover } from '../../NotificationPopover';
import { SendMenuPopover } from './SendMenuPopover';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useComposerInputStore } from '../../../stores/composerInputStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { shouldOpenSendMenu } from '../../../utils/sendMenu';

interface NotificationSendControlsProps {
	theme: Theme;
	isTerminalMode: boolean;
	processInput: () => void;
}

export const NotificationSendControls = memo(function NotificationSendControls({
	theme,
	isTerminalMode,
	processInput,
}: NotificationSendControlsProps) {
	const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
	const [sendMenuOpen, setSendMenuOpen] = useState(false);
	const notificationBtnRef = useRef<HTMLButtonElement>(null);
	const sendBtnRef = useRef<HTMLButtonElement>(null);

	// Read at click time: the menu opens only when the four rows are different
	// choices (the agent is working and there is a draft). Every other click sends.
	const handleSendClick = () => {
		if (sendMenuOpen) {
			setSendMenuOpen(false);
			return;
		}
		if (!isTerminalMode) {
			const session = selectActiveSession(useSessionStore.getState());
			const composer = useComposerInputStore.getState();
			const imageCount =
				session?.aiTabs?.find((tab) => tab.id === session.activeTabId)?.stagedImages?.length ?? 0;
			if (
				composer.aiCommandMode === 'off' &&
				shouldOpenSendMenu(session, {
					menuEnabled: useSettingsStore.getState().sendButtonMenu,
					hasDraft: composer.aiValue.trim().length > 0 || imageCount > 0,
				})
			) {
				setSendMenuOpen(true);
				return;
			}
		}
		processInput();
	};

	return (
		<div className="flex flex-shrink-0 flex-col gap-2">
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
				className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				title={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
				aria-haspopup={isTerminalMode ? undefined : 'menu'}
				aria-expanded={isTerminalMode ? undefined : sendMenuOpen}
			>
				<ArrowUp className="w-4 h-4" />
			</button>
			{sendMenuOpen && (
				<SendMenuPopover
					theme={theme}
					anchorRef={sendBtnRef}
					onClose={() => setSendMenuOpen(false)}
					processInput={processInput}
				/>
			)}
		</div>
	);
});
