import { memo, useMemo } from 'react';
import { Mic } from 'lucide-react';
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
	/**
	 * Show the A Cappella microphone under Send.
	 *
	 * True only when the Encore Feature owns the composer's microphone. The Web
	 * Speech dictation button stays where it has always been, in the toolbar row
	 * and on touch pointers only, so exactly one microphone is ever on screen.
	 */
	showVoiceButton?: boolean;
	/** True while this agent holds the voice floor. */
	isVoiceListening?: boolean;
	/** Start or end the voice session. Stable identity (see InputArea). */
	onToggleVoice?: () => void;
}

/**
 * The AI composer's send column: the shared `ComposerSendColumn` with the Send
 * menu wired to the active agent and tab.
 */
export const NotificationSendControls = memo(function NotificationSendControls({
	theme,
	isTerminalMode,
	processInput,
	showVoiceButton = false,
	isVoiceListening = false,
	onToggleVoice,
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
		<div className="flex flex-shrink-0 flex-col gap-2">
			<ComposerSendColumn
				theme={theme}
				onSend={processInput}
				sendTitle={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
				sendMenu={sendMenu}
			/>
			{showVoiceButton && onToggleVoice && (
				<button
					type="button"
					data-testid="composer-voice-button"
					onClick={onToggleVoice}
					className={`p-2 rounded-lg border transition-all ${isVoiceListening ? 'animate-pulse' : ''}`}
					style={{
						backgroundColor: isVoiceListening ? `${theme.colors.accent}20` : theme.colors.bgMain,
						borderColor: isVoiceListening ? theme.colors.accent : theme.colors.border,
						color: isVoiceListening ? theme.colors.accent : theme.colors.textDim,
					}}
					title={isVoiceListening ? 'End the voice session' : 'Talk to this agent'}
					aria-label={isVoiceListening ? 'End the voice session' : 'Talk to this agent'}
					aria-pressed={isVoiceListening}
				>
					<Mic className="w-4 h-4" />
				</button>
			)}
		</div>
	);
});
