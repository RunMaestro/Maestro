/**
 * Window manager for creating and managing the main BrowserWindow.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 */

import * as path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from '../stores/types';
import type { WindowInfo, WindowSessionsMovedToPrimaryEvent } from '../../shared/types/window';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';
import { WindowRegistry } from '../window-registry';
import { recordMultiWindowUsage, type StatsSettingsReader } from '../stats/multi-window-recorder';

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

type WindowBounds = Pick<WindowState, 'x' | 'y' | 'width' | 'height'>;

function createDefaultWindowState(id: string): WindowState {
	return {
		id,
		x: 0,
		y: 0,
		width: 1400,
		height: 900,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

function getPrimaryWindowState(state: MultiWindowState): WindowState {
	return (
		state.windows.find((windowState) => windowState.id === state.primaryWindowId) ||
		state.windows[0] ||
		createDefaultWindowState('primary')
	);
}

function getWindowState(state: MultiWindowState, windowId?: string): WindowState {
	if (!windowId) {
		return getPrimaryWindowState(state);
	}

	return (
		state.windows.find((windowState) => windowState.id === windowId) ||
		createDefaultWindowState(windowId)
	);
}

function appendWindowIdToUrl(url: string, windowId: string): string {
	const parsedUrl = new URL(url);
	parsedUrl.searchParams.set('windowId', windowId);
	return parsedUrl.toString();
}

function findStoredWindowState(
	windowStateStore: Store<MultiWindowState>,
	windowId: string
): WindowState | undefined {
	return windowStateStore.store.windows.find((windowState) => windowState.id === windowId);
}

function getWindowList(
	windowRegistry: WindowRegistry,
	windowStateStore: Store<MultiWindowState>
): WindowInfo[] {
	return windowRegistry.getEntries().map(([windowId, entry]) => {
		const storedState = findStoredWindowState(windowStateStore, windowId);
		return {
			id: windowId,
			isMain: entry.isMain,
			sessionIds: entry.sessionIds,
			activeSessionId: storedState?.activeSessionId ?? null,
		};
	});
}

function broadcastSessionsMovedToPrimary(
	windowRegistry: WindowRegistry,
	payload: WindowSessionsMovedToPrimaryEvent
): void {
	for (const entry of windowRegistry.getAll()) {
		if (entry.browserWindow.isDestroyed() || entry.browserWindow.webContents.isDestroyed()) {
			continue;
		}
		entry.browserWindow.webContents.send('windows:sessionsMovedToPrimary', payload);
	}
}

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
	windowStateStore: Store<MultiWindowState>;
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
	/** Whether to auto-hide the menu bar (Linux/Windows) */
	autoHideMenuBar: boolean;
	/** Registry for tracking all open windows */
	windowRegistry?: WindowRegistry;
	/** Whether the app is in the confirmed quit path */
	isQuitting?: () => boolean;
	/** Settings store for stats collection gating */
	settingsStore?: StatsSettingsReader;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show a window */
	createWindow: (windowId?: string, sessionIds?: string[]) => BrowserWindow;
	/** Create a secondary window for the provided sessions */
	createSecondaryWindow: (sessionIds: string[], bounds: Partial<WindowBounds>) => BrowserWindow;
	/** Registry tracking all open windows */
	windowRegistry: WindowRegistry;
}

/**
 * Creates a window manager for handling the main BrowserWindow.
 *
 * @param deps - Dependencies for window creation
 * @returns WindowManager instance
 */
export function createWindowManager(deps: WindowManagerDependencies): WindowManager {
	const {
		windowStateStore,
		isDevelopment,
		preloadPath,
		rendererPath,
		devServerUrl,
		useNativeTitleBar,
		autoHideMenuBar,
	} = deps;
	const windowRegistry = deps.windowRegistry ?? new WindowRegistry();
	windowRegistry.setWindowStateStore(windowStateStore);

	const createBrowserWindow = (
		savedState: WindowState,
		options: {
			windowId?: string;
			sessionIds?: string[];
			bounds?: Partial<WindowBounds>;
			isMain?: boolean;
		} = {}
	): BrowserWindow => {
		const windowOptions: BrowserWindowConstructorOptions = {
			x: options.bounds?.x ?? savedState.x,
			y: options.bounds?.y ?? savedState.y,
			width: options.bounds?.width ?? savedState.width,
			height: options.bounds?.height ?? savedState.height,
			minWidth: 1000,
			minHeight: 600,
			backgroundColor: '#0b0b0d',
			...(useNativeTitleBar ? {} : { titleBarStyle: 'hiddenInset' as const }),
			...(autoHideMenuBar ? { autoHideMenuBar: true } : {}),
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		};

		const entry = windowRegistry.create({
			...windowOptions,
			id: options.windowId,
			sessionIds: options.sessionIds ?? savedState.sessionIds,
			isMain: options.isMain,
		});
		const mainWindow = entry.browserWindow;
		const registryWindowId = options.windowId ?? String(mainWindow.id);

		// Restore maximized/fullscreen state after window is created
		if (savedState.isFullScreen) {
			mainWindow.setFullScreen(true);
		} else if (savedState.isMaximized) {
			mainWindow.maximize();
		}

		logger.info('Browser window created', 'Window', {
			id: registryWindowId,
			size: `${windowOptions.width}x${windowOptions.height}`,
			maximized: savedState.isMaximized,
			fullScreen: savedState.isFullScreen,
			mode: isDevelopment ? 'development' : 'production',
		});

		const saveWindowState = () => {
			try {
				windowRegistry.saveWindowState(registryWindowId);
			} catch {
				// Ignore ENFILE/ENOSPC errors during window close — non-critical
			}
		};
		let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
		const scheduleWindowStateSave = () => {
			if (saveWindowStateTimer) {
				clearTimeout(saveWindowStateTimer);
			}
			saveWindowStateTimer = setTimeout(() => {
				saveWindowStateTimer = null;
				saveWindowState();
			}, 250);
		};

		mainWindow.on('close', () => {
			if (!entry.isMain && !(deps.isQuitting?.() ?? false)) {
				const transfer = windowRegistry.moveSessionsToPrimary(registryWindowId);
				if (transfer) {
					windowRegistry.saveWindowState(transfer.toWindowId);
					broadcastSessionsMovedToPrimary(windowRegistry, {
						sessionIds: transfer.sessionIds,
						fromWindowId: registryWindowId,
						toWindowId: transfer.toWindowId,
						windows: getWindowList(windowRegistry, windowStateStore),
					});
				}
				recordMultiWindowUsage(
					deps.settingsStore,
					windowRegistry,
					'window_closed',
					Math.max(0, windowRegistry.getAll().length - 1)
				);
			}

			saveWindowState();
		});
		mainWindow.on('move', scheduleWindowStateSave);
		mainWindow.on('resize', scheduleWindowStateSave);
		mainWindow.on('maximize', scheduleWindowStateSave);
		mainWindow.on('unmaximize', scheduleWindowStateSave);
		mainWindow.on('enter-full-screen', scheduleWindowStateSave);
		mainWindow.on('leave-full-screen', scheduleWindowStateSave);

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

			mainWindow.loadURL(appendWindowIdToUrl(devServerUrl, registryWindowId));
			// DevTools can be opened via Command-K menu instead of automatically on startup
			logger.info('Loading development server', 'Window');
		} else {
			mainWindow.loadFile(rendererPath, { query: { windowId: registryWindowId } });
			logger.info('Loading production build', 'Window');
			// Open DevTools in production if DEBUG env var is set
			if (process.env.DEBUG === 'true') {
				mainWindow.webContents.openDevTools();
			}
		}

		// ================================================================
		// Navigation & Window Security Hardening
		// ================================================================

		// Deny all popup/new-window requests — external links use IPC shell:openExternal
		mainWindow.webContents.setWindowOpenHandler(({ url }) => {
			logger.warn(`Blocked window.open request: ${url}`, 'Window');
			return { action: 'deny' };
		});

		// Restrict navigation to the app itself — prevent renderer from navigating away
		mainWindow.webContents.on('will-navigate', (event, url) => {
			const parsedUrl = new URL(url);
			if (isDevelopment) {
				// In dev mode, allow Vite dev server navigation
				const devUrl = new URL(devServerUrl);
				if (parsedUrl.origin === devUrl.origin) return;
			} else {
				// In production, only allow file:// URLs within the app's renderer directory
				if (
					parsedUrl.protocol === 'file:' &&
					url.includes(path.dirname(rendererPath).replace(/\\/g, '/'))
				)
					return;
			}
			event.preventDefault();
			logger.warn(`Blocked navigation to: ${url}`, 'Window');
		});

		// Deny most browser permission requests (camera, mic, geolocation, etc.)
		// Allow clipboard access for copy-to-clipboard functionality
		mainWindow.webContents.session.setPermissionRequestHandler(
			(_webContents, permission, callback) => {
				if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
					callback(true);
				} else {
					callback(false);
				}
			}
		);

		mainWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window');
			if (!entry.isMain && !(deps.isQuitting?.() ?? false)) {
				windowRegistry.removeWindowState(registryWindowId);
			}
			windowRegistry.remove(registryWindowId);
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
		mainWindow.webContents.on(
			'did-fail-load',
			(_event, errorCode, errorDescription, validatedURL) => {
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
			}
		);

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
			logger.info('Auto-updater disabled in development mode (stub handlers registered)', 'Window');
		}

		return mainWindow;
	};

	return {
		createWindow: (windowId?: string, sessionIds?: string[]): BrowserWindow => {
			const savedState = getWindowState(windowStateStore.store, windowId);
			return createBrowserWindow(savedState, {
				windowId: windowId ?? savedState.id,
				sessionIds,
				isMain: windowRegistry.getPrimary() === undefined,
			});
		},
		createSecondaryWindow: (
			sessionIds: string[],
			bounds: Partial<WindowBounds> = {}
		): BrowserWindow => {
			return createBrowserWindow(createDefaultWindowState('secondary'), {
				sessionIds,
				bounds,
				isMain: false,
			});
		},
		windowRegistry,
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
