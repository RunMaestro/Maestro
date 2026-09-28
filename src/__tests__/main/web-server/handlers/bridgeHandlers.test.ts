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
	handleBridgeInvoke,
	installWebContentsBridgeHook,
	uninstallWebContentsBridgeHook,
} from '../../../../main/web-server/handlers/bridgeHandlers';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';

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
});

describe('handleBridgeInvoke', () => {
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
		expect(String(payload.error)).toMatch(/No ipcMain handler/);
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

	it('prefers an invoke handler when a channel has both', async () => {
		invokeHandlers.set('dual', async () => 'from-handle');
		sendListeners.set('dual', () => {
			throw new Error('the send listener must not run');
		});

		const send = vi.fn();
		const client = makeClient();
		await handleBridgeInvoke(
			client,
			{ type: 'bridge.invoke', requestId: 13, channel: 'dual' },
			send
		);

		expect(send.mock.calls[0][1]).toMatchObject({ ok: true, result: 'from-handle' });
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
		invokeHandlers.set('slow', async () => {
			await new Promise((r) => setTimeout(r, 1));
			seen = getActingUser();
		});

		await handleBridgeInvoke(
			makeClient({ id: 'u2', username: 'grace', displayName: 'Grace' }),
			{ type: 'bridge.invoke', requestId: 2, channel: 'slow' },
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
		invokeHandlers.set('noop', async () => undefined);
		await handleBridgeInvoke(
			makeClient({ id: 'u1', username: 'ada', displayName: 'Ada' }),
			{ type: 'bridge.invoke', requestId: 5, channel: 'noop' },
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
		expect(String(payload.error)).toContain('not available over the web interface');
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

	it('leaves every other namespace alone', async () => {
		invokeHandlers.set('settings:get', async () => 'dracula');

		const send = vi.fn();
		await handleBridgeInvoke(
			makeClient(),
			{ type: 'bridge.invoke', requestId: 11, channel: 'settings:get' },
			send
		);

		expect(send.mock.calls[0][1]).toMatchObject({ ok: true, result: 'dracula' });
	});
});
