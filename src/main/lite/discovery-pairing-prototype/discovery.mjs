/* global URL */
// PROTOTYPE: passive inputs only. No sockets, subprocesses, probes or persistence.
export const SERVICE = '_maestro._tcp.local';
const SOURCES = new Set(['lan', 'tailscale', 'cloudflare']);
export function origin(value) {
	if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid endpoint');
	const url = new URL(value);
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('A bare HTTPS origin is required; no tokens, paths or downgrade');
	return url.origin;
}
export function label(value) {
	if (typeof value !== 'string' || !value.trim() || value.length > 64)
		throw new Error('Invalid display name');
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127 || char === '/' || char === '\\')
			throw new Error('Invalid display name');
	}
	return value.trim();
}
function id(value) {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value))
		throw new Error('Invalid discovery ID');
	return value;
}
function candidate(value, source, now, ttl = 120) {
	const lifetime = Math.max(0, Math.min(300, Number(ttl)));
	if (!Number.isFinite(lifetime)) throw new Error('Invalid TTL');
	return {
		id: id(value.id),
		name: label(value.name),
		endpoint: origin(value.endpoint),
		source,
		reachability: value.offline ? 'offline' : source === 'tailscale' ? 'peer-online' : 'unverified',
		expiresAt: now + lifetime * 1000,
	};
}
// Input is resolved DNS-SD data, as delivered by an OS browser or mdns-wire.mjs.
export function fromMdns(records, now) {
	if (!Array.isArray(records) || records.length > 64) throw new Error('Oversized DNS-SD result');
	return records.flatMap((record) => {
		if (
			record.type !== SERVICE ||
			record.txt?.v !== '1' ||
			record.txt?.pair !== '1' ||
			record.txt?.tls !== '1'
		)
			return [];
		try {
			if (
				!/^[a-zA-Z0-9.-]+\.local\.?$/.test(record.target) ||
				!Number.isInteger(record.port) ||
				record.port < 1 ||
				record.port > 65535
			)
				return [];
			return [
				candidate(
					{
						id: record.txt.id,
						name: record.name,
						endpoint: 'https://' + record.target.replace(/\.$/, '') + ':' + record.port,
					},
					'lan',
					now,
					record.ttl
				),
			];
		} catch {
			return [];
		}
	});
}
// Join to a deliberately supplied known-host registry. Never probe every peer.
export function fromTailscale(status, knownHosts, now) {
	if (!Array.isArray(knownHosts) || knownHosts.length > 64)
		throw new Error('Oversized known-host registry');
	const peers = Object.values(status?.Peer ?? {});
	if (peers.length > 10000) throw new Error('Oversized peer metadata');
	const byId = new Map(peers.map((peer) => [peer.ID, peer]));
	return knownHosts.flatMap((known) => {
		const peer = byId.get(known.peerId);
		if (!peer) return [];
		try {
			const endpoint = origin(known.endpoint);
			if (new URL(endpoint).hostname !== String(peer.DNSName).toLowerCase().replace(/\.$/, ''))
				return [];
			return [
				candidate(
					{
						...known,
						endpoint,
						offline: status.BackendState !== 'Running' || peer.Online !== true,
					},
					'tailscale',
					now
				),
			];
		} catch {
			return [];
		}
	});
}
// Invitations are untrusted location hints, NOT a credential or an authority to connect.
export function fromRegistry(entries, now) {
	if (!Array.isArray(entries) || entries.length > 64) throw new Error('Oversized host registry');
	return entries.flatMap((entry) => {
		if (
			!Number.isFinite(entry.expiresAt) ||
			entry.expiresAt <= now ||
			!['registered', 'invitation'].includes(entry.kind)
		)
			return [];
		try {
			return [candidate(entry, 'cloudflare', now, (entry.expiresAt - now) / 1000)];
		} catch {
			return [];
		}
	});
}
export class DiscoveryCatalog {
	#sources = new Map();
	#epoch = 1;
	get epoch() {
		return this.#epoch;
	}
	replace(source, candidates, now) {
		if (!SOURCES.has(source) || candidates.length > 64) throw new Error('Invalid discovery source');
		// Re-project at the seam: caller extras cannot leak into the view or establish trust.
		this.#sources.set(
			source,
			candidates.map((row) => {
				if (row.source !== source || !Number.isFinite(row.expiresAt))
					throw new Error('Invalid candidate');
				return {
					id: id(row.id),
					name: label(row.name),
					endpoint: origin(row.endpoint),
					source,
					reachability: ['offline', 'peer-online', 'unverified'].includes(row.reachability)
						? row.reachability
						: 'unverified',
					expiresAt: Math.min(row.expiresAt, now + 300000),
					epoch: this.#epoch,
				};
			})
		);
	}
	networkChanged() {
		this.#epoch++;
		this.#sources.clear();
	}
	list(now) {
		const rows = new Map();
		for (const source of this.#sources.values())
			for (const row of source) {
				const key = row.source + ':' + row.endpoint;
				rows.set(key, {
					...row,
					key,
					reachability: row.expiresAt <= now ? 'expired' : row.reachability,
					trusted: false,
				});
			}
		return [...rows.values()].sort(
			(a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
		);
	}
	select(key, now) {
		const row = this.list(now).find((item) => item.key === key);
		if (!row || ['offline', 'expired'].includes(row.reachability))
			throw new Error('Host unavailable; refresh or choose another registered transport');
		return row;
	}
}
