// @vitest-environment node
import type { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
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
import {
	REMOTE_WORKFLOWS,
	qualifyRemoteWorkflows,
} from '../../../main/web-server/remote-workflows';
import { getActingUser } from '../../../main/web-server/auth/acting-user';

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
		send: (channel: string, responseChannel: string) => {
			if (channel !== 'remote:liteReady') return;
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

function installWorkflowFixture() {
	const mutations: string[] = [];
	for (const workflow of Object.values(REMOTE_WORKFLOWS)) {
		for (const channel of workflow.methods)
			handlers.set(channel, () => {
				mutations.push(channel);
				return true;
			});
	}
	for (const channel of ['sessions:getBootstrap', 'groups:getAll', 'process:getActiveProcesses'])
		handlers.set(channel, () => []);
	handlers.set('settings:getAll', () => ({ theme: 'dark' }));
	handlers.set('web:getAutoRunStates', () => ({}));
	handlers.set('prompts:getSystemPromptPaths', () => ({
		success: true,
		computerHistoryDir: '/host/context',
	}));
	handlers.set('fs:homeDir', () => '/host/home');
	state.relayReady = true;
	return mutations;
}

describe('Lite host handshake and readiness', () => {
	it('keeps token auth when optional login is off and distinguishes unavailable owner from empty sessions', async () => {
		const server = await httpHost();
		expect((await server.inject('/api/lite/handshake')).statusCode).toBe(404);
		const response = await server.inject(`/${token}/api/lite/handshake`);
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: 'Temporarily unavailable',
			message: 'Owning desktop renderer is unavailable',
		});
		expect(response.headers['cache-control']).toBe('no-store');
	});
	it('requires a live login session even through loopback, with no auth or credential fields in the contract', async () => {
		state.settings.set('encoreFeatures', { webLogin: true });
		installWorkflowFixture();
		const server = await httpHost(windowWithReply(true));
		const url = `/${token}/api/lite/handshake`;
		expect((await server.inject({ url, remoteAddress: '127.0.0.1' })).statusCode).toBe(401);
		expect(
			(await server.inject({ url, headers: { cookie: 'maestro_web_session=stale' } })).statusCode
		).toBe(401);
		state.sessions.set('live', { id: 'operator', username: 'ada', displayName: 'Ada' });
		const response = await server.inject({ url, headers: { cookie: 'maestro_web_session=live' } });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			protocolVersion: 1,
			instanceId: expect.any(String),
			hostName: hostname(),
			appVersion: '1.2.3',
			platform: process.platform,
			ready: true,
			authentication: { loginEnabled: true, authenticated: true },
			capabilities: { sessions: true, terminal: true, files: true, browserRelay: true },
			workflowQualificationVersion: 1,
		});
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

	it('treats an unanswered owner readiness read as transient and recovers when the owner responds', async () => {
		installWorkflowFixture();
		const owner = windowWithReply(true);
		const send = owner.webContents.send;
		let responding = false;
		vi.spyOn(owner.webContents, 'send').mockImplementation((channel, ...args) => {
			if (responding) send(channel, ...args);
		});
		const server = await httpHost(owner);
		const url = `/${token}/api/lite/handshake`;
		const delayed = await server.inject(url);
		expect(delayed.statusCode).toBe(503);
		expect(delayed.json()).toMatchObject({
			error: 'Temporarily unavailable',
			message: 'Owning desktop renderer is not ready to accept remote work',
		});
		expect(delayed.headers['cache-control']).toBe('no-store');
		responding = true;
		const recovered = await server.inject(url);
		expect(recovered.statusCode).toBe(200);
		expect(recovered.json()).toMatchObject({ ready: true, capabilities: { sessions: true } });
	});

	it('qualifies authenticated reads through the real bridge without executing mutations', async () => {
		const mutations = installWorkflowFixture();
		state.settings.set('encoreFeatures', { webLogin: true });
		state.sessions.set('live', { id: 'operator', username: 'ada', displayName: 'Ada' });
		handlers.set('groups:getAll', async () => {
			await Promise.resolve();
			expect(getActingUser()?.id).toBe('operator');
			return [];
		});
		const server = await httpHost(windowWithReply(true));
		const response = await server.inject({
			url: '/' + token + '/api/lite/handshake',
			headers: { cookie: 'maestro_web_session=live' },
		});
		expect(response.json().capabilities).toEqual({
			sessions: true,
			terminal: true,
			files: true,
			browserRelay: true,
		});
		expect(response.json().workflowQualificationVersion).toBe(1);
		expect(mutations).toEqual([]);
	});

	it('rejects a nominal session capability with a missing conversation-close operation', async () => {
		installWorkflowFixture();
		handlers.delete('web:requestCloseTab');
		const server = await httpHost(windowWithReply(true));
		const response = await server.inject('/' + token + '/api/lite/handshake');
		expect(response.json().capabilities.sessions).toBe(false);
		expect(response.json().capabilities.files).toBe(true);
		expect(response.json().unavailableReason).toContain('web:requestCloseTab');
		expect(response.statusCode).toBe(200);
	});

	it('rejects a failed prompt-context read and does not disclose its private payload', async () => {
		installWorkflowFixture();
		handlers.set('prompts:getSystemPromptPaths', () => ({
			success: false,
			error: '/private/host/path',
		}));
		const server = await httpHost(windowWithReply(true));
		const response = await server.inject('/' + token + '/api/lite/handshake');
		expect(response.statusCode).toBe(503);
		expect(response.json().message).toContain('prompts:getSystemPromptPaths');
		expect(response.body).not.toContain('/private/host/path');
	});

	it('rechecks revocation after asynchronous workflow reads', async () => {
		installWorkflowFixture();
		state.settings.set('encoreFeatures', { webLogin: true });
		state.sessions.set('live', { id: 'operator', username: 'ada', displayName: 'Ada' });
		handlers.set('groups:getAll', async () => {
			state.sessions.delete('live');
			return [];
		});
		const server = await httpHost(windowWithReply(true));
		expect(
			(
				await server.inject({
					url: '/' + token + '/api/lite/handshake',
					headers: { cookie: 'maestro_web_session=live' },
				})
			).statusCode
		).toBe(401);
	});

	it('bounds unanswered workflow reads instead of declaring a usable session capability', async () => {
		vi.useFakeTimers();
		try {
			installWorkflowFixture();
			handlers.set('sessions:getBootstrap', () => new Promise(() => {}));
			const pending = qualifyRemoteWorkflows(
				{ sessions: true, terminal: true, files: true, browserRelay: false },
				{ id: 'probe', cli: false }
			);
			await vi.advanceTimersByTimeAsync(3001);
			const result = await pending;
			expect(result.capabilities.sessions).toBe(false);
			expect(result.capabilities.terminal).toBe(true);
			expect(result.failures).toEqual(['sessions read checks failed: sessions:getBootstrap']);
			expect(result.temporarilyUnavailable).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
	it('shares an in-flight workflow read and retries after its timeout clears', async () => {
		vi.useFakeTimers();
		try {
			installWorkflowFixture();
			let calls = 0;
			handlers.set('sessions:getBootstrap', () => {
				calls++;
				return new Promise(() => {});
			});
			const options = [
				{ sessions: true, terminal: true, files: true, browserRelay: false },
				{ id: 'probe', cli: false },
			] as const;
			const first = qualifyRemoteWorkflows(...options);
			const second = qualifyRemoteWorkflows(...options);
			expect(calls).toBe(1);
			await vi.advanceTimersByTimeAsync(3001);
			await Promise.all([first, second]);
			const third = qualifyRemoteWorkflows(...options);
			expect(calls).toBe(2);
			await vi.advanceTimersByTimeAsync(3001);
			await third;
		} finally {
			vi.useRealTimers();
		}
	});
	it('does not let a late timed-out probe delete its newer replacement', async () => {
		vi.useFakeTimers();
		try {
			installWorkflowFixture();
			let finishFirst!: (value: unknown[]) => void;
			handlers.set(
				'sessions:getBootstrap',
				() =>
					new Promise<unknown[]>((resolve) => {
						finishFirst = resolve;
					})
			);
			const options = [
				{ sessions: true, terminal: true, files: true, browserRelay: false },
				{ id: 'probe', cli: false },
			] as const;
			const first = qualifyRemoteWorkflows(...options);
			await vi.advanceTimersByTimeAsync(3001);
			await first;
			let secondCalls = 0;
			let finishSecond!: (value: unknown[]) => void;
			handlers.set('sessions:getBootstrap', () => {
				secondCalls++;
				return new Promise<unknown[]>((resolve) => {
					finishSecond = resolve;
				});
			});
			const second = qualifyRemoteWorkflows(...options);
			finishFirst([]);
			await Promise.resolve();
			const third = qualifyRemoteWorkflows(...options);
			expect(secondCalls).toBe(1);
			finishSecond([]);
			await Promise.all([second, third]);
		} finally {
			vi.useRealTimers();
		}
	});
	it('uses the local bootstrap identity without adopting synced installation identity', () => {
		state.settings.set('installationId', 'synced-other-machine');
		const firstStore = {
			get: (key: string) => state.bootstrap.get(key) ?? state.settings.get(key),
			set: (key: string, value: string) => state.bootstrap.set(key, value),
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
				socket: {
					readyState: WebSocket.OPEN,
					bufferedAmount: 0,
					send: (value: string) => sent.push(value),
				} as WebClient['socket'],
			},
			{ type: 'set_setting', key: 'encoreFeatures', value: { webLogin: false } }
		);
		expect(mutated).toBe(false);
		expect(JSON.parse(sent[0])).toMatchObject({ type: 'error' });
	});
});
