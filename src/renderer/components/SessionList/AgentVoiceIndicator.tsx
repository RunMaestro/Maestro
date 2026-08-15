/**
 * Per-agent voice indicators for the Left Bar.
 *
 * Three separate facts, three separate glyphs, all next to the agent's name:
 *
 *   - **Holding the floor.** This agent is what the live voice session is bound
 *     to, so anything said next lands here. A filled microphone.
 *   - **Being spoken.** This agent's reply is coming out of the speakers right
 *     now, which is not the same thing - a Conductor session speaks replies from
 *     whichever agent it routed to, and that agent may not hold the floor at all.
 *   - **Has a wake phrase.** Saying the phrase jumps straight into this agent.
 *     Without a badge that mapping is invisible, and an invisible mapping is one
 *     nobody uses.
 *
 * These COMPOSE with the status dot rather than replacing it. Green/yellow/red
 * still means ready/busy/error; the voice glyphs sit beside them and say
 * something the status colour cannot. Overloading the dot would mean losing the
 * agent's state for as long as it was being talked to, which is exactly when the
 * user most wants to know whether it is working.
 *
 * The component reads the stores itself instead of taking props, for the same
 * reason `VoiceIndicator` does: SessionItem is memoized on primitive props and
 * renders once per row, and threading four voice fields through SessionList
 * would re-render every row in the Left Bar on every voice event.
 */

import { memo } from 'react';
import { Mic, Volume2, Waves } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { usePrefersReducedMotion } from '../../hooks/utils/usePrefersReducedMotion';
import { selectACappellaEnabled, useSettingsStore } from '../../stores/settingsStore';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { selectWakePhraseFor, useVoiceUiStore } from '../../stores/voiceUiStore';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';

export interface AgentVoiceIndicatorProps {
	/** The agent this row is for. */
	sessionId: string;
	theme: Theme;
}

export const AgentVoiceIndicator = memo(function AgentVoiceIndicator({
	sessionId,
	theme,
}: AgentVoiceIndicatorProps) {
	const enabled = useSettingsStore(selectACappellaEnabled);
	const state = useVoiceSessionStore((s) => s.state);
	const scope = useVoiceSessionStore((s) => s.scope);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);
	const wakePhrase = useVoiceUiStore(selectWakePhraseFor(sessionId));
	const reducedMotion = usePrefersReducedMotion();

	if (!enabled) return null;

	const hasFloor =
		isVoiceSessionActive(state) && scope?.kind === 'agent' && scope.sessionId === sessionId;
	const speaking = state === 'speaking' && lastDispatch?.agentSessionId === sessionId;

	if (!hasFloor && !speaking && !wakePhrase) return null;

	// The accent is the theme's own colour and the Left Bar row background is
	// too, so a theme whose accent sits near its sidebar would otherwise paint
	// these glyphs invisibly.
	const accent = readableTextOn(theme.colors.accent, [theme.colors.bgSidebar, theme.colors.bgMain]);

	return (
		<>
			{hasFloor && (
				<span
					data-testid="agent-voice-floor"
					className="shrink-0 flex items-center"
					title="Holding the voice floor: what you say next goes here"
					aria-label="Holding the voice floor"
				>
					<Mic className="w-3 h-3" style={{ color: accent }} fill={accent} />
				</span>
			)}
			{speaking && (
				<span
					data-testid="agent-voice-speaking"
					data-motion={reducedMotion ? 'static' : 'animated'}
					className={`shrink-0 flex items-center${reducedMotion ? '' : ' animate-pulse'}`}
					title="Speaking this agent's reply"
					aria-label="Speaking this agent's reply"
				>
					<Volume2 className="w-3 h-3" style={{ color: accent }} />
				</span>
			)}
			{wakePhrase && (
				<span
					data-testid="agent-voice-wake-phrase"
					className="shrink-0 flex items-center"
					title={`Wake phrase: "${wakePhrase}"`}
					aria-label={`Wake phrase: ${wakePhrase}`}
				>
					<Waves className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</span>
			)}
		</>
	);
});

export default AgentVoiceIndicator;
