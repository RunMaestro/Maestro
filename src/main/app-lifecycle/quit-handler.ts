/**
 * Application quit handler.
 * Manages quit confirmation flow and cleanup on application exit.
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import type Store from 'electron-store';
import { logger } from '../utils/logger';
import type { ProcessManager } from '../process-manager';
import type { WebServer } from '../web-server';
import type { WindowState } from '../stores/types';
import type { WindowRegistry } from '../window-registry';
import { saveAllWindowStates } from '../window-state-persistence';
import { tunnelManager as tunnelManagerInstance } from '../tunnel-manager';
import type { HistoryManager } from '../history-manager';
import { isWebContentsAvailable } from '../utils/safe-send';
import { deleteCliServerInfo } from '../../shared/cli-server-discovery';
import { stopAllCueRuns } from '../cue/cue-executor';
import { stopAllCueShellRuns } from '../cue/cue-shell-executor';
import { stopAllCueCliRuns } from '../cue/cue-cli-executor';
import { flushTelemetry } from '../cue/cue-telemetry';
import { captureException } from '../utils/sentry';
import { powerManager as powerManagerInstance } from '../power-manager';
import { isMacOS } from '../../shared/platformDetection';
import { flushStarredMirrorsSync } from '../storage/starred-transcript-mirror';

/**
 * Safety timeout for quit confirmation from the renderer.
 * If the renderer doesn't respond within this time (e.g., window already closing,
 * renderer crashed), force-quit to prevent the app from lingering in the background.
 */
const QUIT_CONFIRMATION_TIMEOUT_MS = 5000;

/**
 * Grace window between running cleanup and hard-exiting on a normal user quit.
 *
 * After performCleanup() the only work left is fire-and-forget (telemetry POST,
 * the tunnel's SIGTERM->exit, web-server socket close). The critical teardown
 * (PTY SIGKILL, stats DB close) already ran synchronously. We let those tails
 * make progress for this long, then hardExit() the process. Kept short so quit
 * still feels instant; the trade is a sub-second delay for a guaranteed exit.
 */
const FORCE_EXIT_GRACE_MS = 750;

/**
 * Grace window for the macOS update-install path before hard-exiting.
 *
 * By the time before-quit fires, `autoUpdater.quitAndInstall()` has already
 * spawned Squirrel.Mac's ShipIt helper, which only waits for our PID to die
 * before swapping the .app bundle and relaunching - it needs nothing from our
 * in-process teardown. We give the spawned helper a slightly longer settle
 * window than a normal quit (the cost of a failed update is high), then
 * hardExit() to dodge the native-addon finalizer deadlock that the *graceful*
 * teardown hits (see hardExit() and the before-quit handler).
 */
const UPDATE_EXIT_GRACE_MS = 2000;

/**
 * Terminates the process immediately, bypassing Electron's Node-environment
 * teardown.
 *
 * Why not app.exit()/process.exit(): both still run node::FreeEnvironment ->
 * Environment::CleanupHandles, which finalizes native-addon ThreadSafeFunctions.
 * A node-pty / fsevents TSFN whose underlying mutex is already gone deadlocks
 * there on uv_mutex_lock and hangs the process forever, forcing the user to kill
 * it from Activity Monitor (MAESTRO-3B). Confirmed via `sample`: on quit the main
 * thread parks in napi_release_threadsafe_function -> uv_mutex_lock ->
 * __psynch_mutexwait and never returns, even after app.exit(0) is called.
 *
 * SIGKILL to self is kernel-enforced, uncatchable, and runs no finalizers, so it
 * cannot deadlock. On Windows, Node maps 'SIGKILL' to TerminateProcess on the
 * target, which is the equivalent hard kill. All durable state (stats DB,
 * unflushed telemetry rows in SQLite) was already persisted synchronously in
 * performCleanup before the grace window, so nothing is lost.
 */
function hardExit(): void {
	try {
		process.kill(process.pid, 'SIGKILL');
	} catch (err) {
		// process.kill should never throw when signalling self, but if it does
		// fall back to app.exit() so we still attempt to terminate rather than
		// linger in the background.
		logger.error(`Hard exit via SIGKILL failed, falling back to app.exit: ${err}`, 'Shutdown');
		app.exit(0);
	}
}

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
	/**
	 * Returns the persisted session list (StoredSession[]) so the quit path can
	 * flush every open starred tab's transcript to Maestro's mirror before exit.
	 */
	getPersistedSessions?: () => Array<Record<string, unknown>>;
	/**
	 * Window-state store. When provided alongside {@link getWindowRegistry}, the
	 * full multi-window layout (bounds, display mode, owned agents, panel state)
	 * is snapshotted to it during quit cleanup so the next launch can restore it.
	 * Optional for the phased multi-window rollout and for tests that don't
	 * exercise persistence.
	 */
	windowStateStore?: Store<WindowState>;
	/** Registry of every open window, the source of truth for the saved layout. */
	getWindowRegistry?: () => WindowRegistry | null;
}

/** Quit handler state */
interface QuitHandlerState {
	/** Whether quit has been confirmed by user (or no busy agents) */
	quitConfirmed: boolean;
	/** Whether we're currently waiting for quit confirmation from renderer */
	isRequestingConfirmation: boolean;
	/** Safety timeout for quit confirmation - forces quit if renderer never responds */
	confirmationTimeout: ReturnType<typeof setTimeout> | null;
	/**
	 * Whether this quit is the auto-updater installing an update. On that path we
	 * must let Electron's graceful will-quit/quit teardown run so electron-updater
	 * can apply the update (Squirrel.Mac install-on-quit, the Windows NSIS handoff).
	 * The force-exit fallback is skipped when this is set.
	 */
	installingUpdate: boolean;
	/** Guards against re-entrant before-quit running cleanup / arming the timer twice. */
	cleanupStarted: boolean;
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
		getPersistedSessions,
		windowStateStore,
		getWindowRegistry,
	} = deps;

	const state: QuitHandlerState = {
		quitConfirmed: false,
		isRequestingConfirmation: false,
		confirmationTimeout: null,
		installingUpdate: false,
		cleanupStarted: false,
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

			// Renderer is showing the quit-confirmation modal and is waiting on the
			// user. Disarm the dead-renderer safety timeout so we don't force-quit
			// out from under an open dialog. We keep isRequestingConfirmation set so
			// repeat quit attempts stay suppressed; the eventual confirm/cancel from
			// the modal clears it.
			ipcMain.on('app:quitConfirmationPending', () => {
				logger.info('Quit confirmation pending - user deciding, disarming timeout', 'Window');
				clearConfirmationTimeout();
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
									'Quit confirmation timed out - renderer did not respond, forcing quit',
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

				// Quit confirmed. Guard against a re-entrant before-quit (e.g. another
				// path calling app.quit() during the grace window) running cleanup or
				// arming the timer twice.
				if (state.cleanupStarted) {
					return;
				}
				state.cleanupStarted = true;

				// Proceed with cleanup (async operations are fire-and-forget).
				performCleanup();

				// Take control of the exit on every path that can deadlock: hold the
				// event loop open (preventDefault) and hardExit() after a grace window.
				// This dodges the native Node-environment teardown that can hang the
				// process forever on node-pty / fsevents ThreadSafeFunction finalizers
				// (see hardExit() and FORCE_EXIT_GRACE_MS).
				//
				// The update-install path used to opt out of this and let Electron's
				// graceful teardown run "so electron-updater can apply the update". On
				// macOS that was wrong: Squirrel.Mac applies the update from an external
				// ShipIt helper that quitAndInstall already spawned before this handler
				// fires - it only needs our PID to die, not a graceful exit. Routing it
				// through the graceful path instead reintroduced the very deadlock the
				// hardExit() change was made to avoid, leaving "Maestro (not responding)"
				// after "Restart to Update" until the user force-quit. So on macOS we
				// hard-exit here too (after a longer settle window). Windows/Linux keep
				// the graceful teardown their updater handoffs are written against.
				const forceExitOnInstall = state.installingUpdate && isMacOS();
				if (!state.installingUpdate || forceExitOnInstall) {
					event.preventDefault();
					const graceMs = state.installingUpdate ? UPDATE_EXIT_GRACE_MS : FORCE_EXIT_GRACE_MS;
					setTimeout(() => {
						logger.info(
							forceExitOnInstall
								? 'Hard-exiting after update-install grace window (ShipIt armed; dodging teardown deadlock)'
								: 'Hard-exiting after cleanup grace window',
							'Shutdown'
						);
						hardExit();
					}, graceMs);
				}
			});
		},

		isQuitConfirmed: () => state.quitConfirmed,

		confirmQuit: () => {
			clearConfirmationTimeout();
			state.quitConfirmed = true;
			// confirmQuit() is only invoked from the auto-updater's
			// onBeforeQuitAndInstall hook (the renderer's user-quit path goes through
			// the 'app:quitConfirmed' IPC handler instead). Mark this so the
			// before-quit handler skips the force-exit and lets the updater apply the
			// update via the graceful will-quit/quit teardown.
			state.installingUpdate = true;
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

		// Snapshot the multi-window layout first, while every window is still open
		// and its bounds are valid (windows are destroyed after before-quit). This
		// is additive to the legacy per-window 'close' save in window-manager.ts and
		// never throws, so it can't disrupt the rest of cleanup. Skipped when the
		// window-state store / registry weren't injected (phased rollout, tests).
		const windowRegistry = getWindowRegistry?.();
		if (windowStateStore && windowRegistry) {
			saveAllWindowStates(windowStateStore, windowRegistry);
		}

		// Stop history manager watcher
		getHistoryManager().stopWatching();

		// Flush every open starred tab's transcript to Maestro's own mirror. Done
		// synchronously (not fire-and-forget) because the process is SIGKILLed
		// shortly after cleanup - async copies could be cut off. Each copy is
		// mtime-gated, so unchanged transcripts cost only a stat.
		if (getPersistedSessions) {
			try {
				flushStarredMirrorsSync(getPersistedSessions());
			} catch (err) {
				logger.error(`Error flushing starred transcripts on quit: ${err}`, 'Shutdown');
			}
		}

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

		// Kill all active Cue processes (tracked separately from ProcessManager)
		logger.info('Killing active Cue processes', 'Shutdown');
		stopAllCueRuns();
		stopAllCueShellRuns();
		stopAllCueCliRuns();

		// Flush Cue telemetry outbox before quit so events captured between the
		// last autorun and shutdown aren't deferred to the next launch (or lost
		// if the user uninstalls). Fire-and-forget - performCleanup is sync and
		// the network call may not finish before quit, but unflushed rows
		// survive in SQLite for the next session.
		flushTelemetry({ reason: 'app-quit' }).catch((error) => {
			// Errors already logged inside flushTelemetry; report unexpected
			// failures to Sentry so we can spot regressions, but don't rethrow
			// - a network failure during shutdown shouldn't crash cleanup.
			captureException(error, {
				context: 'quit-handler.performCleanup.flushTelemetry',
			});
		});

		// Clean up all running processes. shutdown:true makes PTYs SIGKILL
		// immediately (no SIGTERM grace, no escalation timer, no onExit
		// listener) so node-pty's worker threads exit and release their
		// N-API ThreadSafeFunctions before Electron tears down the Node
		// environment. Otherwise CleanupHandles can finalize a TSFN whose
		// underlying mutex is already gone, aborting the main process
		// (Sentry MAESTRO-3B).
		logger.info('Killing all running processes', 'Shutdown');
		processManager?.killAll({ shutdown: true });

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

		// Delete CLI server discovery file so CLI knows we're gone
		logger.info('Deleting CLI server discovery file', 'Shutdown');
		deleteCliServerInfo();

		// Close stats database
		logger.info('Closing stats database', 'Shutdown');
		closeStatsDB();

		logger.info('Shutdown complete', 'Shutdown');
	}
}
