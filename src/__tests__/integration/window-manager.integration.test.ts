import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class MockEmitter {
		listeners = new Map<string, Listener[]>();

		on(event: string, listener: Listener) {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}

		emit(event: string, ...args: unknown[]) {
			for (const listener of this.listeners.get(event) ?? []) {
				listener(...args);
			}
		}
	}

	class MockWebContents extends MockEmitter {
		getType = vi.fn(() => 'window');
		openDevTools = vi.fn();
		reload = vi.fn();
		setWindowOpenHandler = vi.fn();
		session = {
			setPermissionRequestHandler: vi.fn(),
		};
	}

	class MockBrowserWindow extends MockEmitter {
		static instances: MockBrowserWindow[] = [];

		constructor(public options: Record<string, unknown>) {
			super();
			MockBrowserWindow.instances.push(this);
		}

		getBounds = vi.fn(() => ({ height: 700, width: 1100, x: 15, y: 25 }));
		isDestroyed = vi.fn(() => false);
		isFullScreen = vi.fn(() => false);
		isMaximized = vi.fn(() => false);
		isMinimized = vi.fn(() => false);
		loadFile = vi.fn();
		loadURL = vi.fn();
		maximize = vi.fn();
		setFullScreen = vi.fn();
		webContents = new MockWebContents();
	}

	return {
		BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
			return new MockBrowserWindow(options);
		}),
		MockBrowserWindow,
		ipcMain: {
			handle: vi.fn(),
		},
		screen: {
			getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
		},
	};
});

const loggerMock = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

const autoUpdaterMock = vi.hoisted(() => ({
	initAutoUpdater: vi.fn(),
}));

const sentryMock = vi.hoisted(() => ({
	captureMessage: vi.fn(() => 'event-id'),
}));

const devtoolsMock = vi.hoisted(() => ({
	REACT_DEVELOPER_TOOLS: 'react-devtools',
	default: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
	BrowserWindow: electronMocks.BrowserWindow,
	ipcMain: electronMocks.ipcMain,
	screen: electronMocks.screen,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: loggerMock,
}));

vi.mock('../../main/auto-updater', () => autoUpdaterMock);

vi.mock('@sentry/electron/main', () => sentryMock);

vi.mock('electron-devtools-installer', () => devtoolsMock);

describe('window-manager integration', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		electronMocks.MockBrowserWindow.instances.length = 0;
		delete process.env.DEBUG;
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env.DEBUG;
	});

	it('creates a development window with state persistence, security guards, and dev update stubs', async () => {
		const { createWindowManager } = await import('../../main/app-lifecycle/window-manager');
		const windowStateStore = createWindowStateStore();

		const firstWindow = createWindowManager({
			autoHideMenuBar: true,
			devServerUrl: 'http://localhost:5173',
			isDevelopment: true,
			preloadPath: '/app/preload.js',
			rendererProductionUrl: 'app://app/index.html',
			useNativeTitleBar: false,
			windowStateStore,
		}).createWindow() as MockWindow;

		expect(electronMocks.BrowserWindow).toHaveBeenCalledWith(
			expect.objectContaining({
				autoHideMenuBar: true,
				height: 768,
				titleBarStyle: 'hiddenInset',
				webPreferences: expect.objectContaining({
					contextIsolation: true,
					nodeIntegration: false,
					preload: '/app/preload.js',
					sandbox: true,
				}),
				width: 1280,
				x: 100,
				y: 120,
			})
		);
		expect(firstWindow.loadURL).toHaveBeenCalledWith('http://localhost:5173');
		expect(electronMocks.ipcMain.handle).toHaveBeenCalledTimes(4);

		const popupHandler = firstWindow.webContents.setWindowOpenHandler.mock.calls[0][0];
		expect(popupHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });

		const allowedNavigation = { preventDefault: vi.fn() };
		firstWindow.webContents.emit('will-navigate', allowedNavigation, 'http://localhost:5173/');
		expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();

		const blockedSameOriginNavigation = { preventDefault: vi.fn() };
		firstWindow.webContents.emit(
			'will-navigate',
			blockedSameOriginNavigation,
			'http://localhost:5173/path'
		);
		expect(blockedSameOriginNavigation.preventDefault).toHaveBeenCalledTimes(1);

		const blockedNavigation = { preventDefault: vi.fn() };
		firstWindow.webContents.emit('will-navigate', blockedNavigation, 'https://example.com');
		expect(blockedNavigation.preventDefault).toHaveBeenCalledTimes(1);

		const permissionHandler =
			firstWindow.webContents.session.setPermissionRequestHandler.mock.calls[0][0];
		const clipboardCallback = vi.fn();
		permissionHandler(firstWindow.webContents, 'clipboard-read', clipboardCallback);
		expect(clipboardCallback).toHaveBeenCalledWith(true);
		const webviewClipboardCallback = vi.fn();
		permissionHandler({ getType: () => 'webview' }, 'clipboard-read', webviewClipboardCallback);
		expect(webviewClipboardCallback).toHaveBeenCalledWith(false);
		const mediaCallback = vi.fn();
		permissionHandler(firstWindow.webContents, 'media', mediaCallback);
		expect(mediaCallback).toHaveBeenCalledWith(false);

		firstWindow.emit('close');
		expect(windowStateStore.set).toHaveBeenCalledWith('x', 15);
		expect(windowStateStore.set).toHaveBeenCalledWith('y', 25);
		expect(windowStateStore.set).toHaveBeenCalledWith('width', 1100);
		expect(windowStateStore.set).toHaveBeenCalledWith('height', 700);
		expect(windowStateStore.set).toHaveBeenCalledWith('isMaximized', false);
		expect(windowStateStore.set).toHaveBeenCalledWith('isFullScreen', false);

		createWindowManager({
			autoHideMenuBar: false,
			devServerUrl: 'http://localhost:5173',
			isDevelopment: true,
			preloadPath: '/app/preload.js',
			rendererProductionUrl: 'app://app/index.html',
			useNativeTitleBar: true,
			windowStateStore,
		}).createWindow();
		expect(electronMocks.ipcMain.handle).toHaveBeenCalledTimes(4);
	});

	it('creates a production window and routes renderer failures to reload, logging, and Sentry', async () => {
		vi.useFakeTimers();
		process.env.DEBUG = 'true';
		const { createWindowManager } = await import('../../main/app-lifecycle/window-manager');
		const windowStateStore = createWindowStateStore({ isFullScreen: true });

		const mainWindow = createWindowManager({
			autoHideMenuBar: false,
			devServerUrl: 'http://localhost:5173',
			isDevelopment: false,
			preloadPath: '/app/preload.js',
			rendererProductionUrl: 'app://app/index.html',
			useNativeTitleBar: true,
			windowStateStore,
		}).createWindow() as MockWindow;

		expect(mainWindow.setFullScreen).toHaveBeenCalledWith(true);
		expect(mainWindow.loadURL).toHaveBeenCalledWith('app://app/index.html');
		expect(mainWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
		expect(autoUpdaterMock.initAutoUpdater).toHaveBeenCalledWith(
			mainWindow,
			expect.objectContaining({ onBeforeQuitAndInstall: expect.any(Function) })
		);

		const productionAllowed = { preventDefault: vi.fn() };
		mainWindow.webContents.emit('will-navigate', productionAllowed, 'app://app/index.html');
		expect(productionAllowed.preventDefault).not.toHaveBeenCalled();

		const productionBlocked = { preventDefault: vi.fn() };
		mainWindow.webContents.emit('will-navigate', productionBlocked, 'app://app/settings.html');
		expect(productionBlocked.preventDefault).toHaveBeenCalledTimes(1);

		const abortedLoadLoggerCount = loggerMock.error.mock.calls.length;
		mainWindow.webContents.emit('did-fail-load', {}, -3, 'aborted', 'file:///app/dist/index.html');
		expect(loggerMock.error).toHaveBeenCalledTimes(abortedLoadLoggerCount);

		mainWindow.webContents.emit('did-fail-load', {}, -2, 'network failed', 'https://example.com');
		mainWindow.webContents.emit('preload-error', {}, '/app/preload.js', new Error('boom'));
		mainWindow.webContents.emit(
			'console-message',
			{},
			3,
			'Uncaught TypeError: Cannot read properties',
			44,
			'app.js'
		);
		mainWindow.webContents.emit('crashed', {}, false);
		mainWindow.emit('unresponsive');
		mainWindow.emit('responsive');

		mainWindow.webContents.emit('render-process-gone', {}, { exitCode: 134, reason: 'oom' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(mainWindow.webContents.reload).toHaveBeenCalledTimes(1);

		mainWindow.webContents.reload.mockClear();
		mainWindow.webContents.emit('render-process-gone', {}, { exitCode: 0, reason: 'killed' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(mainWindow.webContents.reload).not.toHaveBeenCalled();

		await flushPromises();
		await vi.dynamicImportSettled();
		await vi.waitFor(() => expect(sentryMock.captureMessage).toHaveBeenCalled());
		expect(loggerMock.error).toHaveBeenCalledWith(
			'Renderer console error: Uncaught TypeError: Cannot read properties',
			'Window',
			expect.objectContaining({ line: 44, source: 'app.js' })
		);
	});
});

type MockWindow = InstanceType<typeof electronMocks.MockBrowserWindow>;

function createWindowStateStore(overrides: Record<string, unknown> = {}) {
	return {
		set: vi.fn(),
		store: {
			height: 768,
			isFullScreen: false,
			isMaximized: false,
			width: 1280,
			x: 100,
			y: 120,
			...overrides,
		},
	} as never;
}

async function flushPromises() {
	for (let index = 0; index < 10; index++) {
		await Promise.resolve();
	}
}
