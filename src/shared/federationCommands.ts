/**
 * Wire shape of `federation_command`, the CLI half of the desktop's Federation peer mirror
 * (`maestro-cli federation peers|reconnect`, FED-SSH-05).
 *
 * The desktop answers it from the one main-process `PeerMirrorService`, the same instance the
 * `federation:*` IPC handlers and the hosted Left Bar rows read, so the CLI prints what the
 * desktop shows. CLI only: a browser client is refused, as every `federation:` IPC channel is on
 * the web-desktop deny list.
 *
 * Lives in `shared/` because main answers it and the CLI prints it.
 */

import type { MirrorPeerSummary } from './maestro-lib/client/peer-mirror';
import type { AutoFederationSnapshot } from './federationAuto';
import type {
	FederationFieldStatus,
	LiftSyncConflict,
	LiftSyncResolution,
} from './maestro-lib/agents/lift-settings-sync';

/**
 * The answer while the main-process peer mirror is not running: before boot started it, or after
 * quit stopped it. Federation itself is always on.
 */
export const FEDERATION_NOT_RUNNING_MESSAGE =
	'Federation is not running yet. Wait for Maestro to finish starting, then try again.';

export const FEDERATION_COMMAND = 'federation_command';
export const FEDERATION_COMMAND_RESULT = 'federation_command_result';

/**
 * `peers` lists what the desktop mirrors; `reconnect` forces one peer's reload; `auto-status`
 * reads automatic Federation's snapshot; `auto-run` runs a pass now and answers what it left.
 * `conflicts` lists the hosted agents' settings waiting for a person (the Federation Settings
 * Conflicts modal); `resolve-conflict` settles one the way its buttons do. `settings-fields`
 * answers where each setting of one hosted agent lives and what waits on it (the badges Edit
 * Agent draws), for `show agent --json`. `hosted-agents` lists every agent the peers' hosts run
 * and which of them the Left Bar shows; `add-agent` adds one (the Add Hosted Agent modal).
 */
export type FederationCommandAction =
	| 'peers'
	| 'reconnect'
	| 'auto-status'
	| 'auto-run'
	| 'conflicts'
	| 'resolve-conflict'
	| 'settings-fields'
	| 'hosted-agents'
	| 'add-agent';

export const FEDERATION_COMMAND_ACTIONS: readonly FederationCommandAction[] = [
	'peers',
	'reconnect',
	'auto-status',
	'auto-run',
	'conflicts',
	'resolve-conflict',
	'settings-fields',
	'hosted-agents',
	'add-agent',
];

/**
 * One agent a peer's host runs, as the Add Hosted Agent modal and `maestro-cli federation agents`
 * list it. `addedAs` is the local agent (Left Bar row) that points at it, when one does.
 */
export interface HostedAgentListing {
	peerId: string;
	peerName: string;
	agentId: string;
	/** `peer:agentId`, the address maestro-cli takes. */
	ref: string;
	name: string;
	toolType: string;
	cwd?: string;
	/** The host agent's group on the host, by name, when it has one. */
	hostGroupName?: string;
	/** The id of the local agent that shows it in the Left Bar. */
	addedAs?: string;
}

/** What `add-agent` asks for: the host agent, and where its Left Bar row goes. */
export interface AddHostedAgentRequest {
	/** `peer:agent`: the agent part is its id, an id prefix, or its name. */
	agent: string;
	/** A local group id or name. Absent: ungrouped. */
	group?: string;
	/** Leave the Left Bar selection where it is. */
	background?: boolean;
}

/** The Left Bar row `add-agent` made. */
export interface AddedHostedAgent {
	/** The local agent's id. */
	id: string;
	name: string;
	ref: string;
	groupId?: string;
}

/** The conflicts of one hosted agent, as the modal lists them. */
export interface HostedSettingsConflictSummary {
	/** `peer:agentId`, the address `resolve-conflict` takes. */
	agent: string;
	peerId: string;
	agentId: string;
	agentName: string;
	conflicts: LiftSyncConflict[];
}

/**
 * What main asks the main window about Federation, and what it answers: the hosted agents'
 * settings conflicts (they live with the window's settings sync), the host agents and which ones
 * the Left Bar shows, and adding one (the Left Bar's agents live in the window).
 */
export type FederationWindowRequest =
	| { action: 'list' }
	| { action: 'resolve'; agent: string; field: string; resolution: LiftSyncResolution }
	/** `agent` is `peer:agentId` of the host agent. */
	| { action: 'fields'; agent: string }
	| { action: 'hosted-agents' }
	| ({ action: 'add-agent' } & AddHostedAgentRequest);

export interface FederationWindowReply {
	success: boolean;
	error?: string;
	conflicts?: HostedSettingsConflictSummary[];
	/** `fields`: every setting of the agent, with its scope and what waits on it. */
	fields?: FederationFieldStatus[];
	hostedAgents?: HostedAgentListing[];
	added?: AddedHostedAgent;
}

/** The renderer channel main asks on (`requestFromRenderer`). */
export const FEDERATION_WINDOW_REQUEST_CHANNEL = 'federation:windowRequest';

export interface FederationCommandRequest {
	type: typeof FEDERATION_COMMAND;
	action: FederationCommandAction;
	/** `reconnect` only: a peer id, remote name, or remote id (prefix), as `findMirrorPeer()` reads it. */
	peer?: string;
	/** `resolve-conflict` and `settings-fields`: the hosted agent (`peer:agentId`). */
	agent?: string;
	/** `resolve-conflict` only: the field id the conflict list names. */
	field?: string;
	/** `resolve-conflict` only: which value wins; `value` takes `value` below. */
	take?: 'host' | 'local' | 'value';
	/** `resolve-conflict` with `take: 'value'`: the merged text. */
	value?: string;
	/** `add-agent` only: the local group (id or name) the row goes in. */
	group?: string;
	/** `add-agent` only: leave the Left Bar selection where it is. */
	background?: boolean;
}

export interface FederationCommandResult {
	success: boolean;
	error?: string;
	/** `peers`: every peer the desktop mirrors, in stored order. */
	peers?: MirrorPeerSummary[];
	/** `reconnect`: the peer after its reload, also on a failed reload. */
	peer?: MirrorPeerSummary;
	/** `auto-status` / `auto-run`: automatic Federation, per remote and per SSH agent. */
	auto?: AutoFederationSnapshot;
	/** `conflicts` / `resolve-conflict`: what still waits for a person, after the change. */
	conflicts?: HostedSettingsConflictSummary[];
	/** `settings-fields`: every setting of the agent, with its scope and what waits on it. */
	fields?: FederationFieldStatus[];
	/** `hosted-agents`: every agent the mirrored hosts run, with the ones the Left Bar shows. */
	hostedAgents?: HostedAgentListing[];
	/** `add-agent`: the Left Bar row it made. */
	added?: AddedHostedAgent;
}
