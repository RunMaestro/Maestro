import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserWindow } from 'electron';
type Handler = (...args: unknown[]) => unknown;
type Guest = EventEmitter & {
	debugger: { isAttached: () => boolean; sendCommand: ReturnType<typeof vi.fn> };
};
type WindowFixture = { width: number; height: number; webContents: Guest };
type OwnerFixture = EventEmitter & {
	isDestroyed: () => boolean;
	webContents: {
		id: number;
		isDestroyed: () => boolean;
		setBackgroundThrottling: ReturnType<typeof vi.fn>;
		send: (channel: string, payload: { requestId: string }) => void;
	};
};

const ipc = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	listeners: new Map<string, Handler>(),
	windows: [] as WindowFixture[],
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) => ipc.handlers.set(channel, handler),
		on: (channel: string, listener: Handler) => ipc.listeners.set(channel, listener),
	},
	BrowserWindow: class extends EventEmitter {
		width: number;
		height: number;
		webContents: Guest;
		constructor(options: { width: number; height: number }) {
			super();
			this.width = options.width;
			this.height = options.height;
			this.webContents = Object.assign(new EventEmitter(), {
				id: ipc.windows.length + 2,
				isDestroyed: () => false,
				setFrameRate: vi.fn(),
				startPainting: vi.fn(),
				stopPainting: vi.fn(),
				invalidate: () =>
					queueMicrotask(() =>
						this.webContents.emit(
							'paint',
							{},
							{},
							{
								isEmpty: () => false,
								toJPEG: () => Buffer.from(`${this.width}x${this.height}`),
							}
						)
					),
				session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
				loadURL: vi.fn().mockResolvedValue(undefined),
				getURL: () => 'https://example.com',
				getTitle: () => 'Shared page',
				isLoading: () => false,
				navigationHistory: { canGoBack: () => false, canGoForward: () => false },
				debugger: { isAttached: () => true, sendCommand: vi.fn().mockResolvedValue(undefined) },
			});
			ipc.windows.push(this);
		}
		isDestroyed() {
			return false;
		}
		setContentSize(width: number, height: number) {
			this.width = width;
			this.height = height;
		}
	},
}));
vi.mock('../../../main/app-lifecycle/guest-webview-security', () => ({
	attachBrowserPageSecurity: vi.fn(),
	isAllowedBrowserTabUrl: (url: string) => url.startsWith('https://'),
}));

import {
	closeBrowserRelayClient,
	registerBrowserRelayHandlers,
} from '../../../main/browser/browser-relay';

const target = { sessionId: 'session', tabId: 'tab' };
const remote = { type: 'bridge', clientId: 'lite' };
const nativeSize = { width: 1200, height: 800 };
const remoteSize = { width: 640, height: 480 };
let owner: OwnerFixture;
let interval: ReturnType<typeof setInterval>;
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
	ipc.handlers.get(channel)!(...args);

beforeEach(() => {
	ipc.handlers.clear();
	ipc.listeners.clear();
	ipc.windows.length = 0;
	owner = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		webContents: {
			id: 1,
			isDestroyed: () => false,
			setBackgroundThrottling: vi.fn(),
			send: (channel: string, payload: { requestId: string }) => {
				if (channel === 'browser:relayRequest')
					ipc.listeners.get('browser:relayResponse')!(
						{ sender: owner.webContents },
						payload.requestId,
						{
							ok: true,
							initialUrl: 'https://example.com',
							partition: 'persist:maestro-browser-session-session',
						}
					);
			},
		},
	});
	const original = globalThis.setInterval;
	vi.spyOn(globalThis, 'setInterval').mockImplementation(((
		...args: Parameters<typeof setInterval>
	) => {
		interval = original(...args);
		return interval;
	}) as typeof setInterval);
	// Electron is replaced only at the native boundary; production relay and page queues run unchanged.
	const hostWindow = owner as unknown as BrowserWindow;
	registerBrowserRelayHandlers({ getMainWindow: () => hostWindow });
	invoke('browser:relayReady', { sender: owner.webContents }, true);
});
afterEach(() => {
	closeBrowserRelayClient(remote.clientId);
	clearInterval(interval);
	vi.restoreAllMocks();
});

describe('shared host browser page', () => {
	it('keeps the visible host viewport while Lite requests different frame sizes', async () => {
		const native = { sender: owner.webContents };
		await invoke('browser:pageOpen', native, target, 'host-view', nativeSize);
		await invoke('browser:pageFrame', native, target, 'host-view', nativeSize);
		const lease = await invoke('browser:relayOpen', remote, target, remoteSize);
		expect(await invoke('browser:relayFrame', remote, lease, remoteSize)).toMatchObject(nativeSize);
		const resized = { width: 1400, height: 900 };
		expect(await invoke('browser:pageFrame', native, target, 'host-view', resized)).toMatchObject(
			resized
		);
		expect(ipc.windows[0]).toMatchObject(resized);
		invoke('browser:pageSuspend', native, target, 'host-view');
		expect(await invoke('browser:relayFrame', remote, lease, remoteSize)).toMatchObject(remoteSize);
	});

	it('rejects queued remote input after disconnect without cancelling the host input ahead of it', async () => {
		const lease = await invoke('browser:relayOpen', remote, target, remoteSize);
		const pending = Promise.withResolvers<void>();
		const send = ipc.windows[0].webContents.debugger.sendCommand;
		send.mockImplementationOnce(() => pending.promise);
		const hostInput = invoke('browser:pageInput', { sender: owner.webContents }, target, {
			type: 'text',
			text: 'host',
		});
		await nextTurn();
		const remoteInput = invoke('browser:relayInput', remote, lease, {
			type: 'text',
			text: 'stale remote',
		});
		const result = remoteInput.then(
			() => null,
			(error: Error) => error
		);
		await nextTurn();
		closeBrowserRelayClient(remote.clientId);
		pending.resolve();
		await hostInput;
		expect(await result).toMatchObject({ message: expect.stringContaining('lease expired') });
		expect(send.mock.calls).toEqual([['Input.insertText', { text: 'host' }]]);
	});
});
