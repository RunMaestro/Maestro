/**
 * Tests for the `peer:agent` resolver: parse rules, local routing, and the errors that name the
 * peer and the fix. The SSH forward and the host client are stood in for.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(() => []),
	resolveSshRemoteId: vi.fn((id: string) => id),
	// The real matcher, so the agent part resolves the way a local target does.
	resolveAgentId: (ref: string, list: Array<{ id: string; name: string }>) => {
		const exact = list.find((a) => a.id === ref);
		if (exact) return exact.id;
		const prefix = list.filter((a) => a.id.startsWith(ref));
		if (prefix.length === 1) return prefix[0].id;
		const byName = list.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
		if (byName.length === 1) return byName[0].id;
		throw new Error(`Agent not found: ${ref}`);
	},
}));

import { ExitCode } from '../../../cli/exit-codes';
import {
	PeerResolveError,
	clientErrorExitCode,
	connectPeer,
	findPeerRemote,
	hostCallError,
	listFederationPeers,
	listHostAgents,
	parsePeerTarget,
	peerAgentRef,
	peerErrorCode,
	peerIdFor,
	resolvePeerAgent,
	routeAgentTarget,
	watchPeerConnection,
	withPeerAgent,
	type PeerResolverDeps,
} from '../../../cli/services/peer-resolver';
import type { BridgeConnection } from '../../../shared/maestro-lib/client/bridge-connection';
import { RemoteDiscoveryError } from '../../../shared/maestro-lib/client/remote-discovery';
import type { SshForwardState } from '../../../shared/maestro-lib/client/ssh-forward';
import type { MaestroEvent } from '../../../shared/maestro-lib/client/types';
import { generateUUID } from '../../../shared/uuid';
import {
	SshForwardError,
	type SshForwardLease,
} from '../../../shared/maestro-lib/client/ssh-forward';
import type { ClientResult, MaestroClient } from '../../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

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

const ENDPOINT = {
	port: 50123,
	remotePort: 41234,
	token: 'tok-path-token',
	cliSecret: 'cli-secret',
	pid: 812,
};

const agents: AgentRecord[] = [
	{ id: 'a1111111-0000-4000-8000-000000000001', name: 'Maestro: rc', toolType: 'claude-code' },
	{ id: 'b2222222-0000-4000-8000-000000000002', name: 'docs', toolType: 'codex' },
];

function fakeLease(ready: () => Promise<typeof ENDPOINT>): SshForwardLease & {
	release: ReturnType<typeof vi.fn>;
} {
	return {
		remoteId: 'r1-abcdef',
		state: () => ({ status: 'up', endpoint: ENDPOINT }),
		ready,
		onChange: () => () => undefined,
		restart: () => undefined,
		release: vi.fn(async () => undefined),
	};
}

function fakeClient(
	connect: ClientResult<unknown> = { ok: true, value: {} },
	list: ClientResult<AgentRecord[]> = { ok: true, value: agents }
) {
	const close = vi.fn(async () => undefined);
	const client = {
		connection: { connect: vi.fn(async () => connect), close },
		agents: { list: vi.fn(async () => list) },
	} as unknown as MaestroClient;
	return { client, close };
}

function depsWith(
	overrides: Partial<PeerResolverDeps> & { remotes?: SshRemoteConfig[] } = {}
): PeerResolverDeps & { lease: ReturnType<typeof fakeLease>; close: ReturnType<typeof vi.fn> } {
	const remotes = overrides.remotes ?? [remoteOf()];
	const lease = fakeLease(async () => ENDPOINT);
	const { client, close } = fakeClient();
	return {
		readRemotes: () => remotes,
		resolveRemoteId: (ref: string) => {
			const hits = remotes.filter((r) => r.id.startsWith(ref));
			if (hits.length > 1) throw new Error(`Ambiguous SSH remote ID '${ref}'.`);
			if (!hits.length) throw new Error(`SSH remote not found: ${ref}`);
			return hits[0].id;
		},
		isFederationEnabled: () => true,
		isLocalAgent: () => false,
		acquireForward: vi.fn(() => lease),
		createClient: vi.fn(() => client),
		createBridge: vi.fn(
			() =>
				({
					connect: vi.fn(async () => undefined),
					sendCommand: vi.fn(),
					disconnect: vi.fn(),
				}) as unknown as BridgeConnection
		),
		lease,
		close,
		...overrides,
	};
}

async function rejection(promise: Promise<unknown>): Promise<PeerResolveError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PeerResolveError);
		return error as PeerResolveError;
	}
	throw new Error('expected a rejection');
}

describe('parsePeerTarget', () => {
	it('splits on the FIRST colon, so an agent name with a colon reaches the host whole', () => {
		expect(parsePeerTarget('buildbox:Maestro: rc')).toEqual({
			peer: 'buildbox',
			agent: 'Maestro: rc',
		});
		expect(parsePeerTarget('buildbox:a1111111')).toEqual({ peer: 'buildbox', agent: 'a1111111' });
	});

	it('is not a peer target without a colon, or with an empty side', () => {
		expect(parsePeerTarget('a1111111')).toBeNull();
		expect(parsePeerTarget(':agent')).toBeNull();
		expect(parsePeerTarget('peer:')).toBeNull();
	});

	it('relies on local agent ids never holding a colon', () => {
		for (let i = 0; i < 200; i++) expect(generateUUID()).toMatch(/^[0-9a-f-]+$/);
	});
});

describe('routeAgentTarget', () => {
	it('keeps a target without a colon local and reads nothing', () => {
		const isFederationEnabled = vi.fn(() => true);
		const isLocalAgent = vi.fn(() => false);
		expect(routeAgentTarget('a1111111', { isFederationEnabled, isLocalAgent })).toEqual({
			kind: 'local',
		});
		expect(isFederationEnabled).not.toHaveBeenCalled();
		expect(isLocalAgent).not.toHaveBeenCalled();
	});

	it('keeps every target local while the Encore Feature is off', () => {
		expect(
			routeAgentTarget('buildbox:docs', {
				isFederationEnabled: () => false,
				isLocalAgent: () => false,
			})
		).toEqual({ kind: 'local' });
	});

	it('keeps a colon target that names a local agent local', () => {
		expect(
			routeAgentTarget('Maestro: rc', { isFederationEnabled: () => true, isLocalAgent: () => true })
		).toEqual({ kind: 'local' });
	});

	it('routes a colon target that is not a local agent to the peer', () => {
		expect(
			routeAgentTarget('buildbox:docs', {
				isFederationEnabled: () => true,
				isLocalAgent: () => false,
			})
		).toEqual({ kind: 'peer', target: { peer: 'buildbox', agent: 'docs' } });
	});
});

describe('peer ids', () => {
	it('uses the remote name, or the id when two remotes share the name', () => {
		const a = remoteOf();
		const b = remoteOf({ id: 'r2-123456', name: 'BuildBox' });
		const c = remoteOf({ id: 'r3-999999', name: 'gpu' });
		expect(peerIdFor(c, [a, b, c])).toBe('gpu');
		expect(peerIdFor(a, [a, b, c])).toBe('r1-abcdef');
	});

	it('finds a remote by exact name, then by id prefix', () => {
		const deps = depsWith({ remotes: [remoteOf(), remoteOf({ id: 'r2-123456', name: 'gpu' })] });
		expect(findPeerRemote('GPU', deps).id).toBe('r2-123456');
		expect(findPeerRemote('r1', deps).name).toBe('buildbox');
	});
});

describe('listFederationPeers', () => {
	it('lists opted-in, enabled remotes in stored order with their peer ids, and dials nothing', () => {
		const shared = remoteOf({ id: 'r2-123456', name: 'BUILDBOX' });
		const remotes = [
			remoteOf(),
			remoteOf({ id: 'r3-999999', name: 'gpu', federation: false }),
			remoteOf({ id: 'r4-444444', name: 'off', enabled: false }),
			remoteOf({ id: 'r5-555555', name: 'plain', federation: undefined }),
			shared,
		];
		expect(listFederationPeers({ readRemotes: () => remotes })).toEqual([
			{ peer: 'r1-abcdef', remote: remotes[0] },
			{ peer: 'r2-123456', remote: shared },
		]);
	});
});

describe('listHostAgents', () => {
	it("returns the host's agents, and names the peer when the read fails", async () => {
		const connection = await connectPeer('buildbox', depsWith());
		expect(await listHostAgents(connection)).toEqual(agents);

		const { client } = fakeClient(undefined, {
			ok: false,
			error: { code: 'timeout', message: 'No reply.', method: 'agents.list' },
		});
		const failing = await connectPeer('buildbox', depsWith({ createClient: vi.fn(() => client) }));
		const error = await rejection(listHostAgents(failing));
		expect(error.code).toBe('connect-failed');
		expect(error.exitCode).toBe(ExitCode.Timeout);
		expect(error.message).toContain('peer "buildbox"');
	});
});

describe('resolvePeerAgent', () => {
	it('opens the forward, attaches a client, and finds the agent by name or id prefix', async () => {
		const deps = depsWith();
		const byName = await resolvePeerAgent('buildbox:docs', deps);
		expect(byName.peer).toBe('buildbox');
		expect(byName.agent.id).toBe('b2222222-0000-4000-8000-000000000002');
		expect(deps.acquireForward).toHaveBeenCalledWith(remoteOf());
		await byName.release();
		await byName.release();
		expect(deps.close).toHaveBeenCalledTimes(1);
		expect(deps.lease.release).toHaveBeenCalledTimes(1);

		const byId = await resolvePeerAgent('buildbox:a1111111', depsWith());
		expect(byId.agent.name).toBe('Maestro: rc');
	});

	it('names the peer and the list command when the host has no such agent', async () => {
		const deps = depsWith();
		const error = await rejection(resolvePeerAgent('buildbox:nope', deps));
		expect(error.code).toBe('agent-not-found');
		expect(error.message).toContain('peer "buildbox"');
		expect(error.message).toContain('maestro-cli list agents --peer buildbox');
		expect(deps.lease.release).toHaveBeenCalled();
		expect(deps.close).toHaveBeenCalled();
	});

	it('refuses an unknown peer without dialing', async () => {
		const deps = depsWith();
		const error = await rejection(resolvePeerAgent('elsewhere:docs', deps));
		expect(error.code).toBe('unknown-peer');
		expect(error.exitCode).toBe(ExitCode.InvalidUsage);
		expect(deps.acquireForward).not.toHaveBeenCalled();
	});

	it('refuses a remote that is not opted in to Federation and names the fix', async () => {
		const deps = depsWith({ remotes: [remoteOf({ federation: undefined })] });
		const error = await rejection(resolvePeerAgent('buildbox:docs', deps));
		expect(error.code).toBe('federation-off');
		expect(error.message).toContain('maestro-cli update-ssh-remote r1-abcdef --federation on');
		expect(deps.acquireForward).not.toHaveBeenCalled();
	});

	it('refuses while the Encore Feature is off', async () => {
		const deps = depsWith({ isFederationEnabled: () => false });
		const error = await rejection(connectPeer('buildbox', deps));
		expect(error.code).toBe('encore-off');
		expect(deps.acquireForward).not.toHaveBeenCalled();
	});

	it('names `remote-host start <peer>` when the host is down, and drops the forward', async () => {
		const lease = fakeLease(async () => {
			throw new SshForwardError('not-running', 'No host serves the data directory.');
		});
		const deps = depsWith({ acquireForward: vi.fn(() => lease) });
		const error = await rejection(resolvePeerAgent('buildbox:docs', deps));
		expect(error.code).toBe('host-down');
		expect(error.exitCode).toBe(ExitCode.NotRunning);
		expect(error.message).toContain('maestro-cli remote-host start buildbox');
		expect(lease.release).toHaveBeenCalled();
		expect(deps.createClient).not.toHaveBeenCalled();
	});

	it('reports a bridge that refuses the connection, and drops the forward', async () => {
		const { client, close } = fakeClient({
			ok: false,
			error: {
				code: 'unauthorized',
				message: 'The host refused this client.',
				method: 'connection.connect',
			},
		});
		const deps = depsWith({ createClient: vi.fn(() => client) });
		const error = await rejection(connectPeer('buildbox', deps));
		expect(error.code).toBe('connect-failed');
		expect(error.message).toContain('maestro-cli remote-host status buildbox');
		expect(close).toHaveBeenCalled();
		expect(deps.lease.release).toHaveBeenCalled();
	});

	it('refuses a string that is not a peer target, before reading any remote', async () => {
		const readRemotes = vi.fn(() => [remoteOf()]);
		const error = await rejection(resolvePeerAgent('a1111111', depsWith({ readRemotes })));
		expect(error.exitCode).toBe(ExitCode.InvalidUsage);
		expect(error.message).toContain('Not a peer target: a1111111');
		expect(readRemotes).not.toHaveBeenCalled();
	});

	it('refuses an ambiguous id prefix without dialing', async () => {
		const deps = depsWith({
			remotes: [remoteOf(), remoteOf({ id: 'r1-zzzzzz', name: 'other' })],
		});
		const error = await rejection(resolvePeerAgent('r1:docs', deps));
		expect(error.code).toBe('ambiguous-peer');
		expect(error.exitCode).toBe(ExitCode.InvalidUsage);
		expect(error.peer).toBe('r1');
		expect(deps.acquireForward).not.toHaveBeenCalled();
	});

	it('addresses a peer that shares its name by remote id, in errors too', async () => {
		const lease = fakeLease(async () => {
			throw new SshForwardError('host-gone', 'The host exited.');
		});
		const deps = depsWith({
			remotes: [remoteOf(), remoteOf({ id: 'r2-123456', name: 'BuildBox' })],
			acquireForward: vi.fn(() => lease),
		});
		const error = await rejection(resolvePeerAgent('r2:docs', deps));
		expect(error.code).toBe('host-down');
		expect(error.peer).toBe('r2-123456');
		expect(error.message).toContain('maestro-cli remote-host start r2-123456');
	});

	it.each([
		{
			label: 'a remote without maestro-cli',
			thrown: new SshForwardError('not-installed', 'maestro-cli is not on PATH.'),
			code: 'not-installed',
			exitCode: ExitCode.NotRunning,
			says: 'Peer "buildbox" has no usable maestro-cli. maestro-cli is not on PATH.',
		},
		{
			label: 'a forward ssh could not open',
			thrown: new SshForwardError('forward-failed', 'bind: Address already in use.'),
			code: 'forward-failed',
			exitCode: ExitCode.NotRunning,
			says: 'maestro-cli remote-host status buildbox',
		},
		{
			label: 'a discovery that timed out',
			thrown: new RemoteDiscoveryError('timeout', 'No answer in 15s.'),
			code: 'forward-failed',
			exitCode: ExitCode.Timeout,
			says: 'Could not reach peer "buildbox" over SSH: No answer in 15s.',
		},
		{
			label: 'an ssh that failed',
			thrown: new RemoteDiscoveryError('ssh-failed', 'Permission denied (publickey).'),
			code: 'forward-failed',
			exitCode: ExitCode.NotRunning,
			says: 'Permission denied (publickey).',
		},
		{
			label: 'an unexpected failure',
			thrown: new Error('spawn ssh ENOENT'),
			code: 'forward-failed',
			exitCode: ExitCode.NotRunning,
			says: 'Could not reach peer "buildbox": spawn ssh ENOENT',
		},
	])('names the peer and the fix for $label, and drops the forward', async (row) => {
		const lease = fakeLease(async () => {
			throw row.thrown;
		});
		const deps = depsWith({ acquireForward: vi.fn(() => lease) });
		const error = await rejection(resolvePeerAgent('buildbox:docs', deps));
		expect(error.code).toBe(row.code);
		expect(error.exitCode).toBe(row.exitCode);
		expect(error.peer).toBe('buildbox');
		expect(error.message).toContain(row.says);
		expect(lease.release).toHaveBeenCalledTimes(1);
		expect(deps.createClient).not.toHaveBeenCalled();
	});
});

describe('withBridge', () => {
	function fakeBridge(connect: () => Promise<void> = async () => undefined) {
		return {
			connect: vi.fn(connect),
			sendCommand: vi.fn(async () => ({ type: 'command_result', success: true })),
			disconnect: vi.fn(),
		};
	}

	it("dials a raw bridge on the forward's local end and always closes it", async () => {
		const bridge = fakeBridge();
		const deps = depsWith({ createBridge: vi.fn(() => bridge as unknown as BridgeConnection) });
		const connection = await connectPeer('buildbox', deps);

		const reply = await connection.withBridge((b) => b.sendCommand({ type: 'ping' }, 'pong'));

		expect(deps.createBridge).toHaveBeenCalledWith(ENDPOINT);
		expect(reply).toMatchObject({ success: true });
		expect(bridge.disconnect).toHaveBeenCalledTimes(1);
		await expect(
			connection.withBridge(async () => Promise.reject(new Error('boom')))
		).rejects.toThrow('boom');
		expect(bridge.disconnect).toHaveBeenCalledTimes(2);
	});

	it('reports a bridge that will not attach as connect-failed, naming the peer', async () => {
		const bridge = fakeBridge(async () => {
			throw new Error('ECONNREFUSED');
		});
		const deps = depsWith({ createBridge: vi.fn(() => bridge as unknown as BridgeConnection) });
		const connection = await connectPeer('buildbox', deps);
		const action = vi.fn();

		const error = await rejection(connection.withBridge(action));

		expect(error.code).toBe('connect-failed');
		expect(error.exitCode).toBe(ExitCode.NotRunning);
		expect(error.message).toContain('maestro-cli remote-host status buildbox');
		expect(action).not.toHaveBeenCalled();
		expect(bridge.disconnect).toHaveBeenCalled();
	});
});

describe('withPeerAgent', () => {
	it('runs the action on the resolved agent and releases the connection after', async () => {
		const deps = depsWith();
		const seen = await withPeerAgent(
			'buildbox:docs',
			async ({ agent, peer }) => `${peer}/${agent.id}`,
			deps
		);
		expect(seen).toBe('buildbox/b2222222-0000-4000-8000-000000000002');
		expect(deps.close).toHaveBeenCalled();
		expect(deps.lease.release).toHaveBeenCalled();
	});

	it('releases when the action throws', async () => {
		const deps = depsWith();
		await expect(
			withPeerAgent('buildbox:docs', async () => Promise.reject(new Error('nope')), deps)
		).rejects.toThrow('nope');
		expect(deps.lease.release).toHaveBeenCalled();
	});
});

describe('peer error helpers', () => {
	it('prefixes resolver codes with PEER_ and addresses agents as peer:agent', () => {
		expect(peerErrorCode('host-down')).toBe('PEER_HOST_DOWN');
		expect(peerErrorCode('connection-lost')).toBe('PEER_CONNECTION_LOST');
		expect(peerAgentRef('buildbox', 'a1')).toBe('buildbox:a1');
	});

	it('maps a host call failure to an exit code and a peer-named error', () => {
		expect(clientErrorExitCode({ code: 'host-lost' })).toBe(ExitCode.NotRunning);
		expect(clientErrorExitCode({ code: 'timeout' })).toBe(ExitCode.Timeout);
		expect(clientErrorExitCode({ code: 'unsupported' })).toBe(ExitCode.Unsupported);
		expect(clientErrorExitCode({ code: 'rejected' })).toBe(ExitCode.GeneralError);

		const lost = hostCallError('buildbox', { code: 'host-lost', message: 'Dropped.' });
		expect(lost.code).toBe('connection-lost');
		expect(lost.message).toContain('maestro-cli remote-host status buildbox');
		const refused = hostCallError('buildbox', { code: 'rejected', message: 'Busy.' });
		expect(refused.code).toBe('host-failed');
		expect(refused.message).toBe('Peer "buildbox": Busy.');
	});
});

describe('watchPeerConnection', () => {
	function watched() {
		let hostListener: (event: MaestroEvent) => void = () => undefined;
		let leaseListener: (state: SshForwardState) => void = () => undefined;
		const offHost = vi.fn();
		const offLease = vi.fn();
		const connection = {
			client: {
				events: {
					subscribe: vi.fn((listener: (event: MaestroEvent) => void) => {
						hostListener = listener;
						return offHost;
					}),
				},
			},
			lease: {
				onChange: vi.fn((listener: (state: SshForwardState) => void) => {
					leaseListener = listener;
					return offLease;
				}),
			},
		} as unknown as Parameters<typeof watchPeerConnection>[0];
		const onLost = vi.fn();
		const stop = watchPeerConnection(connection, onLost);
		return {
			hostListener: () => hostListener,
			leaseListener: () => leaseListener,
			onLost,
			stop,
			offHost,
			offLease,
		};
	}

	it('fires once, on the client losing the host or the forward going down', () => {
		const w = watched();
		w.leaseListener()({ status: 'up', endpoint: ENDPOINT });
		expect(w.onLost).not.toHaveBeenCalled();
		w.hostListener()({ type: 'host.lost', reason: 'socket closed' });
		w.leaseListener()({
			status: 'down',
			error: new Error('ssh exited'),
			attempt: 1,
			retryInMs: 500,
		});
		expect(w.onLost).toHaveBeenCalledTimes(1);
		expect(w.onLost).toHaveBeenCalledWith('socket closed');
	});

	it('treats a stopped forward as lost, and unsubscribes both', () => {
		const w = watched();
		w.leaseListener()({ status: 'stopped' });
		expect(w.onLost).toHaveBeenCalledWith('The SSH forward stopped.');
		w.stop();
		expect(w.offHost).toHaveBeenCalled();
		expect(w.offLease).toHaveBeenCalled();
	});
});
