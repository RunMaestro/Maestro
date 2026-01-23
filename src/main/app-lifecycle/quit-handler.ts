/**
 * Application quit handler.
 * Manages quit confirmation flow and cleanup on application exit.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import type { ProcessManager } from '../process-manager';
import type { WebServer } from '../web-server';
import { tunnelManager as tunnelManagerInstance } from '../tunnel-manager';
import type { HistoryManager } from '../history-manager';

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
					if (mainWindow && !mainWindow.isDestroyed()) {
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
	function performCleanup(): void {
		logger.info('Application shutting down', 'Shutdown');

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
