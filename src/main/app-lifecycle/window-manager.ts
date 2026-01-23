/**
 * Window manager for creating and managing the main BrowserWindow.
 * Handles window state persistence, DevTools, and auto-updater initialization.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type Store from 'electron-store';
import type { WindowState } from '../stores/types';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';

/** Dependencies for window manager */
export interface WindowManagerDependencies {
	/** Store for window state persistence */
	windowStateStore: Store<WindowState>;
	/** Whether running in development mode */
	isDevelopment: boolean;
	/** Path to the preload script */
	preloadPath: string;
	/** Path to the renderer HTML file (production) */
	rendererPath: string;
	/** Development server URL */
	devServerUrl: string;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show the main window */
	createWindow: () => BrowserWindow;
}

/**
 * Creates a window manager for handling the main BrowserWindow.
 *
 * @param deps - Dependencies for window creation
 * @returns WindowManager instance
 */
export function createWindowManager(deps: WindowManagerDependencies): WindowManager {
	const { windowStateStore, isDevelopment, preloadPath, rendererPath, devServerUrl } = deps;

	return {
		createWindow: (): BrowserWindow => {
			// Restore saved window state
			const savedState = windowStateStore.store;

			const mainWindow = new BrowserWindow({
				x: savedState.x,
				y: savedState.y,
				width: savedState.width,
				height: savedState.height,
				minWidth: 1000,
				minHeight: 600,
				backgroundColor: '#0b0b0d',
				titleBarStyle: 'hiddenInset',
				webPreferences: {
					preload: preloadPath,
					contextIsolation: true,
					nodeIntegration: false,
				},
			});

			// Restore maximized/fullscreen state after window is created
			if (savedState.isFullScreen) {
				mainWindow.setFullScreen(true);
			} else if (savedState.isMaximized) {
				mainWindow.maximize();
			}

			logger.info('Browser window created', 'Window', {
				size: `${savedState.width}x${savedState.height}`,
				maximized: savedState.isMaximized,
				fullScreen: savedState.isFullScreen,
				mode: isDevelopment ? 'development' : 'production',
			});

			// Save window state before closing
			const saveWindowState = () => {
				const isMaximized = mainWindow.isMaximized();
				const isFullScreen = mainWindow.isFullScreen();
				const bounds = mainWindow.getBounds();

				// Only save bounds if not maximized/fullscreen (to restore proper size later)
				if (!isMaximized && !isFullScreen) {
					windowStateStore.set('x', bounds.x);
					windowStateStore.set('y', bounds.y);
					windowStateStore.set('width', bounds.width);
					windowStateStore.set('height', bounds.height);
				}
				windowStateStore.set('isMaximized', isMaximized);
				windowStateStore.set('isFullScreen', isFullScreen);
			};

			mainWindow.on('close', saveWindowState);

			// Load the app
			if (isDevelopment) {
				// Install React DevTools extension in development mode
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

				mainWindow.loadURL(devServerUrl);
				// DevTools can be opened via Command-K menu instead of automatically on startup
				logger.info('Loading development server', 'Window');
			} else {
				mainWindow.loadFile(rendererPath);
				logger.info('Loading production build', 'Window');
				// Open DevTools in production if DEBUG env var is set
				if (process.env.DEBUG === 'true') {
					mainWindow.webContents.openDevTools();
				}
			}

			mainWindow.on('closed', () => {
				logger.info('Browser window closed', 'Window');
			});

			// Initialize auto-updater (only in production)
			if (!isDevelopment) {
				initAutoUpdater(mainWindow);
				logger.info('Auto-updater initialized', 'Window');
			} else {
				// Register stub handlers in development mode so users get a helpful error
				registerDevAutoUpdaterStubs();
				logger.info(
					'Auto-updater disabled in development mode (stub handlers registered)',
					'Window'
				);
			}

			return mainWindow;
		},
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
