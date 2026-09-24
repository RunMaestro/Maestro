/**
 * The one thing in the HUD you are meant to read from across the room.
 *
 * Five states have to be distinguishable, and they have to be distinguishable by
 * more than hue: they are all drawn from the same theme accent, and a
 * colour-only difference is no difference at all to a large minority of users.
 * So each state differs in SHAPE and in MOTION as well:
 *
 *   idle-armed  an outlined ring around a radio glyph, still
 *   listening   an outlined ring around a microphone, filled by a disc that
 *               tracks the real input level
 *   thinking    an outlined ring around a spinner
 *   speaking    a FILLED accent disc around a speaker, pulsing with the outgoing
 *               audio
 *   error       an outlined ring in the error colour around a warning glyph
 *
 * The level meter is why this component reads the store itself instead of taking
 * the level as a prop. `audio-level` lands ~20 times a second, and a
 * subscription in the HUD body would re-render the transcript, the controls, and
 * the harness at meter rate to move a disc a few pixels. The subscription
 * belongs in the smallest component that draws the number.
 *
 * Under `prefers-reduced-motion` every one of those animations is replaced by a
 * static indicator. That is not a nicety: this widget is designed to be left on
 * screen all day, and a permanently animating element is a genuine accessibility
 * problem for people with vestibular disorders.
 */

import { memo } from 'react';
import { AlertTriangle, Loader2, Mic, Radio, Volume2 } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import {
	VOICE_HUD_STATE_DESCRIPTIONS,
	VOICE_HUD_STATE_LABELS,
	type VoiceHudVisualState,
} from '../../../shared/acappella/hud-state';
import { usePrefersReducedMotion } from '../../hooks/utils/usePrefersReducedMotion';
import { selectVoiceAudioLevel, useVoiceSessionStore } from '../../stores/voiceSessionStore';

/**
 * Where the level sits when the meter is full. Speech from a laptop mic at arm's
 * length lands around 0.05 to 0.2 RMS, so a bar scaled linearly to 1.0 would
 * barely move; the square root spends the range where the voice actually is.
 */
const METER_FULL_SCALE = 0.25;

export function meterFill(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, Math.sqrt(level / METER_FULL_SCALE));
}

export interface VoiceIndicatorProps {
	theme: Theme;
	state: VoiceHudVisualState;
	/** The microphone in use, shown on hover. Null when nothing is being captured. */
	deviceLabel?: string | null;
	/** Diameter in px. The HUD header uses 28; the collapsed pill uses 20. */
	size?: number;
}

export const VoiceIndicator = memo(function VoiceIndicator({
	theme,
	state,
	deviceLabel = null,
	size = 28,
}: VoiceIndicatorProps) {
	// Read here rather than in the HUD body: this is the only thing that moves at
	// meter rate, so it is the only thing that should re-render at meter rate.
	const level = useVoiceSessionStore(selectVoiceAudioLevel);
	const reducedMotion = usePrefersReducedMotion();

	const label = VOICE_HUD_STATE_LABELS[state];
	const title = deviceLabel
		? `${VOICE_HUD_STATE_DESCRIPTIONS[state]} (${deviceLabel})`
		: VOICE_HUD_STATE_DESCRIPTIONS[state];
	const glyph = Math.round(size * 0.5);
	const box = { width: size, height: size } as const;

	if (state === 'speaking') {
		const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);
		return (
			<div
				data-testid="voice-indicator-speaking"
				data-motion={reducedMotion ? 'static' : 'animated'}
				aria-label={label}
				title={title}
				role="img"
				className="rounded-full flex items-center justify-center shrink-0"
				style={{ ...box, backgroundColor: theme.colors.accent, color: onAccent }}
			>
				<Volume2
					className={reducedMotion ? undefined : 'animate-pulse'}
					style={{ width: glyph, height: glyph }}
				/>
			</div>
		);
	}

	if (state === 'listening') {
		const fill = meterFill(level);
		return (
			<div
				data-testid="voice-indicator-listening"
				data-level={fill.toFixed(2)}
				data-motion={reducedMotion ? 'static' : 'animated'}
				aria-label={label}
				title={title}
				role="meter"
				aria-valuemin={0}
				aria-valuemax={1}
				aria-valuenow={Number(fill.toFixed(2))}
				aria-valuetext={`${label}, input level ${Math.round(fill * 100)} percent`}
				className="relative rounded-full flex items-center justify-center shrink-0"
				style={{
					...box,
					border: `2px solid ${theme.colors.accent}`,
					color: readableTextOn(theme.colors.accent, [theme.colors.bgSidebar]),
				}}
			>
				{/*
				 * The level itself, behind the icon. A real signal is worth more than a
				 * canned pulse: a ring that moves with the room proves the microphone is
				 * live, which is the single question a user has while looking at this
				 * thing. It floors at a visible sliver so an open floor in a silent room
				 * still reads as open rather than as switched off.
				 *
				 * With reduced motion the disc stops tracking and sits at a fixed size:
				 * the ring alone still says the floor is open, and the transcript says
				 * whether anything is being heard.
				 */}
				<span
					data-testid="voice-hud-level"
					aria-hidden="true"
					className="absolute inset-0 m-auto rounded-full pointer-events-none"
					style={{
						width: glyph * 1.4,
						height: glyph * 1.4,
						backgroundColor: theme.colors.accent,
						opacity: reducedMotion ? 0.35 : 0.18 + 0.5 * fill,
						transform: reducedMotion ? undefined : `scale(${(0.2 + 0.8 * fill).toFixed(3)})`,
						transition: reducedMotion ? undefined : 'transform 80ms linear, opacity 80ms linear',
					}}
				/>
				<Mic className="relative" style={{ width: glyph, height: glyph }} />
			</div>
		);
	}

	if (state === 'thinking') {
		return (
			<div
				data-testid="voice-indicator-thinking"
				data-motion={reducedMotion ? 'static' : 'animated'}
				aria-label={label}
				title={title}
				role="img"
				className="rounded-full flex items-center justify-center shrink-0"
				style={{
					...box,
					border: `2px dashed ${theme.colors.accent}`,
					color: readableTextOn(theme.colors.accent, [theme.colors.bgSidebar]),
				}}
			>
				<Loader2
					className={reducedMotion ? undefined : 'animate-spin'}
					style={{ width: glyph, height: glyph }}
				/>
			</div>
		);
	}

	if (state === 'error') {
		return (
			<div
				data-testid="voice-indicator-error"
				data-motion="static"
				aria-label={label}
				title={title}
				role="img"
				className="rounded-full flex items-center justify-center shrink-0"
				style={{
					...box,
					border: `2px solid ${theme.colors.error}`,
					color: readableTextOn(theme.colors.error, [theme.colors.bgSidebar]),
				}}
			>
				<AlertTriangle style={{ width: glyph, height: glyph }} />
			</div>
		);
	}

	return (
		<div
			data-testid="voice-indicator-idle"
			data-motion="static"
			aria-label={label}
			title={title}
			role="img"
			className="rounded-full flex items-center justify-center shrink-0"
			style={{
				...box,
				border: `2px solid ${theme.colors.border}`,
				color: theme.colors.textDim,
			}}
		>
			<Radio style={{ width: glyph, height: glyph }} />
		</div>
	);
});

export default VoiceIndicator;
