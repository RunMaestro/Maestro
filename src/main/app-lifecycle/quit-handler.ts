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
import { isWebContentsAvailable } from '../utils/safe-send';
import { powerManager as powerManagerInstance } from '../power-manager';
import type { MultiWindowState, WindowState } from '../stores/types';
import type { WindowRegistry, WindowRegistryEntry } from '../window-registry';

/**
 * Safety timeout for quit confirmation from the renderer.
 * If the renderer doesn't respond within this time (e.g., window already closing,
 * renderer crashed), force-quit to prevent the app from lingering in the background.
 */
const QUIT_CONFIRMATION_TIMEOUT_MS = 5000;

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
	/** Function to stop CLI watcher (optional, may not be started yet) */
	stopCliWatcher?: () => void;
	/** Function to stop settings file watcher (optional, may not be started yet) */
	stopSettingsWatcher?: () => void;
	/** Power manager instance for clearing sleep prevention on shutdown */
	powerManager: typeof powerManagerInstance;
	/** Function to stop group chat moderator cleanup interval */
	stopSessionCleanup?: () => void;
	/** Function to get the window registry */
	getWindowRegistry?: () => WindowRegistry | null;
	/** Store for multi-window state persistence */
	windowStateStore?: Store<MultiWindowState>;
}

/** Quit handler state */
interface QuitHandlerState {
	/** Whether quit has been confirmed by user (or no busy agents) */
	quitConfirmed: boolean;
	/** Whether we're currently waiting for quit confirmation from renderer */
	isRequestingConfirmation: boolean;
	/** Safety timeout for quit confirmation — forces quit if renderer never responds */
	confirmationTimeout: ReturnType<typeof setTimeout> | null;
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
		stopCliWatcher,
		stopSettingsWatcher,
		powerManager,
		stopSessionCleanup,
		getWindowRegistry,
		windowStateStore,
	} = deps;

	const state: QuitHandlerState = {
		quitConfirmed: false,
		isRequestingConfirmation: false,
		confirmationTimeout: null,
	};

	return {
		setup: () => {
			// Handle quit confirmation from renderer
			ipcMain.on('app:quitConfirmed', () => {
				logger.info('Quit confirmed by renderer', 'Window');
				clearConfirmationTimeout();
				state.isRequestingConfirmation = false;
				state.quitConfirmed = true;
				app.quit();
			});

			// Handle quit cancellation (user declined)
			ipcMain.on('app:quitCancelled', () => {
				logger.info('Quit cancelled by renderer', 'Window');
				clearConfirmationTimeout();
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

						// Arm safety timeout BEFORE send() so it's always active even if
						// send() throws (e.g., renderer disposed between the availability
						// check and the actual IPC call). Prevents the app from lingering
						// in the background with no window (issue #623).
						state.confirmationTimeout = setTimeout(() => {
							if (state.isRequestingConfirmation) {
								logger.warn(
									'Quit confirmation timed out — renderer did not respond, forcing quit',
									'Window'
								);
								state.isRequestingConfirmation = false;
								state.quitConfirmed = true;
								app.quit();
							}
						}, QUIT_CONFIRMATION_TIMEOUT_MS);

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
			clearConfirmationTimeout();
			state.quitConfirmed = true;
		},
	};

	/** Clears the quit confirmation safety timeout if active. */
	function clearConfirmationTimeout(): void {
		if (state.confirmationTimeout) {
			clearTimeout(state.confirmationTimeout);
			state.confirmationTimeout = null;
		}
	}

	/**
	 * Performs cleanup operations before app quits.
	 * Called synchronously from before-quit, so async operations are fire-and-forget.
	 */
	function performCleanup(): void {
		logger.info('Application shutting down', 'Shutdown');

		saveAllWindowStates();

		// Stop history manager watcher
		getHistoryManager().stopWatching();

		// Stop CLI activity watcher
		if (stopCliWatcher) {
			stopCliWatcher();
		}

		// Stop settings file watcher
		if (stopSettingsWatcher) {
			stopSettingsWatcher();
		}

		// Stop group chat moderator cleanup interval
		if (stopSessionCleanup) {
			stopSessionCleanup();
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

		// Clear power save blocker AFTER killAll() to prevent late process output
		// from re-arming the blocker via addBlockReason()
		powerManager.clearAllReasons();

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

	/** Saves all registered window states before app shutdown begins. */
	function saveAllWindowStates(): void {
		const windowRegistry = getWindowRegistry?.();
		if (!windowRegistry || !windowStateStore) {
			return;
		}

		try {
			const currentState = windowStateStore.store;
			const windows: WindowState[] = [];
			let primaryWindowId = currentState.primaryWindowId;

			for (const entry of windowRegistry.getAll()) {
				const windowId = windowRegistry.getWindowId(entry.browserWindow);
				if (!windowId || entry.browserWindow.isDestroyed()) {
					continue;
				}

				if (entry.isMain) {
					primaryWindowId = windowId;
				}

				windows.push(createWindowState(windowId, entry, currentState));
			}

			if (windows.length === 0) {
				return;
			}

			windowStateStore.store = {
				...currentState,
				primaryWindowId,
				windows,
			};
			logger.info(`Saved state for ${windows.length} window(s) before quit`, 'Shutdown');
		} catch (err) {
			logger.warn(`Failed to save window state before quit: ${err}`, 'Shutdown');
		}
	}

	function createWindowState(
		windowId: string,
		entry: WindowRegistryEntry,
		currentState: MultiWindowState
	): WindowState {
		const browserWindow = entry.browserWindow;
		const bounds = browserWindow.getBounds();
		const existingWindowState = currentState.windows.find(
			(windowState) => windowState.id === windowId
		);

		return {
			id: windowId,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized: browserWindow.isMaximized(),
			isFullScreen: browserWindow.isFullScreen(),
			sessionIds: entry.sessionIds,
			activeSessionId: existingWindowState?.activeSessionId ?? null,
			leftPanelCollapsed: existingWindowState?.leftPanelCollapsed ?? false,
			rightPanelCollapsed: existingWindowState?.rightPanelCollapsed ?? false,
		};
	}
}
