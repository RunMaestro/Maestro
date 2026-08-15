/**
 * VoiceHud - the one on-screen surface for an A Cappella voice session.
 *
 * Mounted once, app-wide (next to the other single-instance hosts in
 * AppShell), gated on the `aCappella` Encore flag. It renders nothing until
 * there is something to show: a live session, an error worth reading, or the
 * dev harness in a development build.
 *
 * The indicator has to differ between LISTENING and SPEAKING at a glance, and
 * it must differ by more than colour: a voice UI is read from across the room,
 * and both states are drawn from the same theme accent. Listening is an outlined
 * ring around a microphone, filled by a disc that tracks the real input level;
 * speaking is a filled accent disc around a speaker, plus a sentence counter.
 * Every derived foreground runs through `readableTextOn()`, since the fills come
 * from the theme.
 *
 * The level meter is the reason `VoiceIndicator` reads the store itself instead
 * of taking a prop. `audio-level` lands ~20 times a second, and a subscription
 * in the HUD body would re-render the transcript, the feed, and the harness at
 * meter rate to move a disc a few pixels. The subscription belongs in the
 * smallest component that draws the number.
 *
 * Closing the HUD ENDS the session. It is not a hide: an open floor with no
 * visible surface is a microphone the user cannot see, and the media player's
 * lesson (a control that hides itself must not silently keep running) points
 * the other way here, because there the sound is the evidence and here silence
 * is.
 */

import { useCallback, useMemo } from 'react';
import { Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import type { MicIssue } from '../../../shared/acappella/protocol';
import { micSettingsLabel, micSettingsUrl } from '../../../shared/acappella/mic-settings';
import { getPlatform } from '../../utils/platformUtils';
import {
	selectVoiceAudioLevel,
	selectVoiceScopeLabel,
	useVoiceSessionStore,
	type VoiceFeedEntry,
} from '../../stores/voiceSessionStore';
import { EscCloseButton } from '../ui/EscCloseButton';
import { VoiceDevHarness } from './VoiceDevHarness';
import { useVoiceSession } from './useVoiceSession';

export interface VoiceHudProps {
	theme: Theme;
	/** The A Cappella Encore flag. False renders nothing and subscribes to nothing. */
	enabled: boolean;
	/**
	 * Show the dev harness. Defaults to the development build: the harness is
	 * the only way to drive a session in Phase 01 (there is no hotkey and no
	 * microphone yet), and it has no place in a production window.
	 */
	showDevHarness?: boolean;
}

/** Short, spoken-English label per state. The HUD is read at a glance. */
const STATE_LABELS: Record<string, string> = {
	idle: 'Idle',
	arming: 'Waking',
	listening: 'Listening',
	transcribing: 'Heard you',
	routing: 'Thinking',
	dispatching: 'Working',
	speaking: 'Speaking',
	interrupted: 'Interrupted',
	error: 'Error',
};

const FEED_LABELS: Record<VoiceFeedEntry['kind'], string> = {
	you: 'You',
	assistant: 'Agent',
	system: 'Maestro',
};

/**
 * What a broken microphone says. Plain, specific, and free of alarm language:
 * a denied permission is a setting the user has not turned on yet, not a crash,
 * and dressing it in error red teaches people to ignore the colour that matters.
 */
const MIC_ISSUE_MESSAGES: Record<MicIssue, string> = {
	'permission-denied': 'Maestro does not have microphone access yet.',
	'no-device': 'No microphone was found.',
	'device-lost': 'The microphone was disconnected.',
	unavailable: 'Audio capture is unavailable on this system.',
};

/**
 * Where the level sits when the meter is full. Speech from a laptop mic at arm's
 * length lands around 0.05 to 0.2 RMS, so a bar scaled linearly to 1.0 would
 * barely move; the square root spends the range where the voice actually is.
 */
const METER_FULL_SCALE = 0.25;

function meterFill(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, Math.sqrt(level / METER_FULL_SCALE));
}

export function VoiceHud({ theme, enabled, showDevHarness }: VoiceHudProps) {
	const actions = useVoiceSession(enabled);

	const state = useVoiceSessionStore((s) => s.state);
	const scopeLabel = useVoiceSessionStore(selectVoiceScopeLabel);
	const partial = useVoiceSessionStore((s) => s.partialTranscript);
	const feed = useVoiceSessionStore((s) => s.feed);
	const speech = useVoiceSessionStore((s) => s.speech);
	const mic = useVoiceSessionStore((s) => s.mic);
	const error = useVoiceSessionStore((s) => s.error);
	const substitutions = useVoiceSessionStore((s) => s.substitutions);
	const lostEvents = useVoiceSessionStore((s) => s.lostEvents);
	const dismissed = useVoiceSessionStore((s) => s.dismissed);
	const setDismissed = useVoiceSessionStore((s) => s.setDismissed);

	const devHarness = showDevHarness ?? process.env.NODE_ENV === 'development';
	const active = isVoiceSessionActive(state);

	// Escape and the ESC pill do the same thing, from one callback: end the
	// session, then hide. Stopping an already-idle session is a no-op in the
	// service, so the harness case (idle, HUD open) closes cleanly too.
	const handleClose = useCallback(() => {
		void actions.stop();
		setDismissed(true);
	}, [actions, setDismissed]);

	// Non-blocking: the HUD floats over the workspace while the user keeps
	// typing, so it takes neither focus nor the lower layers' clicks. It still
	// registers, so Escape reaches it before the surfaces underneath.
	useModalLayer(MODAL_PRIORITIES.VOICE_HUD, 'Voice HUD', handleClose, {
		enabled: enabled && !dismissed && (active || devHarness),
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

	const accentText = useMemo(
		() => readableTextOn(theme.colors.accent, [theme.colors.bgSidebar, theme.colors.bgMain]),
		[theme.colors.accent, theme.colors.bgSidebar, theme.colors.bgMain]
	);
	const warningText = useMemo(
		() => readableTextOn(theme.colors.warning, [theme.colors.bgSidebar]),
		[theme.colors.warning, theme.colors.bgSidebar]
	);
	const errorText = useMemo(
		() => readableTextOn(theme.colors.error, [theme.colors.bgSidebar]),
		[theme.colors.error, theme.colors.bgSidebar]
	);
	const onAccent = useMemo(
		() => readableTextOn(theme.colors.accentForeground, [theme.colors.accent]),
		[theme.colors.accentForeground, theme.colors.accent]
	);

	const micIssue = mic?.issue ?? null;

	if (!enabled || dismissed) return null;
	if (!active && !devHarness && !error && !micIssue) return null;

	const listening = state === 'listening' || state === 'arming';
	const speaking = state === 'speaking';
	const spoken = speech ? speech.sentences.length : 0;
	// The mic row says the same thing as an `audio-capture-failed` session error,
	// only in the calmer words and with the button that fixes it. Showing both
	// would put the identical sentence on screen twice, one of them in red.
	const showError = error && !(micIssue && error.code === 'audio-capture-failed');

	return (
		<div
			data-testid="voice-hud"
			className="fixed bottom-4 right-4 z-[90000] w-[340px] rounded-lg border shadow-xl select-none overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: active ? theme.colors.accent : theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			{/* Header: what it is bound to, what it is doing, and the way out. */}
			<div
				className="flex items-center gap-2 px-3 py-2 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<VoiceIndicator
					theme={theme}
					listening={listening}
					speaking={speaking}
					deviceLabel={mic?.capturing ? mic.deviceLabel : null}
				/>
				<div className="min-w-0 flex-1">
					<div className="text-xs font-bold truncate" style={{ color: accentText }}>
						{STATE_LABELS[state] ?? state}
					</div>
					<div className="text-[10px] truncate" style={{ color: theme.colors.textDim }}>
						{scopeLabel}
					</div>
				</div>
				{speaking && speech && (
					<span
						data-testid="voice-hud-speech-progress"
						className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
						style={{ backgroundColor: theme.colors.accent, color: onAccent }}
					>
						{spoken} of {speech.sentenceCount}
					</span>
				)}
				<EscCloseButton
					theme={theme}
					onClose={handleClose}
					label="End voice session (Esc)"
					testId="voice-hud-close"
				/>
			</div>

			{/* Anything the user is running that they did not ask for. */}
			{substitutions.length > 0 && (
				<div
					data-testid="voice-hud-substitutions"
					className="px-3 py-1.5 text-[10px] border-b"
					style={{ borderColor: theme.colors.border, color: warningText }}
				>
					{substitutions.map((sub) => (
						<div key={sub.role} className="truncate">
							{sub.message}
						</div>
					))}
				</div>
			)}

			{lostEvents && (
				<div
					data-testid="voice-hud-gap"
					className="px-3 py-1.5 text-[10px] border-b"
					style={{ borderColor: theme.colors.border, color: warningText }}
				>
					Some voice events were lost; this transcript may be incomplete.
				</div>
			)}

			{micIssue && <MicIssueNotice theme={theme} issue={micIssue} color={warningText} />}

			{showError && error && (
				<div
					data-testid="voice-hud-error"
					className="px-3 py-1.5 text-[10px] border-b select-text"
					style={{ borderColor: theme.colors.border, color: errorText }}
				>
					{error.message}
				</div>
			)}

			{/* Transcript. Content-driven, so it opts back into selection. */}
			<div
				data-testid="voice-hud-transcript"
				className="max-h-48 overflow-y-auto px-3 py-2 space-y-1.5 select-text"
			>
				{feed.length === 0 && !partial && (
					<div className="text-[11px] italic" style={{ color: theme.colors.textDim }}>
						{active ? 'Say something.' : 'No session.'}
					</div>
				)}
				{feed.map((entry) => (
					<div key={entry.id} className="text-[11px] leading-snug">
						<span
							className="font-bold mr-1"
							style={{
								color: entry.kind === 'you' ? accentText : theme.colors.textDim,
							}}
						>
							{FEED_LABELS[entry.kind]}
						</span>
						<span style={{ color: theme.colors.textMain }}>{entry.text}</span>
					</div>
				))}
				{partial && (
					<div
						data-testid="voice-hud-partial"
						className="text-[11px] leading-snug italic"
						style={{ color: theme.colors.textDim }}
					>
						{partial}
					</div>
				)}
				{speech && speech.sentences.length > 0 && (
					<div data-testid="voice-hud-spoken" className="text-[11px] leading-snug">
						{speech.sentences.map((sentence, index) => (
							<span key={index} style={{ color: accentText }}>
								{sentence}{' '}
							</span>
						))}
						{speech.endedReason === 'cancelled' && (
							<span style={{ color: theme.colors.textDim }}>(cut off)</span>
						)}
					</div>
				)}
			</div>

			{devHarness && <VoiceDevHarness theme={theme} actions={actions} />}
		</div>
	);
}

/**
 * Listening and speaking must be distinguishable without reading the label and
 * without relying on hue alone, so they differ in SHAPE and in motion: a ring
 * breathing with the room versus a filled disc.
 */
function VoiceIndicator({
	theme,
	listening,
	speaking,
	deviceLabel,
}: {
	theme: Theme;
	listening: boolean;
	speaking: boolean;
	/** The microphone in use, shown on hover. Null when nothing is being captured. */
	deviceLabel: string | null;
}) {
	// Read here rather than in the HUD body: this is the only thing that moves at
	// meter rate, so it is the only thing that should re-render at meter rate.
	const level = useVoiceSessionStore(selectVoiceAudioLevel);
	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);

	if (speaking) {
		return (
			<div
				data-testid="voice-indicator-speaking"
				aria-label="Speaking"
				className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
				style={{ backgroundColor: theme.colors.accent, color: onAccent }}
			>
				<Volume2 className="w-4 h-4 animate-pulse" />
			</div>
		);
	}

	if (listening) {
		const fill = meterFill(level);
		return (
			<div
				data-testid="voice-indicator-listening"
				data-level={fill.toFixed(2)}
				aria-label="Listening"
				title={deviceLabel ?? undefined}
				role="meter"
				aria-valuemin={0}
				aria-valuemax={1}
				aria-valuenow={Number(fill.toFixed(2))}
				className="relative w-7 h-7 rounded-full flex items-center justify-center shrink-0"
				style={{
					border: `2px solid ${theme.colors.accent}`,
					color: readableTextOn(theme.colors.accent, [theme.colors.bgSidebar]),
				}}
			>
				{/*
				 * The level itself, behind the icon. A real signal is worth more than
				 * `animate-pulse` was: a ring that moves with the room proves the
				 * microphone is live, which is the single question a user has while
				 * looking at this thing. It floors at a visible sliver so an open floor
				 * in a silent room still reads as open rather than as switched off.
				 */}
				<span
					data-testid="voice-hud-level"
					aria-hidden="true"
					className="absolute inset-0 m-auto rounded-full pointer-events-none"
					style={{
						width: '1.25rem',
						height: '1.25rem',
						backgroundColor: theme.colors.accent,
						opacity: 0.18 + 0.5 * fill,
						transform: `scale(${(0.2 + 0.8 * fill).toFixed(3)})`,
						transition: 'transform 80ms linear, opacity 80ms linear',
					}}
				/>
				<Mic className="w-3.5 h-3.5 relative" />
			</div>
		);
	}

	return (
		<div
			data-testid="voice-indicator-idle"
			aria-label="Idle"
			className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
			style={{ border: `2px solid ${theme.colors.border}`, color: theme.colors.textDim }}
		>
			<Radio className="w-3.5 h-3.5" />
		</div>
	);
}

/**
 * The microphone is not going to work, said calmly.
 *
 * Only `permission-denied` gets the button, because it is the only issue the OS
 * settings pane can fix: sending someone to a privacy checkbox to solve an
 * unplugged microphone wastes their time and their trust in the next button. On
 * a platform with no deep link (Linux) the sentence carries the instruction
 * instead, since a button that opens nothing is worse than no button at all.
 */
function MicIssueNotice({ theme, issue, color }: { theme: Theme; issue: MicIssue; color: string }) {
	const platform = getPlatform();
	const settingsUrl = issue === 'permission-denied' ? micSettingsUrl(platform) : null;

	const openSettings = useCallback(() => {
		void window.maestro.voice.openMicSettings();
	}, []);

	return (
		<div
			data-testid="voice-hud-mic"
			className="flex items-center gap-2 px-3 py-1.5 text-[10px] border-b"
			style={{ borderColor: theme.colors.border, color }}
		>
			<MicOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span className="flex-1 select-text">
				{MIC_ISSUE_MESSAGES[issue]}
				{issue === 'permission-denied' && !settingsUrl
					? ' Allow it for Maestro in your system settings.'
					: ''}
			</span>
			{settingsUrl && (
				<button
					type="button"
					data-testid="voice-hud-mic-settings"
					onClick={openSettings}
					className="shrink-0 px-1.5 py-0.5 rounded border text-[10px] hover:opacity-80"
					style={{ borderColor: theme.colors.border, color }}
				>
					{micSettingsLabel(platform)}
				</button>
			)}
		</div>
	);
}

export default VoiceHud;
