import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

/** Enumerate existing IPv4 interfaces; no route, firewall or network settings changes. */
export function availableLanInterfaces(): { name: string; address: string }[] {
	const found = new Map<string, { name: string; address: string }>();
	for (const [name, entries] of Object.entries(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (
				entry.internal ||
				entry.family !== 'IPv4' ||
				!isIPv4(entry.address) ||
				entry.address === '0.0.0.0'
			)
				continue;
			// Tailscale's routed address space does not carry link-local mDNS.
			const [a, b] = entry.address.split('.').map(Number);
			if (a === 100 && b >= 64 && b <= 127) continue;
			found.set(entry.address, { name, address: entry.address });
		}
	}
	return [...found.values()];
}
