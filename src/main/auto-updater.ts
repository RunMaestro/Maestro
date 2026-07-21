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
import { getReleaseDownloadFeedUrl } from './update-checker';

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

/** Number of attempts (1 initial + retries) for transient GitHub failures. */
const UPDATE_MAX_ATTEMPTS = 3;
/** Base backoff between retries; doubles each attempt (1s, 2s). */
const UPDATE_RETRY_BASE_DELAY_MS = 1000;

/**
 * Detect transient network failures worth retrying. electron-updater fetches
 * `releases.atom` from GitHub, which intermittently returns 5xx gateway errors
 * (notably 504 Gateway Time-out) or drops the connection. These resolve on their
 * own, so a short backoff-retry sails through them instead of failing the update.
 */
function isTransientUpdateError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	// HTTP gateway / server / overload statuses that GitHub serves transiently.
	if (/\b(408|425|429|500|502|503|504)\b/.test(message)) return true;
	// Node socket-level failures.
	if (
		/(etimedout|esockettimedout|econnreset|econnrefused|enotfound|eai_again|enetunreach|epipe)/.test(
			message
		)
	) {
		return true;
	}
	// Generic phrasing emitted by various layers.
	return /(timed out|timeout|gateway time-?out|socket hang up|network|temporarily unavailable)/.test(
		message
	);
}

/**
 * Turn a raw updater error into a concise, user-facing message. GitHub 504s
 * arrive as a wall of HTML plus response headers and cookies; surfacing that
 * verbatim is noise. Collapse transient failures to a plain "try again" line and
 * strip any embedded HTML body from everything else.
 */
function describeUpdateError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const statusMatch = raw.match(/\b(408|425|429|500|502|503|504)\b/);
	if (isTransientUpdateError(error)) {
		const code = statusMatch ? ` (HTTP ${statusMatch[1]})` : '';
		return `GitHub is temporarily unavailable${code}. This is usually brief - try again in a moment, or download manually from GitHub.`;
	}
	// Drop any HTML payload (e.g. an error page) and trailing header/cookie dumps.
	const htmlIndex = raw.search(/<html|<!doctype/i);
	const trimmed = htmlIndex >= 0 ? raw.slice(0, htmlIndex) : raw;
	return trimmed.replace(/\s+/g, ' ').trim() || 'Unknown error';
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a GitHub-hitting updater operation, retrying transient failures with
 * exponential backoff. Non-transient errors (and the final attempt) rethrow so
 * the caller surfaces them.
 */
async function withUpdateRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= UPDATE_MAX_ATTEMPTS; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt >= UPDATE_MAX_ATTEMPTS || !isTransientUpdateError(error)) {
				throw error;
			}
			const wait = UPDATE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			logger.warn(
				`${label} hit a transient error (attempt ${attempt}/${UPDATE_MAX_ATTEMPTS}), retrying in ${wait}ms: ${
					error instanceof Error ? error.message.slice(0, 120) : String(error)
				}`,
				'AutoUpdater'
			);
			await delay(wait);
		}
	}
	// Unreachable: the loop either returns or throws, but satisfies the type checker.
	throw lastError;
}

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
 * vitest's module mocker - this hook lets tests provide a stand-in.
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
	 * confirmation gate so the Windows installer - which spawns waiting on our PID
	 * - isn't orphaned by `before-quit` preventDefault.
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
		currentStatus = { status: 'error', error: describeUpdateError(err) };
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
			const result = await withUpdateRetry('electron-updater check', () =>
				autoUpdater.checkForUpdates()
			);
			logger.info(
				`electron-updater check result: ${result?.updateInfo ? `v${result.updateInfo.version} available` : 'no update'}`,
				'AutoUpdater',
				result?.updateInfo
					? { version: result.updateInfo.version, releaseDate: result.updateInfo.releaseDate }
					: undefined
			);
			return { success: true, updateInfo: result?.updateInfo };
		} catch (error) {
			const errorMessage = describeUpdateError(error);
			logger.error(`electron-updater check failed: ${errorMessage}`, 'AutoUpdater', {
				stack: error instanceof Error ? error.stack : undefined,
			});
			currentStatus = { status: 'error', error: errorMessage };
			sendStatusToRenderer();
			return { success: false, error: errorMessage };
		}
	});

	// Download update
	ipcMain.handle('updates:download', async (_event, targetTag?: string) => {
		try {
			// First, check for updates with electron-updater to tell it which version to download
			// This is required because the UI uses the GitHub API check, not electron-updater's check.
			//
			// When the renderer hands us the exact release tag it's offering, point
			// electron-updater at that release's CDN-served asset directory via a
			// generic provider. This bypasses the default GitHub provider's
			// `releases.atom` lookup, which intermittently (sometimes persistently)
			// returns 504 Gateway Time-out. Falls back to the bundled GitHub provider
			// when no tag is supplied (e.g. background auto-update paths).
			if (targetTag) {
				const feedUrl = getReleaseDownloadFeedUrl(targetTag);
				autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
				logger.info(
					`Pointing electron-updater at CDN release assets for ${targetTag} (bypasses releases.atom): ${feedUrl}`,
					'AutoUpdater'
				);
			} else {
				logger.info(
					`Pre-download check via default GitHub provider (allowPrerelease: ${autoUpdater.allowPrerelease}) - no target tag supplied`,
					'AutoUpdater'
				);
			}
			const checkResult = await withUpdateRetry('pre-download check', () =>
				autoUpdater.checkForUpdates()
			);

			if (!checkResult || !checkResult.updateInfo) {
				logger.error(
					'No update found during pre-download check - electron-updater found nothing to download',
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
			await withUpdateRetry('download', () => autoUpdater.downloadUpdate());
			logger.info(
				`Download of v${checkResult.updateInfo.version} completed successfully`,
				'AutoUpdater'
			);
			return { success: true };
		} catch (error) {
			const errorMessage = describeUpdateError(error);
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
		logger.info('Installing update - quitting and restarting app', 'AutoUpdater');
		// Bypass the busy-agent quit confirmation gate. The user already opted in
		// via the update modal, and on Windows quitAndInstall spawns the NSIS
		// installer bound to our PID - if before-quit preventDefaults the quit, the
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
