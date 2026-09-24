/**
 * What the voice session is bound to, in the words and colour the HUD shows.
 *
 * This is the single most important line in the widget. Everything else on
 * screen is feedback about a turn that already happened; this says where the
 * NEXT sentence is going to land. Speaking a refactor instruction into the wrong
 * repository is the failure mode the whole HUD exists to prevent, so the scope
 * gets the agent's own colour, its name, and the tab the last dispatch actually
 * used - not a generic "connected" pill.
 *
 * The tab comes from `lastDispatch` rather than from the scope, because the
 * scope only names an agent. Which TAB a prompt landed in is decided per turn by
 * the router, and it is the part a user is most likely to have lost track of.
 */

import { useMemo } from 'react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import {
	documentScopeName,
	isDocumentScope,
	voiceScopeAgentId,
} from '../../../shared/acappella/document-scope';
import { generateParticipantColor } from '../../utils/participantColors';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';

export interface VoiceScopeDisplay {
	/** "Conductor", or the agent's name. Never empty. */
	label: string;
	/** The tab the last dispatch used, or null when nothing has been dispatched. */
	tabLabel: string | null;
	/** The agent's colour, already contrast-corrected for the HUD background. */
	color: string;
	/** The bound agent, or null for the conductor. */
	agentSessionId: string | null;
	/** The tab the last dispatch used, so the HUD can offer to jump to it. */
	tabId: string | null;
}

/**
 * The conductor's colour index.
 *
 * Zero is the group-chat moderator's reserved blue, which is the same idea
 * wearing a different hat: the one participant that coordinates the others. Two
 * features using one palette slot for the same role is consistency, not a
 * collision.
 */
const CONDUCTOR_COLOR_INDEX = 0;

export function useVoiceScope(theme: Theme): VoiceScopeDisplay {
	const scope = useVoiceSessionStore((s) => s.scope);
	const roster = useVoiceSessionStore((s) => s.roster);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);

	return useMemo(() => {
		const agentSessionId = voiceScopeAgentId(scope);
		const index = agentSessionId
			? roster.findIndex((agent) => agent.sessionId === agentSessionId)
			: -1;
		const agent = index >= 0 ? roster[index] : null;

		// The colour index is the agent's position in the roster, which is the only
		// stable per-agent ordinal this side of IPC. `+ 1` keeps every agent off the
		// conductor's reserved slot.
		const raw = generateParticipantColor(agentSessionId ? index + 1 : CONDUCTOR_COLOR_INDEX, theme);

		// The HUD sits on the sidebar background and the colour comes from a
		// palette, so a theme whose background lands near one of the hues would
		// otherwise paint the scope label invisibly on top of itself.
		const color = readableTextOn(raw, [theme.colors.bgSidebar, theme.colors.bgMain]);

		// The dispatch tab only describes this scope when it went to this agent. A
		// conductor session dispatches all over the fleet, so its last tab is not
		// "the tab you are talking to" and showing it would claim a binding that
		// does not exist.
		const dispatchMatches =
			!!lastDispatch && (!agentSessionId || lastDispatch.agentSessionId === agentSessionId);

		// A document conversation is named after the DOCUMENT, not the agent. The
		// scope line answers "where is the next sentence going", and in a document
		// session what the user needs confirmed is which file they are talking
		// about - the agent is an implementation detail of that binding, and it is
		// still on the row below as the tab the dispatch landed in.
		const label = isDocumentScope(scope)
			? documentScopeName(scope)
			: agentSessionId
				? (agent?.name ?? 'Agent')
				: 'Conductor';

		return {
			label,
			tabLabel: dispatchMatches ? (lastDispatch.tabName ?? null) : null,
			color,
			agentSessionId,
			tabId: dispatchMatches ? lastDispatch.tabId : null,
		};
	}, [lastDispatch, roster, scope, theme]);
}
