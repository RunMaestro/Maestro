/**
 * QuickChatVoiceButton - the Quick Chat composer's microphone.
 *
 * Idle, it is one more icon in the composer row. Live, it IS the voice surface:
 * the same `VoiceIndicator` the HUD draws (ring, level meter, spinner, speaker),
 * so listening, thinking and speaking look here the way they do everywhere
 * else. What it does on a tap and on a hold is `useQuickChatVoice`.
 *
 * It explains itself in the composer's hover overlay, with its chord, like the
 * buttons beside it: macOS does not show a native `title` in this panel while
 * another app is active.
 */

import { Mic } from 'lucide-react';

import { VOICE_HUD_STATE_DESCRIPTIONS } from '../../shared/acappella/hud-state';
import { VoiceIndicator } from '../components/ACappella/VoiceIndicator';
import { ChatTooltip } from '../components/ui/ChatSurface';
import type { ShortcutChords } from '../components/ui/ShortcutHint';
import { usePressAndHold } from '../hooks/utils/usePressAndHold';
import type { QuickChatVoice } from '../hooks/voice/useQuickChatVoice';
import type { Theme } from '../types';

/** The indicator's diameter: the footprint of the composer's other icon buttons. */
const INDICATOR_SIZE = 28;

export function QuickChatVoiceButton({
	theme,
	voice,
	agentName,
	shortcut,
}: {
	theme: Theme;
	voice: QuickChatVoice;
	/** Who the microphone talks to, for the idle label. */
	agentName: string;
	/** The window's chord for the same toggle a click is, shown in the overlay. */
	shortcut?: string | ShortcutChords;
}) {
	const { holding, beginPress, endPress } = usePressAndHold({
		holdThresholdMs: voice.holdThresholdMs,
		onHoldStart: voice.holdStart,
		onHoldEnd: voice.holdEnd,
		onTap: voice.toggle,
	});

	const [title, hint] = holding
		? ['Release to send', undefined]
		: voice.active
			? [
					VOICE_HUD_STATE_DESCRIPTIONS[voice.visualState],
					'Click to end the voice session, or hold to talk.',
				]
			: [`Talk to ${agentName}.`, 'Click to start, or hold to talk.'];
	const label = hint ? `${title} ${hint}` : title;

	return (
		<ChatTooltip label={title} hint={hint} shortcut={shortcut} theme={theme}>
			<button
				type="button"
				data-testid="quick-chat-voice-button"
				aria-label={label}
				aria-pressed={voice.active}
				// The composer keeps the caret: a click here must not leave Space and
				// Enter aimed at the microphone.
				onMouseDown={(event) => event.preventDefault()}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					beginPress();
				}}
				onPointerUp={endPress}
				// Keyboard users get the plain toggle, as on the document chat's
				// microphone: a held key needs a keyup this button does not reliably
				// receive, and a push-to-talk that fails to release is an open microphone.
				onKeyDown={(event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					voice.toggle();
				}}
				className={`rounded-md transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 ${
					voice.active ? '' : 'p-1.5 opacity-70'
				}`}
				style={{ color: theme.colors.textMain }}
			>
				{voice.active ? (
					// The indicator carries its own tooltip; the button's is the one that
					// also says what a click does.
					<span className="block pointer-events-none">
						<VoiceIndicator theme={theme} state={voice.visualState} size={INDICATOR_SIZE} />
					</span>
				) : (
					<Mic className="w-4 h-4" />
				)}
			</button>
		</ChatTooltip>
	);
}
