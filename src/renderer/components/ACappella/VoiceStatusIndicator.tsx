/**
 * The minimized voice HUD: a live state glyph in the Left Bar header.
 *
 * Minimizing the floating widget parks it here rather than ending the session,
 * so this is both the "Maestro is listening" indicator and the way back to the
 * controls. It sits in the same header row as `NowPlayingIndicator`, for the
 * same reason: a background capability with no visible surface is one the user
 * can neither find nor stop.
 *
 * **This is why minimize is allowed to hide the widget at all.** A microphone is
 * not like audio playback - silence is not evidence that it stopped - so the
 * HUD's minimize button is only honest while something on screen keeps saying
 * the floor is open. That something is this. Do not let the HUD's minimized
 * state render nothing on the grounds that the session is still in the store: a
 * state nobody can see is a microphone nobody knows about.
 *
 * One button, not the media indicator's two. There, the halves are play/pause
 * and restore, which are genuinely different actions; here the only thing a
 * header icon can do is bring the widget back, because talking is done by voice,
 * by the hotkey, or by the composer button.
 */

import { memo } from 'react';

import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { VOICE_HUD_STATE_LABELS, voiceHudVisualState } from '../../../shared/acappella/hud-state';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { useOwnsVoiceSession } from './useOwnsVoiceSession';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import type { Theme } from '../../types';
import { VoiceIndicator } from './VoiceIndicator';
import { useVoiceScope } from './useVoiceScope';

interface VoiceStatusIndicatorProps {
	theme: Theme;
	/**
	 * Drop the scope label, for a Left Bar with no room for it - the collapsed
	 * rail, or a sidebar too narrow to take one. The glyph always stays: it is
	 * the entire point of the control.
	 */
	compact?: boolean;
}

export const VoiceStatusIndicator = memo(function VoiceStatusIndicator({
	theme,
	compact = false,
}: VoiceStatusIndicatorProps) {
	const enabled = useSettingsStore(selectACappellaEnabled);
	const state = useVoiceSessionStore((s) => s.state);
	const minimized = useVoiceUiStore((s) => s.minimized);
	const setMinimized = useVoiceUiStore((s) => s.setMinimized);
	const scope = useVoiceScope(theme);
	// The minimized HUD is still the session's surface, so it follows the HUD's
	// window: a session opened in another window must not leave a live microphone
	// indicator in this one's Left Bar.
	const ownsSession = useOwnsVoiceSession();

	// `minimized` alone, deliberately not `minimized || dismissed`. Dismissed is
	// the close button, which ends the session, so an indicator that also
	// respected it would sit there claiming an open microphone for the moment
	// between the click and the service confirming the session is gone.
	if (!enabled || !ownsSession || !isVoiceSessionActive(state) || !minimized) return null;

	const visualState = voiceHudVisualState(state);
	const stateLabel = VOICE_HUD_STATE_LABELS[visualState];

	// Bordered pill, matching the now-playing indicator beside it, so the two read
	// as the same class of thing: something running that you can get back to.
	// Never shrinks - the wordmark is this row's shrink target.
	return (
		<button
			type="button"
			data-testid="voice-status-indicator"
			onClick={() => setMinimized(false)}
			className={`flex items-center gap-1 shrink-0 rounded border text-[10px] font-bold transition-colors hover:bg-white/10 ${
				compact ? 'px-1 py-1' : 'pl-1.5 pr-1.5 py-0.5'
			}`}
			style={{ borderColor: theme.colors.accent, color: scope.color }}
			title={`Voice session: ${stateLabel} (${scope.label}) - click to show the voice HUD`}
			aria-label={`Voice session: ${stateLabel}, bound to ${scope.label}. Show the voice HUD.`}
		>
			<VoiceIndicator theme={theme} state={visualState} size={16} />
			{!compact && <span className="max-w-[7rem] truncate font-normal">{scope.label}</span>}
		</button>
	);
});
