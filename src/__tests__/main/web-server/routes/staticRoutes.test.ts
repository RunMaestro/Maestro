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
		redirect: vi.fn().mockReturnThis(),
	};
	return reply;
}

describe('StaticRoutes', () => {
	const securityToken = 'test-token-123';
	const webAssetsPath = '/path/to/web/assets';
	const webDesktopPath = '/path/to/web-desktop';

	let staticRoutes: StaticRoutes;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		staticRoutes = new StaticRoutes(securityToken, webAssetsPath, webDesktopPath);
		mockFastify = createMockFastify();
		staticRoutes.registerRoutes(mockFastify as any);
	});

	describe('Route Registration', () => {
		it('should register all static routes', () => {
			// 10 routes: /, /health, manifest.json, sw.js, token root, token root/,
			// /desktop, /desktop/, session/:id, /:token
			expect(mockFastify.get).toHaveBeenCalledTimes(10);
		});

		it('should register routes with correct paths', () => {
			expect(mockFastify.routes.has('GET:/')).toBe(true);
			expect(mockFastify.routes.has('GET:/health')).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/manifest.json`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/sw.js`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/desktop`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/desktop/`)).toBe(true);
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
			const noAssetsRoutes = new StaticRoutes(securityToken, null, webDesktopPath);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/manifest.json`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 404 for sw.js when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null, webDesktopPath);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/sw.js`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 503 for the token root when the web-desktop bundle is missing', async () => {
			const noDesktopRoutes = new StaticRoutes(securityToken, webAssetsPath, null);
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
			const customRoutes = new StaticRoutes(customToken, webAssetsPath, webDesktopPath);
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

				const freshRoutes = new StaticRoutes(securityToken, webAssetsPath, tempDesktopPath);
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
				// PWA manifest and iOS home-screen icon are wired into the page,
				// token-prefixed to match their HTTP-served routes.
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`<link rel="manifest" href="/${securityToken}/manifest.json" />`)
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

				const freshRoutes = new StaticRoutes(securityToken, webAssetsPath, tempDesktopPath);
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
});
