/**
 * One agent's wake phrase, surfaced where the agent itself is configured.
 *
 * The same value the Voice Controls panel edits, read and written through the
 * same hook and stored in the same `acappella` settings blob. Deliberately NOT a
 * field on the `Session` record: an agent's wake phrase has to be resolvable by
 * the always-on detector in the main process, and a second copy on the session
 * would be a second answer to "what does this agent respond to".
 *
 * Renders nothing when A Cappella is off. A wake phrase field on a machine with
 * no voice feature is a question the user cannot act on.
 */

import type { Theme } from '../../../types';
import { useVoiceControls } from './useVoiceControls';

export interface AgentWakePhraseSectionProps {
	theme: Theme;
	/** The agent this phrase binds to. */
	agentSessionId: string;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

export function AgentWakePhraseSection({
	theme,
	agentSessionId,
	enabled,
}: AgentWakePhraseSectionProps) {
	const controls = useVoiceControls(enabled);
	if (!enabled) return null;

	const phrase =
		controls.agentPhrases.find((entry) => entry.agentSessionId === agentSessionId)?.phrase ?? '';

	return (
		// No `data-setting-id`: this renders in the agent modal, not the Settings
		// modal, and a registry entry would send Settings search to a tab that does
		// not contain it. The Voice Controls panel carries the searchable copy.
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Voice Wake Phrase
			</div>
			<input
				type="text"
				aria-label="Voice wake phrase"
				value={phrase}
				placeholder="No phrase"
				onChange={(event) => void controls.setAgentPhrase(agentSessionId, event.target.value)}
				className="w-full p-2 rounded border text-sm"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
				}}
			/>
			<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
				Saying this opens a voice session bound straight to this agent, with no routing step. Leave
				blank to use the global wake phrase and let the Conductor decide.
			</p>
		</div>
	);
}
