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
		webContents = {};
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
		expect(ipcMain.handle).toHaveBeenCalledWith('windows:getState', expect.any(Function));
	});

	it('creates a secondary window with sessions and bounds', async () => {
		windowManager.createWindow('primary', ['session-1']);

		const handler = mockState.registeredHandlers.get('windows:create');
		const result = await handler!({}, ['session-2'], { x: 50, y: 60, width: 900, height: 700 });

		expect(result).toEqual({
			id: '2',
			isMain: false,
			sessionIds: ['session-2'],
			activeSessionId: null,
		});
		expect(windowManager.windowRegistry.getWindowForSession('session-2')).toBe('2');
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
		windowManager.createSecondaryWindow([], {});

		const moveHandler = mockState.registeredHandlers.get('windows:moveSession');
		await expect(moveHandler!({}, 'session-1', 'primary', '2')).resolves.toBe(true);

		const lookupHandler = mockState.registeredHandlers.get('windows:getForSession');
		await expect(lookupHandler!({}, 'session-1')).resolves.toBe('2');
	});

	it('focuses existing windows', async () => {
		const primary = windowManager.createWindow('primary', []);

		const handler = mockState.registeredHandlers.get('windows:focusWindow');
		const result = await handler!({}, 'primary');

		expect(result).toBe(true);
		expect(primary.show).toHaveBeenCalled();
		expect(primary.focus).toHaveBeenCalled();
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
});
