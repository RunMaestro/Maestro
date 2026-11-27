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

/**
 * The setting that turns hosted agents on for this machine. Off by default: only an explicit `true`
 * opts in. Off, a lifted record works as the SSH agent it was: its turns run over SSH from here,
 * nothing is sent to its host, and nothing on the host or in the record changes, so switching it
 * on again restores hosting.
 */
export const HOSTED_AGENTS_SETTING = 'federationHostedAgents';

/** Whether hosted agents are on, from the stored settings (absent means off: only `true` opts in). */
export function hostedAgentsEnabled(settings: Record<string, unknown> | undefined | null): boolean {
	return settings?.[HOSTED_AGENTS_SETTING] === true;
}

/** The error code a refused send reports (`--json` output and bridge replies). */
export const AGENT_LIFTED_CODE = 'AGENT_LIFTED';

/**
 * Stamped on a hosted agent's turn, so `maestro-cli ask` and `dispatch` inside it know their
 * caller is a hosted agent: every turn `maestro-cli host` runs, and every turn a Maestro desktop
 * runs for a message that arrived over the client protocol. Set it only through
 * `hostedTurnEnv()`, so both hosts set it the same way.
 */
export const HOSTED_TURN_ENV_VAR = 'MAESTRO_HOSTED_TURN';

/** The environment that marks a hosted agent's turn (`HOSTED_TURN_ENV_VAR`). */
export function hostedTurnEnv(): Record<string, string> {
	return { [HOSTED_TURN_ENV_VAR]: '1' };
}

/** The error code `hostedTurnTargetRefusal()` is reported with. */
export const TARGET_OFF_HOST_CODE = 'TARGET_OFF_HOST';

/**
 * Why a consult or delegation from a hosted agent's turn cannot reach `target`, or undefined when
 * the caller is not a hosted turn. Ask it only for a target the host does not hold (an id it
 * cannot resolve, or a `peer:agent` route): the turn runs on the host, with the host's
 * `maestro-cli`, so an agent on a conductor's machine is out of its reach until hosts can call
 * back.
 */
export function hostedTurnTargetRefusal(
	target: string,
	env: Readonly<Record<string, string | undefined>>
): string | undefined {
	if (env[HOSTED_TURN_ENV_VAR] !== '1') return undefined;
	return `"${target}" is not an agent on this host. This agent runs on a Federation host, so it can consult and delegate only to agents on the same host; an agent on a conductor's machine cannot be reached from here.`;
}

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
 * Where a hosted agent's turns run: its pointer while hosted agents are on, undefined for an
 * agent that is not lifted or while they are off (it then works as its SSH agent, from here).
 * The CLI sends to this peer agent what a local id names (`liftedPeerTarget()`).
 */
export function hostedPointer(
	agent: { liftedTo?: unknown },
	/** `HOSTED_AGENTS_SETTING`, or a reader for it: read only for a lifted agent. */
	hostedEnabled: boolean | (() => boolean) = true
): LiftedToPointer | undefined {
	const pointer = readLiftedTo(agent.liftedTo);
	if (!pointer) return undefined;
	if (!(typeof hostedEnabled === 'function' ? hostedEnabled() : hostedEnabled)) return undefined;
	return pointer;
}

/**
 * The message a send to a lifted agent is refused with, or undefined when the agent was not
 * lifted and the send may go ahead. For a place that cannot reach the host (a host's own
 * runtime holding a stale pointer); the CLI routes such a send to the host instead.
 */
export function liftedSendRefusal(
	agent: {
		name?: string;
		liftedTo?: unknown;
	},
	/** `HOSTED_AGENTS_SETTING`, or a reader for it: read only for a lifted agent. */
	hostedEnabled: boolean | (() => boolean) = true
): string | undefined {
	const pointer = hostedPointer(agent, hostedEnabled);
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

/** The live state a host or the desktop's bridge sends for an agent, as far as a running turn reads. */
export interface RunningTurnProbe {
	name?: string;
	state?: string;
	aiTabs?: readonly { id: string; name?: string | null; state?: string }[];
}

/**
 * Where a turn of this agent runs now ("tab \"Main\"", "tab t1", or "" for the agent as a whole),
 * or null when none does. The agent's own state and every tab's state count, hidden consult tabs
 * included: a consult answering on one of them is a running turn too.
 */
export function runningTurnWhere(agent: RunningTurnProbe): string | null {
	const tabs = Array.isArray(agent.aiTabs) ? agent.aiTabs : [];
	const busyTab = tabs.find((tab) => tab?.state === 'busy');
	if (busyTab) return busyTab.name ? `tab "${busyTab.name}"` : `tab ${busyTab.id}`;
	return agent.state === 'busy' ? '' : null;
}

/** Why a turn of this agent is running, or null: the refusal a lift shows. */
export function liftBusyReason(agent: RunningTurnProbe): string | null {
	const where = runningTurnWhere(agent);
	if (where === null) return null;
	const who = agent.name ? `"${agent.name}"` : 'The agent';
	return where
		? `${who} is running a turn in ${where}. A running turn cannot move: wait for it to finish, or stop it, then lift again.`
		: `${who} is busy. A running turn cannot move: wait for it to finish, or stop it, then lift again.`;
}

/**
 * The `peer:agentId` of every hosted agent the person keeps in their Left Bar: one per local record
 * with a pointer, whether it moved from here (a lift) or was added from the host's roster. A
 * peer's other agents belong to whoever runs that host, so the Left Bar, the Thinking pill, and
 * the command palette leave them out.
 */
export function liftedAgentKeys(agents: readonly { liftedTo?: unknown }[]): Set<string> {
	const keys = new Set<string>();
	for (const agent of agents) {
		const pointer = readLiftedTo(agent?.liftedTo);
		if (pointer) keys.add(peerAgentRef(pointer.peer, pointer.agentId));
	}
	return keys;
}

/** The local record that points at `peer:agentId`, or undefined when none does. */
export function findLiftedAgent<T extends { liftedTo?: unknown }>(
	agents: readonly T[],
	peer: string,
	agentId: string
): T | undefined {
	return agents.find((agent) => {
		const pointer = readLiftedTo(agent?.liftedTo);
		return pointer !== undefined && pointer.peer === peer && pointer.agentId === agentId;
	});
}
