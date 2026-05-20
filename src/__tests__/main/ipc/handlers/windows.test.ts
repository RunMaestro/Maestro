import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { registerWindowsHandlers } from '../../../../main/ipc/handlers/windows';
import { WindowRegistry } from '../../../../main/window-registry';
import type { WindowManager } from '../../../../main/app-lifecycle/window-manager';
import type { MultiWindowState } from '../../../../main/stores/types';

const mockState = vi.hoisted(() => {
	const registeredHandlers = new Map<string, Function>();
	const webContentsToWindow = new Map<object, any>();
	let nextBrowserWindowId = 1;

	class MockBrowserWindow {
		id: number;
		webContents = {
			send: vi.fn(),
			isDestroyed: vi.fn(() => false),
		};
		close = vi.fn();
		focus = vi.fn();
		show = vi.fn();
		restore = vi.fn();
		isDestroyed = vi.fn(() => false);
		isMinimized = vi.fn(() => false);
		isMaximized = vi.fn(() => false);
		isFullScreen = vi.fn(() => false);
		getBounds = vi.fn(() => ({ x: 10, y: 20, width: 1200, height: 800 }));

		constructor() {
			this.id = nextBrowserWindowId;
			nextBrowserWindowId += 1;
			webContentsToWindow.set(this.webContents, this);
		}

		static fromWebContents(webContents: object) {
			return webContentsToWindow.get(webContents) ?? null;
		}
	}

	return {
		registeredHandlers,
		webContentsToWindow,
		MockBrowserWindow,
		resetBrowserWindowIds: () => {
			nextBrowserWindowId = 1;
		},
	};
});

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			mockState.registeredHandlers.set(channel, handler);
		}),
	},
	BrowserWindow: mockState.MockBrowserWindow,
}));

function createWindowStateStore(state?: Partial<MultiWindowState>) {
	return {
		store: {
			primaryWindowId: 'primary',
			windows: [],
			...state,
		},
	};
}

function createTestWindowManager(): WindowManager {
	const windowRegistry = new WindowRegistry();

	return {
		windowRegistry,
		createWindow: (windowId?: string, sessionIds?: string[]) => {
			return windowRegistry.create({ id: windowId, sessionIds }).browserWindow;
		},
		createSecondaryWindow: (sessionIds, bounds = {}) => {
			return windowRegistry.create({ sessionIds, ...bounds, isMain: false }).browserWindow;
		},
	};
}

describe('windows IPC handlers', () => {
	let windowManager: WindowManager;
	let windowStateStore: ReturnType<typeof createWindowStateStore>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockState.registeredHandlers.clear();
		mockState.webContentsToWindow.clear();
		mockState.resetBrowserWindowIds();
		windowManager = createTestWindowManager();
		windowStateStore = createWindowStateStore();
		registerWindowsHandlers({
			windowManager,
			windowStateStore: windowStateStore as any,
		});
	});

	it('registers all window handlers', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:create', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:close', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:getForSession', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:moveSession', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:focusWindow', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:getWindowBounds', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:findWindowAtPoint', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:getState', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:updateState', expect.any(Function));
	});

	it('creates a secondary window with sessions and bounds', async () => {
		windowManager.createWindow('primary', ['session-1']);

		const handler = mockState.registeredHandlers.get('windows:create');
		const result = await handler!({}, ['session-2'], { x: 50, y: 60, width: 900, height: 700 });

		expect(result).toEqual({
			id: '2',
			isMain: false,
			sessionIds: ['session-2'],
			activeSessionId: 'session-2',
		});
		expect(windowManager.windowRegistry.getWindowForSession('session-2')).toBe('2');
	});

	it('creates a secondary window from the invoking window and updates source ownership', async () => {
		const primary = windowManager.createWindow('primary', ['session-1', 'session-2']);
		windowStateStore.store.windows = [{ id: 'primary', activeSessionId: 'session-1' } as any];

		const handler = mockState.registeredHandlers.get('windows:create');
		const result = await handler!({ sender: primary.webContents }, ['session-1'], {
			x: 500,
			y: 250,
		});

		expect(result).toEqual({
			id: '2',
			isMain: false,
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
		});
		expect(windowManager.windowRegistry.get('primary')?.sessionIds).toEqual(['session-2']);
		expect(windowStateStore.store.windows).toEqual([
			expect.objectContaining({
				id: 'primary',
				sessionIds: ['session-2'],
				activeSessionId: 'session-2',
			}),
			expect.objectContaining({
				id: '2',
				sessionIds: ['session-1'],
				activeSessionId: 'session-1',
				x: 10,
				y: 20,
			}),
		]);
	});

	it('prevents closing the primary window', async () => {
		const primary = windowManager.createWindow('primary', []);

		const handler = mockState.registeredHandlers.get('windows:close');
		const result = await handler!({}, 'primary');

		expect(result).toEqual({ closed: false, reason: 'primary-window' });
		expect(primary.close).not.toHaveBeenCalled();
	});

	it('closes secondary windows by id', async () => {
		windowManager.createWindow('primary', []);
		const secondary = windowManager.createSecondaryWindow(['session-1'], {});
		const secondaryId = windowManager.windowRegistry.getWindowId(secondary)!;

		const handler = mockState.registeredHandlers.get('windows:close');
		const result = await handler!({}, secondaryId);

		expect(result).toEqual({ closed: true });
		expect(secondary.close).toHaveBeenCalled();
	});

	it('lists registered windows with stored active session ids', async () => {
		windowManager.createWindow('primary', ['session-1']);
		windowManager.createSecondaryWindow(['session-2'], {});
		windowStateStore.store.windows = [{ id: 'primary', activeSessionId: 'session-1' } as any];

		const handler = mockState.registeredHandlers.get('windows:list');
		const result = await handler!({});

		expect(result).toEqual([
			{ id: 'primary', isMain: true, sessionIds: ['session-1'], activeSessionId: 'session-1' },
			{ id: '2', isMain: false, sessionIds: ['session-2'], activeSessionId: null },
		]);
	});

	it('moves sessions between windows and looks up session ownership', async () => {
		windowManager.createWindow('primary', ['session-1']);
		const secondary = windowManager.createSecondaryWindow([], {});
		windowStateStore.store.windows = [
			{ id: 'primary', activeSessionId: 'session-1' } as any,
			{ id: '2', activeSessionId: null } as any,
		];

		const moveHandler = mockState.registeredHandlers.get('windows:moveSession');
		await expect(moveHandler!({}, 'session-1', 'primary', '2')).resolves.toBe(true);

		const lookupHandler = mockState.registeredHandlers.get('windows:getForSession');
		await expect(lookupHandler!({}, 'session-1')).resolves.toBe('2');
		expect(secondary.webContents.send).toHaveBeenCalledWith('windows:sessionMoved', {
			sessionId: 'session-1',
			fromWindowId: 'primary',
			toWindowId: '2',
			windows: [
				{ id: 'primary', isMain: true, sessionIds: [], activeSessionId: null },
				{ id: '2', isMain: false, sessionIds: ['session-1'], activeSessionId: 'session-1' },
			],
		});
	});

	it('focuses existing windows', async () => {
		const primary = windowManager.createWindow('primary', []);

		const handler = mockState.registeredHandlers.get('windows:focusWindow');
		const result = await handler!({}, 'primary');

		expect(result).toBe(true);
		expect(primary.show).toHaveBeenCalled();
		expect(primary.focus).toHaveBeenCalled();
	});

	it('returns bounds for the invoking window', async () => {
		const primary = windowManager.createWindow('primary', ['session-1']);

		const handler = mockState.registeredHandlers.get('windows:getWindowBounds');
		const result = await handler!({ sender: primary.webContents });

		expect(BrowserWindow.fromWebContents(primary.webContents)).toBe(primary);
		expect(result).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
	});

	it('finds another registered window containing screen coordinates', async () => {
		const primary = windowManager.createWindow('primary', ['session-1']);
		const secondary = windowManager.createSecondaryWindow(['session-2'], {});
		primary.getBounds = vi.fn(() => ({ x: 0, y: 0, width: 500, height: 500 }));
		secondary.getBounds = vi.fn(() => ({ x: 600, y: 100, width: 500, height: 400 }));
		windowStateStore.store.windows = [{ id: '2', activeSessionId: 'session-2' } as any];

		const handler = mockState.registeredHandlers.get('windows:findWindowAtPoint');
		const result = await handler!({ sender: primary.webContents }, 650, 150);

		expect(result).toEqual({
			id: '2',
			isMain: false,
			sessionIds: ['session-2'],
			activeSessionId: 'session-2',
		});
	});

	it('returns null when screen coordinates do not hit another window', async () => {
		const primary = windowManager.createWindow('primary', ['session-1']);
		const secondary = windowManager.createSecondaryWindow(['session-2'], {});
		primary.getBounds = vi.fn(() => ({ x: 0, y: 0, width: 500, height: 500 }));
		secondary.getBounds = vi.fn(() => ({ x: 600, y: 100, width: 500, height: 400 }));

		const handler = mockState.registeredHandlers.get('windows:findWindowAtPoint');
		const result = await handler!({ sender: primary.webContents }, 550, 50);

		expect(result).toBeNull();
	});

	it('returns state for the invoking window', async () => {
		const primary = windowManager.createWindow('primary', ['session-1']);
		windowStateStore.store.windows = [
			{
				id: 'primary',
				activeSessionId: 'session-1',
				leftPanelCollapsed: true,
				rightPanelCollapsed: false,
			} as any,
		];

		const handler = mockState.registeredHandlers.get('windows:getState');
		const result = await handler!({ sender: primary.webContents });

		expect(BrowserWindow.fromWebContents(primary.webContents)).toBe(primary);
		expect(result).toEqual({
			id: 'primary',
			x: 10,
			y: 20,
			width: 1200,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: true,
			rightPanelCollapsed: false,
		});
	});

	it('updates persisted state for the invoking window', async () => {
		const primary = windowManager.createWindow('primary', ['session-1']);
		windowStateStore.store.windows = [
			{
				id: 'primary',
				x: 1,
				y: 2,
				width: 1000,
				height: 700,
				isMaximized: false,
				isFullScreen: false,
				sessionIds: ['session-1'],
				activeSessionId: 'session-1',
				leftPanelCollapsed: false,
				rightPanelCollapsed: false,
			},
		];

		const handler = mockState.registeredHandlers.get('windows:updateState');
		const result = await handler!({ sender: primary.webContents }, { rightPanelCollapsed: true });

		expect(result.rightPanelCollapsed).toBe(true);
		expect(result.leftPanelCollapsed).toBe(false);
		expect(windowStateStore.store.windows[0]).toMatchObject({
			id: 'primary',
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: false,
			rightPanelCollapsed: true,
		});
	});
});
