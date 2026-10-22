import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request } from 'node:https';
import * as dns from 'dns-packet';

const network = vi.hoisted(() => ({
	interfaces: {} as ReturnType<typeof import('node:os').networkInterfaces>,
}));
vi.mock('node:os', async (original) => ({
	...(await original<typeof import('node:os')>()),
	networkInterfaces: () => network.interfaces,
}));
vi.mock('../../../main/lite/tailnet', () => ({
	tailnetDestination: vi.fn(async () => {
		throw new Error('Tailscale must not be consulted for LAN');
	}),
}));
import {
	lanDestination,
	lanInterface,
	lanIPv4,
	lanOrigin,
	sameLanSubnet,
} from '../../../main/lite/lan';
import { tailnetDestination } from '../../../main/lite/tailnet';
import { candidate } from '../../../main/lite/discovery/types';
import { advertisement, MdnsCache } from '../../../main/lite/discovery/mdns';
import { probeService } from '../../../main/lite/discovery/probe';
import { pairingTransport } from '../../../main/lite/pairing/transport';
import { PairingClient } from '../../../main/lite/pairing/client';
import { CONNECTION } from '../../../main/lite/pairing/protocol';
import { DiscoveryController } from '../../../main/lite/discovery/controller';
import type { DeviceCredentials } from '../../../main/lite/device-credentials';
import { LITE_SETUP_REVISION } from '../../../shared/lite-discovery';

const origin = 'http://192.168.1.20:56036';
beforeEach(() => {
	network.interfaces = {
		ethernet: [
			{
				family: 'IPv4',
				address: '192.168.1.10',
				netmask: '255.255.255.0',
				internal: false,
				mac: '00:00:00:00:00:01',
				cidr: '192.168.1.10/24',
			},
		],
		tailnet: [
			{
				family: 'IPv4',
				address: '100.64.0.10',
				netmask: '255.255.255.255',
				internal: false,
				mac: '00:00:00:00:00:02',
				cidr: '100.64.0.10/32',
			},
		],
	};
	vi.mocked(tailnetDestination).mockClear();
});

describe('explicit LAN destination policy', () => {
	it.each(['10.0.0.2', '172.16.0.2', '172.31.255.254', '192.168.0.2'])(
		'accepts private IPv4 %s',
		(address) => {
			expect(lanIPv4(address)).toBe(true);
			expect(lanOrigin('http://' + address + ':56036/')).toBe('http://' + address + ':56036');
		}
	);
	it.each([
		'http://127.0.0.1:56036',
		'http://100.64.0.1:56036',
		'http://172.32.0.1:56036',
		'http://192.0.2.1:56036',
		'http://169.254.1.1:56036',
		'http://maestro.local:56036',
		'http://3232235796:56036',
		'http://192.168.01.20:56036',
		'http://192.168.1.20:80',
		'http://192.168.1.20:56036/path',
		'http://user@192.168.1.20:56036',
		'http://192.168.1.20:56036?token=x',
		'https://192.168.1.20:56036',
		' http://192.168.1.20:56036',
	])('rejects noncanonical or nonprivate LAN origin %s', (value) => {
		expect(() => lanOrigin(value)).toThrow();
	});
	it('binds only an eligible current interface on the destination subnet', async () => {
		expect(lanInterface('192.168.1.10')).toEqual({
			name: 'ethernet',
			address: '192.168.1.10',
			netmask: '255.255.255.0',
		});
		expect(lanInterface('100.64.0.10')).toBeUndefined();
		expect(await lanDestination(origin)).toEqual({
			hostname: '192.168.1.20',
			port: 56036,
			localAddress: '192.168.1.10',
		});
		await expect(lanDestination('http://192.168.2.20:56036')).rejects.toThrow('same LAN');
		network.interfaces.ethernet![0].address = '192.168.2.10';
		expect(lanInterface('192.168.1.10')).toBeUndefined();
		await expect(lanDestination(origin)).rejects.toThrow('same LAN');
		expect(tailnetDestination).not.toHaveBeenCalled();
	});
	it.each([
		['10.0.0.2', '255.0.0.0', '10.2.3.10', '10.2.3.20', false],
		['10.0.0.2', '255.0.0.0', '10.2.3.10', '10.2.3.20', true],
		['172.16.0.2', '255.240.0.0', '172.20.3.10', '172.20.3.20', false],
		['172.16.0.2', '255.240.0.0', '172.20.3.10', '172.20.3.20', true],
	] as const)(
		'prefers the matching /24 over %s/%s using %s for %s (broad first: %s)',
		async (broadAddress, broadMask, specificAddress, destination, broadFirst) => {
			const base = network.interfaces.ethernet![0];
			const broad = { ...base, address: broadAddress, netmask: broadMask, cidr: null };
			const specific = { ...base, address: specificAddress, cidr: specificAddress + '/24' };
			network.interfaces = broadFirst
				? { vpn: [broad], ethernet: [specific] }
				: { ethernet: [specific], vpn: [broad] };
			expect(await lanDestination('http://' + destination + ':56036/')).toEqual({
				hostname: destination,
				port: 56036,
				localAddress: specificAddress,
			});
		}
	);
	it('keeps the first equally specific eligible interface and ignores ineligible longer masks', async () => {
		const base = network.interfaces.ethernet![0];
		network.interfaces = {
			ineligible: [
				{ ...base, address: '192.168.1.20', netmask: '255.255.255.255', internal: true },
				{ ...base, address: '192.168.1.20', netmask: '255.255.255.1' },
				{ ...base, address: '192.168.2.20', netmask: '255.255.255.255' },
				{
					...base,
					family: 'IPv6',
					address: 'fd00::20',
					netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
					cidr: 'fd00::20/128',
					scopeid: 0,
				},
			],
			first: [base],
			second: [{ ...base, address: '192.168.1.11', cidr: '192.168.1.11/24' }],
		};
		expect(await lanDestination(origin)).toEqual({
			hostname: '192.168.1.20',
			port: 56036,
			localAddress: '192.168.1.10',
		});
	});
	it('rejects invalid netmasks, foreign/private subnets and canceled connections', async () => {
		expect(
			sameLanSubnet('192.168.1.20', { address: '192.168.1.10', netmask: '255.255.255.0' })
		).toBe(true);
		for (const netmask of ['255.0.255.0', '0.0.0.0', 'not-a-mask']) {
			expect(sameLanSubnet('192.168.1.20', { address: '192.168.1.10', netmask })).toBe(false);
			network.interfaces.ethernet![0].netmask = netmask;
			await expect(lanDestination(origin)).rejects.toThrow('same LAN');
		}
		expect(sameLanSubnet('10.0.0.20', { address: '192.168.1.10', netmask: '255.255.255.0' })).toBe(
			false
		);
		const abort = new AbortController();
		abort.abort();
		await expect(lanDestination(origin, abort.signal)).rejects.toThrow('canceled');
	});
});

describe('LAN discovery and pairing without Tailscale', () => {
	it('reconnects a discovered LAN host with its saved device admission and cancels the selected connection', async () => {
		const row = {
			...candidate('host-id', 'Work computer', origin, 'lan', Date.now() + 60000),
			availability: 'ready' as const,
			connection: CONNECTION,
		};
		const credential = 'A'.repeat(43) + '.' + 'B'.repeat(43);
		const get = vi.fn(async () => credential),
			connected = vi.fn(),
			revoked = vi.fn();
		const controller = new DiscoveryController(
			() => {},
			() => [],
			connected,
			revoked,
			{ get } as unknown as DeviceCredentials
		);
		vi.spyOn(controller.discovery, 'select').mockReturnValue(row);
		await controller.control('pair-request', { key: row.key, generation: 1 });
		expect(get).toHaveBeenCalledWith(row.id, origin, undefined);
		expect(connected).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: expect.objectContaining({
					transport: 'lan',
					instanceId: row.id,
					url: origin + CONNECTION.path,
				}),
				credential,
			})
		);
		await controller.control('pair-cancel', undefined);
		expect(revoked).toHaveBeenCalledWith('cancelled');
		connected.mockClear();
		get.mockClear();
		network.interfaces.ethernet![0].address = '192.168.2.10';
		await expect(
			controller.control('pair-request', { key: row.key, generation: 1 })
		).rejects.toThrow('same LAN');
		expect(get).not.toHaveBeenCalled();
		expect(connected).not.toHaveBeenCalled();
		expect(tailnetDestination).not.toHaveBeenCalled();
		controller.close();
	});
	it('round trips a private LAN advertisement and rejects untrusted public HTTP advertisements', () => {
		const cache = new MdnsCache();
		const bytes = advertisement('host-id', 'Work computer', origin);
		cache.ingest(bytes);
		expect(cache.rows()).toEqual([expect.objectContaining({ endpoint: origin, source: 'lan' })]);
		const packet = dns.decode(bytes);
		const srv = packet.answers!.find((record) => record.type === 'SRV')!;
		(srv.data as { target: string }).target = '192.0.2.20';
		cache.ingest(dns.encode(packet));
		expect(cache.rows()).toEqual([]);
		const secure = new MdnsCache();
		secure.ingest(advertisement('host-id', 'Work computer', 'https://host.example.test'));
		expect(secure.rows()[0].endpoint).toBe('https://host.example.test');
	});
	it('reports a LAN connection failure to pairing when the discovered interface disappears', async () => {
		const row = candidate('host-id', 'Work computer', origin, 'lan', Date.now() + 60000);
		const send = vi.fn<typeof request>();
		const client = new PairingClient(pairingTransport(row, send), row, 'Lite');
		network.interfaces = {};
		await expect(client.begin(row.id)).rejects.toThrow('lan-connection-failed');
		expect(client.snapshot().error).toBe('lan-connection-failed');
		expect(send).not.toHaveBeenCalled();
		expect(tailnetDestination).not.toHaveBeenCalled();
	});
	it.each(['before binding', 'while binding'])(
		'preserves cancellation when a LAN destination fails %s',
		async (timing) => {
			const row = candidate('host-id', 'Work computer', origin, 'lan', Date.now() + 60000);
			const send = vi.fn<typeof request>();
			const abort = new AbortController();
			network.interfaces = {};
			if (timing === 'before binding') abort.abort();
			const result = pairingTransport(row, send).call('describe', {}, abort.signal);
			if (timing === 'while binding') abort.abort();
			await expect(result).rejects.toThrow('cancelled');
			expect(send).not.toHaveBeenCalled();
			expect(tailnetDestination).not.toHaveBeenCalled();
		}
	);
	it('binds manifest probes and pairing calls to LAN and does not contact foreign subnets', async () => {
		const row = candidate('host-id', 'Work computer', origin, 'lan', Date.now() + 60000);
		const manifest = {
			protocol: 'maestro-discovery',
			version: 1,
			appVersion: require('../../../../package.json').version,
			setupRevision: LITE_SETUP_REVISION,
			instanceId: row.id,
			name: row.name,
			pairing: { protocol: 'maestro-device-pairing/1', scope: 'host.control', enabled: true },
			capabilities: ['host.control'],
			connection: {
				path: '/.well-known/maestro/connect',
				authentication: 'device-pairing',
				admission: 'device',
				capabilities: ['sessions', 'terminal', 'files', 'browserRelay'],
			},
		};
		const calls = vi.fn((url: string, options: unknown) => ({ url, options }));
		const send = ((
			url: string,
			options: unknown,
			callback: (response: PassThrough & { statusCode: number }) => void
		) => {
			calls(url, options);
			const req = Object.assign(new EventEmitter(), {
				destroy() {},
				end() {
					const response = Object.assign(new PassThrough(), { statusCode: 200 });
					callback(response);
					response.end(JSON.stringify(manifest));
					req.emit('close');
				},
			});
			return req;
		}) as unknown as typeof request;
		expect((await probeService(row, new AbortController().signal, send)).availability).toBe(
			'ready'
		);
		await pairingTransport(row, send).call('describe', {});
		expect(calls).toHaveBeenCalledTimes(2);
		for (const [, options] of calls.mock.calls)
			expect(options).toMatchObject({
				hostname: '192.168.1.20',
				port: 56036,
				localAddress: '192.168.1.10',
			});
		const foreign = candidate(
			'host-id',
			'Work computer',
			'http://192.168.2.20:56036',
			'lan',
			Date.now() + 60000
		);
		expect((await probeService(foreign, new AbortController().signal, send)).availability).toBe(
			'unreachable'
		);
		await expect(pairingTransport(foreign, send).call('describe', {})).rejects.toThrow(
			'lan-connection-failed'
		);
		expect(calls).toHaveBeenCalledTimes(2);
		expect(tailnetDestination).not.toHaveBeenCalled();
	});
});
