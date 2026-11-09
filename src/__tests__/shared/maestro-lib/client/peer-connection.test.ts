/**
 * Tests for the shared peer connection core: which remotes are peers, the errors that name the
 * peer and the fix, and opening a client over the forward.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	PeerConnectError,
	connectPeerClient,
	federationPeersOf,
	peerForwardError,
	peerIdFor,
	watchPeerConnection,
} from '../../../../shared/maestro-lib/client/peer-connection';
import { RemoteDiscoveryError } from '../../../../shared/maestro-lib/client/remote-discovery';
import {
	SshForwardError,
	type SshForwardLease,
	type SshForwardState,
} from '../../../../shared/maestro-lib/client/ssh-forward';
import type {
	ClientResult,
	MaestroClient,
	MaestroEvent,
} from '../../../../shared/maestro-lib/client/types';
import type { SshRemoteConfig } from '../../../../shared/types';

const remoteOf = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'r1-abcdef',
	name: 'buildbox',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
	...overrides,
});

const ENDPOINT = { port: 50123, remotePort: 41234, token: 't', cliSecret: 's', pid: 1 };

function fakeLease(ready = async () => ENDPOINT) {
	const listeners = new Set<(state: SshForwardState) => void>();
	const lease = {
		remoteId: 'r1-abcdef',
		state: () => ({ status: 'up', endpoint: ENDPOINT }) as SshForwardState,
		ready: vi.fn(ready),
		onChange: (listener: (state: SshForwardState) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		restart: vi.fn(),
		release: vi.fn(async () => undefined),
	};
	return {
		lease: lease as unknown as SshForwardLease & { release: ReturnType<typeof vi.fn> },
		emit: (state: SshForwardState) => listeners.forEach((l) => l(state)),
	};
}

function fakeClient(connect: ClientResult<unknown> = { ok: true, value: {} }) {
	const listeners = new Set<(event: MaestroEvent) => void>();
	const close = vi.fn(async () => undefined);
	const client = {
		connection: { connect: vi.fn(async () => connect), close },
		events: {
			subscribe: (listener: (event: MaestroEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	} as unknown as MaestroClient;
	return { client, close, emit: (event: MaestroEvent) => listeners.forEach((l) => l(event)) };
}

describe('federationPeersOf and peerIdFor', () => {
	it('keeps opted-in, enabled remotes in stored order', () => {
		const remotes = [
			remoteOf({ id: 'a', name: 'one' }),
			remoteOf({ id: 'b', name: 'two', federation: false }),
			remoteOf({ id: 'c', name: 'three', enabled: false }),
			remoteOf({ id: 'd', name: 'four' }),
		];
		expect(federationPeersOf(remotes).map((p) => p.peer)).toEqual(['one', 'four']);
	});

	it('uses the remote id when two remotes share a name', () => {
		const remotes = [remoteOf({ id: 'a', name: 'Box' }), remoteOf({ id: 'b', name: 'box' })];
		expect(peerIdFor(remotes[0], remotes)).toBe('a');
		expect(peerIdFor(remoteOf(), [remoteOf()])).toBe('buildbox');
	});
});

describe('peerForwardError', () => {
	it('maps each forward failure to a code and a fix line', () => {
		const notInstalled = peerForwardError(
			'box',
			new SshForwardError('not-installed', 'Install it.')
		);
		expect(notInstalled.code).toBe('not-installed');
		const down = peerForwardError('box', new SshForwardError('not-running', 'x'));
		expect(down.code).toBe('host-down');
		expect(down.message).toContain('maestro-cli remote-host start box');
		const failed = peerForwardError('box', new SshForwardError('forward-failed', 'ssh exited.'));
		expect(failed.code).toBe('forward-failed');
		expect(failed.message).toContain('maestro-cli remote-host status box');
	});

	it('marks a discovery timeout as a timeout, and passes a PeerConnectError through', () => {
		const timedOut = peerForwardError('box', new RemoteDiscoveryError('timeout', 'slow'));
		expect(timedOut.timeout).toBe(true);
		const original = new PeerConnectError('host-down', 'down', 'box');
		expect(peerForwardError('box', original)).toBe(original);
	});
});

describe('connectPeerClient', () => {
	it('attaches a client over the forward', async () => {
		const { lease } = fakeLease();
		const { client } = fakeClient();
		const opened = await connectPeerClient('box', remoteOf(), {
			acquireForward: () => lease,
			createClient: () => client,
		});
		expect(opened.client).toBe(client);
		await opened.release();
		await opened.release();
		expect(lease.release).toHaveBeenCalledTimes(1);
	});

	it('releases the forward and throws a typed error when the forward fails', async () => {
		const { lease } = fakeLease(async () => {
			throw new SshForwardError('not-running', 'no host');
		});
		const createClient = vi.fn();
		await expect(
			connectPeerClient('box', remoteOf(), { acquireForward: () => lease, createClient })
		).rejects.toMatchObject({ code: 'host-down', peer: 'box' });
		expect(createClient).not.toHaveBeenCalled();
		expect(lease.release).toHaveBeenCalledTimes(1);
	});

	it('closes the client and releases the forward when the host does not attach', async () => {
		const { lease } = fakeLease();
		const { client, close } = fakeClient({
			ok: false,
			error: { code: 'timeout', message: 'no answer', method: 'connection.connect' },
		} as ClientResult<unknown>);
		await expect(
			connectPeerClient('box', remoteOf(), {
				acquireForward: () => lease,
				createClient: () => client,
			})
		).rejects.toMatchObject({ code: 'connect-failed', timeout: true });
		expect(close).toHaveBeenCalledTimes(1);
		expect(lease.release).toHaveBeenCalledTimes(1);
	});
});

describe('watchPeerConnection', () => {
	it('fires once, for a lost host or a forward that went down', () => {
		const { lease, emit: emitLease } = fakeLease();
		const { client, emit } = fakeClient();
		const onLost = vi.fn();
		const off = watchPeerConnection({ client, lease }, onLost);
		emit({ type: 'host.lost', reason: 'gone' });
		emitLease({ status: 'stopped' });
		expect(onLost).toHaveBeenCalledTimes(1);
		expect(onLost).toHaveBeenCalledWith('gone');
		off();
	});
});
