/**
 * The pointer a lifted agent keeps after Federation moved it onto its host.
 *
 * A lift moves ownership of an SSH agent to the `maestro-cli host` on its remote, for good. The
 * local record stays (every tab and transcript is kept; tabs are never destroyed) and gains
 * `liftedTo`, which names the peer and the agent id the host gave it. From then on the local
 * copy is a pointer, not a second owner: a send to it would start a turn on the same provider
 * session the host now resumes, so every send path refuses it with {@link liftedSendRefusal},
 * and `list agents` shows where the agent went.
 *
 * Records come from JSON files, so {@link readLiftedTo} validates the stored shape before anything
 * acts on it. A malformed pointer reads as "not lifted" rather than as a refusal nobody can act on.
 *
 * Pure.
 */

/** Where a lifted agent went: the peer that owns it now, its id there, and when it moved. */
export interface LiftedToPointer {
	/** The peer id it is addressed by (`peerIdFor()`): the SSH remote's name, or its id. */
	peer: string;
	/** The agent id the host assigned. */
	agentId: string;
	/** When the lift finished, in epoch milliseconds. */
	at: number;
}

/** The error code a refused send reports (`--json` output and bridge replies). */
export const AGENT_LIFTED_CODE = 'AGENT_LIFTED';

/** How a peer's agent is addressed on the command line: `peer:agentId`. */
export function peerAgentRef(peer: string, agentId: string): string {
	return `${peer}:${agentId}`;
}

/** The stored pointer, or undefined when the field is absent or malformed. */
export function readLiftedTo(value: unknown): LiftedToPointer | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { peer, agentId, at } = value as Record<string, unknown>;
	if (typeof peer !== 'string' || !peer.trim()) return undefined;
	if (typeof agentId !== 'string' || !agentId.trim()) return undefined;
	if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
	return { peer, agentId, at };
}

/** `peer:agentId` for a lifted agent, or undefined when it was not lifted. */
export function liftedAgentRef(agent: { liftedTo?: unknown }): string | undefined {
	const pointer = readLiftedTo(agent.liftedTo);
	return pointer ? peerAgentRef(pointer.peer, pointer.agentId) : undefined;
}

/**
 * The message a send to a lifted agent is refused with, or undefined when the agent was not
 * lifted and the send may go ahead.
 */
export function liftedSendRefusal(agent: {
	name?: string;
	liftedTo?: unknown;
}): string | undefined {
	const pointer = readLiftedTo(agent.liftedTo);
	if (!pointer) return undefined;
	const ref = peerAgentRef(pointer.peer, pointer.agentId);
	const who = agent.name ? `"${agent.name}"` : 'This agent';
	return `${who} was moved to peer "${pointer.peer}" and runs there now. Send to ${ref} instead.`;
}

/**
 * The lifted agent that owns a process id, or undefined. Process ids for an agent's turns start
 * with the agent id (`{agentId}-ai-{tabId}`, `{agentId}-batch-...`). Agent ids are UUIDs (fixed
 * length, hex and dashes), so `{agentId}-` is never the start of another agent's process id and a
 * prefix match finds the owner. Used by spawn paths as a backstop: no turn of a lifted agent
 * starts here.
 */
export function liftedOwnerOfProcess<T extends { id: string; liftedTo?: unknown }>(
	agents: readonly T[],
	processSessionId: string
): T | undefined {
	return agents.find(
		(agent) =>
			!!agent &&
			readLiftedTo(agent.liftedTo) !== undefined &&
			(processSessionId === agent.id || processSessionId.startsWith(`${agent.id}-`))
	);
}

/**
 * Why a turn of this agent is running, or null. The agent's own state and every tab's state count,
 * hidden consult tabs included: a consult answering on one of them is a running turn too.
 */
export function liftBusyReason(agent: {
	name?: string;
	state?: string;
	aiTabs?: readonly { id: string; name?: string | null; state?: string }[];
}): string | null {
	const tabs = Array.isArray(agent.aiTabs) ? agent.aiTabs : [];
	const busyTab = tabs.find((tab) => tab?.state === 'busy');
	const who = agent.name ? `"${agent.name}"` : 'The agent';
	if (busyTab) {
		const tab = busyTab.name ? `tab "${busyTab.name}"` : `tab ${busyTab.id}`;
		return `${who} is running a turn in ${tab}. A running turn cannot move: wait for it to finish, or stop it, then lift again.`;
	}
	if (agent.state === 'busy') {
		return `${who} is busy. A running turn cannot move: wait for it to finish, or stop it, then lift again.`;
	}
	return null;
}
