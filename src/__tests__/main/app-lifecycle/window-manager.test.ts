/**
 * Tests for window manager factory with multi-window support.
 *
 * Tests cover:
 * - Factory creates window manager with createWindow and createSecondaryWindow methods
 * - Window creation uses saved state from multi-window store
 * - Window saves state on close
 * - DevTools and auto-updater initialization based on environment
 * - Secondary window creation with proper bounds and session handling
 * - WindowRegistry integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track event handlers
let windowCloseHandler: (() => void) | null = null;
let windowClosedHandler: (() => void) | null = null;

// Mock BrowserWindow instance methods
const mockWebContents = {
	send: vi.fn(),
	openDevTools: vi.fn(),
};

const mockWindowInstance = {
	loadURL: vi.fn(),
	loadFile: vi.fn(),
	maximize: vi.fn(),
	setFullScreen: vi.fn(),
	setTitle: vi.fn(),
	isMaximized: vi.fn().mockReturnValue(false),
	isFullScreen: vi.fn().mockReturnValue(false),
	getBounds: vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 }),
	getPosition: vi.fn().mockReturnValue([100, 100]),
	webContents: mockWebContents,
	on: vi.fn((event: string, handler: () => void) => {
		if (event === 'close') windowCloseHandler = handler;
		if (event === 'closed') windowClosedHandler = handler;
	}),
};

// Create a class-based mock for BrowserWindow
class MockBrowserWindow {
	loadURL = mockWindowInstance.loadURL;
	loadFile = mockWindowInstance.loadFile;
	maximize = mockWindowInstance.maximize;
	setFullScreen = mockWindowInstance.setFullScreen;
	setTitle = mockWindowInstance.setTitle;
	isMaximized = mockWindowInstance.isMaximized;
	isFullScreen = mockWindowInstance.isFullScreen;
	getBounds = mockWindowInstance.getBounds;
	getPosition = mockWindowInstance.getPosition;
	webContents = mockWindowInstance.webContents;
	on = mockWindowInstance.on;

	constructor(_options: unknown) {
		// Constructor accepts options but we don't need them for the mock
	}

	static getFocusedWindow = vi.fn().mockReturnValue(null);
}

// Mock ipcMain
const mockHandle = vi.fn();

// Mock screen
const mockScreen = {
	getAllDisplays: vi
		.fn()
		.mockReturnValue([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 }]),
	getPrimaryDisplay: vi.fn().mockReturnValue({
		bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		id: 1,
	}),
	getDisplayNearestPoint: vi.fn().mockReturnValue({
		bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		id: 1,
	}),
};

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
	ipcMain: {
		handle: (...args: unknown[]) => mockHandle(...args),
	},
	screen: mockScreen,
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

// Mock uuid with incrementing IDs
let uuidCounter = 0;
vi.mock('uuid', () => ({
	v4: vi.fn(() => `mock-uuid-${++uuidCounter}`),
}));

describe('app-lifecycle/window-manager', () => {
	let mockMultiWindowStateStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.resetModules(); // Reset module cache to clear devStubsRegistered flag
		windowCloseHandler = null;
		windowClosedHandler = null;
		uuidCounter = 0; // Reset UUID counter

		mockMultiWindowStateStore = {
			get: vi.fn((key: string, defaultValue?: unknown) => {
				if (key === 'windows') return [];
				if (key === 'version') return 1;
				return defaultValue;
			}),
			set: vi.fn(),
		};

		// Reset mock implementations
		mockWindowInstance.isMaximized.mockReturnValue(false);
		mockWindowInstance.isFullScreen.mockReturnValue(false);
		mockWindowInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
		MockBrowserWindow.getFocusedWindow.mockReturnValue(null);

		// Reset the window registry before each test
		const { windowRegistry } = await import('../../../main/window-registry');
		windowRegistry.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('createWindowManager', () => {
		it('should create a window manager with all required methods', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			expect(windowManager).toHaveProperty('createWindow');
			expect(windowManager).toHaveProperty('createSecondaryWindow');
			expect(windowManager).toHaveProperty('getRegistry');
			expect(windowManager).toHaveProperty('saveAllWindowStates');
			expect(typeof windowManager.createWindow).toBe('function');
			expect(typeof windowManager.createSecondaryWindow).toBe('function');
			expect(typeof windowManager.getRegistry).toBe('function');
			expect(typeof windowManager.saveAllWindowStates).toBe('function');
		});
	});

	describe('createWindow', () => {
		it('should create BrowserWindow and return it', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const result = windowManager.createWindow();

			expect(result).toBeInstanceOf(MockBrowserWindow);
		});

		it('should create primary window on first call', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			const registry = windowManager.getRegistry();
			const primary = registry.getPrimary();
			expect(primary).toBeDefined();
			expect(primary?.isMain).toBe(true);
		});

		it('should restore window state from saved store data', async () => {
			// Set up saved window state
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'saved-window-id',
							x: 200,
							y: 200,
							width: 1400,
							height: 900,
							isMaximized: true,
							isFullScreen: false,
							sessionIds: ['session-1'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'saved-window-id' });

			expect(mockWindowInstance.maximize).toHaveBeenCalled();
		});

		it('should set fullscreen if saved state is fullscreen', async () => {
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'saved-window-id',
							x: 0,
							y: 0,
							width: 1920,
							height: 1080,
							isMaximized: false,
							isFullScreen: true,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'saved-window-id' });

			expect(mockWindowInstance.setFullScreen).toHaveBeenCalledWith(true);
			expect(mockWindowInstance.maximize).not.toHaveBeenCalled();
		});

		it('should load production file in production mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadFile).toHaveBeenCalledWith('/path/to/index.html');
			expect(mockWindowInstance.loadURL).not.toHaveBeenCalled();
		});

		it('should load dev server URL in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith('http://localhost:5173');
			expect(mockWindowInstance.loadFile).not.toHaveBeenCalled();
		});

		it('should initialize auto-updater in production mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			expect(mockInitAutoUpdater).toHaveBeenCalled();
		});

		it('should register stub handlers in development mode', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: true,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			expect(mockInitAutoUpdater).not.toHaveBeenCalled();
			// Should register stub handlers
			expect(mockHandle).toHaveBeenCalled();
		});

		it('should save window state on close', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			// Trigger close handler
			expect(windowCloseHandler).not.toBeNull();
			windowCloseHandler!();

			expect(mockMultiWindowStateStore.set).toHaveBeenCalled();
			const setCall = mockMultiWindowStateStore.set.mock.calls[0][0];
			expect(setCall).toHaveProperty('windows');
			expect(setCall).toHaveProperty('primaryWindowId');
			expect(setCall).toHaveProperty('version');
		});

		it('should accept optional windowId and sessionIds parameters', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({
				windowId: 'custom-window-id',
				sessionIds: ['session-1', 'session-2'],
				activeSessionId: 'session-1',
			});

			const registry = windowManager.getRegistry();
			const windowEntry = registry.get('custom-window-id');
			expect(windowEntry).toBeDefined();
			expect(windowEntry?.sessionIds).toEqual(['session-1', 'session-2']);
			expect(windowEntry?.activeSessionId).toBe('session-1');
		});

		it('should log window creation details', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Browser window created',
				'Window',
				expect.objectContaining({
					mode: 'production',
				})
			);
		});
	});

	describe('createSecondaryWindow', () => {
		it('should create a secondary window that is not main', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// First create primary window
			windowManager.createWindow();

			// Then create secondary window
			const result = windowManager.createSecondaryWindow(['session-3']);

			expect(result.browserWindow).toBeInstanceOf(MockBrowserWindow);
			expect(result.windowId).toBeDefined();

			const registry = windowManager.getRegistry();
			const secondaryEntry = registry.get(result.windowId);
			expect(secondaryEntry?.isMain).toBe(false);
			expect(secondaryEntry?.sessionIds).toEqual(['session-3']);
		});

		it('should accept custom bounds for secondary window', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// First create primary window
			windowManager.createWindow();

			// Then create secondary window with custom bounds
			const customBounds = { x: 500, y: 300, width: 1000, height: 700 };
			const result = windowManager.createSecondaryWindow([], customBounds);

			expect(result.windowId).toBeDefined();
		});

		it('should not initialize auto-updater for secondary windows', async () => {
			mockInitAutoUpdater.mockClear();

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// First create primary window (this will init auto-updater)
			windowManager.createWindow();
			const callCountAfterPrimary = mockInitAutoUpdater.mock.calls.length;

			// Then create secondary window
			windowManager.createSecondaryWindow();

			// Auto-updater should not have been called again
			expect(mockInitAutoUpdater.mock.calls.length).toBe(callCountAfterPrimary);
		});

		it('should load same renderer entry point as primary window', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow();
			mockWindowInstance.loadFile.mockClear();

			windowManager.createSecondaryWindow();

			expect(mockWindowInstance.loadFile).toHaveBeenCalledWith('/path/to/index.html');
		});
	});

	describe('getRegistry', () => {
		it('should return the WindowRegistry instance', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');
			const { windowRegistry } = await import('../../../main/window-registry');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const registry = windowManager.getRegistry();
			expect(registry).toBe(windowRegistry);
		});
	});

	describe('saveAllWindowStates', () => {
		it('should save all window states to the store', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ sessionIds: ['session-1'] });
			windowManager.createSecondaryWindow(['session-2']);

			mockMultiWindowStateStore.set.mockClear();
			windowManager.saveAllWindowStates();

			expect(mockMultiWindowStateStore.set).toHaveBeenCalledTimes(1);
			const setCall = mockMultiWindowStateStore.set.mock.calls[0][0];
			expect(setCall.windows).toHaveLength(2);
		});
	});

	describe('bounds validation', () => {
		it('should reposition window if bounds are off-screen', async () => {
			// Configure screen to return a display that doesn't include the saved bounds
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
			]);

			// Set up saved window state with off-screen bounds
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'off-screen-window',
							x: 5000, // Off-screen
							y: 5000, // Off-screen
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'off-screen-window' });

			// Should log warning about repositioning
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Window bounds off-screen, repositioning to primary display',
				'Window',
				expect.objectContaining({
					original: { x: 5000, y: 5000 },
				})
			);
		});
	});

	describe('multi-display support', () => {
		it('should restore window to saved display when display still exists', async () => {
			// Configure multiple displays - primary and secondary
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
				{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, id: 2 }, // Secondary monitor to the right
			]);

			// Set up saved window state on secondary display
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'secondary-display-window',
							x: 2100, // On secondary display (1920 + 180)
							y: 100,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 2, // Saved on display 2
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'secondary-display-window' });

			// Should log successful restoration to saved display
			expect(mockLogger.debug).toHaveBeenCalledWith(
				'Window restored to saved display',
				'Window',
				expect.objectContaining({
					displayId: 2,
				})
			);
		});

		it('should handle missing display gracefully by moving to primary display', async () => {
			// Configure only primary display (secondary was disconnected)
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
			]);

			// Set up saved window state referencing a display that no longer exists
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'orphaned-window',
							x: 2100, // Position that was on the now-disconnected display
							y: 100,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 2, // This display no longer exists
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'orphaned-window' });

			// Should log that saved display is no longer available
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Saved display no longer available, finding alternative',
				'Window',
				expect.objectContaining({
					savedDisplayId: 2,
					availableDisplayIds: [1],
				})
			);

			// Should also warn about off-screen repositioning (since x: 2100 is off the only display)
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Window bounds off-screen, repositioning to primary display',
				'Window',
				expect.objectContaining({
					original: { x: 2100, y: 100 },
					savedDisplayId: 2,
				})
			);
		});

		it('should reposition window within display when position is invalid but display exists', async () => {
			// Configure two displays
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
				{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, id: 2 },
			]);

			// Set up saved window state where position is outside the saved display's bounds
			// (e.g., display arrangement changed but display still exists)
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'moved-display-window',
							x: 100, // This position is now on display 1, not display 2
							y: 100,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 2, // Saved as being on display 2
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'moved-display-window' });

			// Should log repositioning within the saved display
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Window position invalid on saved display, repositioning within display',
				'Window',
				expect.objectContaining({
					displayId: 2,
					savedBounds: { x: 100, y: 100 },
				})
			);
		});

		it('should save display ID when persisting window state', async () => {
			// Configure screen with mock display
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
			]);
			mockScreen.getDisplayNearestPoint = vi.fn().mockReturnValue({
				id: 1,
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ sessionIds: ['session-1'] });

			mockMultiWindowStateStore.set.mockClear();
			windowManager.saveAllWindowStates();

			expect(mockMultiWindowStateStore.set).toHaveBeenCalledTimes(1);
			const setCall = mockMultiWindowStateStore.set.mock.calls[0][0];
			expect(setCall.windows[0]).toHaveProperty('displayId', 1);
		});

		it('should handle window movement between displays on save', async () => {
			// Configure two displays
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
				{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, id: 2 },
			]);

			// Window is now on display 2 (moved from original position)
			mockWindowInstance.getBounds.mockReturnValue({ x: 2000, y: 200, width: 1200, height: 800 });
			mockScreen.getDisplayNearestPoint = vi.fn().mockReturnValue({
				id: 2,
				bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ sessionIds: ['session-1'] });

			mockMultiWindowStateStore.set.mockClear();
			windowManager.saveAllWindowStates();

			const setCall = mockMultiWindowStateStore.set.mock.calls[0][0];
			// Should save the current display ID (2), not the original
			expect(setCall.windows[0].displayId).toBe(2);
		});

		it('should handle multiple windows on different displays', async () => {
			// Configure two displays
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
				{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, id: 2 },
			]);

			// Set up saved state with windows on different displays
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'primary-window',
							x: 100,
							y: 100,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 1, // On primary display
						},
						{
							id: 'secondary-window',
							x: 2100,
							y: 200,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-2'],
							activeSessionId: 'session-2',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 2, // On secondary display
						},
					];
				}
				if (key === 'primaryWindowId') return 'primary-window';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const result = windowManager.restoreWindows(['session-1', 'session-2']);

			expect(result.wasRestored).toBe(true);
			expect(result.restoredWindowIds).toHaveLength(2);
			expect(result.restoredWindowIds).toContain('primary-window');
			expect(result.restoredWindowIds).toContain('secondary-window');

			// Both windows should be restored successfully
			const registry = windowManager.getRegistry();
			expect(registry.get('primary-window')).toBeDefined();
			expect(registry.get('secondary-window')).toBeDefined();
		});

		it('should log display ID in window creation info', async () => {
			mockScreen.getAllDisplays.mockReturnValue([
				{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 },
			]);

			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'test-window',
							x: 100,
							y: 100,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
							displayId: 1,
						},
					];
				}
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			windowManager.createWindow({ windowId: 'test-window' });

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Browser window created',
				'Window',
				expect.objectContaining({
					windowId: 'test-window',
					savedDisplayId: 1,
				})
			);
		});
	});

	describe('restoreWindows', () => {
		it('should create fresh primary window when no saved state exists', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const result = windowManager.restoreWindows(['session-1', 'session-2']);

			expect(result.primaryWindow).toBeInstanceOf(MockBrowserWindow);
			expect(result.wasRestored).toBe(false);
			expect(result.restoredWindowIds).toHaveLength(1);
		});

		it('should restore primary window with validated sessions', async () => {
			// Set up saved window state with sessions
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'primary-window',
							x: 100,
							y: 100,
							width: 1400,
							height: 900,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1', 'session-2', 'session-3'],
							activeSessionId: 'session-2',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'primaryWindowId') return 'primary-window';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// Only session-1 and session-3 exist (session-2 was deleted)
			const result = windowManager.restoreWindows(['session-1', 'session-3']);

			expect(result.wasRestored).toBe(true);
			expect(result.restoredWindowIds).toContain('primary-window');

			const registry = windowManager.getRegistry();
			const primaryEntry = registry.get('primary-window');
			expect(primaryEntry).toBeDefined();
			// Should filter out deleted session-2
			expect(primaryEntry?.sessionIds).toEqual(['session-1', 'session-3']);
			// Active session should fall back to first valid session since session-2 was deleted
			expect(primaryEntry?.activeSessionId).toBe('session-1');
		});

		it('should restore multiple windows with session validation', async () => {
			// Set up saved window state with primary and secondary windows
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'primary-window',
							x: 100,
							y: 100,
							width: 1400,
							height: 900,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
						{
							id: 'secondary-window',
							x: 200,
							y: 200,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-2', 'session-3'],
							activeSessionId: 'session-2',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'primaryWindowId') return 'primary-window';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const result = windowManager.restoreWindows(['session-1', 'session-2', 'session-3']);

			expect(result.wasRestored).toBe(true);
			expect(result.restoredWindowIds).toHaveLength(2);
			expect(result.restoredWindowIds).toContain('primary-window');
			expect(result.restoredWindowIds).toContain('secondary-window');
		});

		it('should skip secondary windows with no valid sessions', async () => {
			// Set up saved window state where secondary window has only deleted sessions
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'primary-window',
							x: 100,
							y: 100,
							width: 1400,
							height: 900,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
						{
							id: 'secondary-window',
							x: 200,
							y: 200,
							width: 1200,
							height: 800,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['deleted-session-1', 'deleted-session-2'],
							activeSessionId: 'deleted-session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'primaryWindowId') return 'primary-window';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// Only session-1 exists (secondary window sessions were deleted)
			const result = windowManager.restoreWindows(['session-1']);

			expect(result.wasRestored).toBe(true);
			// Should only restore primary window since secondary has no valid sessions
			expect(result.restoredWindowIds).toHaveLength(1);
			expect(result.restoredWindowIds).toContain('primary-window');

			// Should log that secondary window was skipped
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Skipping restoration of window secondary-window - no valid sessions',
				'Window'
			);
		});

		it('should create fresh primary if saved primary window ID not found', async () => {
			// Set up saved state where primaryWindowId points to non-existent window
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'some-window',
							x: 100,
							y: 100,
							width: 1400,
							height: 900,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'primaryWindowId') return 'non-existent-primary';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			const result = windowManager.restoreWindows(['session-1']);

			expect(result.wasRestored).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Saved primary window not found in saved state, creating fresh primary window',
				'Window'
			);
		});

		it('should handle empty existingSessionIds gracefully', async () => {
			// Set up saved window state with sessions
			mockMultiWindowStateStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'windows') {
					return [
						{
							id: 'primary-window',
							x: 100,
							y: 100,
							width: 1400,
							height: 900,
							isMaximized: false,
							isFullScreen: false,
							sessionIds: ['session-1', 'session-2'],
							activeSessionId: 'session-1',
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						},
					];
				}
				if (key === 'primaryWindowId') return 'primary-window';
				if (key === 'version') return 1;
				return defaultValue;
			});

			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				multiWindowStateStore: mockMultiWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['multiWindowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererPath: '/path/to/index.html',
				devServerUrl: 'http://localhost:5173',
			});

			// No existing sessions - all saved sessions were deleted
			const result = windowManager.restoreWindows([]);

			expect(result.wasRestored).toBe(true);
			const registry = windowManager.getRegistry();
			const primaryEntry = registry.get('primary-window');
			// Primary window should still be created but with empty session list
			expect(primaryEntry?.sessionIds).toEqual([]);
			expect(primaryEntry?.activeSessionId).toBeUndefined();
		});
	});
});
