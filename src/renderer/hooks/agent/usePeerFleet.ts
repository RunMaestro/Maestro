/**
 * usePeerFleet
 *
 * What a Peer Agents editor (`PeerAgentsSection`) draws from besides the form
 * it sits in: the live fleet, cut down to the three fields its picker and its
 * group count read, and the name of the group the edited agent is in.
 *
 * The section reads no store, so every form that mounts it reads the fleet
 * here: Edit Agent passes the group the agent is in now, New Agent the group
 * selected on General, and the wizard no group, because its agent starts in
 * none. The returned keys are the section's own prop names, so a caller can
 * spread the result onto `<PeersTab>` or the section itself.
 */

import { useMemo } from 'react';
import type { PeerAgentOption } from '../../components/shared/PeerAgentsSection';
import { useSessionStore } from '../../stores/sessionStore';

export interface PeerFleet {
	/** Every agent in the fleet. The section leaves out the edited agent itself. */
	availableAgents: PeerAgentOption[];
	/** Name of `groupId`'s group. Absent with no group id, or a group that is gone. */
	groupName?: string;
}

export function usePeerFleet(groupId: string | undefined): PeerFleet {
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const availableAgents = useMemo(
		() => sessions.map((agent) => ({ id: agent.id, name: agent.name, groupId: agent.groupId })),
		[sessions]
	);
	const groupName = groupId ? groups.find((g) => g.id === groupId)?.name : undefined;
	return { availableAgents, groupName };
}
