/**
 * Maps raw persisted sessions into the shape the group-chat router needs to
 * resolve @mention auto-add targets.
 *
 * Extracted verbatim out of main/index.ts's setupIpcHandlers()
 * (setGetSessionsCallback). The field mapping itself is `toGroupChatSessionInfo` in
 * the library, shared with the headless runtime; this binds it to the desktop's SSH
 * remote store and live process liveness.
 */

import type { getSshRemoteById } from '../../stores';
import { isAgentBusy, type ProcessLivenessProbe } from '../../utils/agent-busy';
import { toGroupChatSessionInfo } from '../../../shared/maestro-lib/groupchat/session-info';
import { liftBusyReason, readLiftedTo } from '../../../shared/maestro-lib/agents/lift-pointer';
import type { MirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';

/** What the hosted busy check reads: whether hosting is on, and the peer mirror's peers. */
export interface HostedBusySource {
	hostingEnabled(): boolean;
	peers(): readonly Pick<MirroredPeer, 'peerId' | 'agents'>[];
}

/**
 * Whether a hosted agent is running a turn on its host. Its turns run there, so no process here
 * shows it; the host's record, as the peer mirror holds it, does (`liftBusyReason()`). False for
 * an agent that is not hosted, with hosting off, or for a host the mirror does not hold.
 */
export function isBusyOnHost(session: { liftedTo?: unknown }, source?: HostedBusySource): boolean {
	const pointer = readLiftedTo(session.liftedTo);
	if (!pointer || !source?.hostingEnabled()) return false;
	const agent = source
		.peers()
		.find((peer) => peer.peerId === pointer.peer)
		?.agents.find((candidate) => candidate.id === pointer.agentId);
	return !!agent && liftBusyReason(agent) !== null;
}

export function mapSessionsForMentions(
	sessions: any[],
	getSshRemoteByIdFn: typeof getSshRemoteById,
	processManager?: ProcessLivenessProbe | null,
	hostedBusy?: HostedBusySource
) {
	return sessions.map((s: any) => ({
		...toGroupChatSessionInfo(s, {
			sshRemoteName: (remoteId) => getSshRemoteByIdFn(remoteId)?.name,
			// Live liveness, not the persisted state: persistence rewrites every
			// session and tab to 'idle' on the way to disk, so the stored record
			// can never say whether this agent is mid-turn. A hosted agent's turns run on its
			// host, so the host's record answers too: a busy hosted agent waits as a local one does.
			isBusy: isAgentBusy(s, processManager) || isBusyOnHost(s, hostedBusy),
		}),
		worktreeBasePath: s.worktreeConfig?.basePath,
	}));
}
