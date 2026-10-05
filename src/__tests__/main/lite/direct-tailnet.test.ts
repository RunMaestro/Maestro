import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const fixture = vi.hoisted(() => ({ status: '', address: '100.64.0.10' }));
vi.mock('../../../main/lite/discovery/tailscale', () => ({
	readTailscaleStatus: vi.fn(async () => fixture.status),
}));
vi.mock('node:os', async (original) => ({
	...(await original<typeof import('node:os')>()),
	networkInterfaces: () => ({ tail: [{ address: fixture.address }] }),
}));
import { readTailnet, tailnetDestination } from '../../../main/lite/tailnet';
import { directTailnetOrigin } from '../../../main/lite/tailnet-origin';
import { DirectTailnetHost } from '../../../main/lite/pairing/direct-tailnet';
import { PairedDevices } from '../../../main/lite/pairing/paired-devices';
let directory: string;
const hosts: DirectTailnetHost[] = [];
const state = (changes: Record<string, unknown> = {}) =>
	JSON.stringify({
		BackendState: 'Running',
		Self: { ID: 'host-node', Online: true, TailscaleIPs: ['100.64.0.10'] },
		CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
		Peer: {
			client: {
				ID: 'client-node',
				Online: true,
				DNSName: 'lite.synthetic.ts.net',
				TailscaleIPs: ['100.64.0.20'],
			},
		},
		...changes,
	});
beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), 'maestro-direct-'));
	fixture.status = state();
	fixture.address = '100.64.0.10';
});
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
	await rm(directory, { recursive: true, force: true });
});
async function host() {
	const h = new DirectTailnetHost(
		directory,
		new PairedDevices(directory),
		'aster',
		'Aster',
		() => 56036
	);
	hosts.push(h);
	await h.initialize();
	return h;
}
describe('direct tailnet transport and consent', () => {
	it.each([
		'http://127.0.0.1:56036',
		'http://192.168.1.2:56036',
		'http://100.128.0.1:56036',
		'http://host.synthetic.ts.net:56036',
		'http://100.64.0.1:80',
		'http://100.64.0.1:56036/secret',
		'http://user:pass@100.64.0.1:56036',
	])('rejects noncanonical or non-tailnet endpoint %s', (url) => {
		expect(() => directTailnetOrigin(url)).toThrow();
	});
	it('uses only current online daemon peers and an assigned local Tailscale interface', async () => {
		expect(
			await tailnetDestination('http://100.64.0.20:56036', new AbortController().signal)
		).toMatchObject({
			hostname: '100.64.0.20',
			localAddress: '100.64.0.10',
			peerId: 'client-node',
		});
		await expect(
			tailnetDestination('http://100.64.0.99:56036', new AbortController().signal)
		).rejects.toThrow('online peer');
		fixture.address = '192.0.2.10';
		await expect(readTailnet(new AbortController().signal)).rejects.toThrow('interface');
	});
	it('restores explicit consent and requires real socket endpoints, not forwarded aliases', async () => {
		const first = await host();
		await expect(first.enable(false)).rejects.toThrow();
		expect(first.host).toBeUndefined();
		await expect(
			readFile(path.join(directory, 'lite-tailnet-access.json'), 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
		await first.enable(true);
		expect(first.host?.isPublishedRequest('100.64.0.10:56036', '100.64.0.20', '100.64.0.10')).toBe(
			true
		);
		expect(first.host?.isPublishedRequest('100.64.0.10:56036', '192.0.2.20', '100.64.0.10')).toBe(
			false
		);
		expect(first.host?.isPublishedRequest('100.64.0.10:56036', '100.64.0.20', '127.0.0.1')).toBe(
			false
		);
		await first.close();
		const restored = await host();
		expect(
			restored.host?.discoveryMetadata('http://100.64.0.10:56036', '0.18.6-RC').instanceId
		).toBe('aster');
		await restored.disable();
		expect(restored.host).toBeUndefined();
		expect(
			JSON.parse(await readFile(path.join(directory, 'lite-tailnet-access.json'), 'utf8')).enabled
		).toBe(false);
		expect((await host()).host).toBeUndefined();
	});
	it('closes access on offline/device drift and recovers only the original consented network', async () => {
		const h = await host();
		await h.enable(true);
		fixture.status = state({ BackendState: 'Stopped' });
		await h.refresh();
		expect(h.host).toBeUndefined();
		fixture.status = state({
			Self: { ID: 'other-node', Online: true, TailscaleIPs: ['100.64.0.10'] },
		});
		await h.refresh();
		expect(h.host).toBeUndefined();
		fixture.status = state();
		await h.refresh();
		expect(h.host?.isPublishedRequest('100.64.0.10:56036', '100.64.0.20', '100.64.0.10')).toBe(
			true
		);
	});
});
