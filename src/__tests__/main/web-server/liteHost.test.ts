// @vitest-environment node
import type { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { ipcMain, type BrowserWindow } from 'electron';

const state = vi.hoisted(() => ({
	settings: new Map<string, unknown>(),
	sessions: new Map<string, { id: string; username: string; displayName: string }>(),
	bootstrap: new Map<string, string>(),
	relayReady: false,
}));
vi.mock('electron', async () => {
	const { EventEmitter } = await import('node:events');
	const ipc = new EventEmitter();
	Object.assign(ipc, { _invokeHandlers: new Map<string, unknown>() });
	return { ipcMain: ipc, app: { getVersion: () => '1.2.3' } };
});
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => state.settings.get(key) }),
	getBootstrapStore: () => ({
		get: (key: string) => state.bootstrap.get(key),
		set: (key: string, value: string) => state.bootstrap.set(key, value),
	}),
}));
vi.mock('../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({ resolveSession: (id: string) => state.sessions.get(id) }),
}));
vi.mock('../../../main/browser/browser-relay', () => ({
	isBrowserRelayReady: () => state.relayReady,
}));

import { registerLiteRoutes } from '../../../main/web-server/routes/liteRoutes';
import { webLoginPreHandler } from '../../../main/web-server/auth/web-login-hook';
import { isAllowedRequestOrigin } from '../../../main/web-server/originPolicy';
import { WsRoute, type WsRouteCallbacks } from '../../../main/web-server/routes/wsRoute';
import { createRemoteHostStatusProvider } from '../../../main/web-server/remote-host-status';
import { getOrCreateHostInstanceId } from '../../../main/web-server/host-identity';
import { WEB_LOGIN_WS_CLOSE_CODE } from '../../../shared/webLogin';
import { BroadcastService } from '../../../main/web-server/services/broadcastService';
import { WebSocketMessageHandler } from '../../../main/web-server/handlers/messageHandlers/WebSocketMessageHandler';
import type { WebClient } from '../../../main/web-server/types';

const servers: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
const token = 'host-token';
const ipc = ipcMain as unknown as EventEmitter;
const handlers = Reflect.get(ipc, '_invokeHandlers') as Map<string, unknown>;
const emptyCapabilities = { sessions: false, terminal: false, files: false, browserRelay: false };
beforeEach(() => {
	state.settings.clear();
	state.sessions.clear();
	state.bootstrap.clear();
	state.relayReady = false;
	handlers.clear();
});
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.terminate();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

function windowWithReply(reply: boolean): BrowserWindow {
	const webContents = {
		isDestroyed: () => false,
		isLoadingMainFrame: () => false,
		isCrashed: () => false,
		send: (_channel: string, responseChannel: string) => {
			// A foreign renderer must not consume the listener or fake readiness.
			ipc.emit(responseChannel, { sender: {} }, true);
			ipc.emit(responseChannel, { sender: webContents }, reply);
		},
	};
	return { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
}
function provider(win: BrowserWindow | null, backend = true) {
	return createRemoteHostStatusProvider({
		getMainWindow: () => win,
		getProcessManager: () => (backend ? ({} as never) : null),
	});
}
async function httpHost(win: BrowserWindow | null = null) {
	const server = Fastify();
	servers.push(server);

	server.addHook('preHandler', webLoginPreHandler(token));
	registerLiteRoutes(server, token, provider(win));
	await server.ready();
	return server;
}

describe('Lite host handshake and readiness', () => {
	it('keeps token auth when optional login is off and distinguishes unavailable owner from empty sessions', async () => {
		const server = await httpHost();
		expect((await server.inject('/api/lite/handshake')).statusCode).toBe(404);
		const response = await server.inject(`/${token}/api/lite/handshake`);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			protocolVersion: 1,
			appVersion: '1.2.3',
			ready: false,
			authentication: { loginEnabled: false, authenticated: false },
			capabilities: emptyCapabilities,
		});
		expect(response.json().unavailableReason).toMatch(/renderer/);
		expect(response.headers['cache-control']).toBe('no-store');
		const second = await server.inject(`/${token}/api/lite/handshake`);
		expect(second.json().instanceId).toBe(response.json().instanceId);
	});
	it('requires a live login session even through loopback, with no auth or credential fields in the contract', async () => {
		state.settings.set('encoreFeatures', { webLogin: true });
		const server = await httpHost();
		const url = `/${token}/api/lite/handshake`;
		expect((await server.inject({ url, remoteAddress: '127.0.0.1' })).statusCode).toBe(401);
		expect(
			(await server.inject({ url, headers: { cookie: 'maestro_web_session=stale' } })).statusCode
		).toBe(401);
		state.sessions.set('live', { id: 'operator', username: 'ada', displayName: 'Ada' });
		const response = await server.inject({ url, headers: { cookie: 'maestro_web_session=live' } });
		expect(response.statusCode).toBe(200);
		expect(response.json().authentication).toEqual({ loginEnabled: true, authenticated: true });
		expect(response.body).not.toContain('maestro_web_session');
		state.sessions.delete('live');
		expect(
			(await server.inject({ url, headers: { cookie: 'maestro_web_session=live' } })).statusCode
		).toBe(401);
	});
	it('requires a real owning-renderer acknowledgement, then advertises only installed capabilities', async () => {
		const notReady = await provider(windowWithReply(false))();
		expect(notReady.ready).toBe(false);
		expect(notReady.capabilities).toEqual(emptyCapabilities);
		const ready = await provider(windowWithReply(true))();
		expect(ready.ready).toBe(true);
		expect(ready.capabilities).toEqual(emptyCapabilities);
		for (const channel of [
			'sessions:getBootstrap',
			'sessions:getDeferredContent',
			'sessions:setMany',
			'agents:detect',
			'process:spawn',
			'process:spawnTerminalTab',
			'process:write',
			'process:resize',
			'fs:directoryInfo',
			'fs:readDir',
			'fs:readFile',
			'fs:writeFile',
			'attachments:save',
			'browser:relayOpen',
			'browser:relayFrame',
			'browser:relayInput',
			'browser:relayAction',
			'browser:relayClose',
		])
			handlers.set(channel, () => {});
		state.relayReady = true;
		expect((await provider(windowWithReply(true))()).capabilities).toEqual({
			sessions: true,
			terminal: true,
			files: true,
			browserRelay: true,
		});
		expect((await provider(windowWithReply(true), false)()).ready).toBe(false);
	});
	it('uses the local bootstrap identity without adopting synced installation identity', () => {
		state.settings.set('installationId', 'synced-other-machine');
		const firstStore = {
			get: () => state.bootstrap.get('maestroRemoteInstanceId'),
			set: (_key: string, value: string) => state.bootstrap.set('maestroRemoteInstanceId', value),
		};
		const id = getOrCreateHostInstanceId(firstStore);
		expect(getOrCreateHostInstanceId(firstStore)).toBe(id);
		expect(id).not.toBe('synced-other-machine');
		state.bootstrap.clear();
		expect(getOrCreateHostInstanceId(firstStore)).not.toBe(id);
		expect(() =>
			getOrCreateHostInstanceId({
				get: () => undefined,
				set: () => {
					throw new Error('read-only data directory');
				},
			})
		).toThrow('read-only data directory');
	});
});

describe('live socket authorization', () => {
	it('revokes an already-open socket before accepting another command', async () => {
		state.settings.set('encoreFeatures', { webLogin: true });
		state.sessions.set('live', { id: 'u', username: 'ada', displayName: 'Ada' });
		const server = Fastify();
		servers.push(server);
		await server.register(websocket);
		const accepted: string[] = [];
		const route = new WsRoute(token);
		route.setCallbacks({
			isOriginAllowed: (origin, host) => isAllowedRequestOrigin({ origin, host }),
			handleMessage: (_clientId, message) => accepted.push(message.type),
		} as WsRouteCallbacks);
		route.registerRoute(server);
		const address = await server.listen({ port: 0, host: '127.0.0.1' });
		const socket = new WebSocket(`${address.replace('http:', 'ws:')}/${token}/ws`, {
			headers: { cookie: 'maestro_web_session=live', origin: address },
		});
		sockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once('message', () => resolve());
			socket.once('error', reject);
		});
		state.sessions.delete('live');
		const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
		socket.send(JSON.stringify({ type: 'execute_command', command: 'should not run' }));
		expect(await closed).toBe(WEB_LOGIN_WS_CLOSE_CODE);
		expect(accepted).toEqual([]);
	});
	it('closes a passive token-only socket before sending data when login becomes required', async () => {
		const server = Fastify();
		servers.push(server);
		await server.register(websocket);
		const clients = new Map<string, WebClient>();
		const broadcasts = new BroadcastService();
		broadcasts.setGetWebClientsCallback(() => clients);
		const route = new WsRoute(token);
		route.setCallbacks({
			isOriginAllowed: (origin, host) => isAllowedRequestOrigin({ origin, host }),
			onClientConnect: (client: WebClient) => clients.set(client.id, client),
		} as WsRouteCallbacks);
		route.registerRoute(server);
		const address = await server.listen({ port: 0, host: '127.0.0.1' });
		const socket = new WebSocket(`${address.replace('http:', 'ws:')}/${token}/ws`, {
			headers: { origin: address },
		});
		sockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once('message', () => resolve());
			socket.once('error', reject);
		});
		const received: string[] = [];
		socket.on('message', (value) => received.push(value.toString()));
		state.settings.set('encoreFeatures', { webLogin: true });
		const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
		broadcasts.broadcastToAll({
			type: 'bridge.event',
			channel: 'process:data',
			args: ['a', 'private transcript'],
		});
		expect(await closed).toBe(WEB_LOGIN_WS_CLOSE_CODE);
		expect(received).toEqual([]);
	});
	it('refuses the legacy settings route for host security flags', () => {
		const handler = new WebSocketMessageHandler();
		let mutated = false;
		handler.setCallbacks({
			setSetting: async () => {
				mutated = true;
				return true;
			},
		});
		const sent: string[] = [];
		handler.handleMessage(
			{
				id: 'c',
				connectedAt: 1,
				socket: { send: (value: string) => sent.push(value) } as WebClient['socket'],
			},
			{ type: 'set_setting', key: 'encoreFeatures', value: { webLogin: false } }
		);
		expect(mutated).toBe(false);
		expect(JSON.parse(sent[0])).toMatchObject({ type: 'error' });
	});
});
