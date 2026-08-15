/**
 * A Cappella entries for the command palette.
 *
 * The third surface of `useVoiceAgentActions`, alongside the header voice pill
 * and the Left Bar right-click menu. It takes the action set rather than
 * re-deriving it, exactly as `buildGitWorktreeCommands` takes `GitAgentActions`:
 * the palette IS the third surface, not a reimplementation of the first two.
 *
 * Returns nothing when the Encore Feature is off, so the palette has no
 * A Cappella entries at all for users who never turned it on.
 */

import type { VoiceAgentActions } from '../../../hooks/voice/useVoiceAgentActions';
import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildVoiceCommandsArgs {
	activeSession: Session | undefined;
	/** The same action set the header pill and the Left Bar menu use. */
	voiceActions: VoiceAgentActions;
	/** Whether the transcript panel is currently open. */
	transcriptVisible: boolean;
	toggleTranscript: () => Promise<void>;
	setQuickActionOpen: (open: boolean) => void;
}

export function buildVoiceCommands({
	activeSession,
	voiceActions,
	transcriptVisible,
	toggleTranscript,
	setQuickActionOpen,
}: BuildVoiceCommandsArgs): QuickAction[] {
	if (!voiceActions.enabled) return [];

	const commands: QuickAction[] = [];

	if (activeSession) {
		commands.push({
			id: 'voiceTalkToAgent',
			label: `Talk to ${activeSession.name}`,
			// The wake phrase is surfaced here too: the palette is where people go
			// looking for a capability, and it is the cheapest place to teach them
			// they never needed to open it.
			subtext: voiceActions.wakePhrase
				? `Or say "${voiceActions.wakePhrase}"`
				: 'Open a voice session bound to this agent',
			action: () => {
				void voiceActions.talkToAgent();
				setQuickActionOpen(false);
			},
		});
	}

	commands.push({
		id: 'voiceTalkToConductor',
		label: 'Talk to the Conductor',
		subtext: 'Open a voice session that can route to any agent',
		action: () => {
			void window.maestro.voice.start().catch(() => undefined);
			setQuickActionOpen(false);
		},
	});

	commands.push({
		id: 'voiceToggleTranscript',
		label: transcriptVisible ? 'Hide Voice Transcript' : 'Show Voice Transcript',
		action: () => {
			void toggleTranscript();
			setQuickActionOpen(false);
		},
	});

	// Only offered when there is a session to end, for the same reason the header
	// menu hides it: an entry that does nothing teaches people the palette lies.
	if (voiceActions.hasVoiceFloor) {
		commands.push({
			id: 'voiceEndSession',
			label: 'End Voice Session',
			action: () => {
				void voiceActions.endVoiceSession();
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
