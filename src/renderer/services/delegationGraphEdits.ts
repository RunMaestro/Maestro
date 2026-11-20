/**
 * Writing a relationship from the Delegation Graph.
 *
 * The canvas owns no store of relationships. An edge from A to B IS a row for
 * B in A's `peerAgents`, so drawing, changing or taking away one is an edit to
 * A's roster and to nothing else. B is never written: the edge the other way
 * is B's own statement, in B's own settings.
 *
 * Every write is one `maestro-cli update-agent` makes: the same patch
 * (`PeerAgentEdits`), the same check (`peerAgentEditsProblem`) and the same
 * apply (`applyPeerAgentEdits`, whose result is already through
 * `normalizePeerAgents`). So the graph and the CLI cannot store different rows
 * for one gesture, and a row is replaced in place and never doubled.
 *
 *   | Gesture on the canvas                  | Patch              | CLI                    |
 *   | -------------------------------------- | ------------------ | ---------------------- |
 *   | Draw or change an edge                 | upsert + note      | `--peer <b>:<r|w|rw>`  |
 *   | Delete an edge the user wrote (a row)  | remove             | `--remove-peer <b>`    |
 *   | Delete an edge a grant derived         | upsert, no access  | `--peer <b>:none`      |
 *   | Save an edge with neither bit          | upsert, no access  | `--peer <b>:none`      |
 *
 * TAKING AN EDGE AWAY IS TWO DIFFERENT WRITES. An edge the user wrote has a row
 * behind it, and deleting the edge deletes the row. An edge a group or worktree
 * grant derived has no row: there is nothing to delete, so the one way to stop
 * that one peer is a row with NEITHER bit, which `resolvePeerRoster` reads as
 * an exclusion that overrides the grant. The two results differ in what is
 * left in the agent's settings, so `describeDelegationEdgeRemoval` says which
 * one happened, and the canvas shows it at the moment it happens.
 *
 * The agent is flushed to the main-process store at once. The renderer's own
 * persistence is debounced, and the next turn builds its `## Peer Agents`
 * block, and `show-agent` its report, from what main holds.
 */

import {
	applyPeerAgentEdits,
	hasAnyPeerAccess,
	PEER_GRANT_LABELS,
	peerAgentEditsProblem,
	resolveGrantedPeer,
	resolvePeerRoster,
	type PeerAgentEdits,
	type PeerAgentEditsResult,
	type PeerGrantSource,
} from '../../shared/peerAgents';
import type { PeerAccess } from '../../shared/types';
import type { ToastColor } from '../stores/notificationStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { flushAgentToStore } from './agentGateway';

/** What an edge editor hands over: the two bits, and the note as typed. */
export interface DelegationEdgeDraft extends PeerAccess {
	/** Blank clears the note of the row. */
	description: string;
}

/** Refused by `writeDelegationEdge`: an edge with neither bit is not a relationship. */
export const DELEGATION_EDGE_NEEDS_ACCESS = 'Pick Consult, Delegate or both.';

/** Refused by `deleteDelegationEdge`: the roster no longer gives that peer. */
export const DELEGATION_EDGE_NOT_FOUND = 'This edge is no longer on the graph.';

const AGENT_NOT_FOUND = 'Agent not found';

/**
 * What taking an edge away left behind.
 *
 *   - `removed`: the explicit row was deleted. `restoredBy` names the grant
 *     that still reaches the peer, in which case the edge is still drawn, as a
 *     derived one.
 *   - `excluded`: a row with neither bit was written. `overrides` names the
 *     grant it overrides. Absent when no grant reaches the peer today: the row
 *     then waits for one.
 */
export type DelegationEdgeRemoved =
	| { outcome: 'removed'; restoredBy?: PeerGrantSource }
	| { outcome: 'excluded'; overrides?: PeerGrantSource };

export type DelegationEdgeRemoval =
	| ({ ok: true } & DelegationEdgeRemoved)
	| { ok: false; error: string };

/** What the canvas tells the user after an edge was taken away. */
export interface DelegationEdgeRemovalNotice {
	color: ToastColor;
	title: string;
	message: string;
}

/**
 * Check `edits` against the live fleet, apply them to the roster of
 * `sourceId`, and persist the result. Refused, by name, with nothing written:
 * a source that is not an agent, an agent as its own peer, and a peer that is
 * given access or a note and is not a live agent.
 */
function applyRosterEdits(sourceId: string, edits: PeerAgentEdits): PeerAgentEditsResult {
	const { sessions } = useSessionStore.getState();
	const source = sessions.find((session) => session.id === sourceId);
	if (!source) return { ok: false, error: AGENT_NOT_FOUND };

	const problem = peerAgentEditsProblem(
		edits,
		new Set(sessions.map((session) => session.id)),
		sourceId
	);
	if (problem) return { ok: false, error: problem };

	const applied = applyPeerAgentEdits(source.peerAgents, edits);
	if (!applied.ok) return applied;

	updateSessionWith(sourceId, (session) => ({ ...session, peerAgents: applied.peerAgents }));
	void flushAgentToStore(sourceId);
	return applied;
}

/**
 * Write the edge from `sourceId` to `targetId`: upsert the row for the target
 * in the SOURCE's roster. A row the source already holds is replaced, so
 * re-drawing a direction edits it. A row that a group or worktree grant only
 * derived becomes an explicit one, which then overrides the grant for that one
 * peer.
 *
 * Refused, by name, with nothing written: an edge with neither bit (that is
 * `excludeDelegationPeer`, a separate and deliberate act), an agent as its own
 * peer, and an end that is not a live agent.
 */
export function writeDelegationEdge(
	sourceId: string,
	targetId: string,
	draft: DelegationEdgeDraft
): PeerAgentEditsResult {
	if (!hasAnyPeerAccess(draft)) return { ok: false, error: DELEGATION_EDGE_NEEDS_ACCESS };
	return applyRosterEdits(sourceId, {
		upsert: [{ sessionId: targetId, read: draft.read, write: draft.write }],
		notes: [{ sessionId: targetId, description: draft.description }],
	});
}

/**
 * Exclude `targetId` from the peers of `sourceId`: write a row with NEITHER
 * bit into the source's roster. That row overrides every group and worktree
 * grant for that one peer, and it stays when a grant is switched off and on
 * again. It is not a delete: the row is still in the agent's settings, on the
 * Peers tab, until the user removes it there.
 *
 * `description` sets the note of the row. Leave it out to keep the note the
 * row has.
 */
export function excludeDelegationPeer(
	sourceId: string,
	targetId: string,
	description?: string
): DelegationEdgeRemoval {
	const { sessions } = useSessionStore.getState();
	const source = sessions.find((session) => session.id === sourceId);
	if (!source) return { ok: false, error: AGENT_NOT_FOUND };

	const applied = applyRosterEdits(sourceId, {
		upsert: [{ sessionId: targetId, read: false, write: false }],
		...(description === undefined ? {} : { notes: [{ sessionId: targetId, description }] }),
	});
	if (!applied.ok) return applied;

	const overrides = resolveGrantedPeer(source, sessions, targetId)?.source;
	return { ok: true, outcome: 'excluded', ...(overrides ? { overrides } : {}) };
}

/**
 * Take away the edge from `sourceId` to `targetId`. What is written depends on
 * where the edge comes from, and the result says which:
 *
 *   - An edge the user wrote: the row is deleted. A grant that covers the peer
 *     then applies again, so the edge can still be drawn (`restoredBy`).
 *   - An edge a grant derived: there is no row to delete, so the peer is
 *     excluded (`excludeDelegationPeer`). The grant field is not touched.
 *
 * Refused, with nothing written, when the roster of the source does not give
 * that peer: there is no edge to take away.
 */
export function deleteDelegationEdge(sourceId: string, targetId: string): DelegationEdgeRemoval {
	const { sessions } = useSessionStore.getState();
	const source = sessions.find((session) => session.id === sourceId);
	if (!source) return { ok: false, error: AGENT_NOT_FOUND };

	const peer = resolvePeerRoster(source, sessions).find(
		(candidate) => candidate.sessionId === targetId
	);
	if (!peer) return { ok: false, error: DELEGATION_EDGE_NOT_FOUND };
	if (peer.source !== 'explicit') return excludeDelegationPeer(sourceId, targetId);

	const applied = applyRosterEdits(sourceId, { remove: [targetId] });
	if (!applied.ok) return applied;

	const restoredBy = resolveGrantedPeer(source, sessions, targetId)?.source;
	return { ok: true, outcome: 'removed', ...(restoredBy ? { restoredBy } : {}) };
}

/**
 * Say what taking an edge away did, in the words of the Peers tab. Four
 * results, and no two of them leave the same thing in the agent's settings:
 *
 *   | Result                       | Row for the peer | Edge on the graph   |
 *   | ---------------------------- | ---------------- | ------------------- |
 *   | removed                      | gone             | gone                |
 *   | removed, a grant restores it | gone             | still drawn, derived|
 *   | excluded, over a grant       | kept, no access  | gone                |
 *   | excluded, no grant today     | kept, no access  | gone                |
 */
export function describeDelegationEdgeRemoval(
	removed: DelegationEdgeRemoved,
	sourceName: string,
	targetName: string
): DelegationEdgeRemovalNotice {
	if (removed.outcome === 'removed') {
		if (!removed.restoredBy) {
			return {
				color: 'green',
				title: 'Edge deleted',
				message: `The row for ${targetName} was removed from the Peers of ${sourceName}. ${sourceName} can no longer reach ${targetName}.`,
			};
		}
		return {
			color: 'yellow',
			title: 'Row deleted, edge still drawn',
			message: `The row for ${targetName} was removed from the Peers of ${sourceName}. The "${PEER_GRANT_LABELS[removed.restoredBy]}" grant of ${sourceName} still reaches ${targetName}, so the edge stays and is drawn fainter. Delete it again to exclude ${targetName} from that grant.`,
		};
	}
	return {
		color: 'yellow',
		title: 'Peer excluded, not removed',
		message: removed.overrides
			? `The "${PEER_GRANT_LABELS[removed.overrides]}" grant of ${sourceName} is still in force, so there was no row to delete. A row with no access was written for ${targetName} in the Peers of ${sourceName}, and it overrides the grant for this one agent. To let the grant reach ${targetName} again, delete that row on the Peers tab.`
			: `The row for ${targetName} stays in the Peers of ${sourceName}, with no access. No group or worktree grant of ${sourceName} will reach ${targetName} while the row is there. To remove the row, delete it on the Peers tab.`,
	};
}
