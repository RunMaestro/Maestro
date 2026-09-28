import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { WebServer } from '../../../main/web-server/WebServer';
import { MEDIA_PATH_PARAM_MAX_LENGTH } from '../../../main/web-server/routes/mediaRoutes';

// Keep Sentry inert; constructing a WebServer should never reach it.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('WebServer PWA asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('resolves PWA assets from the built web-desktop bundle', () => {
		// The web-desktop vite publicDir copies src/web/public/* (manifest.json,
		// service worker, icons/) into dist/web-desktop, so that directory is the
		// PWA asset root. manifest.json is the marker file we probe for.
		const bundleDir = path.join(tempRoot, 'dist', 'web-desktop');
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(path.join(bundleDir, 'manifest.json'), '{"name":"Maestro"}');

		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBe(bundleDir);
	});

	it('returns null when no built bundle provides PWA assets', () => {
		// Empty cwd, and the source web-desktop dir ships no manifest.json, so no
		// candidate path resolves.
		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBeNull();
	});
});

describe('WebServer Fastify configuration', () => {
	it('raises maxParamLength so the media route can match a hex-encoded absolute path', () => {
		// mediaRoutes.test.ts proves the constant is large enough on a Fastify
		// instance of its own; this proves WebServer actually passes it. Without
		// it the router's default cap of 100 404s every real media file before
		// the handler ever runs, and no other test would notice.
		const server = new WebServer(0);

		expect(server.getServer().initialConfig.routerOptions.maxParamLength).toBe(
			MEDIA_PATH_PARAM_MAX_LENGTH
		);
		expect(MEDIA_PATH_PARAM_MAX_LENGTH).toBeGreaterThan(100);
	});
});

describe('WebServer Web Login revocation', () => {
	// The gate checks the cookie at the upgrade and never again, so a store
	// mutation is the only moment a live socket can learn its session is gone.
	// Keyed on the SESSION, not the account: a password reset and a logout keep
	// the account and remove the session, and both must close the socket.
	it('closes sockets whose session no longer resolves and leaves the rest alone', async () => {
		const listeners: Array<() => void> = [];
		const live = new Set(['sid-live']);
		const fakeStore = {
			onChange: (l: () => void) => {
				listeners.push(l);
				return () => {};
			},
			resolveSession: (sid?: string) =>
				sid && live.has(sid) ? { id: 'u1', username: 'ada', displayName: 'Ada' } : undefined,
		};
		// WebServer is already imported at the top of this file, so the mock has
		// to reach a FRESH module graph.
		vi.resetModules();
		vi.doMock('../../../main/web-server/auth/web-user-store', () => ({
			getWebUserStore: () => fakeStore,
		}));
		const { WebServer: IsolatedWebServer } = await import('../../../main/web-server/WebServer');
		const { WEB_LOGIN_WS_CLOSE_CODE } = await import('../../../shared/webLogin');
		const server = new IsolatedWebServer(0);

		const make = (id: string, sessionId?: string) => ({
			id,
			socket: { close: vi.fn(), readyState: 1, send: vi.fn() },
			connectedAt: Date.now(),
			...(sessionId ? { user: { id: 'u1', username: 'ada', displayName: 'Ada' }, sessionId } : {}),
		});
		const revoked = make('c-revoked', 'sid-reset');
		const kept = make('c-kept', 'sid-live');
		const cli = make('c-cli');
		const clients = (server as any).webClients as Map<string, unknown>;
		clients.set(revoked.id, revoked);
		clients.set(kept.id, kept);
		clients.set(cli.id, cli);

		(server as any).watchWebUserStore();
		expect(listeners).toHaveLength(1);
		listeners[0]();

		expect(revoked.socket.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		expect(kept.socket.close).not.toHaveBeenCalled();
		expect(cli.socket.close).not.toHaveBeenCalled();

		vi.doUnmock('../../../main/web-server/auth/web-user-store');
		vi.resetModules();
	});
});
