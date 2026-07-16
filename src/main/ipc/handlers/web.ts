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

import { ipcMain, app } from 'electron';
import { logger } from '../../utils/logger';
import { WebServer } from '../../web-server';
import type { AITabData } from '../../web-server/services/broadcastService';
import type { SettingsStoreInterface } from '../../stores/types';
import {
	writeCliServerInfo,
	deleteCliServerInfo,
	readCliServerInfo,
} from '../../../shared/cli-server-discovery';

/**
 * Timeout for waiting for web server to become active (ms)
 */
const SERVER_STARTUP_TIMEOUT_MS = 5000;

/**
 * Polling interval when waiting for server startup (ms)
 */
const SERVER_STARTUP_POLL_INTERVAL_MS = 100;

/**
 * Dependencies required for web handlers
 */
export interface WebHandlerDependencies {
	getWebServer: () => WebServer | null;
	setWebServer: (server: WebServer | null) => void;
	createWebServer: () => WebServer;
	settingsStore: SettingsStoreInterface;
}

/**
 * Write the CLI discovery file for the currently-running server so the CLI
 * can locate it. Centralized so `ensureCliServer` and `live:startServer`
 * cannot drift on pid/startedAt semantics or future fields.
 */
function refreshCliDiscoveryFile(port: number, token: string): void {
	writeCliServerInfo({
		port,
		token,
		pid: process.pid,
		startedAt: Date.now(),
		// Stamp the running build's version so the CLI can detect version skew
		// (e.g. a freshly-built CLI talking to an older still-running app).
		version: app.getVersion(),
	});
}

/**
 * Verify the discovery file on disk matches the running server. Used by
 * `ensureCliServer` to detect silent write failures or external interference
 * (deleted file, stale pid, etc.).
 */
function discoveryFileMatches(port: number, token: string): boolean {
	const info = readCliServerInfo();
	return info !== null && info.port === port && info.token === token && info.pid === process.pid;
}

/** Number of times `ensureCliServer` will retry on failure. */
const ENSURE_CLI_MAX_ATTEMPTS = 3;

/**
 * Ensure the CLI server is running and the discovery file is published.
 *
 * Called during app initialization to make the web server always available
 * for CLI IPC connections. The server binds to 0.0.0.0 - this is intentional
 * for LAN accessibility; the UUID security token prevents unauthorized access.
 *
 * Retries on any failure (port collision, transient fs error, etc.) and
 * verifies the discovery file is actually present on disk after each attempt.
 * Historically this could fail silently when a later `whenReady` step threw
 * before we got here, leaving the CLI unable to connect until the user
 * manually toggled Live Mode.
 */
export async function ensureCliServer(deps: WebHandlerDependencies): Promise<boolean> {
	const { getWebServer, setWebServer, createWebServer } = deps;

	for (let attempt = 1; attempt <= ENSURE_CLI_MAX_ATTEMPTS; attempt++) {
		try {
			let webServer = getWebServer();

			if (!webServer) {
				logger.info(`Creating CLI server (attempt ${attempt})`, 'CliServer');
				webServer = createWebServer();
				setWebServer(webServer);
			}

			if (!webServer.isActive()) {
				logger.info(`Starting CLI server (attempt ${attempt})`, 'CliServer');
				const { port, token } = await webServer.start();
				logger.info(`CLI server running on port ${port}`, 'CliServer');
				refreshCliDiscoveryFile(port, token);
			} else {
				refreshCliDiscoveryFile(webServer.getPort(), webServer.getSecurityToken());
			}

			if (discoveryFileMatches(webServer.getPort(), webServer.getSecurityToken())) {
				if (attempt > 1) {
					logger.info(`CLI discovery file confirmed after ${attempt} attempt(s)`, 'CliServer');
				}
				return true;
			}

			logger.warn(
				`CLI discovery file missing/mismatched after write (attempt ${attempt}); will retry`,
				'CliServer'
			);
		} catch (error: any) {
			logger.error(
				`Failed to start CLI server (attempt ${attempt}): ${error?.message ?? error}`,
				'CliServer'
			);
			// Tear down the (potentially half-initialized) server so the next
			// attempt creates a fresh instance instead of reusing a broken one.
			const existing = getWebServer();
			if (existing) {
				try {
					await existing.stop();
				} catch {
					// Best-effort cleanup - the next attempt will recreate the server.
				}
				setWebServer(null);
			}
		}

		if (attempt < ENSURE_CLI_MAX_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
		}
	}

	logger.error(
		`Gave up starting CLI server after ${ENSURE_CLI_MAX_ATTEMPTS} attempts - maestro-cli will be unavailable until Live Mode is toggled`,
		'CliServer'
	);
	return false;
}

/** Active watchdog timer, if any. */
let cliDiscoveryWatchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Default interval between watchdog checks.
 *
 * Short on purpose: maestro-cli is the user's hands-off entry point and a 30s
 * window of "command says app isn't running" is enough to retrain muscle
 * memory toward toggling Live Mode. 5s self-heals well before the user gives
 * up and reaches for the UI.
 */
const CLI_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * Start a periodic watchdog that re-publishes the CLI discovery file whenever
 * it goes missing or drifts out of sync with the running server. Defense in
 * depth for cases the main-path retry can't catch (file deleted externally,
 * disk hiccup after a successful write, ensureCliServer racing with a Live
 * Mode toggle, etc.). Also self-heals if the initial ensureCliServer attempt
 * gave up - the next time the server is reachable, the watchdog republishes.
 *
 * Safe to call multiple times - the previous timer is cleared first. Pass
 * `intervalMs` only for tests; production uses the default 5s interval.
 */
export function startCliDiscoveryWatchdog(
	deps: WebHandlerDependencies,
	intervalMs: number = CLI_WATCHDOG_INTERVAL_MS
): void {
	stopCliDiscoveryWatchdog();
	cliDiscoveryWatchdog = setInterval(() => {
		const webServer = deps.getWebServer();
		if (!webServer) {
			// No server yet (initial ensureCliServer never succeeded) - try to
			// bring one up so maestro-cli works without forcing a Live Mode toggle.
			void ensureCliServer(deps).catch((err: unknown) => {
				logger.error(
					`Watchdog ensureCliServer failed: ${err instanceof Error ? err.message : String(err)}`,
					'CliServer'
				);
			});
			return;
		}
		if (!webServer.isActive()) {
			return;
		}
		const port = webServer.getPort();
		const token = webServer.getSecurityToken();
		if (discoveryFileMatches(port, token)) {
			return;
		}
		logger.warn('CLI discovery file is missing or stale - watchdog republishing', 'CliServer');
		try {
			refreshCliDiscoveryFile(port, token);
		} catch (err: any) {
			logger.error(
				`Watchdog failed to refresh CLI discovery file: ${err?.message ?? err}`,
				'CliServer'
			);
		}
	}, intervalMs);
	// Don't keep the event loop alive just for the watchdog - Electron's
	// lifecycle owns process exit and we don't want this timer to delay quit.
	cliDiscoveryWatchdog.unref?.();
}

/** Stop the discovery-file watchdog (called on app quit). */
export function stopCliDiscoveryWatchdog(): void {
	if (cliDiscoveryWatchdog) {
		clearInterval(cliDiscoveryWatchdog);
		cliDiscoveryWatchdog = null;
	}
}

/**
 * Register all web/live-related IPC handlers.
 */
export function registerWebHandlers(deps: WebHandlerDependencies): void {
	const { getWebServer, setWebServer, createWebServer, settingsStore } = deps;

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
	ipcMain.handle(
		'web:broadcastAutoRunState',
		async (
			_,
			sessionId: string,
			state: {
				isRunning: boolean;
				totalTasks: number;
				completedTasks: number;
				currentTaskIndex: number;
				isStopping?: boolean;
				// Multi-document progress fields
				totalDocuments?: number;
				currentDocumentIndex?: number;
				totalTasksAcrossAllDocs?: number;
				completedTasksAcrossAllDocs?: number;
				// Goal-Driven mode fields
				goalMode?: boolean;
				goalProgress?: number;
				goalRationale?: string;
				goalIteration?: number;
			} | null
		) => {
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
	ipcMain.handle(
		'web:broadcastTabsChange',
		async (_, sessionId: string, aiTabs: AITabData[], activeTabId: string) => {
			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				webServer.broadcastTabsChange(sessionId, aiTabs, activeTabId);
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

	ipcMain.handle('live:getDashboardUrl', async () => {
		const webServer = getWebServer();
		if (!webServer) {
			return null;
		}
		return webServer.getSecureUrl();
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

	// Start web server (creates if needed, starts if not running)
	ipcMain.handle('live:startServer', async () => {
		try {
			let webServer = getWebServer();

			// Rotate the security token on every Live toggle unless the user
			// opted into Persistent Web Link. After live:stopServer the CLI-only
			// server (spun up by ensureCliServer) keeps the previous token -
			// reusing it on the next Live ON would silently leak the prior URL.
			// Tear it down so createWebServer() mints a fresh ephemeral token.
			const persistentWebLink = settingsStore.get<boolean>('persistentWebLink', false);
			if (webServer && !persistentWebLink) {
				try {
					await webServer.stop();
				} catch (err: any) {
					// Don't drop the reference - the old server may still be bound
					// to its port. Nulling it would leak a live server and the next
					// start() would either collide on a custom port or run a second
					// server in parallel on a random one.
					logger.error(
						`Failed to stop existing server before token rotation: ${err?.message ?? err}`,
						'WebServer'
					);
					return { success: false, error: err?.message ?? String(err) };
				}
				setWebServer(null);
				webServer = null;
			}

			// Create web server if it doesn't exist
			if (!webServer) {
				logger.info('Creating web server', 'WebServer');
				webServer = createWebServer();
				setWebServer(webServer);
			}

			// Start if not already running
			if (!webServer.isActive()) {
				logger.info('Starting web server', 'WebServer');
				const { port, token, url } = await webServer.start();
				logger.info(`Web server running at ${url} (port ${port})`, 'WebServer');

				// Refresh CLI discovery file so the CLI can reconnect after a
				// stop/start cycle (ensureCliServer only runs once at app launch).
				// Non-fatal: the server is genuinely up - a failure here would only
				// break CLI IPC, so don't let it mask the UI's success path.
				try {
					refreshCliDiscoveryFile(port, token);
				} catch (err: any) {
					logger.error(`Failed to write CLI discovery file: ${err?.message ?? err}`, 'WebServer');
				}
				return { success: true, url };
			}

			// Already running - refresh discovery file in case it's stale.
			// Same non-fatal treatment: server is up, CLI discovery is secondary.
			try {
				refreshCliDiscoveryFile(webServer.getPort(), webServer.getSecurityToken());
			} catch (err: any) {
				logger.error(`Failed to refresh CLI discovery file: ${err?.message ?? err}`, 'WebServer');
			}
			return { success: true, url: webServer.getSecureUrl() };
		} catch (error: any) {
			logger.error(`Failed to start web server: ${error.message}`, 'WebServer');
			return { success: false, error: error.message };
		}
	});

	// Stop web server and clean up
	ipcMain.handle('live:stopServer', async () => {
		const webServer = getWebServer();
		if (!webServer) {
			// Even with no server, ensure the CLI channel is available so
			// maestro-cli works after Live Mode toggles.
			await ensureCliServer(deps);
			return { success: true };
		}

		try {
			logger.info('Stopping web server', 'WebServer');
			await webServer.stop();
			setWebServer(null); // Allow garbage collection, will recreate on next start
			deleteCliServerInfo();
			logger.info('Web server stopped and cleaned up', 'WebServer');
		} catch (error: any) {
			logger.error(`Failed to stop web server: ${error.message}`, 'WebServer');
			return { success: false, error: error.message };
		}

		// Bring the CLI server back up on a fresh port + token. The user
		// turned off Live Mode (closing the public URL) but the CLI server
		// must remain reachable for maestro-cli.
		await ensureCliServer(deps);
		return { success: true };
	});

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
	ipcMain.handle('live:disableAll', async () => {
		const webServer = getWebServer();
		if (!webServer) {
			await ensureCliServer(deps);
			return { success: true, count: 0 };
		}

		// First mark all sessions as offline
		const liveSessions = webServer.getLiveSessions();
		const count = liveSessions.length;
		for (const session of liveSessions) {
			webServer.setSessionOffline(session.sessionId);
		}

		// Then stop the server
		try {
			logger.info(`Disabled ${count} live sessions, stopping server`, 'Live');
			await webServer.stop();
			setWebServer(null);
			deleteCliServerInfo();
		} catch (error: any) {
			logger.error(`Failed to stop web server during disableAll: ${error.message}`, 'WebServer');
			return { success: false, count, error: error.message };
		}

		// Bring the CLI server back up on a fresh port + token so maestro-cli
		// continues working after Live Mode is fully disabled.
		await ensureCliServer(deps);
		return { success: true, count };
	});

	// Web server management
	ipcMain.handle('webserver:getUrl', async () => {
		return getWebServer()?.getSecureUrl();
	});

	ipcMain.handle('webserver:getConnectedClients', async () => {
		return getWebServer()?.getWebClientCount() || 0;
	});
}
