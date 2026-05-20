/**
 * Multi-window IPC handlers.
 *
 * Handles BrowserWindow creation, focus, close, lookup, and per-window session ownership.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, Rectangle } from 'electron';
import type Store from 'electron-store';
import type {
	WindowBounds,
	WindowInfo,
	WindowPoint,
	WindowSessionMovedEvent,
	WindowState,
	WindowStateUpdate,
} from '../../../shared/types/window';
import type { MultiWindowState } from '../../stores/types';
import type { WindowManager } from '../../app-lifecycle/window-manager';

export type WindowCreateBounds = Partial<Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>>;

export interface WindowsHandlerDependencies {
	windowManager: WindowManager;
	windowStateStore: Store<MultiWindowState>;
}

export interface WindowCloseResult {
	closed: boolean;
	reason?: 'primary-window' | 'not-found';
}

function findStoredWindowState(
	windowStateStore: Store<MultiWindowState>,
	windowId: string
): WindowState | undefined {
	return windowStateStore.store.windows.find((windowState) => windowState.id === windowId);
}

function toWindowInfo(
	windowId: string,
	windowManager: WindowManager,
	activeSessionId?: string | null
): WindowInfo {
	const entry = windowManager.windowRegistry.get(windowId);
	if (!entry) {
		throw new Error(`Window not registered: ${windowId}`);
	}

	return {
		id: windowId,
		isMain: entry.isMain,
		sessionIds: entry.sessionIds,
		activeSessionId: activeSessionId ?? null,
	};
}

function getEventWindow(event: IpcMainInvokeEvent): BrowserWindow {
	const browserWindow = BrowserWindow.fromWebContents(event.sender);
	if (!browserWindow) {
		throw new Error('No BrowserWindow found for IPC sender');
	}

	return browserWindow;
}

function getWindowList(
	windowManager: WindowManager,
	windowStateStore: Store<MultiWindowState>
): WindowInfo[] {
	return windowManager.windowRegistry.getEntries().map(([windowId, entry]) => {
		const storedState = findStoredWindowState(windowStateStore, windowId);
		return {
			id: windowId,
			isMain: entry.isMain,
			sessionIds: entry.sessionIds,
			activeSessionId: storedState?.activeSessionId ?? null,
		};
	});
}

function isPointInsideBounds(point: WindowPoint, bounds: WindowBounds): boolean {
	return (
		point.screenX >= bounds.x &&
		point.screenX <= bounds.x + bounds.width &&
		point.screenY >= bounds.y &&
		point.screenY <= bounds.y + bounds.height
	);
}

function upsertStoredWindowState(
	windowStateStore: Store<MultiWindowState>,
	windowId: string,
	browserWindow: BrowserWindow,
	sessionIds: string[],
	update: WindowStateUpdate
): WindowState {
	const currentState = windowStateStore.store;
	const bounds = browserWindow.getBounds();
	const existingWindowState = findStoredWindowState(windowStateStore, windowId);
	const nextWindowState: WindowState = {
		id: windowId,
		x: existingWindowState?.x ?? bounds.x,
		y: existingWindowState?.y ?? bounds.y,
		width: existingWindowState?.width ?? bounds.width,
		height: existingWindowState?.height ?? bounds.height,
		isMaximized: existingWindowState?.isMaximized ?? browserWindow.isMaximized(),
		isFullScreen: existingWindowState?.isFullScreen ?? browserWindow.isFullScreen(),
		sessionIds,
		activeSessionId:
			update.activeSessionId !== undefined
				? update.activeSessionId
				: (existingWindowState?.activeSessionId ?? null),
		leftPanelCollapsed:
			update.leftPanelCollapsed ?? existingWindowState?.leftPanelCollapsed ?? false,
		rightPanelCollapsed:
			update.rightPanelCollapsed ?? existingWindowState?.rightPanelCollapsed ?? false,
	};

	const hasWindowState = currentState.windows.some((windowState) => windowState.id === windowId);
	windowStateStore.store = {
		...currentState,
		windows: hasWindowState
			? currentState.windows.map((windowState) =>
					windowState.id === windowId ? nextWindowState : windowState
				)
			: [...currentState.windows, nextWindowState],
	};

	return nextWindowState;
}

function broadcastSessionMoved(
	windowManager: WindowManager,
	payload: WindowSessionMovedEvent
): void {
	for (const entry of windowManager.windowRegistry.getAll()) {
		if (entry.browserWindow.isDestroyed() || entry.browserWindow.webContents.isDestroyed()) {
			continue;
		}
		entry.browserWindow.webContents.send('windows:sessionMoved', payload);
	}
}

/**
 * Register all multi-window IPC handlers.
 */
export function registerWindowsHandlers(deps: WindowsHandlerDependencies): void {
	const { windowManager, windowStateStore } = deps;
	const { windowRegistry } = windowManager;

	ipcMain.handle(
		'windows:create',
		async (_event, sessionIds: string[] = [], bounds: WindowCreateBounds = {}) => {
			const browserWindow = windowManager.createSecondaryWindow(sessionIds, bounds);
			const windowId = windowRegistry.getWindowId(browserWindow);
			if (!windowId) {
				throw new Error('Created window was not registered');
			}

			return toWindowInfo(windowId, windowManager);
		}
	);

	ipcMain.handle('windows:close', async (_event, windowId: string): Promise<WindowCloseResult> => {
		const entry = windowRegistry.get(windowId);
		if (!entry) {
			return { closed: false, reason: 'not-found' };
		}
		if (entry.isMain) {
			return { closed: false, reason: 'primary-window' };
		}

		entry.browserWindow.close();
		return { closed: true };
	});

	ipcMain.handle('windows:list', async (): Promise<WindowInfo[]> => {
		return getWindowList(windowManager, windowStateStore);
	});

	ipcMain.handle(
		'windows:getForSession',
		async (_event, sessionId: string): Promise<string | null> => {
			return windowRegistry.getWindowForSession(sessionId) ?? null;
		}
	);

	ipcMain.handle(
		'windows:moveSession',
		async (
			_event,
			sessionId: string,
			fromWindowId: string,
			toWindowId: string
		): Promise<boolean> => {
			windowRegistry.moveSession(sessionId, fromWindowId, toWindowId);
			broadcastSessionMoved(windowManager, {
				sessionId,
				fromWindowId,
				toWindowId,
				windows: getWindowList(windowManager, windowStateStore),
			});
			return true;
		}
	);

	ipcMain.handle('windows:focusWindow', async (_event, windowId: string): Promise<boolean> => {
		const entry = windowRegistry.get(windowId);
		if (!entry || entry.browserWindow.isDestroyed()) {
			return false;
		}

		if (entry.browserWindow.isMinimized()) {
			entry.browserWindow.restore();
		}
		entry.browserWindow.show();
		entry.browserWindow.focus();
		return true;
	});

	ipcMain.handle('windows:getWindowBounds', async (event): Promise<WindowBounds> => {
		const browserWindow = getEventWindow(event);
		return browserWindow.getBounds();
	});

	ipcMain.handle(
		'windows:findWindowAtPoint',
		async (event, screenX: number, screenY: number): Promise<WindowInfo | null> => {
			const sourceWindow = getEventWindow(event);

			for (const entry of windowRegistry.getAll()) {
				if (entry.browserWindow === sourceWindow || entry.browserWindow.isDestroyed()) {
					continue;
				}

				const windowId = windowRegistry.getWindowId(entry.browserWindow);
				if (!windowId) {
					continue;
				}

				if (isPointInsideBounds({ screenX, screenY }, entry.browserWindow.getBounds())) {
					const storedState = findStoredWindowState(windowStateStore, windowId);
					return toWindowInfo(windowId, windowManager, storedState?.activeSessionId ?? null);
				}
			}

			return null;
		}
	);

	ipcMain.handle('windows:getState', async (event): Promise<WindowState> => {
		const browserWindow = getEventWindow(event);
		const windowId = windowRegistry.getWindowId(browserWindow);
		if (!windowId) {
			throw new Error('IPC sender window is not registered');
		}

		const entry = windowRegistry.get(windowId);
		if (!entry) {
			throw new Error(`Window not registered: ${windowId}`);
		}

		const bounds = browserWindow.getBounds();
		const storedState = findStoredWindowState(windowStateStore, windowId);

		return {
			id: windowId,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized: browserWindow.isMaximized(),
			isFullScreen: browserWindow.isFullScreen(),
			sessionIds: entry.sessionIds,
			activeSessionId: storedState?.activeSessionId ?? null,
			leftPanelCollapsed: storedState?.leftPanelCollapsed ?? false,
			rightPanelCollapsed: storedState?.rightPanelCollapsed ?? false,
		};
	});

	ipcMain.handle(
		'windows:updateState',
		async (event, update: WindowStateUpdate): Promise<WindowState> => {
			const browserWindow = getEventWindow(event);
			const windowId = windowRegistry.getWindowId(browserWindow);
			if (!windowId) {
				throw new Error('IPC sender window is not registered');
			}

			const entry = windowRegistry.get(windowId);
			if (!entry) {
				throw new Error(`Window not registered: ${windowId}`);
			}

			return upsertStoredWindowState(
				windowStateStore,
				windowId,
				browserWindow,
				entry.sessionIds,
				update
			);
		}
	);
}
