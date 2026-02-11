import { BrowserWindow, ipcMain } from 'electron';
import type { Rectangle } from 'electron';
import type Store from 'electron-store';

import type { WindowManager } from '../../app-lifecycle/window-manager';
import type { WindowState as WindowStateStoreShape } from '../../stores/types';
import type {
	MultiWindowState,
	WindowDropZoneHighlightEvent,
	WindowInfo,
	WindowState as PersistedWindowState,
	WindowSessionMovedEvent,
} from '../../../shared/types/window';
import { WINDOW_STATE_DEFAULTS } from '../../stores/defaults';
import { WindowRegistry } from '../../window-registry';
import {
	CreateHandlerOptions,
	requireDependency,
	withErrorLogging,
	withIpcErrorLogging,
} from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

const LOG_CONTEXT = '[Windows]';

const handlerOpts = (
	operation: string
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation: `windows:${operation}`,
});

export interface WindowsHandlerDependencies {
	getWindowManager: () => WindowManager | null;
	getWindowRegistry: () => WindowRegistry | null;
	windowStateStore: Store<WindowStateStoreShape>;
}

interface CreateWindowArgs {
	sessionIds?: string[];
	bounds?: Partial<Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>>;
}

interface MoveSessionArgs {
	sessionId: string;
	toWindowId: string;
	fromWindowId?: string;
}

interface AssignSessionsArgs {
	sessionIds?: string[];
	windowId?: string;
}

interface FindWindowAtPointArgs {
	screenX: number;
	screenY: number;
}

interface UpdateWindowStateArgs {
	leftPanelCollapsed?: boolean;
	rightPanelCollapsed?: boolean;
}

interface HighlightDropZoneArgs {
	windowId: string;
	highlight?: boolean;
}

export function registerWindowsHandlers(deps: WindowsHandlerDependencies): void {
	const { windowStateStore } = deps;
	const getWindowManager = () => requireDependency(deps.getWindowManager, 'Window manager');
	const getWindowRegistry = () => requireDependency(deps.getWindowRegistry, 'Window registry');
	const enqueueSessionMove = createSerialTaskQueue();

	ipcMain.handle(
		'windows:create',
		withIpcErrorLogging(handlerOpts('create'), async (args?: CreateWindowArgs) => {
			const { sessionIds = [], bounds } = args ?? {};
			const windowManager = getWindowManager();
			const windowRegistry = getWindowRegistry();
			const browserWindow = windowManager.createSecondaryWindow(sessionIds, bounds);
			const registered = findWindowEntryByBrowserWindow(windowRegistry, browserWindow);

			return {
				windowId: registered?.windowId ?? browserWindow.id.toString(),
			};
		})
	);

	ipcMain.handle(
		'windows:close',
		withIpcErrorLogging(handlerOpts('close'), async (windowId: string) => {
			if (!windowId) {
				throw new Error('windowId is required');
			}

			const windowRegistry = getWindowRegistry();
			const entry = windowRegistry.get(windowId);

			if (!entry) {
				throw new Error(`Window ${windowId} not found`);
			}

			if (entry.isMain) {
				throw new Error('Cannot close the primary window');
			}

			entry.browserWindow.close();
			return true;
		})
	);

	ipcMain.handle(
		'windows:list',
		withIpcErrorLogging(handlerOpts('list'), async (): Promise<WindowInfo[]> => {
			const windowRegistry = getWindowRegistry();
			return buildWindowInfoList(windowRegistry, windowStateStore);
		})
	);

	ipcMain.handle(
		'windows:getForSession',
		withIpcErrorLogging(handlerOpts('getForSession'), async (sessionId: string) => {
			if (!sessionId) {
				throw new Error('sessionId is required');
			}

			const windowRegistry = getWindowRegistry();
			return windowRegistry.getWindowForSession(sessionId) ?? null;
		})
	);

	ipcMain.handle(
		'windows:moveSession',
		withIpcErrorLogging(handlerOpts('moveSession'), async (args: MoveSessionArgs) => {
			const { sessionId, toWindowId, fromWindowId } = args ?? {};

			if (!sessionId) {
				throw new Error('sessionId is required');
			}

			if (!toWindowId) {
				throw new Error('toWindowId is required');
			}

			return enqueueSessionMove(async () => {
				const windowRegistry = getWindowRegistry();
				const sourceWindowId = resolveSourceWindowId(windowRegistry, sessionId, fromWindowId);

				if (!sourceWindowId) {
					throw new Error(`Session ${sessionId} is not assigned to any window`);
				}

				if (sourceWindowId === toWindowId) {
					return true;
				}

				windowRegistry.moveSession(sessionId, sourceWindowId, toWindowId);
				persistSessionMove(windowStateStore, sessionId, sourceWindowId, toWindowId);
				broadcastSessionMoved(windowRegistry, {
					sessionId,
					fromWindowId: sourceWindowId,
					toWindowId,
				});
				return true;
			});
		})
	);

	ipcMain.handle(
		'windows:assignSessions',
		withErrorLogging(
			handlerOpts('assignSessions'),
			async (event, args?: AssignSessionsArgs) => {
				const { sessionIds: rawSessionIds, windowId: overrideWindowId } = args ?? {};
				const sessionIds = Array.from(
					new Set(
						(rawSessionIds ?? []).filter(
							(sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0
						)
					)
				);

				if (!sessionIds.length) {
					throw new Error('sessionIds are required');
				}

				return enqueueSessionMove(async () => {
					const windowRegistry = getWindowRegistry();
					let targetWindowId = overrideWindowId;
					if (!targetWindowId) {
						const browserWindow = BrowserWindow.fromWebContents(event.sender);
						if (!browserWindow) {
							throw new Error('Unable to resolve BrowserWindow for assignSessions request');
						}
						targetWindowId = findWindowIdByBrowserWindow(windowRegistry, browserWindow);
						if (!targetWindowId) {
							throw new Error('Window not registered in window registry');
						}
					}

					const targetEntry = windowRegistry.get(targetWindowId);
					if (!targetEntry) {
						throw new Error(`Window ${targetWindowId} not found`);
					}

					const assignments: Array<{ sessionId: string; fromWindowId: string | null }> = [];
					for (const sessionId of sessionIds) {
						const currentWindowId = windowRegistry.getWindowForSession(sessionId) ?? null;
						if (currentWindowId === targetWindowId) {
							continue;
						}

						if (currentWindowId) {
							const currentEntry = windowRegistry.get(currentWindowId);
							if (currentEntry) {
								currentEntry.sessionIds = currentEntry.sessionIds.filter((id) => id !== sessionId);
							}
						}

						if (!targetEntry.sessionIds.includes(sessionId)) {
							targetEntry.sessionIds = [...targetEntry.sessionIds, sessionId];
						}

						assignments.push({ sessionId, fromWindowId: currentWindowId });
					}

					if (!assignments.length) {
						return true;
					}

					const windowsToPersist = new Set<string>([targetWindowId]);
					for (const { fromWindowId } of assignments) {
						if (fromWindowId) {
							windowsToPersist.add(fromWindowId);
						}
					}

					for (const windowId of windowsToPersist) {
						windowRegistry.saveWindowState(windowId, { immediate: true });
					}

					for (const { sessionId, fromWindowId } of assignments) {
						broadcastSessionMoved(windowRegistry, {
							sessionId,
							fromWindowId: fromWindowId ?? targetWindowId,
							toWindowId: targetWindowId,
						});
					}

					return true;
				});
			}
		)
	);

	ipcMain.handle(
		'windows:focusWindow',
		withIpcErrorLogging(handlerOpts('focusWindow'), async (windowId: string) => {
			if (!windowId) {
				throw new Error('windowId is required');
			}

			const windowRegistry = getWindowRegistry();
			const entry = windowRegistry.get(windowId);

			if (!entry) {
				throw new Error(`Window ${windowId} not found`);
			}

			if (entry.browserWindow.isMinimized()) {
				entry.browserWindow.restore();
			}

			entry.browserWindow.show();
			entry.browserWindow.focus();
			return true;
		})
	);

	ipcMain.handle(
		'windows:getWindowBounds',
		withIpcErrorLogging(handlerOpts('getWindowBounds'), async (event) => {
			const browserWindow = BrowserWindow.fromWebContents(event.sender);

			if (!browserWindow) {
				throw new Error('Unable to resolve BrowserWindow for getWindowBounds request');
			}

			return browserWindow.getBounds();
		})
	);

	ipcMain.handle(
		'windows:findWindowAtPoint',
		withIpcErrorLogging(
			handlerOpts('findWindowAtPoint'),
			async (event, args?: FindWindowAtPointArgs) => {
				const { screenX, screenY } = args ?? {};

				if (typeof screenX !== 'number' || typeof screenY !== 'number') {
					throw new Error('screenX and screenY are required');
				}

				const sourceWindow = BrowserWindow.fromWebContents(event.sender);

				if (!sourceWindow) {
					throw new Error('Unable to resolve BrowserWindow for findWindowAtPoint request');
				}

				const windowRegistry = getWindowRegistry();

				for (const { browserWindow, windowId } of windowRegistry.getAll()) {
					if (browserWindow === sourceWindow || browserWindow.isDestroyed()) {
						continue;
					}

					const bounds = browserWindow.getBounds();
					const withinHorizontal =
						screenX >= bounds.x && screenX <= bounds.x + bounds.width;
					const withinVertical =
						screenY >= bounds.y && screenY <= bounds.y + bounds.height;

					if (withinHorizontal && withinVertical) {
						return windowId;
					}
				}

				return null;
			}
		)
	);

	ipcMain.handle(
		'windows:highlightDropZone',
		withIpcErrorLogging(
			handlerOpts('highlightDropZone'),
			async (event, args?: HighlightDropZoneArgs) => {
				const { windowId, highlight = true } = args ?? {};

				if (!windowId) {
					throw new Error('windowId is required');
				}

				const windowRegistry = getWindowRegistry();
				const entry = windowRegistry.get(windowId);

				if (!entry) {
					throw new Error(`Window ${windowId} not found`);
				}

				if (!isWebContentsAvailable(entry.browserWindow)) {
					return false;
				}

				const sourceBrowserWindow = BrowserWindow.fromWebContents(event.sender);
				let sourceWindowId: string | null = null;
				if (sourceBrowserWindow) {
					sourceWindowId =
						findWindowIdByBrowserWindow(windowRegistry, sourceBrowserWindow) ?? null;
				}

				const payload: WindowDropZoneHighlightEvent = {
					highlight: Boolean(highlight),
					sourceWindowId,
				};

				entry.browserWindow.webContents.send('windows:dropZoneHighlight', payload);
				return true;
			}
		)
	);

	ipcMain.handle('windows:getState', async (event) => {
		try {
			const windowRegistry = getWindowRegistry();
			const browserWindow = BrowserWindow.fromWebContents(event.sender);

			if (!browserWindow) {
				return null;
			}

			const windowId = findWindowIdByBrowserWindow(windowRegistry, browserWindow);
			if (!windowId) {
				return null;
			}

			return getWindowStateSnapshot(windowStateStore, windowId);
		} catch (error) {
			logger.error('windows:getState error', LOG_CONTEXT, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	ipcMain.handle('windows:updateState', async (event, args?: UpdateWindowStateArgs) => {
		try {
			if (!args) {
				return false;
			}

			const browserWindow = BrowserWindow.fromWebContents(event.sender);
			if (!browserWindow) {
				throw new Error('Unable to resolve BrowserWindow for updateState request');
			}

			const windowRegistry = getWindowRegistry();
			const windowId = findWindowIdByBrowserWindow(windowRegistry, browserWindow);
			if (!windowId) {
				throw new Error('Window not registered in window registry');
			}

			return updateWindowState(windowStateStore, windowId, args);
		} catch (error) {
			logger.error('windows:updateState error', LOG_CONTEXT, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
}

function buildWindowInfoList(
	windowRegistry: WindowRegistry,
	windowStateStore: Store<WindowStateStoreShape>
): WindowInfo[] {
	const multiWindowState = getMultiWindowStateSnapshot(windowStateStore);
	const stateMap = new Map<string, PersistedWindowState>();

	for (const windowState of multiWindowState.windows) {
		stateMap.set(windowState.id, windowState);
	}

	return windowRegistry.getAll().map(({ windowId, sessionIds, isMain }) => {
		const persisted = stateMap.get(windowId);
		return {
			id: windowId,
			isMain,
			sessionIds: [...sessionIds],
			activeSessionId: persisted?.activeSessionId ?? null,
		};
	});
}

function resolveSourceWindowId(
	windowRegistry: WindowRegistry,
	sessionId: string,
	preferredWindowId?: string
): string | null {
	if (preferredWindowId) {
		const preferredWindow = windowRegistry.get(preferredWindowId);
		if (preferredWindow?.sessionIds.includes(sessionId)) {
			return preferredWindowId;
		}
	}

	return windowRegistry.getWindowForSession(sessionId) ?? null;
}

function createSerialTaskQueue() {
	let pending: Promise<void> = Promise.resolve();
	return function enqueueTask<T>(task: () => T | Promise<T>): Promise<T> {
		const runTask = () => Promise.resolve().then(task);
		const next = pending.then(runTask, runTask);
		pending = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	};
}

function persistSessionMove(
	windowStateStore: Store<WindowStateStoreShape>,
	sessionId: string,
	fromWindowId: string,
	toWindowId: string
): void {
	const multiWindowState = getMultiWindowStateSnapshot(windowStateStore);
	const fromWindowIndex = multiWindowState.windows.findIndex((window) => window.id === fromWindowId);

	if (fromWindowIndex === -1) {
		throw new Error(`Window ${fromWindowId} not found in persisted state`);
	}

	const fromWindow = multiWindowState.windows[fromWindowIndex];
	fromWindow.sessionIds = fromWindow.sessionIds.filter((id) => id !== sessionId);
	if (fromWindow.activeSessionId === sessionId) {
		fromWindow.activeSessionId = fromWindow.sessionIds[0] ?? null;
	}

	let toWindow = multiWindowState.windows.find((window) => window.id === toWindowId);
	if (!toWindow) {
		toWindow = createDefaultWindowStateSnapshot(toWindowId);
		multiWindowState.windows.push(toWindow);
	}

	if (!toWindow.sessionIds.includes(sessionId)) {
		toWindow.sessionIds = [...toWindow.sessionIds, sessionId];
	}
	toWindow.activeSessionId = sessionId;

	windowStateStore.set('multiWindowState', {
		primaryWindowId: multiWindowState.primaryWindowId,
		windows: multiWindowState.windows.map(cloneWindowState),
	});
}

function broadcastSessionMoved(
	windowRegistry: WindowRegistry,
	event: WindowSessionMovedEvent
): void {
	for (const { browserWindow } of windowRegistry.getAll()) {
		if (!isWebContentsAvailable(browserWindow)) {
			continue;
		}
		browserWindow.webContents.send('windows:sessionMoved', event);
	}
}

function getWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>,
	windowId: string
): PersistedWindowState | null {
	const multiWindowState = getMultiWindowStateSnapshot(windowStateStore);
	const windowState = multiWindowState.windows.find((window) => window.id === windowId);
	return windowState ? cloneWindowState(windowState) : null;
}

function getMultiWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>
): MultiWindowState {
	const persisted =
		windowStateStore.get('multiWindowState') ??
		windowStateStore.store.multiWindowState ??
		WINDOW_STATE_DEFAULTS.multiWindowState;

	if (!persisted) {
		return {
			primaryWindowId: 'primary',
			windows: [],
		};
	}

	return {
		primaryWindowId: persisted.primaryWindowId,
		windows: persisted.windows.map(cloneWindowState),
	};
}

function cloneWindowState(windowState: PersistedWindowState): PersistedWindowState {
	return {
		...windowState,
		sessionIds: [...windowState.sessionIds],
	};
}

function createDefaultWindowStateSnapshot(windowId: string): PersistedWindowState {
	const template = WINDOW_STATE_DEFAULTS.multiWindowState?.windows[0];
	return {
		id: windowId,
		x: undefined,
		y: undefined,
		width: template?.width ?? WINDOW_STATE_DEFAULTS.width,
		height: template?.height ?? WINDOW_STATE_DEFAULTS.height,
		isMaximized: template?.isMaximized ?? WINDOW_STATE_DEFAULTS.isMaximized,
		isFullScreen: template?.isFullScreen ?? WINDOW_STATE_DEFAULTS.isFullScreen,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: template?.leftPanelCollapsed ?? false,
		rightPanelCollapsed: template?.rightPanelCollapsed ?? false,
	};
}

function updateWindowState(
	windowStateStore: Store<WindowStateStoreShape>,
	windowId: string,
	updates: UpdateWindowStateArgs
): boolean {
	const hasLeftUpdate = typeof updates.leftPanelCollapsed === 'boolean';
	const hasRightUpdate = typeof updates.rightPanelCollapsed === 'boolean';
	if (!hasLeftUpdate && !hasRightUpdate) {
		return false;
	}

	const multiWindowState = getMultiWindowStateSnapshot(windowStateStore);
	let windowState = multiWindowState.windows.find((window) => window.id === windowId);
	if (!windowState) {
		windowState = createDefaultWindowStateSnapshot(windowId);
		multiWindowState.windows.push(windowState);
	}

	let changed = false;
	if (hasLeftUpdate && windowState.leftPanelCollapsed !== updates.leftPanelCollapsed) {
		windowState.leftPanelCollapsed = updates.leftPanelCollapsed ?? windowState.leftPanelCollapsed;
		changed = true;
	}
	if (hasRightUpdate && windowState.rightPanelCollapsed !== updates.rightPanelCollapsed) {
		windowState.rightPanelCollapsed = updates.rightPanelCollapsed ?? windowState.rightPanelCollapsed;
		changed = true;
	}

	if (!changed) {
		return false;
	}

	windowStateStore.set('multiWindowState', {
		primaryWindowId: multiWindowState.primaryWindowId,
		windows: multiWindowState.windows.map(cloneWindowState),
	});
	return true;
}

function findWindowEntryByBrowserWindow(
	windowRegistry: WindowRegistry,
	browserWindow: BrowserWindow
) {
	return windowRegistry
		.getAll()
		.find((entry) => entry.browserWindow === browserWindow);
}

function findWindowIdByBrowserWindow(
	windowRegistry: WindowRegistry,
	browserWindow: BrowserWindow
): string | undefined {
	return findWindowEntryByBrowserWindow(windowRegistry, browserWindow)?.windowId;
}
