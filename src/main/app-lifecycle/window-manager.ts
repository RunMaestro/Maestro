/**
 * Window manager for creating and managing the main BrowserWindow.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type Store from 'electron-store';
import type { WindowState } from '../stores/types';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';

/** Sentry severity levels */
type SentrySeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/** Sentry module type for crash reporting */
interface SentryModule {
	captureMessage: (
		message: string,
		captureContext?: { level?: SentrySeverityLevel; extra?: Record<string, unknown> }
	) => string;
}

/** Cached Sentry module reference */
let sentryModule: SentryModule | null = null;

/**
 * Reports a crash event to Sentry from the main process.
 * Lazily loads Sentry to avoid module initialization issues.
 */
async function reportCrashToSentry(
	message: string,
	level: SentrySeverityLevel,
	extra?: Record<string, unknown>
): Promise<void> {
	try {
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.captureMessage(message, { level, extra });
	} catch {
		// Sentry not available (development mode or initialization failed)
		logger.debug('Sentry not available for crash reporting', 'Window');
	}
}

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
	/** Whether to use the native OS title bar instead of custom title bar */
	useNativeTitleBar: boolean;
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
	const { windowStateStore, isDevelopment, preloadPath, rendererPath, devServerUrl, useNativeTitleBar } = deps;

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
				...(useNativeTitleBar ? {} : { titleBarStyle: 'hiddenInset' as const }),
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

			// ================================================================
			// Renderer Process Crash Detection
			// ================================================================
			// These handlers capture crashes that Sentry in the renderer cannot
			// report (because the renderer process is dead or broken).

			// Handle renderer process termination (crash, kill, OOM, etc.)
			mainWindow.webContents.on('render-process-gone', (_event, details) => {
				logger.error('Renderer process gone', 'Window', {
					reason: details.reason,
					exitCode: details.exitCode,
				});

				// Report to Sentry from main process (always available)
				reportCrashToSentry(`Renderer process gone: ${details.reason}`, 'fatal', {
					reason: details.reason,
					exitCode: details.exitCode,
				});

				// Auto-reload unless the process was intentionally killed
				if (details.reason !== 'killed' && details.reason !== 'clean-exit') {
					logger.info('Attempting to reload renderer after crash', 'Window');
					setTimeout(() => {
						if (!mainWindow.isDestroyed()) {
							mainWindow.webContents.reload();
						}
					}, 1000);
				}
			});

			// Handle window becoming unresponsive (frozen renderer)
			mainWindow.on('unresponsive', () => {
				logger.warn('Window became unresponsive', 'Window');
				reportCrashToSentry('Window unresponsive', 'warning', {
					memoryUsage: process.memoryUsage(),
				});
			});

			// Log when window recovers from unresponsive state
			mainWindow.on('responsive', () => {
				logger.info('Window became responsive again', 'Window');
			});

			// Handle page crashes (less severe than render-process-gone)
			mainWindow.webContents.on('crashed', (_event, killed) => {
				logger.error('WebContents crashed', 'Window', { killed });
				reportCrashToSentry('WebContents crashed', killed ? 'warning' : 'error', { killed });
			});

			// Handle page load failures (network issues, invalid URLs, etc.)
			mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
				// Ignore aborted loads (user navigated away)
				if (errorCode === -3) return;

				logger.error('Page failed to load', 'Window', {
					errorCode,
					errorDescription,
					url: validatedURL,
				});
				reportCrashToSentry(`Page failed to load: ${errorDescription}`, 'error', {
					errorCode,
					errorDescription,
					url: validatedURL,
				});
			});

			// Handle preload script errors
			mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
				logger.error('Preload script error', 'Window', {
					preloadPath,
					error: error.message,
					stack: error.stack,
				});
				reportCrashToSentry('Preload script error', 'fatal', {
					preloadPath,
					error: error.message,
					stack: error.stack,
				});
			});

			// Forward renderer console errors to main process logger and Sentry
			// This catches errors that happen before or outside React's error boundary
			mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
				// Level 2 = error (0=verbose, 1=info, 2=warning, 3=error)
				if (level === 3) {
					logger.error(`Renderer console error: ${message}`, 'Window', {
						line,
						source: sourceId,
					});

					// Report critical errors to Sentry
					// Filter out common noise (React dev warnings, etc.)
					const isCritical =
						message.includes('Uncaught') ||
						message.includes('TypeError') ||
						message.includes('ReferenceError') ||
						message.includes('Cannot read') ||
						message.includes('is not defined') ||
						message.includes('is not a function');

					if (isCritical) {
						reportCrashToSentry(`Renderer error: ${message}`, 'error', {
							line,
							source: sourceId,
						});
					}
				}
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
