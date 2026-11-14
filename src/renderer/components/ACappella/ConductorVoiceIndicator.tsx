/**
 * The Conductor holding the voice floor, drawn beside the MAESTRO wordmark.
 *
 * In Tab and Agent mode the floor glyph sits on the tab and the agent the
 * session is bound to. In Conductor mode it is bound to neither - you are
 * talking to Maestro, and the Conductor picks the agent per sentence - so the
 * glyph moves to the one thing that IS Maestro: the logo. Without it, switching
 * to Conductor made the floor glyph vanish, which reads as the microphone
 * having closed.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { voiceScopeMode } from '../../../shared/acappella/voice-mode';
import { VoiceFloorMark } from './VoiceFloorMark';

/**
 * Whether a live session is bound to the Conductor. Exported so the Left Bar
 * header can reserve the glyph's width before deciding to draw the wordmark.
 */
export function useConductorHoldsFloor(): boolean {
	const enabled = useSettingsStore(selectACappellaEnabled);
	return useVoiceSessionStore(
		(s) => enabled && isVoiceSessionActive(s.state) && voiceScopeMode(s.scope) === 'conductor'
	);
}

export const ConductorVoiceIndicator = memo(function ConductorVoiceIndicator({
	theme,
}: {
	theme: Theme;
}) {
	if (!useConductorHoldsFloor()) return null;
	return (
		<VoiceFloorMark
			theme={theme}
			testId="conductor-voice-floor"
			label="The Conductor holds the voice floor: what you say next goes to Maestro"
		/>
	);
});
