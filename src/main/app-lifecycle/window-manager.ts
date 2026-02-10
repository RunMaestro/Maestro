/**
 * Window manager for creating and managing application BrowserWindows.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 */

import { randomUUID } from 'crypto';

import { ipcMain } from 'electron';
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from 'electron';
import type Store from 'electron-store';

import type { WindowState as WindowStateStoreShape } from '../stores/types';
import type {
	MultiWindowState as PersistedMultiWindowState,
	WindowState as PersistedWindowState,
} from '../../shared/types/window';
import { WindowRegistry } from '../window-registry';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';
import { WINDOW_STATE_DEFAULTS } from '../stores/defaults';

/** Window bounds override shape */
type WindowBounds = Partial<Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>>;

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
	windowStateStore: Store<WindowStateStoreShape>;
	/** Whether running in development mode */
	isDevelopment: boolean;
	/** Path to the preload script */
	preloadPath: string;
	/** Path to the renderer HTML file (production) */
	rendererPath: string;
	/** Development server URL */
	devServerUrl: string;
	/** Shared window registry (optional for backwards compatibility) */
	windowRegistry?: WindowRegistry;
}

export interface CreateWindowOptions {
	windowId?: string;
	sessionIds?: string[];
	bounds?: WindowBounds;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show a BrowserWindow */
	createWindow: (options?: CreateWindowOptions) => BrowserWindow;
	/** Create a new secondary BrowserWindow */
	createSecondaryWindow: (sessionIds?: string[], bounds?: WindowBounds) => BrowserWindow;
}

const DEFAULT_WINDOW_TEMPLATE: PersistedWindowState = {
	id: WINDOW_STATE_DEFAULTS.multiWindowState?.primaryWindowId ?? 'primary',
	x: undefined,
	y: undefined,
	width: WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.width ?? WINDOW_STATE_DEFAULTS.width,
	height: WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.height ?? WINDOW_STATE_DEFAULTS.height,
	isMaximized:
		WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.isMaximized ??
		WINDOW_STATE_DEFAULTS.isMaximized,
	isFullScreen:
		WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.isFullScreen ??
		WINDOW_STATE_DEFAULTS.isFullScreen,
	sessionIds: [],
	activeSessionId: null,
	leftPanelCollapsed:
		WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.leftPanelCollapsed ?? false,
	rightPanelCollapsed:
		WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0]?.rightPanelCollapsed ?? false,
};

/**
 * Creates a window manager for handling BrowserWindows.
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
		windowRegistry: providedWindowRegistry,
	} = deps;

	const windowRegistry = providedWindowRegistry ?? new WindowRegistry();

	const createWindow = (options: CreateWindowOptions = {}): BrowserWindow => {
		const { windowId, sessionIds, bounds } = options;
		const multiWindowState = getMultiWindowState(windowStateStore);
		const resolvedWindowId = windowId ?? multiWindowState.primaryWindowId ?? DEFAULT_WINDOW_TEMPLATE.id;
		const savedWindowState =
			findWindowState(multiWindowState, resolvedWindowId) ?? createDefaultWindowState(resolvedWindowId);
		const resolvedSessionIds = sessionIds ?? savedWindowState.sessionIds ?? [];

		if (sessionIds || !savedWindowState.sessionIds.length) {
			persistWindowStatePartial(windowStateStore, resolvedWindowId, {
				sessionIds: resolvedSessionIds,
				activeSessionId: savedWindowState.activeSessionId ?? resolvedSessionIds[0] ?? null,
			});
		}

		if (bounds) {
			const boundsUpdates = buildBoundsUpdates(bounds);
			if (Object.keys(boundsUpdates).length > 0) {
				persistWindowStatePartial(windowStateStore, resolvedWindowId, boundsUpdates);
			}
		}

		const browserWindowOptions = buildBrowserWindowOptions(savedWindowState, bounds, preloadPath);

		const browserWindow = windowRegistry.create({
			windowId: resolvedWindowId,
			browserWindowOptions,
			isMain: resolvedWindowId === multiWindowState.primaryWindowId,
			sessionIds: resolvedSessionIds,
		});

		// Restore maximized/fullscreen state after window is created
		if (savedWindowState.isFullScreen) {
			browserWindow.setFullScreen(true);
		} else if (savedWindowState.isMaximized) {
			browserWindow.maximize();
		}

		logger.info('Browser window created', 'Window', {
			windowId: resolvedWindowId,
			size: `${browserWindowOptions.width}x${browserWindowOptions.height}`,
			maximized: savedWindowState.isMaximized,
			fullScreen: savedWindowState.isFullScreen,
			mode: isDevelopment ? 'development' : 'production',
		});

		// Save window state before closing
		const saveWindowState = () => {
			try {
				const isMaximized = browserWindow.isMaximized();
				const isFullScreen = browserWindow.isFullScreen();
				const bounds = browserWindow.getBounds();

				const stateUpdates: Partial<PersistedWindowState> = {
					isMaximized,
					isFullScreen,
				};

				if (!isMaximized && !isFullScreen) {
					stateUpdates.x = bounds.x;
					stateUpdates.y = bounds.y;
					stateUpdates.width = bounds.width;
					stateUpdates.height = bounds.height;
				}

				persistWindowStatePartial(windowStateStore, resolvedWindowId, stateUpdates);
			} catch {
				// Ignore ENFILE/ENOSPC errors during window close — non-critical
			}
		};

		browserWindow.on('close', saveWindowState);

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

			browserWindow.loadURL(devServerUrl);
			// DevTools can be opened via Command-K menu instead of automatically on startup
			logger.info('Loading development server', 'Window');
		} else {
			browserWindow.loadFile(rendererPath);
			logger.info('Loading production build', 'Window');
			// Open DevTools in production if DEBUG env var is set
			if (process.env.DEBUG === 'true') {
				browserWindow.webContents.openDevTools();
			}
		}

		browserWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window', { windowId: resolvedWindowId });
		});

		// ================================================================
		// Renderer Process Crash Detection
		// ================================================================
		// These handlers capture crashes that Sentry in the renderer cannot
		// report (because the renderer process is dead or broken).

		// Handle renderer process termination (crash, kill, OOM, etc.)
		browserWindow.webContents.on('render-process-gone', (_event, details) => {
			logger.error('Renderer process gone', 'Window', {
				windowId: resolvedWindowId,
				reason: details.reason,
				exitCode: details.exitCode,
			});

			// Report to Sentry from main process (always available)
			reportCrashToSentry(`Renderer process gone: ${details.reason}`, 'fatal', {
				windowId: resolvedWindowId,
				reason: details.reason,
				exitCode: details.exitCode,
			});

			// Auto-reload unless the process was intentionally killed
			if (details.reason !== 'killed' && details.reason !== 'clean-exit') {
				logger.info('Attempting to reload renderer after crash', 'Window');
				setTimeout(() => {
					if (!browserWindow.isDestroyed()) {
						browserWindow.webContents.reload();
					}
				}, 1000);
			}
		});

		// Handle window becoming unresponsive (frozen renderer)
		browserWindow.on('unresponsive', () => {
			logger.warn('Window became unresponsive', 'Window', { windowId: resolvedWindowId });
			reportCrashToSentry('Window unresponsive', 'warning', {
				windowId: resolvedWindowId,
				memoryUsage: process.memoryUsage(),
			});
		});

		// Log when window recovers from unresponsive state
		browserWindow.on('responsive', () => {
			logger.info('Window became responsive again', 'Window', { windowId: resolvedWindowId });
		});

		// Handle page crashes (less severe than render-process-gone)
		browserWindow.webContents.on('crashed', (_event, killed) => {
			logger.error('WebContents crashed', 'Window', { killed, windowId: resolvedWindowId });
			reportCrashToSentry('WebContents crashed', killed ? 'warning' : 'error', {
				killed,
				windowId: resolvedWindowId,
			});
		});

		// Handle page load failures (network issues, invalid URLs, etc.)
		browserWindow.webContents.on(
			'did-fail-load',
			(_event, errorCode, errorDescription, validatedURL) => {
				// Ignore aborted loads (user navigated away)
				if (errorCode === -3) return;

				logger.error('Page failed to load', 'Window', {
					windowId: resolvedWindowId,
					errorCode,
					errorDescription,
					url: validatedURL,
				});
				reportCrashToSentry(`Page failed to load: ${errorDescription}`, 'error', {
					windowId: resolvedWindowId,
					errorCode,
					errorDescription,
					url: validatedURL,
				});
			}
		);

		// Handle preload script errors
		browserWindow.webContents.on('preload-error', (_event, preloadPathParam, error) => {
			logger.error('Preload script error', 'Window', {
				windowId: resolvedWindowId,
				preloadPath: preloadPathParam,
				error: error.message,
				stack: error.stack,
			});
			reportCrashToSentry('Preload script error', 'fatal', {
				windowId: resolvedWindowId,
				preloadPath: preloadPathParam,
				error: error.message,
				stack: error.stack,
			});
		});

		// Forward renderer console errors to main process logger and Sentry
		// This catches errors that happen before or outside React's error boundary
		browserWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
			// Level 2 = error (0=verbose, 1=info, 2=warning, 3=error)
			if (level === 3) {
				logger.error(`Renderer console error: ${message}`, 'Window', {
					windowId: resolvedWindowId,
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
						windowId: resolvedWindowId,
						line,
						source: sourceId,
					});
				}
			}
		});

		// Initialize auto-updater (only in production)
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

		return browserWindow;
	};

	const createSecondaryWindow = (
		sessionIds: string[] = [],
		bounds?: WindowBounds
	): BrowserWindow => {
		const newWindowId = randomUUID();
		const partialUpdates: Partial<PersistedWindowState> = {
			sessionIds,
			activeSessionId: sessionIds[0] ?? null,
		};

		const boundsUpdates = buildBoundsUpdates(bounds);
		if (Object.keys(boundsUpdates).length > 0) {
			Object.assign(partialUpdates, boundsUpdates);
		}

		persistWindowStatePartial(windowStateStore, newWindowId, partialUpdates);
		return createWindow({ windowId: newWindowId, sessionIds, bounds });
	};

	return {
		createWindow,
		createSecondaryWindow,
	};
}

function findWindowState(
	multiWindowState: PersistedMultiWindowState,
	windowId: string
): PersistedWindowState | undefined {
	return multiWindowState.windows.find((window) => window.id === windowId);
}

function createDefaultWindowState(windowId: string): PersistedWindowState {
	return {
		...DEFAULT_WINDOW_TEMPLATE,
		id: windowId,
		// Ensure session metadata is reset per window
		sessionIds: [],
		activeSessionId: null,
	};
}

function getMultiWindowState(
	windowStateStore: Store<WindowStateStoreShape>
): PersistedMultiWindowState {
	return (
		windowStateStore.get('multiWindowState') ??
		windowStateStore.store.multiWindowState ?? {
			primaryWindowId: DEFAULT_WINDOW_TEMPLATE.id,
			windows: [createDefaultWindowState(DEFAULT_WINDOW_TEMPLATE.id)],
		}
	);
}

function buildBrowserWindowOptions(
	savedWindowState: PersistedWindowState,
	bounds: WindowBounds | undefined,
	preloadPath: string
): BrowserWindowConstructorOptions {
	const resolvedBounds = {
		x: bounds?.x ?? savedWindowState.x,
		y: bounds?.y ?? savedWindowState.y,
		width: bounds?.width ?? savedWindowState.width,
		height: bounds?.height ?? savedWindowState.height,
	};

	return {
		x: resolvedBounds.x,
		y: resolvedBounds.y,
		width: resolvedBounds.width,
		height: resolvedBounds.height,
		minWidth: 1000,
		minHeight: 600,
		backgroundColor: '#0b0b0d',
		titleBarStyle: 'hiddenInset',
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	};
}

function buildBoundsUpdates(bounds?: WindowBounds): Partial<PersistedWindowState> {
	const updates: Partial<PersistedWindowState> = {};

	if (!bounds) {
		return updates;
	}

	if (typeof bounds.x === 'number') {
		updates.x = bounds.x;
	}

	if (typeof bounds.y === 'number') {
		updates.y = bounds.y;
	}

	if (typeof bounds.width === 'number') {
		updates.width = bounds.width;
	}

	if (typeof bounds.height === 'number') {
		updates.height = bounds.height;
	}

	return updates;
}


function persistWindowStatePartial(
	windowStateStore: Store<WindowStateStoreShape>,
	windowId: string,
	updates: Partial<PersistedWindowState>
): void {
	const multiWindowState = getMultiWindowState(windowStateStore);
	const existingState = findWindowState(multiWindowState, windowId) ?? createDefaultWindowState(windowId);
	const mergedState: PersistedWindowState = {
		...existingState,
		...updates,
	};

	const windowExists = multiWindowState.windows.some((window) => window.id === windowId);
	const nextWindows = windowExists
		? multiWindowState.windows.map((window) => (window.id === windowId ? mergedState : window))
		: [...multiWindowState.windows, mergedState];

	const nextState: PersistedMultiWindowState = {
		...multiWindowState,
		windows: nextWindows,
	};

	windowStateStore.set('multiWindowState', nextState);

	if (windowId === multiWindowState.primaryWindowId) {
		syncLegacyWindowState(windowStateStore, mergedState, updates);
	}
}

function syncLegacyWindowState(
	windowStateStore: Store<WindowStateStoreShape>,
	windowState: PersistedWindowState,
	updates: Partial<PersistedWindowState>
): void {
	if ('x' in updates && typeof windowState.x === 'number') {
		windowStateStore.set('x', windowState.x);
	}
	if ('y' in updates && typeof windowState.y === 'number') {
		windowStateStore.set('y', windowState.y);
	}
	if ('width' in updates) {
		windowStateStore.set('width', windowState.width);
	}
	if ('height' in updates) {
		windowStateStore.set('height', windowState.height);
	}
	if ('isMaximized' in updates) {
		windowStateStore.set('isMaximized', windowState.isMaximized);
	}
	if ('isFullScreen' in updates) {
		windowStateStore.set('isFullScreen', windowState.isFullScreen);
	}
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
