/**
 * Auto-updater module for Maestro
 * Uses electron-updater to download and install updates from GitHub releases
 *
 * Note: electron-updater accesses electron.app at module load time, so we use
 * lazy initialization to avoid "Cannot read properties of undefined" errors
 * when the module is imported before app.whenReady().
 */

import type { UpdateInfo, ProgressInfo, AppUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';
import { isWebContentsAvailable } from './utils/safe-send';

export interface UpdateStatus {
	status:
		| 'idle'
		| 'checking'
		| 'available'
		| 'not-available'
		| 'downloading'
		| 'downloaded'
		| 'error';
	info?: UpdateInfo;
	progress?: ProgressInfo;
	error?: string;
}

let mainWindow: BrowserWindow | null = null;
let currentStatus: UpdateStatus = { status: 'idle' };
let ipcHandlersRegistered = false;
let onBeforeQuitAndInstall: (() => void) | null = null;

// Lazy-loaded autoUpdater instance
let _autoUpdater: AppUpdater | null = null;

/**
 * Get the autoUpdater instance, initializing it lazily
 * This is necessary because electron-updater accesses electron.app at import time
 */
function getAutoUpdater(): AppUpdater {
	if (!_autoUpdater) {
		// Dynamic require to defer the module load
		const { autoUpdater } = require('electron-updater');
		_autoUpdater = autoUpdater;
		// Configure defaults
		_autoUpdater!.autoDownload = false;
		_autoUpdater!.autoInstallOnAppQuit = true;
		_autoUpdater!.allowPrerelease = false;
		logger.info('electron-updater initialized', 'AutoUpdater', {
			autoDownload: false,
			autoInstallOnAppQuit: true,
			allowPrerelease: false,
		});
	}
	return _autoUpdater!;
}

/**
 * @internal Test-only: inject a mock autoUpdater. The real implementation is
 * loaded via dynamic `require` to defer electron.app access, which sidesteps
 * vitest's module mocker — this hook lets tests provide a stand-in.
 *
 * Hard-gated to non-production builds: the symbol still exists in production
 * bundles (TS can't conditionally export) but the body is a no-op there, so
 * a stray call can't subvert the real updater singleton.
 */
export function __setAutoUpdaterForTesting(updater: AppUpdater | null): void {
	if (process.env.NODE_ENV === 'production') return;
	_autoUpdater = updater;
}

/**
 * Options for initializing the auto-updater.
 */
export interface InitAutoUpdaterOptions {
	/**
	 * Called immediately before `autoUpdater.quitAndInstall()` runs (i.e. when the
	 * user clicks "Install Update"). Lets the host bypass the busy-agent quit
	 * confirmation gate so the Windows installer — which spawns waiting on our PID
	 * — isn't orphaned by `before-quit` preventDefault.
	 */
	onBeforeQuitAndInstall?: () => void;
}

/**
 * Initialize the auto-updater and set up event handlers
 */
export function initAutoUpdater(window: BrowserWindow, options?: InitAutoUpdaterOptions): void {
	mainWindow = window;
	onBeforeQuitAndInstall = options?.onBeforeQuitAndInstall ?? null;

	const autoUpdater = getAutoUpdater();

	// Update available
	autoUpdater.on('update-available', (info: UpdateInfo) => {
		logger.info(`Update available: ${info.version}`, 'AutoUpdater');
		currentStatus = { status: 'available', info };
		sendStatusToRenderer();
	});

	// No update available
	autoUpdater.on('update-not-available', (info: UpdateInfo) => {
		logger.info(
			`No update available via electron-updater (current: ${info.version})`,
			'AutoUpdater'
		);
		currentStatus = { status: 'not-available', info };
		sendStatusToRenderer();
	});

	// Download progress
	autoUpdater.on('download-progress', (progress: ProgressInfo) => {
		currentStatus = { ...currentStatus, status: 'downloading', progress };
		sendStatusToRenderer();
	});

	// Update downloaded
	autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
		logger.info(`Update downloaded: ${info.version}`, 'AutoUpdater');
		currentStatus = { status: 'downloaded', info };
		sendStatusToRenderer();
	});

	// Error
	autoUpdater.on('error', (err: Error) => {
		logger.error(`Auto-update error: ${err.message}`, 'AutoUpdater', {
			stack: err.stack,
		});
		currentStatus = { status: 'error', error: err.message };
		sendStatusToRenderer();
	});

	// Set up IPC handlers
	setupIpcHandlers();
}

/**
 * Send current status to renderer
 */
function sendStatusToRenderer(): void {
	if (isWebContentsAvailable(mainWindow)) {
		mainWindow.webContents.send('updates:status', currentStatus);
	}
}

/**
 * Set up IPC handlers for update operations
 */
function setupIpcHandlers(): void {
	if (ipcHandlersRegistered) {
		return;
	}
	ipcHandlersRegistered = true;

	const autoUpdater = getAutoUpdater();

	// Check for updates using electron-updater (different from manual GitHub API check)
	ipcMain.handle('updates:checkAutoUpdater', async () => {
		try {
			logger.info(
				`Checking for updates via electron-updater (allowPrerelease: ${autoUpdater.allowPrerelease})`,
				'AutoUpdater'
			);
			currentStatus = { status: 'checking' };
			sendStatusToRenderer();
			const result = await autoUpdater.checkForUpdates();
			logger.info(
				`electron-updater check result: ${result?.updateInfo ? `v${result.updateInfo.version} available` : 'no update'}`,
				'AutoUpdater',
				result?.updateInfo
					? { version: result.updateInfo.version, releaseDate: result.updateInfo.releaseDate }
					: undefined
			);
			return { success: true, updateInfo: result?.updateInfo };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`electron-updater check failed: ${errorMessage}`, 'AutoUpdater', {
				stack: error instanceof Error ? error.stack : undefined,
			});
			currentStatus = { status: 'error', error: errorMessage };
			sendStatusToRenderer();
			return { success: false, error: errorMessage };
		}
	});

	// Download update
	ipcMain.handle('updates:download', async () => {
		try {
			// First, check for updates with electron-updater to tell it which version to download
			// This is required because the UI uses the GitHub API check, not electron-updater's check
			logger.info(
				`Pre-download check via electron-updater (allowPrerelease: ${autoUpdater.allowPrerelease})`,
				'AutoUpdater'
			);
			const checkResult = await autoUpdater.checkForUpdates();

			if (!checkResult || !checkResult.updateInfo) {
				logger.error(
					'No update found during pre-download check — electron-updater found nothing to download',
					'AutoUpdater',
					{ allowPrerelease: autoUpdater.allowPrerelease }
				);
				currentStatus = { status: 'error', error: 'No update available to download' };
				sendStatusToRenderer();
				return { success: false, error: 'No update available to download' };
			}

			logger.info(`Starting download of v${checkResult.updateInfo.version}`, 'AutoUpdater', {
				version: checkResult.updateInfo.version,
				releaseDate: checkResult.updateInfo.releaseDate,
				files: checkResult.updateInfo.files?.map((f) => f.url),
			});
			currentStatus = {
				status: 'downloading',
				progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0, delta: 0 },
			};
			sendStatusToRenderer();
			await autoUpdater.downloadUpdate();
			logger.info(
				`Download of v${checkResult.updateInfo.version} completed successfully`,
				'AutoUpdater'
			);
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`Download failed: ${errorMessage}`, 'AutoUpdater', {
				stack: error instanceof Error ? error.stack : undefined,
			});
			currentStatus = { status: 'error', error: errorMessage };
			sendStatusToRenderer();
			return { success: false, error: errorMessage };
		}
	});

	// Install update (quit and install)
	ipcMain.handle('updates:install', () => {
		logger.info('Installing update — quitting and restarting app', 'AutoUpdater');
		// Bypass the busy-agent quit confirmation gate. The user already opted in
		// via the update modal, and on Windows quitAndInstall spawns the NSIS
		// installer bound to our PID — if before-quit preventDefaults the quit, the
		// installer is orphaned waiting for a parent exit that may never come.
		try {
			onBeforeQuitAndInstall?.();
		} catch (err) {
			logger.warn(
				`onBeforeQuitAndInstall hook threw: ${err instanceof Error ? err.message : String(err)}`,
				'AutoUpdater'
			);
			void captureException(err instanceof Error ? err : new Error(String(err)), {
				module: 'AutoUpdater',
				hook: 'onBeforeQuitAndInstall',
				operation: 'updates:install',
			});
		}
		autoUpdater.quitAndInstall(false, true);
	});

	// Get current status
	ipcMain.handle('updates:getStatus', () => {
		return currentStatus;
	});
}

/**
 * Manually trigger update check (can be called from main process)
 */
export async function checkForUpdatesManual(): Promise<UpdateInfo | null> {
	try {
		const autoUpdater = getAutoUpdater();
		logger.info(
			`Manual update check via electron-updater (allowPrerelease: ${autoUpdater.allowPrerelease})`,
			'AutoUpdater'
		);
		const result = await autoUpdater.checkForUpdates();
		if (result?.updateInfo) {
			logger.info(`Manual check found update: v${result.updateInfo.version}`, 'AutoUpdater');
		} else {
			logger.info('Manual check: no update available', 'AutoUpdater');
		}
		return result?.updateInfo || null;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Manual update check failed: ${errorMessage}`, 'AutoUpdater', {
			stack: error instanceof Error ? error.stack : undefined,
		});
		return null;
	}
}

/**
 * Configure whether to include prerelease/beta versions in updates
 * This should be called when the user setting changes
 */
export function setAllowPrerelease(allow: boolean): void {
	const autoUpdater = getAutoUpdater();
	autoUpdater.allowPrerelease = allow;
	logger.info(`Auto-updater prerelease mode: ${allow ? 'enabled' : 'disabled'}`, 'AutoUpdater');
}
