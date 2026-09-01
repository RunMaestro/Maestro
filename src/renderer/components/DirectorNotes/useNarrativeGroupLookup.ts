/**
 * useNarrativeGroupLookup
 *
 * Builds the agent-name -> Left Bar group mapping that Director's Notes uses to
 * bucket its bullets. The synopsis agent tags each bullet with the session it
 * came from; Maestro - not the model - decides which group that session sits
 * in, which is why the mapping is derived here from live store state instead of
 * being another field in the prompt contract.
 *
 * Recomputed only when sessions or groups actually change, so a re-render of
 * the notes modal does not rebuild the map (and, through it, every bucket).
 */

import { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import {
	buildNarrativeGroupLookup,
	type NarrativeAgentGroupEntry,
	type NarrativeGroupLookup,
} from '../../../shared/directorNotesGrouping';

export function useNarrativeGroupLookup(): NarrativeGroupLookup {
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);

	return useMemo(() => {
		const groupsById = new Map(groups.map((g) => [g.id, g]));
		const entries: NarrativeAgentGroupEntry[] = [];
		for (const session of sessions) {
			if (!session.name || !session.groupId) continue;
			const group = groupsById.get(session.groupId);
			if (!group) continue;
			entries.push({ agent: session.name, group: group.name, emoji: group.emoji });
		}
		return buildNarrativeGroupLookup(entries);
	}, [sessions, groups]);
}

export default useNarrativeGroupLookup;
