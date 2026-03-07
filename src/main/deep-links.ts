/**
 * Deep Link Handler for maestro:// URL scheme
 *
 * Provides OS-level protocol registration and URL parsing for deep links.
 * Enables clickable OS notifications and external app integrations.
 *
 * URL scheme:
 *   maestro://focus                            — bring window to foreground
 *   maestro://session/{sessionId}              — navigate to agent
 *   maestro://session/{sessionId}/tab/{tabId}  — navigate to agent + tab
 *   maestro://group/{groupId}                  — expand group, focus first session
 *
 * Platform behavior:
 *   macOS:         app.on('open-url') delivers the URL
 *   Windows/Linux: app.on('second-instance') delivers argv with URL;
 *                  cold start delivers via process.argv
 */

import path from 'path';
import { app, BrowserWindow } from 'electron';
import { logger } from './utils/logger';
import { isWebContentsAvailable } from './utils/safe-send';
import type { ParsedDeepLink } from '../shared/types';

// ============================================================================
// Constants
// ============================================================================

const PROTOCOL = 'maestro';
const IPC_CHANNEL = 'app:deepLink';

// ============================================================================
// State
// ============================================================================

/** URL received before the window was ready — flushed after createWindow() */
let pendingDeepLinkUrl: string | null = null;

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse a maestro:// URL into a structured deep link object.
 * Returns null for malformed or unrecognized URLs.
 */
export function parseDeepLink(url: string): ParsedDeepLink | null {
	try {
		// Normalize: strip protocol prefix (handles both maestro:// and maestro: on Windows)
		const normalized = url.replace(/^maestro:\/\//, '').replace(/^maestro:/, '');
		const parts = normalized.split('/').filter(Boolean);

		if (parts.length === 0) return { action: 'focus' };

		const [resource, id, sub, subId] = parts;

		if (resource === 'focus') return { action: 'focus' };

		if (resource === 'session' && id) {
			if (sub === 'tab' && subId) {
				return {
					action: 'session',
					sessionId: decodeURIComponent(id),
					tabId: decodeURIComponent(subId),
				};
			}
			return { action: 'session', sessionId: decodeURIComponent(id) };
		}

		if (resource === 'group' && id) {
			return { action: 'group', groupId: decodeURIComponent(id) };
		}

		logger.warn(`Unrecognized deep link resource: ${resource}`, 'DeepLink');
		return null;
	} catch (error) {
		logger.error('Failed to parse deep link URL', 'DeepLink', { url, error: String(error) });
		return null;
	}
}

// ============================================================================
// Deep Link Dispatch
// ============================================================================

/**
 * Process a deep link URL: parse it, bring window to foreground, and send to renderer.
 */
function processDeepLink(url: string, getMainWindow: () => BrowserWindow | null): void {
	logger.info('Processing deep link', 'DeepLink', { url });

	const parsed = parseDeepLink(url);
	if (!parsed) return;

	const win = getMainWindow();
	if (!win) {
		// Window not ready yet — buffer for later
		pendingDeepLinkUrl = url;
		logger.debug('Window not ready, buffering deep link', 'DeepLink');
		return;
	}

	// Bring window to foreground
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();

	// For 'focus' action, bringing window to front is all we need
	if (parsed.action === 'focus') return;

	// Send parsed payload to renderer for navigation
	if (isWebContentsAvailable(win)) {
		win.webContents.send(IPC_CHANNEL, parsed);
	}
}

// ============================================================================
// Lifecycle Setup
// ============================================================================

/**
 * Set up deep link protocol handling.
 *
 * MUST be called synchronously before app.whenReady() because
 * requestSingleInstanceLock() only works before the app is ready.
 *
 * @returns false if another instance is already running (caller should app.quit())
 */
export function setupDeepLinkHandling(getMainWindow: () => BrowserWindow | null): boolean {
	// Register as handler for maestro:// URLs
	// In dev mode, skip registration to avoid clobbering the production app's registration
	const isDev = !app.isPackaged;
	if (!isDev) {
		app.setAsDefaultProtocolClient(PROTOCOL);
		logger.info('Registered as default protocol client for maestro://', 'DeepLink');
	} else {
		// In dev, register only if explicitly opted in
		if (process.env.REGISTER_DEEP_LINKS_IN_DEV === '1') {
			// In dev mode, the bare Electron binary is used. We must pass the app
			// entry point as an argument so macOS launches Maestro, not the default
			// Electron splash screen.
			const appPath = path.resolve(process.argv[1]);
			app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [appPath]);
			logger.info(
				`Registered protocol client in dev mode (REGISTER_DEEP_LINKS_IN_DEV=1, entry=${appPath})`,
				'DeepLink'
			);
		} else {
			logger.debug('Skipping protocol registration in dev mode', 'DeepLink');
		}
	}

	// Single-instance lock (Windows/Linux deep link support)
	// On macOS, open-url handles this; on Windows/Linux, the OS launches a new instance
	// with the URL in argv, and second-instance event fires in the primary instance
	const gotTheLock = app.requestSingleInstanceLock();
	if (!gotTheLock) {
		// Another instance is running — it will receive our argv via second-instance
		logger.info('Another instance is running, quitting', 'DeepLink');
		return false;
	}

	// Handle second-instance event (Windows/Linux: new instance launched with deep link URL)
	app.on('second-instance', (_event, argv) => {
		const deepLinkUrl = argv.find(
			(arg) => arg.startsWith(`${PROTOCOL}://`) || arg.startsWith(`${PROTOCOL}:`)
		);
		if (deepLinkUrl) {
			processDeepLink(deepLinkUrl, getMainWindow);
		} else {
			// No deep link, but user tried to open a second instance — bring existing window to front
			const win = getMainWindow();
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		}
	});

	// Handle open-url event (macOS: OS delivers URL to running app)
	app.on('open-url', (event, url) => {
		event.preventDefault();
		processDeepLink(url, getMainWindow);
	});

	// Check process.argv for cold-start deep link (Windows/Linux: app launched with URL as arg)
	const deepLinkArg = process.argv.find(
		(arg) => arg.startsWith(`${PROTOCOL}://`) || arg.startsWith(`${PROTOCOL}:`)
	);
	if (deepLinkArg) {
		pendingDeepLinkUrl = deepLinkArg;
		logger.info('Found deep link in process argv (cold start)', 'DeepLink', { url: deepLinkArg });
	}

	return true;
}

/**
 * Flush any pending deep link URL that arrived before the window was ready.
 * Call this after createWindow() inside app.whenReady().
 */
export function flushPendingDeepLink(getMainWindow: () => BrowserWindow | null): void {
	if (!pendingDeepLinkUrl) return;

	const url = pendingDeepLinkUrl;
	pendingDeepLinkUrl = null;
	logger.info('Flushing pending deep link', 'DeepLink', { url });
	processDeepLink(url, getMainWindow);
}

/**
 * Directly dispatch a parsed deep link to the renderer.
 * Used by notification click handlers to avoid an OS protocol round-trip.
 */
export function dispatchDeepLink(
	parsed: ParsedDeepLink,
	getMainWindow: () => BrowserWindow | null
): void {
	const win = getMainWindow();
	if (!win) return;

	// Bring window to foreground
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();

	if (parsed.action === 'focus') return;

	if (isWebContentsAvailable(win)) {
		win.webContents.send(IPC_CHANNEL, parsed);
	}
}
