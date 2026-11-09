import { useMemo } from 'react';
import type { Theme } from '../../../types';
import type { ComposerSendMenu } from '../../ChatComposer';
import { SendMenuPopover } from '../components/SendMenuPopover';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import { useComposerInputStore } from '../../../stores/composerInputStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { shouldOpenSendMenu } from '../../../utils/sendMenu';

/**
 * The AI composer's Send menu for the shared send column, wired to the active
 * agent and tab. Every store read happens at click time, so the menu adds no
 * render dependency to the composer; memoized so the column stays still while
 * the user types.
 */
export function useAiSendMenu(
	theme: Theme,
	isTerminalMode: boolean,
	processInput: () => void
): ComposerSendMenu {
	return useMemo<ComposerSendMenu>(
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
}
