import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PairingHost } from '../../../../main/lite/pairing/host';
import { PairedDevices } from '../../../../main/lite/pairing/paired-devices';
import { PairingClient } from '../../../../main/lite/pairing/client';
import {
	ADMISSION_HEADER,
	CONNECT_PATH,
	GRANT_TTL,
	PAIR_PATH,
	type PairingTransport,
} from '../../../../main/lite/pairing/protocol';
import { registerPairingRoutes } from '../../../../main/lite/pairing/routes';
import { registerLiteConnectionRoutes } from '../../../../main/web-server/routes/liteConnectionRoutes';
import { webLoginPreHandler } from '../../../../main/web-server/auth/web-login-hook';
import { ApiRoutes } from '../../../../main/web-server/routes/apiRoutes';
import { WsRoute } from '../../../../main/web-server/routes/wsRoute';
import { WEB_LOGIN_COOKIE } from '../../../../shared/webLogin';
import { isAllowedRequestOrigin } from '../../../../main/web-server/originPolicy';
const appVersion: string = require('../../../../../package.json').version;
const state = vi.hoisted(() => ({ enabled: false, authenticated: false }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback: unknown) =>
			key === 'encoreFeatures' ? { webLogin: state.enabled } : fallback,
	}),
}));
vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({
		resolveSession: (id?: string) =>
			state.authenticated && id === 'isolated-session'
				? { id: 'user', username: 'test', displayName: 'Test' }
				: undefined,
	}),
}));
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	state.enabled = false;
	state.authenticated = false;
});
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
	let now = Date.now();
	const origin = 'https://aster.example.test';
	const directory = mkdtempSync(path.join(tmpdir(), 'lite-device-routes-'));
	let host = await PairingHost.create(
		'Aster',
		'aster-id',
		[origin],
		() => now,
		true,
		new PairedDevices(directory)
	);
	const server = Fastify();
	await server.register(websocket);
	server.addHook('preHandler', webLoginPreHandler('legacy-secret'));
	server.get('/', async () => 'unrelated-root');
	registerPairingRoutes(
		server,
		() => host,
		() => true,
		appVersion
	);
	mkdirSync(path.join(directory, 'assets'));
	writeFileSync(
		path.join(directory, 'index.html'),
		'<html><head></head><body><script src="./assets/desktop.js"></script></body></html>'
	);
	writeFileSync(path.join(directory, 'assets/desktop.js'), 'window.desktopAssetLoaded = true;');
	const api = new ApiRoutes('unexposed-secret', {
		max: 100,
		maxPost: 100,
		enabled: false,
		timeWindow: 60000,
	});
	api.setCallbacks({
		getSessions: () => [],
		getSessionDetail: () => null,
		getTheme: () => null,
		writeToSession: () => false,
		interruptSession: async () => false,
		getHistory: () => [],
		getLiveSessionInfo: () => undefined,
		isSessionLive: () => false,
	});
	api.registerRoutes(server, 'legacy-secret');
	const ws = new WsRoute('unexposed-secret');
	const messages: unknown[] = [];
	ws.setCallbacks({
		isOriginAllowed: (origin, host) => isAllowedRequestOrigin({ origin, host }),
		getBionifyReadingMode: () => false,
		getSessions: () => [],
		getTheme: () => null,
		getCustomCommands: () => [],
		getAutoRunStates: () => new Map(),
		getLiveSessionInfo: () => undefined,
		isSessionLive: () => false,
		onClientConnect: () => {},
		onClientDisconnect: () => {},
		onClientError: () => {},
		handleMessage: (_client, message) => messages.push(message),
	});
	registerLiteConnectionRoutes(server, {
		getHost: () => host,
		webDesktopPath: directory,
		webAssetsPath: directory,
		apiRoutes: api,
		wsRoute: ws,
		getHostStatus: async () => ({
			instanceId: 'aster-id',
			hostName: 'Aster',
			appVersion: 'test',
			platform: process.platform,
			ready: true,
			capabilities: { sessions: true, terminal: true, files: true, browserRelay: true },
		}),
	});
	await server.ready();
	cleanup.push(async () => {
		host.dispose();
		await server.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const route = { endpoint: origin, source: 'tailscale' as const };
	const transport: PairingTransport = {
		async call<T>(operation: string, payload: unknown) {
			const response = await server.inject({
				method: 'POST',
				url: PAIR_PATH + '/' + operation,
				headers: { host: 'aster.example.test' },
				payload: { route, payload },
			});
			if (response.statusCode !== 200) throw new Error(response.json().error);
			return response.json() as T;
		},
	};
	const client = new PairingClient(transport, route, 'Laptop', () => now);
	await client.begin('aster-id');
	const id = host.localRequests()[0].requestId;
	host.approvePin(id);
	await client.poll();
	await client.submit(host.localRequests()[0].pin!);
	expect(host.devices.list('aster-id')).toEqual([]);
	host.confirm(id);
	await client.poll();
	await client.read();
	const credential = client.connectionAdmission();
	const headers = { host: 'aster.example.test', [ADMISSION_HEADER]: credential };
	return {
		server,
		get host() {
			return host;
		},
		client,
		id,
		credential,
		headers,
		directory,
		messages,
		advance: () => {
			now += GRANT_TTL + 1;
		},
		restart: async () => {
			host.dispose();
			host = await PairingHost.create(
				'Aster',
				'aster-id',
				[origin],
				() => now,
				true,
				new PairedDevices(directory)
			);
		},
	};
}
describe('code-only paired-device authorization on production application routes', () => {
	it.each([false, true])(
		'pairs without an account and leaves optional Web Login=%s unchanged',
		async (loginEnabled) => {
			state.enabled = loginEnabled;
			const f = await fixture();
			expect(
				(
					await f.server.inject({
						url: CONNECT_PATH + '/api/sessions',
						headers: { host: 'aster.example.test' },
					})
				).statusCode
			).toBe(403);
			expect(
				(
					await f.server.inject({
						url: CONNECT_PATH + '/api/sessions',
						headers: f.headers,
						remoteAddress: '192.0.2.10',
					})
				).statusCode
			).toBe(403);
			expect(
				(
					await f.server.inject({
						url: CONNECT_PATH + '/api/sessions',
						headers: { ...f.headers, host: 'substitute.example.test' },
					})
				).statusCode
			).toBe(403);
			const handshake = await f.server.inject({
				url: CONNECT_PATH + '/api/lite/handshake',
				headers: f.headers,
			});
			expect(handshake.statusCode).toBe(200);
			expect(handshake.json().authentication).toEqual({
				loginEnabled: false,
				authenticated: true,
				method: 'device-pairing',
			});
			const desktop = await f.server.inject({ url: CONNECT_PATH + '/desktop', headers: f.headers });
			expect(desktop.statusCode).toBe(200);
			expect(desktop.body).toContain(CONNECT_PATH + '/desktop/assets/desktop.js');
			expect(desktop.body).not.toContain('unexposed-secret');
			expect(desktop.headers['set-cookie']).toBeUndefined();
			expect(
				(
					await f.server.inject({
						url: CONNECT_PATH + '/desktop/assets/desktop.js',
						headers: f.headers,
					})
				).body
			).toBe('window.desktopAssetLoaded = true;');
			expect(
				(await f.server.inject({ url: '/legacy-secret/api/sessions', headers: f.headers }))
					.statusCode
			).toBe(loginEnabled ? 401 : 200);
			expect(state.authenticated).toBe(false);
			if (loginEnabled) {
				state.authenticated = true;
				expect(
					(
						await f.server.inject({
							url: '/legacy-secret/api/sessions',
							headers: { cookie: WEB_LOGIN_COOKIE + '=isolated-session' },
						})
					).statusCode
				).toBe(200);
			}
			expect((await f.server.inject('/')).body).toBe('unrelated-root');
		}
	);
	it('remembers only a verifier across host restart; PIN expiry does not expire a paired device; persisted revoke closes HTTP and WS', async () => {
		const f = await fixture();
		const saved = readFileSync(path.join(f.directory, 'lite-paired-devices.json'), 'utf8');
		expect(saved).not.toContain(f.credential);
		expect(saved).not.toContain(f.credential.split('.')[1]);
		f.advance();
		await f.restart();
		expect(
			(await f.server.inject({ url: CONNECT_PATH + '/api/sessions', headers: f.headers }))
				.statusCode
		).toBe(200);
		const socket = await f.server.injectWS(CONNECT_PATH + '/ws', {
			headers: f.headers,
			socket: { remoteAddress: '127.0.0.1' },
		});
		const closed = once(socket, 'close');
		await f.host.devices.revoke(f.host.devices.list('aster-id')[0].id);
		socket.send(JSON.stringify({ type: 'ping' }));
		expect((await closed)[0]).toBe(4403);
		expect(f.messages).toEqual([]);
		await f.restart();
		expect(
			(await f.server.inject({ url: CONNECT_PATH + '/api/sessions', headers: f.headers }))
				.statusCode
		).toBe(403);
	});
	it('canceling the completed proof before client persistence revokes that newly issued device', async () => {
		const f = await fixture();
		await f.client.cancel();
		expect(f.host.devices.list('aster-id')).toEqual([]);
		expect(
			(await f.server.inject({ url: CONNECT_PATH + '/api/sessions', headers: f.headers }))
				.statusCode
		).toBe(403);
	});
});
