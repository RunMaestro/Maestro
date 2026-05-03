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

// Track event handlers
let windowCloseHandler: (() => void) | null = null;
const webContentsEventHandlers = new Map<string, (...args: any[]) => void>();
const guestWebContentsEventHandlers = new Map<string, (...args: any[]) => void>();

const mockGuestWebContents = {
	getType: vi.fn(() => 'webview'),
	setWindowOpenHandler: vi.fn(),
	on: vi.fn((event: string, handler: (...args: any[]) => void) => {
		guestWebContentsEventHandlers.set(event, handler);
	}),
	executeJavaScript: vi.fn().mockResolvedValue(undefined),
};

// Mock BrowserWindow instance methods
const mockWebContents = {
	send: vi.fn(),
	openDevTools: vi.fn(),
	getType: vi.fn(() => 'window'),
	on: vi.fn((event: string, handler: (...args: any[]) => void) => {
		webContentsEventHandlers.set(event, handler);
	}),
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
		webContentsEventHandlers.clear();
		guestWebContentsEventHandlers.clear();

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
		mockWindowInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
		mockWebContents.getType.mockReturnValue('window');
		mockGuestWebContents.getType.mockReturnValue('webview');
	});

	afterEach(() => {
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

		it('enables webviewTag while keeping sandboxed renderer prefs', async () => {
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

			expect(lastBrowserWindowOptions?.webPreferences).toMatchObject({
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webviewTag: true,
			});
		});

		it('blocks unsafe webview attachments that use disallowed partitions or URLs', async () => {
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

			const handler = webContentsEventHandlers.get('will-attach-webview');
			expect(handler).toBeTruthy();

			const preventDefault = vi.fn();
			const webPreferences: Record<string, unknown> = {
				partition: 'persist:unexpected',
				preload: '/tmp/preload.js',
			};

			handler?.({ preventDefault } as any, webPreferences, {
				src: 'file:///tmp/escape.html',
			} as any);

			expect(preventDefault).toHaveBeenCalled();
			expect(webPreferences.preload).toBeUndefined();
			expect(webPreferences.nodeIntegration).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('hardens attached browser-tab guests with popup and navigation restrictions', async () => {
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			expect(attachHandler).toBeTruthy();

			attachHandler?.({} as any, mockGuestWebContents as any);

			expect(mockGuestWebContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
			expect(mockGuestWebContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
			expect(mockGuestWebContents.on).toHaveBeenCalledWith('will-redirect', expect.any(Function));
		});

		it('blocks unsafe browser-tab guest navigations after attachment', async () => {
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
			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const navigateHandler = guestWebContentsEventHandlers.get('will-navigate');
			expect(navigateHandler).toBeTruthy();

			const blockedEvent = { preventDefault: vi.fn() };
			navigateHandler?.(blockedEvent as any, 'file:///etc/passwd');
			expect(blockedEvent.preventDefault).toHaveBeenCalled();

			const allowedEvent = { preventDefault: vi.fn() };
			navigateHandler?.(allowedEvent as any, 'http://localhost:7100/');
			expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
		});

		it('denies browser-tab guest popup requests in the main process', async () => {
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
			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const handler = mockGuestWebContents.setWindowOpenHandler.mock.calls[0][0];
			expect(handler({ url: 'https://popup.example.com' })).toEqual({ action: 'deny' });
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

		it('should allow file:// navigation to the renderer entry HTML in production', async () => {
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

			// Should allow file:// navigation to the renderer entry HTML itself.
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

		it('regression: should block file:// navigation to other files inside the renderer directory in production', async () => {
			// A relative <a href="foo.md"> in chat output resolves against the
			// current page URL (the renderer's index.html), producing a file://
			// URL inside the renderer dir. The previous "directory prefix" check
			// allowed that through, unloading the app to a non-existent file.
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

			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'file:///path/to/TEST-PLAN-0.16.15-RC.md');
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});

		it('should block file:// navigation with a query string or fragment appended to the entry HTML', async () => {
			// Exact-match check: even if the path matches the renderer entry,
			// any added query/fragment is treated as different navigation.
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

			for (const url of [
				'file:///path/to/index.html?foo=bar',
				'file:///path/to/index.html#hash',
				'file:///path/to/index.htmlx', // suffix that "starts with" the entry
			]) {
				const mockEvent = { preventDefault: vi.fn() };
				navigateHandler(mockEvent, url);
				expect(mockEvent.preventDefault).toHaveBeenCalled();
			}
		});

		it('should block dev server navigation in production mode', async () => {
			// In production the dev-server origin is not on the allowlist.
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

			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'http://localhost:5173/');
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

		it('should block file:// navigation in development mode', async () => {
			// Dev mode only allows the dev-server origin, not local file:// URLs
			// (the renderer is served from Vite, not from disk).
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
			navigateHandler(mockEvent, 'file:///path/to/index.html');
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});

		it('should register a single will-navigate handler regardless of how many navigation events fire', async () => {
			// Regression for review feedback: rendererFileUrl/devUrl should be
			// computed once at setup, not per-event. Easiest observable proof is
			// that the handler is registered exactly once on the webContents.
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

			const willNavigateCalls = mockWebContents.on.mock.calls.filter(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			expect(willNavigateCalls).toHaveLength(1);

			// Drive the handler many times — behavior should be stable and the
			// allowed URL should still match exactly on every invocation.
			const navigateHandler = willNavigateCalls[0][1];
			for (let i = 0; i < 5; i++) {
				const allowed = { preventDefault: vi.fn() };
				navigateHandler(allowed, 'file:///path/to/index.html');
				expect(allowed.preventDefault).not.toHaveBeenCalled();

				const blocked = { preventDefault: vi.fn() };
				navigateHandler(blocked, 'file:///path/to/other.md');
				expect(blocked.preventDefault).toHaveBeenCalled();
			}
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
			handler(mockWebContents, 'clipboard-read', allowedCb);
			expect(allowedCb).toHaveBeenCalledWith(true);

			const writeCb = vi.fn();
			handler(mockWebContents, 'clipboard-sanitized-write', writeCb);
			expect(writeCb).toHaveBeenCalledWith(true);

			// All other permissions should be denied
			const deniedPermissions = ['camera', 'microphone', 'geolocation', 'notifications', 'midi'];
			for (const perm of deniedPermissions) {
				const cb = vi.fn();
				handler(null, perm, cb);
				expect(cb).toHaveBeenCalledWith(false);
			}
		});

		it('injects shortcut listener into browser-tab guests on dom-ready and did-navigate', async () => {
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			// Should register dom-ready and did-navigate handlers for injection
			expect(mockGuestWebContents.on).toHaveBeenCalledWith('dom-ready', expect.any(Function));
			expect(mockGuestWebContents.on).toHaveBeenCalledWith('did-navigate', expect.any(Function));

			// Trigger dom-ready — should call executeJavaScript
			const domReadyHandler = mockGuestWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'dom-ready'
			)?.[1];
			domReadyHandler?.();
			expect(mockGuestWebContents.executeJavaScript).toHaveBeenCalled();
		});

		it('forwards keyboard shortcuts from browser-tab guest via console-message', async () => {
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const consoleHandler = mockGuestWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'console-message'
			)?.[1];
			expect(consoleHandler).toBeDefined();

			// console-message args: (event, level, message, line, sourceId)
			// level=1 (info), message is args[2]
			const payload = JSON.stringify({
				key: 't',
				code: 'KeyT',
				meta: true,
				control: false,
				alt: false,
				shift: false,
			});
			consoleHandler?.({}, 1, `__MAESTRO_KEY__${payload}`, 0, '');

			expect(mockWebContents.send).toHaveBeenCalledWith(
				'browser-tab:shortcutKey',
				expect.objectContaining({ key: 't', meta: true })
			);
		});

		it('ignores console-message events without the __MAESTRO_KEY__ prefix', async () => {
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const consoleHandler = mockGuestWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'console-message'
			)?.[1];

			// Regular console message — should not forward
			consoleHandler?.({}, 1, 'Hello world', 0, '');
			expect(mockWebContents.send).not.toHaveBeenCalledWith(
				'browser-tab:shortcutKey',
				expect.anything()
			);
		});

		it('denies clipboard permission requests from browser-tab guests', async () => {
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

			const handler = mockWebContents.session.setPermissionRequestHandler.mock.calls[0][0];
			const callback = vi.fn();
			handler(mockGuestWebContents, 'clipboard-read', callback);

			expect(callback).toHaveBeenCalledWith(false);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Blocked browser-tab permission request: clipboard-read',
				'Window',
				expect.objectContaining({
					permission: 'clipboard-read',
					type: 'webview',
				})
			);
		});
	});
});
