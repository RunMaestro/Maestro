/**
 * Automatic Federation: what the desktop did, is waiting on, or could not do on its own, per SSH
 * remote and per SSH agent. Renderer-safe types, read by the Left Bar badge, the toasts, and
 * `maestro-cli federation auto`.
 *
 * The desktop's coordinator (`src/main/federation/auto-federation.ts`) keeps each remote able to
 * run a host (installs `maestro-cli`, registers the service, starts a stopped host) and moves each
 * SSH agent onto its remote's host once every sanity check passes. Whatever it cannot do itself
 * ends as `blocked` with a `fix`: the one thing a person has to do.
 */

/** The setting that turns automatic moves on or off (on by default). */
export const FEDERATION_AUTO_MOVE_SETTING = 'federationAutoMove';

/**
 * - `ready`: a host runs and the mirror is connected.
 * - `setting-up`: installing, registering the service, or starting the host now.
 * - `waiting`: nothing to do on this remote yet (no host, and no SSH agent that needs one).
 * - `blocked`: setup failed; `fix` says what a person has to do. Retried after a while.
 * - `off`: the remote opted out of Federation, or is disabled.
 */
export type AutoFederationRemoteState = 'ready' | 'setting-up' | 'waiting' | 'blocked' | 'off';

/**
 * - `moved`: lifted onto the host (this run of the app did it).
 * - `pending`: will move on the next pass (its host is being set up, or the pass has not run).
 * - `waiting`: a passing condition holds it back (a turn is running); it moves by itself later.
 * - `blocked`: a sanity check failed; `fix` says what a person has to do. Not retried until the
 *   agent or its remote changes, or a while passes.
 * - `manual`: automatic moves are off; Move to Host still works.
 */
export type AutoFederationAgentState = 'moved' | 'pending' | 'waiting' | 'blocked' | 'manual';

export interface AutoFederationRemoteStatus {
	remoteId: string;
	name: string;
	state: AutoFederationRemoteState;
	/** What happened, in one sentence. */
	reason?: string;
	/** What a person has to do, when anything. */
	fix?: string;
	/**
	 * `fix` is required, not advice: the host runs, but will not survive logout or reboot (or the
	 * service could not be registered) until a person acts. `blocked` implies it too.
	 */
	needsYou?: boolean;
	/** How the remote keeps its host running across reboots, in one sentence. */
	service?: string;
	/** Epoch ms of the last change. */
	at: number;
}

export interface AutoFederationAgentStatus {
	agentId: string;
	agentName: string;
	remoteId: string;
	state: AutoFederationAgentState;
	reason?: string;
	fix?: string;
	/** `peer:agent` once moved. */
	target?: string;
	at: number;
}

export interface AutoFederationSnapshot {
	/** Automatic moves are on. Hosts are kept running either way. */
	autoMove: boolean;
	/** Epoch ms the last pass finished, if one ran. */
	lastPassAt?: number;
	/** A pass runs right now. */
	running: boolean;
	remotes: AutoFederationRemoteStatus[];
	agents: AutoFederationAgentStatus[];
}

export function emptyAutoFederationSnapshot(autoMove = true): AutoFederationSnapshot {
	return { autoMove, running: false, remotes: [], agents: [] };
}
