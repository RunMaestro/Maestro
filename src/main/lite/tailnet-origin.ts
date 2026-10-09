import { isIP } from 'node:net';

/** The one direct-tailnet port. Other HTTP destinations are never accepted. */
export const TAILNET_PORT = 56036;
export function tailnetIPv4(value: unknown): value is string {
	if (typeof value !== 'string' || isIP(value) !== 4) return false;
	const [a, b] = value.split('.').map(Number);
	return a === 100 && b >= 64 && b <= 127;
}
export function directTailnetOrigin(value: unknown): string {
	if (typeof value !== 'string' || value.length > 256)
		throw new Error('Invalid direct Tailscale endpoint.');
	const url = new URL(value);
	if (
		url.protocol !== 'http:' ||
		!tailnetIPv4(url.hostname) ||
		url.port !== String(TAILNET_PORT) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('Direct access requires a Tailscale IP on the Maestro port.');
	return url.origin;
}
