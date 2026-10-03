import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import packet from 'dns-packet';
import { DiscoveryCatalog, fromMdns, fromTailscale, fromRegistry, SERVICE } from '../discovery.mjs';
import { browseQuery, decodeAdvertisement } from '../mdns-wire.mjs';
const now = 1000;
const mdns = {
	type: SERVICE,
	name: 'Aster',
	target: 'aster.local',
	port: 8443,
	ttl: 120,
	txt: {
		v: '1',
		pair: '1',
		tls: '1',
		id: 'aster-demo',
		path: 'SENSITIVE_SYNTHETIC_VALUE',
		user: 'SENSITIVE_SYNTHETIC_VALUE',
	},
};
test('minimal LAN metadata, unsupported services and insecure adverts', () => {
	const rows = fromMdns(
		[mdns, { ...mdns, type: '_unrelated._tcp.local' }, { ...mdns, txt: { ...mdns.txt, tls: '0' } }],
		now
	);
	assert.deepEqual(rows, [
		{
			id: 'aster-demo',
			name: 'Aster',
			endpoint: 'https://aster.local:8443',
			source: 'lan',
			reachability: 'unverified',
			expiresAt: 121000,
		},
	]);
});
test('DNS-SD wire query/answer resolves PTR, SRV, TXT and honors goodbye TTL', () => {
	const query = packet.decode(browseQuery());
	assert.deepEqual(query.questions, [{ name: SERVICE, type: 'PTR', class: 'IN' }]);
	const instance = 'Aster.' + SERVICE;
	const records = [
		{ type: 'PTR', name: SERVICE, ttl: 120, data: instance },
		{
			type: 'SRV',
			name: instance,
			ttl: 120,
			data: { port: 8443, target: 'aster.local', priority: 0, weight: 0 },
		},
		{
			type: 'TXT',
			name: instance,
			ttl: 120,
			data: ['v=1', 'pair=1', 'tls=1', 'id=aster-demo'].map((value) => Buffer.from(value)),
		},
	];
	assert.equal(
		decodeAdvertisement(packet.encode({ type: 'response', answers: records }), now)[0].endpoint,
		'https://aster.local:8443'
	);
	records[0].ttl = 0;
	const catalog = new DiscoveryCatalog();
	catalog.replace(
		'lan',
		decodeAdvertisement(packet.encode({ type: 'response', answers: records }), now),
		now
	);
	assert.equal(catalog.list(now)[0].reachability, 'expired');
	assert.throws(() => decodeAdvertisement(new Uint8Array(3), now));
});
test('Tailscale requires a registered peer endpoint; peer-online is not service-ready', () => {
	const status = {
		BackendState: 'Running',
		Peer: {
			one: { ID: 'p1', DNSName: 'aster.demo.ts.net.', Online: true },
			two: { ID: 'p2', DNSName: 'cedar.demo.ts.net.', Online: false },
			unregistered: { ID: 'p3', DNSName: 'unused.demo.ts.net.', Online: true },
		},
	};
	const known = [
		{ peerId: 'p1', id: 'aster-demo', name: 'Aster', endpoint: 'https://aster.demo.ts.net' },
		{ peerId: 'p2', id: 'cedar-demo', name: 'Cedar', endpoint: 'https://cedar.demo.ts.net' },
		{ peerId: 'p1', id: 'spoof-demo', name: 'Spoof', endpoint: 'https://impostor.example.test' },
	];
	const rows = fromTailscale(status, known, now);
	assert.deepEqual(
		rows.map((row) => [row.id, row.reachability]),
		[
			['aster-demo', 'peer-online'],
			['cedar-demo', 'offline'],
		]
	);
});
test('Cloudflare registry rejects credentials, token paths, HTTP and expired invitations', () => {
	const entry = {
		id: 'aster-demo',
		name: 'Aster',
		endpoint: 'https://aster.example.test',
		kind: 'invitation',
		expiresAt: now + 10000,
	};
	const rows = fromRegistry(
		[
			entry,
			{ ...entry, endpoint: 'http://aster.example.test' },
			{ ...entry, endpoint: 'https://user:secret@aster.example.test' },
			{ ...entry, endpoint: entry.endpoint + '/secret' },
			{ ...entry, expiresAt: now },
		],
		now
	);
	assert.deepEqual(
		rows.map((row) => row.endpoint),
		[entry.endpoint]
	);
});
test('spoofed IDs/names remain separate untrusted routes; stale and offline selections fail', () => {
	const catalog = new DiscoveryCatalog();
	catalog.replace('lan', fromMdns([mdns], now), now);
	catalog.replace(
		'cloudflare',
		fromRegistry(
			[
				{
					id: 'aster-demo',
					name: 'Aster',
					endpoint: 'https://impostor.example.test',
					kind: 'invitation',
					expiresAt: now + 1000,
				},
			],
			now
		).map((row) => ({ ...row, trusted: true, user: 'SENSITIVE_SYNTHETIC_VALUE' })),
		now
	);
	const rows = catalog.list(now);
	assert.equal(rows.length, 2);
	assert.equal(
		rows.every((row) => row.trusted === false && !('user' in row)),
		true
	);
	assert.throws(
		() => catalog.select(rows.find((row) => row.source === 'cloudflare').key, now + 1000),
		/unavailable/
	);
	const old = rows[0].key;
	catalog.networkChanged();
	assert.deepEqual(catalog.list(now), []);
	assert.throws(() => catalog.select(old, now), /unavailable/);
	assert.equal(catalog.epoch, 2);
});
