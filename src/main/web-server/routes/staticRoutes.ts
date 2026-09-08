/**
 * Static Routes for Web Server
 *
 * This module contains core route handlers extracted from web-server.ts.
 * Routes handle static files, dashboard views, PWA files, and security redirects.
 *
 * Routes:
 * - / - Redirect to GitHub (no access without token)
 * - /health - Health check endpoint
 * - /og.png - Social preview card (no token; static brand mark)
 * - /$TOKEN/manifest.json - PWA manifest
 * - /$TOKEN/sw.js - PWA service worker
 * - /$TOKEN - Web-desktop interface (the default UI)
 * - /$TOKEN/desktop - Legacy alias for the web-desktop interface
 * - /$TOKEN/session/:sessionId - Deprecated deep link, serves the desktop interface
 * - /:token - Invalid token catch-all, redirect to GitHub
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { OG_IMAGE_ROUTE, buildSocialPreviewTags, resolveRequestOrigin } from '../social-preview';

// Logger context for all static route logs
const LOG_CONTEXT = 'WebServer:Static';

// Redirect URL for invalid/missing token requests
const REDIRECT_URL = 'https://runmaestro.ai';

/**
 * File cache for static assets that don't change at runtime.
 * Prevents blocking file reads on every request.
 */
interface CachedFile {
	content: string;
	exists: boolean;
}

const fileCache = new Map<string, CachedFile>();

/**
 * Read a file with caching - only reads from disk once per path.
 * Returns null if file doesn't exist.
 */
function getCachedFile(filePath: string): string | null {
	const cached = fileCache.get(filePath);
	if (cached !== undefined) {
		return cached.exists ? cached.content : null;
	}

	// First access - read from disk and cache
	if (!existsSync(filePath)) {
		fileCache.set(filePath, { content: '', exists: false });
		return null;
	}

	try {
		const content = readFileSync(filePath, 'utf-8');
		fileCache.set(filePath, { content, exists: true });
		return content;
	} catch {
		fileCache.set(filePath, { content: '', exists: false });
		return null;
	}
}

/**
 * Static Routes Class
 *
 * Encapsulates all static/core route setup logic.
 * Handles dashboard, PWA files, and security redirects.
 */
export class StaticRoutes {
	private securityToken: string;
	// Directory that ships the PWA manifest/service worker/icons. These are
	// copied into the web-desktop bundle by its vite publicDir, so this points at
	// the same bundle root as webDesktopPath.
	private webAssetsPath: string | null;
	// Web-desktop bundle root - the default browser interface, served at the
	// token root and at /<token>/desktop. Null when the bundle hasn't been built.
	private webDesktopPath: string | null;
	// Read-only token for the Concerto HTML document route, handed to the page so
	// the renderer can point a Movement's iframe at an HTTP URL the browser can
	// actually load (the desktop app uses the maestro-concerto:// scheme instead).
	private concertoToken: string;

	constructor(
		securityToken: string,
		webAssetsPath: string | null,
		webDesktopPath: string | null,
		concertoToken: string
	) {
		this.securityToken = securityToken;
		this.webAssetsPath = webAssetsPath;
		this.webDesktopPath = webDesktopPath;
		this.concertoToken = concertoToken;
	}

	/**
	 * Validate the security token from a request
	 */
	private validateToken(token: string): boolean {
		return token === this.securityToken;
	}

	/**
	 * Serve the web-desktop bundle's index.html for SPA routes.
	 *
	 * The bundle's asset references are rewritten to the absolute
	 * `/<token>/desktop/assets/` prefix (matching the asset mount in
	 * WebServer), so the same HTML renders correctly whether it is served from
	 * the token root or from `/<token>/desktop`.
	 *
	 * Takes the request, not just the reply, because the social preview tags
	 * injected below have to name an ABSOLUTE origin and only the request knows
	 * which host the page is being reached on.
	 */
	private serveDesktopIndex(request: FastifyRequest, reply: FastifyReply): void {
		if (!this.webDesktopPath) {
			reply.code(503).send({
				error: 'Service Unavailable',
				message: 'Web-Desktop bundle not built. Run "npm run build:web-desktop".',
			});
			return;
		}

		const indexPath = path.join(this.webDesktopPath, 'index.html');
		if (!existsSync(indexPath)) {
			reply.code(404).send({
				error: 'Not Found',
				message: 'Web-Desktop bundle index.html not found.',
			});
			return;
		}

		try {
			// Read index.html fresh so rebuilt asset hashes are reflected immediately.
			let html = readFileSync(indexPath, 'utf-8');
			const token = this.securityToken;

			// Rewrite the bundle's relative asset references to the absolute
			// token-prefixed path the asset mount serves from.
			html = html.replace(/\.\/assets\//g, `/${token}/desktop/assets/`);
			html = html.replace(/="\/assets\//g, `="/${token}/desktop/assets/`);

			// Inject config so the renderer's electron-shim knows where to open
			// the WebSocket bridge. The desktop app manages its own session
			// selection, so sessionId/tabId are intentionally null.
			const configScript = `<script>
        window.__MAESTRO_CONFIG__ = {
          securityToken: ${JSON.stringify(token)},
          sessionId: null,
          tabId: null,
          apiBase: "/${token}/api",
          wsUrl: "/${token}/ws",
          concertoToken: ${JSON.stringify(this.concertoToken)}
        };
      </script>`;

			// Wire the PWA manifest and iOS home-screen icon into the served page.
			// Both are HTTP-served under the token prefix (see registerRoutes and
			// WebServer's icons mount). The manifest uses relative start_url/scope
			// ("./"), which the browser resolves against the manifest URL, so it
			// works under the token prefix unchanged.
			const pwaLinks =
				`<link rel="manifest" href="/${token}/manifest.json" />` +
				`<link rel="icon" href="/${token}/icons/icon-192x192.png" />` +
				`<link rel="apple-touch-icon" href="/${token}/icons/icon-192x192.png" />`;

			// Open Graph / Twitter card. Built here rather than in the bundle's
			// index.html because a crawler drops a relative og:image outright, and
			// only the request knows the host the link was shared as. Absent a
			// usable Host header the block is simply omitted - a card pointing at
			// a guessed origin is worse than no card.
			const origin = resolveRequestOrigin(request.headers as Record<string, unknown> | undefined);
			const socialTags = origin ? buildSocialPreviewTags(origin) : '';

			html = html.replace('</head>', `${socialTags}${configScript}${pwaLinks}</head>`);

			reply.type('text/html').send(html);
		} catch (err) {
			void captureException(err);
			logger.error('Error serving web-desktop index.html', LOG_CONTEXT, err);
			reply.code(500).send({
				error: 'Internal Server Error',
				message: 'Failed to serve web-desktop interface.',
			});
		}
	}

	/**
	 * Register all static routes on the Fastify server
	 */
	registerRoutes(server: FastifyInstance): void {
		const token = this.securityToken;

		// Root path - redirect to GitHub (no access without token)
		server.get('/', async (_request, reply) => {
			return reply.redirect(302, REDIRECT_URL);
		});

		// Health check (no auth required)
		server.get('/health', async () => {
			return { status: 'ok', timestamp: Date.now() };
		});

		// Social preview card. Deliberately outside the token prefix: see
		// OG_IMAGE_ROUTE in ../social-preview.ts for why that is safe and why it
		// matters. Fastify matches a static path ahead of the `/:token` parametric
		// route below, so this cannot be swallowed by the invalid-token catch-all.
		server.get(OG_IMAGE_ROUTE, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const imagePath = path.join(this.webAssetsPath, 'og-image.png');
			if (!existsSync(imagePath)) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			// Not run through getCachedFile: that cache holds utf-8 strings, which
			// would corrupt a PNG. A crawler fetches this once per share, so the
			// read is not worth a second cache - but it IS worth a long max-age,
			// since a brand mark that changes only on rebuild is what immutable
			// caching is for, and chat clients re-fetch previews aggressively.
			return reply
				.type('image/png')
				.header('Cache-Control', 'public, max-age=86400')
				.send(readFileSync(imagePath));
		});

		// PWA manifest.json (cached)
		server.get(`/${token}/manifest.json`, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const manifestPath = path.join(this.webAssetsPath, 'manifest.json');
			const content = getCachedFile(manifestPath);
			if (content === null) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			return reply.type('application/json').send(content);
		});

		// PWA service worker (cached)
		server.get(`/${token}/sw.js`, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const swPath = path.join(this.webAssetsPath, 'sw.js');
			const content = getCachedFile(swPath);
			if (content === null) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			return reply.type('application/javascript').send(content);
		});

		// Web-desktop interface - the default UI at the token root.
		server.get(`/${token}`, async (request, reply) => {
			this.serveDesktopIndex(request, reply);
		});

		// Token root with trailing slash
		server.get(`/${token}/`, async (request, reply) => {
			this.serveDesktopIndex(request, reply);
		});

		// Legacy /desktop alias - kept so URLs from before the desktop bundle
		// became the default (when it lived at /<token>/desktop) still resolve.
		server.get(`/${token}/desktop`, async (request, reply) => {
			this.serveDesktopIndex(request, reply);
		});
		server.get(`/${token}/desktop/`, async (request, reply) => {
			this.serveDesktopIndex(request, reply);
		});

		// Deprecated single-session deep link. The desktop app manages its own
		// session selection, so this just serves the full interface.
		server.get(`/${token}/session/:sessionId`, async (request, reply) => {
			this.serveDesktopIndex(request, reply);
		});

		// Catch-all for invalid tokens - redirect to GitHub
		server.get('/:token', async (request, reply) => {
			const { token: reqToken } = request.params as { token: string };
			if (!this.validateToken(reqToken)) {
				return reply.redirect(302, REDIRECT_URL);
			}
			// Valid token but no specific route - serve the desktop interface
			this.serveDesktopIndex(request, reply);
		});

		logger.debug('Static routes registered', LOG_CONTEXT);
	}
}
