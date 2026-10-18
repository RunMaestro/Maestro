import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
const fixture = vi.hoisted(() => ({
	address: '192.168.20.10',
	netmask: '255.255.255.0',
	name: 'Ethernet',
	available: true,
	advertise: vi.fn(),
	stopAdvertising: vi.fn(),
}));
vi.mock('node:os', async (original) => ({
	...(await original<typeof import('node:os')>()),
	networkInterfaces: () =>
		fixture.available
			? {
					[fixture.name]: [
						{ address: fixture.address, netmask: fixture.netmask, family: 'IPv4', internal: false },
					],
				}
			: {},
}));
vi.mock('../../../main/lite/discovery/advertiser', () => ({
	MdnsAdvertiser: class {
		start = fixture.advertise;
		stop = fixture.stopAdvertising;
	},
}));
vi.mock('../../../main/utils/atomic-json-store', async (original) => {
	const module = await original<typeof import('../../../main/utils/atomic-json-store')>();
	return { ...module, atomicWriteFile: vi.fn(module.atomicWriteFile) };
});
import { DirectLanHost } from '../../../main/lite/pairing/direct-lan';
import { PairedDevices } from '../../../main/lite/pairing/paired-devices';
import { PairingHost } from '../../../main/lite/pairing/host';
import { registerPairingRoutes } from '../../../main/lite/pairing/routes';
import { PairingClient } from '../../../main/lite/pairing/client';
import {
	PAIR_PATH,
	token,
	type PairingTransport,
	type Route,
} from '../../../main/lite/pairing/protocol';
import { atomicWriteFile } from '../../../main/utils/atomic-json-store';
let directory: string;
const hosts: DirectLanHost[] = [];
const endpoint = 'http://192.168.20.10:56036';
beforeEach(async () => {
	vi.clearAllMocks();
	fixture.address = '192.168.20.10';
	fixture.netmask = '255.255.255.0';
	fixture.name = 'Ethernet';
	fixture.available = true;
	const scratch = path.join(process.cwd(), '.maestro', 'scratch');
	await mkdir(scratch, { recursive: true });
	directory = await mkdtemp(path.join(scratch, 'direct-lan-'));
});
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
	await rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});
/** Initialize a host with injected listener/availability controls and register it for teardown. */
async function host(
	listen = vi.fn(async (_address: string) => vi.fn(async () => {})),
	available = () => true
) {
	const h = new DirectLanHost(
		directory,
		new PairedDevices(directory),
		'aster',
		'Aster',
		listen,
		undefined,
		available
	);
	hosts.push(h);
	await h.initialize();
	return { h, listen };
}
describe('direct LAN host consent and admission', () => {
	it('requires explicit consent and an existing private interface before opening or saving access', async () => {
		const { h, listen } = await host();
		await expect(h.enable(false, fixture.address)).rejects.toThrow('explicitly allow');
		await expect(h.enable(true, '0.0.0.0')).rejects.toThrow('eligible private');
		await expect(h.enable(true, '100.64.0.10')).rejects.toThrow('eligible private');
		await expect(h.enable(true, '192.168.20.99')).rejects.toThrow('eligible private');
		expect(h.host).toBeUndefined();
		expect(listen).not.toHaveBeenCalled();
		expect(fixture.advertise).not.toHaveBeenCalled();
		await expect(readFile(path.join(directory, 'lite-lan-access.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
	it('binds and advertises only the selected interface and accepts real same-subnet socket endpoints', async () => {
		const { h, listen } = await host();
		await h.enable(true, fixture.address);
		expect(listen).toHaveBeenCalledExactlyOnceWith('192.168.20.10');
		expect(fixture.advertise).toHaveBeenCalledWith(
			'192.168.20.10',
			'aster',
			'Aster',
			endpoint,
			expect.any(Function)
		);
		expect(h.state).toMatchObject({
			enabled: true,
			ready: true,
			origin: endpoint,
			interfaceAddress: fixture.address,
		});
		const published = (
			remote: string,
			local = fixture.address,
			authority = '192.168.20.10:56036'
		) => h.host!.isPublishedRequest(authority, remote, local);
		expect(published('192.168.20.20')).toBe(true);
		expect(published('::ffff:192.168.20.20', '::ffff:192.168.20.10')).toBe(true);
		expect(published('192.168.21.20')).toBe(false);
		expect(published('127.0.0.1')).toBe(false);
		expect(published('100.64.0.20')).toBe(false);
		expect(published('192.168.20.20', '127.0.0.1')).toBe(false);
		expect(published('192.168.20.20', fixture.address, 'other.example:56036')).toBe(false);
		expect(h.host!.describe({ endpoint, source: 'lan' }).instanceId).toBe('aster');
		expect(() => h.host!.describe({ endpoint, source: 'tailscale' })).toThrow('route-mismatch');
		await expect(PairingHost.create('Aster', 'aster', [endpoint])).rejects.toThrow(
			'policy-required'
		);
	});
	it('restores acknowledged consent, retains device authorization through shutdown, and persists disable', async () => {
		const first = await host();
		await first.h.enable(true, fixture.address);
		const credential = token() + '.' + token();
		await first.h.host!.devices.add(credential, 'Lite', 'aster', endpoint);
		expect(
			first.h.host!.authorizeConnection(
				credential,
				'192.168.20.10:56036',
				'192.168.20.20',
				fixture.address
			)
		).toBe(true);
		await first.h.close();
		const restored = await host();
		expect(restored.h.state.ready).toBe(true);
		expect(
			restored.h.host!.authorizeConnection(
				credential,
				'192.168.20.10:56036',
				'192.168.20.20',
				fixture.address
			)
		).toBe(true);
		await restored.h.host!.devices.revoke(credential.split('.')[0]);
		expect(
			restored.h.host!.authorizeConnection(
				credential,
				'192.168.20.10:56036',
				'192.168.20.20',
				fixture.address
			)
		).toBe(false);
		await restored.h.disable();
		expect(restored.h.host).toBeUndefined();
		expect(
			JSON.parse(await readFile(path.join(directory, 'lite-lan-access.json'), 'utf8')).enabled
		).toBe(false);
		expect((await host()).h.state.enabled).toBe(false);
	});
	it.each(['address', 'netmask', 'name', 'available'] as const)(
		'rejects requests immediately when the consented interface %s changes and recovers the original network',
		async (field) => {
			const { h, listen } = await host();
			await h.enable(true, fixture.address);
			const admittedHost = h.host!;
			const previous = fixture[field];
			if (field === 'address') fixture.address = '192.168.30.10';
			if (field === 'netmask') fixture.netmask = '255.255.0.0';
			if (field === 'name') fixture.name = 'Another Ethernet';
			if (field === 'available') fixture.available = false;
			expect(h.host).toBeUndefined();
			expect(
				admittedHost.isPublishedRequest('192.168.20.10:56036', '192.168.20.20', '192.168.20.10')
			).toBe(false);
			await h.refresh();
			expect(h.state.ready).toBe(false);
			expect(fixture.stopAdvertising).toHaveBeenCalled();
			const stop = await listen.mock.results[0].value;
			expect(stop).toHaveBeenCalledOnce();
			Object.assign(fixture, { [field]: previous });
			await h.refresh();
			expect(h.state.ready).toBe(true);
		}
	);
	it('cannot activate while another mode is enabled', async () => {
		const { h, listen } = await host(undefined, () => false);
		await expect(h.enable(true, fixture.address)).rejects.toThrow(
			'Disable direct Tailscale or HTTPS'
		);
		expect(listen).not.toHaveBeenCalled();
	});
	it('keeps a listener failure closed and usable for a later retry', async () => {
		const listen = vi.fn(async (_address: string) => vi.fn(async () => {}));
		listen.mockRejectedValueOnce(new Error('Port unavailable'));
		const { h } = await host(listen);
		await h.enable(true, fixture.address);
		expect(h.state).toMatchObject({ enabled: true, ready: false, message: 'Port unavailable' });
		expect(h.host).toBeUndefined();
		await h.refresh();
		expect(h.state.ready).toBe(true);
	});
	it('retries a failed LAN announcement without reopening the listener or losing access', async () => {
		fixture.advertise.mockImplementationOnce((_address, _id, _name, _origin, failed) =>
			failed('LAN advertisement unavailable')
		);
		const { h, listen } = await host();
		await h.enable(true, fixture.address);
		expect(h.state.ready).toBe(true);
		expect(h.advertising).toBe(false);
		expect(h.state.message).toContain('LAN advertisement unavailable');
		await h.refresh();
		expect(h.advertising).toBe(true);
		expect(listen).toHaveBeenCalledOnce();
		expect(fixture.advertise).toHaveBeenCalledTimes(2);
	});
	it('persists disable after a racing consent write and closes a pending listener startup', async () => {
		const { h, listen } = await host();
		let finishWrite!: () => void;
		const persist = vi.mocked(atomicWriteFile).getMockImplementation()!;
		vi.mocked(atomicWriteFile).mockImplementationOnce(async (...args) => {
			await persist(...args);
			await new Promise<void>((resolve) => (finishWrite = resolve));
		});
		const enabling = h.enable(true, fixture.address);
		const cancelled = expect(enabling).rejects.toThrow('cancelled');
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
		const disabling = h.disable();
		finishWrite();
		await Promise.all([cancelled, disabling]);
		expect(h.host).toBeUndefined();
		expect(listen).not.toHaveBeenCalled();
		expect(
			JSON.parse(await readFile(path.join(directory, 'lite-lan-access.json'), 'utf8')).enabled
		).toBe(false);
		let finishListen!: (close: () => Promise<void>) => void;
		listen.mockImplementationOnce(() => new Promise((resolve) => (finishListen = resolve)));
		const again = h.enable(true, fixture.address);
		await vi.waitFor(() => expect(finishListen).toBeTypeOf('function'));
		const close = vi.fn(async () => {});
		const stopped = h.disable();
		finishListen(close);
		await Promise.all([again, stopped]);
		expect(close).toHaveBeenCalledOnce();
		expect(h.host).toBeUndefined();
	});
	it('requires the existing host PIN approval and confirmation before device admission over LAN', async () => {
		const { h } = await host();
		await h.enable(true, fixture.address);
		const app = Fastify();
		app.addHook('onRequest', (request, _reply, done) => {
			Object.defineProperty(request.raw.socket, 'localAddress', {
				value: fixture.address,
				configurable: true,
			});
			done();
		});
		registerPairingRoutes(
			app,
			() => h.host,
			() => true,
			'1.1.0-RC'
		);
		const route: Route = { endpoint, source: 'lan' };
		const transport: PairingTransport = {
			async call<T>(operation: string, payload: unknown) {
				const response = await app.inject({
					method: 'POST',
					url: PAIR_PATH + '/' + operation,
					headers: { host: '192.168.20.10:56036' },
					remoteAddress: '192.168.20.20',
					payload: { route, payload },
				});
				if (response.statusCode !== 200) throw new Error(response.json().error);
				return response.json() as T;
			},
		};
		try {
			const client = new PairingClient(transport, route, 'Lite');
			await client.begin('aster');
			expect(client.snapshot().phase).toBe('awaiting-host');
			expect(h.host!.devices.list('aster')).toEqual([]);
			const id = h.host!.localRequests()[0].requestId;
			h.host!.approvePin(id);
			await client.poll();
			await client.submit(h.host!.localRequests()[0].pin!);
			expect(h.host!.devices.list('aster')).toEqual([]);
			h.host!.confirm(id);
			await client.poll();
			expect(client.snapshot().phase).toBe('paired');
			expect(h.host!.devices.list('aster')).toHaveLength(1);
			await h.host!.revoke(id);
			expect(h.host!.devices.list('aster')).toEqual([]);
		} finally {
			await app.close();
		}
	});
});
