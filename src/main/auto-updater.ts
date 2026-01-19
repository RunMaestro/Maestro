/**
 * Auto-updater module for Maestro
 * Uses electron-updater to download and install updates from GitHub releases
 */

import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import { logger } from './utils/logger';

// Don't auto-download - we want user to initiate
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// Default to stable releases only (will be updated from settings)
autoUpdater.allowPrerelease = false;

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

/**
 * Initialize the auto-updater and set up event handlers
 */
export function initAutoUpdater(window: BrowserWindow): void {
	mainWindow = window;

	// Update available
	autoUpdater.on('update-available', (info: UpdateInfo) => {
		logger.info(`Update available: ${info.version}`, 'AutoUpdater');
		currentStatus = { status: 'available', info };
		sendStatusToRenderer();
	});

	// No update available
	autoUpdater.on('update-not-available', (info: UpdateInfo) => {
		logger.debug(`No update available (current: ${info.version})`, 'AutoUpdater');
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
		logger.error(`Auto-update error: ${err.message}`, 'AutoUpdater');
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
	if (mainWindow && !mainWindow.isDestroyed()) {
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

	// Check for updates using electron-updater (different from manual GitHub API check)
	ipcMain.handle('updates:checkAutoUpdater', async () => {
		try {
			currentStatus = { status: 'checking' };
			sendStatusToRenderer();
			const result = await autoUpdater.checkForUpdates();
			return { success: true, updateInfo: result?.updateInfo };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
			logger.info('Checking for updates before download...', 'AutoUpdater');
			const checkResult = await autoUpdater.checkForUpdates();

			if (!checkResult || !checkResult.updateInfo) {
				logger.error('No update found during pre-download check', 'AutoUpdater');
				currentStatus = { status: 'error', error: 'No update available to download' };
				sendStatusToRenderer();
				return { success: false, error: 'No update available to download' };
			}

			logger.info(
				`Found update ${checkResult.updateInfo.version}, starting download...`,
				'AutoUpdater'
			);
			currentStatus = {
				status: 'downloading',
				progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0, delta: 0 },
			};
			sendStatusToRenderer();
			await autoUpdater.downloadUpdate();
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`Download failed: ${errorMessage}`, 'AutoUpdater');
			currentStatus = { status: 'error', error: errorMessage };
			sendStatusToRenderer();
			return { success: false, error: errorMessage };
		}
	});

	// Install update (quit and install)
	ipcMain.handle('updates:install', () => {
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
		const result = await autoUpdater.checkForUpdates();
		return result?.updateInfo || null;
	} catch {
		return null;
	}
}

/**
 * Configure whether to include prerelease/beta versions in updates
 * This should be called when the user setting changes
 */
export function setAllowPrerelease(allow: boolean): void {
	autoUpdater.allowPrerelease = allow;
	logger.info(`Auto-updater prerelease mode: ${allow ? 'enabled' : 'disabled'}`, 'AutoUpdater');
}
