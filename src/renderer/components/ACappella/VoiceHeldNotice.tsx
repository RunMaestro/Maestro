/**
 * The HUD line shown while a finished sentence is held before it is sent.
 *
 * Hold-until-send keeps a request for up to thirty seconds waiting for a send
 * phrase ("go maestro" unless it was changed). Without this line the HUD showed
 * the text and then nothing happened for half a minute, which is
 * indistinguishable from a session that heard you and ignored you. It says what
 * it is waiting for, counts down to the automatic send, and offers the send
 * itself as a button.
 */

import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';

import { humanizeDuration } from '../../../shared/duration';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import type { Theme } from '../../types';

/** How often the countdown redraws. A second is the unit it shows. */
const TICK_MS = 1000;

export function VoiceHeldNotice({ theme, onSend }: { theme: Theme; onSend?: () => void }) {
	const held = useVoiceSessionStore((s) => s.heldUtterance);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!held) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, [held]);

	if (!held) return null;

	const remainingMs = Math.max(0, held.settlesAt - now);
	const phrase = held.sendPhrases[0];
	// Rounded up: "sends in 0s" while a second is still left reads as broken.
	const countdown = humanizeDuration(remainingMs, { round: 'ceil', fallback: '0s' });

	return (
		<div
			data-testid="voice-hud-held"
			className="flex items-center gap-2 px-3 py-1.5 text-2xs border-b"
			style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
		>
			<span className="flex-1">
				{phrase ? <>Say &ldquo;{phrase}&rdquo; to send, or it sends in </> : <>Sends in </>}
				<span className="tabular-nums" style={{ color: theme.colors.textMain }}>
					{countdown}
				</span>
			</span>
			<button
				type="button"
				data-testid="voice-hud-send-now"
				onClick={() => {
					if (onSend) onSend();
					else void window.maestro.voice.endUtterance();
				}}
				className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border text-2xs hover:opacity-80 focus:outline-none focus-visible:ring-2"
				style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
			>
				<Send className="w-3 h-3" aria-hidden="true" />
				Send now
			</button>
		</div>
	);
}
