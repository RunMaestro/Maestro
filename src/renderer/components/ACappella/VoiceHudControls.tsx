/**
 * The HUD's control row: talk, interrupt, stop, transcript, mute.
 *
 * The talk button is the only interesting one. It has to be BOTH push-to-talk
 * and tap-to-toggle, because those are two different habits and a voice UI that
 * picks one has half its users fighting it: someone dictating a paragraph holds
 * the button like a walkie-talkie, and someone having a conversation taps it
 * once and forgets about it. The classification lives in `usePressAndHold`,
 * shared with the document chat's push button and fed the same
 * `holdThresholdMs` the global hotkey uses, so no two surfaces can decide
 * "hold" at different moments.
 *
 * Unlike the global hotkey, this surface HAS a real release event (see the note
 * at the top of `main/acappella/hotkeys/press-hold.ts`), so it drives start/stop
 * directly instead of going through the polling detector.
 *
 * Every control is a real `<button>` with a visible focus ring and a text label
 * in `aria-label`, and none of them are icon-only to the accessibility tree. The
 * HUD is allowed to be small; it is not allowed to be unreachable.
 */

import { useCallback } from 'react';
import { Hand, Mic, MicOff, ScrollText, Square, Volume2, VolumeX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import type { VoiceHudVisualState } from '../../../shared/acappella/hud-state';
import { usePressAndHold } from '../../hooks/utils/usePressAndHold';

export interface VoiceHudControlsProps {
	theme: Theme;
	state: VoiceHudVisualState;
	/** True while a session holds resources. Drives what "talk" means. */
	active: boolean;
	transcriptVisible: boolean;
	muted: boolean;
	/** Tap-vs-hold threshold, mirrored from the voice control settings. */
	holdThresholdMs: number;
	/** Open the floor. Rejections are the caller's to report. */
	onStart: () => void;
	/** End the session. */
	onStop: () => void;
	/** Barge-in: cancel speech, keep the floor. */
	onInterrupt: () => void;
	onToggleTranscript: () => void;
	onToggleMute: () => void;
}

export function VoiceHudControls({
	theme,
	state,
	active,
	transcriptVisible,
	muted,
	holdThresholdMs,
	onStart,
	onStop,
	onInterrupt,
	onToggleTranscript,
	onToggleMute,
}: VoiceHudControlsProps) {
	// Holding when already listening is a "keep it open" gesture: re-starting
	// would restart the session under the user's sentence. A tap is the toggle it
	// has always been on the hotkey.
	const onHoldStart = useCallback(() => {
		if (!active) onStart();
	}, [active, onStart]);
	const onTap = useCallback(() => {
		if (active) onStop();
		else onStart();
	}, [active, onStart, onStop]);

	const { holding, beginPress, endPress } = usePressAndHold({
		holdThresholdMs,
		onHoldStart,
		onHoldEnd: onStop,
		onTap,
	});

	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);
	const talkLabel = holding
		? 'Release to stop talking'
		: active
			? 'Stop listening (or hold to talk)'
			: 'Start listening (or hold to talk)';

	return (
		<div
			data-testid="voice-hud-controls"
			className="flex items-center gap-1 px-2 py-1.5 border-t"
			style={{ borderColor: theme.colors.border }}
		>
			<button
				type="button"
				data-testid="voice-hud-talk"
				aria-label={talkLabel}
				aria-pressed={active}
				title={talkLabel}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					beginPress();
				}}
				onPointerUp={endPress}
				// Keyboard users get the plain toggle. Holding a key to talk needs a
				// keyup this button does not reliably receive once focus moves, and a
				// push-to-talk that sometimes fails to release is worse than a toggle.
				onKeyDown={(event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					if (active) onStop();
					else onStart();
				}}
				className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium focus:outline-none focus-visible:ring-2 transition-colors"
				style={{
					backgroundColor: active ? theme.colors.accent : 'transparent',
					color: active ? onAccent : theme.colors.textMain,
					border: `1px solid ${active ? theme.colors.accent : theme.colors.border}`,
				}}
			>
				{active ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
				<span>{holding ? 'Talking' : active ? 'Listening' : 'Talk'}</span>
			</button>

			<IconControl
				theme={theme}
				testId="voice-hud-interrupt"
				icon={Hand}
				label="Interrupt the reply"
				// Only meaningful while something is being said. Enabled at all other
				// times it would be a button that does nothing, which teaches people
				// that the button does nothing.
				disabled={state !== 'speaking'}
				onClick={onInterrupt}
			/>

			<IconControl
				theme={theme}
				testId="voice-hud-stop"
				icon={Square}
				label="End the voice session"
				disabled={!active}
				onClick={onStop}
			/>

			<div className="flex-1" />

			<IconControl
				theme={theme}
				testId="voice-hud-transcript-toggle"
				icon={ScrollText}
				label={transcriptVisible ? 'Hide the transcript' : 'Show the transcript'}
				pressed={transcriptVisible}
				onClick={onToggleTranscript}
			/>

			<IconControl
				theme={theme}
				testId="voice-hud-mute"
				icon={muted ? VolumeX : Volume2}
				label={muted ? 'Unmute the assistant' : 'Mute the assistant'}
				pressed={muted}
				onClick={onToggleMute}
			/>
		</div>
	);
}

function IconControl({
	theme,
	testId,
	icon: Icon,
	label,
	disabled,
	pressed,
	onClick,
}: {
	theme: Theme;
	testId: string;
	icon: LucideIcon;
	label: string;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			aria-label={label}
			// Only set when the control is a toggle. `aria-pressed` on a plain action
			// button announces a state that does not exist.
			aria-pressed={pressed === undefined ? undefined : pressed}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="p-1 rounded focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10 transition-colors"
			style={{ color: pressed ? theme.colors.accent : theme.colors.textDim }}
		>
			<Icon className="w-3.5 h-3.5" />
		</button>
	);
}

export default VoiceHudControls;
