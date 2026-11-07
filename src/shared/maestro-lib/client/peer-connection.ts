// A connection to a Federation peer's host (Federation over SSH, #1716), shared by maestro-cli's
// `peer:agent` verbs and the desktop's peer mirror.
//
// A peer is an SSH remote with `federation` on and a running `maestro-cli host`. This module owns
// the parts both callers need byte for byte: which remotes are peers and the id each is shown by,
// opening the SSH forward and attaching a client to it, the errors that name the peer and the fix,
// and the watch that tells a caller the connection dropped. The CLI adds its own Encore and
// opt-in checks and maps the error codes to exit codes (`src/cli/services/peer-resolver.ts`).
//
// Nothing here reads a store, dials a remote that was not handed in, or retries.

import type { SshRemoteConfig } from '../../types';
import { RemoteDiscoveryError } from './remote-discovery';
import { SshForwardError, type ForwardedHostEndpoint, type SshForwardLease } from './ssh-forward';
import type { MaestroClient } from './types';

/** Why a connection to a peer's host could not be opened. */
export type PeerConnectErrorCode =
	/** The remote has no usable `maestro-cli`. */
	| 'not-installed'
	/** The CLI is there, but no host is running. */
	| 'host-down'
	/** The SSH forward could not be opened. */
	| 'forward-failed'
	/** The forward is up, but the host's bridge did not attach. */
	| 'connect-failed';

/** A failure to reach a peer's host. The message names the peer and the fix. */
export class PeerConnectError extends Error {
	readonly code: PeerConnectErrorCode;
	readonly peer: string;
	/** The attempt timed out, as opposed to being refused. */
	readonly timeout: boolean;
	constructor(code: PeerConnectErrorCode, message: string, peer: string, timeout = false) {
		super(message);
		this.name = 'PeerConnectError';
		this.code = code;
		this.peer = peer;
		this.timeout = timeout;
	}
}

/** The id a peer is shown and addressed by: its name, or its id when another remote shares it. */
export function peerIdFor(remote: SshRemoteConfig, remotes: readonly SshRemoteConfig[]): string {
	const lower = remote.name.toLowerCase();
	const shared = remotes.filter((r) => r.name.toLowerCase() === lower).length > 1;
	return shared ? remote.id : remote.name;
}

/** A remote that is a Federation peer, with the id it is shown and addressed by. */
export interface FederationPeer {
	peer: string;
	remote: SshRemoteConfig;
}

/**
 * Every SSH remote that is opted in to Federation and not disabled, in stored order, with its
 * peer id. Pure: nothing here dials a remote (decision D8).
 */
export function federationPeersOf(remotes: readonly SshRemoteConfig[]): FederationPeer[] {
	return remotes
		.filter((remote) => remote.federation === true && remote.enabled !== false)
		.map((remote) => ({ peer: peerIdFor(remote, remotes), remote }));
}

/** Why a remote that is not opted in is never dialed (decision D8), with the fix. */
export function federationOffMessage(remote: Pick<SshRemoteConfig, 'id' | 'name'>): string {
	return (
		`SSH remote "${remote.name}" is not opted in to Federation, so Maestro does not dial it. ` +
		`Turn it on with: maestro-cli update-ssh-remote ${remote.id} --federation on`
	);
}

/** The `remote-host status` line that diagnoses a peer. */
export function peerStatusFix(peer: string): string {
	return `Check it with: maestro-cli remote-host status ${peer}`;
}

/** The `remote-host start` line that brings a peer's host up. */
export function peerStartFix(peer: string): string {
	return `Start it with: maestro-cli remote-host start ${peer}`;
}

/** Turn a forward failure into an error that names the peer and the fix. */
export function peerForwardError(peer: string, error: unknown): PeerConnectError {
	if (error instanceof PeerConnectError) return error;
	if (error instanceof SshForwardError) {
		switch (error.code) {
			case 'not-installed':
				return new PeerConnectError(
					'not-installed',
					`Peer "${peer}" has no usable maestro-cli. ${error.message}`,
					peer
				);
			case 'not-running':
			case 'host-gone':
				return new PeerConnectError(
					'host-down',
					`No Maestro host is running on peer "${peer}". ${peerStartFix(peer)}`,
					peer
				);
			case 'forward-failed':
				return new PeerConnectError(
					'forward-failed',
					`Could not open the SSH forward to peer "${peer}": ${error.message} ${peerStatusFix(peer)}`,
					peer
				);
		}
	}
	if (error instanceof RemoteDiscoveryError) {
		return new PeerConnectError(
			'forward-failed',
			`Could not reach peer "${peer}" over SSH: ${error.message} ${peerStatusFix(peer)}`,
			peer,
			error.code === 'timeout'
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new PeerConnectError(
		'forward-failed',
		`Could not reach peer "${peer}": ${message} ${peerStatusFix(peer)}`,
		peer
	);
}

/** The host's bridge did not attach. */
export function peerAttachError(peer: string, message: string, timeout = false): PeerConnectError {
	return new PeerConnectError(
		'connect-failed',
		`The host on peer "${peer}" did not accept the connection: ${message} ${peerStatusFix(peer)}`,
		peer,
		timeout
	);
}

/** What opening a peer client needs from the world, so a test can stand in for it. */
export interface PeerClientDeps {
	acquireForward(remote: SshRemoteConfig): SshForwardLease;
	createClient(endpoint: () => Promise<ForwardedHostEndpoint>): MaestroClient;
}

/** A client attached to a peer's host, over the forward it rides. */
export interface PeerClient {
	client: MaestroClient;
	/** The forward the client rides. `state()` tells a dropped forward from a stopped host. */
	lease: SshForwardLease;
	/** Close the client and drop the forward. Safe to call twice. */
	release(): Promise<void>;
}

/**
 * Open the SSH forward to `remote` and attach a client to the host behind it. Checks nothing about
 * opt-in: the caller decides which remotes it may dial. On failure the forward is released and a
 * `PeerConnectError` is thrown; on success the caller must `release()` the result.
 */
export async function connectPeerClient(
	peer: string,
	remote: SshRemoteConfig,
	deps: PeerClientDeps
): Promise<PeerClient> {
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
			throw peerForwardError(peer, error);
		}
		client = deps.createClient(() => lease.ready());
		const attached = await client.connection.connect();
		if (!attached.ok) {
			throw peerAttachError(peer, attached.error.message, attached.error.code === 'timeout');
		}
	} catch (error) {
		await release();
		throw error;
	}
	return { client, lease, release };
}

/**
 * Call `onLost` once when the connection to the peer drops: the client loses the host, or the SSH
 * forward goes down or stops. Nothing here reconnects or retries. Returns the unsubscribe.
 */
export function watchPeerConnection(
	connection: Pick<PeerClient, 'client' | 'lease'>,
	onLost: (reason: string) => void
): () => void {
	let fired = false;
	const fire = (reason: string): void => {
		if (fired) return;
		fired = true;
		onLost(reason);
	};
	const offHost = connection.client.events.subscribe(
		(event) => {
			if (event.type === 'host.lost') fire(event.reason);
		},
		{ types: ['host.lost'] }
	);
	const offLease = connection.lease.onChange((state) => {
		if (state.status === 'down') fire(state.error.message);
		else if (state.status === 'stopped') fire('The SSH forward stopped.');
	});
	return () => {
		offHost();
		offLease();
	};
}
