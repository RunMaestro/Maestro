import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:dgram';
import { PassThrough } from 'node:stream';
import type { request as httpsRequest } from 'node:https';
import { MdnsCache } from '../../../main/lite/discovery/mdns';
import { probeService } from '../../../main/lite/discovery/probe';
import { tailscaleCandidates } from '../../../main/lite/discovery/tailscale';
import Fastify from 'fastify';
import * as opaque from '@serenity-kit/opaque';
import * as dns from 'dns-packet';
import QRCode from 'qrcode';
import { BrowserWindow, clipboard, ipcMain, dialog } from 'electron';
import { availableLanInterfaces } from '../../../main/lite/discovery/interfaces';
import { MdnsAdvertiser } from '../../../main/lite/discovery/advertiser';
import { parseInvitation } from '../../../main/lite/discovery/invitation';
import { PairingHost } from '../../../main/lite/pairing/host';
import { PairingClient } from '../../../main/lite/pairing/client';
import { HostPairingWindow } from '../../../main/lite/pairing/host-window';

import { registerPairingRoutes } from '../../../main/lite/pairing/routes';
import { hash, token, PAIR_PATH, type PairingTransport } from '../../../main/lite/pairing/protocol';

const mocks = vi.hoisted(() => ({ sockets: vi.fn(), interfaces: vi.fn(), directory: '' }));
vi.mock('../../../main/web-server/auth/web-login-policy', () => ({
	isWebLoginEnabled: () => true,
}));
vi.mock('../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({ hasUsers: () => true }),
}));
vi.mock('../../../main/lite/discovery/tailscale', async (original) => ({
	...(await original<typeof import('../../../main/lite/discovery/tailscale')>()),
	readTailscaleStatus: vi.fn(async () => JSON.stringify({ BackendState: 'Stopped' })),
}));
vi.mock('node:dgram', () => ({ createSocket: mocks.sockets }));
vi.mock('../../../main/lite/discovery/interfaces', () => ({
	availableLanInterfaces: mocks.interfaces,
}));
vi.mock('electron', () => ({
	app: { getPath: () => mocks.directory },
	dialog: {
		showMessageBox: vi.fn(
			(_window: unknown, options: { signal?: AbortSignal }) =>
				new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
					const cancel = () => resolve({ response: 0, checkboxChecked: false });
					if (options.signal?.aborted) cancel();
					else options.signal?.addEventListener('abort', cancel, { once: true });
				})
		),
	},
	BrowserWindow: vi.fn(function () {
		const events = new Map<string, () => void>();
		return {
			webContents: { mainFrame: { url: '' }, on: vi.fn(), setWindowOpenHandler: vi.fn() },
			on: (name: string, callback: () => void) => events.set(name, callback),
			loadURL: vi.fn(async function (
				this: { webContents: { mainFrame: { url: string } } },
				url: string
			) {
				this.webContents.mainFrame.url = url;
			}),
			isDestroyed: vi.fn(() => false),
			show: vi.fn(),
			focus: vi.fn(),
			close: vi.fn(() => events.get('closed')?.()),
		};
	}),
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	clipboard: { writeText: vi.fn() },
}));

class MockSocket extends EventEmitter {
	packets: Buffer[] = [];
	bind = vi.fn((_port: number, _address: string, done: () => void) => done());
	addMembership = vi.fn();
	setMulticastInterface = vi.fn();
	setMulticastTTL = vi.fn();
	close = vi.fn();
	send = vi.fn((bytes: Buffer, _port: number, _address: string, done: (error?: Error) => void) => {
		this.packets.push(bytes);
		done();
	});
}
const endpoint = 'https://host.example.test:8443';
const options = { name: 'Synthetic host', appVersion: '0.18.6-RC', endpoints: () => [endpoint] };
let shell: HostPairingWindow | undefined;

beforeAll(async () => {
	await opaque.ready;
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.directory = mkdtempSync(path.join(os.tmpdir(), 'maestro-host-discovery-'));
	mocks.interfaces.mockReturnValue([{ name: 'Mock Ethernet', address: '192.0.2.10' }]);
	mocks.sockets.mockImplementation(() => new MockSocket());
});
afterEach(async () => {
	await shell?.close();
	rmSync(mocks.directory, { recursive: true, force: true });
	shell = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function local(config = options) {
	shell = new HostPairingWindow();
	await shell.open(
		{
			isDestroyed: () => false,
			isMinimized: () => false,
			show: vi.fn(),
			focus: vi.fn(),
		} as unknown as BrowserWindow,
		'host-id',
		config
	);
	const window = vi.mocked(BrowserWindow).mock.results.at(-1)!.value;
	const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
	const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
	const invoke = (action: string, payload?: object) => handler(event as never, action, payload);
	return { invoke, window, event, handler, shell };
}
const enable = { name: 'Synthetic host', endpoint, consent: true };

describe('attended host discovery manifest on the existing server', () => {
	it('returns a minimal manifest only while sharing and normal login are ready', async () => {
		const host = await PairingHost.create('Synthetic host', 'host-id', [endpoint]);
		let active: PairingHost | undefined;
		let authorized = false;
		const app = Fastify();
		registerPairingRoutes(
			app,
			() => active,
			() => authorized,
			options.appVersion
		);
		const get = () =>
			app.inject({
				method: 'GET',
				url: '/.well-known/maestro/discovery',
				headers: { host: 'host.example.test:8443' },
			});
		try {
			const off = await get();
			expect(off.statusCode).toBe(404);
			expect(off.headers['cache-control']).toBe('no-store');
			active = host;
			expect((await get()).statusCode).toBe(503);
			authorized = true;
			const response = await get();
			expect(response.statusCode).toBe(200);
			expect(response.headers['cache-control']).toBe('no-store');
			expect(response.json()).toEqual({
				protocol: 'maestro-discovery',
				version: 1,
				instanceId: 'host-id',
				name: 'Synthetic host',
				appVersion: options.appVersion,
				setupRevision: 6,
				pairing: {
					protocol: 'maestro-device-pairing/1',
					scope: 'host.control',
					enabled: true,
				},
				capabilities: ['host.control'],
				connection: {
					path: '/.well-known/maestro/connect',
					authentication: 'device-pairing',
					admission: 'device',
					capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
				},
			});
			active = undefined;
			host.dispose();
			expect((await get()).statusCode).toBe(404);
		} finally {
			host.dispose();
			await app.close();
		}
	});
	it('rejects unrelated authority/origin and forwarded aliases', async () => {
		const host = await PairingHost.create('Synthetic host', 'host-id', [endpoint]);
		const app = Fastify();
		registerPairingRoutes(
			app,
			() => host,
			() => true,
			options.appVersion
		);
		try {
			for (const headers of [
				{ host: 'unrelated.example.test', 'x-forwarded-host': 'host.example.test:8443' },
				{ host: 'host.example.test:8443', origin: 'https://unrelated.example.test' },
				{ host: 'host.example.test:8443', origin: 'null' },
			])
				expect([400, 403]).toContain(
					(await app.inject({ url: '/.well-known/maestro/discovery', headers })).statusCode
				);
			expect(
				(
					await app.inject({
						url: '/.well-known/maestro/discovery',
						headers: { host: 'HOST.EXAMPLE.TEST:8443', origin: endpoint },
					})
				).statusCode
			).toBe(200);
			host.dispose();
			expect(() => host.discoveryMetadata(endpoint, options.appVersion)).toThrow('route-mismatch');
		} finally {
			host.dispose();
			await app.close();
		}
	});
	describe('matched host advertisement and client discovery', () => {
		it('requires actual host activation for optional LAN and named-Service HTTPS discovery', async () => {
			vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
			const origin = 'https://maestro-synthetic.synthetic.ts.net';
			const { invoke, shell: active } = await local({ ...options, endpoints: () => [origin] });
			const app = Fastify();
			let authorized = true;
			registerPairingRoutes(
				app,
				() => active.host,
				() => authorized,
				options.appVersion
			);
			// Only the network boundary is replaced: client consumes real host route responses.
			const send = ((
				_url: string,
				_options: unknown,
				callback: (response: PassThrough & { statusCode: number }) => void
			) => {
				const request = new EventEmitter();
				return Object.assign(request, {
					destroy() {},
					end() {
						const url = new URL(_url);
						void app
							.inject({ method: 'GET', url: url.pathname, headers: { host: url.host } })
							.then((reply) => {
								const response = Object.assign(new PassThrough(), { statusCode: reply.statusCode });
								callback(response);
								response.end(reply.body);
							})
							.catch((error) => request.emit('error', error));
					},
				});
			}) as unknown as typeof httpsRequest;
			const status = JSON.stringify({
				BackendState: 'Running',
				Self: { Online: true },
				CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
				Peer: {
					a: {
						ID: 'node-a',
						DNSName: 'maestro-synthetic.synthetic.ts.net.',
						Online: true,
						TailscaleIPs: ['100.64.0.10'],
					},
				},
			});
			const service = JSON.stringify([
				{
					Name: 'svc:maestro-synthetic',
					Hostname: 'maestro-synthetic.synthetic.ts.net',
					Ports: ['tcp:443'],
				},
			]);
			const overlay = tailscaleCandidates(status, service)[0];

			const probe = (row: typeof overlay) => probeService(row, new AbortController().signal, send);
			const cache = new MdnsCache();
			try {
				// Online peer plus running app is not a discovery service.
				expect(tailscaleCandidates(status, '[]')).toEqual([]);
				expect(cache.rows()).toEqual([]);
				expect((await probe(overlay)).availability).toBe('pairing-disabled');

				await invoke('enable', {
					...enable,
					endpoint: origin,
					lan: true,
					interfaceAddress: '192.0.2.10',
				});
				await vi.advanceTimersByTimeAsync(1100);
				const socket: MockSocket = mocks.sockets.mock.results[0].value;
				for (const packet of socket.packets) cache.ingest(packet);
				const lan = cache.rows()[0];
				expect(lan).toMatchObject({ id: 'host-id', endpoint: origin, source: 'lan' });
				for (const row of [lan, overlay]) {
					expect(await probe(row)).toMatchObject({
						id: 'host-id',
						name: enable.name,
						endpoint: origin,
						availability: 'ready',
					});
				}
				// A browsable host still cannot bypass its existing login policy.
				authorized = false;
				for (const row of [lan, overlay])
					expect((await probe(row)).availability).toBe('unreachable');
				authorized = true;
				expect(active.host!.localRequests()).toEqual([]);
				await invoke('stop');
				cache.ingest(socket.packets.at(-1)!);
				expect(cache.rows()).toEqual([]);
				// Named Service may remain registered, but the stopped host is not pairable.
				expect((await probe(overlay)).availability).toBe('pairing-disabled');
			} finally {
				await invoke('stop');
				await app.close();
			}
		});
	});
});

describe('host-local consent, interface selection and invitation lifecycle', () => {
	it('prompts for a named incoming request and denies it without revealing a code or granting a device', async () => {
		vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
		const { invoke, shell: active } = await local();
		await invoke('enable', enable);
		const host = active.host!;
		const route = { endpoint, source: 'lan' as const };
		const request = host.begin(
			{
				clientName: 'Travel-Laptop',
				clientNonce: token(),
				capabilityHash: hash(token()),
				scope: 'host.control',
				epoch: host.describe(route).epoch,
			},
			route
		);
		await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledOnce(), { timeout: 600 });
		expect(vi.mocked(dialog.showMessageBox).mock.calls[0][1]).toMatchObject({
			message: expect.stringContaining('Travel-Laptop'),

			defaultId: 0,
			cancelId: 0,
		});
		await vi.waitFor(() =>
			expect(host.localRequests().find((r) => r.requestId === request.requestId)).toMatchObject({
				state: 'cancelled',
				pin: undefined,
			})
		);
		expect(host.devices.list('host-id')).toEqual([]);
	});
	it('queues simultaneous requests and reveals only the confirmed request code', async () => {
		const firstReply = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
		vi.mocked(dialog.showMessageBox)
			.mockReturnValueOnce(firstReply.promise)
			.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
		const { invoke, shell: active } = await local();
		await invoke('enable', enable);
		const host = active.host!,
			route = { endpoint, source: 'lan' as const };
		const payload = {
			clientName: 'First Laptop',
			clientNonce: token(),
			capabilityHash: hash(token()),
			scope: 'host.control',
			epoch: host.describe(route).epoch,
		};
		const first = host.begin(payload, route);
		expect(() => host.begin(payload, route)).toThrow('replay');
		const second = host.begin(
			{ ...payload, clientName: 'Second Laptop', clientNonce: token() },
			route
		);
		expect(dialog.showMessageBox).toHaveBeenCalledOnce();
		firstReply.resolve({ response: 1, checkboxChecked: false });
		await vi.waitFor(() =>
			expect(host.localRequests().find((r) => r.requestId === first.requestId)).toMatchObject({
				state: 'pin-issued',
				pin: expect.stringMatching(/^\d{6}$/),
			})
		);
		await vi.waitFor(() =>
			expect(host.localRequests().find((r) => r.requestId === second.requestId)).toMatchObject({
				state: 'cancelled',
				pin: undefined,
			})
		);
		expect((await invoke('state')).focusRequestId).toBe(first.requestId);
		expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
		expect(host.devices.list('host-id')).toEqual([]);
	});
	it.each(['cancel', 'expire', 'shutdown'] as const)(
		'does not apply a late Confirm after %s',
		async (reason) => {
			let now = Date.now();
			if (reason === 'expire') vi.spyOn(Date, 'now').mockImplementation(() => now);
			const reply = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>();
			vi.mocked(dialog.showMessageBox).mockReturnValueOnce(reply.promise);
			const { invoke, shell: active } = await local();
			await invoke('enable', enable);
			const host = active.host!,
				route = { endpoint, source: 'lan' as const };
			const request = host.begin(
				{
					clientName: 'Stale Laptop',
					clientNonce: token(),
					capabilityHash: hash(token()),
					scope: 'host.control',
					epoch: host.describe(route).epoch,
				},
				route
			);
			const options = vi.mocked(dialog.showMessageBox).mock.calls[0][1];
			if (reason === 'cancel') await host.revoke(request.requestId);
			else if (reason === 'expire') now = request.expiresAt + 1;
			else await active.close();
			await vi.waitFor(() => expect(options.signal?.aborted).toBe(true));
			reply.resolve({ response: 1, checkboxChecked: false });
			await Promise.resolve();
			expect(host.localRequests().every((r) => r.pin === undefined)).toBe(true);
			expect(host.devices.list('host-id')).toEqual([]);
		}
	);

	it('opens disabled, lists mocked eligible interfaces, and requires explicit consent', async () => {
		const { invoke } = await local();
		expect(await invoke('state')).toMatchObject({
			enabled: false,
			advertising: false,
			endpoints: [endpoint],
			interfaces: availableLanInterfaces(),
		});
		expect(mocks.sockets).not.toHaveBeenCalled();
		await expect(invoke('enable', { ...enable, consent: false })).rejects.toThrow(
			'Explicit host consent'
		);
		await expect(
			invoke('enable', { ...enable, lan: true, interfaceAddress: '203.0.113.90' })
		).rejects.toThrow('eligible LAN interface');
		expect(mocks.sockets).not.toHaveBeenCalled();
	});
	it('creates one consent-scoped advertisement only on the selected eligible interface', async () => {
		vi.useFakeTimers();
		const { invoke } = await local();
		expect(
			await invoke('enable', { ...enable, lan: true, interfaceAddress: '192.0.2.10' })
		).toMatchObject({ enabled: true, advertising: true });
		const socket: MockSocket = mocks.sockets.mock.results[0].value;
		expect(socket.addMembership).toHaveBeenCalledWith('224.0.0.251', '192.0.2.10');
		expect(socket.setMulticastInterface).toHaveBeenCalledWith('192.0.2.10');
		await vi.advanceTimersByTimeAsync(1100);
		await invoke('stop');
		expect(socket.close).toHaveBeenCalled();
		expect(dns.decode(socket.packets.at(-1)!).answers?.every((row) => row.ttl === 0)).toBe(true);
		const count = socket.packets.length;
		await vi.advanceTimersByTimeAsync(8 * 60 * 60000 + 2 * 60000);
		expect(socket.packets.length).toBe(count);
		expect(await invoke('state')).toMatchObject({
			enabled: false,
			advertising: false,
			invitation: undefined,
		});
	});
	it('issues the codec invitation and a PNG QR, copies only explicitly and expires after five minutes', async () => {
		vi.useFakeTimers();
		const { invoke } = await local();
		const encode = vi.spyOn(QRCode, 'toDataURL');
		await invoke('enable', enable);
		const state = await invoke('invite');
		const invitation = state.invitation;
		expect(encode).toHaveBeenCalledWith(invitation.text, expect.objectContaining({ width: 320 }));
		expect(parseInvitation(invitation.text)).toMatchObject({
			id: 'host-id',
			name: 'Synthetic host',
			endpoint,
			expiresAt: Date.now() + 5 * 60000,
		});
		expect(invitation.qr).toMatch(/^data:image\/png;base64,/);
		expect(clipboard.writeText).not.toHaveBeenCalled();
		await invoke('copy-invitation');
		expect(clipboard.writeText).toHaveBeenCalledWith(invitation.text);
		await vi.advanceTimersByTimeAsync(5 * 60000);
		expect((await invoke('state')).invitation).toBeUndefined();
		await expect(invoke('copy-invitation')).rejects.toThrow('current invitation');
	});
	it('retains host-only PIN approval and revokes requests and invitations on close', async () => {
		const { invoke, window, shell: active } = await local();
		await invoke('enable', enable);
		const host = active.host!;
		const route = { endpoint, source: 'lan' as const };
		const capability = token();
		const request = host.begin(
			{
				clientName: 'Synthetic client',
				clientNonce: token(),
				capabilityHash: hash(capability),
				scope: 'host.control',
				epoch: host.describe(route).epoch,
			},
			route
		);
		expect(host.localRequests()[0].pin).toBeUndefined();
		await invoke('approve', { id: request.requestId });
		expect(host.localRequests()[0].pin).toMatch(/^\d{6}$/);
		await expect(invoke('confirm', { id: request.requestId })).rejects.toThrow('pin-issued');
		await invoke('invite');
		window.close();
		expect(active.host).toBeUndefined();
		expect(host.localRequests()).toEqual([]);
		expect(() => host.status(request.requestId, capability)).toThrow('unknown-request');
		expect(ipcMain.removeHandler).toHaveBeenCalledWith('litePairing:local');
	});
	it('revokes a synthetic metadata grant on stop without bypassing normal login', async () => {
		const { invoke, shell: active } = await local();
		await invoke('enable', enable);
		const api = Fastify();
		registerPairingRoutes(
			api,
			() => active.host,
			() => true,
			options.appVersion
		);
		const route = { endpoint, source: 'lan' as const };
		const transport: PairingTransport = {
			async call<T>(operation: string, payload: unknown) {
				const response = await api.inject({
					method: 'POST',
					url: PAIR_PATH + '/' + operation,
					headers: { host: new URL(endpoint).host },
					payload: { route, payload },
				});
				if (response.statusCode !== 200) throw new Error(response.json().error);
				return response.json() as T;
			},
		};
		const client = new PairingClient(transport, route, 'Synthetic Lite');
		try {
			await client.begin('host-id');
			const id = active.host!.localRequests()[0].requestId;
			await invoke('approve', { id });
			const pin = active.host!.localRequests()[0].pin!;
			await client.poll();
			await client.submit(pin);
			expect(client.snapshot().phase).toBe('awaiting-confirmation');
			await expect(client.read()).rejects.toThrow('not-paired');
			await invoke('confirm', { id });
			await client.poll();
			expect(await client.read()).toMatchObject({ name: 'Synthetic host', instanceId: 'host-id' });
			expect(client.snapshot().expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60 * 1000);
			await invoke('stop');
			await expect(client.read()).rejects.toThrow('pairing-disabled');
		} finally {
			await api.close();
		}
	});
	it('disposes asynchronously created hosts when setup was stopped', async () => {
		const { invoke, shell: active } = await local();
		const host = await PairingHost.create('Synthetic host', 'host-id', [endpoint]);
		let resolve!: (host: PairingHost) => void;
		vi.spyOn(PairingHost, 'create').mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const pending = invoke('enable', { ...enable, lan: true, interfaceAddress: '192.0.2.10' });
		await invoke('stop');
		resolve(host);
		await expect(pending).rejects.toThrow('Pairing cancelled');
		expect(active.host).toBeUndefined();
		expect(mocks.sockets).not.toHaveBeenCalled();
		expect(() => host.discoveryMetadata(endpoint, options.appVersion)).toThrow('route-mismatch');
	});
	it('expires attended mode and revokes a changed managed endpoint immediately', async () => {
		vi.useFakeTimers();
		let endpoints = [endpoint];
		const { invoke, shell: active } = await local({ ...options, endpoints: () => endpoints });
		await invoke('enable', enable);
		endpoints = ['https://changed.example.test'];
		expect(active.host).toBeUndefined();
		endpoints = [endpoint];
		await invoke('enable', enable);
		await vi.advanceTimersByTimeAsync(8 * 60 * 60000 + 2 * 60000);
		expect(active.host).toBeUndefined();
	});
	it('supports explicitly declared existing reverse proxy origins without provisioning', async () => {
		const { invoke, shell: active } = await local({ ...options, endpoints: () => [] });
		await expect(invoke('enable', enable)).rejects.toThrow();
		expect(active.host).toBeUndefined();
		await expect(
			invoke('enable', { ...enable, advanced: true, endpoint: endpoint + '/secret-token' })
		).rejects.toThrow('bare HTTPS');
		expect(await invoke('enable', { ...enable, advanced: true })).toMatchObject({ enabled: true });
		expect(active.host).toBeDefined();
		expect(mocks.sockets).not.toHaveBeenCalled();
	});
	it('rejects remote frames and late QR work after stop', async () => {
		const { invoke, handler, event } = await local();
		await expect(
			handler({ ...event, senderFrame: { url: event.senderFrame.url } } as never, 'state')
		).rejects.toThrow('Host-local');
		await invoke('enable', enable);
		const pending = invoke('invite');
		await invoke('stop');
		await expect(pending).rejects.toThrow('Pairing cancelled');
		expect((await invoke('state')).invitation).toBeUndefined();
	});
});

describe('mocked advertisement lifecycle', () => {
	it('withdraws on setup failure and ignores errors from a previously stopped socket', async () => {
		vi.useFakeTimers();
		const first = new MockSocket(),
			second = new MockSocket();
		const sockets = [first, second];
		const advertiser = new MdnsAdvertiser(() => sockets.shift()! as unknown as Socket);
		const failed = vi.fn();
		advertiser.start('192.0.2.10', 'host-id', 'Synthetic host', endpoint, failed);
		advertiser.start('192.0.2.10', 'host-id', 'Synthetic host', endpoint, failed);
		first.emit('error', new Error('late'));
		expect(second.close).not.toHaveBeenCalled();
		expect(failed).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1100);
		expect(second.packets.some((packet) => dns.decode(packet).type === 'response')).toBe(true);
		advertiser.stop();
		const broken = new MockSocket();
		broken.bind.mockImplementation(() => {
			throw new Error('mock bind denied');
		});
		const unavailable = new MdnsAdvertiser(() => broken as unknown as Socket);
		unavailable.start('192.0.2.10', 'host-id', 'Synthetic host', endpoint, failed);
		expect(broken.close).toHaveBeenCalled();
		expect(failed).toHaveBeenCalledWith('LAN advertisement unavailable on selected interface');
		unavailable.stop();
	});
});
