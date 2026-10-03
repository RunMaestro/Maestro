// Entirely invented fixtures. No system configuration, device inventory or network reads.
import { DiscoveryCatalog, fromMdns, fromTailscale, fromRegistry, SERVICE } from './discovery.mjs';
import { PairingHost } from './pairing.mjs';
export async function demoFixtures() {
	let offset = 0;
	const now = () => Date.now() + offset;
	const advance = (milliseconds) => {
		offset += milliseconds;
	};
	const aster = await PairingHost.create({
		name: 'Aster studio',
		endpoints: [
			'https://aster.local:8443',
			'https://aster.demo.ts.net',
			'https://aster.example.test',
		],
		now,
	});
	const willow = await PairingHost.create({
		name: 'Willow lab',
		endpoints: ['https://willow.example.test'],
		now,
	});
	const forged = await PairingHost.create({
		name: 'Aster studio',
		endpoints: ['https://lookalike.example.test'],
		now,
	});
	const catalog = new DiscoveryCatalog();
	const offline = new Set();
	const peers = {
		BackendState: 'Running',
		Peer: {
			'nodekey:synthetic-aster': {
				ID: 'demo-aster-peer',
				DNSName: 'aster.demo.ts.net.',
				Online: true,
			},
			'nodekey:synthetic-cedar': {
				ID: 'demo-cedar-peer',
				DNSName: 'cedar.demo.ts.net.',
				Online: false,
			},
		},
	};
	const known = [
		{
			peerId: 'demo-aster-peer',
			id: 'aster-demo',
			name: 'Aster studio',
			endpoint: 'https://aster.demo.ts.net',
		},
		{
			peerId: 'demo-cedar-peer',
			id: 'cedar-demo',
			name: 'Cedar office',
			endpoint: 'https://cedar.demo.ts.net',
		},
	];
	const registry = [
		{
			id: 'aster-demo',
			name: 'Aster studio',
			endpoint: 'https://aster.example.test',
			kind: 'registered',
			expiresAt: now() + 300000,
		},
		{
			id: 'willow-demo',
			name: 'Willow lab',
			endpoint: 'https://willow.example.test',
			kind: 'invitation',
			expiresAt: now() + 180000,
		},
	];
	const hosts = new Map([
		['https://aster.local:8443', aster],
		['https://aster.demo.ts.net', aster],
		['https://aster.example.test', aster],
		['https://willow.example.test', willow],
		['https://lookalike.example.test', forged],
	]);
	function refresh() {
		catalog.replace(
			'lan',
			fromMdns(
				[
					{
						type: SERVICE,
						name: 'Aster studio',
						target: 'aster.local',
						port: 8443,
						ttl: 120,
						txt: { v: '1', pair: '1', tls: '1', id: 'aster-demo' },
					},
				],
				now()
			),
			now()
		);
		catalog.replace('tailscale', fromTailscale(peers, known, now()), now());
		catalog.replace('cloudflare', fromRegistry(registry, now()), now());
	}
	function hostFor(row) {
		if (row.epoch !== catalog.epoch || offline.has(row.endpoint) || !hosts.has(row.endpoint))
			throw Object.assign(new Error('offline'), { code: 'offline' });
		return hosts.get(row.endpoint);
	}
	function networkChanged() {
		catalog.networkChanged();
		for (const host of new Set(hosts.values())) host.networkChanged();
	}
	function addSpoof() {
		registry.push({
			id: 'aster-demo',
			name: 'Aster studio',
			endpoint: 'https://lookalike.example.test',
			kind: 'invitation',
			expiresAt: now() + 180000,
		});
		refresh();
	}
	refresh();
	return {
		now,
		advance,
		catalog,
		aster,
		willow,
		refresh,
		hostFor,
		networkChanged,
		offline,
		addSpoof,
	};
}
