/**
 * The one place the Web Login gate is enforced for ordinary HTTP requests.
 *
 * Registered ONCE as a global `preHandler` in `WebServer.setupMiddleware`, so a
 * route added later under `/<token>/` is gated the moment it is registered
 * rather than whenever somebody remembers to decorate it. That direction
 * matters: a per-route opt-in fails OPEN, and the route that forgets the
 * decorator is the one nobody notices until it is serving somebody else's
 * transcript.
 *
 * The allow-list below is therefore the whole surface a browser can reach
 * without a session cookie, and each entry earns its place:
 *
 * - The index routes (`/<token>`, `/<token>/desktop`, `/<token>/session/:id`)
 *   serve HTML, so `serveDesktopIndex` answers them with a 302 to the login
 *   page. A 401 JSON body there would render as a wall of text instead of a
 *   form.
 * - `/<token>/login` and `/<token>/auth/*` ARE the login flow. Gating them is
 *   a locked door with the key inside.
 * - `manifest.json`, `sw.js`, `icons/`, `desktop/assets/` are static assets
 *   with no user data in them, and they have to load for the login page and
 *   the PWA install to work at all.
 * - `/<token>/ws` closes the socket with {@link WEB_LOGIN_WS_CLOSE_CODE}
 *   itself (see `wsRoute.ts`), which is what tells the browser to go to the
 *   login page rather than reconnect forever.
 *
 * Routes outside the token prefix (`/`, `/health`, `/og.png`) and the Concerto
 * routes (a different, read-only token) are never touched.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
	isWebLoginEnabled,
	isWebRequestAuthorized,
	resolveWebRequestAuth,
} from './web-login-policy';

/** Path suffixes under `/<token>` that are reachable without a session. */
const ALLOWED_EXACT = new Set([
	'',
	'/',
	'/login',
	'/desktop',
	'/desktop/',
	'/manifest.json',
	'/sw.js',
	'/ws',
]);

/** Path prefixes under `/<token>` that are reachable without a session. */
const ALLOWED_PREFIXES = ['/auth/', '/icons/', '/desktop/assets/', '/session/'];

/** Strip the query string and any trailing fragment - only the path is matched. */
function pathOf(url: string): string {
	const q = url.indexOf('?');
	const path = q === -1 ? url : url.slice(0, q);
	const h = path.indexOf('#');
	return h === -1 ? path : path.slice(0, h);
}

/**
 * Whether `url` is one of the paths a browser may reach under `/<token>` with
 * no session cookie. Anything outside the token prefix answers `true` as well:
 * this hook only speaks for the token-scoped surface.
 */
export function isUnauthenticatedWebPath(token: string, url: string): boolean {
	const path = pathOf(url);
	const prefix = `/${token}`;
	if (path !== prefix && !path.startsWith(`${prefix}/`)) return true;
	const rest = path.slice(prefix.length);
	if (ALLOWED_EXACT.has(rest)) return true;
	return ALLOWED_PREFIXES.some((p) => rest.startsWith(p));
}

/**
 * Build the global `preHandler` for a server serving `token`.
 *
 * Returns without resolving anything when the Encore flag is off, which is
 * both the common case and what keeps the users store off the hot path of
 * every request on an installation that never turns Web Login on.
 */
export function webLoginPreHandler(
	token: string
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
	return async (request, reply) => {
		if (!isWebLoginEnabled()) return;
		if (isUnauthenticatedWebPath(token, request.url ?? '')) return;
		if (isWebRequestAuthorized(resolveWebRequestAuth(request))) return;
		await reply.code(401).send({ error: 'Unauthorized', message: 'Login required' });
	};
}
