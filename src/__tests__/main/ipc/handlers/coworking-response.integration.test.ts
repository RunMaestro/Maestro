import { beforeEach, describe, expect, it, vi } from 'vitest';

type MainListener = (event: { sender: { id: number } }, ...args: unknown[]) => void;
type RendererListener = (event: unknown, ...args: unknown[]) => void;

const {
	mainListeners,
	rendererListeners,
	mockIpcMainOn,
	mockIpcMainRemoveListener,
	mockSetTerminalBufferResolver,
} = vi.hoisted(() => {
	const mainListeners = new Map<string, Set<MainListener>>();
	const rendererListeners = new Map<string, Set<RendererListener>>();
	const mockIpcMainOn = vi.fn((channel: string, listener: MainListener) => {
		const channelListeners = mainListeners.get(channel) ?? new Set<MainListener>();
		channelListeners.add(listener);
		mainListeners.set(channel, channelListeners);
	});
	const mockIpcMainRemoveListener = vi.fn((channel: string, listener: MainListener) => {
		mainListeners.get(channel)?.delete(listener);
	});
	const mockSetTerminalBufferResolver = vi.fn();
	return {
		mainListeners,
		rendererListeners,
		mockIpcMainOn,
		mockIpcMainRemoveListener,
		mockSetTerminalBufferResolver,
	};
});

const rendererId = 404;

function sendToMain(channel: string, ...args: unknown[]): void {
	for (const listener of mainListeners.get(channel) ?? []) {
		listener({ sender: { id: rendererId } }, ...args);
	}
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
	for (const listener of rendererListeners.get(channel) ?? []) {
		listener({}, ...args);
	}
}

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		on: mockIpcMainOn,
		removeListener: mockIpcMainRemoveListener,
	},
	ipcRenderer: {
		invoke: vi.fn(),
		on: vi.fn((channel: string, listener: RendererListener) => {
			const channelListeners = rendererListeners.get(channel) ?? new Set<RendererListener>();
			channelListeners.add(listener);
			rendererListeners.set(channel, channelListeners);
		}),
		removeListener: vi.fn((channel: string, listener: RendererListener) => {
			rendererListeners.get(channel)?.delete(listener);
		}),
		send: vi.fn(sendToMain),
	},
}));

vi.mock('../../../../main/coworking/coworking-tools', () => ({
	setBrowserResolver: vi.fn(),
	setTerminalBufferResolver: mockSetTerminalBufferResolver,
}));
vi.mock('../../../../main/coworking/coworking-registry', () => ({
	coworkingRegistry: {
		syncSessionTerminals: vi.fn(),
		removeSession: vi.fn(),
		syncSessionBrowsers: vi.fn(),
		getBrowserConfirmPolicy: vi.fn(),
	},
}));
vi.mock('../../../../main/coworking/coworking-installer', () => ({
	getInstallStatus: vi.fn(),
	installFor: vi.fn(),
	installForAll: vi.fn(),
	uninstallFor: vi.fn(),
}));
vi.mock('../../../../main/coworking/coworking-audit', () => ({
	createDefaultBrowserAuditSink: vi.fn(),
	setBrowserAuditSink: vi.fn(),
}));
vi.mock('../../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging: vi.fn((_options: unknown, handler: unknown) => handler),
}));

import { registerCoworkingHandlers } from '../../../../main/ipc/handlers/coworking';
import { createCoworkingApi } from '../../../../main/preload/coworking';

type TerminalBufferResolver = (sessionId: string, tabUuid: string) => Promise<string>;

describe('coworking main/preload/renderer buffer round trip', () => {
	beforeEach(() => {
		mainListeners.clear();
		rendererListeners.clear();
		vi.clearAllMocks();
	});

	it('returns the matching renderer buffer over a request-specific response channel', async () => {
		const webContents = {
			id: rendererId,
			isDestroyed: () => false,
			once: vi.fn(),
			removeListener: vi.fn(),
			send: sendToRenderer,
		};
		registerCoworkingHandlers({
			getMainWindow: () =>
				({
					isDestroyed: () => false,
					webContents,
				}) as unknown as Electron.BrowserWindow,
		});
		const resolver = mockSetTerminalBufferResolver.mock.calls[0][0] as TerminalBufferResolver;
		const api = createCoworkingApi();
		const respond = vi.fn((tabUuid: string, sessionId: string, responseChannel: string) => {
			api.sendBufferResponse(responseChannel, `${sessionId}:${tabUuid}`);
		});
		const unsubscribe = api.onRequestBuffer(respond);
		const request = resolver('session-1', 'tab-1');

		expect(respond).toHaveBeenCalledTimes(1);
		await expect(request).resolves.toBe('session-1:tab-1');
		expect(mockIpcMainRemoveListener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});
});
