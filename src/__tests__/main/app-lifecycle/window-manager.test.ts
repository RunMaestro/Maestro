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
	isMaximized: vi.fn().mockReturnValue(false),
	isFullScreen: vi.fn().mockReturnValue(false),
	getBounds: vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 }),
	webContents: mockWebContents,
	on: vi.fn((event: string, handler: () => void) => {
		if (event === 'close') windowCloseHandler = handler;
	}),
};

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

	constructor(_options: unknown) {
		// Constructor accepts options but we don't need them for the mock
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
		windowCloseHandler = null;

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
	});
});
