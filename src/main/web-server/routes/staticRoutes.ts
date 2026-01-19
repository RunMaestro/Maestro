/**
 * Static Routes for Web Server
 *
 * This module contains core route handlers extracted from web-server.ts.
 * Routes handle static files, dashboard views, PWA files, and security redirects.
 *
 * Routes:
 * - / - Redirect to GitHub (no access without token)
 * - /health - Health check endpoint
 * - /$TOKEN/manifest.json - PWA manifest
 * - /$TOKEN/sw.js - PWA service worker
 * - /$TOKEN - Dashboard (list all sessions)
 * - /$TOKEN/session/:sessionId - Single session view
 * - /:token - Invalid token catch-all, redirect to GitHub
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../utils/logger';

// Logger context for all static route logs
const LOG_CONTEXT = 'WebServer:Static';

// Redirect URL for invalid/missing token requests
const REDIRECT_URL = 'https://runmaestro.ai';

/**
 * Static Routes Class
 *
 * Encapsulates all static/core route setup logic.
 * Handles dashboard, PWA files, and security redirects.
 */
export class StaticRoutes {
	private securityToken: string;
	private webAssetsPath: string | null;

	constructor(securityToken: string, webAssetsPath: string | null) {
		this.securityToken = securityToken;
		this.webAssetsPath = webAssetsPath;
	}

	/**
	 * Validate the security token from a request
	 */
	private validateToken(token: string): boolean {
		return token === this.securityToken;
	}

	/**
	 * Serve the index.html file for SPA routes
	 * Rewrites asset paths to include the security token
	 */
	private serveIndexHtml(reply: FastifyReply, sessionId?: string, tabId?: string | null): void {
		if (!this.webAssetsPath) {
			reply.code(503).send({
				error: 'Service Unavailable',
				message: 'Web interface not built. Run "npm run build:web" to build web assets.',
			});
			return;
		}

		const indexPath = path.join(this.webAssetsPath, 'index.html');
		if (!existsSync(indexPath)) {
			reply.code(404).send({
				error: 'Not Found',
				message: 'Web interface index.html not found.',
			});
			return;
		}

		try {
			// Read and transform the HTML to fix asset paths
			let html = readFileSync(indexPath, 'utf-8');

			// Transform relative paths to use the token-prefixed absolute paths
			html = html.replace(/\.\/assets\//g, `/${this.securityToken}/assets/`);
			html = html.replace(/\.\/manifest\.json/g, `/${this.securityToken}/manifest.json`);
			html = html.replace(/\.\/icons\//g, `/${this.securityToken}/icons/`);
			html = html.replace(/\.\/sw\.js/g, `/${this.securityToken}/sw.js`);

			// Inject config for the React app to know the token and session context
			const configScript = `<script>
        window.__MAESTRO_CONFIG__ = {
          securityToken: "${this.securityToken}",
          sessionId: ${sessionId ? `"${sessionId}"` : 'null'},
          tabId: ${tabId ? `"${tabId}"` : 'null'},
          apiBase: "/${this.securityToken}/api",
          wsUrl: "/${this.securityToken}/ws"
        };
      </script>`;
			html = html.replace('</head>', `${configScript}</head>`);

			reply.type('text/html').send(html);
		} catch (err) {
			logger.error('Error serving index.html', LOG_CONTEXT, err);
			reply.code(500).send({
				error: 'Internal Server Error',
				message: 'Failed to serve web interface.',
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

		// PWA manifest.json
		server.get(`/${token}/manifest.json`, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const manifestPath = path.join(this.webAssetsPath, 'manifest.json');
			if (!existsSync(manifestPath)) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			return reply.type('application/json').send(readFileSync(manifestPath, 'utf-8'));
		});

		// PWA service worker
		server.get(`/${token}/sw.js`, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const swPath = path.join(this.webAssetsPath, 'sw.js');
			if (!existsSync(swPath)) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			return reply.type('application/javascript').send(readFileSync(swPath, 'utf-8'));
		});

		// Dashboard - list all live sessions
		server.get(`/${token}`, async (_request, reply) => {
			this.serveIndexHtml(reply);
		});

		// Dashboard with trailing slash
		server.get(`/${token}/`, async (_request, reply) => {
			this.serveIndexHtml(reply);
		});

		// Single session view - works for any valid session (security token protects access)
		// Supports ?tabId=xxx query parameter for deep-linking to specific tabs
		server.get(`/${token}/session/:sessionId`, async (request, reply) => {
			const { sessionId } = request.params as { sessionId: string };
			const { tabId } = request.query as { tabId?: string };
			// Note: Session validation happens in the frontend via the sessions list
			this.serveIndexHtml(reply, sessionId, tabId || null);
		});

		// Catch-all for invalid tokens - redirect to GitHub
		server.get('/:token', async (request, reply) => {
			const { token: reqToken } = request.params as { token: string };
			if (!this.validateToken(reqToken)) {
				return reply.redirect(302, REDIRECT_URL);
			}
			// Valid token but no specific route - serve dashboard
			this.serveIndexHtml(reply);
		});

		logger.debug('Static routes registered', LOG_CONTEXT);
	}
}
