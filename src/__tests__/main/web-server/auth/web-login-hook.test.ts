/**
 * Tests for the global Web Login preHandler.
 *
 * The hook is deny-by-default under `/<token>/`, so the interesting assertions
 * are the allow-list: each entry is something that must stay reachable WITHOUT
 * a session, and a mistake there either locks the user out of the login page
 * itself or leaves a data route open.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';

const { webLogin } = vi.hoisted(() => ({
	webLogin: { enabled: false, authorized: false },
}));

vi.mock('../../../../main/web-server/auth/web-login-policy', () => ({
	isWebLoginEnabled: () => webLogin.enabled,
	resolveWebRequestAuth: () => ({
		required: webLogin.enabled,
		user: undefined,
		sessionId: undefined,
		cli: webLogin.authorized,
	}),
	isWebRequestAuthorized: () => webLogin.authorized,
}));

const { isUnauthenticatedWebPath, webLoginPreHandler } =
	await import('../../../../main/web-server/auth/web-login-hook');

const TOKEN = 'tok-123';

describe('isUnauthenticatedWebPath', () => {
	it('leaves everything outside the token prefix alone', () => {
		// `/`, `/health` and `/og.png` are deliberately public, and the Concerto
		// routes carry a different, read-only token of their own.
		for (const url of ['/', '/health', '/og.png', '/concerto-token/doc/abc', '/tok-123x/api']) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(true);
		}
	});

	it('allows the login flow itself', () => {
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/login')).toBe(true);
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/login?next=%2Ftok-123%2F')).toBe(true);
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/auth/login')).toBe(true);
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/auth/logout')).toBe(true);
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/auth/me')).toBe(true);
	});

	it('allows the index routes, which redirect to the form themselves', () => {
		for (const url of [
			'/tok-123',
			'/tok-123/',
			'/tok-123/desktop',
			'/tok-123/desktop/',
			'/tok-123/session/abc',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(true);
		}
	});

	it('allows the static assets the login page and the PWA need', () => {
		for (const url of [
			'/tok-123/manifest.json',
			'/tok-123/sw.js',
			'/tok-123/icons/icon-192x192.png',
			'/tok-123/desktop/assets/main-abc123.js',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(true);
		}
	});

	it('allows the WebSocket upgrade, which closes with its own code', () => {
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/ws')).toBe(true);
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/ws?sessionId=abc')).toBe(true);
	});

	it('gates everything else under the token', () => {
		for (const url of [
			'/tok-123/api/sessions',
			'/tok-123/api/session/abc/send',
			'/tok-123/api/images/deadbeef.png',
			'/tok-123/media/stream/mt/6162',
			'/tok-123/something-added-later',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(false);
		}
	});

	it('is not fooled by a query string that looks like an allowed path', () => {
		expect(isUnauthenticatedWebPath(TOKEN, '/tok-123/api/sessions?x=/tok-123/login')).toBe(false);
	});

	it('decodes escapes before matching, as the router does', () => {
		// The router runs the gated handler for each of these. Compared raw, the
		// first three did not start with `/tok-123` and walked past the gate.
		for (const url of [
			'/%74ok-123/api/sessions',
			'/%74%6F%6B-123/api/sessions',
			'/tok-%31%32%33/api/session/abc/send',
			'/tok-123/%61pi/sessions',
			'/tok-123/api/%73essions?x=1',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(false);
		}
	});

	it('still allows an allowed path that arrives encoded', () => {
		for (const url of [
			'/%74ok-123/login',
			'/tok-123/%6Cogin',
			'/tok-123/auth/%6De',
			'/tok-123/%69cons/icon-192x192.png',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(true);
		}
	});

	it('fails closed on an encoded slash under the token', () => {
		// The router keeps `%2F` inside one segment, so these name segments it
		// never matched. Decoded, the first two read as allowed prefixes.
		for (const url of [
			'/tok-123/auth%2F..%2Fapi/sessions',
			'/tok-123/desktop%2Fassets%2F..%2F..%2Fapi/sessions',
			'/tok-123%2Fapi/sessions',
			'/tok-123/session%2fabc',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(false);
		}
	});

	it('leaves an encoded slash outside the token alone', () => {
		expect(isUnauthenticatedWebPath(TOKEN, '/concerto-token/doc/a%2Fb')).toBe(true);
	});

	it('fails closed on a malformed escape', () => {
		for (const url of [
			'/tok-123/%zz',
			'/tok-123/api/%E0%A4%A',
			'/%74ok-123/%',
			'/tok-123/%C0%AF',
			'/%zz/tok-123/api/sessions',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(false);
		}
	});

	it('fails closed on a target that is not origin-form', () => {
		// The router routes each of these by the token path inside it.
		for (const url of [
			'http://127.0.0.1/tok-123/api/sessions',
			'HTTPS://elsewhere.example/tok-123/api/sessions',
			'*tok-123/api/sessions',
		]) {
			expect(isUnauthenticatedWebPath(TOKEN, url)).toBe(false);
		}
	});
});

describe('webLoginPreHandler', () => {
	function makeReply() {
		const reply = {
			code: vi.fn(() => reply),
			send: vi.fn(() => reply),
		};
		return reply;
	}

	beforeEach(() => {
		webLogin.enabled = false;
		webLogin.authorized = false;
	});

	it('does nothing at all while the Encore flag is off', async () => {
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)({ url: '/tok-123/api/sessions' } as never, reply as never);

		expect(reply.code).not.toHaveBeenCalled();
	});

	it('answers 401 for a gated path with no session', async () => {
		webLogin.enabled = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)({ url: '/tok-123/api/sessions' } as never, reply as never);

		expect(reply.code).toHaveBeenCalledWith(401);
		expect(reply.send).toHaveBeenCalledWith({
			error: 'Unauthorized',
			message: 'Login required',
		});
	});

	it('lets an authorized request through', async () => {
		webLogin.enabled = true;
		webLogin.authorized = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)({ url: '/tok-123/api/sessions' } as never, reply as never);

		expect(reply.code).not.toHaveBeenCalled();
	});

	it('never gates the login page, even with the flag on and no session', async () => {
		webLogin.enabled = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)({ url: '/tok-123/login' } as never, reply as never);

		expect(reply.code).not.toHaveBeenCalled();
	});

	it('gates on the matched route even when the target reads as open', async () => {
		// Stands in for any spelling the router resolves differently from the
		// hook: the matched route is the handler that will run.
		webLogin.enabled = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)(
			{ url: '/health', routeOptions: { url: '/tok-123/api/sessions' } } as never,
			reply as never
		);

		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it('gates on the target even when the matched route reads as open', async () => {
		// A route that takes the token segment as a param does not start with
		// `/tok-123`. The target still does.
		webLogin.enabled = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)(
			{ url: '/tok-123/api/thing', routeOptions: { url: '/:token/api/thing' } } as never,
			reply as never
		);

		expect(reply.code).toHaveBeenCalledWith(401);
	});

	it('lets an allowed route through when the target agrees', async () => {
		webLogin.enabled = true;
		const reply = makeReply();
		await webLoginPreHandler(TOKEN)(
			{
				url: '/tok-123/session/abc',
				routeOptions: { url: '/tok-123/session/:sessionId' },
			} as never,
			reply as never
		);

		expect(reply.code).not.toHaveBeenCalled();
	});
});

describe('webLoginPreHandler on a real router', () => {
	// Raw request lines over a socket: `inject()` parses the URL first, which
	// turns the absolute-form and `*` targets into plain paths before routing.
	let server: FastifyInstance;
	let port: number;
	const served: string[] = [];

	beforeAll(async () => {
		server = Fastify();
		server.addHook('preHandler', webLoginPreHandler(TOKEN));
		server.get(`/${TOKEN}/api/sessions`, async () => {
			served.push('api');
			return { sessions: [] };
		});
		server.get(`/${TOKEN}/login`, async () => {
			served.push('login');
			return 'login page';
		});
		await server.listen({ port: 0, host: '127.0.0.1' });
		port = (server.server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await server.close();
	});

	beforeEach(() => {
		webLogin.enabled = true;
		webLogin.authorized = false;
		served.length = 0;
	});

	/** Send `GET <target>` as written and resolve with the status code. */
	function rawGet(target: string): Promise<number> {
		return new Promise((resolve, reject) => {
			const socket = connect(port, '127.0.0.1', () => {
				socket.write(
					`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
				);
			});
			let response = '';
			socket.on('data', (chunk) => {
				response += chunk.toString('latin1');
			});
			socket.on('end', () => resolve(Number(response.split(' ')[1])));
			socket.on('error', reject);
		});
	}

	it.each([
		['percent-encoded token characters', '/%74ok-123/api/sessions'],
		['a percent-encoded route segment', '/tok-123/%61pi/sessions'],
		['an absolute-form target', 'http://127.0.0.1/tok-123/api/sessions'],
		[
			'an absolute-form target naming another host',
			'HTTP://elsewhere.example/tok-123/api/sessions',
		],
		['a target the router reads from its second character', '*tok-123/api/sessions'],
	])('refuses %s with no session', async (_label, target) => {
		expect(await rawGet(target)).toBe(401);
		expect(served).toEqual([]);
	});

	it('serves the gated route to a signed-in browser, however it is spelled', async () => {
		webLogin.authorized = true;

		expect(await rawGet('/%74ok-123/api/sessions')).toBe(200);
		expect(served).toEqual(['api']);
	});

	it('still serves the login page with no session', async () => {
		expect(await rawGet('/tok-123/login')).toBe(200);
		expect(await rawGet('/tok-123/%6Cogin')).toBe(200);
		expect(served).toEqual(['login', 'login']);
	});
});
