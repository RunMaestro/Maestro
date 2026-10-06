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
	native: null as (Guest & { id: number }) | null,
	nativeSession: {},
}));
vi.mock('electron', () => ({
	webContents: { fromId: (id: number) => (ipc.native?.id === id ? ipc.native : null) },
	session: { fromPartition: () => ipc.nativeSession },
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
	ipc.native = null;
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
							webContentsId: ipc.native?.id,
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
	it('attaches remote capture and input to the live native guest without a second page or navigation', async () => {
		const capturePage = vi.fn().mockResolvedValue({
			isEmpty: () => false,
			getSize: () => nativeSize,
			toJPEG: () => Buffer.from('native frame'),
		});
		const loadURL = vi.fn();
		ipc.native = Object.assign(new EventEmitter(), {
			id: 42,
			hostWebContents: owner.webContents,
			session: ipc.nativeSession,
			getType: () => 'webview',
			isDestroyed: () => false,
			getURL: () => 'https://example.com/form',
			getTitle: () => 'Unsaved form',
			isLoading: () => false,
			navigationHistory: { canGoBack: () => true, canGoForward: () => false },
			capturePage,
			loadURL,
			debugger: { isAttached: () => true, sendCommand: vi.fn().mockResolvedValue(undefined) },
		});
		const lease = await invoke('browser:relayOpen', remote, target, remoteSize);
		expect(ipc.windows).toHaveLength(0);
		expect(await invoke('browser:relayFrame', remote, lease, remoteSize)).toMatchObject({
			...nativeSize,
			url: 'https://example.com/form',
			dataUrl: expect.any(String),
		});
		await invoke('browser:relayInput', remote, lease, { type: 'text', text: 'continue form' });
		expect(ipc.native.debugger.sendCommand).toHaveBeenCalledWith('Input.insertText', {
			text: 'continue form',
		});
		const scaledSize = { width: 2560, height: 1440 };
		const resize = vi.fn().mockReturnValue({
			getSize: () => scaledSize,
			toJPEG: () => Buffer.from('scaled frame'),
		});
		capturePage.mockResolvedValueOnce({
			isEmpty: () => false,
			getSize: () => ({ width: 3840, height: 2160 }),
			toJPEG: () => Buffer.from('large frame'),
			resize,
		} as Awaited<ReturnType<typeof capturePage>>);
		expect(await invoke('browser:relayFrame', remote, lease, remoteSize)).toMatchObject(scaledSize);
		expect(resize).toHaveBeenCalledWith(scaledSize);
		await invoke('browser:relayInput', remote, lease, {
			type: 'mouseWheel',
			x: 2500,
			y: 1400,
			deltaX: 0,
			deltaY: 120,
		});
		expect(ipc.native.debugger.sendCommand).toHaveBeenLastCalledWith(
			'Input.dispatchMouseEvent',
			expect.objectContaining({ type: 'mouseWheel', x: 3750, y: 2100, deltaY: 120 })
		);
		await invoke('browser:relayClose', remote, lease);
		expect(loadURL).not.toHaveBeenCalled();
		expect(capturePage).toHaveBeenCalledTimes(2);
		// Native guests retain the desktop keep-alive lifetime. After the host
		// unmounts one, an attached remote view can reopen its URL offscreen.
		const reopened = await invoke('browser:relayOpen', remote, target, remoteSize);
		ipc.native.emit('destroyed');
		ipc.native = null;
		expect(await invoke('browser:relayFrame', remote, reopened, remoteSize)).toMatchObject(
			remoteSize
		);
		expect(ipc.windows).toHaveLength(1);
	});

	it.each(['owner', 'partition', 'type'] as const)(
		'refuses native guest identity with the wrong %s',
		async (field) => {
			ipc.native = Object.assign(new EventEmitter(), {
				id: 42,
				isDestroyed: () => false,
				hostWebContents: field === 'owner' ? { id: 99 } : owner.webContents,
				session: field === 'partition' ? {} : ipc.nativeSession,
				getType: () => (field === 'type' ? 'window' : 'webview'),
				debugger: { isAttached: () => true, sendCommand: vi.fn() },
			});
			await expect(invoke('browser:relayOpen', remote, target, remoteSize)).rejects.toThrow(
				'does not belong'
			);
			expect(ipc.windows).toHaveLength(0);
		}
	);

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
