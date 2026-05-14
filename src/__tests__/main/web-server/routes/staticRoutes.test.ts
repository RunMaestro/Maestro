/**
 * Tests for StaticRoutes
 *
 * Static Routes handle dashboard views, PWA files, and security redirects.
 * Routes are protected by a security token prefix.
 *
 * Note: Tests that require fs mocking are skipped due to ESM module limitations.
 * The fs-dependent functionality is tested via integration tests.
 *
 * Routes tested:
 * - / - Redirect to website (no access without token)
 * - /health - Health check endpoint
 * - /:token - Invalid token catch-all, redirect to website
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

	let staticRoutes: StaticRoutes;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		staticRoutes = new StaticRoutes(securityToken, webAssetsPath);
		mockFastify = createMockFastify();
		staticRoutes.registerRoutes(mockFastify as any);
	});

	describe('Route Registration', () => {
		it('should register all static routes', () => {
			// 8 routes: /, /health, manifest.json, sw.js, dashboard, dashboard/, session/:id, /:token
			expect(mockFastify.get).toHaveBeenCalledTimes(8);
		});

		it('should register routes with correct paths', () => {
			expect(mockFastify.routes.has('GET:/')).toBe(true);
			expect(mockFastify.routes.has('GET:/health')).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/manifest.json`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/sw.js`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}`)).toBe(true);
			expect(mockFastify.routes.has(`GET:/${securityToken}/`)).toBe(true);
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

	describe('Null webAssetsPath handling', () => {
		it('should return 404 for manifest.json when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/manifest.json`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 404 for sw.js when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}/sw.js`);
			const reply = createMockReply();
			await route!.handler({}, reply);

			expect(reply.code).toHaveBeenCalledWith(404);
		});

		it('should return 503 for dashboard when webAssetsPath is null', async () => {
			const noAssetsRoutes = new StaticRoutes(securityToken, null);
			const noAssetsFastify = createMockFastify();
			noAssetsRoutes.registerRoutes(noAssetsFastify as any);

			const route = noAssetsFastify.getRoute('GET', `/${securityToken}`);
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
			const customRoutes = new StaticRoutes(customToken, webAssetsPath);
			const customFastify = createMockFastify();
			customRoutes.registerRoutes(customFastify as any);

			expect(customFastify.routes.has(`GET:/${customToken}`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/manifest.json`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/sw.js`)).toBe(true);
			expect(customFastify.routes.has(`GET:/${customToken}/session/:sessionId`)).toBe(true);
		});
	});

	describe('Index HTML freshness', () => {
		it('should serve updated index.html content after the file changes on disk', async () => {
			const tempRoot = mkdtempSync(path.join(tmpdir(), 'maestro-static-routes-'));
			const tempAssetsPath = path.join(tempRoot, 'web');
			const tempIndexPath = path.join(tempAssetsPath, 'index.html');

			mkdirSync(tempAssetsPath, { recursive: true });

			try {
				writeFileSync(
					tempIndexPath,
					'<!doctype html><html><head><script type="module" src="./assets/main-old.js"></script></head><body></body></html>',
					'utf8'
				);

				const freshRoutes = new StaticRoutes(securityToken, tempAssetsPath);
				const freshFastify = createMockFastify();
				freshRoutes.registerRoutes(freshFastify as any);

				const route = freshFastify.getRoute('GET', `/${securityToken}`);
				const firstReply = createMockReply();
				await route!.handler({}, firstReply);

				expect(firstReply.type).toHaveBeenCalledWith('text/html');
				expect(firstReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/assets/main-old.js`)
				);

				writeFileSync(
					tempIndexPath,
					'<!doctype html><html><head><script type="module" src="./assets/main-new.js"></script></head><body></body></html>',
					'utf8'
				);

				const secondReply = createMockReply();
				await route!.handler({}, secondReply);

				expect(secondReply.send).toHaveBeenCalledWith(
					expect.stringContaining(`/${securityToken}/assets/main-new.js`)
				);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		});
	});

	describe('XSS Sanitization (sanitizeId)', () => {
		// Access private method via type casting for testing
		const getSanitizeId = (routes: StaticRoutes) => {
			return (routes as any).sanitizeId.bind(routes);
		};

		it('should allow valid UUID-style IDs', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('abc123')).toBe('abc123');
			expect(sanitizeId('session-1')).toBe('session-1');
			expect(sanitizeId('tab_abc_123')).toBe('tab_abc_123');
			expect(sanitizeId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
				'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
			);
		});

		it('should return null for null/undefined input', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId(null)).toBeNull();
			expect(sanitizeId(undefined)).toBeNull();
			expect(sanitizeId('')).toBeNull();
		});

		it('should reject XSS payloads with script tags', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('<script>alert(1)</script>')).toBeNull();
			expect(sanitizeId('session<script>')).toBeNull();
			expect(sanitizeId('tab</script>')).toBeNull();
		});

		it('should reject XSS payloads with JavaScript URLs', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('javascript:alert(1)')).toBeNull();
			expect(sanitizeId('session:javascript')).toBeNull();
		});

		it('should reject XSS payloads with HTML entities', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('&lt;script&gt;')).toBeNull();
			expect(sanitizeId('session&#x3C;')).toBeNull();
		});

		it('should reject special characters that could break HTML/JS', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('"onload="alert(1)')).toBeNull();
			expect(sanitizeId("'onclick='alert(1)")).toBeNull();
			expect(sanitizeId('session;alert(1)')).toBeNull();
			expect(sanitizeId('session&alert=1')).toBeNull();
			expect(sanitizeId('session?alert=1')).toBeNull();
			expect(sanitizeId('session#alert')).toBeNull();
		});

		it('should reject whitespace', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('session 1')).toBeNull();
			expect(sanitizeId('tab\t1')).toBeNull();
			expect(sanitizeId('tab\n1')).toBeNull();
		});

		it('should reject path traversal attempts', () => {
			const sanitizeId = getSanitizeId(staticRoutes);
			expect(sanitizeId('../../../etc/passwd')).toBeNull();
			expect(sanitizeId('..%2F..%2F')).toBeNull();
		});
	});
});
