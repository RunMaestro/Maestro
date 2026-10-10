/**
 * The credential that lets `maestro-cli` through the Web Login gate.
 *
 * The gate cannot exempt "local" callers by peer address: the Cloudflare
 * tunnel (`cloudflared tunnel --url http://localhost:<port>`) and any reverse
 * proxy on the same machine deliver every REMOTE request over a loopback
 * connection, so a `127.0.0.1` check would wave the whole internet through
 * the moment Remote Control is on - which is exactly the path a login is
 * meant to protect.
 *
 * So the CLI presents something a remote caller cannot have: a per-boot
 * secret written into `cli-server.json`, which lives in the user's own data
 * directory and is readable only by processes running as that user. The CLI
 * sends it as a request header on the WebSocket upgrade; nothing else on the
 * server reads or forwards it, and a browser cannot set custom headers on an
 * upgrade at all.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

let secret: string | null = null;

/** The secret for this process, minted on first use. */
export function getCliSecret(): string {
	if (!secret) secret = randomBytes(32).toString('hex');
	return secret;
}

/** Constant-time check of a presented value against the process secret. */
export function isCliSecret(presented: string | string[] | undefined): boolean {
	if (typeof presented !== 'string' || presented.length === 0) return false;
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(getCliSecret()).digest();
	return timingSafeEqual(a, b);
}

/** Test seam. */
export function resetCliSecretForTests(): void {
	secret = null;
}
