/**
 * Remote Tab Rename Integration Tests
 *
 * Drives `rename_tab` end to end over a REAL WebSocket against a REAL
 * `WebServer`, through the real `CallbackRegistry` and the real
 * `registerTabCallbacks` round trip, with a stand-in renderer on the far side
 * of a real `ipcMain` EventEmitter.
 *
 * The unit tests beside `tabCallbacks.ts` pin the callback's own behaviour.
 * These two pin the properties a caller actually observes on the wire:
 *
 * 1. A rename whose persistence outlasts the five second budget that used to
 *    live in the callback still comes back as a success, instead of a failure
 *    the renderer then contradicts by applying the rename anyway.
 * 2. Two overlapping renames for one tab reach the renderer one at a time, in
 *    request order, so the NEWEST rename is the last one persisted and painted
 *    and the results go back on the wire in that same order.
 *
 * Run with: RUN_INTEGRATION_TESTS=true npm run test:integration
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

const runTests = process.env.RUN_INTEGRATION_TESTS === 'true';

// A live listener registry standing in for ipcMain: the callback registers a
// one-shot listener on a response channel and the stand-in renderer answers on
// it, so the whole request/response handshake runs for real rather than being
// stubbed. `removeListener` matches a wrapped once-listener by its original
// function, the way Node's EventEmitter does, so the callback's own cleanup is
// exercised too and `pendingListenerCount` is a real leak check.
// Built inside vi.hoisted because vi.mock's factory is hoisted above imports.
const { ipcMain } = vi.hoisted(() => {
	type Listener = ((...args: unknown[]) => void) & { listener?: unknown };
	const listeners = new Map<string, Listener[]>();

	const removeListener = (channel: string, listener: unknown) => {
		const list = listeners.get(channel);
		if (!list) return;
		const index = list.findIndex((entry) => entry === listener || entry.listener === listener);
		if (index >= 0) list.splice(index, 1);
		if (list.length === 0) listeners.delete(channel);
	};

	return {
		ipcMain: {
			once(channel: string, listener: (...args: unknown[]) => void) {
				const wrapped: Listener = (...args: unknown[]) => {
					removeListener(channel, wrapped);
					listener(...args);
				};
				wrapped.listener = listener;
				listeners.set(channel, [...(listeners.get(channel) ?? []), wrapped]);
			},
			removeListener,
			emit(channel: string, ...args: unknown[]) {
				for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args);
			},
			removeAllListeners() {
				listeners.clear();
			},
			pendingListenerCount() {
				let total = 0;
				for (const list of listeners.values()) total += list.length;
				return total;
			},
		},
	};
});

vi.mock('electron', () => ({
	ipcMain,
	app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' },
	BrowserWindow: class {},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../main/utils/networkUtils', () => ({
	getLocalIpAddress: () => Promise.resolve('localhost'),
	getLocalIpAddressSync: () => 'localhost',
}));

import { WebServer } from '../../main/web-server';
import { registerTabCallbacks } from '../../main/web-server/callbacks/tabCallbacks';

/** One rename as the stand-in renderer received it. */
interface ReceivedRename {
	tabId: string;
	newName: string;
	responseChannel: string;
	receivedAt: number;
}

describe.skipIf(!runTests)('Remote Tab Rename Integration Tests', () => {
	let server: WebServer;
	let wsUrl: string;
	let received: ReceivedRename[];
	/** How long the stand-in renderer takes to persist a given name. */
	let persistDelayByName: Map<string, number>;

	beforeEach(async () => {
		received = [];
		persistDelayByName = new Map();

		server = new WebServer(0);
		server.setGetSessionsCallback(() => [
			{
				id: 'session-1',
				name: 'Test Session',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai' as const,
				cwd: '/test/project',
				groupId: null,
				groupName: null,
				groupEmoji: null,
			},
		]);

		// Stand-in renderer: records what it was told to rename, waits out its
		// "persistence", then answers on the response channel the callback opened.
		const webContents = Object.assign(new EventEmitter(), {
			isDestroyed: () => false,
			send: (
				channel: string,
				_sessionId: string,
				tabId: string,
				newName: string,
				responseChannel: string
			) => {
				if (channel !== 'remote:renameTab') return;
				received.push({ tabId, newName, responseChannel, receivedAt: Date.now() });
				setTimeout(
					() => ipcMain.emit(responseChannel, {}, { success: true }),
					persistDelayByName.get(newName) ?? 0
				);
			},
		});
		webContents.setMaxListeners(0);

		// The real `isWebContentsAvailable` is used, so the window answers the same
		// liveness questions a BrowserWindow does.
		const mainWindow = { isDestroyed: () => false, webContents };

		registerTabCallbacks(
			server as never,
			{
				getMainWindow: () => mainWindow as never,
				getWindowForSession: undefined,
			} as never
		);

		const { port, token } = await server.start();
		wsUrl = `ws://localhost:${port}/${token}/ws`;
	});

	afterEach(async () => {
		await server.stop();
		ipcMain.removeAllListeners();
	});

	async function createWebClient(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl);
			const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
			socket.on('open', () => {
				clearTimeout(timeout);
				resolve(socket);
			});
			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
	}

	/** Collect every `rename_tab_result` frame, in arrival order. */
	function collectRenameResults(socket: WebSocket): Array<Record<string, unknown>> {
		const results: Array<Record<string, unknown>> = [];
		socket.on('message', (data: WebSocket.RawData) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'rename_tab_result') results.push(msg);
			} catch {
				// Ignore frames that are not JSON.
			}
		});
		return results;
	}

	async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	it('reports success for a rename whose persistence outlasts the old five second budget', async () => {
		// Six seconds: past the deadline that used to resolve a failure here while
		// the renderer went on to persist the rename and repaint the tab.
		persistDelayByName.set('Slow Name', 6000);

		const client = await createWebClient();
		await new Promise((r) => setTimeout(r, 200));
		const results = collectRenameResults(client);

		client.send(
			JSON.stringify({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Slow Name',
			})
		);

		await waitFor(() => results.length === 1, 30000, 'the slow rename result');
		expect(results[0]).toMatchObject({
			type: 'rename_tab_result',
			success: true,
			sessionId: 'session-1',
			tabId: 'tab-1',
			newName: 'Slow Name',
		});
		expect(results[0].error).toBeUndefined();
		// Bounded cleanup: the response channel listener is gone once it answered.
		expect(ipcMain.pendingListenerCount()).toBe(0);

		client.close();
	}, 40000);

	it('hands overlapping renames for one tab to the renderer one at a time, newest last', async () => {
		// If the two ran concurrently the older one would finish LAST and leave the
		// tab named after the older request. Serialized, the newer one does not
		// even start until the older has been persisted and confirmed.
		persistDelayByName.set('Older', 400);
		persistDelayByName.set('Newer', 0);

		const client = await createWebClient();
		await new Promise((r) => setTimeout(r, 200));
		const results = collectRenameResults(client);

		client.send(
			JSON.stringify({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Older',
			})
		);
		client.send(
			JSON.stringify({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Newer',
			})
		);

		await waitFor(() => results.length === 2, 15000, 'both rename results');

		// The renderer persisted and painted them in request order, so the last
		// name it applied is the newest one.
		expect(received.map((r) => r.newName)).toEqual(['Older', 'Newer']);
		expect(received[1].receivedAt).toBeGreaterThanOrEqual(received[0].receivedAt + 400);

		// And a client applying results as they arrive ends on the newest name.
		expect(results.map((r) => r.newName)).toEqual(['Older', 'Newer']);
		expect(results.every((r) => r.success === true)).toBe(true);

		client.close();
	}, 30000);

	it('runs renames for different tabs concurrently', async () => {
		persistDelayByName.set('Tab One', 400);
		persistDelayByName.set('Tab Two', 0);

		const client = await createWebClient();
		await new Promise((r) => setTimeout(r, 200));
		const results = collectRenameResults(client);

		client.send(
			JSON.stringify({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
				newName: 'Tab One',
			})
		);
		client.send(
			JSON.stringify({
				type: 'rename_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
				newName: 'Tab Two',
			})
		);

		await waitFor(() => results.length === 2, 15000, 'both rename results');

		// Both reached the renderer without waiting on each other: the per-tab key
		// must not turn into an app-wide rename lock.
		expect(received.map((r) => r.newName).sort()).toEqual(['Tab One', 'Tab Two']);
		expect(received[1].receivedAt).toBeLessThan(received[0].receivedAt + 400);
		expect(results.map((r) => r.newName)).toEqual(['Tab Two', 'Tab One']);

		client.close();
	}, 30000);
});
