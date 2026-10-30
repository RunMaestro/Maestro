/**
 * Tests for the bridge.invoke dispatcher.
 *
 * The bridge is the entry point that exposes ipcMain.handle() registrations
 * to the web-desktop bundle, the default browser interface. These tests assert
 * the three failure modes plus the happy path:
 *
 *  1. Missing/empty channel → ok:false, never touches ipcMain.
 *  2. Unknown channel → ok:false with a clear message.
 *  3. Handler throws → ok:false carrying the error message.
 *  4. Handler resolves → ok:true with the result.
 *
 * The Electron `ipcMain._invokeHandlers` private Map is stubbed by mocking the
 * `electron` module so the test doesn't need a real Electron runtime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcRenderer } from 'electron';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

// Mock electron so we can drive the internal _invokeHandlers Map directly.
// `vi.hoisted` runs before the module factory so the map is initialized in
// time for vi.mock - top-level consts would be in the temporal dead zone
// at hoist time and the mock factory would throw.
const { invokeHandlers, sendListeners } = vi.hoisted(() => ({
	invokeHandlers: new Map<string, Handler>(),
	// `ipcMain.on` listeners - the OTHER renderer->main direction. These are
	// ordinary EventEmitter listeners and never appear in `_invokeHandlers`.
	sendListeners: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
	ipcRenderer: { invoke: vi.fn() },
	ipcMain: {
		_invokeHandlers: invokeHandlers,
		listenerCount: (channel: string) => (sendListeners.has(channel) ? 1 : 0),
		emit: (channel: string, event: unknown, ...args: unknown[]) => {
			const listener = sendListeners.get(channel);
			if (!listener) return false;
			listener(event, ...args);
			return true;
		},
	},
}));

import {
	broadcastBridgeEvent,
	broadcastBridgeEventToSessionSubscribers,
	isBridgeSessionOwner,
	handleBridgeInvoke,
	installWebContentsBridgeHook,
	uninstallWebContentsBridgeHook,
} from '../../../../main/web-server/handlers/bridgeHandlers';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';
import {
	__resetDesktopOnlyChannelsForTests,
	markDesktopOnlyChannel,
} from '../../../../main/ipc/desktop-only-channels';
import { setBridgeGuardContextProvider } from '../../../../main/web-server/handlers/bridgePathGuard';
import {
	isRemoteEventAllowed,
	isRemoteMethodAllowed,
	isRemoteSettingWritable,
} from '../../../../main/web-server/handlers/bridgeDenyList';
import { createWebApi } from '../../../../main/preload/web';

function makeClient(user?: { id: string; username: string; displayName: string }) {
	return {
		id: 'test-client',
		socket: { readyState: 1, send: vi.fn() } as unknown as WebSocket,
		connectedAt: Date.now(),
		...(user ? { user } : {}),
	};
}

function lastSend(client: ReturnType<typeof makeClient>): Record<string, unknown> {
	const send = client.socket.send as unknown as ReturnType<typeof vi.fn>;
	expect(send).toHaveBeenCalled();
	const last = send.mock.calls[send.mock.calls.length - 1][0] as string;
	return JSON.parse(last);
}

beforeEach(() => {
	invokeHandlers.clear();
	sendListeners.clear();
	__resetDesktopOnlyChannelsForTests();
});

describe('handleBridgeInvoke', () => {
	it.each([false, true])('stamps generic bridge spawns as unattended (cli=%s)', async (cli) => {
		const handler = vi.fn().mockResolvedValue({ success: true });
		invokeHandlers.set('process:spawn', handler);
		for (const querySource of ['user', 'auto', undefined]) {
			const config = { sessionId: 'fixture-ai-tab', prompt: 'Read authorized mail', querySource };
			await handleBridgeInvoke(
				{ ...makeClient(), cli },
				{ type: 'bridge.invoke', requestId: 'spawn', channel: 'process:spawn', args: [config] },
				vi.fn()
			);
			expect(handler).toHaveBeenLastCalledWith(expect.anything(), {
				...config,
				querySource: 'auto',
			});
			expect(config.querySource).toBe(querySource);
		}
	});

	it.each([{ args: [] }, { args: [null] }, { args: [[]] }, { args: [{}, 'user'] }])(
		'rejects malformed remote spawn arguments %j',
		async ({ args }) => {
			const handler = vi.fn();
			invokeHandlers.set('process:spawn', handler);
			const send = vi.fn();
			await handleBridgeInvoke(
				makeClient(),
				{ type: 'bridge.invoke', requestId: 'invalid', channel: 'process:spawn', args },
				send
			);
			expect(handler).not.toHaveBeenCalled();
			expect(send.mock.calls[0][1]).toMatchObject({ ok: false });
		}
	);

	it('allows remote conversation close/reopen and prompt context without transferring run ownership', async () => {
		const tabs = new Set(['keep', 'close']);
		let ownerClaims = 0;
		invokeHandlers.set(
			'web:requestCloseTab',
			(_event, agentId, tabId) => agentId === 'agent' && tabs.delete(String(tabId))
		);
		invokeHandlers.set('web:requestReopenTab', (_event, agentId, tabId) => {
			if (agentId !== 'agent') return null;
			tabs.add(String(tabId));
			return { tabId };
		});
		invokeHandlers.set('prompts:getSystemPromptPaths', () => ({
			success: true,
			computerHistoryDir: '/host/computer-history',
		}));
		invokeHandlers.set('web:takeOrphanedAutoRuns', () => {
			ownerClaims++;
			return [];
		});
		const client = makeClient();
		const send = vi.fn();
		await handleBridgeInvoke(
			client,
			{
				type: 'bridge.invoke',
				requestId: 1,
				channel: 'web:requestCloseTab',
				args: ['agent', 'close'],
			},
			send
		);
		expect(tabs).toEqual(new Set(['keep']));
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ ok: true, result: true });
		await handleBridgeInvoke(
			client,
			{
				type: 'bridge.invoke',
				requestId: 2,
				channel: 'web:requestReopenTab',
				args: ['agent', 'close'],
			},
			send
		);
		expect(tabs).toEqual(new Set(['keep', 'close']));
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ ok: true, result: { tabId: 'close' } });
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 3, channel: 'prompts:getSystemPromptPaths', args: [] },
			send
		);
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
			ok: true,
			result: { computerHistoryDir: '/host/computer-history' },
		});
		await handleBridgeInvoke(
			client,
			{
				type: 'bridge.invoke',
				requestId: 4,
				channel: 'web:takeOrphanedAutoRuns',
				args: ['remote'],
			},
			send
		);
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ ok: false });
		expect(ownerClaims).toBe(0);
	});

	it('rejects empty/non-string channel without touching ipcMain', async () => {
		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 1, channel: '' as unknown as string },
			send
		);
		expect(send).toHaveBeenCalledTimes(1);
		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload.ok).toBe(false);
		expect(String(payload.error)).toMatch(/channel string/);
	});

	it('returns ok:false when channel is unknown', async () => {
		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 7, channel: 'fs:does-not-exist' },
			send
		);
		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload).toMatchObject({
			type: 'bridge.response',
			requestId: 7,
			ok: false,
		});
	});

	/**
	 * `ipcRenderer.send` is fire-and-forget and pairs with `ipcMain.on`, not
	 * `ipcMain.handle`. The web shim has only one frame type, so it routes both
	 * directions through `bridge.invoke` - which used to mean every send-style
	 * API was a silent no-op in a browser: the server answered "No ipcMain
	 * handler registered" and the shim's send wrapper, which cannot throw at its
	 * caller, logged it and swallowed it.
	 */
	it('dispatches a send-style channel to its ipcMain.on listener', async () => {
		const received: unknown[][] = [];
		sendListeners.set('tabs:aiTabClosed', (_event, ...args) => {
			received.push(args);
		});

		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{
				type: 'bridge.invoke',
				requestId: 11,
				channel: 'tabs:aiTabClosed',
				args: ['agent-1', 'tab-1'],
			},
			send
		);

		expect(received).toEqual([['agent-1', 'tab-1']]);
		expect(send.mock.calls[0][1]).toMatchObject({
			type: 'bridge.response',
			requestId: 11,
			ok: true,
		});
	});

	it('reports a throwing send listener rather than hanging the caller', async () => {
		sendListeners.set('tabs:aiTabClosed', () => {
			throw new Error('listener exploded');
		});

		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 12, channel: 'tabs:aiTabClosed', args: [] },
			send
		);

		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload).toMatchObject({ requestId: 12, ok: false });
		expect(String(payload.error)).toMatch(/listener exploded/);
	});

	it('returns the handler result on success', async () => {
		invokeHandlers.set('settings:get', async (_event, key: string) => {
			if (key === 'theme') return 'dracula';
			return null;
		});

		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 42, channel: 'settings:get', args: ['theme'] },
			send
		);

		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload).toEqual({
			type: 'bridge.response',
			requestId: 42,
			ok: true,
			result: 'dracula',
		});
	});

	it('surfaces handler errors as ok:false with the message', async () => {
		invokeHandlers.set('fs:readFile', async () => {
			throw new Error('ENOENT: no such file');
		});

		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{
				type: 'bridge.invoke',
				requestId: 99,
				channel: 'fs:readFile',
				args: ['/missing'],
			},
			send
		);

		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload).toMatchObject({
			type: 'bridge.response',
			requestId: 99,
			ok: false,
			error: 'ENOENT: no such file',
		});
	});

	it('passes args through in order to the registered handler', async () => {
		const spy = vi.fn().mockResolvedValue('ok');
		invokeHandlers.set('process:write', spy);

		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 1,
				channel: 'process:write',
				args: ['session-123', 'echo hello'],
			},
			send
		);

		expect(spy).toHaveBeenCalledTimes(1);
		// First arg is the FAKE_EVENT object, then the user args.
		const callArgs = spy.mock.calls[0];
		expect(callArgs.slice(1)).toEqual(['session-123', 'echo hello']);
	});

	void lastSend; // helper kept available for future tests; tsc would warn if unused.
});

describe('browser conversation operations through the bridge', () => {
	beforeEach(() => {
		// Web-desktop runs the real preload API with ipcRenderer.invoke carried
		// as bridge.invoke. Do not mock requestCloseTab itself: that skips the
		// remote method inventory that distinguishes this path from CLI close_tab.
		vi.mocked(ipcRenderer.invoke).mockImplementation(async (channel, ...args) => {
			const send = vi.fn();
			await handleBridgeInvoke(
				makeClient(),
				{ type: 'bridge.invoke', requestId: 1, channel, args },
				send
			);
			const response = send.mock.calls[0][1] as {
				ok: boolean;
				result?: unknown;
				error?: string;
			};
			if (!response.ok) throw new Error(response.error);
			return response.result;
		});
	});

	it.each([true, false])('waits for the owner close acknowledgement %s', async (closed) => {
		let acknowledge!: (result: boolean) => void;
		const handler = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					acknowledge = resolve;
				})
		);
		invokeHandlers.set('web:requestCloseTab', handler);

		let settled = false;
		const pending = createWebApi()
			.requestCloseTab('agent-1', 'inactive-tab')
			.then(
				(result) => ({ result }),
				(error: unknown) => ({ error })
			)
			.finally(() => {
				settled = true;
			});
		await Promise.resolve();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0].slice(1)).toEqual(['agent-1', 'inactive-tab']);
		expect(settled).toBe(false);
		acknowledge(closed);
		await expect(pending).resolves.toEqual({ result: closed });
	});

	it.each([{ tabId: 'desktop-restored-tab' }, null])(
		'forwards the owner reopen result %j',
		async (reopened) => {
			const handler = vi.fn().mockResolvedValue(reopened);
			invokeHandlers.set('web:requestReopenTab', handler);

			await expect(createWebApi().requestReopenTab('agent-1', 'closed-tab')).resolves.toEqual(
				reopened
			);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler.mock.calls[0].slice(1)).toEqual(['agent-1', 'closed-tab']);
		}
	);

	it.each([
		'remote:closeTab',
		'remote:closeTab:response:private',
		'remote:reopenTab',
		'remote:reopenTab:response:private',
	])('keeps the trusted owner channel %s private', async (channel) => {
		const handler = vi.fn();
		invokeHandlers.set(channel, handler);
		await expect(ipcRenderer.invoke(channel, 'agent-1', 'tab-1')).rejects.toThrow(
			'not available over the web interface'
		);
		expect(handler).not.toHaveBeenCalled();
	});
});

describe('broadcastBridgeEvent', () => {
	it('is a no-op when the hook is not installed', () => {
		uninstallWebContentsBridgeHook();
		expect(() => broadcastBridgeEvent('any-channel', [1, 2, 3])).not.toThrow();
	});

	it('fans out installed broadcastService calls to all clients', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);

		broadcastBridgeEvent('process:data', ['session-1', 'hello']);

		expect(broadcastToAll).toHaveBeenCalledTimes(1);
		const payload = broadcastToAll.mock.calls[0][0] as Record<string, unknown>;
		expect(payload).toMatchObject({
			type: 'bridge.event',
			channel: 'process:data',
			args: ['session-1', 'hello'],
		});
		expect(typeof payload.timestamp).toBe('number');

		uninstallWebContentsBridgeHook();
	});

	it('targets private interactions to session subscribers and checks the same owner scope', () => {
		const broadcastToAll = vi.fn();
		const broadcastToSubscribers = vi.fn(() => true);
		const isClientSubscribed = vi.fn(() => true);
		installWebContentsBridgeHook({
			broadcastToAll,
			broadcastToSubscribers,
			isClientSubscribed,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);

		expect(
			broadcastBridgeEventToSessionSubscribers(
				'process:harness-interaction-request',
				[{ requestId: 'request-a' }],
				'agent-a'
			)
		).toBe(true);
		expect(broadcastToSubscribers).toHaveBeenCalledWith(
			'agent-a',
			expect.objectContaining({
				type: 'bridge.event',
				channel: 'process:harness-interaction-request',
			})
		);
		expect(isBridgeSessionOwner('browser-a', 'agent-a')).toBe(true);
		expect(isClientSubscribed).toHaveBeenCalledWith('browser-a', 'agent-a');
		expect(broadcastToAll).not.toHaveBeenCalled();

		uninstallWebContentsBridgeHook();
		expect(isBridgeSessionOwner('browser-a', 'agent-a')).toBe(false);
	});

	it('never fans out a denied channel (Computer History status push)', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);

		broadcastBridgeEvent('computerHistory:statusChanged', [{ state: 'recording' }]);
		expect(broadcastToAll).not.toHaveBeenCalled();

		uninstallWebContentsBridgeHook();
	});

	it('stops broadcasting after uninstall', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);
		uninstallWebContentsBridgeHook();

		broadcastBridgeEvent('process:data', ['session-1', 'hello']);
		expect(broadcastToAll).not.toHaveBeenCalled();
	});
});

/**
 * Web Login: who a bridge call is acting as, and what it may not call.
 *
 * Most handlers strip the event (`withIpcErrorLogging`) and every bridge call
 * carries the same shared FAKE_EVENT, so nothing in a handler's arguments says
 * which account asked. Rather than threading a user through hundreds of handler
 * signatures, the dispatch runs inside an AsyncLocalStorage context.
 */
describe('handleBridgeInvoke acting user', () => {
	it('makes the client account visible to the handler it dispatches', async () => {
		let seen: unknown;
		invokeHandlers.set('history:add', async () => {
			seen = getActingUser();
			return 'ok';
		});

		const client = makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' });
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 1, channel: 'history:add' },
			vi.fn()
		);

		expect(seen).toEqual({ id: 'u1', username: 'ada', displayName: 'Ada' });
	});

	it('survives an await inside the handler', async () => {
		// The whole reason this is AsyncLocalStorage rather than a module-level
		// variable: a handler that awaits must still read the same account after
		// the continuation, and two clients can be in flight at once.
		let seen: unknown;
		invokeHandlers.set('history:add', async () => {
			await new Promise((r) => setTimeout(r, 1));
			seen = getActingUser();
		});

		await handleBridgeInvoke(
			makeClient({ id: 'u2', username: 'grace', displayName: 'Grace' }),
			{ type: 'bridge.invoke', requestId: 2, channel: 'history:add' },
			vi.fn()
		);

		expect(seen).toMatchObject({ username: 'grace' });
	});

	it('reads undefined for a client with no account, which means the desktop', async () => {
		// Loopback callers (maestro-cli) and every client while the gate is off.
		let seen: unknown = 'unset';
		invokeHandlers.set('history:add', async () => {
			seen = getActingUser();
		});

		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 3, channel: 'history:add' },
			vi.fn()
		);

		expect(seen).toBeUndefined();
	});

	it('carries the account into a send-style listener too', async () => {
		let seen: unknown;
		sendListeners.set('tabs:aiTabClosed', () => {
			seen = getActingUser();
		});

		await handleBridgeInvoke(
			makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' }),
			{ type: 'bridge.invoke', requestId: 4, channel: 'tabs:aiTabClosed' },
			vi.fn()
		);

		expect(seen).toMatchObject({ username: 'ada' });
	});

	it('leaves no context behind for the next call', async () => {
		invokeHandlers.set('history:add', async () => undefined);
		await handleBridgeInvoke(
			makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' }),
			{ type: 'bridge.invoke', requestId: 5, channel: 'history:add' },
			vi.fn()
		);

		expect(getActingUser()).toBeUndefined();
	});
});

/**
 * Account administration cannot ride the bridge. The desktop is the
 * administrator: a browser that could call `webLogin:createUser` could mint
 * itself a second account from inside the session the gate was meant to
 * constrain, and the same channels read the file holding every password hash.
 */
describe('handleBridgeInvoke denied channels', () => {
	it('refuses a webLogin channel without dispatching it', async () => {
		const handler = vi.fn(async () => ['everyone']);
		invokeHandlers.set('webLogin:listUsers', handler);

		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' }),
			{ type: 'bridge.invoke', requestId: 9, channel: 'webLogin:listUsers' },
			send
		);

		expect(handler).not.toHaveBeenCalled();
		const payload = send.mock.calls[0][1] as Record<string, unknown>;
		expect(payload).toMatchObject({ requestId: 9, ok: false });
	});

	it('refuses every channel in the namespace, including ones added later', async () => {
		// Matching is by PREFIX so a new webLogin channel is denied the moment it
		// is registered, rather than being exposed until somebody extends a list.
		for (const channel of ['webLogin:createUser', 'webLogin:deleteUser', 'webLogin:somethingNew']) {
			const handler = vi.fn(async () => 'leaked');
			invokeHandlers.set(channel, handler);
			const send = vi.fn();
			await handleBridgeInvoke(
				makeClient(),
				{ type: 'bridge.invoke', requestId: channel, channel },
				send
			);
			expect(handler).not.toHaveBeenCalled();
			expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
		}
	});

	it('refuses every computerHistory channel (D15: a browser must not read screen history)', async () => {
		for (const channel of [
			'computerHistory:query',
			'computerHistory:status',
			'computerHistory:clear',
			'computerHistory:somethingNew',
		]) {
			const handler = vi.fn(async () => 'leaked');
			invokeHandlers.set(channel, handler);
			const send = vi.fn();
			await handleBridgeInvoke(
				makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' }),
				{ type: 'bridge.invoke', requestId: channel, channel },
				send
			);
			expect(handler).not.toHaveBeenCalled();
			expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
		}
	});

	it('lets a browser record and read its User Journey', async () => {
		for (const channel of ['journey:append', 'journey:read', 'journey:path']) {
			const handler = vi.fn(async () => 'ok');
			invokeHandlers.set(channel, handler);
			const send = vi.fn();
			await handleBridgeInvoke(
				makeClient(),
				{ type: 'bridge.invoke', requestId: channel, channel, args: ['agent-1'] },
				send
			);
			expect(handler).toHaveBeenCalled();
			expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(true);
		}
	});

	it('refuses windows:setPanelState (a browser has no window of its own to persist)', async () => {
		const handler = vi.fn();
		invokeHandlers.set('windows:setPanelState', handler);
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 11,
				channel: 'windows:setPanelState',
				args: [{ rightPanelCollapsed: true }],
			},
			send
		);
		expect(handler).not.toHaveBeenCalled();
		expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
	});

	it('answers maestroRun:readyPath, which a browser spawn needs for its system prompt', async () => {
		invokeHandlers.set('maestroRun:readyPath', async () => '/opt/maestro-run');
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 12, channel: 'maestroRun:readyPath' },
			send
		);
		expect(send.mock.calls[0][1]).toMatchObject({
			requestId: 12,
			ok: true,
			result: '/opt/maestro-run',
		});
	});

	it('refuses a denied send-style channel too', async () => {
		const listener = vi.fn();
		sendListeners.set('webLogin:notify', listener);

		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 10, channel: 'webLogin:notify' },
			send
		);

		expect(listener).not.toHaveBeenCalled();
		expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
	});
});

/**
 * Computer History behind the generic handlers: a browser must not reach the
 * store or the CLI secret through `fs:*`, nor flip the flag through
 * `settings:set`. maestro-cli (client.cli) is exempt.
 */
describe('handleBridgeInvoke argument guard', () => {
	const userData = '/guard-test-user-data';
	const storeFile = `${userData}/computer-history/index.jsonl`;

	beforeEach(() => {
		setBridgeGuardContextProvider(() => ({
			userDataDir: userData,
			encoreFeatures: { computerHistory: true },
			platform: 'linux',
		}));
	});

	it('refuses a browser reading the store through fs:readFile', async () => {
		const handler = vi.fn(async () => 'leaked');
		invokeHandlers.set('fs:readFile', handler);
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 'g1', channel: 'fs:readFile', args: [storeFile] },
			send
		);
		expect(handler).not.toHaveBeenCalled();
		expect(send.mock.calls[0][1]).toMatchObject({ requestId: 'g1', ok: false });
	});

	it('refuses the same on the ipcMain.emit fallback path', async () => {
		const listener = vi.fn();
		sendListeners.set('fs:sendStyleWrite', listener);
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 'g2',
				channel: 'fs:sendStyleWrite',
				args: [{ target: `${userData}/cli-server.json` }],
			},
			send
		);
		expect(listener).not.toHaveBeenCalled();
		expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
	});

	it('refuses a browser turning Computer History off through settings:set', async () => {
		const handler = vi.fn(async () => true);
		invokeHandlers.set('settings:set', handler);
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 'g3',
				channel: 'settings:set',
				args: ['encoreFeatures', { computerHistory: false }],
			},
			send
		);
		expect(handler).not.toHaveBeenCalled();
		expect((send.mock.calls[0][1] as Record<string, unknown>).ok).toBe(false);
	});

	it('lets maestro-cli through and leaves unrelated calls alone', async () => {
		const handler = vi.fn(async () => 'contents');
		invokeHandlers.set('fs:readFile', handler);
		const send = vi.fn();
		await handleBridgeInvoke(
			{ ...makeClient(), cli: true },
			{ type: 'bridge.invoke', requestId: 'g4', channel: 'fs:readFile', args: [storeFile] },
			send
		);
		expect(handler).toHaveBeenCalledTimes(1);
		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 'g5', channel: 'fs:readFile', args: ['/tmp/notes.md'] },
			send
		);
		expect(handler).toHaveBeenCalledTimes(2);
		setBridgeGuardContextProvider(null);
	});
});

/** Desktop-only registrations override the explicit remote inventory. */
describe('handleBridgeInvoke desktop-only channels', () => {
	/** The whole answer the bridge gives for `channel`. */
	async function answerFor(
		channel: string,
		client = makeClient()
	): Promise<Record<string, unknown>> {
		const send = vi.fn();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 'd1', channel, args: ['agent-1'] },
			send
		);
		expect(send).toHaveBeenCalledTimes(1);
		return send.mock.calls[0][1] as Record<string, unknown>;
	}

	it('does not run a send-style listener of a marked channel either', async () => {
		const listener = vi.fn();
		sendListeners.set('tabs:aiTabClosed', listener);
		markDesktopOnlyChannel('tabs:aiTabClosed');

		expect(await answerFor('tabs:aiTabClosed')).toMatchObject({ ok: false });
		expect(listener).not.toHaveBeenCalled();
	});

	it('keeps a marked channel from maestro-cli as well', async () => {
		const handler = vi.fn().mockResolvedValue('secret');
		invokeHandlers.set('sessions:getAll', handler);
		markDesktopOnlyChannel('sessions:getAll');

		const cli = { ...makeClient(), cli: true };
		expect(await answerFor('sessions:getAll', cli)).toMatchObject({ ok: false });
		expect(handler).not.toHaveBeenCalled();
	});

	it('never fans out an event pushed on a marked channel', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);
		markDesktopOnlyChannel('sessions:lifecycleSync');

		broadcastBridgeEvent('sessions:lifecycleSync', [{ added: [] }]);
		expect(broadcastToAll).not.toHaveBeenCalled();

		uninstallWebContentsBridgeHook();
	});
});

describe('notification history over the bridge', () => {
	it.each([
		{ action: 'migrate', records: [] },
		{ action: 'read', ids: ['host-notification'] },
	])('returns the host history snapshot for a $action change', async (change) => {
		const snapshot = {
			success: true,
			records: [
				{
					id: 'host-notification',
					title: 'Completed',
					message: 'Done',
					timestamp: 1,
					read: change.action === 'read',
					color: 'green',
					type: 'success',
				},
			],
			revision: 1,
		};
		const handler = vi.fn(async () => snapshot);
		invokeHandlers.set('notification:changeHistory', handler);
		const send = vi.fn();

		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 22,
				channel: 'notification:changeHistory',
				args: [change],
			},
			send
		);

		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'bridge' }), change);
		expect(send.mock.calls[0][1]).toMatchObject({ requestId: 22, ok: true, result: snapshot });
	});

	it('fans committed history snapshots out to browsers', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);
		const snapshot = { success: true, records: [], revision: 2 };
		try {
			broadcastBridgeEvent('notification:historyChanged', [snapshot]);
			expect(broadcastToAll.mock.calls[0][0]).toMatchObject({
				type: 'bridge.event',
				channel: 'notification:historyChanged',
				args: [snapshot],
			});
		} finally {
			uninstallWebContentsBridgeHook();
		}
	});

	it('keeps host notification delivery and trusted renderer activation private', () => {
		for (const operation of ['show', 'speak', 'stopSpeak', 'ready', 'navigateToSource']) {
			expect(isRemoteMethodAllowed(`notification:${operation}`)).toBe(false);
		}
		expect(isRemoteEventAllowed('notification:activateAction')).toBe(false);
	});
});

/**
 * Dataview DQL runs in the browser build too (DV-14): its four channels and the change push are on the
 * remote allowlist, while the DataviewJS settings stay out of a browser's reach.
 */
describe('Dataview over the bridge', () => {
	it('answers dataview:query', async () => {
		const answer = { root: '/vault', revision: 1, result: { kind: 'list', items: [] } };
		const handler = vi.fn(async () => answer);
		invokeHandlers.set('dataview:query', handler);
		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{
				type: 'bridge.invoke',
				requestId: 21,
				channel: 'dataview:query',
				args: [{ filePath: '/vault/A.md', source: 'LIST', agentId: 'a' }],
			},
			send
		);
		expect(handler).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][1]).toMatchObject({ requestId: 21, ok: true, result: answer });
	});

	it('allows every Dataview request channel and the change push', () => {
		for (const operation of ['query', 'queryInline', 'status', 'rebuild']) {
			expect(isRemoteMethodAllowed(`dataview:${operation}`)).toBe(true);
		}
		expect(isRemoteEventAllowed('dataview:changed')).toBe(true);
	});

	it('fans dataview:changed out to bridge clients', () => {
		const broadcastToAll = vi.fn();
		installWebContentsBridgeHook({
			broadcastToAll,
		} as unknown as Parameters<typeof installWebContentsBridgeHook>[0]);

		const event = { root: '/vault', sshRemoteId: null, revision: 2, changedPaths: ['A.md'] };
		broadcastBridgeEvent('dataview:changed', [event]);
		expect(broadcastToAll.mock.calls[0][0]).toMatchObject({
			type: 'bridge.event',
			channel: 'dataview:changed',
			args: [event],
		});

		uninstallWebContentsBridgeHook();
	});

	it('refuses browser writes to the DataviewJS settings', () => {
		expect(isRemoteSettingWritable('dataviewJsEnabled')).toBe(false);
		expect(isRemoteSettingWritable('dataviewJsTrustedRoots')).toBe(false);
	});
});
