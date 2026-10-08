/**
 * Network egress policy for the `net:fetch` capability (main process).
 *
 * Hostname-string scope matching in the broker is NOT enough: a name can resolve
 * to a private/loopback/metadata address (SSRF), or resolve to a public IP at
 * check time and a private one at connect time (DNS rebinding). This guard:
 *  - classifies a resolved IP and BLOCKS loopback, link-local (incl. the cloud
 *    metadata IP 169.254.169.254), RFC1918, unspecified, IPv6 ULA, and unwraps
 *    IPv4-mapped IPv6 before classifying;
 *  - blocks an injected set of ports (the app's own loopback web-server port,
 *    so plugin code can never reach it even on a public-looking host);
 *  - resolves the hostname and refuses if ANY candidate address is blocked
 *    (pre-connect check);
 *  - exposes a validating `lookup` so the actual socket connect is pinned to a
 *    validated address - the connected IP is the one we checked, which is what
 *    defeats rebinding (there is no second, unchecked resolution).
 *
 * Pure given an injected resolver, so the policy is unit-testable without a
 * network stack. The undici dispatcher (socket-level pin) is built lazily and is
 * optional; the pre-connect check is the always-on gate.
 */

import * as dns from 'dns';
import * as net from 'net';

/** Node lookup callback shape consumed by undici's connector. */
export type GuardedLookup = (
	hostname: string,
	options: { all?: boolean; family?: number } | undefined,
	callback: (
		err: NodeJS.ErrnoException | null,
		address: string | Array<{ address: string; family: number }>,
		family?: number
	) => void
) => void;

export interface EgressGuard {
	/** Resolve + validate a URL's host and port. Rejects with a descriptive
	 * Error when the scheme, port, or any resolved address is disallowed. */
	assertUrlAllowed(url: string): Promise<void>;
	/** A validating lookup to pin the connect to a checked address. */
	readonly lookup: GuardedLookup;
	/** Optional undici dispatcher built from `lookup` (socket-level rebind pin). */
	readonly dispatcher?: unknown;
}

export interface EgressGuardDeps {
	/** Resolve a hostname to candidate IP strings. INJECTED for tests; defaults
	 * to dns.promises.lookup(host, { all: true }). */
	resolve?: (hostname: string) => Promise<string[]>;
	/** Ports that must never be reachable (the app's own loopback web port). */
	blockedPorts?: () => readonly number[];
	/** Build the connect-pinning dispatcher from the validating lookup. Defaults
	 * to an undici Agent; returns undefined when undici is unavailable. */
	makeDispatcher?: (lookup: GuardedLookup) => unknown;
}

/** Parse the four octets of a dotted-quad IPv4, or undefined when not IPv4. */
function ipv4Octets(ip: string): [number, number, number, number] | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return undefined;
	const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
	if (o.some((n) => n > 255)) return undefined;
	return [o[0], o[1], o[2], o[3]];
}

/** Classify an IPv4 address (octets) - loopback / private / metadata / etc, or
 * null when it is a routable public address. */
function classifyV4(o: readonly number[]): string | null {
	const [a, b, c, d] = o;
	if (a === 0) return 'unspecified/this-network';
	if (a === 127) return 'loopback';
	if (a === 10) return 'RFC1918 private';
	if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private';
	if (a === 192 && b === 168) return 'RFC1918 private';
	if (a === 169 && b === 254) {
		return c === 169 && d === 254 ? 'cloud metadata' : 'link-local';
	}
	if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
	if (a >= 224) return 'multicast/reserved';
	return null;
}

/** Expand a validated IPv6 literal to its 16 bytes, decoding an embedded
 * dotted-quad (IPv4-mapped / -compatible) tail. Returns null when `ip` is not a
 * valid IPv6 literal. Working from bytes lets us classify EVERY form of an
 * IPv4-mapped address uniformly (dotted `::ffff:1.2.3.4`, hex `::ffff:7f00:1`, or
 * fully expanded), instead of a string match an attacker can dodge - and it will
 * not mis-unwrap a public address that merely ends in `ffff:...` because the high
 * bytes are checked. */
function ipv6ToBytes(ip: string): number[] | null {
	if (net.isIP(ip) !== 6) return null;
	const expand = (segment: string): number[] | null => {
		if (segment === '') return [];
		const out: number[] = [];
		const parts = segment.split(':');
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i];
			if (part.includes('.')) {
				// An embedded dotted-quad is only valid as the final group.
				if (i !== parts.length - 1) return null;
				const v4 = ipv4Octets(part);
				if (!v4) return null;
				out.push(v4[0], v4[1], v4[2], v4[3]);
			} else {
				if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
				const n = parseInt(part, 16);
				out.push((n >> 8) & 0xff, n & 0xff);
			}
		}
		return out;
	};
	const dc = ip.indexOf('::');
	let bytes: number[];
	if (dc >= 0) {
		const head = expand(ip.slice(0, dc));
		const tail = expand(ip.slice(dc + 2));
		if (!head || !tail) return null;
		const gap = 16 - head.length - tail.length;
		if (gap < 0) return null;
		bytes = [...head, ...new Array<number>(gap).fill(0), ...tail];
	} else {
		const all = expand(ip);
		if (!all) return null;
		bytes = all;
	}
	return bytes.length === 16 ? bytes : null;
}

/**
 * Classify a blocked address, returning a human-readable reason or null when the
 * address is allowed (a routable public address). Unparseable input is blocked
 * (fail-closed). IPv4-mapped / -compatible IPv6 (in ANY textual form) is decoded
 * to its embedded v4 and classified there, so a private/loopback/metadata v4
 * cannot be smuggled through a v6 form.
 */
export function classifyBlockedAddress(input: string): string | null {
	let ip = input.trim().toLowerCase();
	// Strip a zone id (fe80::1%eth0) and brackets.
	const pct = ip.indexOf('%');
	if (pct >= 0) ip = ip.slice(0, pct);
	ip = ip.replace(/^\[/, '').replace(/\]$/, '');

	const v4 = ipv4Octets(ip);
	if (v4) return classifyV4(v4);

	const bytes = ipv6ToBytes(ip);
	if (!bytes) return 'unresolvable address';

	const high10Zero = bytes.slice(0, 10).every((x) => x === 0);
	// IPv4-mapped ::ffff:a.b.c.d -> classify the embedded v4.
	if (high10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
		return classifyV4([bytes[12], bytes[13], bytes[14], bytes[15]]);
	}
	// IPv4-compatible ::a.b.c.d (deprecated) -> classify the embedded v4, except the
	// reserved :: and ::1 which are handled as IPv6 specials below.
	if (high10Zero && bytes[10] === 0 && bytes[11] === 0) {
		const lo = [bytes[12], bytes[13], bytes[14], bytes[15]];
		const reserved = lo[0] === 0 && lo[1] === 0 && lo[2] === 0 && (lo[3] === 0 || lo[3] === 1);
		if (!reserved) return classifyV4(lo);
	}

	// Pure IPv6 specials, derived from bytes (robust to any textual form).
	if (bytes.every((x) => x === 0)) return 'unspecified';
	if (
		high10Zero &&
		bytes[10] === 0 &&
		bytes[11] === 0 &&
		bytes[12] === 0 &&
		bytes[13] === 0 &&
		bytes[14] === 0 &&
		bytes[15] === 1
	) {
		return 'loopback';
	}
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local'; // fe80::/10
	if ((bytes[0] & 0xfe) === 0xfc) return 'IPv6 unique-local'; // fc00::/7
	if (bytes[0] === 0xff) return 'IPv6 multicast'; // ff00::/8
	return null;
}

/** Build a lookup that resolves, validates EVERY candidate, and yields only
 * checked addresses (so the connected IP is one we vetted). */
export function createGuardedLookup(
	resolve: (hostname: string) => Promise<string[]>
): GuardedLookup {
	return (hostname, options, callback): void => {
		void resolve(hostname)
			.then((addresses) => {
				if (!addresses || addresses.length === 0) {
					callback(new Error(`egress blocked: ${hostname} did not resolve`), '', 0);
					return;
				}
				const entries: Array<{ address: string; family: number }> = [];
				for (const addr of addresses) {
					const reason = classifyBlockedAddress(addr);
					if (reason) {
						callback(
							new Error(`egress blocked: ${hostname} resolved to ${reason} (${addr})`),
							'',
							0
						);
						return;
					}
					entries.push({ address: addr, family: net.isIP(addr) === 6 ? 6 : 4 });
				}
				if (options?.all) {
					callback(null, entries);
				} else {
					callback(null, entries[0].address, entries[0].family);
				}
			})
			.catch((err: unknown) => {
				callback(err instanceof Error ? err : new Error(String(err)), '', 0);
			});
	};
}

function defaultResolve(hostname: string): Promise<string[]> {
	return dns.promises
		.lookup(hostname, { all: true })
		.then((records) => records.map((r) => r.address));
}

function defaultMakeDispatcher(lookup: GuardedLookup): unknown {
	try {
		// undici ships with Node and Electron; built lazily so unit tests that
		// never fetch do not require it, and a missing module degrades to the
		// always-on pre-connect check rather than throwing.
		const undici = require('undici') as { Agent: new (opts: unknown) => unknown };
		return new undici.Agent({ connect: { lookup } });
	} catch {
		return undefined;
	}
}

export function createEgressGuard(deps: EgressGuardDeps = {}): EgressGuard {
	const resolve = deps.resolve ?? defaultResolve;
	const blockedPorts = deps.blockedPorts ?? ((): readonly number[] => []);
	const lookup = createGuardedLookup(resolve);
	const makeDispatcher = deps.makeDispatcher ?? defaultMakeDispatcher;
	const dispatcher = makeDispatcher(lookup);

	const assertUrlAllowed = async (rawUrl: string): Promise<void> => {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new Error('invalid url');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error(`unsupported url scheme: ${url.protocol}`);
		}
		const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
		if (blockedPorts().includes(port)) {
			throw new Error(`egress blocked: port ${port} is not reachable`);
		}
		const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
		// A literal IP needs no resolution; validate it directly.
		if (net.isIP(host) !== 0) {
			const reason = classifyBlockedAddress(host);
			if (reason) throw new Error(`egress blocked: ${reason} (${host})`);
			return;
		}
		const addresses = await resolve(host);
		if (!addresses || addresses.length === 0) {
			throw new Error(`egress blocked: ${host} did not resolve`);
		}
		for (const addr of addresses) {
			const reason = classifyBlockedAddress(addr);
			if (reason) throw new Error(`egress blocked: ${host} resolved to ${reason} (${addr})`);
		}
	};

	return {
		assertUrlAllowed,
		lookup,
		...(dispatcher !== undefined ? { dispatcher } : {}),
	};
}
