/**
 * The AI tab that voice is landing in.
 *
 * A glance at the tab bar has to answer "where is what I am saying going", and
 * the Left Bar cannot answer it: an agent has many tabs, the router picks one
 * per turn, and it is very often not the one on screen. Without this, a spoken
 * instruction routed to a background tab is invisible until the user goes
 * looking for it.
 *
 * Two facts, the same two the Left Bar draws for an agent:
 *
 *   - **Holding the floor.** Tab mode pins the session to this tab, so what is
 *     said next lands here. The shared filled microphone, the same mark the
 *     agent row shows, so a pinned tab and its agent read as one binding.
 *   - **Where the last prompt landed.** In Agent and Conductor mode the router
 *     picks a tab per turn; this marks the one it picked last.
 *
 * Reads the voice store itself and renders null when the Encore Feature is off,
 * so the tab bar wires up nothing - the same arrangement as the Left Bar's
 * `AgentVoiceIndicator`, and for the same reason: the tab components are
 * memoized on primitive props, and threading voice state through them would
 * re-render every tab on every voice event.
 */

import { memo } from 'react';
import { Mic } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { usePrefersReducedMotion } from '../../hooks/utils/usePrefersReducedMotion';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { voiceScopeTabId } from '../../../shared/acappella/voice-mode';
import { VoiceFloorMark } from '../ACappella/VoiceFloorMark';

export interface TabVoiceIndicatorProps {
	tabId: string;
	theme: Theme;
}

export const TabVoiceIndicator = memo(function TabVoiceIndicator({
	tabId,
	theme,
}: TabVoiceIndicatorProps) {
	const enabled = useSettingsStore(selectACappellaEnabled);
	const state = useVoiceSessionStore((s) => s.state);
	const scope = useVoiceSessionStore((s) => s.scope);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);
	const reducedMotion = usePrefersReducedMotion();

	if (!enabled || !isVoiceSessionActive(state)) return null;

	if (voiceScopeTabId(scope) === tabId) {
		return (
			<VoiceFloorMark
				theme={theme}
				testId="tab-voice-floor"
				label="Holding the voice floor: what you say next goes to this tab"
			/>
		);
	}

	// The dispatch address outlives the turn, which is what makes the marker
	// useful: it says where the last thing you said went, not merely where audio
	// is being processed this instant. It clears when the session ends.
	if (lastDispatch?.tabId !== tabId) return null;

	const accent = readableTextOn(theme.colors.accent, [theme.colors.bgMain, theme.colors.bgSidebar]);
	const live = state === 'listening' || state === 'speaking';

	return (
		<span
			data-testid="tab-voice-indicator"
			data-motion={reducedMotion ? 'static' : 'animated'}
			className={`shrink-0 flex items-center${live && !reducedMotion ? ' animate-pulse' : ''}`}
			title="Voice prompts are landing in this tab"
			aria-label="Voice prompts are landing in this tab"
		>
			<Mic className="w-3 h-3" style={{ color: accent }} fill={live ? accent : 'none'} />
		</span>
	);
});

export default TabVoiceIndicator;
