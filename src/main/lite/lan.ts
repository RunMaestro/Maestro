import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { TAILNET_PORT } from './tailnet-origin';

/** Direct Lite access uses the same application port on separate network interfaces. */
export const LAN_PORT = TAILNET_PORT;

/** Accept canonical IPv4 addresses only within the RFC 1918 private address ranges. */
export function lanIPv4(value: unknown): value is string {
	if (typeof value !== 'string' || !isIPv4(value)) return false;
	const [a, b] = value.split('.').map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Only explicit private IPv4 addresses are accepted; DNS and alternate IPv4 spellings cannot redirect access. */
export function lanOrigin(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!new RegExp('^http://\\d+\\.\\d+\\.\\d+\\.\\d+:' + LAN_PORT + '/?$').test(value)
	)
		throw new Error('Direct LAN access requires a private IPv4 address on the Maestro port.');
	const url = new URL(value);
	if (
		!lanIPv4(url.hostname) ||
		url.port !== String(LAN_PORT) ||
		(value !== url.origin && value !== url.origin + '/')
	)
		throw new Error('Direct LAN access requires a private IPv4 address on the Maestro port.');
	return url.origin;
}

/** A valid contiguous interface netmask must place both private addresses on the same network. */
export function sameLanSubnet(peer: unknown, local: { address: string; netmask: string }): boolean {
	if (!lanIPv4(local.address) || !lanIPv4(peer) || !isIPv4(local.netmask)) return false;
	const mask = local.netmask.split('.').map(Number);
	const bits = mask.map((part) => part.toString(2).padStart(8, '0')).join('');
	if (!/^1+0*$/.test(bits)) return false;
	const address = local.address.split('.').map(Number),
		remote = peer.split('.').map(Number);
	return mask.every((part, i) => (address[i] & part) === (remote[i] & part));
}

/** Resolve an explicitly selected eligible address against the current operating-system interfaces. */
export function lanInterface(
	address: string
): { name: string; address: string; netmask: string } | undefined {
	for (const [name, entries] of Object.entries(networkInterfaces()))
		for (const entry of entries ?? [])
			if (
				!entry.internal &&
				entry.family === 'IPv4' &&
				entry.address === address &&
				sameLanSubnet(address, entry)
			)
				return { name, address, netmask: entry.netmask };
}

/** Bind to the matching private interface with the longest netmask, keeping the first eligible tie. */
export async function lanDestination(
	origin: string,
	signal?: AbortSignal
): Promise<{ hostname: string; port: number; localAddress: string }> {
	if (signal?.aborted) throw new Error('Connection canceled.');
	const url = new URL(lanOrigin(origin));
	let localAddress: string | undefined;
	let longestMask = -1;
	for (const entries of Object.values(networkInterfaces()))
		for (const entry of entries ?? []) {
			if (!entry.internal && entry.family === 'IPv4' && sameLanSubnet(url.hostname, entry)) {
				// sameLanSubnet validates contiguous masks, so their unsigned values rank prefix length.
				const mask = entry.netmask
					.split('.')
					.reduce((value, part) => value * 256 + Number(part), 0);
				if (mask > longestMask) {
					longestMask = mask;
					localAddress = entry.address;
				}
			}
		}
	if (localAddress) return { hostname: url.hostname, port: LAN_PORT, localAddress };
	throw new Error(
		'This host is not on an active private local network. Connect both computers to the same LAN.'
	);
}
