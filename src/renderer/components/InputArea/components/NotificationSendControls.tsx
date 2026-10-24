import { memo, useMemo } from 'react';
import type { Theme } from '../../../types';
import { ComposerSendColumn, type ComposerSendMenu } from '../../ChatComposer';
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

/**
 * The AI composer's send column: the shared `ComposerSendColumn` with the Send
 * menu wired to the active agent and tab.
 */
export const NotificationSendControls = memo(function NotificationSendControls({
	theme,
	isTerminalMode,
	processInput,
}: NotificationSendControlsProps) {
	const sendMenu = useMemo<ComposerSendMenu>(
		() => ({
			available: !isTerminalMode,
			// Read at click time: the menu opens only when the four rows are different
			// choices (the agent is working and there is a draft). Every other click sends.
			shouldOpen: () => {
				if (isTerminalMode) return false;
				const session = selectActiveSession(useSessionStore.getState());
				const composer = useComposerInputStore.getState();
				const imageCount =
					session?.aiTabs?.find((tab) => tab.id === session.activeTabId)?.stagedImages?.length ?? 0;
				return (
					composer.aiCommandMode === 'off' &&
					shouldOpenSendMenu(session, {
						menuEnabled: useSettingsStore.getState().sendButtonMenu,
						hasDraft: composer.aiValue.trim().length > 0 || imageCount > 0,
					})
				);
			},
			render: (anchorRef, onClose) => (
				<SendMenuPopover
					theme={theme}
					anchorRef={anchorRef}
					onClose={onClose}
					processInput={processInput}
				/>
			),
		}),
		[isTerminalMode, theme, processInput]
	);

	return (
		<ComposerSendColumn
			theme={theme}
			onSend={processInput}
			sendTitle={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
			sendMenu={sendMenu}
		/>
	);
});
