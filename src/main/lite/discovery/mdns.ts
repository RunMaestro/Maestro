import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import * as dns from 'dns-packet';
import { candidate, httpsOrigin, type Candidate, type DiscoveryAdapter } from './types';
export const SERVICE = '_maestro._tcp.local';
const GROUP = '224.0.0.251';
const normalize = (name: string) => name.replace(/\.$/, '').toLowerCase();
export type SocketFactory = () => Socket;
const socketFactory: SocketFactory = () => createSocket({ type: 'udp4', reuseAddr: true });
/** Cross-packet DNS-SD cache. Discovery is a location hint, never authorization. */
export class MdnsCache {
	private records = new Map<string, { record: dns.Record; until: number }>();
	constructor(private now = Date.now) {}
	ingest(bytes: Uint8Array): void {
		if (bytes.byteLength > 9000) return;
		let packet: dns.Packet;
		try {
			packet = dns.decode(bytes);
		} catch {
			return;
		}
		if (packet.type !== 'response') return;
		const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
		if (records.length > 128) return;
		const flushed = new Set<string>();
		for (const record of records) {
			if (!['PTR', 'SRV', 'TXT'].includes(record.type) || typeof record.name !== 'string') continue;
			const name = normalize(record.name);
			if (name !== SERVICE && !name.endsWith('.' + SERVICE)) continue;
			const set = name + ':' + record.type;
			const key = set + ':' + JSON.stringify(record.data);
			const ttl = record.ttl ?? 0;
			if (ttl === 0) {
				this.records.delete(key);
				continue;
			}
			if (!Number.isFinite(ttl) || ttl < 0) continue;
			if (record.flush && !flushed.has(set)) {
				for (const [old, value] of this.records)
					if (normalize(value.record.name) + ':' + value.record.type === set)
						this.records.delete(old);
				flushed.add(set);
			}
			if (this.records.size < 1024 || this.records.has(key))
				this.records.set(key, { record, until: this.now() + Math.min(ttl, 4500) * 1000 });
		}
	}
	rows(): Candidate[] {
		const now = this.now();
		for (const [key, value] of this.records) if (value.until <= now) this.records.delete(key);
		const all = [...this.records.values()];
		const rows: Candidate[] = [];
		for (const ptr of all.filter(
			(v) => v.record.type === 'PTR' && normalize(v.record.name) === SERVICE
		)) {
			if (typeof ptr.record.data !== 'string') continue;
			const instance = normalize(ptr.record.data);
			const srv = all.find((v) => v.record.type === 'SRV' && normalize(v.record.name) === instance);
			const txt = all.find((v) => v.record.type === 'TXT' && normalize(v.record.name) === instance);
			if (!srv || !txt || !Array.isArray(txt.record.data)) continue;
			const fields: Record<string, string> = Object.create(null);
			for (const value of txt.record.data) {
				if (!(value instanceof Uint8Array)) continue;
				const field = Buffer.from(value).toString('utf8');
				const equal = field.indexOf('=');
				if (equal > 0) fields[field.slice(0, equal)] = field.slice(equal + 1);
			}
			const data = srv.record.data as { target?: string; port?: number };
			if (
				fields.v !== '1' ||
				fields.tls !== '1' ||
				fields.pair !== '1' ||
				typeof data.target !== 'string' ||
				!Number.isInteger(data.port) ||
				data.port! < 1 ||
				data.port! > 65535
			)
				continue;
			try {
				rows.push(
					candidate(
						fields.id,
						fields.name,
						'https://' + data.target.replace(/\.$/, '') + ':' + data.port,
						'lan',
						Math.min(ptr.until, srv.until, txt.until)
					)
				);
			} catch {
				/* Malformed untrusted advert is not a candidate. */
			}
		}
		return rows;
	}
}
/** No socket exists until start. IPv4 membership is explicitly scoped; no IPv6/native provider is claimed. */
export class MdnsBrowser implements DiscoveryAdapter {
	private socket?: Socket;
	private tick?: ReturnType<typeof setInterval>;
	private query?: ReturnType<typeof setInterval>;
	private cancelStart?: () => void;
	constructor(
		private address: string,
		private sockets = socketFactory,
		private cache = new MdnsCache()
	) {
		if (!isIPv4(address) || address === '0.0.0.0')
			throw new Error('Choose an explicit IPv4 multicast interface');
	}
	async start(
		publish: (rows: Candidate[]) => void,
		failed: (message: string) => void
	): Promise<void> {
		this.stop();
		const socket = this.sockets();
		this.socket = socket;
		const send = () =>
			socket.send(
				dns.encode({ type: 'query', questions: [{ name: SERVICE, type: 'PTR' }] }),
				5353,
				GROUP,
				(error) => {
					if (error) {
						this.stop();
						failed('LAN query failed');
					}
				}
			);
		socket.on('message', (bytes) => {
			if (this.socket !== socket) return;
			this.cache.ingest(bytes);
			publish(this.cache.rows());
		});
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const fail = (error: unknown) => {
			if (this.socket !== socket) return;
			const code = (error as { code?: string })?.code;
			const message =
				code === 'EACCES' || code === 'EPERM'
					? 'LAN multicast permission denied; no permissions were changed'
					: 'LAN multicast unavailable on the selected interface';
			clearTimeout(timer);
			this.cancelStart = undefined;
			this.stop();
			failed(message);
			reject(new Error(message));
		};
		const timer = setTimeout(() => fail(new Error('timeout')), 5000);
		this.cancelStart = () => {
			clearTimeout(timer);
			reject(new Error('LAN discovery cancelled'));
		};
		socket.on('error', fail);
		try {
			socket.bind(5353, '0.0.0.0', () => {
				if (this.socket !== socket) return;
				try {
					socket.addMembership(GROUP, this.address);
					socket.setMulticastInterface(this.address);
					socket.setMulticastTTL(255);
					clearTimeout(timer);
					this.cancelStart = undefined;
					send();
					if (this.socket !== socket) {
						reject(new Error('LAN discovery query failed'));
						return;
					}
					this.query = setInterval(send, 60000);
					this.tick = setInterval(() => publish(this.cache.rows()), 1000);
					resolve();
				} catch (error) {
					fail(error);
				}
			});
		} catch (error) {
			fail(error);
		}
		await promise;
	}
	stop(): void {
		clearInterval(this.tick);
		clearInterval(this.query);
		this.cancelStart?.();
		this.cancelStart = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			try {
				socket.dropMembership(GROUP, this.address);
			} catch {
				/* May not have bound yet. */
			}
			try {
				socket.close();
			} catch {
				/* Already closed. */
			}
		}
	}
}
/** DNS-SD advert bytes for an existing TLS endpoint; no secret URL/token is published. */
export function advertisement(id: string, name: string, endpoint: string, ttl = 120): Buffer {
	const origin = new URL(httpsOrigin(endpoint));
	const row = candidate(id, name, origin.origin, 'lan', 0);
	const instance = row.id + '.' + SERVICE;
	return dns.encode({
		type: 'response',
		flags: 0x8400,
		answers: [
			{ name: SERVICE, type: 'PTR', ttl, data: instance },
			{
				name: instance,
				type: 'SRV',
				ttl,
				flush: true,
				data: { priority: 0, weight: 0, port: Number(origin.port || 443), target: origin.hostname },
			},
			{
				name: instance,
				type: 'TXT',
				ttl,
				flush: true,
				data: ['v=1', 'tls=1', 'pair=1', 'id=' + id, 'name=' + name].map((v) => Buffer.from(v)),
			},
		],
	});
}
