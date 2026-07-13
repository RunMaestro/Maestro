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
import { parseMaestroDeepLink } from '../shared/deep-link-urls';
import { captureException } from './utils/sentry';
import {
	parseWorkspaceLink,
	type SnapshotToken,
	type WorkspaceLinkResolution,
	type WorkspaceLocalId,
} from '../shared/plugins/workspace-foundation';

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

export interface WorkspaceDeepLinkHandlers {
	readonly resolveWorkspaceLink: (url: string) => WorkspaceLinkResolution | null;
	readonly selectBySnapshotToken: (snapshotToken: SnapshotToken) => WorkspaceLinkResolution | null;
}

interface WorkspaceDeepLinkPayload {
	readonly action: 'workspace';
	readonly ownerPluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly externalSessionId: string;
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse a maestro:// URL into a structured deep link object.
 * Returns null for malformed or unrecognized URLs.
 *
 * Wraps the pure shared parser with Sentry/log instrumentation so we keep
 * visibility into malformed URLs reaching the main process.
 */
export function parseDeepLink(url: string): ParsedDeepLink | null {
	try {
		const parsed = parseMaestroDeepLink(url);
		if (!parsed) {
			logger.warn('Unrecognized deep link route', 'DeepLink', { route: 'unknown' });
		}
		return parsed;
	} catch {
		void captureException(new Error('Deep link parsing failed'), {
			extra: { route: 'unknown' },
		});
		logger.error('Failed to parse deep link route', 'DeepLink', { route: 'unknown' });
		return null;
	}
}

// ============================================================================
// Deep Link Dispatch
// ============================================================================

function isWorkspaceDeepLink(url: string): boolean {
	return url.startsWith(`${PROTOCOL}://workspace`);
}

function bufferDeepLink(url: string, route: 'maestro' | 'workspace', reason: string): void {
	pendingDeepLinkUrl = url;
	logger.debug('Deep link deferred', 'DeepLink', { route, reason });
}

function reportWorkspaceResolution(
	outcome: WorkspaceLinkResolution['kind'] | 'registry_unavailable'
): void {
	logger.warn('Workspace deep link rejected', 'DeepLink', { route: 'workspace', outcome });
}

function processWorkspaceDeepLink(
	url: string,
	getMainWindow: () => BrowserWindow | null,
	workspaceHandlers: WorkspaceDeepLinkHandlers | undefined
): void {
	const parsed = parseWorkspaceLink(url);
	if (!parsed) {
		reportWorkspaceResolution('syntax_invalid');
		return;
	}
	if (!workspaceHandlers) {
		reportWorkspaceResolution('registry_unavailable');
		return;
	}

	const resolution = workspaceHandlers.resolveWorkspaceLink(url);
	if (!resolution) {
		bufferDeepLink(url, 'workspace', 'registry_unavailable');
		return;
	}
	if (resolution.kind !== 'resolved') {
		reportWorkspaceResolution(resolution.kind);
		return;
	}

	const win = getMainWindow();
	if (!win) {
		bufferDeepLink(url, 'workspace', 'window_unavailable');
		return;
	}

	const selected = workspaceHandlers.selectBySnapshotToken(parsed.snapshotToken);
	if (!selected) {
		bufferDeepLink(url, 'workspace', 'registry_unavailable');
		return;
	}
	if (selected.kind !== 'resolved') {
		reportWorkspaceResolution(selected.kind);
		return;
	}

	const workspacePayload: WorkspaceDeepLinkPayload = {
		action: 'workspace',
		ownerPluginId: selected.ownerPluginId,
		workspaceLocalId: selected.workspaceLocalId,
		externalSessionId: selected.externalSession.externalSessionId,
	};

	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	if (isWebContentsAvailable(win)) {
		win.webContents.send(IPC_CHANNEL, workspacePayload);
	}
}

/**
 * Process a deep link URL: parse it, bring window to foreground, and send to renderer.
 */
function processDeepLink(
	url: string,
	getMainWindow: () => BrowserWindow | null,
	workspaceHandlers?: WorkspaceDeepLinkHandlers
): void {
	if (isWorkspaceDeepLink(url)) {
		processWorkspaceDeepLink(url, getMainWindow, workspaceHandlers);
		return;
	}

	logger.info('Processing deep link', 'DeepLink', { route: 'maestro' });
	const parsed = parseDeepLink(url);
	if (!parsed) return;

	const win = getMainWindow();
	if (!win) {
		bufferDeepLink(url, 'maestro', 'window_unavailable');
		return;
	}

	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();

	if (parsed.action === 'focus') return;

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
export function setupDeepLinkHandling(
	getMainWindow: () => BrowserWindow | null,
	workspaceHandlers?: WorkspaceDeepLinkHandlers
): boolean {
	// Register as handler for maestro:// URLs
	// In dev mode, skip registration to avoid clobbering the production app's registration
	const isDev = !app.isPackaged;
	const shouldUseSingleInstanceLock =
		!isDev ||
		process.env.REGISTER_DEEP_LINKS_IN_DEV === '1' ||
		process.env.ENFORCE_SINGLE_INSTANCE_IN_DEV === '1';

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

	if (!shouldUseSingleInstanceLock) {
		logger.debug('Skipping single-instance lock in dev mode', 'DeepLink');
		return true;
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
			processDeepLink(deepLinkUrl, getMainWindow, workspaceHandlers);
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
		processDeepLink(url, getMainWindow, workspaceHandlers);
	});

	// Check process.argv for cold-start deep link (Windows/Linux: app launched with URL as arg)
	const deepLinkArg = process.argv.find(
		(arg) => arg.startsWith(`${PROTOCOL}://`) || arg.startsWith(`${PROTOCOL}:`)
	);
	if (deepLinkArg) {
		pendingDeepLinkUrl = deepLinkArg;
		logger.info('Found deep link in process argv (cold start)', 'DeepLink', {
			route: isWorkspaceDeepLink(deepLinkArg) ? 'workspace' : 'maestro',
		});
	}

	return true;
}

/**
 * Flush any pending deep link URL that arrived before the window was ready.
 * Call this after createWindow() inside app.whenReady().
 */
export function flushPendingDeepLink(
	getMainWindow: () => BrowserWindow | null,
	workspaceHandlers?: WorkspaceDeepLinkHandlers
): void {
	if (!pendingDeepLinkUrl) return;

	const url = pendingDeepLinkUrl;
	pendingDeepLinkUrl = null;
	logger.info('Flushing pending deep link', 'DeepLink', {
		route: isWorkspaceDeepLink(url) ? 'workspace' : 'maestro',
	});
	processDeepLink(url, getMainWindow, workspaceHandlers);
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
