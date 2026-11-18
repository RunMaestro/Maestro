/**
 * Tests for the Federation peer mirror's place in the main process: the runtime that creates and
 * stops the one `PeerMirrorService` (Federation is always on and opportunistic), the push
 * channels, and the rule that the mirror never reaches a persisted store.
 *
 * The SSH forward and the host client are stood in for through the `overrides` seam; nothing
 * here dials.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	buildPeerMirrorServiceDeps,
	createFederationRuntime,
	FEDERATION_EVENT_CHANNEL,
	FEDERATION_RESET_CHANNEL,
	getPeerMirrorService,
	setPeerMirrorServiceForTests,
	type FederationRuntimeDeps,
} from '../../../main/federation';
import type { SshForwardLease } from '../../../shared/maestro-lib/client/ssh-forward';
import type { MaestroClient } from '../../../shared/maestro-lib/client/types';
import type { SshRemoteConfig } from '../../../shared/types';

const remoteOf = (id: string, overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id,
	name: id,
	host: `${id}.example.com`,
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
	...overrides,
});

const ENDPOINT = { port: 50123, remotePort: 41234, token: 't', cliSecret: 's', pid: 1 };

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A forward that is up at once and a client that connects with one agent. */
function fakeTransport() {
	const close = vi.fn(async () => undefined);
	const release = vi.fn(async () => undefined);
	const acquireForward = vi.fn(
		(remote: SshRemoteConfig) =>
			({
				remoteId: remote.id,
				state: () => ({ status: 'up', endpoint: ENDPOINT }),
				ready: () => Promise.resolve(ENDPOINT),
				onChange: () => () => undefined,
				restart: vi.fn(),
				release,
			}) as unknown as SshForwardLease
	);
	const createClient = vi.fn(() => {
		const listeners = new Set<(event: unknown) => void>();
		let state = 'idle';
		return {
			connection: {
				connect: vi.fn(async () => {
					state = 'connected';
					listeners.forEach((l) =>
						l({
							type: 'snapshot',
							agents: [{ id: 'a1', name: 'a1', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
							groups: [],
						})
					);
					return { ok: true, value: {} };
				}),
				reconnect: vi.fn(async () => ({ ok: true, value: {} })),
				close,
				state: () => state,
			},
			agents: { list: vi.fn(async () => ({ ok: true, value: [] })) },
			groups: { list: vi.fn(async () => ({ ok: true, value: [] })) },
			tabs: { transcript: vi.fn(async () => ({ ok: true, value: [] })) },
			// The service reads every agent's host queue once it attaches.
			turns: { queue: { list: vi.fn(async () => ({ ok: true, value: [] })) } },
			events: {
				subscribe: (listener: (event: unknown) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		} as unknown as MaestroClient;
	});
	return { acquireForward, createClient, close, release };
}

function runtime(remotes: SshRemoteConfig[]) {
	const transport = fakeTransport();
	const unwatch = vi.fn();
	const deps = {
		readRemotes: vi.fn<FederationRuntimeDeps['readRemotes']>(() => remotes),
		watchRemotes: vi.fn<FederationRuntimeDeps['watchRemotes']>(() => unwatch),
		safeSend: vi.fn<FederationRuntimeDeps['safeSend']>(),
		overrides: {
			acquireForward: transport.acquireForward,
			createClient: transport.createClient,
		},
	} satisfies FederationRuntimeDeps;
	return { deps, transport, unwatch };
}

afterEach(() => {
	setPeerMirrorServiceForTests(null);
});

describe('Federation runtime', () => {
	it('does nothing until start(): no service, no store read, no ssh', () => {
		const { deps, transport } = runtime([remoteOf('a')]);
		createFederationRuntime(deps);
		expect(getPeerMirrorService()).toBeNull();
		expect(deps.readRemotes).not.toHaveBeenCalled();
		expect(deps.watchRemotes).not.toHaveBeenCalled();
		expect(deps.safeSend).not.toHaveBeenCalled();
		expect(transport.acquireForward).not.toHaveBeenCalled();
	});

	it('stop() with nothing running does nothing at all', () => {
		const { deps, transport } = runtime([remoteOf('a')]);
		createFederationRuntime(deps).stop();
		expect(getPeerMirrorService()).toBeNull();
		expect(deps.safeSend).not.toHaveBeenCalled();
		expect(transport.acquireForward).not.toHaveBeenCalled();
	});

	it('start() builds one service that probes every remote except one that opted out', async () => {
		const { deps, transport } = runtime([
			remoteOf('a'),
			remoteOf('plain', { federation: undefined }),
			remoteOf('off', { federation: false }),
		]);
		const federation = createFederationRuntime(deps);
		federation.start();
		const service = getPeerMirrorService();
		expect(service).not.toBeNull();
		expect(deps.watchRemotes).toHaveBeenCalledTimes(1);
		await settle();
		await settle();
		expect(transport.acquireForward).toHaveBeenCalledTimes(2);
		expect(transport.acquireForward).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
		expect(transport.acquireForward).toHaveBeenCalledWith(expect.objectContaining({ id: 'plain' }));
		expect(transport.acquireForward).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: 'off' })
		);

		// A second start settles the same instance; it never builds a second one.
		federation.start();
		expect(getPeerMirrorService()).toBe(service);
		expect(deps.watchRemotes).toHaveBeenCalledTimes(1);
		federation.stop();
	});

	it('pushes every change on federation:event', async () => {
		const { deps } = runtime([remoteOf('a')]);
		const federation = createFederationRuntime(deps);
		federation.start();
		await settle();
		const channels = deps.safeSend.mock.calls.map((call) => call[0]);
		expect(channels.length).toBeGreaterThan(0);
		expect(new Set(channels)).toEqual(new Set([FEDERATION_EVENT_CHANNEL]));
		expect(deps.safeSend).toHaveBeenCalledWith(
			FEDERATION_EVENT_CHANNEL,
			expect.objectContaining({ peerId: 'a' })
		);
		federation.stop();
	});

	it('stop() forgets the service, drops the store listener, closes the peer, and resets the windows', async () => {
		const { deps, transport, unwatch } = runtime([remoteOf('a')]);
		const federation = createFederationRuntime(deps);
		federation.start();
		await settle();
		const stopped = getPeerMirrorService();
		federation.stop();
		expect(getPeerMirrorService()).toBeNull();
		await settle();
		expect(unwatch).toHaveBeenCalledTimes(1);
		expect(transport.close).toHaveBeenCalled();
		expect(transport.release).toHaveBeenCalled();
		expect(deps.safeSend).toHaveBeenLastCalledWith(FEDERATION_RESET_CHANNEL);
		expect(stopped?.peers()).toEqual([]);

		// Started again: a fresh instance, not the stopped one.
		federation.start();
		expect(getPeerMirrorService()).not.toBe(stopped);
		expect(getPeerMirrorService()).not.toBeNull();
		federation.stop();
	});
});

describe('buildPeerMirrorServiceDeps', () => {
	it('routes pushes and resets through the all-windows send', () => {
		const { deps } = runtime([]);
		const built = buildPeerMirrorServiceDeps(deps);
		const payload = { peerId: 'a', event: { type: 'peer.removed' } } as never;
		built.push(payload);
		built.reset();
		expect(deps.safeSend).toHaveBeenNthCalledWith(1, FEDERATION_EVENT_CHANNEL, payload);
		expect(deps.safeSend).toHaveBeenNthCalledWith(2, FEDERATION_RESET_CHANNEL);
	});
});

describe('the mirror never touches a persisted store', () => {
	// The hard rule of FED-SSH-05: mirrored agents live in memory only. The main-process side of
	// the mirror holds no store handle; it reads SSH remotes only through the deps it is given. A
	// store import in any of these modules would be the first step to writing one.
	const MIRROR_MODULES = [
		'src/main/federation/index.ts',
		'src/main/federation/peer-mirror-service.ts',
		'src/main/ipc/handlers/federation.ts',
		'src/main/preload/federation.ts',
		'src/shared/maestro-lib/client/peer-mirror.ts',
		'src/shared/maestro-lib/client/live-turn.ts',
		'src/shared/maestro-lib/client/peer-connection.ts',
	];
	const importsOf = (source: string): string[] =>
		[...source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

	it.each(MIRROR_MODULES)('%s imports no store', (relative) => {
		const source = readFileSync(join(process.cwd(), relative), 'utf8');
		const imports = importsOf(source);
		expect(imports.length).toBeGreaterThan(0);
		for (const specifier of imports) {
			// `maestro-lib/store/*` is the library's record TYPES, not a store; `stores/` is.
			expect(specifier).not.toMatch(/(^|\/)stores(\/|$)/);
			expect(specifier).not.toMatch(/electron-store/);
			expect(specifier).not.toMatch(/sessionStore|maestro-sessions/);
		}
	});
});
