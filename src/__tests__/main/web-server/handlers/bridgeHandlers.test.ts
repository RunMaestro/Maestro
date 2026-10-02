import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '../../../../main/web-server/types';

const { handlers, listeners } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
	ipcMain: {
		_invokeHandlers: handlers,
		listenerCount: (channel: string) => (listeners.has(channel) ? 1 : 0),
		emit: (channel: string, event: unknown, ...args: unknown[]) =>
			listeners.get(channel)?.(event, ...args),
	},
}));
import {
	handleBridgeInvoke,
	broadcastBridgeEvent,
	installWebContentsBridgeHook,
	uninstallWebContentsBridgeHook,
} from '../../../../main/web-server/handlers/bridgeHandlers';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';

const client: WebClient = {
	id: 'remote-1',
	connectedAt: 1,
	socket: {} as WebClient['socket'],
	user: { id: 'operator', username: 'ada', displayName: 'Ada' },
};
async function invoke(channel: string, args: unknown[] = []) {
	let response: Record<string, unknown> = {};
	await handleBridgeInvoke(
		client,
		{ type: 'bridge.invoke', requestId: 1, channel, args },
		(_client, payload) => {
			response = { ...payload };
		}
	);
	return response;
}
beforeEach(() => {
	handlers.clear();
	listeners.clear();
	uninstallWebContentsBridgeHook();
});

describe('remote bridge permissions', () => {
	it.each([
		'webLogin:setPassword',
		'webLogin:futureCommand',
		'app:quitConfirmed',
		'live:stopServer',
		'tunnel:start',
		'sync:setCustomPath',
		'devtools:open',
		'browser:relayReady',
		'browser:relayResponse',
		'remote:liteReady:response:forged',
		'process:futureCommand',
	])('never dispatches forbidden registered channel %s', async (channel) => {
		let mutated = false;
		handlers.set(channel, () => {
			mutated = true;
		});
		listeners.set(channel, () => {
			mutated = true;
		});
		expect(await invoke(channel)).toMatchObject({ ok: false });
		expect(mutated).toBe(false);
	});
	it.each([
		'webAuthToken',
		'encoreFeatures',
		'webInterfaceAutoStart',
		'persistentWebLink',
		'sshRemotes',
		'wakatimeApiKey',
		'webAuthToken.nested',
	])('prevents host security or credential changes via settings key %s', async (key) => {
		let mutated = false;
		handlers.set('settings:set', () => {
			mutated = true;
		});
		expect(await invoke('settings:set', [key, false])).toMatchObject({ ok: false });
		expect(mutated).toBe(false);
	});
	it('does not resolve secret or nested settings reads', async () => {
		let read = false;
		handlers.set('settings:get', () => {
			read = true;
			return 'credential';
		});
		expect(await invoke('settings:get', ['webAuthToken'])).toMatchObject({
			ok: true,
			result: undefined,
		});
		expect(await invoke('settings:get', ['sshRemotes.0.remoteEnv'])).toMatchObject({
			ok: true,
			result: undefined,
		});
		expect(read).toBe(false);
	});
	it('keeps normal web UI settings and host token-use statistics without exposing credentials', async () => {
		handlers.set('settings:getAll', () => ({
			activeThemeId: 'dracula',
			webAuthToken: 'path-secret',
			wakatimeApiKey: 'key',
			sshRemotes: [
				{ id: 'host', privateKeyPath: '/keys/id_ed25519', remoteEnv: { TOKEN: 'secret' } },
			],
			stats: { totalTokens: 123 },
		}));
		expect((await invoke('settings:getAll')).result).toEqual({
			activeThemeId: 'dracula',
			sshRemotes: [{ id: 'host', privateKeyPath: '/keys/id_ed25519' }],
			stats: { totalTokens: 123 },
		});
	});
	it('retains credentials during a non-secret agent config edit', async () => {
		let saved: unknown;
		handlers.set('agents:getConfig', () => ({
			model: 'old',
			customEnvVars: { API_KEY: 'host-only' },
		}));
		handlers.set('agents:setConfig', (_event, _id, config) => {
			saved = config;
			return true;
		});
		expect(await invoke('agents:setConfig', ['claude-code', { model: 'new' }])).toMatchObject({
			ok: true,
		});
		expect(saved).toEqual({ model: 'new', customEnvVars: { API_KEY: 'host-only' } });
		expect(await invoke('agents:setConfig', ['claude-code', { customEnvVars: {} }])).toMatchObject({
			ok: false,
		});
	});
	it('attributes accepted asynchronous work and identifies the remote connection', async () => {
		let actor: unknown;
		let event: unknown;
		handlers.set('process:runCommand', async (receivedEvent) => {
			await Promise.resolve();
			actor = getActingUser();
			event = receivedEvent;
			return 'accepted';
		});
		expect(await invoke('process:runCommand')).toMatchObject({ ok: true, result: 'accepted' });
		expect(actor).toEqual(client.user);
		expect(event).toMatchObject({ type: 'bridge', clientId: client.id });
		expect(getActingUser()).toBeUndefined();
	});
	it('does not fan host commands or native focus to remote clients, but does deliver workload events', () => {
		const received: object[] = [];
		installWebContentsBridgeHook({
			broadcastToAll: (payload: object) => received.push(payload),
		} as Parameters<typeof installWebContentsBridgeHook>[0]);
		broadcastBridgeEvent('remote:executeCommand', ['run twice']);
		broadcastBridgeEvent('remote:liteReady', ['reply']);
		broadcastBridgeEvent('sessions:focus-request', [{ sessionId: 'host-focus' }]);
		broadcastBridgeEvent('process:data', ['agent-1', 'host output']);
		expect(received).toEqual([
			expect.objectContaining({ channel: 'process:data', args: ['agent-1', 'host output'] }),
		]);
	});
	it('masks session configuration without changing transcript content', async () => {
		handlers.set('sessions:getBootstrap', () => ({
			sessions: [
				{
					id: 'a',
					customEnvVars: { TOKEN: 'secret' },
					logs: [{ text: 'token usage', totalTokens: 3 }],
				},
			],
		}));
		expect((await invoke('sessions:getBootstrap')).result).toEqual({
			sessions: [{ id: 'a', logs: [{ text: 'token usage', totalTokens: 3 }] }],
		});
	});
});
