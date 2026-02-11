/**
 * Application quit handler.
 * Manages quit confirmation flow and cleanup on application exit.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import type Store from 'electron-store';
import { logger } from '../utils/logger';
import type { ProcessManager } from '../process-manager';
import type { WebServer } from '../web-server';
import { tunnelManager as tunnelManagerInstance } from '../tunnel-manager';
import type { HistoryManager } from '../history-manager';
import type { WindowRegistry } from '../window-registry';
import type { WindowState as WindowStateStoreShape } from '../stores/types';
import type {
	MultiWindowState as PersistedMultiWindowState,
	WindowState as PersistedWindowState,
} from '../../shared/types/window';
import { WINDOW_STATE_DEFAULTS } from '../stores/defaults';
import { isWebContentsAvailable } from '../utils/safe-send';

/** Dependencies for quit handler */
export interface QuitHandlerDependencies {
	/** Function to get the main window */
	getMainWindow: () => BrowserWindow | null;
	/** Function to get the process manager */
	getProcessManager: () => ProcessManager | null;
	/** Function to get the web server (may be null if not started) */
	getWebServer: () => WebServer | null;
	/** Function to get the history manager */
	getHistoryManager: () => HistoryManager;
	/** Tunnel manager instance */
	tunnelManager: typeof tunnelManagerInstance;
	/** Function to get active grooming session count */
	getActiveGroomingSessionCount: () => number;
	/** Function to cleanup all grooming sessions */
	cleanupAllGroomingSessions: (pm: ProcessManager) => Promise<void>;
	/** Function to close the stats database */
	closeStatsDB: () => void;
	/** Function to get the window registry */
	getWindowRegistry: () => WindowRegistry | null;
	/** Store for window state persistence */
	windowStateStore: Store<WindowStateStoreShape>;
	/** Function to stop CLI watcher (optional, may not be started yet) */
	stopCliWatcher?: () => void;
}

/** Quit handler state */
interface QuitHandlerState {
	/** Whether quit has been confirmed by user (or no busy agents) */
	quitConfirmed: boolean;
	/** Whether we're currently waiting for quit confirmation from renderer */
	isRequestingConfirmation: boolean;
}

/** Quit handler instance */
export interface QuitHandler {
	/** Set up quit-related IPC handlers and before-quit event */
	setup: () => void;
	/** Check if quit has been confirmed */
	isQuitConfirmed: () => boolean;
	/** Mark quit as confirmed (for programmatic quit) */
	confirmQuit: () => void;
}

type RegisteredWindowEntry = ReturnType<WindowRegistry['getAll']>[number];

/**
 * Creates a quit handler that manages application quit flow.
 *
 * The quit flow:
 * 1. User attempts to quit (Cmd+Q, menu, etc.)
 * 2. before-quit is intercepted if not confirmed
 * 3. Renderer is asked to check for busy agents
 * 4. User confirms or cancels via IPC
 * 5. On confirm, cleanup runs and app quits
 *
 * @param deps - Dependencies for quit handling
 * @returns QuitHandler instance
 */
export function createQuitHandler(deps: QuitHandlerDependencies): QuitHandler {
	const {
		getMainWindow,
		getProcessManager,
		getWebServer,
		getHistoryManager,
		tunnelManager,
		getActiveGroomingSessionCount,
		cleanupAllGroomingSessions,
		closeStatsDB,
		getWindowRegistry,
		windowStateStore,
		stopCliWatcher,
	} = deps;

	const state: QuitHandlerState = {
		quitConfirmed: false,
		isRequestingConfirmation: false,
	};

	return {
		setup: () => {
			// Handle quit confirmation from renderer
			ipcMain.on('app:quitConfirmed', () => {
				logger.info('Quit confirmed by renderer', 'Window');
				state.isRequestingConfirmation = false;
				state.quitConfirmed = true;
				app.quit();
			});

			// Handle quit cancellation (user declined)
			ipcMain.on('app:quitCancelled', () => {
				logger.info('Quit cancelled by renderer', 'Window');
				state.isRequestingConfirmation = false;
				// Nothing to do - app stays running
			});

			// IMPORTANT: This handler must be synchronous for event.preventDefault() to work!
			// Async handlers return a Promise immediately, which breaks preventDefault in Electron.
			app.on('before-quit', (event) => {
				const mainWindow = getMainWindow();

				// If quit not yet confirmed, intercept and ask renderer
				if (!state.quitConfirmed) {
					event.preventDefault();

					// Prevent multiple confirmation requests (race condition protection)
					if (state.isRequestingConfirmation) {
						logger.debug(
							'Quit confirmation already in progress, ignoring duplicate request',
							'Window'
						);
						return;
					}

					// Ask renderer to check for busy agents
					if (isWebContentsAvailable(mainWindow)) {
						state.isRequestingConfirmation = true;
						logger.info('Requesting quit confirmation from renderer', 'Window');
						mainWindow.webContents.send('app:requestQuitConfirmation');
					} else {
						// No window, just quit
						state.quitConfirmed = true;
						app.quit();
					}
					return;
				}

				// Quit confirmed - proceed with cleanup (async operations are fire-and-forget)
				performCleanup();
			});
		},

		isQuitConfirmed: () => state.quitConfirmed,

		confirmQuit: () => {
			state.quitConfirmed = true;
		},
	};

	/**
	 * Performs cleanup operations before app quits.
	 * Called synchronously from before-quit, so async operations are fire-and-forget.
	 */
	function persistWindowLayoutState(): void {
		try {
			const windowRegistry = getWindowRegistry();
			if (!windowRegistry) {
				return;
			}

			const windowEntries = windowRegistry.getAll();
			if (windowEntries.length === 0) {
				return;
			}

			const nextState = buildMultiWindowStateFromRegistry(windowEntries, windowStateStore);
			windowStateStore.set('multiWindowState', nextState);

			const primaryWindow = nextState.windows.find((window) => window.id === nextState.primaryWindowId);
			if (primaryWindow) {
				syncLegacyWindowStateSnapshot(windowStateStore, primaryWindow);
			}
		} catch (error) {
			logger.error('Failed to persist window state during shutdown', 'Shutdown', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function performCleanup(): void {
		logger.info('Application shutting down', 'Shutdown');
		persistWindowLayoutState();

		// Stop history manager watcher
		getHistoryManager().stopWatching();

		// Stop CLI activity watcher
		if (stopCliWatcher) {
			stopCliWatcher();
		}

		// Clean up active grooming sessions (context merge/transfer operations)
		const processManager = getProcessManager();
		const groomingSessionCount = getActiveGroomingSessionCount();
		if (groomingSessionCount > 0 && processManager) {
			logger.info(`Cleaning up ${groomingSessionCount} active grooming session(s)`, 'Shutdown');
			// Fire and forget - don't await
			cleanupAllGroomingSessions(processManager).catch((err) => {
				logger.error(`Error cleaning up grooming sessions: ${err}`, 'Shutdown');
			});
		}

		// Clean up all running processes
		logger.info('Killing all running processes', 'Shutdown');
		processManager?.killAll();

		// Stop tunnel and web server (fire and forget)
		logger.info('Stopping tunnel', 'Shutdown');
		tunnelManager.stop().catch((err: unknown) => {
			logger.error(`Error stopping tunnel: ${err}`, 'Shutdown');
		});

		const webServer = getWebServer();
		logger.info('Stopping web server', 'Shutdown');
		webServer?.stop().catch((err: unknown) => {
			logger.error(`Error stopping web server: ${err}`, 'Shutdown');
		});

		// Close stats database
		logger.info('Closing stats database', 'Shutdown');
		closeStatsDB();

		logger.info('Shutdown complete', 'Shutdown');
	}
}

function buildMultiWindowStateFromRegistry(
	windowEntries: RegisteredWindowEntry[],
	windowStateStore: Store<WindowStateStoreShape>
): PersistedMultiWindowState {
	const previousState = getMultiWindowStateSnapshot(windowStateStore);
	const previousStateMap = new Map(previousState.windows.map((window) => [window.id, window]));
	let primaryWindowId = previousState.primaryWindowId;
	const windows: PersistedWindowState[] = [];

	for (const entry of windowEntries) {
		const snapshot = buildWindowStateSnapshot(entry, previousStateMap.get(entry.windowId));
		windows.push(snapshot);
		if (entry.isMain) {
			primaryWindowId = entry.windowId;
		}
	}

	if (!windows.length) {
		return previousState;
	}

	if (!windows.some((window) => window.id === primaryWindowId)) {
		primaryWindowId = windows[0].id;
	}

	return {
		primaryWindowId,
		windows,
	};
}

function buildWindowStateSnapshot(
	entry: RegisteredWindowEntry,
	previousState?: PersistedWindowState
): PersistedWindowState {
	const baseState = previousState
		? cloneWindowState(previousState)
		: createDefaultWindowStateSnapshot(entry.windowId);
	const sessionIds = Array.from(new Set(entry.sessionIds));
	const activeSessionId = resolveActiveSessionId(baseState.activeSessionId, sessionIds);

	const snapshot: PersistedWindowState = {
		...baseState,
		id: entry.windowId,
		sessionIds,
		activeSessionId,
	};

	if (!entry.browserWindow.isDestroyed()) {
		try {
			const isMaximized = entry.browserWindow.isMaximized();
			const isFullScreen = entry.browserWindow.isFullScreen();
			snapshot.isMaximized = isMaximized;
			snapshot.isFullScreen = isFullScreen;

			if (!isMaximized && !isFullScreen) {
				const bounds = entry.browserWindow.getBounds();
				snapshot.x = bounds.x;
				snapshot.y = bounds.y;
				snapshot.width = bounds.width;
				snapshot.height = bounds.height;
			}
		} catch (error) {
			logger.warn('Failed to capture window bounds during shutdown', 'Shutdown', {
				windowId: entry.windowId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return snapshot;
}

function resolveActiveSessionId(
	previousActive: string | null,
	sessionIds: string[]
): string | null {
	if (previousActive && sessionIds.includes(previousActive)) {
		return previousActive;
	}
	return sessionIds[0] ?? null;
}

function getMultiWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>
): PersistedMultiWindowState {
	const fallback = WINDOW_STATE_DEFAULTS.multiWindowState ?? {
		primaryWindowId: 'primary',
		windows: [],
	};
	const persisted =
		windowStateStore.get('multiWindowState') ??
		windowStateStore.store.multiWindowState ??
		fallback;

	return {
		primaryWindowId:
			persisted.primaryWindowId ||
			fallback.primaryWindowId ||
			persisted.windows?.[0]?.id ||
			'primary',
		windows: (persisted.windows ?? fallback.windows ?? []).map(cloneWindowState),
	};
}

function cloneWindowState(windowState: PersistedWindowState): PersistedWindowState {
	return {
		...windowState,
		sessionIds: [...windowState.sessionIds],
	};
}

function createDefaultWindowStateSnapshot(windowId: string): PersistedWindowState {
	const template = WINDOW_STATE_DEFAULTS.multiWindowState?.windows?.[0];
	return {
		id: windowId,
		x: template?.x,
		y: template?.y,
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

function syncLegacyWindowStateSnapshot(
	windowStateStore: Store<WindowStateStoreShape>,
	windowState: PersistedWindowState
): void {
	if (typeof windowState.x === 'number') {
		windowStateStore.set('x', windowState.x);
	}
	if (typeof windowState.y === 'number') {
		windowStateStore.set('y', windowState.y);
	}
	windowStateStore.set('width', windowState.width);
	windowStateStore.set('height', windowState.height);
	windowStateStore.set('isMaximized', windowState.isMaximized);
	windowStateStore.set('isFullScreen', windowState.isFullScreen);
}
