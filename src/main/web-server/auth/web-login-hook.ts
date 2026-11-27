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
 *
 * A request is read twice, and it skips the session check only when both
 * readings say it may (see {@link isUnauthenticatedWebRequest}): the route the
 * router matched, which is the handler that will run however the target was
 * spelled, and the target itself, decoded the way the router decodes it.
 * Comparing the raw target alone let `/%74oken/api/...` and
 * `http://any-host/<token>/api/...` through: the router runs the gated handler
 * for both, and neither string starts with `/<token>`.
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

/** Whether `path` is the token root or a path under it. */
function isUnderToken(token: string, path: string): boolean {
	const prefix = `/${token}`;
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Whether a plain path (no query string, no escapes) is open: outside the
 * token prefix, or on the allow-list under it. Also reads a route pattern
 * (`/<token>/session/:sessionId`, `/<token>/icons/*`) as it was registered.
 */
function isOpenPath(token: string, path: string): boolean {
	if (!isUnderToken(token, path)) return true;
	const rest = path.slice(token.length + 1);
	if (ALLOWED_EXACT.has(rest)) return true;
	return ALLOWED_PREFIXES.some((p) => rest.startsWith(p));
}

/**
 * The segments of the path a request target names, each percent-decoded, or
 * `null` when the target cannot be read the way the router reads it.
 *
 * The router (find-my-way) undoes escapes before it matches, so
 * `/%74oken/api/...` runs the `/token/api/...` handler. `decodeURIComponent`
 * undoes every escape the router undoes, and also the reserved ones the router
 * keeps (`%2F` among them), which {@link isUnauthenticatedWebPath} handles.
 * Duplicate slashes stay as they are because the router keeps them too
 * (`ignoreDuplicateSlashes` is off in `WebServer`).
 *
 * `null` for:
 * - A target that is not origin-form (`/...`). The router also routes an
 *   absolute-form target (`http://any-host/<token>/api/...`) by its path, and
 *   matches anything else from its second character (`*<token>/api/...`). A
 *   browser sends neither to the server it is talking to.
 * - A malformed escape, which `decodeURIComponent` refuses.
 */
function decodedPathSegments(url: string): string[] | null {
	if (!url.startsWith('/')) return null;
	try {
		return pathOf(url)
			.split('/')
			.map((segment) => decodeURIComponent(segment));
	} catch (error) {
		if (error instanceof URIError) return null;
		throw error;
	}
}

/**
 * Whether `url` is one of the paths a browser may reach under `/<token>` with
 * no session cookie. Anything outside the token prefix answers `true` as well:
 * this hook only speaks for the token-scoped surface.
 *
 * The path is percent-decoded first, as the router decodes it before matching.
 * A target that cannot be read with certainty answers `false` (fail closed):
 * one that is not origin-form, one with a malformed escape, and one that is
 * under the token once decoded but holds an encoded slash.
 */
export function isUnauthenticatedWebPath(token: string, url: string): boolean {
	const segments = decodedPathSegments(url);
	if (segments === null) return false;
	const path = segments.join('/');
	// The router keeps `%2F` inside one segment, so a decoded slash names
	// segments the router never matched: `/<token>/auth%2F..%2Fapi` would read
	// as an allowed `/auth/` path here.
	if (segments.some((segment) => segment.includes('/'))) return !isUnderToken(token, path);
	return isOpenPath(token, path);
}

/**
 * Whether a request may skip the session check: its target AND the route the
 * router matched must both be open. The matched route is the handler that will
 * run, however the target was spelled. The target still shows the token when a
 * route takes that segment as a param (`/:token/...`). A request that no route
 * matched (the 404 handler) has no route, only its target.
 */
function isUnauthenticatedWebRequest(token: string, request: FastifyRequest): boolean {
	if (!isUnauthenticatedWebPath(token, request.url ?? '')) return false;
	const route = request.routeOptions?.url;
	return route === undefined || isOpenPath(token, route);
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
		if (isUnauthenticatedWebRequest(token, request)) return;
		if (isWebRequestAuthorized(resolveWebRequestAuth(request))) return;
		await reply.code(401).send({ error: 'Unauthorized', message: 'Login required' });
	};
}
