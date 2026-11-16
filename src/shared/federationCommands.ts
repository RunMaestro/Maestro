/**
 * Wire shape of `federation_command`, the CLI half of the desktop's Federation peer mirror
 * (`maestro-cli federation peers|reconnect`, FED-SSH-05).
 *
 * The desktop answers it from the one main-process `PeerMirrorService`, the same instance the
 * `federation:*` IPC handlers and the Left Bar peer groups read, so the CLI prints what the
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
 * Agent draws), for `show agent --json`.
 */
export type FederationCommandAction =
	| 'peers'
	| 'reconnect'
	| 'auto-status'
	| 'auto-run'
	| 'conflicts'
	| 'resolve-conflict'
	| 'settings-fields';

export const FEDERATION_COMMAND_ACTIONS: readonly FederationCommandAction[] = [
	'peers',
	'reconnect',
	'auto-status',
	'auto-run',
	'conflicts',
	'resolve-conflict',
	'settings-fields',
];

/** The conflicts of one hosted agent, as the modal lists them. */
export interface HostedSettingsConflictSummary {
	/** `peer:agentId`, the address `resolve-conflict` takes. */
	agent: string;
	peerId: string;
	agentId: string;
	agentName: string;
	conflicts: LiftSyncConflict[];
}

/** What main asks the window that runs the settings sync, and what it answers. */
export type HostedSettingsRequest =
	| { action: 'list' }
	| { action: 'resolve'; agent: string; field: string; resolution: LiftSyncResolution }
	/** `agent` is `peer:agentId` of the host agent. */
	| { action: 'fields'; agent: string };

export interface HostedSettingsReply {
	success: boolean;
	error?: string;
	conflicts?: HostedSettingsConflictSummary[];
	/** `fields`: every setting of the agent, with its scope and what waits on it. */
	fields?: FederationFieldStatus[];
}

/** The renderer channel main asks on (`requestFromRenderer`). */
export const HOSTED_SETTINGS_REQUEST_CHANNEL = 'federation:hostedSettings';

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
}
