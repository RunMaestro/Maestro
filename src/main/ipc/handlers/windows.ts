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
import {
	recordMultiWindowUsage,
	type StatsSettingsReader,
} from '../../stats/multi-window-recorder';

export type WindowCreateBounds = Partial<Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>>;

export interface WindowsHandlerDependencies {
	windowManager: WindowManager;
	windowStateStore: Store<MultiWindowState>;
	settingsStore?: StatsSettingsReader;
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

function getNextActiveSessionId(sessionIds: string[], movedSessionId: string): string | null {
	const movedIndex = sessionIds.indexOf(movedSessionId);
	const nextSessionIds = sessionIds.filter((sessionId) => sessionId !== movedSessionId);
	if (nextSessionIds.length === 0) {
		return null;
	}

	return nextSessionIds[Math.min(movedIndex, nextSessionIds.length - 1)] ?? null;
}

function wouldEmptyPrimaryWindow(
	sessionIds: string[],
	movedSessionIds: string[],
	isMain: boolean
): boolean {
	if (!isMain || sessionIds.length === 0) {
		return false;
	}

	return sessionIds.every((sessionId) => movedSessionIds.includes(sessionId));
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

function createMoveSessionQueue() {
	let queue = Promise.resolve();

	return function enqueueMoveSession<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = queue.then(operation, operation);
		queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};
}

/**
 * Register all multi-window IPC handlers.
 */
export function registerWindowsHandlers(deps: WindowsHandlerDependencies): void {
	const { windowManager, windowStateStore, settingsStore } = deps;
	const { windowRegistry } = windowManager;
	const enqueueMoveSession = createMoveSessionQueue();

	ipcMain.handle(
		'windows:create',
		async (event, sessionIds: string[] = [], bounds: WindowCreateBounds = {}) => {
			const sourceWindow = event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
			const sourceWindowId = sourceWindow ? windowRegistry.getWindowId(sourceWindow) : undefined;
			const sourceEntry = sourceWindowId ? windowRegistry.get(sourceWindowId) : undefined;
			const sourceSessionIds = sourceEntry?.sessionIds ?? [];
			const sourceActiveSessionId = sourceWindowId
				? findStoredWindowState(windowStateStore, sourceWindowId)?.activeSessionId
				: null;
			if (
				sourceEntry &&
				wouldEmptyPrimaryWindow(sourceEntry.sessionIds, sessionIds, sourceEntry.isMain)
			) {
				throw new Error('Cannot move the last tab out of the primary window');
			}

			const browserWindow = windowManager.createSecondaryWindow(sessionIds, bounds);
			const windowId = windowRegistry.getWindowId(browserWindow);
			if (!windowId) {
				throw new Error('Created window was not registered');
			}

			const activeSessionId = sessionIds[0] ?? null;
			upsertStoredWindowState(windowStateStore, windowId, browserWindow, sessionIds, {
				activeSessionId,
			});

			if (sourceWindowId && sourceWindow && sourceEntry) {
				const sourceMovedActiveSession =
					sourceActiveSessionId && sessionIds.includes(sourceActiveSessionId);
				upsertStoredWindowState(
					windowStateStore,
					sourceWindowId,
					sourceWindow,
					sourceEntry.sessionIds,
					{
						activeSessionId: sourceMovedActiveSession
							? getNextActiveSessionId(sourceSessionIds, sourceActiveSessionId)
							: (sourceActiveSessionId ?? null),
					}
				);
			}

			recordMultiWindowUsage(settingsStore, windowRegistry, 'window_created');

			return toWindowInfo(windowId, windowManager, activeSessionId);
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
			return enqueueMoveSession(() => {
				const currentOwnerWindowId = windowRegistry.getWindowForSession(sessionId);
				const effectiveFromWindowId = currentOwnerWindowId ?? fromWindowId;
				const fromWindow = windowRegistry.get(effectiveFromWindowId);
				const toWindow = windowRegistry.get(toWindowId);
				if (!fromWindow) {
					throw new Error(`Source window not registered: ${effectiveFromWindowId}`);
				}
				if (!toWindow) {
					throw new Error(`Destination window not registered: ${toWindowId}`);
				}
				if (effectiveFromWindowId === toWindowId) {
					return true;
				}
				if (wouldEmptyPrimaryWindow(fromWindow.sessionIds, [sessionId], fromWindow.isMain)) {
					throw new Error('Cannot move the last tab out of the primary window');
				}

				const sourceStoredState = findStoredWindowState(windowStateStore, effectiveFromWindowId);
				const nextSourceActiveSessionId =
					sourceStoredState?.activeSessionId === sessionId
						? getNextActiveSessionId(fromWindow.sessionIds, sessionId)
						: sourceStoredState?.activeSessionId;

				windowRegistry.moveSession(sessionId, effectiveFromWindowId, toWindowId);
				upsertStoredWindowState(
					windowStateStore,
					effectiveFromWindowId,
					fromWindow.browserWindow,
					fromWindow.sessionIds,
					{ activeSessionId: nextSourceActiveSessionId ?? null }
				);
				upsertStoredWindowState(
					windowStateStore,
					toWindowId,
					toWindow.browserWindow,
					toWindow.sessionIds,
					{ activeSessionId: sessionId }
				);
				broadcastSessionMoved(windowManager, {
					sessionId,
					fromWindowId: effectiveFromWindowId,
					toWindowId,
					windows: getWindowList(windowManager, windowStateStore),
				});
				recordMultiWindowUsage(settingsStore, windowRegistry, 'session_moved');
				return true;
			});
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

	ipcMain.handle(
		'windows:highlightDropZone',
		async (_event, windowId: string, highlighted: boolean): Promise<boolean> => {
			const entry = windowRegistry.get(windowId);
			if (
				!entry ||
				entry.browserWindow.isDestroyed() ||
				entry.browserWindow.webContents.isDestroyed()
			) {
				return false;
			}

			entry.browserWindow.webContents.send('windows:dropZoneHighlightChanged', { highlighted });
			return true;
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
