/**
 * Web/Live IPC Handlers
 *
 * This module handles IPC calls for web interface and live session operations:
 * - web:broadcastUserInput: Broadcast user input to web clients
 * - web:broadcastAutoRunState: Broadcast AutoRun state to web clients
 * - web:broadcastTabsChange: Broadcast tab changes to web clients
 * - web:broadcastSessionState: Broadcast session state changes to web clients
 * - live:toggle: Toggle live mode for a session
 * - live:getStatus: Get live status for a session
 * - live:getDashboardUrl: Get the dashboard URL
 * - live:getLiveSessions: Get all live sessions
 * - live:broadcastActiveSession: Broadcast active session change
 * - live:startServer: Start the web server
 * - live:stopServer: Stop the web server
 * - live:persistCurrentToken: Persist the running server's token and enable persistent web link
 * - live:clearPersistentToken: Clear the persisted token and disable persistent web link
 * - live:disableAll: Disable all live sessions and stop server
 * - webserver:getUrl: Get the web server URL
 * - webserver:getConnectedClients: Get connected client count
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { AITabData } from '../../web-server/services/broadcastService';
import { getAutoRunStateTracker } from '../../autorun/autorun-state-tracker';
import type { AutoRunBroadcastState } from '../../../shared/autoRunBroadcast';
import {
	startLiveServer,
	stopLiveServer,
	disableAllLive,
	isLiveModeOn,
	type LiveModeDependencies,
} from '../../web-server/live-mode';

// The CLI server lifecycle lives in the Live Mode service; re-exported here
// because startup and the quit handler have always imported it from this module.
export {
	ensureCliServer,
	startCliDiscoveryWatchdog,
	stopCliDiscoveryWatchdog,
} from '../../web-server/live-mode';

/**
 * Timeout for waiting for web server to become active (ms)
 */
const SERVER_STARTUP_TIMEOUT_MS = 5000;

/**
 * Polling interval when waiting for server startup (ms)
 */
const SERVER_STARTUP_POLL_INTERVAL_MS = 100;

/**
 * Dependencies required for web handlers. Same shape as the Live Mode
 * service's deps, since most of what these handlers do is call it.
 */
export type WebHandlerDependencies = LiveModeDependencies;

/**
 * True when this invoke arrived over the web-desktop WebSocket bridge rather
 * than from an Electron renderer.
 *
 * `handleBridgeInvoke` dispatches to the registered `ipcMain` handler with a
 * synthetic event (`FAKE_EVENT` in `web-server/handlers/bridgeHandlers.ts`)
 * stamped `type: 'bridge'`; a real `IpcMainInvokeEvent` has no `type`. This is
 * the only thing that tells main WHICH client owns an Auto Run, and the whole
 * echo-safety of the forward below rests on it.
 */
function isBridgeOriginatedInvoke(event: unknown): boolean {
	return (event as { type?: unknown } | null)?.type === 'bridge';
}

/**
 * Mirror a web-owned Auto Run into the Electron desktop windows.
 *
 * Auto Run is renderer-owned state, so a run started in a web-desktop browser
 * tab lives entirely in that tab. #1508 taught the browser to RENDER a run
 * owned by the desktop (`autorun_state` -> `remote:autoRunStateMirror`), but
 * only in that direction: the desktop is not a WebSocket client, so nothing
 * carried the reverse. The desktop drew the agent as idle for the whole run.
 *
 * Two deliberate narrowings:
 *
 * 1. **Bridge-originated frames only.** A desktop-owned run must never be
 *    forwarded, or the owning window would receive its own state back and
 *    `applyAutoRunMirrorFrame` could stamp its own live run `mirrored: true` -
 *    which disables Stop, Skip, Resume and Abort on the window that is actually
 *    driving the run. The renderer has an ownership guard of its own, but the
 *    cheapest way to be sure is not to send the echo in the first place.
 *
 * 2. **Not `safeSend`.** `safeSend` fans every push out to the bridge as well,
 *    which would deliver this frame to web clients a second time on a second
 *    channel - they already receive it as `autorun_state`. The desktop windows
 *    are the entire audience for this message, so it goes straight to them.
 *
 * Still out of scope: desktop window A does not mirror into desktop window B.
 * That needs the same echo reasoning applied per-window and is not what #1519
 * reports.
 */
function forwardAutoRunStateToDesktopWindows(
	event: unknown,
	sessionId: string,
	state: AutoRunBroadcastState | null
): void {
	if (!isBridgeOriginatedInvoke(event)) return;

	for (const win of BrowserWindow.getAllWindows()) {
		try {
			if (isWebContentsAvailable(win)) {
				win.webContents.send('remote:autoRunStateMirror', sessionId, state);
			}
		} catch (error) {
			// A window closing mid-broadcast is routine, not a fault. Keep going so
			// one dead window never costs the others their frame.
			logger.debug('Failed to mirror Auto Run state to a desktop window', 'WebHandlers', {
				error: String(error),
			});
		}
	}
}

/**
 * Register all web/live-related IPC handlers.
 */
export function registerWebHandlers(deps: WebHandlerDependencies): void {
	const { getWebServer, settingsStore } = deps;

	// Broadcast user input to web clients (called when desktop sends a message)
	ipcMain.handle(
		'web:broadcastUserInput',
		async (_, sessionId: string, command: string, inputMode: 'ai' | 'terminal') => {
			const webServer = getWebServer();
			const clientCount = webServer?.getWebClientCount() ?? 0;
			logger.debug(
				`web:broadcastUserInput called - webServer: ${webServer ? 'exists' : 'null'}, clientCount: ${clientCount}`,
				'WebBroadcast'
			);
			if (webServer && clientCount > 0) {
				webServer.broadcastUserInput(sessionId, command, inputMode);
				return true;
			}
			return false;
		}
	);

	// Broadcast AutoRun state to web clients (called when batch processing state changes)
	// Always store state even if no clients are connected, so new clients get initial state
	ipcMain.handle('web:claimAutoRunStart', async (_, sessionId: string) => {
		return getAutoRunStateTracker().tryClaimStart(sessionId);
	});
	ipcMain.handle('web:releaseAutoRunStartClaim', async (_, sessionId: string) => {
		return getAutoRunStateTracker().releaseStartClaim(sessionId);
	});

	ipcMain.handle(
		'web:broadcastAutoRunState',
		async (event, sessionId: string, state: AutoRunBroadcastState | null) => {
			// Feed the first-party main-process tracker FIRST, unconditionally.
			// The web-server branch below returns early when Live Mode is off, so
			// anything downstream of it (dispatch callbacks, and later Cue's
			// agent.completed) would otherwise never learn that an Auto Run batch
			// finished. Auto Run finality is main-process state now, not a
			// web-broadcast side effect.
			getAutoRunStateTracker().update(sessionId, state);

			// A run OWNED by a web-desktop browser client has to reach the desktop
			// windows too, or the desktop renders the agent as idle for the whole
			// run. Web clients are already served by the `autorun_state` packet
			// below; the desktop is not a WebSocket client, so this is its only
			// path to the frame.
			forwardAutoRunStateToDesktopWindows(event, sessionId, state);

			const webServer = getWebServer();
			if (webServer) {
				// Always call broadcastAutoRunState - it stores the state for new clients
				// and broadcasts to any currently connected clients
				webServer.broadcastAutoRunState(sessionId, state);
				return true;
			}
			return false;
		}
	);

	// Broadcast tab changes to web clients
	ipcMain.handle('web:requestNewTab', async (_, sessionId: string, background = false) => {
		const webServer = getWebServer();
		return webServer?.requestNewTab(sessionId, background) ?? null;
	});
	ipcMain.handle('web:requestCloseTab', async (_, sessionId: string, tabId: string) => {
		return getWebServer()?.requestCloseTab(sessionId, tabId) ?? false;
	});

	ipcMain.handle(
		'web:broadcastTabsChange',
		async (
			_,
			sessionId: string,
			aiTabs: AITabData[],
			activeTabId: string,
			activeTabChanged = false
		) => {
			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				webServer.broadcastTabsChange(sessionId, aiTabs, activeTabId, activeTabChanged);
				return true;
			}
			return false;
		}
	);

	// Broadcast session state change to web clients (for real-time busy/idle updates)
	// This is called directly from the renderer to bypass debounced persistence
	// which resets state to 'idle' before saving
	ipcMain.handle(
		'web:broadcastSessionState',
		async (
			_,
			sessionId: string,
			state: string,
			additionalData?: {
				name?: string;
				toolType?: string;
				inputMode?: string;
				cwd?: string;
			}
		) => {
			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				webServer.broadcastSessionStateChange(sessionId, state, additionalData);
				return true;
			}
			return false;
		}
	);

	// Live session management - toggle sessions as live/offline in web interface
	ipcMain.handle('live:toggle', async (_, sessionId: string, agentSessionId?: string) => {
		const webServer = getWebServer();
		if (!webServer) {
			throw new Error('Web server not initialized');
		}

		// Ensure web server is running before allowing live toggle
		if (!webServer.isActive()) {
			logger.warn('Web server not yet started, waiting...', 'Live');
			// Wait for server to start (with timeout)
			const startTime = Date.now();
			while (!webServer.isActive() && Date.now() - startTime < SERVER_STARTUP_TIMEOUT_MS) {
				await new Promise((resolve) => setTimeout(resolve, SERVER_STARTUP_POLL_INTERVAL_MS));
			}
			if (!webServer.isActive()) {
				throw new Error('Web server failed to start');
			}
		}

		const isLive = webServer.isSessionLive(sessionId);

		if (isLive) {
			// Turn off live mode
			webServer.setSessionOffline(sessionId);
			logger.info(`Session ${sessionId} is now offline`, 'Live');
			return { live: false, url: null };
		} else {
			// Turn on live mode
			logger.info(
				`Enabling live mode for session ${sessionId} (claude: ${agentSessionId || 'none'})`,
				'Live'
			);
			webServer.setSessionLive(sessionId, agentSessionId);
			const url = webServer.getSessionUrl(sessionId);
			logger.info(`Session ${sessionId} is now live at ${url}`, 'Live');
			return { live: true, url };
		}
	});

	ipcMain.handle('live:getStatus', async (_, sessionId: string) => {
		const webServer = getWebServer();
		if (!webServer) {
			return { live: false, url: null };
		}
		const isLive = webServer.isSessionLive(sessionId);
		return {
			live: isLive,
			url: isLive ? webServer.getSessionUrl(sessionId) : null,
		};
	});

	// Only a Live Mode (LAN) server has a dashboard. The loopback CLI server's
	// URL is not one: auto-start reads a non-null answer as "Live is already
	// on" and would never open the server to the LAN.
	ipcMain.handle('live:getDashboardUrl', async () => {
		const webServer = getWebServer();
		return isLiveModeOn(webServer) ? webServer.getSecureUrl() : null;
	});

	ipcMain.handle('live:getLiveSessions', async () => {
		const webServer = getWebServer();
		if (!webServer) {
			return [];
		}
		return webServer.getLiveSessions();
	});

	ipcMain.handle('live:broadcastActiveSession', async (_, sessionId: string) => {
		const webServer = getWebServer();
		if (webServer) {
			webServer.broadcastActiveSessionChange(sessionId);
		}
	});

	// Start web server (creates if needed, starts if not running). Shared with
	// `maestro-cli live on` through the Live Mode service.
	ipcMain.handle('live:startServer', async () => startLiveServer(deps));

	// Stop web server and clean up
	ipcMain.handle('live:stopServer', async () => stopLiveServer(deps));

	// Persist the current web server's security token and enable persistent web link.
	// Flag is written first: a crash between the two writes leaves
	// persistentWebLink=true with a missing/stale token, which the factory
	// handles by generating and persisting a fresh UUID on next startup.
	ipcMain.handle('live:persistCurrentToken', async () => {
		const webServer = getWebServer();
		if (!webServer || !webServer.isActive()) {
			return { success: false, message: 'Web server is not running.' };
		}
		try {
			const currentToken = webServer.getSecurityToken();
			settingsStore.set('persistentWebLink', true);
			settingsStore.set('webAuthToken', currentToken);
			logger.info(
				'Persisted current web server token and enabled persistent web link',
				'WebServer'
			);
			return { success: true };
		} catch (error: any) {
			// Rollback the flag so the factory doesn't read persistentWebLink=true
			// with a missing token on next startup, which would silently change the URL.
			try {
				settingsStore.set('persistentWebLink', false);
			} catch {
				// Best-effort rollback - disk may be completely unavailable
			}
			logger.error(`Failed to persist web server token: ${error.message}`, 'WebServer');
			return { success: false, message: error.message };
		}
	});

	// Clear persistent web link token and disable the flag on the main side.
	// Flag is cleared first: a crash between the two writes leaves
	// persistentWebLink=false with a stale token, which the factory ignores.
	ipcMain.handle('live:clearPersistentToken', async () => {
		try {
			settingsStore.set('persistentWebLink', false);
			settingsStore.set('webAuthToken', null);
			logger.info('Cleared persistent web link token and disabled flag', 'WebServer');
			return { success: true };
		} catch (error: any) {
			// Rollback the flag so disk state stays consistent - prevents
			// persistentWebLink=false with a stale token on next startup.
			try {
				settingsStore.set('persistentWebLink', true);
			} catch {
				// Best-effort rollback - disk may be completely unavailable
			}
			logger.error(`Failed to clear persistent token: ${error.message}`, 'WebServer');
			return { success: false, message: error.message };
		}
	});

	// Disable all live sessions and stop the server
	ipcMain.handle('live:disableAll', async () => disableAllLive(deps));

	// Web server management
	ipcMain.handle('webserver:getUrl', async () => {
		return getWebServer()?.getSecureUrl();
	});

	ipcMain.handle('webserver:getConnectedClients', async () => {
		return getWebServer()?.getWebClientCount() || 0;
	});
}
