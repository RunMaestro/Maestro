/**
 * Tests for the web server's Origin guard (issue #1710).
 *
 * A page that learned the tokened URL must not be able to read API responses
 * or open the control WebSocket, while the web interface the server serves
 * itself (same origin) and non-browser clients (no Origin) keep working.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { isTrustedRequestOrigin, registerOriginGuard } from '../../../main/web-server/originGuard';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('isTrustedRequestOrigin', () => {
	it('allows requests with no Origin (CLI, curl, native clients)', () => {
		expect(isTrustedRequestOrigin(undefined, '127.0.0.1:4567')).toBe(true);
		expect(isTrustedRequestOrigin(undefined, undefined)).toBe(true);
	});

	it('allows a page served by this server (same host and port)', () => {
		expect(isTrustedRequestOrigin('http://127.0.0.1:4567', '127.0.0.1:4567')).toBe(true);
		expect(isTrustedRequestOrigin('http://192.168.1.20:4567', '192.168.1.20:4567')).toBe(true);
		expect(isTrustedRequestOrigin('http://[::1]:4567', '[::1]:4567')).toBe(true);
	});

	it('allows the tunnel origin, whose default https port is absent from both headers', () => {
		expect(
			isTrustedRequestOrigin('https://abc-def.trycloudflare.com', 'abc-def.trycloudflare.com')
		).toBe(true);
	});

	it('compares hosts case-insensitively', () => {
		expect(isTrustedRequestOrigin('http://LOCALHOST:4567', 'localhost:4567')).toBe(true);
	});

	it('rejects an unrelated website', () => {
		expect(isTrustedRequestOrigin('http://evil.example', '127.0.0.1:4567')).toBe(false);
		expect(isTrustedRequestOrigin('https://evil.example', '127.0.0.1:4567')).toBe(false);
	});

	it('rejects the null origin sent by file:// pages and sandboxed frames', () => {
		expect(isTrustedRequestOrigin('null', '127.0.0.1:4567')).toBe(false);
	});

	it('rejects another port on the same host', () => {
		expect(isTrustedRequestOrigin('http://127.0.0.1:8080', '127.0.0.1:4567')).toBe(false);
		expect(isTrustedRequestOrigin('http://localhost:4567', '127.0.0.1:4567')).toBe(false);
	});

	it('rejects non-http schemes, malformed origins, and a missing Host', () => {
		expect(isTrustedRequestOrigin('chrome-extension://abcdef', 'abcdef')).toBe(false);
		expect(isTrustedRequestOrigin('not a url', '127.0.0.1:4567')).toBe(false);
		expect(isTrustedRequestOrigin('http://127.0.0.1:4567', undefined)).toBe(false);
	});
});

describe('registerOriginGuard', () => {
	let server: FastifyInstance | null = null;

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	/** Mirrors WebServer.setupMiddleware: websocket, then the guard, then CORS. */
	async function buildServer(): Promise<FastifyInstance> {
		const app = Fastify();
		await app.register(websocket);
		registerOriginGuard(app);
		await app.register(cors, { origin: false });
		app.get('/token/api/sessions', async () => ({ sessions: ['secret'] }));
		app.get('/token/ws', { websocket: true }, (connection) => {
			connection.socket.send('connected');
		});
		return app;
	}

	it('answers a foreign page with 403 and no CORS grant', async () => {
		server = await buildServer();
		for (const origin of ['http://evil.example', 'null']) {
			const res = await server.inject({
				method: 'GET',
				url: '/token/api/sessions',
				headers: { origin, host: '127.0.0.1:4567' },
			});
			expect(res.statusCode).toBe(403);
			expect(res.body).not.toContain('secret');
			expect(res.headers['access-control-allow-origin']).toBeUndefined();
		}
	});

	it('refuses a foreign preflight', async () => {
		server = await buildServer();
		const res = await server.inject({
			method: 'OPTIONS',
			url: '/token/api/sessions',
			headers: {
				origin: 'http://evil.example',
				host: '127.0.0.1:4567',
				'access-control-request-method': 'POST',
			},
		});
		expect(res.statusCode).toBe(403);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('serves same-origin and Origin-less requests', async () => {
		server = await buildServer();
		const sameOrigin = await server.inject({
			method: 'GET',
			url: '/token/api/sessions',
			headers: { origin: 'http://127.0.0.1:4567', host: '127.0.0.1:4567' },
		});
		expect(sameOrigin.statusCode).toBe(200);
		expect(sameOrigin.headers['access-control-allow-origin']).toBeUndefined();

		const noOrigin = await server.inject({ method: 'GET', url: '/token/api/sessions' });
		expect(noOrigin.statusCode).toBe(200);
	});

	describe('WebSocket handshake', () => {
		async function connect(origin?: string): Promise<'open' | number> {
			const { port } = server!.server.address() as AddressInfo;
			const ws = new WebSocket(`ws://127.0.0.1:${port}/token/ws`, origin ? { origin } : {});
			return new Promise((resolve) => {
				ws.on('message', () => {
					ws.close();
					resolve('open');
				});
				// No client-side cleanup on purpose: the server must close a refused
				// handshake's socket itself, or server.close() in afterEach hangs.
				ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
				ws.on('error', () => undefined);
			});
		}

		it('rejects a handshake from a foreign page', async () => {
			server = await buildServer();
			await server.listen({ port: 0, host: '127.0.0.1' });
			expect(await connect('http://evil.example')).toBe(403);
			expect(await connect('null')).toBe(403);
		});

		it('accepts a same-origin handshake and an Origin-less client', async () => {
			server = await buildServer();
			await server.listen({ port: 0, host: '127.0.0.1' });
			const { port } = server.server.address() as AddressInfo;
			expect(await connect(`http://127.0.0.1:${port}`)).toBe('open');
			expect(await connect()).toBe('open');
		});
	});
});
