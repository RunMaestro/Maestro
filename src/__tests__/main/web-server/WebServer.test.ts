import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WebServer } from '../../../main/web-server/WebServer';
import { MEDIA_PATH_PARAM_MAX_LENGTH } from '../../../main/web-server/routes/mediaRoutes';
import {
	WebUserStore,
	setWebUserStoreForTests,
} from '../../../main/web-server/auth/web-user-store';
import { WEB_LOGIN_COOKIE, WEB_LOGIN_WS_CLOSE_CODE } from '../../../shared/webLogin';
import { PairingHost } from '../../../main/lite/pairing/host';
import { PairedDevices } from '../../../main/lite/pairing/paired-devices';
import { HostPairingWindow } from '../../../main/lite/pairing/host-window';
import { ADMISSION_HEADER, CONNECT_PATH } from '../../../main/lite/pairing/protocol';

const isolated = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({
	app: { getPath: () => isolated.directory, getVersion: () => '0.0.0-test' },
}));
beforeEach(() => {
	isolated.directory = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-server-'));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(isolated.directory, { recursive: true, force: true });
});

// Keep Sentry inert; constructing a WebServer should never reach it.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// The LAN address probe touches the real network; pin it. The address watcher
// still needs the module's other exports.
vi.mock('../../../main/utils/networkUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/networkUtils')>()),
	getLocalIpAddress: vi.fn().mockResolvedValue('192.168.1.50'),
}));

// start() installs the IPC-bridge fanout, which needs Electron.
vi.mock('../../../main/web-server/handlers/bridgeHandlers', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/web-server/handlers/bridgeHandlers')>()),
	installWebContentsBridgeHook: vi.fn(),
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

describe('WebServer desktop asset caching', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-cache-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
		const assets = path.join(tempRoot, 'dist', 'web-desktop', 'assets');
		mkdirSync(path.join(assets, 'fonts'), { recursive: true });
		writeFileSync(path.join(tempRoot, 'dist', 'web-desktop', 'index.html'), '<html></html>');
		writeFileSync(path.join(assets, 'main-BOEbwE3b.js'), 'export {};');
		writeFileSync(path.join(assets, 'fonts', 'inter-latin-400_700-1.woff2'), 'font');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	// Revalidating every module on every load is what overflowed a Cloudflare
	// quick tunnel's in-flight request cap when several phone tabs reloaded at
	// once, so the header has to actually reach the wire, on 304s included.
	it('serves hashed bundle files as immutable and leaves the fonts folder revalidating', async () => {
		const server = new WebServer(0);
		await (server as any).setupMiddleware();
		const fastify = server.getServer();
		const token = server.getSecurityToken();

		const hashed = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/main-BOEbwE3b.js`,
		});
		expect(hashed.statusCode).toBe(200);
		expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');

		const revalidated = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/main-BOEbwE3b.js`,
			headers: { 'if-none-match': String(hashed.headers.etag) },
		});
		expect(revalidated.statusCode).toBe(304);
		expect(revalidated.headers['cache-control']).toBe('public, max-age=31536000, immutable');

		const font = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/fonts/inter-latin-400_700-1.woff2`,
		});
		expect(font.statusCode).toBe(200);
		expect(font.headers['cache-control']).not.toContain('immutable');

		await fastify.close();
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
describe('independent browser-account and paired-device revocation', () => {
	it('proactively closes idle real sockets through the account watcher and remembered-device verifier', async () => {
		const users = new WebUserStore(path.join(isolated.directory, 'web-users.json'));
		const password = 'synthetic-revocation-test-password';
		await users.createUser({ username: 'operator', password });
		const login = await users.login('operator', password);
		if (!login.ok) throw new Error('Synthetic account did not authenticate');
		setWebUserStoreForTests(users);
		const credential = 'A'.repeat(43) + '.' + 'B'.repeat(43);
		const origin = 'https://host.example.test';
		const devices = new PairedDevices(isolated.directory);
		await devices.add(credential, 'Synthetic laptop', 'synthetic-host', origin);
		// Restore the remembered grant from disk, as a host restart would.
		const host = await PairingHost.create(
			'Synthetic host',
			'synthetic-host',
			[origin],
			Date.now,
			true,
			new PairedDevices(isolated.directory)
		);
		vi.spyOn(HostPairingWindow.prototype, 'host', 'get').mockReturnValue(host);
		const server = new WebServer(0);
		const sockets: WebSocket[] = [];
		try {
			const started = await server.start();
			const address = new URL(started.url).origin;
			const account = new WebSocket(`${address.replace('http:', 'ws:')}/${started.token}/ws`, {
				headers: { cookie: `${WEB_LOGIN_COOKIE}=${login.sessionId}`, origin: address },
			});
			sockets.push(account);
			expect(JSON.parse(String((await once(account, 'message'))[0])).type).toBe('connected');
			const paired = new WebSocket(`${address.replace('http:', 'ws:')}${CONNECT_PATH}/ws`, {
				headers: { host: new URL(origin).host, origin, [ADMISSION_HEADER]: credential },
			});
			sockets.push(paired);
			expect(JSON.parse(String((await once(paired, 'message'))[0])).type).toBe('connected');
			expect(server.getWebClientCount()).toBe(2);
			const accountSend = vi.spyOn(account, 'send');
			const pairedSend = vi.spyOn(paired, 'send');
			const accountClosed = once(account, 'close', { signal: AbortSignal.timeout(5000) });
			await users.logout(login.sessionId);
			expect((await accountClosed)[0]).toBe(WEB_LOGIN_WS_CLOSE_CODE);
			expect(paired.readyState).toBe(WebSocket.OPEN);
			await vi.waitFor(() => expect(server.getWebClientCount()).toBe(1));
			const pairedClosed = once(paired, 'close', { signal: AbortSignal.timeout(5000) });
			await host.devices.revoke(credential.split('.')[0]);
			expect((await pairedClosed)[0]).toBe(4403);
			await vi.waitFor(() => expect(server.getWebClientCount()).toBe(0));
			expect(accountSend).not.toHaveBeenCalled();
			expect(pairedSend).not.toHaveBeenCalled();
		} finally {
			for (const socket of sockets) socket.terminate();
			await server.stop();
			host.dispose();
			await users.flush();
			setWebUserStoreForTests(null);
		}
	});
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
		const device = {
			...make('c-device'),
			user: { id: 'paired-device:abc', username: 'paired-device', displayName: 'Laptop' },
		};
		const clients = (server as any).webClients as Map<string, unknown>;
		clients.set(revoked.id, revoked);
		clients.set(kept.id, kept);
		clients.set(cli.id, cli);
		clients.set(device.id, device);

		(server as any).watchWebUserStore();
		expect(listeners).toHaveLength(1);
		listeners[0]();

		expect(revoked.socket.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		expect(kept.socket.close).not.toHaveBeenCalled();
		expect(cli.socket.close).not.toHaveBeenCalled();
		expect(device.socket.close).not.toHaveBeenCalled();

		vi.doUnmock('../../../main/web-server/auth/web-user-store');
		vi.resetModules();
	});
});

describe('WebServer network exposure', () => {
	// start() with the route and store wiring stubbed out, so only the bind
	// decision is under test.
	async function startStubbed(server: WebServer) {
		const internals = server as any;
		internals.setupMiddleware = vi.fn();
		internals.setupRoutes = vi.fn();
		internals.setupMessageHandlerCallbacks = vi.fn();
		internals.watchWebUserStore = vi.fn();
		internals.startAddressWatcher = vi.fn();
		const listen = vi.spyOn(server.getServer(), 'listen').mockResolvedValue('' as never);
		const result = await server.start();
		return { listen, result, internals };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('listens on loopback only and advertises 127.0.0.1 by default', async () => {
		const server = new WebServer(0);
		const { listen, result, internals } = await startStubbed(server);

		expect(server.isLanAccessible()).toBe(false);
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '127.0.0.1' });
		expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(internals.startAddressWatcher).not.toHaveBeenCalled();
	});

	it('listens on every interface and advertises the LAN address when asked for LAN access', async () => {
		const server = new WebServer(0, undefined, { lanAccess: true });
		const { listen, result, internals } = await startStubbed(server);

		expect(server.isLanAccessible()).toBe(true);
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '0.0.0.0' });
		expect(result.url).toMatch(/^http:\/\/192\.168\.1\.50:/);
		expect(internals.startAddressWatcher).toHaveBeenCalled();
	});
	it('keeps the live core HTTP server available when optional pairing initialization fails', async () => {
		const server = new WebServer(0);
		server.setRemoteHostStatusProvider(async () => {
			throw new Error('Pairing status unavailable');
		});
		try {
			const started = await server.start();
			const health = await fetch(new URL('/health', started.url));
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: 'ok' });
			expect((await server.start()).port).toBe(started.port);
		} finally {
			await server.stop();
		}
	});
});

describe('WebServer origin policy', () => {
	let server: WebServer;

	beforeEach(async () => {
		server = new WebServer(0);
		await (server as any).setupMiddleware();
		server.getServer().get('/probe', async () => 'ok');
		server.getServer().post('/probe', async () => 'ok');
	});

	afterEach(async () => {
		await server.getServer().close();
	});

	function request(method: 'GET' | 'POST', headers: Record<string, string>) {
		return server.getServer().inject({
			method,
			url: '/probe',
			headers,
			...(method === 'POST' ? { payload: '{"command":"echo pwned"}' } : {}),
		});
	}

	it('serves requests with no Origin header (maestro-cli, same-origin GETs)', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('serves requests whose Origin is the host they were sent to', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('refuses a foreign Origin and sends no CORS grant', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'https://evil.example' });
		expect(res.statusCode).toBe(403);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('refuses the opaque "null" Origin a sandboxed iframe sends', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'null' });
		expect(res.statusCode).toBe(403);
	});

	it('refuses a cross-origin POST outright instead of only hiding the response', async () => {
		const res = await request('POST', {
			host: '127.0.0.1:1234',
			origin: 'https://evil.example',
			'content-type': 'text/plain',
		});
		expect(res.statusCode).toBe(403);
	});

	it('serves the trusted tunnel origin even when the Host header differs', async () => {
		server.setTrustedOriginsProvider(() => ['https://abc-def.trycloudflare.com']);
		const res = await request('GET', {
			host: '127.0.0.1:1234',
			origin: 'https://abc-def.trycloudflare.com',
		});
		expect(res.statusCode).toBe(200);
	});
});
