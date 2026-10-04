/**
 * Origin guard for the embedded web server (issue #1710).
 *
 * The server's token lives in the URL path, so the browser's Same-Origin Policy
 * is the only thing standing between "a page that learned the URL" and full
 * control of Maestro. Two things used to defeat it: CORS reflected every
 * `Origin` (including `null` from `file://` pages), and the WebSocket handshake,
 * which CORS never governs, did not look at `Origin` at all.
 *
 * Every page the server legitimately serves (the web interface, over LAN, the
 * Cloudflare tunnel, or localhost) is loaded FROM this server, so its requests
 * are same-origin: the `Origin` header names the same host the request was sent
 * to. Anything else is a foreign page and is refused before it reaches a route.
 *
 * A request with NO `Origin` header is allowed. Browsers always send one on a
 * WebSocket handshake and on every cross-origin fetch, so its absence means a
 * non-browser client (`maestro-cli`, curl, a native app) or a same-origin GET,
 * none of which the Same-Origin Policy was ever protecting against.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'WebServer:Origin';

/**
 * Whether a request carrying `origin` and sent to `host` comes from a page this
 * server served. `origin` is the raw `Origin` header (undefined when absent),
 * `host` the raw `Host` header.
 */
export function isTrustedRequestOrigin(
	origin: string | undefined,
	host: string | undefined
): boolean {
	if (origin === undefined) return true;
	// `null` is what sandboxed frames and file:// pages send. Never trust it.
	if (!host || origin === 'null') return false;

	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

	// URL.host drops the scheme's default port, matching what a browser puts in
	// the Host header (`example.com`, not `example.com:443`).
	return parsed.host.toLowerCase() === host.trim().toLowerCase();
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/**
 * Refuse every request (HTTP and the WebSocket upgrade alike) whose `Origin`
 * is not this server. Register it AFTER `@fastify/websocket` (whose own
 * onRequest hook marks an upgrade so the plugin destroys the socket once the
 * 403 is written; replying ahead of it leaks every refused handshake's socket)
 * and BEFORE CORS, rate limiting, and the routes.
 */
export function registerOriginGuard(server: FastifyInstance): void {
	server.addHook('onRequest', async (request: FastifyRequest, reply) => {
		const origin = headerValue(request.headers.origin);
		if (isTrustedRequestOrigin(origin, request.headers.host)) return;

		logger.warn(`Rejected cross-origin request from ${origin} to ${request.method}`, LOG_CONTEXT);
		return reply.code(403).send({
			statusCode: 403,
			error: 'Forbidden',
			message: 'Cross-origin requests are not allowed',
		});
	});
}
