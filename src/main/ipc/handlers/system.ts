/**
 * System IPC Handlers
 *
 * This module handles IPC calls for system-level operations:
 * - Dialog: folder selection
 * - Fonts: system font detection
 * - Shells: available shell detection, open external URLs
 * - Tunnel: Cloudflare tunnel management
 * - DevTools: developer tools control
 * - Updates: update checking
 * - Logger: logging operations
 * - Sync: iCloud/custom sync path management
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, dialog, shell, BrowserWindow, App } from 'electron';
import * as path from 'path';
import * as fsSync from 'fs';
import Store from 'electron-store';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { detectShells } from '../../utils/shellDetector';
import { isCloudflaredInstalled } from '../../utils/cliDetection';
import { tunnelManager as tunnelManagerInstance } from '../../tunnel-manager';
import { checkForUpdates } from '../../update-checker';
import { setAllowPrerelease } from '../../auto-updater';
import { WebServer } from '../../web-server';
import { powerManager } from '../../power-manager';
import { MaestroSettings } from './persistence';

// Type for tunnel manager instance
type TunnelManagerType = typeof tunnelManagerInstance;

/**
 * Interface for bootstrap settings (custom storage location)
 */
interface BootstrapSettings {
	customSyncPath?: string;
	iCloudSyncEnabled?: boolean; // Legacy - kept for backwards compatibility
}

/**
 * Dependencies required for system handlers
 */
export interface SystemHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	app: App;
	settingsStore: Store<MaestroSettings>;
	tunnelManager: TunnelManagerType;
	getWebServer: () => WebServer | null;
	bootstrapStore?: Store<BootstrapSettings>;
}

/**
 * Register all system-related IPC handlers.
 */
export function registerSystemHandlers(deps: SystemHandlerDependencies): void {
	const { getMainWindow, app, settingsStore, tunnelManager, getWebServer } = deps;

	// ============ Dialog Handlers ============

	// Folder selection dialog
	// Wrapped in try-catch to ensure a reply is always sent, even if the window
	// is closed while the dialog is open or other unexpected errors occur.
	// Fixes MAESTRO-58: "reply was never sent"
	ipcMain.handle('dialog:selectFolder', async () => {
		try {
			const mainWindow = getMainWindow();
			if (!mainWindow || mainWindow.isDestroyed()) return null;

			const result = await dialog.showOpenDialog(mainWindow, {
				properties: ['openDirectory', 'createDirectory'],
				title: 'Select Working Directory',
			});

			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}

			return result.filePaths[0];
		} catch (error) {
			// Log the error but return null to ensure IPC reply is sent
			logger.error('dialog:selectFolder failed', 'Dialog', { error });
			return null;
		}
	});

	// File save dialog
	ipcMain.handle(
		'dialog:saveFile',
		async (
			_event,
			options: {
				defaultPath?: string;
				filters?: Array<{ name: string; extensions: string[] }>;
				title?: string;
			}
		) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) return null;

			const result = await dialog.showSaveDialog(mainWindow, {
				defaultPath: options.defaultPath,
				filters: options.filters,
				title: options.title ?? 'Save File',
			});

			if (result.canceled || !result.filePath) {
				return null;
			}

			return result.filePath;
		}
	);

	// ============ Font Detection Handlers ============

	// Font detection
	ipcMain.handle('fonts:detect', async () => {
		try {
			// Use fc-list on all platforms (faster than system_profiler on macOS)
			// macOS: 0.74s (was 8.77s with system_profiler) - 11.9x faster
			// Linux/Windows: 0.5-0.6s
			const result = await execFileNoThrow('fc-list', [':', 'family']);

			if (result.exitCode === 0 && result.stdout) {
				// Parse font list and deduplicate
				const fonts = result.stdout
					.split('\n')
					.filter(Boolean)
					.map((line: string) => line.trim())
					.filter((font) => font.length > 0);

				// Deduplicate fonts (fc-list can return duplicates)
				return [...new Set(fonts)];
			}

			// Fallback if fc-list not available (rare on modern systems)
			return [
				'Monaco',
				'Menlo',
				'Courier New',
				'Consolas',
				'Roboto Mono',
				'Fira Code',
				'JetBrains Mono',
			];
		} catch (error) {
			console.error('Font detection error:', error);
			// Return common monospace fonts as fallback
			return [
				'Monaco',
				'Menlo',
				'Courier New',
				'Consolas',
				'Roboto Mono',
				'Fira Code',
				'JetBrains Mono',
			];
		}
	});

	// ============ Shell Detection Handlers ============

	// Shell detection
	ipcMain.handle('shells:detect', async () => {
		try {
			logger.info('Detecting available shells', 'ShellDetector');
			const shells = await detectShells();
			logger.info(
				`Detected ${shells.filter((s) => s.available).length} available shells`,
				'ShellDetector',
				{
					shells: shells.filter((s) => s.available).map((s) => s.id),
				}
			);
			return shells;
		} catch (error) {
			logger.error('Shell detection error', 'ShellDetector', error);
			// Return default shell list with all marked as unavailable
			return [
				{ id: 'zsh', name: 'Zsh', available: false },
				{ id: 'bash', name: 'Bash', available: false },
				{ id: 'sh', name: 'Bourne Shell (sh)', available: false },
				{ id: 'fish', name: 'Fish', available: false },
				{ id: 'tcsh', name: 'Tcsh', available: false },
			];
		}
	});

	// Shell operations - open external URLs
	ipcMain.handle('shell:openExternal', async (_event, url: string) => {
		// Validate URL before opening - Fixes MAESTRO-1S
		if (!url || typeof url !== 'string') {
			throw new Error('Invalid URL: URL must be a non-empty string');
		}
		try {
			new URL(url);
		} catch {
			throw new Error(`Invalid URL: ${url}`);
		}
		await shell.openExternal(url);
	});

	// Shell operations - move item to system trash
	ipcMain.handle('shell:trashItem', async (_event, itemPath: string) => {
		if (!itemPath || typeof itemPath !== 'string') {
			throw new Error('Invalid path: path must be a non-empty string');
		}
		// Resolve to absolute path and verify it exists
		const absolutePath = path.resolve(itemPath);
		if (!fsSync.existsSync(absolutePath)) {
			throw new Error(`Path does not exist: ${absolutePath}`);
		}
		await shell.trashItem(absolutePath);
	});

	// Shell operations - reveal item in system file manager (Finder on macOS, Explorer on Windows)
	ipcMain.handle('shell:showItemInFolder', async (_event, itemPath: string) => {
		if (!itemPath || typeof itemPath !== 'string') {
			throw new Error('Invalid path: path must be a non-empty string');
		}
		// Resolve to absolute path and verify it exists
		const absolutePath = path.resolve(itemPath);
		if (!fsSync.existsSync(absolutePath)) {
			throw new Error(`Path does not exist: ${absolutePath}`);
		}
		shell.showItemInFolder(absolutePath);
	});

	// ============ Tunnel Handlers (Cloudflare) ============

	ipcMain.handle('tunnel:isCloudflaredInstalled', async () => {
		return await isCloudflaredInstalled();
	});

	ipcMain.handle('tunnel:start', async () => {
		const webServer = getWebServer();
		// Get web server URL (includes the security token)
		const serverUrl = webServer?.getSecureUrl();
		if (!serverUrl) {
			return { success: false, error: 'Web server not running' };
		}

		// Parse the URL to get port and token path
		const parsedUrl = new URL(serverUrl);
		const port = parseInt(parsedUrl.port, 10);
		const tokenPath = parsedUrl.pathname; // e.g., "/7d7f7162-614c-43e2-bb8a-8a8123c2f56a"

		const result = await tunnelManager.start(port);

		if (result.success && result.url) {
			// Append the token path to the tunnel URL for security
			// e.g., "https://xyz.trycloudflare.com" + "/TOKEN" = "https://xyz.trycloudflare.com/TOKEN"
			const fullTunnelUrl = result.url + tokenPath;
			return { success: true, url: fullTunnelUrl };
		}

		return result;
	});

	ipcMain.handle('tunnel:stop', async () => {
		await tunnelManager.stop();
		return { success: true };
	});

	ipcMain.handle('tunnel:getStatus', async () => {
		return tunnelManager.getStatus();
	});

	// ============ DevTools Handlers ============

	ipcMain.handle('devtools:open', async () => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.openDevTools();
		}
	});

	ipcMain.handle('devtools:close', async () => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.closeDevTools();
		}
	});

	ipcMain.handle('devtools:toggle', async () => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools();
			}
		}
	});

	// ============ Update Check Handler ============

	ipcMain.handle('updates:check', async (_event, includePrerelease: boolean = false) => {
		const currentVersion = app.getVersion();
		return checkForUpdates(currentVersion, includePrerelease);
	});

	// Set whether to allow prerelease updates (for electron-updater)
	ipcMain.handle('updates:setAllowPrerelease', async (_event, allow: boolean) => {
		setAllowPrerelease(allow);
	});

	// ============ Logger Handlers ============

	ipcMain.handle(
		'logger:log',
		async (_event, level: string, message: string, context?: string, data?: unknown) => {
			const logLevel = level as 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun';
			switch (logLevel) {
				case 'debug':
					logger.debug(message, context, data);
					break;
				case 'info':
					logger.info(message, context, data);
					break;
				case 'warn':
					logger.warn(message, context, data);
					break;
				case 'error':
					logger.error(message, context, data);
					break;
				case 'toast':
					logger.toast(message, context, data);
					break;
				case 'autorun':
					logger.autorun(message, context, data);
					break;
				default:
					// Log unknown levels as info to prevent silent failures
					logger.info(`[${level}] ${message}`, context, data);
					break;
			}
		}
	);

	ipcMain.handle(
		'logger:getLogs',
		async (_event, filter?: { level?: string; context?: string; limit?: number }) => {
			const typedFilter = filter
				? {
						level: filter.level as
							| 'debug'
							| 'info'
							| 'warn'
							| 'error'
							| 'toast'
							| 'autorun'
							| undefined,
						context: filter.context,
						limit: filter.limit,
					}
				: undefined;
			return logger.getLogs(typedFilter);
		}
	);

	ipcMain.handle('logger:clearLogs', async () => {
		logger.clearLogs();
	});

	ipcMain.handle('logger:setLogLevel', async (_event, level: string) => {
		const logLevel = level as 'debug' | 'info' | 'warn' | 'error';
		logger.setLogLevel(logLevel);
		settingsStore.set('logLevel', logLevel);
	});

	ipcMain.handle('logger:getLogLevel', async () => {
		return logger.getLogLevel();
	});

	ipcMain.handle('logger:setMaxLogBuffer', async (_event, max: number) => {
		logger.setMaxLogBuffer(max);
		settingsStore.set('maxLogBuffer', max);
	});

	ipcMain.handle('logger:getMaxLogBuffer', async () => {
		return logger.getMaxLogBuffer();
	});

	// Get the path to the debug log file (useful for Windows debugging)
	ipcMain.handle('logger:getLogFilePath', async () => {
		return logger.getLogFilePath();
	});

	// Check if file logging is enabled
	ipcMain.handle('logger:isFileLoggingEnabled', async () => {
		return logger.isFileLoggingEnabled();
	});

	// Enable file logging (automatically enabled on Windows)
	ipcMain.handle('logger:enableFileLogging', async () => {
		logger.enableFileLogging();
	});

	// ============ Sync (Custom Storage Location) Handlers ============

	// List of settings files that should be migrated
	const SETTINGS_FILES = [
		'maestro-settings.json',
		'maestro-sessions.json',
		'maestro-groups.json',
		'maestro-agent-configs.json',
		'maestro-claude-session-origins.json',
	];

	// Get the default storage path
	ipcMain.handle('sync:getDefaultPath', async () => {
		return app.getPath('userData');
	});

	// Get current sync settings
	ipcMain.handle('sync:getSettings', async () => {
		if (!deps.bootstrapStore) {
			return { customSyncPath: undefined };
		}
		return {
			customSyncPath: deps.bootstrapStore.get('customSyncPath') || undefined,
		};
	});

	// Get current storage location (either custom or default)
	ipcMain.handle('sync:getCurrentStoragePath', async () => {
		if (!deps.bootstrapStore) {
			return app.getPath('userData');
		}
		const customPath = deps.bootstrapStore.get('customSyncPath');
		return customPath || app.getPath('userData');
	});

	// Select custom sync folder via dialog
	ipcMain.handle('sync:selectSyncFolder', async () => {
		const mainWindow = getMainWindow();
		if (!mainWindow) return null;

		const result = await dialog.showOpenDialog(mainWindow, {
			properties: ['openDirectory', 'createDirectory'],
			title: 'Select Settings Folder',
			message:
				'Choose a folder for Maestro settings. Use a synced folder (iCloud Drive, Dropbox, OneDrive) to share settings across devices.',
		});

		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}

		return result.filePaths[0];
	});

	// Set custom sync path and migrate settings
	ipcMain.handle('sync:setCustomPath', async (_event, newPath: string | null) => {
		if (!deps.bootstrapStore) {
			return { success: false, error: 'Bootstrap store not available' };
		}

		const defaultPath = app.getPath('userData');
		const currentCustomPath = deps.bootstrapStore.get('customSyncPath');
		const currentPath = currentCustomPath || defaultPath;
		const targetPath = newPath || defaultPath;

		// Don't do anything if paths are the same
		if (currentPath === targetPath) {
			return { success: true, migrated: 0 };
		}

		// Ensure target directory exists
		if (!fsSync.existsSync(targetPath)) {
			try {
				fsSync.mkdirSync(targetPath, { recursive: true });
			} catch {
				return { success: false, error: `Cannot create directory: ${targetPath}` };
			}
		}

		// Migrate settings files
		let migratedCount = 0;
		const errors: string[] = [];

		for (const file of SETTINGS_FILES) {
			const sourcePath = path.join(currentPath, file);
			const destPath = path.join(targetPath, file);

			try {
				if (fsSync.existsSync(sourcePath)) {
					// Check if destination already exists
					if (fsSync.existsSync(destPath)) {
						// Read both files to compare
						const sourceContent = fsSync.readFileSync(sourcePath, 'utf-8');
						const destContent = fsSync.readFileSync(destPath, 'utf-8');

						if (sourceContent !== destContent) {
							// Backup existing destination file
							const backupPath = destPath + '.backup.' + Date.now();
							fsSync.copyFileSync(destPath, backupPath);
							logger.info(`Backed up existing ${file} to ${backupPath}`, 'Sync');
						}
					}

					// Copy file to new location
					fsSync.copyFileSync(sourcePath, destPath);
					migratedCount++;
					logger.info(`Migrated ${file} to ${targetPath}`, 'Sync');
				}
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				errors.push(`Failed to migrate ${file}: ${errMsg}`);
				logger.error(`Failed to migrate ${file}`, 'Sync', error);
			}
		}

		// Update bootstrap store
		if (newPath) {
			deps.bootstrapStore.set('customSyncPath', newPath);
		} else {
			deps.bootstrapStore.delete('customSyncPath' as keyof BootstrapSettings);
		}

		// Clear the old iCloudSyncEnabled flag if it exists (legacy cleanup)
		if (deps.bootstrapStore.get('iCloudSyncEnabled')) {
			deps.bootstrapStore.delete('iCloudSyncEnabled' as keyof BootstrapSettings);
		}

		logger.info(
			`Storage location changed to ${targetPath}, migrated ${migratedCount} files`,
			'Sync'
		);

		return {
			success: errors.length === 0,
			migrated: migratedCount,
			errors: errors.length > 0 ? errors : undefined,
			requiresRestart: true,
		};
	});

	// ============ Power Management Handlers ============

	// Load saved preference and enable power manager if it was enabled
	const savedPreventSleep = settingsStore.get('preventSleepEnabled' as keyof MaestroSettings);
	if (savedPreventSleep === true) {
		powerManager.setEnabled(true);
		logger.info('Sleep prevention restored from settings', 'PowerManager');
	}

	// Set whether sleep prevention is enabled
	ipcMain.handle('power:setEnabled', async (_event, enabled: boolean) => {
		powerManager.setEnabled(enabled);
		settingsStore.set('preventSleepEnabled' as keyof MaestroSettings, enabled);
	});

	// Check if sleep prevention is enabled
	ipcMain.handle('power:isEnabled', async () => {
		return powerManager.isEnabled();
	});

	// Get current power management status
	ipcMain.handle('power:getStatus', async () => {
		return powerManager.getStatus();
	});

	// Add a reason to block sleep (for renderer to signal auto-run, etc.)
	ipcMain.handle('power:addReason', async (_event, reason: string) => {
		powerManager.addBlockReason(reason);
	});

	// Remove a reason for blocking sleep
	ipcMain.handle('power:removeReason', async (_event, reason: string) => {
		powerManager.removeBlockReason(reason);
	});
}

/**
 * Setup logger event forwarding to renderer.
 * This should be called after the main window is created.
 */
export function setupLoggerEventForwarding(getMainWindow: () => BrowserWindow | null): void {
	logger.on('newLog', (entry) => {
		const mainWindow = getMainWindow();
		// Safely send - handle cases where renderer is disposed (GPU crash, window closing)
		try {
			if (
				mainWindow &&
				!mainWindow.isDestroyed() &&
				mainWindow.webContents &&
				!mainWindow.webContents.isDestroyed()
			) {
				mainWindow.webContents.send('logger:newLog', entry);
			}
		} catch {
			// Silently ignore - renderer not available
		}
	});
}
