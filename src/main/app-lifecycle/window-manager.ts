/**
 * Window manager for creating and managing BrowserWindows.
 * Handles window state persistence, DevTools, and auto-updater initialization.
 * Supports multi-window functionality via WindowRegistry.
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import type Store from 'electron-store';
import type { MultiWindowStoreData, MultiWindowWindowState } from '../stores/types';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';
import {
	windowRegistry,
	type CreateWindowOptions,
	type CreateWindowResult,
	type WindowFactory,
} from '../window-registry';
import { DEFAULT_WINDOW_BOUNDS, MIN_WINDOW_BOUNDS } from '../../shared/types/window';

/** Dependencies for window manager */
export interface WindowManagerDependencies {
	/** Store for multi-window state persistence */
	multiWindowStateStore: Store<MultiWindowStoreData>;
	/** Whether running in development mode */
	isDevelopment: boolean;
	/** Path to the preload script */
	preloadPath: string;
	/** Path to the renderer HTML file (production) */
	rendererPath: string;
	/** Development server URL */
	devServerUrl: string;
}

/** Options for creating a window */
export interface CreateWindowParams {
	/** Optional window ID (generated if not provided) */
	windowId?: string;
	/** Session IDs to open in this window */
	sessionIds?: string[];
	/** ID of the session to make active */
	activeSessionId?: string;
	/** Whether this is the primary window */
	isMain?: boolean;
	/** Window bounds (x, y, width, height) */
	bounds?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
}

/** Result from restoring windows */
export interface RestoreWindowsResult {
	/** The primary window (always returned) */
	primaryWindow: BrowserWindow;
	/** All restored window IDs (includes primary) */
	restoredWindowIds: string[];
	/** Whether windows were restored from saved state (false = fresh start) */
	wasRestored: boolean;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show a window (primary if first, secondary otherwise) */
	createWindow: (params?: CreateWindowParams) => BrowserWindow;
	/** Create a secondary window with specific sessions and bounds */
	createSecondaryWindow: (
		sessionIds?: string[],
		bounds?: { x?: number; y?: number; width?: number; height?: number }
	) => CreateWindowResult;
	/** Get the WindowRegistry for direct access to window management */
	getRegistry: () => typeof windowRegistry;
	/** Save all window states to the store */
	saveAllWindowStates: () => void;
	/**
	 * Restore windows from saved state.
	 * Validates that referenced sessions still exist and filters out deleted ones.
	 * If no saved state exists, creates a single primary window (backward compatible).
	 *
	 * @param existingSessionIds - Array of session IDs that still exist in the sessions store
	 * @returns Result with primary window and restoration details
	 */
	restoreWindows: (existingSessionIds: string[]) => RestoreWindowsResult;
}

/**
 * Creates a window manager for handling BrowserWindows with multi-window support.
 *
 * @param deps - Dependencies for window creation
 * @returns WindowManager instance
 */
export function createWindowManager(deps: WindowManagerDependencies): WindowManager {
	const { multiWindowStateStore, isDevelopment, preloadPath, rendererPath, devServerUrl } = deps;

	// Track if auto-updater has been initialized (only once for primary window)
	let autoUpdaterInitialized = false;

	/**
	 * Gets the app name for window titles.
	 * Uses "Maestro" as the default name.
	 */
	const getAppName = (): string => 'Maestro';

	/**
	 * Creates a BrowserWindow with the standard configuration.
	 * This is the factory function used by WindowRegistry.
	 */
	const windowFactory: WindowFactory = (options: CreateWindowOptions): BrowserWindow => {
		const { windowId, isMain, sessionIds, bounds } = options;

		// Try to restore saved state for this window from the store
		const savedWindows = multiWindowStateStore.get('windows', []);
		const savedState = windowId
			? savedWindows.find((w: MultiWindowWindowState) => w.id === windowId)
			: undefined;

		// Determine window bounds
		const windowBounds = {
			x: bounds?.x ?? savedState?.x,
			y: bounds?.y ?? savedState?.y,
			width: bounds?.width ?? savedState?.width ?? DEFAULT_WINDOW_BOUNDS.width,
			height: bounds?.height ?? savedState?.height ?? DEFAULT_WINDOW_BOUNDS.height,
		};

		// Validate bounds are on a visible display, passing saved display ID for multi-monitor support
		const validatedBounds = validateBoundsOnDisplay(windowBounds, savedState?.displayId);

		const browserWindow = new BrowserWindow({
			x: validatedBounds.x,
			y: validatedBounds.y,
			width: validatedBounds.width,
			height: validatedBounds.height,
			minWidth: MIN_WINDOW_BOUNDS.width,
			minHeight: MIN_WINDOW_BOUNDS.height,
			backgroundColor: '#0b0b0d',
			titleBarStyle: 'hiddenInset',
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		// Restore maximized/fullscreen state after window is created
		if (savedState?.isFullScreen) {
			browserWindow.setFullScreen(true);
		} else if (savedState?.isMaximized) {
			browserWindow.maximize();
		}

		logger.info('Browser window created', 'Window', {
			windowId,
			isMain,
			sessionIds,
			size: `${windowBounds.width}x${windowBounds.height}`,
			maximized: savedState?.isMaximized ?? false,
			fullScreen: savedState?.isFullScreen ?? false,
			savedDisplayId: savedState?.displayId,
			mode: isDevelopment ? 'development' : 'production',
		});

		// Load the app - same for all windows (primary and secondary)
		if (isDevelopment) {
			// Install React DevTools extension in development mode (only once)
			if (isMain) {
				import('electron-devtools-installer')
					.then(({ default: installExtension, REACT_DEVELOPER_TOOLS }) => {
						installExtension(REACT_DEVELOPER_TOOLS)
							.then(() => logger.info('React DevTools extension installed', 'Window'))
							.catch((err: Error) =>
								logger.warn(`Failed to install React DevTools: ${err.message}`, 'Window')
							);
					})
					.catch((err: Error) =>
						logger.warn(`Failed to load electron-devtools-installer: ${err.message}`, 'Window')
					);
			}

			browserWindow.loadURL(devServerUrl);
			logger.info('Loading development server', 'Window', { windowId });
		} else {
			browserWindow.loadFile(rendererPath);
			logger.info('Loading production build', 'Window', { windowId });
			// Open DevTools in production if DEBUG env var is set
			if (process.env.DEBUG === 'true') {
				browserWindow.webContents.openDevTools();
			}
		}

		browserWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window', { windowId, isMain });
		});

		// Set window title for OS identification (Cmd+Tab, Mission Control)
		// Primary window: "Maestro", Secondary windows: "Maestro [2]", "Maestro [3]", etc.
		const appName = getAppName();
		if (isMain) {
			browserWindow.setTitle(appName);
		} else {
			// For secondary windows, compute the window number
			// Count existing windows + 1 (since this window isn't registered yet)
			const existingWindowCount = windowRegistry.getWindowCount();
			const windowNumber = existingWindowCount + 1;
			browserWindow.setTitle(`${appName} [${windowNumber}]`);
		}

		// Initialize auto-updater (only in production, only once for primary window)
		if (isMain && !autoUpdaterInitialized) {
			if (!isDevelopment) {
				initAutoUpdater(browserWindow);
				logger.info('Auto-updater initialized', 'Window');
			} else {
				// Register stub handlers in development mode so users get a helpful error
				registerDevAutoUpdaterStubs();
				logger.info(
					'Auto-updater disabled in development mode (stub handlers registered)',
					'Window'
				);
			}
			autoUpdaterInitialized = true;
		}

		return browserWindow;
	};

	// Set the factory on the registry
	windowRegistry.setWindowFactory(windowFactory);

	/**
	 * Saves all window states to the multi-window store.
	 */
	const saveAllWindowStates = (): void => {
		const allWindows = windowRegistry.getAll();
		const primaryId = windowRegistry.getPrimaryId();

		const windowStates: MultiWindowWindowState[] = allWindows.map(([windowId, entry]) => {
			const bounds = entry.browserWindow.getBounds();
			const isMaximized = entry.browserWindow.isMaximized();
			const isFullScreen = entry.browserWindow.isFullScreen();

			// Get the display ID for multi-monitor support
			const displayId = getDisplayIdForBounds(bounds);

			return {
				id: windowId,
				x: isMaximized || isFullScreen ? bounds.x : bounds.x,
				y: isMaximized || isFullScreen ? bounds.y : bounds.y,
				width: bounds.width,
				height: bounds.height,
				isMaximized,
				isFullScreen,
				sessionIds: entry.sessionIds,
				activeSessionId: entry.activeSessionId,
				leftPanelCollapsed: false, // TODO: Get from renderer state
				rightPanelCollapsed: false, // TODO: Get from renderer state
				displayId,
			};
		});

		multiWindowStateStore.set({
			windows: windowStates,
			primaryWindowId: primaryId || '',
			version: multiWindowStateStore.get('version', 1),
		});

		logger.debug('All window states saved', 'Window', {
			windowCount: windowStates.length,
		});
	};

	/**
	 * Restore windows from saved state.
	 * If no saved state or all saved sessions are deleted, creates a single primary window.
	 */
	const restoreWindows = (existingSessionIds: string[]): RestoreWindowsResult => {
		const savedWindows = multiWindowStateStore.get('windows', []);
		const savedPrimaryId = multiWindowStateStore.get('primaryWindowId', '');

		// No saved state - create fresh primary window
		if (savedWindows.length === 0) {
			logger.info('No saved window state, creating fresh primary window', 'Window');
			const primaryWindow = createWindowWithCloseHandler({});
			return {
				primaryWindow,
				restoredWindowIds: [windowRegistry.getPrimaryId()!],
				wasRestored: false,
			};
		}

		// Convert existingSessionIds to a Set for efficient lookup
		const existingSessionSet = new Set(existingSessionIds);

		// Filter saved windows: validate session IDs exist, and filter out deleted sessions
		const validatedWindows: Array<{
			savedState: MultiWindowWindowState;
			validSessionIds: string[];
			validActiveSessionId?: string;
		}> = [];

		for (const savedWindow of savedWindows) {
			// Filter to only sessions that still exist
			const validSessionIds = savedWindow.sessionIds.filter((id) => existingSessionSet.has(id));

			// Validate active session still exists
			const validActiveSessionId =
				savedWindow.activeSessionId && existingSessionSet.has(savedWindow.activeSessionId)
					? savedWindow.activeSessionId
					: validSessionIds.length > 0
						? validSessionIds[0]
						: undefined;

			validatedWindows.push({
				savedState: savedWindow,
				validSessionIds,
				validActiveSessionId,
			});
		}

		// Find the primary window (must always exist)
		const primaryWindowData = validatedWindows.find((w) => w.savedState.id === savedPrimaryId);

		// If no primary window found, create fresh
		if (!primaryWindowData) {
			logger.warn(
				'Saved primary window not found in saved state, creating fresh primary window',
				'Window'
			);
			const primaryWindow = createWindowWithCloseHandler({});
			return {
				primaryWindow,
				restoredWindowIds: [windowRegistry.getPrimaryId()!],
				wasRestored: false,
			};
		}

		// Create the primary window first
		logger.info('Restoring windows from saved state', 'Window', {
			savedWindowCount: savedWindows.length,
			primaryWindowId: savedPrimaryId,
		});

		const primaryWindow = createWindowWithCloseHandler({
			windowId: primaryWindowData.savedState.id,
			sessionIds: primaryWindowData.validSessionIds,
			activeSessionId: primaryWindowData.validActiveSessionId,
			isMain: true,
			bounds: {
				x: primaryWindowData.savedState.x,
				y: primaryWindowData.savedState.y,
				width: primaryWindowData.savedState.width,
				height: primaryWindowData.savedState.height,
			},
		});

		const restoredWindowIds: string[] = [primaryWindowData.savedState.id];

		// Create secondary windows
		for (const windowData of validatedWindows) {
			// Skip the primary window (already created)
			if (windowData.savedState.id === savedPrimaryId) {
				continue;
			}

			// Only restore secondary windows that have at least one valid session
			// Windows with no sessions will not be restored (those sessions may have been deleted)
			if (windowData.validSessionIds.length === 0) {
				logger.info(
					`Skipping restoration of window ${windowData.savedState.id} - no valid sessions`,
					'Window'
				);
				continue;
			}

			const result = windowRegistry.create({
				windowId: windowData.savedState.id,
				sessionIds: windowData.validSessionIds,
				activeSessionId: windowData.validActiveSessionId,
				isMain: false,
				bounds: {
					x: windowData.savedState.x,
					y: windowData.savedState.y,
					width: windowData.savedState.width,
					height: windowData.savedState.height,
				},
			});

			// Save window state on close
			result.browserWindow.on('close', () => {
				saveAllWindowStates();
			});

			restoredWindowIds.push(windowData.savedState.id);

			logger.info(`Restored secondary window: ${windowData.savedState.id}`, 'Window', {
				sessionCount: windowData.validSessionIds.length,
			});
		}

		logger.info('Window restoration complete', 'Window', {
			restoredCount: restoredWindowIds.length,
			originalCount: savedWindows.length,
		});

		return {
			primaryWindow,
			restoredWindowIds,
			wasRestored: true,
		};
	};

	/**
	 * Helper to create a window and attach the close handler.
	 */
	const createWindowWithCloseHandler = (params: CreateWindowParams): BrowserWindow => {
		const { windowId, sessionIds, activeSessionId, isMain, bounds } = params;

		// Determine if this should be the primary window
		const shouldBeMain = isMain ?? windowRegistry.getWindowCount() === 0;

		const result = windowRegistry.create({
			windowId,
			sessionIds,
			activeSessionId,
			isMain: shouldBeMain,
			bounds,
		});

		// Save window state on close
		result.browserWindow.on('close', () => {
			saveAllWindowStates();
		});

		return result.browserWindow;
	};

	return {
		createWindow: (params: CreateWindowParams = {}): BrowserWindow => {
			return createWindowWithCloseHandler(params);
		},

		createSecondaryWindow: (
			sessionIds?: string[],
			bounds?: { x?: number; y?: number; width?: number; height?: number }
		): CreateWindowResult => {
			// Calculate offset position for new window if no bounds provided
			const offsetBounds = bounds ?? calculateNewWindowPosition();

			const result = windowRegistry.create({
				sessionIds: sessionIds || [],
				isMain: false,
				bounds: offsetBounds,
			});

			// Save window state on close
			result.browserWindow.on('close', () => {
				saveAllWindowStates();
			});

			return result;
		},

		getRegistry: () => windowRegistry,

		saveAllWindowStates,

		restoreWindows,
	};
}

/**
 * Validates that window bounds are on a visible display.
 * If a saved display ID is provided, attempts to restore to that display.
 * If the saved display is no longer available or bounds are off-screen,
 * repositions the window to the primary display gracefully.
 *
 * @param bounds - Window bounds to validate
 * @param savedDisplayId - Optional display ID from saved state
 * @returns Validated bounds positioned on a visible display
 */
function validateBoundsOnDisplay(
	bounds: {
		x?: number;
		y?: number;
		width: number;
		height: number;
	},
	savedDisplayId?: number
): { x?: number; y?: number; width: number; height: number } {
	// If no position specified, let Electron handle it
	if (bounds.x === undefined || bounds.y === undefined) {
		return bounds;
	}

	// Get all displays
	const displays = screen.getAllDisplays();

	// If we have a saved display ID, check if that display still exists
	if (savedDisplayId !== undefined) {
		const savedDisplay = displays.find((d) => d.id === savedDisplayId);
		if (savedDisplay) {
			// Check if the saved position is still valid on the saved display
			const { x, y, width, height } = savedDisplay.bounds;
			const isOnSavedDisplay =
				bounds.x >= x && bounds.x < x + width && bounds.y >= y && bounds.y < y + height;

			if (isOnSavedDisplay) {
				logger.debug('Window restored to saved display', 'Window', {
					displayId: savedDisplayId,
					bounds: { x: bounds.x, y: bounds.y },
				});
				return bounds;
			}

			// Position is not valid on the saved display - restore relative to display
			// This handles cases where the display arrangement changed but display still exists
			logger.info(
				'Window position invalid on saved display, repositioning within display',
				'Window',
				{
					displayId: savedDisplayId,
					savedBounds: { x: bounds.x, y: bounds.y },
					displayBounds: { x, y, width, height },
				}
			);
			return {
				x: x + 100,
				y: y + 100,
				width: bounds.width,
				height: bounds.height,
			};
		} else {
			// Saved display no longer exists - log and fall through to check other displays
			logger.info('Saved display no longer available, finding alternative', 'Window', {
				savedDisplayId,
				availableDisplayIds: displays.map((d) => d.id),
			});
		}
	}

	// Check if the window's top-left corner is on any display
	const isOnDisplay = displays.some((display) => {
		const { x, y, width, height } = display.bounds;
		return bounds.x! >= x && bounds.x! < x + width && bounds.y! >= y && bounds.y! < y + height;
	});

	if (isOnDisplay) {
		return bounds;
	}

	// Window is off-screen, position on primary display
	logger.warn('Window bounds off-screen, repositioning to primary display', 'Window', {
		original: { x: bounds.x, y: bounds.y },
		savedDisplayId,
	});

	const primaryDisplay = screen.getPrimaryDisplay();
	return {
		x: primaryDisplay.bounds.x + 100,
		y: primaryDisplay.bounds.y + 100,
		width: bounds.width,
		height: bounds.height,
	};
}

/**
 * Gets the display ID for a given window bounds.
 * Uses the display that contains the window's center point.
 *
 * @param bounds - The window bounds with x, y position
 * @returns The display ID, or undefined if no display found
 */
function getDisplayIdForBounds(bounds: {
	x: number;
	y: number;
	width: number;
	height: number;
}): number | undefined {
	try {
		// Calculate center point of window
		const centerX = bounds.x + bounds.width / 2;
		const centerY = bounds.y + bounds.height / 2;

		// Get the display at the window's center point
		const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
		return display?.id;
	} catch (error) {
		logger.warn('Failed to get display ID for window bounds', 'Window', { error, bounds });
		return undefined;
	}
}

/**
 * Calculates position for a new window, offset from the focused window.
 */
function calculateNewWindowPosition(): { x: number; y: number; width: number; height: number } {
	const focusedWindow = BrowserWindow.getFocusedWindow();
	const offset = 30;

	if (focusedWindow) {
		const [x, y] = focusedWindow.getPosition();
		return {
			x: x + offset,
			y: y + offset,
			width: DEFAULT_WINDOW_BOUNDS.width,
			height: DEFAULT_WINDOW_BOUNDS.height,
		};
	}

	// No focused window, use primary display center
	const primaryDisplay = screen.getPrimaryDisplay();
	const { width: screenWidth, height: screenHeight } = primaryDisplay.bounds;

	return {
		x: Math.round((screenWidth - DEFAULT_WINDOW_BOUNDS.width) / 2),
		y: Math.round((screenHeight - DEFAULT_WINDOW_BOUNDS.height) / 2),
		width: DEFAULT_WINDOW_BOUNDS.width,
		height: DEFAULT_WINDOW_BOUNDS.height,
	};
}

// Track if stub handlers have been registered (module-level to persist across createWindow calls)
let devStubsRegistered = false;

/**
 * Registers stub IPC handlers for auto-updater in development mode.
 * These provide helpful error messages instead of silent failures.
 * Uses a module-level flag to ensure handlers are only registered once.
 */
function registerDevAutoUpdaterStubs(): void {
	// Only register once - prevents duplicate handler errors if createWindow is called multiple times
	if (devStubsRegistered) {
		logger.debug('Auto-updater stub handlers already registered, skipping', 'Window');
		return;
	}

	ipcMain.handle('updates:download', async () => {
		return {
			success: false,
			error: 'Auto-update is disabled in development mode. Please check update first.',
		};
	});

	ipcMain.handle('updates:install', async () => {
		logger.warn('Auto-update install called in development mode', 'AutoUpdater');
	});

	ipcMain.handle('updates:getStatus', async () => {
		return { status: 'idle' as const };
	});

	ipcMain.handle('updates:checkAutoUpdater', async () => {
		return { success: false, error: 'Auto-update is disabled in development mode' };
	});

	devStubsRegistered = true;
}
