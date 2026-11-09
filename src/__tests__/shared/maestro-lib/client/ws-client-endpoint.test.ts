/**
 * Tests for the explicit-endpoint path of src/shared/maestro-lib/client/ws-client.ts: a client
 * built from `{port, token, cliSecret}` (a Federation SSH forward) instead of the local
 * `cli-server.json`. Runs against the real fake bridge socket, so the dial, the secret header and
 * the reconnect are the client's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWsMaestroClient } from '../../../../shared/maestro-lib/client/ws-client';
import type { ExplicitHostEndpointSource } from '../../../../shared/maestro-lib/client/discovery';
import type { MaestroClient, MaestroEvent } from '../../../../shared/maestro-lib/client/types';
import {
	CLI_SECRET,
	FakeBridge,
	TOKEN,
	agentRecord,
} from '../../../../shared/maestro-lib/client/__tests__/fakeBridge';

describe('createWsMaestroClient with an explicit endpoint', () => {
	let bridge: FakeBridge;
	const bridges: FakeBridge[] = [];
	const clients: MaestroClient[] = [];
	let events: MaestroEvent[];

	const types = () => events.map((event) => event.type);

	async function startBridge(): Promise<FakeBridge> {
		const started = await FakeBridge.start();
		started.invokes.set('sessions:getBootstrap', () => [agentRecord('a1')]);
		started.invokes.set('groups:getAll', () => []);
		bridges.push(started);
		return started;
	}

	function makeClient(endpoint: ExplicitHostEndpointSource): MaestroClient {
		const client = createWsMaestroClient({
			endpoint,
			requestTimeoutMs: 1000,
			reconcileIntervalMs: 0,
			heartbeatIntervalMs: 60_000,
			reconnect: { initialDelayMs: 10, maxDelayMs: 40 },
		});
		client.events.subscribe((event) => events.push(event));
		clients.push(client);
		return client;
	}

	const endpointOf = (overrides: Record<string, unknown> = {}, on: FakeBridge = bridge) => ({
		port: on.port,
		token: TOKEN,
		cliSecret: CLI_SECRET,
		...overrides,
	});

	beforeEach(async () => {
		events = [];
		bridge = await startBridge();
	});

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((client) => client.connection.close()));
		await Promise.all(bridges.splice(0).map((started) => started.stop()));
	});

	it('dials the endpoint on 127.0.0.1 with its secret, never reading cli-server.json', async () => {
		bridge.removeDiscovery();
		const client = makeClient(endpointOf({ pid: 812, version: '1.2.3', hostKind: 'headless' }));
		expect(await client.connection.discover()).toEqual({
			ok: true,
			value: { kind: 'headless', pid: 812, version: '1.2.3', label: 'headless pid 812' },
		});
		expect(bridge.connections).toHaveLength(0);
		const result = await client.connection.connect();
		expect(result).toMatchObject({ ok: true, value: { label: 'headless pid 812' } });
		expect(bridge.connections[0].headers['x-maestro-cli-secret']).toBe(CLI_SECRET);
		expect(bridge.connections[0].url).toBe(`/${TOKEN}/ws`);
		expect(client.connection.state()).toBe('connected');
	});

	it('does not check the pid, which may belong to another machine', async () => {
		const client = makeClient(endpointOf({ pid: 2 ** 22 + 12345 }));
		expect(await client.connection.connect()).toMatchObject({ ok: true });
	});

	it('labels an endpoint without a pid by its port', async () => {
		const client = makeClient(endpointOf());
		expect(await client.connection.discover()).toEqual({
			ok: true,
			value: { kind: 'desktop', label: `desktop 127.0.0.1:${bridge.port}` },
		});
	});

	it('asks a resolver again on every attempt, so a reconnect re-resolves', async () => {
		const resolver = vi.fn(() => Promise.resolve(endpointOf({ hostKind: 'headless' })));
		const client = makeClient(resolver);
		expect(await client.connection.connect()).toMatchObject({ ok: true });
		expect(resolver).toHaveBeenCalledTimes(1);
		events.length = 0;
		bridge.dropAll();
		await vi.waitFor(() => expect(types()).toContain('host.connected'));
		expect(client.connection.state()).toBe('connected');
		expect(resolver).toHaveBeenCalledTimes(2);
	});

	it('follows a host that restarted on a new port', async () => {
		let current = bridge;
		const client = makeClient(() => Promise.resolve(endpointOf({}, current)));
		expect(await client.connection.connect()).toMatchObject({ ok: true });
		expect(bridge.connections).toHaveLength(1);

		// The host goes away and comes back elsewhere; the resolver (a forward lease) learns it.
		const moved = await startBridge();
		expect(moved.port).not.toBe(bridge.port);
		current = moved;
		events.length = 0;
		await bridge.stop();
		bridges.splice(bridges.indexOf(bridge), 1);

		await vi.waitFor(() => expect(types()).toContain('host.connected'));
		expect(client.connection.state()).toBe('connected');
		expect(moved.connections).toHaveLength(1);
		expect(moved.connections[0].headers['x-maestro-cli-secret']).toBe(CLI_SECRET);
	});

	it('reports a resolver failure as host-unavailable, before any dial', async () => {
		// The resolver's own error must already be redacted (a forward lease's is): the client
		// cannot know the secrets of an endpoint it never received.
		const client = makeClient(() => Promise.reject(new Error('forward down')));
		const result = await client.connection.connect();
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'host-unavailable', method: 'connection.connect' },
		});
		expect(!result.ok && result.error.message).toMatch(/forward down/);
		expect(bridge.connections).toHaveLength(0);
	});

	it('scrubs the previous endpoint secrets from a later resolver failure', async () => {
		let fail = false;
		const client = makeClient(() =>
			fail
				? Promise.reject(new Error(`forward down ${TOKEN} ${CLI_SECRET}`))
				: Promise.resolve(endpointOf())
		);
		expect(await client.connection.connect()).toMatchObject({ ok: true });
		await client.connection.close();
		fail = true;
		const result = await client.connection.connect();
		expect(result).toMatchObject({ ok: false, error: { code: 'host-unavailable' } });
		const text = JSON.stringify(result);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(CLI_SECRET);
	});

	it('refuses an endpoint that cannot be dialed, without echoing the token', async () => {
		for (const bad of [
			endpointOf({ port: 0 }),
			endpointOf({ port: 70_000 }),
			endpointOf({ token: '' }),
			endpointOf({ token: 'tok/../../evil?x=' }),
		]) {
			const client = makeClient(bad);
			const result = await client.connection.discover();
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
			expect(JSON.stringify(result)).not.toContain('evil');
		}
		expect(bridge.connections).toHaveLength(0);
	});

	it('never puts the endpoint token or secret in an error message', async () => {
		bridge.invokes.set('sessions:getBootstrap', () => {
			throw new Error(`boom ${TOKEN} ${CLI_SECRET}`);
		});
		const client = makeClient(endpointOf());
		const result = await client.connection.connect();
		expect(result.ok).toBe(false);
		const text = JSON.stringify(result);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(CLI_SECRET);
	});
});
