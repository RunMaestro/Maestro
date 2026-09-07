/**
 * Network Utilities
 *
 * Provides utilities for network-related operations, including
 * detecting the local IP address that routes to the internet.
 */

import { networkInterfaces } from 'os';
import * as dgram from 'dgram';

/**
 * Get the local IP address that routes to the internet.
 *
 * This uses a UDP socket to connect to an external IP (8.8.8.8 - Google DNS)
 * without actually sending data. The OS will pick the right interface,
 * and we can get the local address from the socket.
 *
 * Falls back to scanning network interfaces if the UDP approach fails.
 *
 * @returns Promise resolving to the local IP address, or 'localhost' if none found
 */
export async function getLocalIpAddress(): Promise<string> {
	// Try UDP socket approach first - most reliable
	try {
		const ip = await getIpViaUdp();
		if (ip && ip !== '127.0.0.1') {
			return ip;
		}
	} catch {
		// Fall through to interface scanning
	}

	// Fall back to scanning network interfaces
	return getIpFromInterfaces();
}

/**
 * Get local IP by creating a UDP socket that "connects" to an external address.
 * The OS routes the connection and we can read which local IP it would use.
 */
function getIpViaUdp(): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket('udp4');
		let settled = false;

		const cleanup = () => {
			if (!settled) {
				settled = true;
				socket.removeAllListeners();
				try {
					socket.close();
				} catch {
					// Ignore close errors
				}
			}
		};

		socket.on('error', (err) => {
			if (settled) return;
			cleanup();
			reject(err);
		});

		// Connect to Google DNS - doesn't actually send data
		socket.connect(53, '8.8.8.8', () => {
			if (settled) return;
			try {
				const address = socket.address();
				cleanup();
				resolve(address.address);
			} catch (err) {
				cleanup();
				reject(err);
			}
		});

		// Timeout after 1 second
		setTimeout(() => {
			if (settled) return;
			cleanup();
			reject(new Error('Timeout'));
		}, 1000);
	});
}

/**
 * Get local IP by scanning network interfaces.
 * Prefers interfaces that look like they connect to the internet.
 */
function getIpFromInterfaces(): string {
	const candidates = rankedIpv4Candidates();
	if (candidates.length === 0) {
		return 'localhost';
	}
	return candidates[0].ip;
}

/**
 * Every usable IPv4 address, sorted best-routing first. The one scoring pass
 * behind both `getIpFromInterfaces` (takes the head) and
 * `listLocalIpv4Addresses` (takes all of it).
 */
function rankedIpv4Candidates(): Array<{ ip: string; priority: number }> {
	const interfaces = networkInterfaces();
	const candidates: Array<{ ip: string; priority: number }> = [];

	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;

		for (const addr of addrs) {
			// Skip internal and non-IPv4 addresses
			if (addr.internal || addr.family !== 'IPv4') continue;
			if (addr.address === '127.0.0.1') continue;

			// Prioritize interfaces that are likely to route to internet
			let priority = 0;

			// Ethernet interfaces (en0, eth0) get highest priority
			if (/^(en|eth)\d+$/.test(name)) {
				priority = 100;
			}
			// WiFi interfaces
			else if (/wifi|wlan|wl/i.test(name)) {
				priority = 90;
			}
			// Bridge interfaces (common on Mac for internet sharing)
			else if (/bridge/i.test(name)) {
				priority = 50;
			}
			// Virtual interfaces get lower priority
			else if (/veth|docker|vmnet|vbox|tun|tap/i.test(name)) {
				priority = 10;
			}
			// Other interfaces
			else {
				priority = 30;
			}

			// Private IP ranges are preferred over other ranges
			if (isPrivateIp(addr.address)) {
				priority += 5;
			}

			candidates.push({ ip: addr.address, priority });
		}
	}

	// Sort by priority (highest first) so the head is the best route out.
	candidates.sort((a, b) => b.priority - a.priority);
	return candidates;
}

/**
 * Check if an IP address is in a private range
 */
function isPrivateIp(ip: string): boolean {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4) return false;

	// 10.0.0.0 - 10.255.255.255
	if (parts[0] === 10) return true;

	// 172.16.0.0 - 172.31.255.255
	if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

	// 192.168.0.0 - 192.168.255.255
	if (parts[0] === 192 && parts[1] === 168) return true;

	return false;
}

/**
 * Synchronous version that only uses interface scanning.
 * Use this when async is not available.
 */
export function getLocalIpAddressSync(): string {
	return getIpFromInterfaces();
}

/**
 * Every non-internal IPv4 address on this machine, best-routing first.
 *
 * `getLocalIpAddress` answers "which one address should I advertise"; this
 * answers "which addresses could someone reach me on", which is a different
 * question with a different right answer. A machine on WiFi and a Tailscale-style
 * overlay at the same time has two working addresses, and a pairing QR code that
 * offered only the highest-priority one would send a phone that is on the overlay
 * but not the WiFi to a relay for a connection it could have had directly.
 *
 * Ordering reuses the same interface-priority scoring as the single-address
 * picker, so the two can never disagree about which address is the primary one.
 */
export function listLocalIpv4Addresses(): string[] {
	return rankedIpv4Candidates().map((candidate) => candidate.ip);
}
