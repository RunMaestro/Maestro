import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import * as dns from 'dns-packet';
import { request as httpsRequest } from 'node:https';
import { pairingTransport } from '../../main/lite/pairing/transport';
import { MdnsAdvertiser } from '../../main/lite/discovery/advertiser';
import { MdnsCache, MdnsBrowser, advertisement } from '../../main/lite/discovery/mdns';
import { issueInvitation, parseInvitation } from '../../main/lite/discovery/invitation';
import { candidate } from '../../main/lite/discovery/types';
import { validateManifest } from '../../main/lite/discovery/probe';
import { DiscoveryManager } from '../../main/lite/discovery/manager';
import { PairingHost } from '../../main/lite/pairing/host';
import { PairingClient } from '../../main/lite/pairing/client';
import { registerPairingRoutes } from '../../main/lite/pairing/routes';
import {
	PIN_TTL,
	GRANT_TTL,
	PAIR_PATH,
	token,
	hash,
	SCOPE,
	type PairingTransport,
	type Route,
} from '../../main/lite/pairing/protocol';
const route: Route = { endpoint: 'https://aster.example.test:8443', source: 'lan' };
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fixture() {
	let time = 1000000;
	let allowed = true;
	const host = await PairingHost.create(
		'Synthetic Aster',
		'aster-id',
		[route.endpoint, 'https://aster.overlay.test'],
		() => time
	);
	const app = Fastify({ logger: false });
	servers.push(app);
	let active: PairingHost | undefined = host;
	registerPairingRoutes(
		app,
		() => active,
		() => allowed,
		'0.18.6-RC'
	);
	const traces: { operation: string; body: unknown; response: string }[] = [];
	const transportFor = (r: Route): PairingTransport => ({
		async call<T>(operation: string, payload: unknown) {
			const response = await app.inject({
				method: 'POST',
				url: PAIR_PATH + '/' + operation,
				headers: { host: new URL(r.endpoint).host },
				payload: { route: r, payload },
			});
			traces.push({ operation, body: payload, response: response.body });
			const body = response.json();
			if (response.statusCode !== 200) throw new Error(body.error);
			return body as T;
		},
	});
	const transport = transportFor(route);
	const client = new PairingClient(transport, route, 'Synthetic Lite', () => time);
	const request = async () => {
		await client.begin('aster-id');
		return host.localRequests().at(-1)!.requestId;
	};
	const prove = async () => {
		const id = await request();
		host.approvePin(id);
		const pin = host.localRequests().find((r) => r.requestId === id)!.pin!;
		await client.poll();
		await client.submit(pin);
		return { id, pin };
	};
	const pair = async () => {
		const p = await prove();
		host.confirm(p.id);
		await client.poll();
		return p;
	};
	return {
		host,
		app,
		client,
		transport,
		transportFor,
		traces,
		request,
		prove,
		pair,
		advance: (n: number) => {
			time += n;
		},
		gate: (v: boolean) => {
			allowed = v;
		},
		disable: () => {
			active = undefined;
		},
	};
}
describe('production discovery adapters with synthetic inputs', () => {
	it('assembles split DNS-SD packets, honors goodbye and expiry, and exposes no service-ready claim', () => {
		let now = 1000;
		const cache = new MdnsCache(() => now);
		const records = dns.decode(
			advertisement('aster-id', 'Synthetic Aster', route.endpoint, 5)
		).answers!;
		for (const record of records) cache.ingest(dns.encode({ type: 'response', answers: [record] }));
		expect(cache.rows()).toEqual([
			expect.objectContaining({
				id: 'aster-id',
				name: 'Synthetic Aster',
				endpoint: route.endpoint,
				availability: 'unmeasured',
				expiresAt: 6000,
			}),
		]);
		cache.ingest(advertisement('aster-id', 'Synthetic Aster', route.endpoint, 0));
		expect(cache.rows()).toEqual([]);
		cache.ingest(advertisement('aster-id', 'Synthetic Aster', route.endpoint, 5));
		now = 6001;
		expect(cache.rows()).toEqual([]);
	});
	it('binds only on explicit start and closes pending multicast startup without resurrecting it', async () => {
		class FakeSocket extends EventEmitter {
			callback?: () => void;
			closed = false;
			bind(_port: number, _host: string, callback: () => void) {
				this.callback = callback;
			}
			close() {
				this.closed = true;
			}
			dropMembership() {}
		}
		const socket = new FakeSocket();
		let created = 0;
		const browser = new MdnsBrowser('192.0.2.10', () => {
			created++;
			return socket as unknown as Socket;
		});
		expect(created).toBe(0);
		const start = browser.start(
			() => undefined,
			() => undefined
		);
		browser.stop();
		socket.callback!();
		await expect(start).rejects.toThrow('cancelled');
		expect(socket.closed).toBe(true);
		expect(created).toBe(1);
	});
	it('expires host invitations and refuses authority changes or credential-bearing payloads', () => {
		const invitation = issueInvitation(
			{ id: 'aster-id', name: 'Aster', endpoint: route.endpoint },
			1000,
			1000
		);
		expect(parseInvitation(invitation, 1999)).toMatchObject({
			id: 'aster-id',
			availability: 'unmeasured',
			expiresAt: 2000,
		});
		expect(() => parseInvitation(invitation, 2000)).toThrow('expired');
		expect(() =>
			parseInvitation(invitation.replace('aster.example.test', 'different.example.test'), 1500)
		).toThrow('origin mismatch');
		const payload = {
			version: 1,
			id: 'aster-id',
			name: 'Aster',
			endpoint: route.endpoint,
			expiresAt: 2000,
			token: 'synthetic-not-accepted',
		};
		expect(() =>
			parseInvitation(
				route.endpoint +
					'/#maestro-invite=' +
					Buffer.from(JSON.stringify(payload)).toString('base64url'),
				1500
			)
		).toThrow('credentials');
	});
	it('automatically joins advertised LAN and Tailscale routes only after compatible service probes', async () => {
		const hint = candidate('aster-id', 'Aster', route.endpoint, 'lan', Date.now() + 60000);
		const manifest = {
			protocol: 'maestro-discovery',
			version: 1,
			instanceId: 'aster-id',
			name: 'Aster',
			appVersion: '0.18.6-RC',
			setupRevision: 6,
			pairing: { protocol: 'maestro-device-pairing/1', scope: SCOPE, enabled: true },
			capabilities: [SCOPE],
			connection: {
				path: '/.well-known/maestro/connect',
				authentication: 'device-pairing',
				admission: 'device',
				capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
			},
		};
		const addresses: string[] = [];
		const manager = new DiscoveryManager(
			() => undefined,
			() => undefined,
			{
				interfaces: () => [
					{ name: 'LAN1', address: '192.0.2.10' },
					{ name: 'LAN2', address: '192.0.2.11' },
				],
				lan: (address) => ({
					start: async (publish) => {
						addresses.push(address);
						publish([hint]);
					},
					stop() {},
				}),
				status: async () =>
					JSON.stringify({
						BackendState: 'Running',
						CurrentTailnet: { MagicDNSSuffix: 'tail.test' },
						Peer: {},
					}),
				services: async () =>
					JSON.stringify([
						{ Name: 'svc:maestro', Hostname: 'maestro.tail.test', Ports: ['tcp:443'] },
					]),
				probe: async (row) => validateManifest(row, manifest),
			}
		);
		try {
			await manager.start({});
			await vi.waitFor(() =>
				expect(manager.snapshot().candidates).toEqual([
					expect.objectContaining({
						id: 'aster-id',
						availability: 'ready',
						sources: ['lan', 'tailscale'],
					}),
				])
			);
			expect(addresses).toEqual(['192.0.2.10', '192.0.2.11']);
			const current = manager.snapshot();
			expect(manager.select(current.candidates[0].key, current.generation).id).toBe('aster-id');
			manager.stop();
			expect(() => manager.select(current.candidates[0].key, current.generation)).toThrow('stale');
		} finally {
			manager.stop();
		}
	});
	it('requires peer-probe consent and a real manifest even when named Services are unavailable', async () => {
		let finish!: (row: ReturnType<typeof candidate>) => void;
		const probe = vi.fn(
			(row: ReturnType<typeof candidate>) =>
				new Promise<ReturnType<typeof candidate>>((resolve) => {
					finish = resolve;
				})
		);
		const manager = new DiscoveryManager(
			() => undefined,
			() => undefined,
			{
				status: async () =>
					JSON.stringify({
						BackendState: 'Running',
						CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
						Peer: {
							a: {
								ID: 'peer-a',
								DNSName: 'aster.synthetic.ts.net.',
								Online: true,
								TailscaleIPs: ['100.64.0.10'],
							},
						},
					}),
				services: async () => {
					throw Object.assign(new Error('private diagnostic'), { status: 'unavailable' });
				},
				probe,
			}
		);
		try {
			await manager.start({ lan: false });
			expect(probe).not.toHaveBeenCalled();
			expect(manager.snapshot().candidates).toEqual([]);
			await manager.start({ lan: false, tailscalePeers: true });
			expect(probe).toHaveBeenCalledTimes(1);
			expect(manager.snapshot().candidates).toEqual([]);
			const hint = probe.mock.calls[0][0];
			expect(hint.endpoint).toBe('http://100.64.0.10:56036');
			finish(
				validateManifest(hint, {
					protocol: 'maestro-discovery',
					version: 1,
					instanceId: 'aster-id',
					name: 'Aster',
					appVersion: '0.18.6-RC',
					setupRevision: 6,
					pairing: { protocol: 'maestro-device-pairing/1', scope: SCOPE, enabled: true },
					capabilities: [SCOPE],
					connection: {
						path: '/.well-known/maestro/connect',
						authentication: 'device-pairing',
						admission: 'device',
						capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
					},
				})
			);
			await vi.waitFor(() =>
				expect(manager.snapshot().candidates).toEqual([
					expect.objectContaining({ id: 'aster-id', availability: 'ready' }),
				])
			);
			expect(
				manager.select(manager.snapshot().candidates[0].key, manager.snapshot().generation).id
			).toBe('aster-id');
			await manager.start({ lan: false, tailscale: false, tailscalePeers: true });
			expect(probe).toHaveBeenCalledTimes(1);
			await manager.start({ lan: false, tailscalePeers: true });
			const secondHint = probe.mock.calls[1][0];
			finish({ ...secondHint, availability: 'auth-required' });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(manager.snapshot().candidates).toEqual([]);
			await manager.start({ lan: false, tailscalePeers: true });
			const lateHint = probe.mock.calls[2][0];
			manager.stop();
			finish(validateManifest(lateHint, { protocol: 'unrelated-service' }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			manager.stop();
			expect(manager.snapshot().candidates).toEqual([]);
		} finally {
			manager.stop();
		}
	});
	it.each(['tailnet', 'interface'] as const)(
		'requires new peer consent after a %s change',
		async (change) => {
			vi.useFakeTimers();
			let suffix = 'first.ts.net';
			let address = '192.0.2.10';
			const networkChanged = vi.fn();
			const probe = vi.fn(async (row: ReturnType<typeof candidate>) =>
				validateManifest(row, {
					protocol: 'maestro-discovery',
					version: 1,
					instanceId: 'aster-id',
					name: 'Aster',
					appVersion: '0.18.6-RC',
					setupRevision: 6,
					pairing: { protocol: 'maestro-device-pairing/1', scope: SCOPE, enabled: true },
					capabilities: [SCOPE],
					connection: {
						path: '/.well-known/maestro/connect',
						authentication: 'device-pairing',
						admission: 'device',
						capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
					},
				})
			);
			const manager = new DiscoveryManager(() => undefined, networkChanged, {
				interfaces: () => [{ name: 'Synthetic interface', address }],
				lan: () => ({ async start() {}, stop() {} }),
				status: async () =>
					JSON.stringify({
						BackendState: 'Running',
						CurrentTailnet: { MagicDNSSuffix: suffix },
						Peer: {
							a: {
								ID: 'peer-a',
								DNSName: 'aster.' + suffix,
								Online: true,
								TailscaleIPs: ['100.64.0.10'],
							},
						},
					}),
				services: async () => '[]',
				probe,
			});
			try {
				await manager.start({ tailscalePeers: true });
				await vi.advanceTimersByTimeAsync(0);
				expect(probe).toHaveBeenCalledTimes(1);
				if (change === 'tailnet') suffix = 'second.ts.net';
				else address = '192.0.2.11';
				await vi.advanceTimersByTimeAsync(30000);
				expect(manager.snapshot().candidates).toEqual([]);
				expect(probe.mock.calls.every(([row]) => row.endpoint === 'http://100.64.0.10:56036')).toBe(
					true
				);
				const count = probe.mock.calls.length;
				await vi.advanceTimersByTimeAsync(30000);
				expect(probe).toHaveBeenCalledTimes(count);
				await manager.start({ tailscalePeers: true });
				await vi.advanceTimersByTimeAsync(0);
				expect(probe.mock.calls.at(-1)![0].endpoint).toBe('http://100.64.0.10:56036');
			} finally {
				manager.stop();
				vi.useRealTimers();
			}
		}
	);
	it('discards stopped asynchronous searches without launching another provider operation', async () => {
		const pending = Promise.withResolvers<string>();
		const services = vi.fn(async () => '[]');
		const manager = new DiscoveryManager(
			() => undefined,
			() => undefined,
			{ status: () => pending.promise, services }
		);
		const start = manager.start({ lan: false });
		manager.stop();
		pending.resolve(JSON.stringify({ BackendState: 'Running' }));
		await start;
		expect(manager.snapshot().candidates).toEqual([]);
		expect(services).not.toHaveBeenCalled();
	});
});
describe('separated roles through existing-server HTTP injection', () => {
	it('keeps PIN/approval off transport and requires final consent before admitting normal sign-in', async () => {
		const f = await fixture();
		const { id, pin } = await f.prove();
		await expect(f.client.read()).rejects.toThrow('not-paired');
		for (const operation of ['approve', 'approvePin', 'confirm', 'localRequests'])
			expect(
				(await f.app.inject({ method: 'POST', url: PAIR_PATH + '/' + operation })).statusCode
			).toBe(404);
		f.host.confirm(id);
		await f.client.poll();
		expect(await f.client.read()).toEqual({
			name: 'Synthetic Aster',
			instanceId: 'aster-id',
			hostKey: f.client.snapshot().hostKey,
			connection: {
				path: '/.well-known/maestro/connect',
				authentication: 'device-pairing',
				admission: 'device',
				capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
			},
		});
		const containsPin = (value: unknown): boolean =>
			typeof value === 'string'
				? value === pin
				: !!value && typeof value === 'object' && Object.values(value).some(containsPin);
		expect(f.traces.some((t) => containsPin(t.body) || containsPin(JSON.parse(t.response)))).toBe(
			false
		);
		const read = f.traces.find((t) => t.operation === 'read')!.body as object;
		await expect(f.transport.call('read', { ...read, method: 'agents.execute' })).rejects.toThrow(
			'forbidden'
		);
		await expect(f.transport.call('read', read)).rejects.toThrow('replay');
	});
	it('locks five incorrect PIN attempts and consumes a successful proof', async () => {
		const f = await fixture();
		const id = await f.request();
		f.host.approvePin(id);
		await f.client.poll();
		const wrong = f.host.localRequests()[0].pin === '000000' ? '111111' : '000000';
		for (let i = 0; i < 5; i++)
			await expect(f.client.submit(wrong)).rejects.toThrow('wrong-pin-or-host');
		await f.client.poll();
		expect(f.client.snapshot().phase).toBe('locked');
	});
	it('expires requests and grants, rejects reused finish messages and supports host revocation', async () => {
		const f = await fixture();
		await f.request();
		f.advance(PIN_TTL + 1);
		await f.client.poll();
		expect(f.client.snapshot().phase).toBe('expired');
		const g = await fixture();
		const { id } = await g.pair();
		const finish = g.traces.find((t) => t.operation === 'finish')!.body;
		await expect(g.transport.call('finish', finish)).rejects.toThrow();
		g.host.revoke(id);
		await g.client.poll();
		expect(g.client.snapshot().phase).toBe('cancelled');
		const h = await fixture();
		await h.pair();
		h.advance(GRANT_TTL + 1);
		await expect(h.client.read()).rejects.toThrow('not-paired');
	});
	it('rejects missing capabilities, forged origins and cross-route reuse', async () => {
		const f = await fixture();
		const id = await f.request();
		await expect(f.transport.call('status', { id })).rejects.toThrow('invalid-request');

		const challenge = f.traces.find((t) => t.operation === 'begin')!;
		expect(challenge.response).not.toContain('capability');
		const foreign = await f.app.inject({
			method: 'POST',
			url: PAIR_PATH + '/describe',
			headers: { host: new URL(route.endpoint).host, origin: 'https://evil.example.test' },
			payload: { route, payload: {} },
		});
		expect(foreign.statusCode).toBe(400);
		const g = await fixture();
		await g.pair();
		const read = await g.client.read();
		expect(read.instanceId).toBe('aster-id');
		const payload = g.traces.find((t) => t.operation === 'read')!.body;
		await expect(
			g
				.transportFor({ endpoint: 'https://aster.overlay.test', source: 'cloudflare' })
				.call('read', payload)
		).rejects.toThrow('route-mismatch');
		f.disable();
		await expect(f.transport.call('describe', {})).rejects.toThrow('pairing-disabled');
	});
	it('rejects a saved identity mismatch before allocating a PIN request', async () => {
		const f = await fixture();
		await expect(
			new PairingClient(f.transport, route, 'Lite').begin('different-host')
		).rejects.toThrow('host-identity-changed');
		expect(f.host.localRequests()).toEqual([]);
	});
	it('cancellation racing an in-flight begin revokes the request and cannot restore client state', async () => {
		const f = await fixture();
		let release!: () => void;
		let created!: () => void;
		const allocated = new Promise<void>((resolve) => {
			created = resolve;
		});
		const transport: PairingTransport = {
			async call<T>(op: string, p: unknown) {
				const value = await f.transport.call<T>(op, p);
				if (op === 'begin') {
					created();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				return value;
			},
		};
		const client = new PairingClient(transport, route, 'Lite');
		const begin = client.begin();
		await allocated;
		await client.cancel();
		release();
		await expect(begin).rejects.toThrow('cancelled');
		expect(client.snapshot().phase).toBe('cancelled');
		expect(f.host.localRequests()[0].state).toBe('cancelled');
	});
	it('bounds concurrent requests and rate limits independently of client labels', async () => {
		const f = await fixture();
		const descriptor = f.host.describe(route);
		for (let i = 0; i < 4; i++)
			f.host.begin(
				{
					clientName: 'Client ' + i,
					clientNonce: token(),
					capabilityHash: hash(token()),
					scope: SCOPE,
					epoch: descriptor.epoch,
				},
				route
			);
		expect(() =>
			f.host.begin(
				{
					clientName: 'Next',
					clientNonce: token(),
					capabilityHash: hash(token()),
					scope: SCOPE,
					epoch: descriptor.epoch,
				},
				route
			)
		).toThrow('host-busy');
	});
});
describe('executable adapters with mocked operating-system I/O', () => {
	it('receives DNS-SD results through the socket adapter and sends goodbye on advertiser shutdown', async () => {
		vi.useFakeTimers();
		class FakeSocket extends EventEmitter {
			sent: Buffer[] = [];
			closed = false;
			bind(_port: number, _host: string, callback: () => void) {
				callback();
			}
			addMembership() {}
			setMulticastInterface() {}
			setMulticastTTL() {}
			dropMembership() {}
			send(bytes: Buffer, _port: number, _host: string, callback: (error?: Error) => void) {
				this.sent.push(bytes);
				callback();
			}
			close() {
				this.closed = true;
			}
		}
		const source = new FakeSocket(),
			sink = new FakeSocket();
		const values: string[][] = [];
		const browser = new MdnsBrowser('192.0.2.10', () => sink as unknown as Socket);
		await browser.start(
			(rows) => values.push(rows.map((r) => r.name)),
			(error) => {
				throw new Error(error);
			}
		);
		const advertiser = new MdnsAdvertiser(() => source as unknown as Socket);
		advertiser.start('192.0.2.11', 'aster-id', 'Synthetic Aster', route.endpoint, (error) => {
			throw new Error(error);
		});
		await vi.advanceTimersByTimeAsync(1001);
		const response = source.sent.find((bytes) => dns.decode(bytes).type === 'response')!;
		sink.emit('message', response);
		expect(values.at(-1)).toEqual(['Synthetic Aster']);
		advertiser.stop();
		sink.emit('message', source.sent.at(-1));
		expect(values.at(-1)).toEqual([]);
		browser.stop();
		expect(source.closed && sink.closed).toBe(true);
	});
	it('refuses redirects and enforces HTTPS verification without sending credentials', async () => {
		let captured: Record<string, unknown> = {};
		let calls = 0;
		const send = ((_url: string, options: object, callback: (response: EventEmitter) => void) => {
			calls++;
			captured = options as Record<string, unknown>;
			const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
			req.destroy = () => {
				req.emit('error', new Error('destroyed'));
				req.emit('close');
			};
			req.end = () => {
				const response = Object.assign(new EventEmitter(), { statusCode: 302 });
				callback(response);
				response.emit('data', Buffer.from('{}'));
				response.emit('end');
				req.emit('close');
			};
			return req;
		}) as unknown as typeof httpsRequest;
		await expect(pairingTransport(route, send).call('describe', {})).rejects.toThrow(
			'authentication-required-use-manual'
		);
		expect(calls).toBe(1);
		expect(captured.rejectUnauthorized).toBe(true);
		expect(captured.headers).not.toHaveProperty('cookie');
		expect(captured.headers).not.toHaveProperty('authorization');
		expect(() => pairingTransport({ ...route, endpoint: 'http://aster.test' }, send)).toThrow();
	});
});
