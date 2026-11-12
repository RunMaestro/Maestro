/**
 * Tests for the global Web Login preHandler.
 *
 * The hook is deny-by-default under `/<token>/`, so the interesting assertions
 * are the allow-list: each entry is something that must stay reachable WITHOUT
 * a session, and a mistake there either locks the user out of the login page
 * itself or leaves a data route open.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
