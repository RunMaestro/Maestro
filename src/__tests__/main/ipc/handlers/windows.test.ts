/**
 * Tests for Windows IPC Handlers.
 *
 * Tests cover:
 * - windows:create - Creating new windows
 * - windows:close - Closing windows (with primary protection)
 * - windows:list - Listing all windows
 * - windows:getForSession - Finding window for a session
 * - windows:moveSession - Moving sessions between windows
 * - windows:focusWindow - Focusing windows
 * - windows:getState - Getting window state
 * - windows:getWindowId - Getting calling window's ID
 * - windows:setSessionsForWindow - Setting sessions for a window
 * - windows:setActiveSession - Setting active session
 * - windows:getWindowBounds - Getting window screen bounds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import type { CreateWindowResult } from '../../../../main/window-registry';

// Mock logger
const mockLogger = {
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
};

vi.mock('../../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

// Mock electron
vi.mock('electron', () => {
	const handlers = new Map<string, Function>();
	return {
		ipcMain: {
			handle: vi.fn((channel: string, handler: Function) => {
				handlers.set(channel, handler);
			}),
			// Helper for tests to invoke handlers
			_getHandler: (channel: string) => handlers.get(channel),
			_clearHandlers: () => handlers.clear(),
		},
		BrowserWindow: {
			fromWebContents: vi.fn(),
		},
	};
});

// Mock multi-window store for panel state tests
const mockMultiWindowStoreData: { windows: any[]; primaryWindowId: string; version: number } = {
	windows: [],
	primaryWindowId: '',
	version: 1,
};

vi.mock('../../../../main/stores/getters', () => ({
	getMultiWindowStateStore: vi.fn(() => ({
		get: vi.fn((key: string, defaultValue: any) => {
			if (key === 'windows') return mockMultiWindowStoreData.windows;
			return defaultValue;
		}),
		set: vi.fn((key: string, value: any) => {
			if (key === 'windows') mockMultiWindowStoreData.windows = value;
		}),
	})),
}));

// Track window registry state
let mockRegistryState: Map<
	string,
	{
		browserWindow: any;
		sessionIds: string[];
		isMain: boolean;
		activeSessionId?: string;
	}
>;
let mockPrimaryWindowId: string | null = null;

// Mock window registry
vi.mock('../../../../main/window-registry', () => ({
	windowRegistry: {
		get: vi.fn((windowId: string) => mockRegistryState.get(windowId)),
		getAll: vi.fn(() => Array.from(mockRegistryState.entries())),
		getPrimaryId: vi.fn(() => mockPrimaryWindowId),
		getWindowForSession: vi.fn((sessionId: string) => {
			for (const [windowId, entry] of mockRegistryState.entries()) {
				if (entry.sessionIds.includes(sessionId)) {
					return windowId;
				}
			}
			return undefined;
		}),
		moveSession: vi.fn((sessionId: string, fromWindowId: string, toWindowId: string) => {
			const toEntry = mockRegistryState.get(toWindowId);
			if (!toEntry) return false;

			if (fromWindowId) {
				const fromEntry = mockRegistryState.get(fromWindowId);
				if (fromEntry) {
					const index = fromEntry.sessionIds.indexOf(sessionId);
					if (index !== -1) {
						fromEntry.sessionIds.splice(index, 1);
						if (fromEntry.activeSessionId === sessionId) {
							fromEntry.activeSessionId = fromEntry.sessionIds[0];
						}
					}
				}
			}

			if (!toEntry.sessionIds.includes(sessionId)) {
				toEntry.sessionIds.push(sessionId);
				toEntry.activeSessionId = sessionId;
			}

			return true;
		}),
		setActiveSession: vi.fn((windowId: string, sessionId: string) => {
			const entry = mockRegistryState.get(windowId);
			if (!entry || !entry.sessionIds.includes(sessionId)) return false;
			entry.activeSessionId = sessionId;
			return true;
		}),
		setSessionsForWindow: vi.fn(
			(windowId: string, sessionIds: string[], activeSessionId?: string) => {
				const entry = mockRegistryState.get(windowId);
				if (!entry) return false;
				entry.sessionIds = sessionIds;
				if (activeSessionId !== undefined) {
					entry.activeSessionId = activeSessionId;
				}
				return true;
			}
		),
		getWindowIdForBrowserWindow: vi.fn((browserWindow: any) => {
			for (const [windowId, entry] of mockRegistryState.entries()) {
				if (entry.browserWindow === browserWindow) {
					return windowId;
				}
			}
			return undefined;
		}),
	},
}));

// Create mock BrowserWindow
function createMockBrowserWindow(options: { destroyed?: boolean; minimized?: boolean } = {}) {
	return {
		isDestroyed: vi.fn().mockReturnValue(options.destroyed ?? false),
		isMinimized: vi.fn().mockReturnValue(options.minimized ?? false),
		isMaximized: vi.fn().mockReturnValue(false),
		isFullScreen: vi.fn().mockReturnValue(false),
		getBounds: vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 }),
		close: vi.fn(),
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
		webContents: {
			send: vi.fn(),
		},
	};
}

describe('Windows IPC Handlers', () => {
	let mockCreateSecondaryWindow: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		(ipcMain as any)._clearHandlers();
		mockRegistryState = new Map();
		mockPrimaryWindowId = null;
		// Reset mock multi-window store data
		mockMultiWindowStoreData.windows = [];
		mockMultiWindowStoreData.primaryWindowId = '';
		mockMultiWindowStoreData.version = 1;

		// Create mock for createSecondaryWindow
		mockCreateSecondaryWindow = vi.fn().mockImplementation((sessionIds?: string[]) => {
			const windowId = 'new-window-' + Date.now();
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set(windowId, {
				browserWindow: mockWindow,
				sessionIds: sessionIds || [],
				isMain: false,
				activeSessionId: sessionIds?.[0],
			});
			return { windowId, browserWindow: mockWindow } as CreateWindowResult;
		});

		// Register handlers
		const { registerWindowsHandlers } = await import('../../../../main/ipc/handlers/windows');
		registerWindowsHandlers({
			createSecondaryWindow: mockCreateSecondaryWindow,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('windows:create', () => {
		it('should create a new window with default options', async () => {
			const handler = (ipcMain as any)._getHandler('windows:create');
			expect(handler).toBeDefined();

			const result = await handler({}, undefined);

			expect(mockCreateSecondaryWindow).toHaveBeenCalledWith(undefined, undefined);
			expect(result.windowId).toMatch(/^new-window-/);
		});

		it('should create a new window with sessionIds', async () => {
			const handler = (ipcMain as any)._getHandler('windows:create');

			const result = await handler(
				{},
				{
					sessionIds: ['session-1', 'session-2'],
				}
			);

			expect(mockCreateSecondaryWindow).toHaveBeenCalledWith(['session-1', 'session-2'], undefined);
			expect(result.windowId).toBeDefined();
		});

		it('should create a new window with bounds', async () => {
			const handler = (ipcMain as any)._getHandler('windows:create');

			const result = await handler(
				{},
				{
					bounds: { x: 200, y: 200, width: 1000, height: 700 },
				}
			);

			expect(mockCreateSecondaryWindow).toHaveBeenCalledWith(undefined, {
				x: 200,
				y: 200,
				width: 1000,
				height: 700,
			});
			expect(result.windowId).toBeDefined();
		});

		it('should handle creation errors', async () => {
			mockCreateSecondaryWindow.mockImplementation(() => {
				throw new Error('Window creation failed');
			});

			const handler = (ipcMain as any)._getHandler('windows:create');

			await expect(handler({}, {})).rejects.toThrow(
				'Failed to create window: Window creation failed'
			);
		});
	});

	describe('windows:close', () => {
		it('should close a non-primary window', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('secondary-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:close');
			const result = await handler({}, 'secondary-window');

			expect(result.success).toBe(true);
			expect(mockWindow.close).toHaveBeenCalled();
		});

		it('should prevent closing the primary window', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('primary-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: true,
			});
			mockPrimaryWindowId = 'primary-window';

			const handler = (ipcMain as any)._getHandler('windows:close');
			const result = await handler({}, 'primary-window');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Cannot close the primary window');
			expect(mockWindow.close).not.toHaveBeenCalled();
		});

		it('should return error for non-existent window', async () => {
			const handler = (ipcMain as any)._getHandler('windows:close');
			const result = await handler({}, 'non-existent');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window not found');
		});
	});

	describe('windows:list', () => {
		it('should return empty array when no windows', async () => {
			const handler = (ipcMain as any)._getHandler('windows:list');
			const result = await handler({});

			expect(result).toEqual([]);
		});

		it('should return all windows as WindowInfo objects', async () => {
			const mockWindow1 = createMockBrowserWindow();
			const mockWindow2 = createMockBrowserWindow();

			mockRegistryState.set('window-1', {
				browserWindow: mockWindow1,
				sessionIds: ['session-a'],
				isMain: true,
				activeSessionId: 'session-a',
			});
			mockRegistryState.set('window-2', {
				browserWindow: mockWindow2,
				sessionIds: ['session-b', 'session-c'],
				isMain: false,
				activeSessionId: 'session-b',
			});

			const handler = (ipcMain as any)._getHandler('windows:list');
			const result = await handler({});

			expect(result).toHaveLength(2);
			expect(result).toContainEqual({
				id: 'window-1',
				isMain: true,
				sessionIds: ['session-a'],
				activeSessionId: 'session-a',
			});
			expect(result).toContainEqual({
				id: 'window-2',
				isMain: false,
				sessionIds: ['session-b', 'session-c'],
				activeSessionId: 'session-b',
			});
		});
	});

	describe('windows:getForSession', () => {
		it('should return null when session not found', async () => {
			const handler = (ipcMain as any)._getHandler('windows:getForSession');
			const result = await handler({}, 'non-existent-session');

			expect(result).toBeNull();
		});

		it('should return window ID containing session', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: ['session-1', 'session-2'],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:getForSession');
			const result = await handler({}, 'session-1');

			expect(result).toBe('test-window');
		});
	});

	describe('windows:moveSession', () => {
		it('should move session between windows', async () => {
			const mockWindow1 = createMockBrowserWindow();
			const mockWindow2 = createMockBrowserWindow();

			mockRegistryState.set('source-window', {
				browserWindow: mockWindow1,
				sessionIds: ['session-1'],
				isMain: true,
				activeSessionId: 'session-1',
			});
			mockRegistryState.set('target-window', {
				browserWindow: mockWindow2,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:moveSession');
			const result = await handler(
				{},
				{
					sessionId: 'session-1',
					fromWindowId: 'source-window',
					toWindowId: 'target-window',
				}
			);

			expect(result.success).toBe(true);
		});

		it('should return error when target window not found', async () => {
			const handler = (ipcMain as any)._getHandler('windows:moveSession');
			const result = await handler(
				{},
				{
					sessionId: 'session-1',
					fromWindowId: 'source',
					toWindowId: 'non-existent',
				}
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Target window not found');
		});

		it('should return error when source window not found', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('target-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:moveSession');
			const result = await handler(
				{},
				{
					sessionId: 'session-1',
					fromWindowId: 'non-existent',
					toWindowId: 'target-window',
				}
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Source window not found');
		});

		it('should broadcast sessionMoved event to all windows on successful move', async () => {
			const mockWindow1 = createMockBrowserWindow();
			const mockWindow2 = createMockBrowserWindow();
			const mockWindow3 = createMockBrowserWindow(); // Third window to verify all get the event

			mockRegistryState.set('source-window', {
				browserWindow: mockWindow1,
				sessionIds: ['session-1'],
				isMain: true,
				activeSessionId: 'session-1',
			});
			mockRegistryState.set('target-window', {
				browserWindow: mockWindow2,
				sessionIds: [],
				isMain: false,
			});
			mockRegistryState.set('observer-window', {
				browserWindow: mockWindow3,
				sessionIds: ['session-2'],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:moveSession');
			const result = await handler(
				{},
				{
					sessionId: 'session-1',
					fromWindowId: 'source-window',
					toWindowId: 'target-window',
				}
			);

			expect(result.success).toBe(true);

			// All three windows should receive the sessionMoved event
			expect(mockWindow1.webContents.send).toHaveBeenCalledWith('windows:sessionMoved', {
				sessionId: 'session-1',
				fromWindowId: 'source-window',
				toWindowId: 'target-window',
			});
			expect(mockWindow2.webContents.send).toHaveBeenCalledWith('windows:sessionMoved', {
				sessionId: 'session-1',
				fromWindowId: 'source-window',
				toWindowId: 'target-window',
			});
			expect(mockWindow3.webContents.send).toHaveBeenCalledWith('windows:sessionMoved', {
				sessionId: 'session-1',
				fromWindowId: 'source-window',
				toWindowId: 'target-window',
			});
		});

		it('should not broadcast sessionMoved event on failed move', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('observer-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:moveSession');
			const result = await handler(
				{},
				{
					sessionId: 'session-1',
					fromWindowId: 'source',
					toWindowId: 'non-existent',
				}
			);

			expect(result.success).toBe(false);

			// No sessionMoved event should be sent on failure
			const sendCalls = mockWindow.webContents.send.mock.calls;
			const sessionMovedCalls = sendCalls.filter(
				(call: [string, unknown]) => call[0] === 'windows:sessionMoved'
			);
			expect(sessionMovedCalls.length).toBe(0);
		});
	});

	describe('windows:focusWindow', () => {
		it('should focus a window', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:focusWindow');
			const result = await handler({}, 'test-window');

			expect(result.success).toBe(true);
			expect(mockWindow.show).toHaveBeenCalled();
			expect(mockWindow.focus).toHaveBeenCalled();
		});

		it('should restore minimized window before focusing', async () => {
			const mockWindow = createMockBrowserWindow({ minimized: true });
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:focusWindow');
			const result = await handler({}, 'test-window');

			expect(result.success).toBe(true);
			expect(mockWindow.restore).toHaveBeenCalled();
			expect(mockWindow.show).toHaveBeenCalled();
			expect(mockWindow.focus).toHaveBeenCalled();
		});

		it('should return error for non-existent window', async () => {
			const handler = (ipcMain as any)._getHandler('windows:focusWindow');
			const result = await handler({}, 'non-existent');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window not found');
		});

		it('should return error for destroyed window', async () => {
			const mockWindow = createMockBrowserWindow({ destroyed: true });
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:focusWindow');
			const result = await handler({}, 'test-window');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window is destroyed');
		});
	});

	describe('windows:getState', () => {
		it('should return null when sender window not found', async () => {
			(BrowserWindow.fromWebContents as any).mockReturnValue(null);

			const handler = (ipcMain as any)._getHandler('windows:getState');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return window state', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: ['session-1'],
				isMain: true,
				activeSessionId: 'session-1',
			});

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('test-window');

			const handler = (ipcMain as any)._getHandler('windows:getState');
			const result = await handler({ sender: {} });

			expect(result).toMatchObject({
				id: 'test-window',
				x: 100,
				y: 100,
				width: 1200,
				height: 800,
				sessionIds: ['session-1'],
				activeSessionId: 'session-1',
			});
		});
	});

	describe('windows:getWindowId', () => {
		it('should return null when sender window not found', async () => {
			(BrowserWindow.fromWebContents as any).mockReturnValue(null);

			const handler = (ipcMain as any)._getHandler('windows:getWindowId');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return window ID for sender', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('test-window');

			const handler = (ipcMain as any)._getHandler('windows:getWindowId');
			const result = await handler({ sender: {} });

			expect(result).toBe('test-window');
		});
	});

	describe('windows:setSessionsForWindow', () => {
		it('should set sessions for window', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			const handler = (ipcMain as any)._getHandler('windows:setSessionsForWindow');
			const result = await handler({}, 'test-window', ['session-1', 'session-2'], 'session-1');

			expect(result.success).toBe(true);
		});

		it('should return error for non-existent window', async () => {
			const handler = (ipcMain as any)._getHandler('windows:setSessionsForWindow');
			const result = await handler({}, 'non-existent', ['session-1']);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window not found');
		});
	});

	describe('windows:setActiveSession', () => {
		it('should set active session', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: ['session-1', 'session-2'],
				isMain: false,
				activeSessionId: 'session-1',
			});

			const handler = (ipcMain as any)._getHandler('windows:setActiveSession');
			const result = await handler({}, 'test-window', 'session-2');

			expect(result.success).toBe(true);
		});

		it('should return error for non-existent window or invalid session', async () => {
			const handler = (ipcMain as any)._getHandler('windows:setActiveSession');
			const result = await handler({}, 'non-existent', 'session-1');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window not found or session not in window');
		});
	});

	describe('windows:getPanelState', () => {
		it('should return null when sender window not found', async () => {
			(BrowserWindow.fromWebContents as any).mockReturnValue(null);

			const handler = (ipcMain as any)._getHandler('windows:getPanelState');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return null when window not in registry', async () => {
			const mockWindow = createMockBrowserWindow();
			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue(undefined);

			const handler = (ipcMain as any)._getHandler('windows:getPanelState');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return panel state from multi-window store', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			// Add window state to mock store
			mockMultiWindowStoreData.windows = [
				{
					id: 'test-window',
					x: 100,
					y: 100,
					width: 1200,
					height: 800,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: [],
					leftPanelCollapsed: true,
					rightPanelCollapsed: false,
				},
			];

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('test-window');

			const handler = (ipcMain as any)._getHandler('windows:getPanelState');
			const result = await handler({ sender: {} });

			expect(result).toEqual({
				leftPanelCollapsed: true,
				rightPanelCollapsed: false,
			});
		});

		it('should return defaults when window not in store', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('new-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			// Empty store - no window state saved yet
			mockMultiWindowStoreData.windows = [];

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('new-window');

			const handler = (ipcMain as any)._getHandler('windows:getPanelState');
			const result = await handler({ sender: {} });

			expect(result).toEqual({
				leftPanelCollapsed: false,
				rightPanelCollapsed: false,
			});
		});
	});

	describe('windows:setPanelState', () => {
		it('should return error when sender window not found', async () => {
			(BrowserWindow.fromWebContents as any).mockReturnValue(null);

			const handler = (ipcMain as any)._getHandler('windows:setPanelState');
			const result = await handler({ sender: {} }, { leftPanelCollapsed: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Could not determine sender window');
		});

		it('should return error when window not in registry', async () => {
			const mockWindow = createMockBrowserWindow();
			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue(undefined);

			const handler = (ipcMain as any)._getHandler('windows:setPanelState');
			const result = await handler({ sender: {} }, { leftPanelCollapsed: true });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Window not found in registry');
		});

		it('should update existing window panel state in store', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			// Add existing window state
			mockMultiWindowStoreData.windows = [
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
				},
			];

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('test-window');

			const handler = (ipcMain as any)._getHandler('windows:setPanelState');
			const result = await handler({ sender: {} }, { leftPanelCollapsed: true });

			expect(result.success).toBe(true);
			expect(mockMultiWindowStoreData.windows[0].leftPanelCollapsed).toBe(true);
			expect(mockMultiWindowStoreData.windows[0].rightPanelCollapsed).toBe(false);
		});

		it('should update only right panel when only right panel provided', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('test-window', {
				browserWindow: mockWindow,
				sessionIds: [],
				isMain: false,
			});

			mockMultiWindowStoreData.windows = [
				{
					id: 'test-window',
					x: 100,
					y: 100,
					width: 1200,
					height: 800,
					isMaximized: false,
					isFullScreen: false,
					sessionIds: [],
					leftPanelCollapsed: true,
					rightPanelCollapsed: false,
				},
			];

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('test-window');

			const handler = (ipcMain as any)._getHandler('windows:setPanelState');
			const result = await handler({ sender: {} }, { rightPanelCollapsed: true });

			expect(result.success).toBe(true);
			expect(mockMultiWindowStoreData.windows[0].leftPanelCollapsed).toBe(true); // Unchanged
			expect(mockMultiWindowStoreData.windows[0].rightPanelCollapsed).toBe(true);
		});

		it('should create new window state entry when window not in store', async () => {
			const mockWindow = createMockBrowserWindow();
			mockRegistryState.set('new-window', {
				browserWindow: mockWindow,
				sessionIds: ['session-1'],
				isMain: false,
				activeSessionId: 'session-1',
			});

			// Empty store
			mockMultiWindowStoreData.windows = [];

			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);
			const { windowRegistry } = await import('../../../../main/window-registry');
			(windowRegistry.getWindowIdForBrowserWindow as any).mockReturnValue('new-window');
			(windowRegistry.get as any).mockReturnValue({
				browserWindow: mockWindow,
				sessionIds: ['session-1'],
				isMain: false,
				activeSessionId: 'session-1',
			});

			const handler = (ipcMain as any)._getHandler('windows:setPanelState');
			const result = await handler({ sender: {} }, { leftPanelCollapsed: true });

			expect(result.success).toBe(true);
			expect(mockMultiWindowStoreData.windows.length).toBe(1);
			expect(mockMultiWindowStoreData.windows[0].id).toBe('new-window');
			expect(mockMultiWindowStoreData.windows[0].leftPanelCollapsed).toBe(true);
			expect(mockMultiWindowStoreData.windows[0].rightPanelCollapsed).toBe(false);
			expect(mockMultiWindowStoreData.windows[0].sessionIds).toEqual(['session-1']);
		});
	});

	describe('windows:getWindowBounds', () => {
		it('should return null when sender window not found', async () => {
			(BrowserWindow.fromWebContents as any).mockReturnValue(null);

			const handler = (ipcMain as any)._getHandler('windows:getWindowBounds');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return null when window is destroyed', async () => {
			const mockWindow = createMockBrowserWindow({ destroyed: true });
			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);

			const handler = (ipcMain as any)._getHandler('windows:getWindowBounds');
			const result = await handler({ sender: {} });

			expect(result).toBeNull();
		});

		it('should return window bounds', async () => {
			const mockWindow = createMockBrowserWindow();
			mockWindow.getBounds.mockReturnValue({ x: 150, y: 250, width: 1400, height: 900 });
			(BrowserWindow.fromWebContents as any).mockReturnValue(mockWindow);

			const handler = (ipcMain as any)._getHandler('windows:getWindowBounds');
			const result = await handler({ sender: {} });

			expect(result).toEqual({
				x: 150,
				y: 250,
				width: 1400,
				height: 900,
			});
		});
	});
});
