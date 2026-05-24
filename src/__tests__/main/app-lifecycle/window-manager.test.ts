/**
 * Tests for window manager factory.
 *
 * Tests cover:
 * - Factory creates window manager with createWindow method
 * - Window creation uses saved state from store
 * - Window saves state on close
 * - DevTools and auto-updater initialization based on environment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WindowManagerDependencies } from '../../../main/app-lifecycle/window-manager';

// Track event handlers
let windowCloseHandler: (() => void) | null = null;

// Mock BrowserWindow instance methods
const mockWebContents = {
	send: vi.fn(),
	openDevTools: vi.fn(),
	reload: vi.fn(),
	on: vi.fn(),
	setWindowOpenHandler: vi.fn(),
	session: {
		setPermissionRequestHandler: vi.fn(),
	},
};

const mockWindowInstance = {
	loadURL: vi.fn(),
	loadFile: vi.fn(),
	maximize: vi.fn(),
	setFullScreen: vi.fn(),
	isMaximized: vi.fn().mockReturnValue(false),
	isFullScreen: vi.fn().mockReturnValue(false),
	isDestroyed: vi.fn().mockReturnValue(false),
	getBounds: vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 }),
	webContents: mockWebContents,
	on: vi.fn((event: string, handler: () => void) => {
		if (event === 'close') windowCloseHandler = handler;
	}),
};

// Track constructor options for assertions
let lastBrowserWindowOptions: Record<string, unknown> | null = null;

// Create a class-based mock for BrowserWindow
class MockBrowserWindow {
	loadURL = mockWindowInstance.loadURL;
	loadFile = mockWindowInstance.loadFile;
	maximize = mockWindowInstance.maximize;
	setFullScreen = mockWindowInstance.setFullScreen;
	isMaximized = mockWindowInstance.isMaximized;
	isFullScreen = mockWindowInstance.isFullScreen;
	isDestroyed = mockWindowInstance.isDestroyed;
	getBounds = mockWindowInstance.getBounds;
	webContents = mockWindowInstance.webContents;
	on = mockWindowInstance.on;

	constructor(options: unknown) {
		lastBrowserWindowOptions = options as Record<string, unknown>;
	}
}

// Mock ipcMain
const mockHandle = vi.fn();

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
	ipcMain: {
		handle: (...args: unknown[]) => mockHandle(...args),
	},
}));

// Mock logger
const mockLogger = {
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
};

vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

// Mock auto-updater
const mockInitAutoUpdater = vi.fn();
vi.mock('../../../main/auto-updater', () => ({
	initAutoUpdater: (...args: unknown[]) => mockInitAutoUpdater(...args),
}));

const sentryMocks = vi.hoisted(() => ({
	captureMessage: vi.fn(),
}));
vi.mock('@sentry/electron/main', () => sentryMocks);

// Mock electron-devtools-installer (for development mode)
vi.mock('electron-devtools-installer', () => ({
	default: vi.fn().mockResolvedValue('React DevTools'),
	REACT_DEVELOPER_TOOLS: 'REACT_DEVELOPER_TOOLS',
}));

describe('app-lifecycle/window-manager', () => {
	let mockWindowStateStore: {
		store: {
			x: number;
			y: number;
			width: number;
			height: number;
			isMaximized: boolean;
			isFullScreen: boolean;
		};
		set: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules(); // Reset module cache to clear devStubsRegistered flag
		windowCloseHandler = null;
		lastBrowserWindowOptions = null;

		mockWindowStateStore = {
			store: {
				x: 50,
				y: 50,
				width: 1400,
				height: 900,
				isMaximized: false,
				isFullScreen: false,
			},
			set: vi.fn(),
		};

		// Reset mock implementations
		mockWindowInstance.isMaximized.mockReturnValue(false);
		mockWindowInstance.isFullScreen.mockReturnValue(false);
		mockWindowInstance.isDestroyed.mockReturnValue(false);
		mockWindowInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
		delete process.env.DEBUG;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('createWindowManager', () => {
		it('should create a window manager with createWindow method', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			expect(windowManager).toHaveProperty('createWindow');
			expect(typeof windowManager.createWindow).toBe('function');
		});
	});

	describe('createWindow', () => {
		const createWindowWith = async (overrides: Partial<WindowManagerDependencies> = {}) => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');
			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
				...overrides,
			});

			const mainWindow = windowManager.createWindow();
			return { createWindowManager, windowManager, mainWindow };
		};

		const getWebContentsHandler = (eventName: string) => {
			const call = mockWebContents.on.mock.calls.find((call: unknown[]) => call[0] === eventName);
			expect(call).toBeDefined();
			return call![1] as (...args: unknown[]) => void;
		};

		const getWindowHandler = (eventName: string) => {
			const call = mockWindowInstance.on.mock.calls.find(
				(call: unknown[]) => call[0] === eventName
			);
			expect(call).toBeDefined();
			return call![1] as (...args: unknown[]) => void;
		};

		const flushAsyncCrashReporting = async () => {
			await vi.dynamicImportSettled();
			await Promise.resolve();
			await Promise.resolve();
		};

		it('should create BrowserWindow and return it', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			const result = windowManager.createWindow();

			expect(result).toBeInstanceOf(MockBrowserWindow);
		});

		it('should maximize window if saved state is maximized', async () => {
			mockWindowStateStore.store.isMaximized = true;

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.maximize).toHaveBeenCalled();
		});

		it('should set fullscreen if saved state is fullscreen', async () => {
			mockWindowStateStore.store.isFullScreen = true;

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.setFullScreen).toHaveBeenCalledWith(true);
			expect(mockWindowInstance.maximize).not.toHaveBeenCalled();
		});

		it('should load production file in production mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadFile).toHaveBeenCalledWith('/path/to/index.html');
			expect(mockWindowInstance.loadURL).not.toHaveBeenCalled();
		});

		it('should load dev server URL in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:5173');
			expect(mockWindowInstance.loadFile).not.toHaveBeenCalled();
		});

		it('should initialize auto-updater in production mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockInitAutoUpdater).toHaveBeenCalled();
		});

		it('should register stub handlers in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockInitAutoUpdater).not.toHaveBeenCalled();
			// Should register stub handlers
			expect(mockHandle).toHaveBeenCalled();
		});

		it('should save window state on close', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			// Trigger close handler
			expect(windowCloseHandler).not.toBeNull();
			windowCloseHandler!();

			expect(mockWindowStateStore.set).toHaveBeenCalledWith('x', 100);
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('y', 100);
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('width', 1200);
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('height', 800);
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('isMaximized', false);
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('isFullScreen', false);
		});

		it('should not save bounds when maximized', async () => {
			mockWindowInstance.isMaximized.mockReturnValue(true);

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();
			windowCloseHandler!();

			// Should save isMaximized but not bounds
			expect(mockWindowStateStore.set).toHaveBeenCalledWith('isMaximized', true);
			expect(mockWindowStateStore.set).not.toHaveBeenCalledWith('x', expect.anything());
			expect(mockWindowStateStore.set).not.toHaveBeenCalledWith('y', expect.anything());
		});

		it('should log window creation details', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Browser window created',
				'Window',
				expect.objectContaining({
					size: '1400x900',
					maximized: false,
					fullScreen: false,
					mode: 'production',
				})
			);
		});

		it('should set up window open handler to deny all popups', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWebContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));

			// Verify the handler denies all requests
			const handler = mockWebContents.setWindowOpenHandler.mock.calls[0][0];
			const result = handler({ url: 'https://evil.example.com' });
			expect(result).toEqual({ action: 'deny' });
		});

		it('should set up will-navigate handler', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			// Verify will-navigate handler was registered
			expect(mockWebContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
		});

		it('should block navigation to external URLs in production', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			// Find the will-navigate handler
			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			expect(willNavigateCall).toBeDefined();
			const navigateHandler = willNavigateCall![1];

			// Should block external URL
			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'https://evil.example.com');
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});

		it('should allow file:// navigation within renderer directory in production', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			const navigateHandler = willNavigateCall![1];

			// Should allow file:// navigation within the renderer's directory (/path/to/)
			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'file:///path/to/index.html');
			expect(mockEvent.preventDefault).not.toHaveBeenCalled();
		});

		it('should block file:// navigation outside renderer directory in production', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			const navigateHandler = willNavigateCall![1];

			// Should block file:// navigation to paths outside the renderer directory
			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'file:///etc/passwd');
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});

		it('should allow dev server navigation in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			const navigateHandler = willNavigateCall![1];

			// Should allow dev server navigation
			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'http://localhost:5173/some/path');
			expect(mockEvent.preventDefault).not.toHaveBeenCalled();
		});

		it('should block non-dev-server navigation in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			const navigateHandler = willNavigateCall![1];

			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'https://example.com/phishing');

			expect(mockEvent.preventDefault).toHaveBeenCalledTimes(1);
		});

		it('should omit titleBarStyle when useNativeTitleBar is true', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: true,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(lastBrowserWindowOptions).not.toHaveProperty('titleBarStyle');
		});

		it('should include autoHideMenuBar when autoHideMenuBar is true', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: true,
			});

			windowManager.createWindow();

			expect(lastBrowserWindowOptions).toHaveProperty('autoHideMenuBar', true);
		});

		it('should allow clipboard permissions and deny all others', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWebContents.session.setPermissionRequestHandler).toHaveBeenCalledWith(
				expect.any(Function)
			);

			const handler = mockWebContents.session.setPermissionRequestHandler.mock.calls[0][0];

			// Clipboard permissions should be allowed
			const allowedCb = vi.fn();
			handler(null, 'clipboard-read', allowedCb);
			expect(allowedCb).toHaveBeenCalledWith(true);

			const writeCb = vi.fn();
			handler(null, 'clipboard-sanitized-write', writeCb);
			expect(writeCb).toHaveBeenCalledWith(true);

			// All other permissions should be denied
			const deniedPermissions = ['camera', 'microphone', 'geolocation', 'notifications', 'midi'];
			for (const perm of deniedPermissions) {
				const cb = vi.fn();
				handler(null, perm, cb);
				expect(cb).toHaveBeenCalledWith(false);
			}
		});

		it('should open DevTools in production when DEBUG is true', async () => {
			process.env.DEBUG = 'true';

			await createWindowWith();

			expect(mockWebContents.openDevTools).toHaveBeenCalled();
		});

		it('should swallow non-critical errors while saving window state', async () => {
			await createWindowWith();
			mockWindowStateStore.set.mockImplementation(() => {
				throw new Error('disk full');
			});

			expect(windowCloseHandler).not.toBeNull();
			expect(() => windowCloseHandler!()).not.toThrow();
		});

		it('should not save bounds when fullscreen', async () => {
			mockWindowInstance.isFullScreen.mockReturnValue(true);

			await createWindowWith();
			windowCloseHandler!();

			expect(mockWindowStateStore.set).toHaveBeenCalledWith('isFullScreen', true);
			expect(mockWindowStateStore.set).not.toHaveBeenCalledWith('width', expect.anything());
			expect(mockWindowStateStore.set).not.toHaveBeenCalledWith('height', expect.anything());
		});

		it('should log closed, unresponsive, responsive, and webContents crash events', async () => {
			await createWindowWith();

			getWindowHandler('closed')();
			expect(mockLogger.info).toHaveBeenCalledWith('Browser window closed', 'Window');

			getWindowHandler('unresponsive')();
			expect(mockLogger.warn).toHaveBeenCalledWith('Window became unresponsive', 'Window');

			getWindowHandler('responsive')();
			expect(mockLogger.info).toHaveBeenCalledWith('Window became responsive again', 'Window');

			const crashedHandler = getWebContentsHandler('crashed');
			crashedHandler(null, false);
			crashedHandler(null, true);
			await flushAsyncCrashReporting();

			expect(mockLogger.error).toHaveBeenCalledWith('WebContents crashed', 'Window', {
				killed: false,
			});
			expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
				'Window unresponsive',
				expect.objectContaining({ level: 'warning' })
			);
		});

		it('should report renderer process crashes and reload when the window survives', async () => {
			vi.useFakeTimers();
			await createWindowWith();

			const goneHandler = getWebContentsHandler('render-process-gone');
			goneHandler(null, { reason: 'crashed', exitCode: 9 });
			await flushAsyncCrashReporting();

			expect(mockLogger.error).toHaveBeenCalledWith('Renderer process gone', 'Window', {
				reason: 'crashed',
				exitCode: 9,
			});
			expect(sentryMocks.captureMessage).toHaveBeenCalledWith('Renderer process gone: crashed', {
				level: 'fatal',
				extra: { reason: 'crashed', exitCode: 9 },
			});

			vi.advanceTimersByTime(1000);
			expect(mockWebContents.reload).toHaveBeenCalled();
		});

		it('should not reload renderer crashes for intentional exits or destroyed windows', async () => {
			vi.useFakeTimers();
			await createWindowWith();
			const goneHandler = getWebContentsHandler('render-process-gone');

			goneHandler(null, { reason: 'killed', exitCode: 0 });
			goneHandler(null, { reason: 'clean-exit', exitCode: 0 });
			vi.advanceTimersByTime(1000);
			expect(mockWebContents.reload).not.toHaveBeenCalled();

			goneHandler(null, { reason: 'oom', exitCode: 137 });
			mockWindowInstance.isDestroyed.mockReturnValue(true);
			vi.advanceTimersByTime(1000);
			expect(mockWebContents.reload).not.toHaveBeenCalled();
		});

		it('should handle page load failures while ignoring aborted loads', async () => {
			await createWindowWith();
			const failLoadHandler = getWebContentsHandler('did-fail-load');

			failLoadHandler(null, -3, 'ERR_ABORTED', 'https://example.com/aborted');
			expect(mockLogger.error).not.toHaveBeenCalledWith(
				'Page failed to load',
				'Window',
				expect.anything()
			);

			failLoadHandler(null, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/missing');
			await flushAsyncCrashReporting();

			expect(mockLogger.error).toHaveBeenCalledWith('Page failed to load', 'Window', {
				errorCode: -105,
				errorDescription: 'ERR_NAME_NOT_RESOLVED',
				url: 'https://example.com/missing',
			});
			expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
				'Page failed to load: ERR_NAME_NOT_RESOLVED',
				{
					level: 'error',
					extra: {
						errorCode: -105,
						errorDescription: 'ERR_NAME_NOT_RESOLVED',
						url: 'https://example.com/missing',
					},
				}
			);
		});

		it('should report preload errors and critical renderer console errors', async () => {
			await createWindowWith();

			const preloadError = new Error('preload exploded');
			getWebContentsHandler('preload-error')(null, '/path/to/preload.js', preloadError);
			await flushAsyncCrashReporting();

			const consoleHandler = getWebContentsHandler('console-message');
			consoleHandler(null, 2, 'warning only', 12, 'renderer.js');
			consoleHandler(null, 3, 'ordinary error text', 13, 'renderer.js');

			expect(mockLogger.error).toHaveBeenCalledWith('Preload script error', 'Window', {
				preloadPath: '/path/to/preload.js',
				error: 'preload exploded',
				stack: preloadError.stack,
			});
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Renderer console error: ordinary error text',
				'Window',
				{ line: 13, source: 'renderer.js' }
			);
			expect(sentryMocks.captureMessage).toHaveBeenCalledWith('Preload script error', {
				level: 'fatal',
				extra: {
					preloadPath: '/path/to/preload.js',
					error: 'preload exploded',
					stack: preloadError.stack,
				},
			});
			sentryMocks.captureMessage.mockClear();

			consoleHandler(null, 3, 'Uncaught TypeError: Cannot read properties', 14, 'renderer.js');
			await flushAsyncCrashReporting();

			expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
				'Renderer error: Uncaught TypeError: Cannot read properties',
				{ level: 'error', extra: { line: 14, source: 'renderer.js' } }
			);
		});

		it('should expose development auto-updater stub handler results and skip duplicates', async () => {
			await createWindowWith({ isDevelopment: true });

			const handlers = new Map<string, (...args: unknown[]) => unknown>(
				mockHandle.mock.calls.map(([channel, handler]) => [
					channel as string,
					handler as (...args: unknown[]) => unknown,
				])
			);

			await expect(handlers.get('updates:download')!()).resolves.toEqual({
				success: false,
				error: 'Auto-update is disabled in development mode. Please check update first.',
			});
			await expect(handlers.get('updates:getStatus')!()).resolves.toEqual({ status: 'idle' });
			await expect(handlers.get('updates:checkAutoUpdater')!()).resolves.toEqual({
				success: false,
				error: 'Auto-update is disabled in development mode',
			});
			await handlers.get('updates:install')!();
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Auto-update install called in development mode',
				'AutoUpdater'
			);

			const registeredCount = mockHandle.mock.calls.length;
			await createWindowWith({ isDevelopment: true });

			expect(mockHandle).toHaveBeenCalledTimes(registeredCount);
			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Auto-updater stub handlers already registered, skipping',
				'Window'
			);
		});

		it('should warn when React DevTools extension installation fails', async () => {
			const devtoolsInstaller = await import('electron-devtools-installer');
			vi.mocked(devtoolsInstaller.default).mockRejectedValueOnce(new Error('extension blocked'));

			await createWindowWith({ isDevelopment: true });
			await flushAsyncCrashReporting();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to install React DevTools: extension blocked',
				'Window'
			);
		});

		it('should warn when the React DevTools installer module cannot be loaded', async () => {
			vi.resetModules();
			vi.doMock('electron-devtools-installer', () => {
				throw new Error('module unavailable');
			});

			await createWindowWith({ isDevelopment: true });
			await flushAsyncCrashReporting();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to load electron-devtools-installer:'),
				'Window'
			);
		});
	});
});
