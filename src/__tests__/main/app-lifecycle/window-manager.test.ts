/**
 * Tests for window manager factory.
 *
 * Tests cover:
 * - Factory creates window manager with createWindow method
 * - Window creation uses saved state from store
 * - Window saves state on close
 * - DevTools and auto-updater initialization based on environment
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
// Type-only import (erased at runtime, so it does not interfere with the
// per-test `vi.resetModules()` + dynamic `import()` pattern used below).
import type { WindowManagerDependencies } from '../../../main/app-lifecycle/window-manager';

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
	paste: vi.fn(),
};

// Per-partition panel session double for the plugin render-host branch.
// fromPartition returns ONE object per partition string (Electron semantics),
// so the will-attach hardening and the did-attach branch see the same session.
interface MockPanelSession {
	protocol: { handle: Mock };
	webRequest: { onBeforeRequest: Mock };
	setPermissionRequestHandler: Mock;
	setPermissionCheckHandler: Mock;
}
const mockPanelSessions = new Map<string, MockPanelSession>();
function makePanelSession(): MockPanelSession {
	return {
		protocol: { handle: vi.fn() },
		webRequest: { onBeforeRequest: vi.fn() },
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
	};
}
const mockFromPartition = vi.fn((partition: string) => {
	let ses = mockPanelSessions.get(partition);
	if (!ses) {
		ses = makePanelSession();
		mockPanelSessions.set(partition, ses);
	}
	return ses;
});

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
	isMinimized: vi.fn().mockReturnValue(false),
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
	isMinimized = mockWindowInstance.isMinimized;
	getBounds = mockWindowInstance.getBounds;
	webContents = mockWindowInstance.webContents;
	on = mockWindowInstance.on;

	constructor(options: unknown) {
		lastBrowserWindowOptions = options as Record<string, unknown>;
	}
}

// Mock ipcMain
const mockHandle = vi.fn();

// Mutable, faithful mock of Electron's `screen`. Tests mutate `mockScreen.displays`
// to simulate display-configuration changes (e.g. a removed monitor) and the
// matcher mirrors Electron's behavior: getDisplayMatching returns the display
// the rect most overlaps, falling back to the first (primary) display.
type MockWorkAreaRect = { x: number; y: number; width: number; height: number };
const { mockScreen } = vi.hoisted(() => {
	const DEFAULT_DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
	const state: { displays: Array<{ workArea: MockWorkAreaRect }> } = {
		displays: [DEFAULT_DISPLAY],
	};
	const intersectionArea = (a: MockWorkAreaRect, b: MockWorkAreaRect): number => {
		const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
		const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
		return ix * iy;
	};
	return {
		mockScreen: {
			state,
			reset: () => {
				state.displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
			},
			getAllDisplays: () => state.displays,
			getPrimaryDisplay: () => state.displays[0],
			getDisplayMatching: (rect: MockWorkAreaRect) => {
				let best = state.displays[0];
				let bestArea = -1;
				for (const display of state.displays) {
					const area = intersectionArea(rect, display.workArea);
					if (area > bestArea) {
						bestArea = area;
						best = display;
					}
				}
				return best;
			},
		},
	};
});

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
	ipcMain: {
		handle: (...args: unknown[]) => mockHandle(...args),
	},
	Menu: {
		buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
	},
	screen: {
		getAllDisplays: () => mockScreen.getAllDisplays(),
		getPrimaryDisplay: () => mockScreen.getPrimaryDisplay(),
		getDisplayMatching: (rect: MockWorkAreaRect) => mockScreen.getDisplayMatching(rect),
	},
	session: {
		fromPartition: (partition: string) => mockFromPartition(partition),
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

vi.mock('../../../main/maestro-cli-manager', () => ({
	resolveBundledCliPathSync: vi.fn(() => '/resolved/maestro-cli.js'),
}));

// Mock electron-devtools-installer (for development mode)
vi.mock('electron-devtools-installer', () => ({
	default: vi.fn().mockResolvedValue('React DevTools'),
	REACT_DEVELOPER_TOOLS: 'REACT_DEVELOPER_TOOLS',
}));

// Mock Sentry main so we can assert which renderer terminations get reported.
const { sentryCaptureMessageMock } = vi.hoisted(() => ({
	sentryCaptureMessageMock: vi.fn(),
}));
vi.mock('@sentry/electron/main', () => ({
	captureMessage: sentryCaptureMessageMock,
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
		// Fresh per-partition sessions so the render-host module's WeakSet marker
		// never bleeds between tests (a reused object would skip re-hardening).
		mockPanelSessions.clear();
		mockScreen.reset();

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
		mockWindowInstance.isMinimized.mockReturnValue(false);
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(lastBrowserWindowOptions?.webPreferences).toMatchObject({
				additionalArguments: ['--maestro-cli-path=/resolved/maestro-cli.js'],
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webviewTag: true,
			});
		});

		it('restores on-screen saved coordinates as-is', async () => {
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

			expect(lastBrowserWindowOptions?.x).toBe(50);
			expect(lastBrowserWindowOptions?.y).toBe(50);
		});

		it('restores the primary from passed bounds + sessionIds (multi-window restore)', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');
			const { WindowRegistry } = await import('../../../main/window-registry');
			const registry = new WindowRegistry();

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
				windowRegistry: registry,
			});

			// The saved primary's bounds win over the legacy store (50,50), and its
			// agents are registered so the renderer can scope its tab strips.
			windowManager.createWindow({
				sessionIds: ['agent-a', 'agent-b'],
				bounds: { x: 300, y: 400, width: 1280, height: 720 },
			});

			expect(lastBrowserWindowOptions?.x).toBe(300);
			expect(lastBrowserWindowOptions?.y).toBe(400);
			const primary = registry.getPrimary();
			expect(primary?.isMain).toBe(true);
			expect(primary?.sessionIds).toEqual(['agent-a', 'agent-b']);
		});

		it('repositions off-screen saved coordinates onto the primary display', async () => {
			// -32000,-32000 is what Windows reports for a minimized window. If it
			// ever lands in the store it must not be restored verbatim - the window
			// is brought back centered on the primary display instead.
			mockWindowStateStore.store = {
				x: -32000,
				y: -32000,
				width: 1000,
				height: 600,
				isMaximized: false,
				isFullScreen: false,
			};

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

			// Centered on the primary 1920x1080 work area for a 1000x600 window.
			expect(lastBrowserWindowOptions?.x).toBe(460);
			expect(lastBrowserWindowOptions?.y).toBe(240);
		});

		it('does not persist bounds while the window is minimized', async () => {
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

			mockWindowInstance.isMinimized.mockReturnValue(true);
			mockWindowInstance.getBounds.mockReturnValue({
				x: -32000,
				y: -32000,
				width: 1000,
				height: 600,
			});

			windowCloseHandler?.();

			const setKeys = mockWindowStateStore.set.mock.calls.map((call: unknown[]) => call[0]);
			expect(setKeys).not.toContain('x');
			expect(setKeys).not.toContain('y');
			expect(setKeys).not.toContain('width');
			expect(setKeys).not.toContain('height');
			expect(setKeys).toContain('isMaximized');
		});

		it('blocks unsafe webview attachments that use disallowed partitions or URLs', async () => {
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

		it('gates webview attachment on the two minted browser-tab partition schemes', async () => {
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

			const handler = webContentsEventHandlers.get('will-attach-webview');
			expect(handler).toBeTruthy();

			const cases: Array<{ name: string; partition: string; allowed: boolean }> = [
				{
					name: 'persistent browser-tab partition',
					partition: 'persist:maestro-browser-session-sess-1',
					allowed: true,
				},
				{
					name: 'ephemeral (incognito) partition',
					partition: 'maestro-ephemeral-sess-1-a1b2c3d4',
					allowed: true,
				},
				{ name: 'foreign persist partition', partition: 'persist:evil', allowed: false },
				{ name: 'ephemeral-lookalike prefix', partition: 'maestro-evil-sess-1', allowed: false },
				{
					// Correct `maestro-ephemeral-` prefix but missing the `-<random8>`
					// suffix: the old startsWith gate allowed this, the full regex must
					// now reject it so an attacker cannot attach with a lookalike prefix.
					name: 'ephemeral prefix without the random-8 suffix',
					partition: 'maestro-ephemeral-x',
					allowed: false,
				},
				{
					name: 'default session (empty partition)',
					partition: '',
					allowed: false,
				},
			];

			for (const c of cases) {
				const preventDefault = vi.fn();
				handler?.(
					{ preventDefault },
					{ partition: c.partition },
					{
						src: 'https://example.com/',
					}
				);
				if (c.allowed) {
					expect(preventDefault, c.name).not.toHaveBeenCalled();
				} else {
					expect(preventDefault, c.name).toHaveBeenCalled();
				}
			}
		});

		it('hardens attached browser-tab guests with popup and navigation restrictions', async () => {
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();
			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const navigateHandler = guestWebContentsEventHandlers.get('will-navigate');
			expect(navigateHandler).toBeTruthy();

			// `chrome:` is not in the allowlist (only http/https/file/about:blank are).
			const blockedEvent = { preventDefault: vi.fn() };
			navigateHandler?.(blockedEvent as any, 'chrome://settings');
			expect(blockedEvent.preventDefault).toHaveBeenCalled();

			const allowedEvent = { preventDefault: vi.fn() };
			navigateHandler?.(allowedEvent as any, 'http://localhost:7100/');
			expect(allowedEvent.preventDefault).not.toHaveBeenCalled();

			// `file:` is explicitly allowed so users can open locally-generated HTML
			// (Plotly dashboards, etc.) inside Maestro instead of the system browser.
			const allowedFileEvent = { preventDefault: vi.fn() };
			navigateHandler?.(allowedFileEvent as any, 'file:///tmp/dashboard.html');
			expect(allowedFileEvent.preventDefault).not.toHaveBeenCalled();
		});

		it('denies browser-tab guest popup requests in the main process', async () => {
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
			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const handler = mockGuestWebContents.setWindowOpenHandler.mock.calls[0][0];
			expect(handler({ url: 'https://popup.example.com' })).toEqual({ action: 'deny' });
		});
		it('attaches a plugin panel webview on its own partition with forced broker-only prefs', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/dist/main/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});
			windowManager.createWindow();

			const handler = webContentsEventHandlers.get('will-attach-webview');
			const preventDefault = vi.fn();
			const webPreferences: Record<string, unknown> = {
				partition: 'plugin:acme.tools',
				preload: '/tmp/renderer-supplied.js',
				nodeIntegration: true,
			};

			handler?.({ preventDefault } as any, webPreferences, {
				src: 'plugin-panel://panel/acme.tools%2Fboard',
			} as any);

			expect(preventDefault).not.toHaveBeenCalled();
			// Renderer-supplied prefs are overridden: broker-only preload, no Node,
			// isolation + sandbox on.
			expect(String(webPreferences.preload)).toMatch(/plugin-panel-preload\.js$/);
			expect(webPreferences.nodeIntegration).toBe(false);
			expect(webPreferences.contextIsolation).toBe(true);
			expect(webPreferences.sandbox).toBe(true);

			// The per-plugin session got its protocol + egress + permission lockdown.
			const ses = mockPanelSessions.get('plugin:acme.tools');
			expect(ses).toBeDefined();
			expect(ses!.protocol.handle).toHaveBeenCalledWith('plugin-panel', expect.any(Function));
			expect(ses!.webRequest.onBeforeRequest).toHaveBeenCalled();
			expect(ses!.setPermissionRequestHandler).toHaveBeenCalled();
			expect(ses!.setPermissionCheckHandler).toHaveBeenCalled();
		});

		it('blocks a plugin panel attachment whose document belongs to ANOTHER plugin', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/dist/main/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});
			windowManager.createWindow();

			const handler = webContentsEventHandlers.get('will-attach-webview');

			// Cross-plugin document reuse.
			const crossPlugin = vi.fn();
			handler?.({ preventDefault: crossPlugin } as any, { partition: 'plugin:acme.tools' }, {
				src: 'plugin-panel://panel/evil.corp%2Fboard',
			} as any);
			expect(crossPlugin).toHaveBeenCalled();

			// Arbitrary URL on a panel partition.
			const arbitraryUrl = vi.fn();
			handler?.({ preventDefault: arbitraryUrl } as any, { partition: 'plugin:acme.tools' }, {
				src: 'https://evil.example/',
			} as any);
			expect(arbitraryUrl).toHaveBeenCalled();
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it('locks down an attached plugin panel guest and skips ALL browser-tab conveniences', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');

			const windowManager = createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Parameters<
					typeof createWindowManager
				>[0]['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/dist/main/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});
			windowManager.createWindow();

			// Attach the partition first so the session is marked as panel-owned.
			const willAttach = webContentsEventHandlers.get('will-attach-webview');
			willAttach?.({ preventDefault: vi.fn() } as any, { partition: 'plugin:acme.tools' }, {
				src: 'plugin-panel://panel/acme.tools%2Fboard',
			} as any);

			const panelGuest = {
				...mockGuestWebContents,
				session: mockPanelSessions.get('plugin:acme.tools'),
				setWindowOpenHandler: vi.fn(),
				on: vi.fn((event: string, handler: (...args: any[]) => void) => {
					guestWebContentsEventHandlers.set(event, handler);
				}),
				executeJavaScript: vi.fn(),
			};

			const didAttach = webContentsEventHandlers.get('did-attach-webview');
			didAttach?.({} as any, panelGuest as any);

			// Panel lockdown: popups denied, every navigation prevented.
			const openHandler = panelGuest.setWindowOpenHandler.mock.calls[0][0];
			expect(openHandler({ url: 'https://popup.example/' })).toEqual({ action: 'deny' });

			const navigate = guestWebContentsEventHandlers.get('will-navigate');
			const navEvent = { preventDefault: vi.fn() };
			navigate?.(navEvent as any, 'plugin-panel://panel/acme.tools%2Fboard');
			expect(navEvent.preventDefault).toHaveBeenCalled();

			// None of the browser-tab machinery may touch plugin content: no
			// shortcut forwarding, no JS injection, no dom-ready hook.
			expect(guestWebContentsEventHandlers.has('before-input-event')).toBe(false);
			expect(guestWebContentsEventHandlers.has('dom-ready')).toBe(false);
			expect(panelGuest.executeJavaScript).not.toHaveBeenCalled();
			// will-redirect IS registered, but as the panel deny-all, which blocks
			// even URLs the browser-tab allowlist would pass.
			const redirect = guestWebContentsEventHandlers.get('will-redirect');
			const redirectEvent = { preventDefault: vi.fn() };
			redirect?.(redirectEvent as any, 'https://allowed-for-browser-tabs.example/');
			expect(redirectEvent.preventDefault).toHaveBeenCalled();
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockWindowInstance.setFullScreen).toHaveBeenCalledWith(true);
			expect(mockWindowInstance.maximize).not.toHaveBeenCalled();
		});

		it('should load production renderer via the app:// protocol in production mode', async () => {
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

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith('app://app/index.html');
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			expect(mockInitAutoUpdater).toHaveBeenCalled();
		});

		it('passes onBeforeQuitAndInstall to auto-updater that invokes confirmQuit', async () => {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');
			const confirmQuit = vi.fn();
			const getConfirmQuit = vi.fn(() => confirmQuit);

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
				getConfirmQuit,
			});

			windowManager.createWindow();

			// initAutoUpdater(window, options)
			expect(mockInitAutoUpdater).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ onBeforeQuitAndInstall: expect.any(Function) })
			);

			// Pull the option and confirm it routes to confirmQuit
			const options = mockInitAutoUpdater.mock.calls[0][1] as {
				onBeforeQuitAndInstall: () => void;
			};
			options.onBeforeQuitAndInstall();

			expect(getConfirmQuit).toHaveBeenCalled();
			expect(confirmQuit).toHaveBeenCalledTimes(1);
		});

		it('onBeforeQuitAndInstall is a no-op when quit handler is not yet wired', async () => {
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
				getConfirmQuit: () => null,
			});

			windowManager.createWindow();

			const options = mockInitAutoUpdater.mock.calls[0][1] as {
				onBeforeQuitAndInstall: () => void;
			};
			expect(() => options.onBeforeQuitAndInstall()).not.toThrow();
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
				rendererProductionUrl: 'app://app/index.html',
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

		it('should allow navigation to the renderer entry URL in production', async () => {
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

			// Should allow navigation to the renderer entry URL itself.
			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'app://app/index.html');
			expect(mockEvent.preventDefault).not.toHaveBeenCalled();
		});

		it('should block navigation outside the renderer origin in production', async () => {
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

			// Anything not on the app:// renderer origin must be blocked - file://
			// is now off-limits too because the renderer is served via app:// only.
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

			const mockEvent = { preventDefault: vi.fn() };
			navigateHandler(mockEvent, 'http://localhost:5173/');
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});

		it('should allow only the dev server entry document in development mode', async () => {
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

			// The dev guard now matches production: only the app's own entry document
			// (origin AND root pathname) may load top-level. The root URL is allowed
			// so HMR/full-reloads keep working.
			const rootEvent = { preventDefault: vi.fn() };
			navigateHandler(rootEvent, 'http://localhost:5173/');
			expect(rootEvent.preventDefault).not.toHaveBeenCalled();

			// Same-origin sub-paths are blocked - page content belongs in a <webview>
			// browser tab, never the top-level frame.
			const subPathEvent = { preventDefault: vi.fn() };
			navigateHandler(subPathEvent, 'http://localhost:5173/some/path');
			expect(subPathEvent.preventDefault).toHaveBeenCalled();
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
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
			});

			windowManager.createWindow();

			const willNavigateCalls = mockWebContents.on.mock.calls.filter(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			expect(willNavigateCalls).toHaveLength(1);

			// Drive the handler many times - behavior should be stable and the
			// allowed URL should still match exactly on every invocation.
			const navigateHandler = willNavigateCalls[0][1];
			for (let i = 0; i < 5; i++) {
				const allowed = { preventDefault: vi.fn() };
				navigateHandler(allowed, 'app://app/index.html');
				expect(allowed.preventDefault).not.toHaveBeenCalled();

				const blocked = { preventDefault: vi.fn() };
				navigateHandler(blocked, 'app://app/other.md');
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
				rendererProductionUrl: 'app://app/index.html',
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

			// Trigger dom-ready - should call executeJavaScript
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
				rendererProductionUrl: 'app://app/index.html',
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
				rendererProductionUrl: 'app://app/index.html',
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

			// Regular console message - should not forward
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
				rendererProductionUrl: 'app://app/index.html',
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

		it('pastes into browser-tab form fields via guest.paste() on Cmd/Ctrl+V (#1063)', async () => {
			// The permission handler denies `clipboard-read` to webviews, so
			// Chromium's native Cmd/Ctrl+V silently fails inside browser-tab form
			// fields. The before-input-event handler must intercept the paste chord
			// and drive the privileged guest.paste() instead.
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const beforeInputHandler = guestWebContentsEventHandlers.get('before-input-event');
			expect(beforeInputHandler).toBeDefined();

			// Cmd+V (macOS)
			const metaEvent = { preventDefault: vi.fn() };
			beforeInputHandler?.(metaEvent, {
				type: 'keyDown',
				key: 'v',
				code: 'KeyV',
				meta: true,
				control: false,
				alt: false,
				shift: false,
			});
			expect(metaEvent.preventDefault).toHaveBeenCalled();
			expect(mockGuestWebContents.paste).toHaveBeenCalledTimes(1);

			// Ctrl+V (Windows/Linux)
			const ctrlEvent = { preventDefault: vi.fn() };
			beforeInputHandler?.(ctrlEvent, {
				type: 'keyDown',
				key: 'v',
				code: 'KeyV',
				meta: false,
				control: true,
				alt: false,
				shift: false,
			});
			expect(ctrlEvent.preventDefault).toHaveBeenCalled();
			expect(mockGuestWebContents.paste).toHaveBeenCalledTimes(2);

			// The paste chord must NOT also be forwarded to the renderer as an app
			// shortcut - it is fully consumed here.
			expect(mockWebContents.send).not.toHaveBeenCalledWith(
				'browser-tab:shortcutKey',
				expect.objectContaining({ key: 'v' })
			);

			// The page-level fallback must also exclude V from its passthrough
			// list. Otherwise it can race the privileged paste path above.
			guestWebContentsEventHandlers.get('dom-ready')?.();
			const injectedScript = mockGuestWebContents.executeJavaScript.mock.calls.at(-1)?.[0];
			expect(injectedScript).toContain("'acxz'.indexOf(k)");
			expect(injectedScript).not.toContain("'acvxz'.indexOf(k)");
		});

		it('does not hijack non-paste edit chords or plain "v" on browser-tab guests', async () => {
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

			const attachHandler = webContentsEventHandlers.get('did-attach-webview');
			attachHandler?.({} as any, mockGuestWebContents as any);

			const beforeInputHandler = guestWebContentsEventHandlers.get('before-input-event');

			// Plain "v" (no modifier) is normal typing - must pass through untouched.
			const plainEvent = { preventDefault: vi.fn() };
			beforeInputHandler?.(plainEvent, {
				type: 'keyDown',
				key: 'v',
				code: 'KeyV',
				meta: false,
				control: false,
				alt: false,
				shift: false,
			});
			expect(plainEvent.preventDefault).not.toHaveBeenCalled();

			// Cmd+Shift+V (paste-and-match-style etc.) is not the plain paste chord.
			const shiftEvent = { preventDefault: vi.fn() };
			beforeInputHandler?.(shiftEvent, {
				type: 'keyDown',
				key: 'v',
				code: 'KeyV',
				meta: true,
				control: false,
				alt: false,
				shift: true,
			});

			// Cmd+Shift+V is not the plain paste chord, so the handler must NOT
			// drive the privileged paste path. It is also not a text-editing
			// passthrough, so it is consumed (preventDefault) and forwarded to the
			// renderer as an app shortcut rather than reaching the page.
			expect(mockGuestWebContents.paste).not.toHaveBeenCalled();
			expect(shiftEvent.preventDefault).toHaveBeenCalled();
			expect(mockWebContents.send).toHaveBeenCalledWith(
				'browser-tab:shortcutKey',
				expect.objectContaining({ key: 'v', shift: true })
			);
		});

		// Electron 41 removed the legacy `'crashed'` event in favor of
		// `'render-process-gone'`. These tests pin the wiring so a future
		// revert can't silently drop renderer-crash reporting.
		describe('webContents crash event wiring', () => {
			it('registers a render-process-gone listener', async () => {
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

				expect(webContentsEventHandlers.has('render-process-gone')).toBe(true);
			});

			it('does not register the deprecated crashed listener', async () => {
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

				expect(webContentsEventHandlers.has('crashed')).toBe(false);
			});

			async function fireRenderProcessGone(reason: string, exitCode: number) {
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
				const handler = webContentsEventHandlers.get('render-process-gone');
				handler?.({}, { reason, exitCode });
			}

			// MAESTRO-4X/4Y: intentional terminations (signal-killed / clean exit)
			// must not be reported as fatal crashes - that buries real crashes.
			it('does not report Sentry for an intentionally killed renderer (MAESTRO-4X)', async () => {
				await fireRenderProcessGone('killed', 15);
				await Promise.resolve();
				expect(sentryCaptureMessageMock).not.toHaveBeenCalled();
			});

			it('does not report Sentry for a clean-exit renderer', async () => {
				await fireRenderProcessGone('clean-exit', 0);
				await Promise.resolve();
				expect(sentryCaptureMessageMock).not.toHaveBeenCalled();
			});

			it('reports Sentry for a genuine renderer crash', async () => {
				await fireRenderProcessGone('crashed', 139);
				await vi.waitFor(() =>
					expect(sentryCaptureMessageMock).toHaveBeenCalledWith(
						'Renderer process gone: crashed',
						expect.objectContaining({ level: 'fatal' })
					)
				);
			});
		});
	});

	// Registry-backed creation (multi-window). The primary registers as isMain
	// and keeps its bare renderer URL ("exactly as before"); secondary windows
	// self-identify via a ?windowId= query and are tracked in the registry.
	describe('registry-backed creation', () => {
		type Deps = WindowManagerDependencies;

		function makeRegistry() {
			return {
				create: vi.fn(),
				remove: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn(() => []),
				getPrimary: vi.fn(),
				reclaimSessionsToPrimary: vi.fn(),
			};
		}

		/** A fake primary window whose webContents records `remote:notifyToast` sends. */
		function makePrimaryWithSend() {
			const send = vi.fn();
			const browserWindow = {
				isDestroyed: () => false,
				webContents: { isDestroyed: () => false, send },
			};
			return { send, browserWindow };
		}

		async function makeManager(overrides: Partial<Deps> = {}) {
			const { createWindowManager } = await import('../../../main/app-lifecycle/window-manager');
			return createWindowManager({
				windowStateStore: mockWindowStateStore as unknown as Deps['windowStateStore'],
				isDevelopment: false,
				preloadPath: '/path/to/preload.js',
				rendererProductionUrl: 'app://app/index.html',
				devServerUrl: 'http://localhost:5173',
				useNativeTitleBar: false,
				autoHideMenuBar: false,
				...overrides,
			});
		}

		/** The most recently registered 'closed' handler on the created window. */
		function lastClosedHandler(): (() => void) | undefined {
			return mockWindowInstance.on.mock.calls
				.filter((call: unknown[]) => call[0] === 'closed')
				.at(-1)?.[1] as (() => void) | undefined;
		}

		it('exposes createSecondaryWindow on the window manager', async () => {
			const windowManager = await makeManager();
			expect(typeof windowManager.createSecondaryWindow).toBe('function');
		});

		it('registers the primary window as isMain when a registry is provided', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createWindow();

			expect(registry.create).toHaveBeenCalledTimes(1);
			expect(registry.create).toHaveBeenCalledWith(
				expect.objectContaining({ isMain: true, sessionIds: [] })
			);
		});

		it('keeps the primary renderer URL free of a windowId query (exactly as before)', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createWindow();

			expect(mockWindowInstance.loadURL).toHaveBeenCalledWith('app://app/index.html');
		});

		it('works without a registry (primary is simply not tracked)', async () => {
			const windowManager = await makeManager();
			expect(() => windowManager.createWindow()).not.toThrow();
		});

		it('appends ?windowId= to a secondary renderer URL and registers it (isMain:false)', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1', 'agent-2']);

			const loadedUrl = mockWindowInstance.loadURL.mock.calls.at(-1)?.[0] as string;
			expect(loadedUrl).toMatch(/^app:\/\/app\/index\.html\?windowId=.+/);

			expect(registry.create).toHaveBeenCalledTimes(1);
			const createArg = registry.create.mock.calls[0][0] as {
				windowId: string;
				isMain: boolean;
				sessionIds: string[];
			};
			expect(createArg).toMatchObject({ isMain: false, sessionIds: ['agent-1', 'agent-2'] });
			// The id in the URL is exactly the id tracked in the registry.
			expect(loadedUrl).toContain(`windowId=${createArg.windowId}`);
		});

		it('off-screen guards a secondary window the same as the primary', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			// -32000 is the Windows minimized-window sentinel; it must be repositioned
			// so the secondary window can never spawn off every visible display.
			windowManager.createSecondaryWindow(['agent-1'], { x: -32000, y: -32000 });

			// Centered on the primary 1920x1080 work area for the default 1400x900 size.
			expect(lastBrowserWindowOptions?.x).toBe(260);
			expect(lastBrowserWindowOptions?.y).toBe(90);
		});

		it('restores a secondary window onto its still-connected secondary display', async () => {
			// End-to-end "remember which display": a window saved on a still-present
			// second monitor must spawn back on that monitor (coords kept), not be
			// yanked to the primary. Two side-by-side 1920x1080 displays.
			mockScreen.state.displays = [
				{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
				{ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
			];
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1'], {
				x: 2000,
				y: 100,
				width: 800,
				height: 600,
			});

			expect(lastBrowserWindowOptions?.x).toBe(2000);
			expect(lastBrowserWindowOptions?.y).toBe(100);
		});

		it('falls back the primary window to the primary display when its saved monitor is gone', async () => {
			// The primary restore path (createWindow with saved bounds, used by
			// restoreWindows) must honor the same off-screen guard: a monitor that has
			// since been unplugged repositions the window onto the primary display.
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			// Only the primary display exists (beforeEach reset); these bounds name a
			// now-removed monitor to the right.
			windowManager.createWindow({ bounds: { x: 2000, y: 100, width: 800, height: 600 } });

			// Centered on the primary 1920x1080 work area for an 800x600 window.
			expect(lastBrowserWindowOptions?.x).toBe(560);
			expect(lastBrowserWindowOptions?.y).toBe(240);
		});

		it('allows reloading a secondary window to its own windowId URL, blocks others', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1']);
			const loadedUrl = mockWindowInstance.loadURL.mock.calls.at(-1)?.[0] as string;

			const willNavigateCall = mockWebContents.on.mock.calls.find(
				(call: unknown[]) => call[0] === 'will-navigate'
			);
			const navigateHandler = willNavigateCall![1];

			// The window's own entry URL (with ?windowId=) is allowed so a
			// programmatic reload to the same URL is not blocked.
			const allowed = { preventDefault: vi.fn() };
			navigateHandler(allowed, loadedUrl);
			expect(allowed.preventDefault).not.toHaveBeenCalled();

			// The bare entry URL (a different document for this window) is blocked.
			const blocked = { preventDefault: vi.fn() };
			navigateHandler(blocked, 'app://app/index.html');
			expect(blocked.preventDefault).toHaveBeenCalled();
		});

		it('removes a secondary window from the registry when it closes', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1']);
			const createArg = registry.create.mock.calls[0][0] as { windowId: string };

			const closedHandler = lastClosedHandler();
			expect(closedHandler).toBeDefined();
			closedHandler!();

			expect(registry.remove).toHaveBeenCalledWith(createArg.windowId);
		});

		it('skips secondary-window registry cleanup on close while the app is quitting', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
				getIsQuitting: () => true,
			});

			windowManager.createSecondaryWindow(['agent-1']);
			lastClosedHandler()?.();

			expect(registry.remove).not.toHaveBeenCalled();
			// No ownership reclaim either - the registry dies with the process.
			expect(registry.reclaimSessionsToPrimary).not.toHaveBeenCalled();
		});

		it('reclaims a closing secondary window agents into the primary BEFORE removing it', async () => {
			const registry = makeRegistry();
			registry.reclaimSessionsToPrimary.mockReturnValue({
				movedSessionIds: ['agent-1'],
				primaryWindowId: 'main',
			});
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1']);
			const createArg = registry.create.mock.calls[0][0] as { windowId: string };

			lastClosedHandler()?.();

			// Reclaim runs against the still-registered window, THEN it is removed -
			// so no agent is ever orphaned.
			expect(registry.reclaimSessionsToPrimary).toHaveBeenCalledWith(createArg.windowId);
			expect(registry.remove).toHaveBeenCalledWith(createArg.windowId);
			const reclaimOrder = registry.reclaimSessionsToPrimary.mock.invocationCallOrder[0];
			const removeOrder = registry.remove.mock.invocationCallOrder[0];
			expect(reclaimOrder).toBeLessThan(removeOrder);
		});

		it('toasts the primary window when a closing secondary window had agents reclaimed', async () => {
			const registry = makeRegistry();
			const primary = makePrimaryWithSend();
			registry.reclaimSessionsToPrimary.mockReturnValue({
				movedSessionIds: ['agent-1', 'agent-2'],
				primaryWindowId: 'main',
			});
			registry.getPrimary.mockReturnValue(primary as never);
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1', 'agent-2']);
			lastClosedHandler()?.();

			expect(primary.send).toHaveBeenCalledWith(
				'remote:notifyToast',
				expect.objectContaining({ message: '2 agents moved to main window' })
			);
		});

		it('uses the singular noun when exactly one agent is reclaimed', async () => {
			const registry = makeRegistry();
			const primary = makePrimaryWithSend();
			registry.reclaimSessionsToPrimary.mockReturnValue({
				movedSessionIds: ['agent-1'],
				primaryWindowId: 'main',
			});
			registry.getPrimary.mockReturnValue(primary as never);
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1']);
			lastClosedHandler()?.();

			expect(primary.send).toHaveBeenCalledWith(
				'remote:notifyToast',
				expect.objectContaining({ message: '1 agent moved to main window' })
			);
		});

		it('does not toast when the closing secondary window owned no agents', async () => {
			const registry = makeRegistry();
			const primary = makePrimaryWithSend();
			registry.reclaimSessionsToPrimary.mockReturnValue({
				movedSessionIds: [],
				primaryWindowId: 'main',
			});
			registry.getPrimary.mockReturnValue(primary as never);
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow([]);
			lastClosedHandler()?.();

			// The window is still removed, but there is nothing to announce.
			expect(registry.remove).toHaveBeenCalled();
			expect(primary.send).not.toHaveBeenCalled();
		});

		it('does not initialize the auto-updater for secondary windows', async () => {
			const registry = makeRegistry();
			const windowManager = await makeManager({
				windowRegistry: registry as unknown as Deps['windowRegistry'],
			});

			windowManager.createSecondaryWindow(['agent-1']);

			expect(mockInitAutoUpdater).not.toHaveBeenCalled();
		});
	});

	// Display-configuration handling: saved bounds are validated against the
	// current displays (via screen.getDisplayMatching) and an off-screen window
	// (removed monitor / minimized sentinel) is repositioned onto the primary.
	describe('resolveVisibleWindowPosition', () => {
		it('returns undefined x/y when no position was saved (Electron places it)', async () => {
			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			expect(resolveVisibleWindowPosition({ width: 800, height: 600 })).toEqual({});
		});

		it('keeps on-screen saved coordinates as-is', async () => {
			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			expect(resolveVisibleWindowPosition({ x: 100, y: 100, width: 800, height: 600 })).toEqual({
				x: 100,
				y: 100,
			});
		});

		it('keeps coordinates on a secondary monitor that is still connected', async () => {
			// Two side-by-side 1920x1080 monitors; the window lives on the right one.
			mockScreen.state.displays = [
				{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
				{ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
			];

			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			expect(resolveVisibleWindowPosition({ x: 2000, y: 100, width: 800, height: 600 })).toEqual({
				x: 2000,
				y: 100,
			});
		});

		it('keeps coordinates on a monitor positioned to the left of primary (negative origin)', async () => {
			// A monitor placed to the LEFT of the primary has a negative origin, so a
			// window living on it is saved with negative x. This is the common
			// real-world layout the positive-x case above does not exercise.
			mockScreen.state.displays = [
				{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
				{ workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
			];

			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			expect(resolveVisibleWindowPosition({ x: -1800, y: 100, width: 800, height: 600 })).toEqual({
				x: -1800,
				y: 100,
			});
		});

		it('repositions onto the primary display when the saved monitor was removed', async () => {
			// Only the primary remains; the window was saved on a now-unplugged
			// monitor to the right (x:2000), so getDisplayMatching falls back to the
			// primary and the reachability check fails.
			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			// Centered on the primary 1920x1080 work area for an 800x600 window.
			expect(resolveVisibleWindowPosition({ x: 2000, y: 100, width: 800, height: 600 })).toEqual({
				x: 560,
				y: 240,
			});
		});

		it('repositions the Windows minimized sentinel (-32000) onto the primary', async () => {
			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			expect(
				resolveVisibleWindowPosition({ x: -32000, y: -32000, width: 1000, height: 600 })
			).toEqual({ x: 460, y: 240 });
		});

		it('repositions a window whose title bar sits below the work area bottom margin', async () => {
			const { resolveVisibleWindowPosition } =
				await import('../../../main/app-lifecycle/window-position');

			// y:1050 puts the title bar (≈1066) past the 1000px reachable limit on a
			// 1080-tall work area, so the title bar can't be grabbed - reposition it.
			expect(resolveVisibleWindowPosition({ x: 100, y: 1050, width: 800, height: 600 })).toEqual({
				x: 560,
				y: 240,
			});
		});
	});
});
