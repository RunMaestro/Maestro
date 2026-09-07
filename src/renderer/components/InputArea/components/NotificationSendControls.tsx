import { memo, useRef, useState } from 'react';
import { ArrowUp, Bell, Mic } from 'lucide-react';
import type { Theme } from '../../../types';
import { NotificationPopover } from '../../NotificationPopover';

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

export const NotificationSendControls = memo(function NotificationSendControls({
	theme,
	isTerminalMode,
	processInput,
	showVoiceButton = false,
	isVoiceListening = false,
	onToggleVoice,
}: NotificationSendControlsProps) {
	const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
	const notificationBtnRef = useRef<HTMLButtonElement>(null);

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
				type="button"
				onClick={() => processInput()}
				className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				title={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
			>
				<ArrowUp className="w-4 h-4" />
			</button>
			{/* Under Send rather than in the toolbar row: speaking is a way of
			    submitting a message, so it belongs with the other submit control
			    instead of among the per-tab toggles. Accented while the floor is open,
			    so the one button that can leave a microphone running never looks the
			    same open as shut. */}
			{showVoiceButton && onToggleVoice && (
				<button
					type="button"
					data-testid="composer-voice-button"
					onClick={onToggleVoice}
					className={`p-2 rounded-lg border transition-all ${
						isVoiceListening ? 'animate-pulse' : ''
					}`}
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
