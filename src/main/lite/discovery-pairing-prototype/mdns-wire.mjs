// PROTOTYPE Node adapter: DNS wire-format ingestion, deliberately no dgram/socket import.
import { Buffer } from 'node:buffer';
import packet from 'dns-packet';
import { SERVICE, fromMdns } from './discovery.mjs';
export function browseQuery() {
	return packet.encode({ type: 'query', questions: [{ type: 'PTR', name: SERVICE }] });
}
export function decodeAdvertisement(bytes, now) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength > 9000)
		throw new Error('Invalid mDNS datagram');
	const decoded = packet.decode(Buffer.from(bytes));
	if (decoded.type !== 'response') return [];
	const records = [...(decoded.answers ?? []), ...(decoded.additionals ?? [])];
	if (records.length > 64) throw new Error('Oversized mDNS answer');
	const output = [];
	for (const ptr of records.filter(
		(row) => row.type === 'PTR' && row.name.replace(/\.$/, '') === SERVICE
	)) {
		const srv = records.find((row) => row.type === 'SRV' && row.name === ptr.data);
		const txt = records.find((row) => row.type === 'TXT' && row.name === ptr.data);
		if (!srv || !txt || !ptr.data.endsWith('.' + SERVICE)) continue;
		const fields = {};
		for (const raw of txt.data) {
			const text = Buffer.from(raw).toString('utf8');
			const split = text.indexOf('=');
			if (split < 1 || text.length > 255) continue;
			const key = text.slice(0, split);
			if (['v', 'pair', 'tls', 'id'].includes(key) && !(key in fields))
				fields[key] = text.slice(split + 1);
		}
		output.push({
			type: SERVICE,
			name: ptr.data.slice(0, -SERVICE.length - 1),
			target: srv.data.target,
			port: srv.data.port,
			ttl: Math.min(ptr.ttl, srv.ttl, txt.ttl),
			txt: fields,
		});
	}
	return fromMdns(output, now);
}
