/**
 * Tests for StaticRoutes
 *
 * Static Routes serve the web-desktop interface (the default browser UI),
 * PWA files, and security redirects. Routes are protected by a security token
 * prefix.
 *
 * Routes tested:
 * - / - Redirect to website (no access without token)
 * - /health - Health check endpoint
 * - /:token - Invalid token catch-all, redirect to website
 * - /$TOKEN - Web-desktop interface served from the web-desktop bundle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { StaticRoutes } from '../../../../main/web-server/routes/staticRoutes';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

/**
 * Mock Fastify instance with route registration tracking
 */
function createMockFastify() {
	const routes: Map<string, { handler: Function }> = new Map();

	return {
		get: vi.fn((path: string, handler: Function) => {
			routes.set(`GET:${path}`, { handler });
		}),
		getRoute: (method: string, path: string) => routes.get(`${method}:${path}`),
		routes,
	};
}

/**
 * Mock reply object
 */
function createMockReply() {
	const reply: any = {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
		type: vi.fn().mockReturnThis(),
		header: vi.fn().mockReturnThis(),
		redirect: vi.fn().mockReturnThis(),
	};
	return reply;
}

describe('StaticRoutes', () => {
	const securityToken = 'test-token-123';
	const webAssetsPath = '/path/to/web/assets';
	const webDesktopPath = '/path/to/web-desktop';
	const concertoToken = 'test-concerto-token';

	let staticRoutes: StaticRoutes;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		staticRoutes = new StaticRoutes(securityToken, webAssetsPath, webDesktopPath, concertoToken);
		mockFastify = createMockFastify();
		staticRoutes.registerRoutes(mockFastify as any);
	});

	describe('Route Registration', () => {
		it('should register all static routes', () => {
			// 13 routes: /, /health, /og.png, manifest.json, sw.js, token root,
			// token root/, /desktop, /desktop/, /acappella, /acappella/,
			// session/:id, /:token
			expect(mockFastify.get).toHaveBeenCalledTimes(13);
		});

		it('should register routes with correct paths', () => {
			expect(mockFastify.routes.has('GET:/')).toBe(true);
			expect(mockFastify.routes.has('GET:/health')).toBe(true);
			// The social card is deliberately NOT under the token prefix, so that
			// the security token stays out of an image URL chat clients cache.
			expect(mockFastify.routes.has('GET:/og.png')).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/manifest.json`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/sw.js`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/desktop`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/desktop/`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/acappella`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/acappella/`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/session/:sessionId`)).toBe(true);
			expect(mockFastify.routes.has('GET:/:token')).toBe(true);
		});
	});

	describe('GET / (Root Redirect)', () => {
		it('should redirect to website', async () => {
			const route = mockFastify.getRoute('GET', '/');
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.redirect).toHaveBeenCalledWith(302, 'https://runmaestro.ai');
		});
	});

	describe('GET /health', () => {
		it('should return health status', async () => {
			const route = mockFastify.getRoute('GET', '/health');
			const result = await route!.handler();

			expect(result.status).toBe('ok');
			expect(result.timestamp).toBeDefined();
		});
	});

	describe('Null path handling', () => {
		it('should return 404 for manifest.json when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null, webDesktopPath, concertoToken);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/manifest.json`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 404 for sw.js when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null, webDesktopPath, concertoToken);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/sw.js`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 503 for the token root when the web-desktop bundle is missing', async () => {
			const noDesktopRoutes = new StaticRoutes(securityToken, webAssetsPath, null, concertoToken);
			const noDesktopFastify = createMockFastify();
			noDesktopRoutes.registerRoutes(noDesktopFastify as any);

			const route = noDesktopFastify.getRoute('GET', `/${securityToken}`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(503);
			expect(reply.send).toHaveBeenCalledWith(
				expect.objectContaining({ error: 'Service Unavailable' })
			);
		});
	});

	describe('GET /:token (Invalid Token Catch-all)', () => {
		it('should redirect to website for invalid token', async () => {
			const route = mockFastify.getRoute('GET', '/:token');
			const reply = createMockReply();
			await route!.handler({ params: { token: 'invalid-token' } }, reply);

			expect(reply.redirect).toHaveBeenCalledWith(302, 'https://runmaestro.ai');
		});
	});

	describe('Security Token Validation', () => {
		it('should use provided security token in routes', () => {
			const customToken = 'custom-secure-token-456';
			const customRoutes = new StaticRoutes(
				customToken,
				webAssetsPath,
				webDesktopPath,
				concertoToken
			);
			const customFastify = createMockFastify();
			customRoutes.registerRoutes(customFastify as any);

			expect(customFastify.routes.has(`GET:/${customToken}`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/desktop`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/manifest.json`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/sw.js`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/session/:sessionId`)).toBe(true);
		});
	});

	describe('Web-desktop index serving', () => {
		it('should serve the web-desktop index with token-prefixed desktop asset paths', async () => {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-static-routes-'));
			const tempDesktopPath = path.join(tempRoot, 'web-desktop');
			const tempIndexPath = path.join(tempDesktopPath, 'index.html');

			mkdirSync(tempDesktopPath, { recursive: true });

			try {
				writeFileSync(
					tempIndexPath,
					'<!doctype html><html><head><script type="module" src="./assets/main-old.js"></script></head><body></body></html>',
					'utf8'
				);

				const freshRoutes = new StaticRoutes(
					securityToken,
					webAssetsPath,
					tempDesktopPath,
					concertoToken
				);
				const freshFastify = createMockFastify();
				freshRoutes.registerRoutes(freshFastify as any);

				const route = freshFastify.getRoute('GET', `/${securityToken}`);
				const firstReply = createMockReply();
				await route!.handler({}, firstReply);

				expect(firstReply.type).toHaveBeenCalledWith('text/html');
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/desktop/assets/main-old.js`)
				);
				// Config is injected so the electron-shim can open the WS bridge.
				expect(firstReply.send).toHaveBeenCalledWith(expect.stringContaining('__MAESTRO_CONFIG__'));
				// ...including the Concerto document token, which the renderer needs
				// to point an HTML Movement's iframe at a URL a browser can load.
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`concertoToken: "${concertoToken}"`)
				);
				// PWA manifest and iOS home-screen icon are wired into the page,
				// token-prefixed to match their HTTP-served routes.
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`<link rel="manifest" href="/${securityToken}/manifest.json" />`)
				);
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(
						`<link rel="icon" href="/${securityToken}/icons/icon-192x192.png" />`
					)
				);
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(
						`<link rel="apple-touch-icon" href="/${securityToken}/icons/icon-192x192.png" />`
					)
				);

				// Read fresh from disk so rebuilt asset hashes are reflected immediately.
				writeFileSync(
					tempIndexPath,
					'<!doctype html><html><head><script type="module" src="./assets/main-new.js"></script></head><body></body></html>',
					'utf8'
				);

				const secondReply = createMockReply();
				await route!.handler({}, secondReply);

				expect(secondReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/desktop/assets/main-new.js`)
				);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it('should serve the same desktop index from the legacy /desktop alias', async () => {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-static-routes-'));
			const tempDesktopPath = path.join(tempRoot, 'web-desktop');
			const tempIndexPath = path.join(tempDesktopPath, 'index.html');

			mkdirSync(tempDesktopPath, { recursive: true });

			try {
				writeFileSync(
					tempIndexPath,
					'<!doctype html><html><head><script type="module" src="./assets/main.js"></script></head><body></body></html>',
					'utf8'
				);

				const freshRoutes = new StaticRoutes(
					securityToken,
					webAssetsPath,
					tempDesktopPath,
					concertoToken
				);
				const freshFastify = createMockFastify();
				freshRoutes.registerRoutes(freshFastify as any);

				const route = freshFastify.getRoute('GET', `/${securityToken}/desktop`);
				const reply = createMockReply();
				await route!.handler({}, reply);

				expect(reply.type).toHaveBeenCalledWith('text/html');
				expect(reply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/desktop/assets/main.js`)
				);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});

	describe('GET /$TOKEN/acappella (reference client)', () => {
		it('serves the reference client page with its assets repointed', async () => {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-static-routes-'));
			const tempDesktopPath = path.join(tempRoot, 'web-desktop');
			const clientDir = path.join(tempDesktopPath, 'acappella-client');

			mkdirSync(clientDir, { recursive: true });

			try {
				// Vite emits `../assets/` for a page one directory down from the bundle
				// root, which is why the desktop index's `./assets/` rewrite alone was
				// not enough.
				writeFileSync(
					path.join(clientDir, 'index.html'),
					'<!doctype html><html><head><script type="module" src="../assets/acappella-client.js"></script></head><body></body></html>',
					'utf8'
				);

				const freshRoutes = new StaticRoutes(
					securityToken,
					webAssetsPath,
					tempDesktopPath,
					concertoToken
				);
				const freshFastify = createMockFastify();
				freshRoutes.registerRoutes(freshFastify as any);

				const route = freshFastify.getRoute('GET', `/${securityToken}/acappella`);
				const reply = createMockReply();
				await route!.handler({}, reply);

				expect(reply.type).toHaveBeenCalledWith('text/html');
				expect(reply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/desktop/assets/acappella-client.js`)
				);
				// No config injection: the reference client pairs with a code like any
				// other device, and handing it the token would skip the one flow it
				// exists to exercise.
				expect(reply.send).not.toHaveBeenCalledWith(expect.stringContaining('__MAESTRO_CONFIG__'));
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it('returns 503 when the bundle has not been built', async () => {
			const noDesktopRoutes = new StaticRoutes(securityToken, webAssetsPath, null, concertoToken);
			const noDesktopFastify = createMockFastify();
			noDesktopRoutes.registerRoutes(noDesktopFastify as any);

			const route = noDesktopFastify.getRoute('GET', `/${securityToken}/acappella`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(503);
		});
	});

	describe('Social preview card', () => {
		/** Serve the desktop index from a throwaway bundle and return the HTML. */
		async function serveIndexWith(
			request: unknown,
			assetsPath: string | null = webAssetsPath
		): Promise<string> {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-og-'));
			const tempDesktopPath = path.join(tempRoot, 'web-desktop');
			mkdirSync(tempDesktopPath, { recursive: true });
			try {
				writeFileSync(
					path.join(tempDesktopPath, 'index.html'),
					'<!doctype html><html><head><title>Maestro</title></head><body></body></html>',
					'utf8'
				);
				const routes = new StaticRoutes(securityToken, assetsPath, tempDesktopPath, concertoToken);
				const fastify = createMockFastify();
				routes.registerRoutes(fastify as any);

				const reply = createMockReply();
				await fastify.getRoute('GET', `/${securityToken}`)!.handler(request, reply);
				return reply.send.mock.calls[0][0] as string;
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		}

		it('injects an absolute og:image built from the request host', async () => {
			// A crawler resolves og:image against nothing, so the URL has to name
			// the host the link was actually shared as - which only the request
			// knows, since one server answers on a LAN IP, on localhost, and
			// through a tunnel.
			const html = await serveIndexWith({ headers: { host: '192.168.1.39:8420' } });

			expect(html).toContain('<meta property="og:image" content="http://192.168.1.39:8420/og.png"');
			expect(html).toContain('<meta property="og:title" content="Maestro" />');
			expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
		});

		it('keeps the security token out of the card', async () => {
			// Chat clients cache and re-host preview images, so the image URL is
			// the one place the token must not appear.
			const html = await serveIndexWith({ headers: { host: '192.168.1.39:8420' } });
			const metaTags = html.match(/<meta [^>]*>/g) ?? [];

			expect(metaTags.length).toBeGreaterThan(0);
			expect(metaTags.join('')).not.toContain(securityToken);
		});

		it('serves the page without a card when the request names no host', async () => {
			// Degrades to the plain title rather than emitting a card pointing at
			// a guessed origin. The page itself must still load.
			const html = await serveIndexWith({});

			expect(html).not.toContain('og:image');
			expect(html).toContain('__MAESTRO_CONFIG__');
			expect(html).toContain('<title>Maestro</title>');
		});

		it('returns 404 for /og.png when the web assets are not built', async () => {
			const routes = new StaticRoutes(securityToken, null, webDesktopPath, concertoToken);
			const fastify = createMockFastify();
			routes.registerRoutes(fastify as any);

			const reply = createMockReply();
			await fastify.getRoute('GET', '/og.png')!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('answers /og.png rather than the invalid-token redirect', async () => {
			// The one property the mock Fastify above cannot express. `/og.png`
			// and `/:token` both match a single-segment path, and if the
			// parametric route ever won, every crawler asking for the card would
			// be redirected to the marketing site and the preview would render
			// with a hole in it. Fastify resolves static ahead of parametric, so
			// this asserts that ordering against the real router.
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-og-priority-'));
			let server: FastifyInstance | null = null;
			try {
				writeFileSync(path.join(tempRoot, 'og-image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

				server = Fastify();
				new StaticRoutes(securityToken, tempRoot, webDesktopPath, concertoToken).registerRoutes(
					server
				);
				await server.ready();

				const card = await server.inject({ method: 'GET', url: '/og.png' });
				expect(card.statusCode).toBe(200);
				expect(card.headers['content-type']).toContain('image/png');

				// The catch-all still owns everything else that looks like a token.
				const bogus = await server.inject({ method: 'GET', url: '/not-the-token' });
				expect(bogus.statusCode).toBe(302);
			} finally {
				await server?.close();
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		it('serves the card as a cacheable PNG', async () => {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-og-asset-'));
			mkdirSync(tempRoot, { recursive: true });
			try {
				const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
				writeFileSync(path.join(tempRoot, 'og-image.png'), bytes);

				const routes = new StaticRoutes(securityToken, tempRoot, webDesktopPath, concertoToken);
				const fastify = createMockFastify();
				routes.registerRoutes(fastify as any);

				const reply = createMockReply();
				await fastify.getRoute('GET', '/og.png')!.handler({}, reply);

				expect(reply.type).toHaveBeenCalledWith('image/png');
				expect(reply.header).toHaveBeenCalledWith(
					'Cache-Control',
					expect.stringContaining('max-age')
				);
				// Sent as bytes, not through the utf-8 string cache - decoding a PNG
				// as text corrupts it.
				const sent = reply.send.mock.calls[0][0];
				expect(Buffer.isBuffer(sent)).toBe(true);
				expect(sent.equals(bytes)).toBe(true);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});
});
