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

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { WebServer } from '../../web-server';
import type { AITabData } from '../../web-server/services/broadcastService';
import type { SettingsStoreInterface } from '../../stores/types';

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

			// Create web server if it doesn't exist
			if (!webServer) {
				logger.info('Creating web server', 'WebServer');
				webServer = createWebServer();
				setWebServer(webServer);
			}

			// Start if not already running
			if (!webServer.isActive()) {
				logger.info('Starting web server', 'WebServer');
				const { port, url } = await webServer.start();
				logger.info(`Web server running at ${url} (port ${port})`, 'WebServer');
				return { success: true, url };
			}

			// Already running
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
			return { success: true };
		}

		try {
			logger.info('Stopping web server', 'WebServer');
			await webServer.stop();
			setWebServer(null); // Allow garbage collection, will recreate on next start
			logger.info('Web server stopped and cleaned up', 'WebServer');
			return { success: true };
		} catch (error: any) {
			logger.error(`Failed to stop web server: ${error.message}`, 'WebServer');
			return { success: false, error: error.message };
		}
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
				// Best-effort rollback — disk may be completely unavailable
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
			// Rollback the flag so disk state stays consistent — prevents
			// persistentWebLink=false with a stale token on next startup.
			try {
				settingsStore.set('persistentWebLink', true);
			} catch {
				// Best-effort rollback — disk may be completely unavailable
			}
			logger.error(`Failed to clear persistent token: ${error.message}`, 'WebServer');
			return { success: false, message: error.message };
		}
	});

	// Disable all live sessions and stop the server
	ipcMain.handle('live:disableAll', async () => {
		const webServer = getWebServer();
		if (!webServer) {
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
			return { success: true, count };
		} catch (error: any) {
			logger.error(`Failed to stop web server during disableAll: ${error.message}`, 'WebServer');
			return { success: false, count, error: error.message };
		}
	});

	// Web server management
	ipcMain.handle('webserver:getUrl', async () => {
		return getWebServer()?.getSecureUrl();
	});

	ipcMain.handle('webserver:getConnectedClients', async () => {
		return getWebServer()?.getWebClientCount() || 0;
	});
}
