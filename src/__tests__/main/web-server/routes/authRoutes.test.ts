/**
 * Tests for AuthRoutes - the Web Login flow.
 *
 * Driven through a real Fastify instance with `inject`, because the two things
 * most worth pinning here are exactly what a mock reply would paper over: the
 * status code a refusal carries (a 200 with `ok:false` would make every browser
 * cache and every proxy treat a rejected password as a successful page) and the
 * `Set-Cookie` header itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WEB_LOGIN_COOKIE } from '../../../../shared/webLogin';

const { state } = vi.hoisted(() => ({
	state: {
		enabled: true,
		hasUsers: true,
		/** What the next login attempt resolves to. */
		login: {
			ok: true,
			user: { id: 'u1', username: 'ada', displayName: 'Ada' },
			sessionId: 'sid-1',
		} as
			| { ok: true; user: { id: string; username: string; displayName: string }; sessionId: string }
			| { ok: false; reason: 'invalid' | 'disabled' | 'no-users' },
		/** Session ids the store still knows about. */
		sessions: new Map<string, { id: string; username: string; displayName: string }>(),
		loggedOut: [] as string[],
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) =>
			key === 'encoreFeatures' ? { webLogin: state.enabled } : fallback,
	}),
}));

vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	WEB_SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
	getWebUserStore: () => ({
		hasUsers: () => state.hasUsers,
		login: async () => state.login,
		logout: async (sid?: string) => {
			if (sid) state.loggedOut.push(sid);
			state.sessions.delete(sid ?? '');
		},
		resolveSession: (sid?: string) => (sid ? state.sessions.get(sid) : undefined),
	}),
}));

const { AuthRoutes, buildSessionCookie, buildClearedSessionCookie, isSecureRequest } =
	await import('../../../../main/web-server/routes/authRoutes');

const TOKEN = 'tok-123';

/**
 * A LAN peer address, so each request reads as the browser it stands for.
 * (The gate never exempts by address - the tunnel arrives over loopback too -
 * so this is documentation, not a requirement of the test.)
 */
const LAN = { remoteAddress: '192.168.1.42' };

async function makeServer(): Promise<FastifyInstance> {
	const server = Fastify();
	new AuthRoutes(TOKEN).registerRoutes(server);
	await server.ready();
	return server;
}

beforeEach(() => {
	state.enabled = true;
	state.hasUsers = true;
	state.sessions.clear();
	state.loggedOut.length = 0;
	state.login = {
		ok: true,
		user: { id: 'u1', username: 'ada', displayName: 'Ada' },
		sessionId: 'sid-1',
	};
});

describe('buildSessionCookie', () => {
	it('scopes the cookie to this server token and hides it from scripts', () => {
		const cookie = buildSessionCookie({ token: TOKEN, sessionId: 'sid-1', secure: false });

		expect(cookie).toContain(`${WEB_LOGIN_COOKIE}=sid-1`);
		expect(cookie).toContain(`Path=/${TOKEN}`);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).toContain('Max-Age=2592000');
	});

	it('omits Secure on plain HTTP', () => {
		// The LAN server speaks plain HTTP. A `Secure` cookie is simply dropped
		// there, so the browser would accept the login and then arrive with no
		// cookie, which reads to the user as the password being wrong.
		expect(buildSessionCookie({ token: TOKEN, sessionId: 's', secure: false })).not.toContain(
			'Secure'
		);
		expect(buildSessionCookie({ token: TOKEN, sessionId: 's', secure: true })).toContain('Secure');
	});

	it('clears the cookie with a zero Max-Age on the same path', () => {
		const cookie = buildClearedSessionCookie(TOKEN, false);

		expect(cookie).toContain('Max-Age=0');
		expect(cookie).toContain(`Path=/${TOKEN}`);
	});
});

describe('isSecureRequest', () => {
	it('trusts x-forwarded-proto, which is how the tunnel says it terminated TLS', () => {
		expect(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' }, protocol: 'http' })).toBe(
			true
		);
		// A chain of proxies appends; the first hop is the client's.
		expect(
			isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' }, protocol: 'http' })
		).toBe(true);
		expect(isSecureRequest({ headers: {}, protocol: 'http' })).toBe(false);
		expect(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' }, protocol: 'http' })).toBe(
			false
		);
	});
});

describe('GET /<token>/login', () => {
	it('serves the form when a login is required and none is held', async () => {
		const server = await makeServer();
		const res = await server.inject({ method: 'GET', url: `/${TOKEN}/login`, ...LAN });

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('MAESTRO');
		expect(res.body).toContain('name="password"');
		// Never cached: the page reflects live state (whether accounts exist).
		expect(res.headers['cache-control']).toContain('no-store');
		await server.close();
	});

	it('redirects home when the gate is off', async () => {
		state.enabled = false;
		const server = await makeServer();
		const res = await server.inject({ method: 'GET', url: `/${TOKEN}/login` });

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe(`/${TOKEN}/`);
		await server.close();
	});

	it('redirects home when the browser already holds a session', async () => {
		state.sessions.set('sid-1', { id: 'u1', username: 'ada', displayName: 'Ada' });
		const server = await makeServer();
		const res = await server.inject({
			method: 'GET',
			url: `/${TOKEN}/login`,
			headers: { cookie: `${WEB_LOGIN_COOKIE}=sid-1` },
			...LAN,
		});

		expect(res.statusCode).toBe(302);
		await server.close();
	});

	it('carries next into the page so a deep link survives the detour', async () => {
		const server = await makeServer();
		const res = await server.inject({
			method: 'GET',
			url: `/${TOKEN}/login?next=%2F${TOKEN}%2Fsession%2Fabc`,
			...LAN,
		});

		expect(res.body).toContain(`data-next="/${TOKEN}/session/abc"`);
		await server.close();
	});

	it('tells a fresh install where the accounts live', async () => {
		state.hasUsers = false;
		const server = await makeServer();
		const res = await server.inject({ method: 'GET', url: `/${TOKEN}/login`, ...LAN });

		expect(res.body).toContain('No accounts exist yet.');
		await server.close();
	});
});

describe('POST /<token>/auth/login', () => {
	it('sets the session cookie and answers with the account on success', async () => {
		const server = await makeServer();
		const res = await server.inject({
			method: 'POST',
			url: `/${TOKEN}/auth/login`,
			payload: { username: 'ada', password: 'hunter2hunter2' },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			ok: true,
			user: { id: 'u1', username: 'ada', displayName: 'Ada' },
		});
		expect(res.headers['set-cookie']).toContain(`${WEB_LOGIN_COOKIE}=sid-1`);
		await server.close();
	});

	it('answers 401 with the reason, and sets no cookie, on a refusal', async () => {
		for (const reason of ['invalid', 'disabled', 'no-users'] as const) {
			state.login = { ok: false, reason };
			const server = await makeServer();
			const res = await server.inject({
				method: 'POST',
				url: `/${TOKEN}/auth/login`,
				payload: { username: 'ada', password: 'nope' },
			});

			expect(res.statusCode).toBe(401);
			expect(res.json()).toEqual({ ok: false, reason });
			expect(res.headers['set-cookie']).toBeUndefined();
			await server.close();
		}
	});

	it('survives a body that is not the expected shape', async () => {
		// A hand-rolled client, or a probe. The store decides; this route must not
		// throw on the way there.
		state.login = { ok: false, reason: 'invalid' };
		const server = await makeServer();
		const res = await server.inject({
			method: 'POST',
			url: `/${TOKEN}/auth/login`,
			payload: { username: 42 },
		});

		expect(res.statusCode).toBe(401);
		await server.close();
	});
});

describe('POST /<token>/auth/logout', () => {
	it('revokes the session server-side and clears the cookie', async () => {
		// Clearing the cookie alone would leave the session id valid, so anyone
		// who captured it keeps the account.
		state.sessions.set('sid-1', { id: 'u1', username: 'ada', displayName: 'Ada' });
		const server = await makeServer();
		const res = await server.inject({
			method: 'POST',
			url: `/${TOKEN}/auth/logout`,
			headers: { cookie: `${WEB_LOGIN_COOKIE}=sid-1` },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
		expect(state.loggedOut).toEqual(['sid-1']);
		expect(res.headers['set-cookie']).toContain('Max-Age=0');
		await server.close();
	});
});

describe('GET /<token>/auth/me', () => {
	it('names the account behind the cookie', async () => {
		state.sessions.set('sid-1', { id: 'u1', username: 'ada', displayName: 'Ada' });
		const server = await makeServer();
		const res = await server.inject({
			method: 'GET',
			url: `/${TOKEN}/auth/me`,
			headers: { cookie: `${WEB_LOGIN_COOKIE}=sid-1` },
		});

		expect(res.json()).toEqual({
			required: true,
			user: { id: 'u1', username: 'ada', displayName: 'Ada' },
		});
		await server.close();
	});

	it('reports a null user rather than failing when nobody is signed in', async () => {
		const server = await makeServer();
		const res = await server.inject({ method: 'GET', url: `/${TOKEN}/auth/me` });

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ required: true, user: null });
		await server.close();
	});

	it('reports required:false when the Encore flag is off', async () => {
		// `required` and `user` answer different questions: no user with the gate
		// ON is maestro-cli, no user with it OFF is the feature unused.
		state.enabled = false;
		const server = await makeServer();
		const res = await server.inject({ method: 'GET', url: `/${TOKEN}/auth/me` });

		expect(res.json()).toEqual({ required: false, user: null });
		await server.close();
	});
});
