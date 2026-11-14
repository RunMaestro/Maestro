/**
 * The HUD's control row: talk, listen mode, send wait, stop the reply,
 * transcript, mute.
 *
 * The talk button is the interesting one, and the hand button beside it decides
 * which of two things it is:
 *
 *   - **Hands-free.** A click opens the microphone and it stays open; another
 *     click shuts it. A request goes when a send phrase is said or the wait
 *     runs out (the chip beside the hand shows it and opens the send panel).
 *   - **Push-to-talk.** The microphone is open exactly while the button is held.
 *     Letting go sends. There is no tap: a walkie-talkie key that also toggles
 *     is one a stray click leaves open.
 *
 * It used to guess between the two from how long the press lasted, which made
 * every click wait out the hold threshold and left nobody sure which gesture
 * they had just made. The mode is now a visible choice and the button does one
 * thing per mode.
 *
 * **Nothing here ends the session.** Shutting the microphone keeps the session,
 * its transcript and its binding; only Escape (the ESC pill in the header) closes
 * the HUD and the session with it. A row of controls where one of them quietly
 * hangs up is a row people learn not to touch.
 *
 * The hold itself is `usePressAndHold`, shared with the document chat's push
 * button, for its window-scoped release and its release-on-unmount: an
 * element-scoped `pointerup` never fires when the pointer is dragged off the
 * button, and that is how a held microphone gets stuck open.
 *
 * Every control is a real `<button>` with a visible focus ring and a text label
 * in `aria-label`, and none of them are icon-only to the accessibility tree. The
 * HUD is allowed to be small; it is not allowed to be unreachable.
 *
 * Every control also explains itself on hover through `HoverTooltip`, never a
 * native `title`: Chromium fires no hover on a DISABLED button, and the tooltip
 * has to be lifted to `Z_LAYERS.VOICE_HUD_TOOLTIP` or it draws behind the HUD it
 * belongs to. A disabled control's tooltip also says WHEN it becomes usable,
 * because "greyed out" with no reason reads as broken.
 */

import { useCallback } from 'react';
import { Hand, Mic, MicOff, ScrollText, Square, Timer, Volume2, VolumeX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import type { VoiceHudVisualState } from '../../../shared/acappella/hud-state';
import {
	formatSendWait,
	type VoiceListenMode,
	type VoiceSendWait,
} from '../../../shared/acappella/listen-mode';
import { usePressAndHold } from '../../hooks/utils/usePressAndHold';
import { Z_LAYERS } from '../../constants/zLayers';
import { HoverTooltip } from '../ui/HoverTooltip';

/** Wide enough for a two-clause hint, narrow enough to stay beside a 320px HUD. */
const TOOLTIP_MAX_WIDTH = 240;

/**
 * Push-to-talk has no tap to tell apart from a hold, so the press is the hold.
 * Any threshold here is that much of the first word spoken into a shut
 * microphone.
 */
const PUSH_TO_TALK_HOLD_MS = 0;

export interface VoiceHudControlsProps {
	theme: Theme;
	state: VoiceHudVisualState;
	/** True while the microphone is open: a live session whose gate is not shut. */
	micOpen: boolean;
	listenMode: VoiceListenMode;
	/** The send wait in force, or null before main has reported it. */
	sendWait: VoiceSendWait | null;
	waitPickerOpen: boolean;
	transcriptVisible: boolean;
	muted: boolean;
	/** Open the microphone. `hold` is a push-to-talk press. Rejections are the caller's to report. */
	onOpenMic: (options: { hold: boolean }) => void;
	/** Shut the microphone and keep the session. `send` is a push-to-talk release. */
	onCloseMic: (options: { send: boolean }) => void;
	onToggleListenMode: () => void;
	onToggleWaitPicker: () => void;
	/** Barge-in: cancel speech, keep the floor. */
	onInterrupt: () => void;
	onToggleTranscript: () => void;
	onToggleMute: () => void;
}

export function VoiceHudControls({
	theme,
	state,
	micOpen,
	listenMode,
	sendWait,
	waitPickerOpen,
	transcriptVisible,
	muted,
	onOpenMic,
	onCloseMic,
	onToggleListenMode,
	onToggleWaitPicker,
	onInterrupt,
	onToggleTranscript,
	onToggleMute,
}: VoiceHudControlsProps) {
	const pushToTalk = listenMode === 'push-to-talk';

	const onHoldStart = useCallback(() => onOpenMic({ hold: true }), [onOpenMic]);
	const onHoldEnd = useCallback(() => onCloseMic({ send: true }), [onCloseMic]);
	// Unreachable at a zero threshold, and deliberately inert if it ever fires:
	// the destructive reading of a stray click in push-to-talk is an open mic.
	const onTap = useCallback(() => undefined, []);

	const { holding, beginPress, endPress } = usePressAndHold({
		holdThresholdMs: PUSH_TO_TALK_HOLD_MS,
		onHoldStart,
		onHoldEnd,
		onTap,
		disabled: !pushToTalk,
	});

	const toggleHandsFree = useCallback(() => {
		if (micOpen) onCloseMic({ send: false });
		else onOpenMic({ hold: false });
	}, [micOpen, onCloseMic, onOpenMic]);

	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);
	// Lit while audio is actually being taken: an open microphone, or a held one
	// whose session is still starting (the label must answer the press at once).
	const lit = pushToTalk ? holding || micOpen : micOpen;
	const talkText = pushToTalk
		? holding
			? 'Talking'
			: micOpen
				? 'Listening'
				: 'Hold to talk'
		: micOpen
			? 'Listening'
			: 'Not listening';
	const talkLabel = pushToTalk
		? holding
			? 'Release to send'
			: 'Hold to talk, release to send'
		: micOpen
			? 'Listening. Click to stop listening (the session stays open)'
			: 'Not listening. Click to start listening';

	const waitText = sendWait ? formatSendWait(sendWait.waitMs) : '';
	const sendPhrase = sendWait?.sendPhrases[0];

	return (
		<div
			data-testid="voice-hud-controls"
			className="flex items-center gap-1 px-2 py-1.5 border-t"
			style={{ borderColor: theme.colors.border }}
		>
			<HoverTooltip
				theme={theme}
				label={talkLabel}
				zIndex={Z_LAYERS.VOICE_HUD_TOOLTIP}
				maxWidth={TOOLTIP_MAX_WIDTH}
			>
				<button
					type="button"
					data-testid="voice-hud-talk"
					data-listen-mode={listenMode}
					aria-label={talkLabel}
					aria-pressed={lit}
					// Hands-free is a plain click, keyboard included. Push-to-talk never
					// acts on click: the press and the release are the two events.
					onClick={pushToTalk ? undefined : toggleHandsFree}
					onPointerDown={(event) => {
						if (!pushToTalk || event.button !== 0) return;
						beginPress();
					}}
					onPointerUp={pushToTalk ? endPress : undefined}
					// The keyboard hold: down opens, up sends. `repeat` is skipped because a
					// held key repeats and each repeat would otherwise be a new press, and
					// blur ends the hold because the keyup that would have ended it goes
					// to whatever took focus.
					onKeyDown={(event) => {
						if (!pushToTalk || (event.key !== 'Enter' && event.key !== ' ')) return;
						event.preventDefault();
						if (!event.repeat) beginPress();
					}}
					onKeyUp={(event) => {
						if (!pushToTalk || (event.key !== 'Enter' && event.key !== ' ')) return;
						event.preventDefault();
						endPress();
					}}
					onBlur={pushToTalk ? endPress : undefined}
					className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium focus:outline-none focus-visible:ring-2 transition-colors"
					style={{
						backgroundColor: lit ? theme.colors.accent : 'transparent',
						color: lit ? onAccent : theme.colors.textMain,
						border: `1px solid ${lit ? theme.colors.accent : theme.colors.border}`,
						// A hold must not start a text selection or a scroll on a touch screen.
						touchAction: pushToTalk ? 'none' : undefined,
					}}
				>
					{lit || pushToTalk ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
					<span>{talkText}</span>
				</button>
			</HoverTooltip>

			<IconControl
				theme={theme}
				testId="voice-hud-listen-mode"
				icon={Hand}
				label={pushToTalk ? 'Switch to hands-free listening' : 'Switch to push-to-talk'}
				hint={
					pushToTalk
						? 'Push-to-talk is on: hold the button while you speak, release to send. Click for hands-free.'
						: 'Hands-free is on: the microphone stays open and a pause or a send phrase sends. Click for push-to-talk.'
				}
				pressed={pushToTalk}
				onClick={onToggleListenMode}
			/>

			<HoverTooltip
				theme={theme}
				label={
					pushToTalk
						? 'Send wait: not used in push-to-talk, where releasing the button sends'
						: sendPhrase
							? `Send wait: a pause of ${waitText} sends your request, or say "${sendPhrase}". Click to change either.`
							: `Send wait: a pause of ${waitText} sends your request. Click to change it, or to set a send phrase.`
				}
				zIndex={Z_LAYERS.VOICE_HUD_TOOLTIP}
				maxWidth={TOOLTIP_MAX_WIDTH}
			>
				<button
					type="button"
					data-testid="voice-hud-wait-chip"
					aria-label={`Send wait: ${waitText}. Change how long a pause sends your request, and the send phrase.`}
					aria-expanded={waitPickerOpen}
					disabled={pushToTalk || !sendWait}
					onClick={onToggleWaitPicker}
					className="flex items-center gap-1 px-1 py-1 rounded text-2xs tabular-nums focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:pointer-events-none hover:bg-white/10 transition-colors"
					style={{
						color:
							waitPickerOpen || sendWait?.overridden ? theme.colors.accent : theme.colors.textDim,
					}}
				>
					<Timer className="w-3.5 h-3.5" />
					{waitText && <span>{waitText}</span>}
				</button>
			</HoverTooltip>

			<IconControl
				theme={theme}
				testId="voice-hud-interrupt"
				icon={Square}
				label="Stop the reply"
				hint="Stop the reply: cut off the assistant mid-sentence and keep the session"
				disabledHint="Stop the reply: available while the assistant is speaking"
				// Only meaningful while something is being said. Enabled at all other
				// times it would be a button that does nothing, which teaches people
				// that the button does nothing.
				disabled={state !== 'speaking'}
				onClick={onInterrupt}
			/>

			<div className="flex-1" />

			<IconControl
				theme={theme}
				testId="voice-hud-transcript-toggle"
				icon={ScrollText}
				label={transcriptVisible ? 'Hide the transcript' : 'Show the transcript'}
				hint={
					transcriptVisible
						? 'Hide the transcript (the latest line stays visible)'
						: 'Show the transcript of this conversation'
				}
				pressed={transcriptVisible}
				onClick={onToggleTranscript}
			/>

			<IconControl
				theme={theme}
				testId="voice-hud-mute"
				icon={muted ? VolumeX : Volume2}
				label={muted ? 'Unmute the assistant' : 'Mute the assistant'}
				hint={
					muted
						? 'Unmute: speak replies aloud again'
						: 'Mute: stop speaking replies aloud (they still appear in the transcript)'
				}
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
	hint,
	disabledHint,
	disabled,
	pressed,
	onClick,
}: {
	theme: Theme;
	testId: string;
	icon: LucideIcon;
	/** The accessible name: short, and what a screen reader announces. */
	label: string;
	/** Hover help. Defaults to `label`. */
	hint?: string;
	/** Hover help while disabled: when the control becomes usable. */
	disabledHint?: string;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
}) {
	return (
		<HoverTooltip
			theme={theme}
			label={(disabled ? disabledHint : undefined) ?? hint ?? label}
			zIndex={Z_LAYERS.VOICE_HUD_TOOLTIP}
			maxWidth={TOOLTIP_MAX_WIDTH}
		>
			<button
				type="button"
				data-testid={testId}
				aria-label={label}
				// Only set when the control is a toggle. `aria-pressed` on a plain action
				// button announces a state that does not exist.
				aria-pressed={pressed === undefined ? undefined : pressed}
				disabled={disabled}
				onClick={onClick}
				// `disabled:pointer-events-none` hands the hover to the tooltip's wrapper:
				// a disabled button swallows mouse events, so without it the one control
				// most in need of an explanation would show none.
				className="p-1 rounded focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:pointer-events-none hover:bg-white/10 transition-colors"
				style={{ color: pressed ? theme.colors.accent : theme.colors.textDim }}
			>
				<Icon className="w-3.5 h-3.5" />
			</button>
		</HoverTooltip>
	);
}

export default VoiceHudControls;
