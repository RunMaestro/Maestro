/**
 * Windows IPC Handlers
 *
 * This module handles IPC calls for multi-window management operations:
 * - windows:create - Create new window with optional sessionIds and bounds
 * - windows:close - Close window by ID (prevents closing primary)
 * - windows:list - Return all WindowInfo
 * - windows:getForSession - Return windowId for a sessionId
 * - windows:moveSession - Move session between windows
 * - windows:focusWindow - Bring window to front
 * - windows:getState - Get current window's state
 *
 * Implements GitHub issue #133 - multi-window support.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { windowRegistry, type WindowEntry, type CreateWindowResult } from '../../window-registry';
import type {
	WindowInfo,
	CreateWindowRequest,
	CreateWindowResponse,
	MoveSessionRequest,
	WindowState,
} from '../../../shared/types/window';
import { logger } from '../../utils/logger';
import { getMultiWindowStateStore } from '../../stores/getters';
import type { MultiWindowWindowState } from '../../stores/types';

const LOG_CONTEXT = 'WindowsIPC';

/**
 * Callback type for creating secondary windows.
 * Used to delegate window creation to the window manager.
 */
export type CreateSecondaryWindowCallback = (
	sessionIds?: string[],
	bounds?: { x?: number; y?: number; width?: number; height?: number }
) => CreateWindowResult;

/**
 * Dependencies required for windows handlers
 */
export interface WindowsHandlerDependencies {
	/** Callback to create secondary windows through the window manager */
	createSecondaryWindow: CreateSecondaryWindowCallback;
}

/**
 * Converts a WindowEntry to a WindowInfo object for IPC responses.
 *
 * @param windowId - The window ID
 * @param entry - The WindowEntry from the registry
 * @returns WindowInfo object
 */
function entryToWindowInfo(windowId: string, entry: WindowEntry): WindowInfo {
	return {
		id: windowId,
		isMain: entry.isMain,
		sessionIds: [...entry.sessionIds],
		activeSessionId: entry.activeSessionId,
	};
}

/**
 * Gets the current state of a BrowserWindow.
 *
 * @param windowId - The window ID
 * @param entry - The WindowEntry from the registry
 * @returns WindowState object
 */
function getWindowState(windowId: string, entry: WindowEntry): WindowState {
	const bounds = entry.browserWindow.getBounds();
	const isMaximized = entry.browserWindow.isMaximized();
	const isFullScreen = entry.browserWindow.isFullScreen();

	return {
		id: windowId,
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		isMaximized,
		isFullScreen,
		sessionIds: [...entry.sessionIds],
		activeSessionId: entry.activeSessionId,
		// Panel collapse state is managed by renderer - defaults here
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

/**
 * Register all windows-related IPC handlers.
 *
 * @param deps - Dependencies required for handler operation
 */
export function registerWindowsHandlers(deps: WindowsHandlerDependencies): void {
	const { createSecondaryWindow } = deps;

	// ============ windows:create ============
	// Create a new window with optional sessionIds and bounds
	ipcMain.handle(
		'windows:create',
		async (_event, request?: CreateWindowRequest): Promise<CreateWindowResponse> => {
			logger.info('Creating new window via IPC', LOG_CONTEXT, {
				sessionIds: request?.sessionIds,
				hasActiveSessionId: !!request?.activeSessionId,
				hasBounds: !!request?.bounds,
			});

			try {
				const result = createSecondaryWindow(request?.sessionIds, request?.bounds);

				// If an active session was specified, set it
				if (request?.activeSessionId) {
					windowRegistry.setActiveSession(result.windowId, request.activeSessionId);
				}

				logger.info('Window created successfully', LOG_CONTEXT, {
					windowId: result.windowId,
				});

				return { windowId: result.windowId };
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error('Failed to create window', LOG_CONTEXT, { error: errorMessage });
				throw new Error(`Failed to create window: ${errorMessage}`);
			}
		}
	);

	// ============ windows:close ============
	// Close a window by ID (prevents closing primary window)
	ipcMain.handle(
		'windows:close',
		async (_event, windowId: string): Promise<{ success: boolean; error?: string }> => {
			logger.info('Closing window via IPC', LOG_CONTEXT, { windowId });

			const entry = windowRegistry.get(windowId);
			if (!entry) {
				logger.warn('Window not found for close', LOG_CONTEXT, { windowId });
				return { success: false, error: 'Window not found' };
			}

			// Prevent closing the primary window
			if (entry.isMain) {
				logger.warn('Attempted to close primary window', LOG_CONTEXT, { windowId });
				return { success: false, error: 'Cannot close the primary window' };
			}

			try {
				// Close the BrowserWindow - registry cleanup happens automatically via 'closed' event
				entry.browserWindow.close();
				logger.info('Window closed successfully', LOG_CONTEXT, { windowId });
				return { success: true };
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error('Failed to close window', LOG_CONTEXT, { windowId, error: errorMessage });
				return { success: false, error: errorMessage };
			}
		}
	);

	// ============ windows:list ============
	// Return all WindowInfo objects
	ipcMain.handle('windows:list', async (): Promise<WindowInfo[]> => {
		const allWindows = windowRegistry.getAll();
		const windowInfos = allWindows.map(([windowId, entry]) => entryToWindowInfo(windowId, entry));

		logger.debug('Listing all windows', LOG_CONTEXT, {
			count: windowInfos.length,
			windowIds: windowInfos.map((w) => w.id),
		});

		return windowInfos;
	});

	// ============ windows:getForSession ============
	// Return the windowId containing a specific session
	ipcMain.handle(
		'windows:getForSession',
		async (_event, sessionId: string): Promise<string | null> => {
			const windowId = windowRegistry.getWindowForSession(sessionId);

			logger.debug('Getting window for session', LOG_CONTEXT, {
				sessionId,
				windowId: windowId || '(not found)',
			});

			return windowId || null;
		}
	);

	// ============ windows:moveSession ============
	// Move a session from one window to another
	ipcMain.handle(
		'windows:moveSession',
		async (_event, request: MoveSessionRequest): Promise<{ success: boolean; error?: string }> => {
			const { sessionId, fromWindowId, toWindowId } = request;

			logger.info('Moving session between windows', LOG_CONTEXT, {
				sessionId,
				fromWindowId: fromWindowId || '(none)',
				toWindowId,
			});

			// Validate target window exists
			const toEntry = windowRegistry.get(toWindowId);
			if (!toEntry) {
				logger.warn('Target window not found for move', LOG_CONTEXT, { toWindowId });
				return { success: false, error: 'Target window not found' };
			}

			// If fromWindowId is specified, validate it exists
			if (fromWindowId) {
				const fromEntry = windowRegistry.get(fromWindowId);
				if (!fromEntry) {
					logger.warn('Source window not found for move', LOG_CONTEXT, { fromWindowId });
					return { success: false, error: 'Source window not found' };
				}
			}

			const success = windowRegistry.moveSession(sessionId, fromWindowId || '', toWindowId);

			if (success) {
				logger.info('Session moved successfully', LOG_CONTEXT, {
					sessionId,
					fromWindowId: fromWindowId || '(none)',
					toWindowId,
				});

				// Notify both windows about the change
				notifyWindowOfSessionChange(toWindowId, toEntry);
				if (fromWindowId) {
					const fromEntry = windowRegistry.get(fromWindowId);
					if (fromEntry) {
						notifyWindowOfSessionChange(fromWindowId, fromEntry);
					}
				}

				// Broadcast sessionMoved event to ALL windows
				broadcastSessionMoved(sessionId, fromWindowId || '', toWindowId);
			} else {
				logger.warn('Failed to move session', LOG_CONTEXT, {
					sessionId,
					fromWindowId,
					toWindowId,
				});
			}

			return { success, error: success ? undefined : 'Failed to move session' };
		}
	);

	// ============ windows:focusWindow ============
	// Bring a window to the front
	ipcMain.handle(
		'windows:focusWindow',
		async (_event, windowId: string): Promise<{ success: boolean; error?: string }> => {
			logger.debug('Focusing window', LOG_CONTEXT, { windowId });

			const entry = windowRegistry.get(windowId);
			if (!entry) {
				logger.warn('Window not found for focus', LOG_CONTEXT, { windowId });
				return { success: false, error: 'Window not found' };
			}

			try {
				const win = entry.browserWindow;
				if (win.isDestroyed()) {
					return { success: false, error: 'Window is destroyed' };
				}

				// Show and focus the window
				if (win.isMinimized()) {
					win.restore();
				}
				win.show();
				win.focus();

				logger.debug('Window focused successfully', LOG_CONTEXT, { windowId });
				return { success: true };
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error('Failed to focus window', LOG_CONTEXT, { windowId, error: errorMessage });
				return { success: false, error: errorMessage };
			}
		}
	);

	// ============ windows:getState ============
	// Get the current state of the calling window
	// Note: Uses IPC event.sender to identify which window is calling
	ipcMain.handle('windows:getState', async (event): Promise<WindowState | null> => {
		// Find the window that sent this IPC call
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		if (!senderWindow) {
			logger.warn('Could not determine sender window for getState', LOG_CONTEXT);
			return null;
		}

		const windowId = windowRegistry.getWindowIdForBrowserWindow(senderWindow);
		if (!windowId) {
			logger.warn('Window not in registry for getState', LOG_CONTEXT);
			return null;
		}

		const entry = windowRegistry.get(windowId);
		if (!entry) {
			return null;
		}

		const state = getWindowState(windowId, entry);
		logger.debug('Retrieved window state', LOG_CONTEXT, {
			windowId,
			sessionCount: state.sessionIds.length,
		});

		return state;
	});

	// ============ windows:getWindowId ============
	// Get the window ID for the calling window
	ipcMain.handle('windows:getWindowId', async (event): Promise<string | null> => {
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		if (!senderWindow) {
			return null;
		}

		const windowId = windowRegistry.getWindowIdForBrowserWindow(senderWindow);
		return windowId || null;
	});

	// ============ windows:setSessionsForWindow ============
	// Set the sessions for a specific window (used by renderer to sync state)
	ipcMain.handle(
		'windows:setSessionsForWindow',
		async (
			_event,
			windowId: string,
			sessionIds: string[],
			activeSessionId?: string
		): Promise<{ success: boolean; error?: string }> => {
			logger.debug('Setting sessions for window', LOG_CONTEXT, {
				windowId,
				sessionCount: sessionIds.length,
				activeSessionId,
			});

			const success = windowRegistry.setSessionsForWindow(windowId, sessionIds, activeSessionId);

			if (!success) {
				return { success: false, error: 'Window not found' };
			}

			return { success: true };
		}
	);

	// ============ windows:setActiveSession ============
	// Set the active session for a specific window
	ipcMain.handle(
		'windows:setActiveSession',
		async (
			_event,
			windowId: string,
			sessionId: string
		): Promise<{ success: boolean; error?: string }> => {
			logger.debug('Setting active session for window', LOG_CONTEXT, {
				windowId,
				sessionId,
			});

			const success = windowRegistry.setActiveSession(windowId, sessionId);

			if (!success) {
				return { success: false, error: 'Window not found or session not in window' };
			}

			return { success: true };
		}
	);

	// ============ windows:getPanelState ============
	// Get the panel collapse state for the calling window
	ipcMain.handle(
		'windows:getPanelState',
		async (
			event
		): Promise<{ leftPanelCollapsed: boolean; rightPanelCollapsed: boolean } | null> => {
			// Find the window that sent this IPC call
			const senderWindow = BrowserWindow.fromWebContents(event.sender);
			if (!senderWindow) {
				logger.warn('Could not determine sender window for getPanelState', LOG_CONTEXT);
				return null;
			}

			const windowId = windowRegistry.getWindowIdForBrowserWindow(senderWindow);
			if (!windowId) {
				logger.warn('Window not in registry for getPanelState', LOG_CONTEXT);
				return null;
			}

			// Look up the window state in the multi-window store
			const multiWindowStore = getMultiWindowStateStore();
			const windows = multiWindowStore.get('windows', []);
			const windowState = windows.find((w: MultiWindowWindowState) => w.id === windowId);

			if (windowState) {
				logger.debug('Retrieved panel state', LOG_CONTEXT, {
					windowId,
					leftPanelCollapsed: windowState.leftPanelCollapsed,
					rightPanelCollapsed: windowState.rightPanelCollapsed,
				});
				return {
					leftPanelCollapsed: windowState.leftPanelCollapsed,
					rightPanelCollapsed: windowState.rightPanelCollapsed,
				};
			}

			// Return defaults if window not found in store
			logger.debug('Window not found in store, returning defaults', LOG_CONTEXT, { windowId });
			return { leftPanelCollapsed: false, rightPanelCollapsed: false };
		}
	);

	// ============ windows:setPanelState ============
	// Set the panel collapse state for the calling window
	ipcMain.handle(
		'windows:setPanelState',
		async (
			event,
			panelState: { leftPanelCollapsed?: boolean; rightPanelCollapsed?: boolean }
		): Promise<{ success: boolean; error?: string }> => {
			// Find the window that sent this IPC call
			const senderWindow = BrowserWindow.fromWebContents(event.sender);
			if (!senderWindow) {
				logger.warn('Could not determine sender window for setPanelState', LOG_CONTEXT);
				return { success: false, error: 'Could not determine sender window' };
			}

			const windowId = windowRegistry.getWindowIdForBrowserWindow(senderWindow);
			if (!windowId) {
				logger.warn('Window not in registry for setPanelState', LOG_CONTEXT);
				return { success: false, error: 'Window not found in registry' };
			}

			// Update the window state in the multi-window store
			const multiWindowStore = getMultiWindowStateStore();
			const windows = multiWindowStore.get('windows', []);
			const windowIndex = windows.findIndex((w: MultiWindowWindowState) => w.id === windowId);

			if (windowIndex !== -1) {
				// Update existing window state
				if (panelState.leftPanelCollapsed !== undefined) {
					windows[windowIndex].leftPanelCollapsed = panelState.leftPanelCollapsed;
				}
				if (panelState.rightPanelCollapsed !== undefined) {
					windows[windowIndex].rightPanelCollapsed = panelState.rightPanelCollapsed;
				}
				multiWindowStore.set('windows', windows);

				logger.debug('Panel state updated', LOG_CONTEXT, {
					windowId,
					leftPanelCollapsed: windows[windowIndex].leftPanelCollapsed,
					rightPanelCollapsed: windows[windowIndex].rightPanelCollapsed,
				});
				return { success: true };
			}

			// Window not in store - create a new entry with defaults
			const entry = windowRegistry.get(windowId);
			if (!entry) {
				return { success: false, error: 'Window not found' };
			}

			const bounds = entry.browserWindow.getBounds();
			const newWindowState: MultiWindowWindowState = {
				id: windowId,
				x: bounds.x,
				y: bounds.y,
				width: bounds.width,
				height: bounds.height,
				isMaximized: entry.browserWindow.isMaximized(),
				isFullScreen: entry.browserWindow.isFullScreen(),
				sessionIds: entry.sessionIds,
				activeSessionId: entry.activeSessionId,
				leftPanelCollapsed: panelState.leftPanelCollapsed ?? false,
				rightPanelCollapsed: panelState.rightPanelCollapsed ?? false,
			};

			windows.push(newWindowState);
			multiWindowStore.set('windows', windows);

			logger.debug('New window state created with panel state', LOG_CONTEXT, {
				windowId,
				leftPanelCollapsed: newWindowState.leftPanelCollapsed,
				rightPanelCollapsed: newWindowState.rightPanelCollapsed,
			});
			return { success: true };
		}
	);

	// ============ windows:getWindowBounds ============
	// Get the screen bounds of the calling window (for drag-out detection)
	ipcMain.handle(
		'windows:getWindowBounds',
		async (event): Promise<{ x: number; y: number; width: number; height: number } | null> => {
			// Find the window that sent this IPC call
			const senderWindow = BrowserWindow.fromWebContents(event.sender);
			if (!senderWindow) {
				logger.warn('Could not determine sender window for getWindowBounds', LOG_CONTEXT);
				return null;
			}

			try {
				if (senderWindow.isDestroyed()) {
					return null;
				}

				const bounds = senderWindow.getBounds();
				logger.debug('Retrieved window bounds', LOG_CONTEXT, {
					x: bounds.x,
					y: bounds.y,
					width: bounds.width,
					height: bounds.height,
				});

				return {
					x: bounds.x,
					y: bounds.y,
					width: bounds.width,
					height: bounds.height,
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.error('Failed to get window bounds', LOG_CONTEXT, { error: errorMessage });
				return null;
			}
		}
	);

	logger.info('Windows IPC handlers registered', LOG_CONTEXT);
}

/**
 * Notifies a window's renderer that its session list has changed.
 *
 * @param windowId - The window ID
 * @param entry - The WindowEntry
 */
function notifyWindowOfSessionChange(windowId: string, entry: WindowEntry): void {
	try {
		if (!entry.browserWindow.isDestroyed()) {
			entry.browserWindow.webContents.send('windows:sessionsChanged', {
				windowId,
				sessionIds: entry.sessionIds,
				activeSessionId: entry.activeSessionId,
			});
		}
	} catch (error) {
		logger.debug('Failed to notify window of session change', LOG_CONTEXT, {
			windowId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Broadcasts a session moved event to ALL windows.
 * This allows any window to update its UI (e.g., SessionList showing window badges).
 *
 * @param sessionId - The session that was moved
 * @param fromWindowId - The source window ID (empty string if not specified)
 * @param toWindowId - The target window ID
 */
function broadcastSessionMoved(sessionId: string, fromWindowId: string, toWindowId: string): void {
	const allWindows = windowRegistry.getAll();
	const event = {
		sessionId,
		fromWindowId,
		toWindowId,
	};

	logger.debug('Broadcasting sessionMoved event to all windows', LOG_CONTEXT, {
		sessionId,
		fromWindowId: fromWindowId || '(none)',
		toWindowId,
		windowCount: allWindows.length,
	});

	for (const [windowId, entry] of allWindows) {
		try {
			if (!entry.browserWindow.isDestroyed()) {
				entry.browserWindow.webContents.send('windows:sessionMoved', event);
			}
		} catch (error) {
			logger.debug('Failed to broadcast sessionMoved to window', LOG_CONTEXT, {
				windowId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
