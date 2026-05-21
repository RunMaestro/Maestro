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
import { recordMultiWindowUsage } from '../../../main/stats/multi-window-recorder';

// Track event handlers
let windowCloseHandler: (() => void) | null = null;
const webContentsEventHandlers = new Map<string, (...args: any[]) => void>();
const guestWebContentsEventHandlers = new Map<string, (...args: any[]) => void>();
let windowEventHandlers: Record<string, Array<() => void>> = {};
let nextBrowserWindowId = 1;

const mockGuestWebContents = {
	getType: vi.fn(() => 'webview'),
	setWindowOpenHandler: vi.fn(),
	on: vi.fn((event: string, handler: (...args: any[]) => void) => {
		guestWebContentsEventHandlers.set(event, handler);
	}),
	executeJavaScript: vi.fn().mockResolvedValue(undefined),
	paste: vi.fn(),
};

// Mock BrowserWindow instance methods
const mockWebContents = {
	send: vi.fn(),
	isDestroyed: vi.fn().mockReturnValue(false),
	openDevTools: vi.fn(),
	reload: vi.fn(),
	getType: vi.fn(() => 'window'),
	on: vi.fn((event: string, handler: (...args: any[]) => void) => {
		webContentsEventHandlers.set(event, handler);
	}),
	setWindowOpenHandler: vi.fn(),
	session: {
		setPermissionRequestHandler: vi.fn(),
		addWordToSpellCheckerDictionary: vi.fn(),
	},
	replaceMisspelling: vi.fn(),
};

const mockWindowInstance = {
	loadURL: vi.fn(),
	loadFile: vi.fn(),
	maximize: vi.fn(),
	setFullScreen: vi.fn(),
	isMaximized: vi.fn().mockReturnValue(false),
	isFullScreen: vi.fn().mockReturnValue(false),
	isMinimized: vi.fn().mockReturnValue(false),
	isDestroyed: vi.fn().mockReturnValue(false),
	getBounds: vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 }),
	webContents: mockWebContents,
	on: vi.fn((event: string, handler: () => void) => {
		windowEventHandlers[event] = [...(windowEventHandlers[event] ?? []), handler];
		if (event === 'close') windowCloseHandler = handler;
	}),
};

// Track constructor options for assertions
let lastBrowserWindowOptions: Record<string, unknown> | null = null;

// Create a class-based mock for BrowserWindow
class MockBrowserWindow {
	id: number;
	loadURL = mockWindowInstance.loadURL;
	loadFile = mockWindowInstance.loadFile;
	maximize = mockWindowInstance.maximize;
	setFullScreen = mockWindowInstance.setFullScreen;
	isMaximized = mockWindowInstance.isMaximized;
	isFullScreen = mockWindowInstance.isFullScreen;
	isMinimized = mockWindowInstance.isMinimized;
	isDestroyed = mockWindowInstance.isDestroyed;
	getBounds = mockWindowInstance.getBounds;
	webContents = mockWindowInstance.webContents;
	on = mockWindowInstance.on;

	constructor(options: unknown) {
		this.id = nextBrowserWindowId;
		nextBrowserWindowId += 1;
		lastBrowserWindowOptions = options as Record<string, unknown>;
	}
}

// Mock ipcMain
const mockHandle = vi.fn();

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
	screen: {
		getDisplayMatching: vi.fn(() => ({
			id: 1,
			workArea: { x: 0, y: 0, width: 1920, height: 1080 },
		})),
	},
	ipcMain: {
		handle: (...args: unknown[]) => mockHandle(...args),
	},
	Menu: {
		buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
	},
	screen: {
		getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
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

vi.mock('../../../main/stats/multi-window-recorder', () => ({
	recordMultiWindowUsage: vi.fn(),
}));

// Mock electron-devtools-installer (for development mode)
vi.mock('electron-devtools-installer', () => ({
	default: vi.fn().mockResolvedValue('React DevTools'),
	REACT_DEVELOPER_TOOLS: 'REACT_DEVELOPER_TOOLS',
}));

describe('app-lifecycle/window-manager', () => {
	let mockWindowStateStore: {
		store: {
			primaryWindowId: string;
			windows: Array<{
				id: string;
				x: number;
				y: number;
				width: number;
				height: number;
				isMaximized: boolean;
				isFullScreen: boolean;
				sessionIds: string[];
				activeSessionId: string | null;
				leftPanelCollapsed: boolean;
				rightPanelCollapsed: boolean;
			}>;
		};
		set: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules(); // Reset module cache to clear devStubsRegistered flag
		windowCloseHandler = null;
		windowEventHandlers = {};
		nextBrowserWindowId = 1;
		lastBrowserWindowOptions = null;
		webContentsEventHandlers.clear();
		guestWebContentsEventHandlers.clear();

		mockWindowStateStore = {
			store: {
				primaryWindowId: 'primary',
				windows: [
					{
						id: 'primary',
						x: 50,
						y: 50,
						width: 1400,
						height: 900,
						isMaximized: false,
						isFullScreen: false,
						sessionIds: [],
						activeSessionId: null,
						leftPanelCollapsed: false,
						rightPanelCollapsed: false,
					},
				],
			},
			set: vi.fn(),
		};

		// Reset mock implementations
		mockWindowInstance.isMaximized.mockReturnValue(false);
		mockWindowInstance.isFullScreen.mockReturnValue(false);
		mockWindowInstance.isMinimized.mockReturnValue(false);
		mockWindowInstance.isDestroyed.mockReturnValue(false);
		mockWebContents.isDestroyed.mockReturnValue(false);
		mockWindowInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
		mockWebContents.getType.mockReturnValue('window');
		mockGuestWebContents.getType.mockReturnValue('webview');
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			expect(windowManager).toHaveProperty('createWindow');
			expect(windowManager).toHaveProperty('createSecondaryWindow');
			expect(windowManager).toHaveProperty('windowRegistry');
			expect(typeof windowManager.createWindow).toBe('function');
			expect(typeof windowManager.createSecondaryWindow).toBe('function');
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			const result = windowManager.createWindow();

			expect(result).toBeInstanceOf(MockBrowserWindow);
		});

		it('should register created windows with explicit session ownership', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow('primary', ['session-1']);

			expect(windowManager.windowRegistry.get('primary')?.sessionIds).toEqual(['session-1']);
			expect(windowManager.windowRegistry.getWindowForSession('session-1')).toBe('primary');
		});

		it('should create secondary windows with provided sessions and bounds', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();
			const secondaryWindow = windowManager.createSecondaryWindow(['session-2'], {
				x: 300,
				y: 200,
				width: 900,
				height: 700,
			});

			expect(secondaryWindow).toBeInstanceOf(MockBrowserWindow);
			expect(windowManager.windowRegistry.getWindowForSession('session-2')).toBe('2');
			expect(lastBrowserWindowOptions).toMatchObject({
				x: 300,
				y: 200,
				width: 900,
				height: 700,
				webPreferences: expect.objectContaining({
					preload: '/path/to/preload.js',
				}),
			});
			expect(mockWindowInstance.loadURL).toHaveBeenLastCalledWith(
				'app://app/index.html?windowId=2'
			);
		});

		it('should maximize window if saved state is maximized', async () => {
			mockWindowStateStore.store.windows[0].isMaximized = true;

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.maximize).toHaveBeenCalled();
		});

		it('should set fullscreen if saved state is fullscreen', async () => {
			mockWindowStateStore.store.windows[0].isFullScreen = true;

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.setFullScreen).toHaveBeenCalledWith(true);
			expect(mockWindowInstance.maximize).not.toHaveBeenCalled();
		});

		it('should load production URL in production mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith(
				'app://app/index.html?windowId=primary'
			);
			expect(mockWindowInstance.loadFile).not.toHaveBeenCalled();
		});

		it('should load dev server URL in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith(
				'http://localhost:5173/?windowId=primary'
			);
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			// Trigger close handler
			expect(windowCloseHandler).not.toBeNull();
			windowCloseHandler!();

			expect(mockWindowStateStore.store.windows[0]).toMatchObject({
				x: 100,
				y: 100,
				width: 1200,
				height: 800,
				isMaximized: false,
				isFullScreen: false,
			});
		});

		it('should debounce window state saves after geometry and display-state changes', async () => {
			vi.useFakeTimers();
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();
			expect(mockWindowInstance.on).toHaveBeenCalledWith('move', expect.any(Function));
			expect(mockWindowInstance.on).toHaveBeenCalledWith('resize', expect.any(Function));
			expect(mockWindowInstance.on).toHaveBeenCalledWith('maximize', expect.any(Function));
			expect(mockWindowInstance.on).toHaveBeenCalledWith('unmaximize', expect.any(Function));
			expect(mockWindowInstance.on).toHaveBeenCalledWith('enter-full-screen', expect.any(Function));
			expect(mockWindowInstance.on).toHaveBeenCalledWith('leave-full-screen', expect.any(Function));

			mockWindowInstance.getBounds.mockReturnValue({ x: 150, y: 160, width: 1000, height: 700 });
			windowEventHandlers.move![0]();
			mockWindowInstance.getBounds.mockReturnValue({ x: 175, y: 185, width: 1100, height: 750 });
			windowEventHandlers.resize![0]();

			expect(mockWindowStateStore.store.windows[0]).toMatchObject({
				x: 50,
				y: 50,
				width: 1400,
				height: 900,
			});

			vi.advanceTimersByTime(249);
			expect(mockWindowStateStore.store.windows[0]).toMatchObject({
				x: 50,
				y: 50,
				width: 1400,
				height: 900,
			});

			vi.advanceTimersByTime(1);
			expect(mockWindowStateStore.store.windows[0]).toMatchObject({
				x: 175,
				y: 185,
				width: 1100,
				height: 750,
			});
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();
			windowCloseHandler!();

			// Should save isMaximized but not bounds
			expect(mockWindowStateStore.store.windows[0]).toMatchObject({
				x: 50,
				y: 50,
				width: 1400,
				height: 900,
				isMaximized: true,
			});
		});

		it('should remove secondary windows from persisted state after they close', async () => {
			mockWindowStateStore.store.windows = [
				{
					...mockWindowStateStore.store.windows[0],
					id: 'primary',
					sessionIds: ['session-1'],
				},
				{
					id: '2',
					x: 300,
					y: 200,
					width: 900,
					height: 700,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: ['session-2'],
					activeSessionId: 'session-2',
					leftPanelCollapsed: false,
					rightPanelCollapsed: true,
				},
			];
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
				isQuitting: () => false,
			});

			windowManager.createWindow('primary', ['session-1']);
			windowManager.createSecondaryWindow(['session-2'], {});
			windowEventHandlers.closed![1]();

			expect(mockWindowStateStore.store.windows.map((windowState) => windowState.id)).toEqual([
				'primary',
			]);
			expect(windowManager.windowRegistry.get('2')).toBeUndefined();
		});

		it('should move secondary window sessions to primary before close', async () => {
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
				isQuitting: () => false,
			});

			windowManager.createWindow('primary', ['session-1']);
			windowManager.createSecondaryWindow(['session-2', 'session-3'], {});
			windowCloseHandler!();

			expect(windowManager.windowRegistry.get('primary')?.sessionIds).toEqual([
				'session-1',
				'session-2',
				'session-3',
			]);
			expect(windowManager.windowRegistry.get('2')?.sessionIds).toEqual([]);
			expect(mockWebContents.send).toHaveBeenCalledWith('windows:sessionsMovedToPrimary', {
				sessionIds: ['session-2', 'session-3'],
				fromWindowId: '2',
				toWindowId: 'primary',
				windows: [
					{
						id: 'primary',
						isMain: true,
						sessionIds: ['session-1', 'session-2', 'session-3'],
						activeSessionId: null,
					},
					{
						id: '2',
						isMain: false,
						sessionIds: [],
						activeSessionId: null,
					},
				],
			});
			expect(recordMultiWindowUsage).toHaveBeenCalledWith(
				undefined,
				windowManager.windowRegistry,
				'window_closed',
				1
			);
		});

		it('should keep secondary window state when closing during app quit', async () => {
			mockWindowStateStore.store.windows = [
				{
					...mockWindowStateStore.store.windows[0],
					id: 'primary',
					sessionIds: ['session-1'],
				},
				{
					id: '2',
					x: 300,
					y: 200,
					width: 900,
					height: 700,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: ['session-2'],
					activeSessionId: 'session-2',
					leftPanelCollapsed: false,
					rightPanelCollapsed: true,
				},
			];
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
				isQuitting: () => true,
			});

			windowManager.createWindow('primary', ['session-1']);
			windowManager.createSecondaryWindow(['session-2'], {});
			windowEventHandlers.closed![1]();

			expect(mockWindowStateStore.store.windows.map((windowState) => windowState.id)).toEqual([
				'primary',
				'2',
			]);
			expect(windowManager.windowRegistry.get('2')).toBeUndefined();
		});

		it('should log window creation details', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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

		it('should omit titleBarStyle when useNativeTitleBar is true', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
	});
});
