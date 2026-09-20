/**
 * Web Login routes.
 *
 * The second factor on the web interface. The path token is the first: it is
 * what makes the URL unguessable, and it is also what a user pastes into a
 * group chat by accident. Login adds something the URL does not carry, and it
 * is what attributes a turn sent from a phone to a person rather than to "the
 * web".
 *
 * Routes (all under `/<token>/`, all left reachable by `web-login-hook.ts`):
 * - GET  /login       - the served form. Redirects home when there is no gate
 *                       or the browser already holds a session.
 * - POST /auth/login  - `{ username, password }` -> sets the session cookie.
 * - POST /auth/logout - revokes the session and clears the cookie.
 * - GET  /auth/me     - `{ required, user }` for the calling browser.
 *
 * The cookie header is hand-rolled rather than pulling in `@fastify/cookie`:
 * this is one `Set-Cookie` with fixed attributes, and the plugin's parsing half
 * would duplicate `readSessionCookie` in `web-login-policy.ts`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../utils/logger';
import { getThemeById } from '../../themes';
import type { Theme } from '../../../shared/themes';
import { getSettingsStore } from '../../stores/getters';
import { WEB_LOGIN_COOKIE, WEB_LOGIN_PATHS } from '../../../shared/webLogin';
import { getWebUserStore, WEB_SESSION_TTL_MS } from '../auth/web-user-store';
import {
	isWebRequestAuthorized,
	readSessionCookie,
	resolveWebRequestAuth,
} from '../auth/web-login-policy';
import { renderLoginPage } from '../auth/login-page';
import type { RateLimitConfig } from '../types';

const LOG_CONTEXT = 'WebServer:Auth';

const FALLBACK_THEME_ID = 'dracula';

/**
 * A login attempt is the one route on the server worth guessing at, so it gets
 * a budget far tighter than the API default rather than inheriting it.
 */
export const LOGIN_RATE_LIMIT: Pick<RateLimitConfig, 'max' | 'timeWindow'> = {
	max: 10,
	timeWindow: 60_000,
};

/**
 * `Secure` is set ONLY for a request that arrived over https.
 *
 * The local server speaks plain HTTP on the LAN, and a `Secure` cookie is
 * simply dropped there - the browser would accept the login and then arrive at
 * the next request with no cookie, which reads as the password being wrong.
 * The cloudflared tunnel terminates TLS in front of us and says so with
 * `x-forwarded-proto`, which is the only case where the flag both applies and
 * can be honored.
 */
export function isSecureRequest(request: Pick<FastifyRequest, 'headers' | 'protocol'>): boolean {
	const forwarded = request.headers['x-forwarded-proto'];
	const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	if (typeof proto === 'string' && proto.split(',')[0]?.trim().toLowerCase() === 'https') {
		return true;
	}
	return request.protocol === 'https';
}

/**
 * Build the `Set-Cookie` value for a session.
 *
 * `Path=/<token>` scopes the cookie to this server's token, so a second
 * Maestro reached through the same host and port (a tunnel, a reverse proxy)
 * cannot see it. `HttpOnly` keeps it away from any script the page runs, and
 * `SameSite=Strict` means a third-party page cannot drive the interface with
 * the user's own session. Pass `maxAgeSeconds: 0` to clear it.
 */
export function buildSessionCookie(options: {
	token: string;
	sessionId: string;
	secure: boolean;
	maxAgeSeconds?: number;
}): string {
	const maxAge = options.maxAgeSeconds ?? Math.floor(WEB_SESSION_TTL_MS / 1000);
	const parts = [
		`${WEB_LOGIN_COOKIE}=${encodeURIComponent(options.sessionId)}`,
		`Path=/${options.token}`,
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${maxAge}`,
	];
	if (options.secure) parts.push('Secure');
	return parts.join('; ');
}

/** The header that ends a session in the browser. */
export function buildClearedSessionCookie(token: string, secure: boolean): string {
	return buildSessionCookie({ token, sessionId: '', secure, maxAgeSeconds: 0 });
}

/** The user's active theme, or the bundled default when nothing resolves. */
function resolveActiveTheme(): Theme {
	let themeId = FALLBACK_THEME_ID;
	try {
		themeId = getSettingsStore().get('activeThemeId', FALLBACK_THEME_ID);
	} catch {
		// Stores not initialized (tests, very early boot): the default is fine.
	}
	return getThemeById(themeId) ?? (getThemeById(FALLBACK_THEME_ID) as Theme);
}

interface LoginBody {
	username?: unknown;
	password?: unknown;
}

export class AuthRoutes {
	private securityToken: string;
	private rateLimit: Pick<RateLimitConfig, 'max' | 'timeWindow'>;

	constructor(
		securityToken: string,
		rateLimit: Pick<RateLimitConfig, 'max' | 'timeWindow'> = LOGIN_RATE_LIMIT
	) {
		this.securityToken = securityToken;
		this.rateLimit = rateLimit;
	}

	registerRoutes(server: FastifyInstance): void {
		const token = this.securityToken;

		// The form. A browser that does not need it, or already holds a session,
		// is sent home rather than shown a box it cannot usefully fill in.
		server.get(`/${token}/${WEB_LOGIN_PATHS.page}`, async (request, reply) => {
			const auth = resolveWebRequestAuth(request);
			if (!auth.required || isWebRequestAuthorized(auth)) {
				return reply.redirect(`/${token}/`, 302);
			}
			const nextParam = (request.query as { next?: unknown } | undefined)?.next;
			return reply
				.type('text/html')
				.header('cache-control', 'no-store')
				.send(
					renderLoginPage({
						token,
						theme: resolveActiveTheme(),
						hasUsers: getWebUserStore().hasUsers(),
						...(typeof nextParam === 'string' ? { next: nextParam } : {}),
					})
				);
		});

		server.post(
			`/${token}/${WEB_LOGIN_PATHS.login}`,
			{ config: { rateLimit: { max: this.rateLimit.max, timeWindow: this.rateLimit.timeWindow } } },
			async (request, reply) => {
				const body = (request.body ?? {}) as LoginBody;
				const username = typeof body.username === 'string' ? body.username : '';
				const password = typeof body.password === 'string' ? body.password : '';
				const result = await getWebUserStore().login(username, password);
				if (!result.ok) {
					logger.warn(`Login refused (${result.reason})`, LOG_CONTEXT);
					return reply.code(401).send({ ok: false, reason: result.reason });
				}
				logger.info(`Login accepted for "${result.user.username}"`, LOG_CONTEXT);
				return reply
					.header(
						'set-cookie',
						buildSessionCookie({
							token,
							sessionId: result.sessionId,
							secure: isSecureRequest(request),
						})
					)
					.send({ ok: true, user: result.user });
			}
		);

		server.post(`/${token}/${WEB_LOGIN_PATHS.logout}`, async (request, reply) => {
			await getWebUserStore().logout(readSessionCookie(request));
			return reply
				.header('set-cookie', buildClearedSessionCookie(token, isSecureRequest(request)))
				.send({ ok: true });
		});

		// What the renderer asks when it wants to draw who is signed in. Answers
		// for maestro-cli too, where `user` is simply absent - it is admitted by
		// its secret, not signed in as somebody.
		server.get(`/${token}/${WEB_LOGIN_PATHS.me}`, async (request, reply: FastifyReply) => {
			const auth = resolveWebRequestAuth(request);
			return reply
				.header('cache-control', 'no-store')
				.send({ required: auth.required, user: auth.user ?? null });
		});

		logger.debug('Auth routes registered', LOG_CONTEXT);
	}
}
