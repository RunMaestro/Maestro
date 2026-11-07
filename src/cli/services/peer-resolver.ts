// `peer:agent` addressing for maestro-cli (Federation over SSH, #1716).
//
// A peer is an SSH remote with `federation` on and a running `maestro-cli host`. Its id is the
// remote's name, or the remote's id when two remotes share that name. A target names a peer's
// agent as `peer:agentId` or `peer:agentName`, split on the FIRST colon, so an agent name with a
// colon in it still reaches the host whole.
//
// The colon is safe as a separator because a local agent ID never contains one: every agent ID
// comes from `generateId()` (`crypto.randomUUID()`) or `generateUUID()`, and both produce only hex
// digits and dashes. A local agent NAME can contain a colon ("Maestro: rc"), so a target that
// still resolves to a local agent stays local, and a target without a colon never reaches this
// module's peer path at all: today's local behavior, byte for byte.
//
// The host is the only source of truth. Its agents are never written to the local agent store, and
// nothing here queues or replays: a peer that is down is an error that names the fix.

import { encoreDisabledMessage } from '../../shared/encoreFeatureDefaults';
import type { MaestroClient } from '../../shared/maestro-lib/client/types';
import { createWsMaestroClient } from '../../shared/maestro-lib/client/ws-client';
import {
	SshForwardError,
	getSshForwardManager,
	type ForwardedHostEndpoint,
	type SshForwardLease,
} from '../../shared/maestro-lib/client/ssh-forward';
import { RemoteDiscoveryError } from '../../shared/maestro-lib/client/remote-discovery';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import { isEncoreEnabled } from '../utils/encore-gate';
import { readSshRemotes, resolveAgentId, resolveSshRemoteId } from './storage';

/** A `peer:agent` target, split on its first colon. */
export interface PeerTarget {
	peer: string;
	/** An agent id, id prefix, or name on the peer's host. */
	agent: string;
}

export type PeerErrorCode =
	/** The Federation Encore Feature is off. */
	| 'encore-off'
	/** No SSH remote by that name or id. */
	| 'unknown-peer'
	/** More than one SSH remote matches the id prefix. */
	| 'ambiguous-peer'
	/** The SSH remote is not opted in to Federation, so Maestro never dials it (decision D8). */
	| 'federation-off'
	/** The remote has no usable `maestro-cli`. */
	| 'not-installed'
	/** The CLI is there, but no host is running. */
	| 'host-down'
	/** The SSH forward could not be opened. */
	| 'forward-failed'
	/** The forward is up, but the host's bridge did not attach. */
	| 'connect-failed'
	/** The host has no such agent, or the name matches more than one. */
	| 'agent-not-found';

/** A failure to reach a peer or its agent. The message names the peer and the fix. */
export class PeerResolveError extends Error {
	readonly code: PeerErrorCode;
	readonly exitCode: ExitCode;
	/** The peer as the caller typed it, when the failure is about one. */
	readonly peer?: string;
	constructor(code: PeerErrorCode, message: string, exitCode: ExitCode, peer?: string) {
		super(message);
		this.name = 'PeerResolveError';
		this.code = code;
		this.exitCode = exitCode;
		this.peer = peer;
	}
}

/** A live connection to a peer's host. `release()` closes the client and drops the forward. */
export interface PeerConnection {
	/** The peer id to show: the remote's name, or its id when the name is shared. */
	peer: string;
	remote: SshRemoteConfig;
	client: MaestroClient;
	/** The forward the client rides. `state()` tells a dropped forward from a stopped host. */
	lease: SshForwardLease;
	/** Safe to call twice. */
	release(): Promise<void>;
}

/** A peer connection plus the host's agent the target named. */
export interface ResolvedPeerAgent extends PeerConnection {
	agent: AgentRecord;
}

/** How a target should be handled. */
export type AgentTargetRoute = { kind: 'local' } | { kind: 'peer'; target: PeerTarget };

/** What the resolver needs from the world, so a test can stand in for it. */
export interface PeerResolverDeps {
	readRemotes(): SshRemoteConfig[];
	resolveRemoteId(ref: string): string;
	isFederationEnabled(): boolean;
	/** Does `target` name a LOCAL agent? Default: `resolveAgentId()` succeeds. */
	isLocalAgent(target: string): boolean;
	acquireForward(remote: SshRemoteConfig): SshForwardLease;
	createClient(endpoint: () => Promise<ForwardedHostEndpoint>): MaestroClient;
}

const defaultDeps: PeerResolverDeps = {
	readRemotes: readSshRemotes,
	resolveRemoteId: resolveSshRemoteId,
	isFederationEnabled: () => isEncoreEnabled('federation'),
	isLocalAgent: (target) => {
		try {
			resolveAgentId(target);
			return true;
		} catch {
			return false;
		}
	},
	acquireForward: (remote) => getSshForwardManager().acquire(remote),
	createClient: (endpoint) => createWsMaestroClient({ endpoint }),
};

function withDefaults(overrides: Partial<PeerResolverDeps>): PeerResolverDeps {
	return { ...defaultDeps, ...overrides };
}

/**
 * Split `peer:agent` on its FIRST colon. Null for a target with no colon, or with nothing on
 * either side of it: those are not peer targets.
 */
export function parsePeerTarget(target: string): PeerTarget | null {
	const at = target.indexOf(':');
	if (at <= 0 || at === target.length - 1) return null;
	return { peer: target.slice(0, at), agent: target.slice(at + 1) };
}

/**
 * Local or peer. A target with no colon is local without reading anything. With the Federation
 * feature off every target is local (zero footprint). A colon target that names a local agent
 * (a name like "Maestro: rc") stays local too.
 */
export function routeAgentTarget(
	target: string,
	overrides: Partial<PeerResolverDeps> = {}
): AgentTargetRoute {
	const parsed = parsePeerTarget(target);
	if (!parsed) return { kind: 'local' };
	const deps = withDefaults(overrides);
	if (!deps.isFederationEnabled()) return { kind: 'local' };
	if (deps.isLocalAgent(target)) return { kind: 'local' };
	return { kind: 'peer', target: parsed };
}

/** The id a peer is shown and addressed by: its name, or its id when another remote shares it. */
export function peerIdFor(remote: SshRemoteConfig, remotes: readonly SshRemoteConfig[]): string {
	const lower = remote.name.toLowerCase();
	const shared = remotes.filter((r) => r.name.toLowerCase() === lower).length > 1;
	return shared ? remote.id : remote.name;
}

/**
 * The SSH remote `ref` names: an exact (case-insensitive) name first, then an id or id prefix,
 * like the other remote verbs.
 */
export function findPeerRemote(
	ref: string,
	overrides: Partial<Pick<PeerResolverDeps, 'readRemotes' | 'resolveRemoteId'>> = {}
): SshRemoteConfig {
	const deps = withDefaults(overrides);
	const remotes = deps.readRemotes();
	const byName = remotes.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
	if (byName.length === 1) return byName[0];
	let id: string;
	try {
		id = deps.resolveRemoteId(ref);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code: PeerErrorCode = message.startsWith('Ambiguous') ? 'ambiguous-peer' : 'unknown-peer';
		throw new PeerResolveError(code, message, ExitCode.InvalidUsage, ref);
	}
	const remote = remotes.find((r) => r.id === id);
	if (!remote) {
		throw new PeerResolveError(
			'unknown-peer',
			`SSH remote not found: ${ref}`,
			ExitCode.InvalidUsage,
			ref
		);
	}
	return remote;
}

/** Refuse a remote that is not opted in: Maestro never dials one (decision D8). */
export function requireFederationRemote(remote: SshRemoteConfig): void {
	if (remote.federation) return;
	throw new PeerResolveError(
		'federation-off',
		`SSH remote "${remote.name}" is not opted in to Federation, so Maestro does not dial it. ` +
			`Turn it on with: maestro-cli update-ssh-remote ${remote.id} --federation on`,
		ExitCode.GeneralError,
		remote.name
	);
}

/** The peer an error names, and the `remote-host start` line that brings its host up. */
function startFix(peer: string): string {
	return `Start it with: maestro-cli remote-host start ${peer}`;
}

/** Turn a forward failure into an error that names the peer and the fix. */
function forwardError(peer: string, error: unknown): PeerResolveError {
	if (error instanceof SshForwardError) {
		switch (error.code) {
			case 'not-installed':
				return new PeerResolveError(
					'not-installed',
					`Peer "${peer}" has no usable maestro-cli. ${error.message}`,
					ExitCode.NotRunning,
					peer
				);
			case 'not-running':
			case 'host-gone':
				return new PeerResolveError(
					'host-down',
					`No Maestro host is running on peer "${peer}". ${startFix(peer)}`,
					ExitCode.NotRunning,
					peer
				);
			case 'forward-failed':
				return new PeerResolveError(
					'forward-failed',
					`Could not open the SSH forward to peer "${peer}": ${error.message} ` +
						`Check it with: maestro-cli remote-host status ${peer}`,
					ExitCode.NotRunning,
					peer
				);
		}
	}
	if (error instanceof RemoteDiscoveryError) {
		return new PeerResolveError(
			'forward-failed',
			`Could not reach peer "${peer}" over SSH: ${error.message} ` +
				`Check it with: maestro-cli remote-host status ${peer}`,
			error.code === 'timeout' ? ExitCode.Timeout : ExitCode.NotRunning,
			peer
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new PeerResolveError(
		'forward-failed',
		`Could not reach peer "${peer}": ${message} Check it with: maestro-cli remote-host status ${peer}`,
		ExitCode.NotRunning,
		peer
	);
}

/**
 * Open a connection to the host behind `peerRef` (a remote name, id, or id prefix): check the
 * Encore Feature and the remote's opt-in, open the forward through the shared SSH forward manager,
 * and attach a client to it. The caller must `release()` the result.
 */
export async function connectPeer(
	peerRef: string,
	overrides: Partial<PeerResolverDeps> = {}
): Promise<PeerConnection> {
	const deps = withDefaults(overrides);
	if (!deps.isFederationEnabled()) {
		throw new PeerResolveError(
			'encore-off',
			encoreDisabledMessage('federation'),
			ExitCode.GeneralError,
			peerRef
		);
	}
	const remote = findPeerRemote(peerRef, deps);
	requireFederationRemote(remote);
	const peer = peerIdFor(remote, deps.readRemotes());

	const lease = deps.acquireForward(remote);
	let client: MaestroClient | undefined;
	let released = false;
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		try {
			await client?.connection.close();
		} finally {
			await lease.release();
		}
	};

	try {
		try {
			await lease.ready();
		} catch (error) {
			throw forwardError(peer, error);
		}
		client = deps.createClient(() => lease.ready());
		const attached = await client.connection.connect();
		if (!attached.ok) {
			throw new PeerResolveError(
				'connect-failed',
				`The host on peer "${peer}" did not accept the connection: ${attached.error.message} ` +
					`Check it with: maestro-cli remote-host status ${peer}`,
				attached.error.code === 'timeout' ? ExitCode.Timeout : ExitCode.NotRunning,
				peer
			);
		}
	} catch (error) {
		await release();
		throw error;
	}
	return { peer, remote, client, lease, release };
}

/**
 * Resolve a `peer:agent` target to a connected client plus the host's agent. The agent part
 * matches the way a local one does (`resolveAgentId()`): id, id prefix, exact name, readable name.
 * The caller must `release()` the result.
 */
export async function resolvePeerAgent(
	target: string | PeerTarget,
	overrides: Partial<PeerResolverDeps> = {}
): Promise<ResolvedPeerAgent> {
	const parsed = typeof target === 'string' ? parsePeerTarget(target) : target;
	if (!parsed) {
		throw new PeerResolveError(
			'agent-not-found',
			`Not a peer target: ${String(target)}. Use peer:agent, for example build-box:my-agent`,
			ExitCode.InvalidUsage
		);
	}
	const connection = await connectPeer(parsed.peer, overrides);
	try {
		const listed = await connection.client.agents.list();
		if (!listed.ok) {
			throw new PeerResolveError(
				'connect-failed',
				`Could not list the agents on peer "${connection.peer}": ${listed.error.message}`,
				listed.error.code === 'timeout' ? ExitCode.Timeout : ExitCode.NotRunning,
				connection.peer
			);
		}
		let agentId: string;
		try {
			agentId = resolveAgentId(parsed.agent, listed.value);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PeerResolveError(
				'agent-not-found',
				`${message} (on peer "${connection.peer}"). ` +
					`List its agents with: maestro-cli list agents --peer ${connection.peer}`,
				ExitCode.GeneralError,
				connection.peer
			);
		}
		const agent = listed.value.find((record) => record.id === agentId) as AgentRecord;
		return { ...connection, agent };
	} catch (error) {
		await connection.release();
		throw error;
	}
}
