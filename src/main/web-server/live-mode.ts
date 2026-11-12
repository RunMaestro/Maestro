/**
 * Live Mode service: the web interface server and its Cloudflare tunnel.
 *
 * One implementation behind three callers: the desktop's `live:*` and
 * `tunnel:*` IPC handlers, and the `live_*` WebSocket messages that
 * `maestro-cli live` sends. Keeping the lifecycle here means a toggle from the
 * CLI and a toggle from the LIVE panel cannot drift on token rotation, the
 * loopback/LAN swap, or the CLI discovery file.
 *
 * Two servers share one slot:
 * - the loopback CLI server (`ensureCliServer`), always up so maestro-cli works;
 * - the LAN server (`startLiveServer`), up only while Live Mode is on.
 * Turning Live on or off REPLACES the server in that slot, which closes every
 * WebSocket on the old one, including the CLI connection that asked for it.
 */

import { app, BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import { tunnelManager as defaultTunnelManager } from '../tunnel-manager';
import type { TunnelResult, TunnelStatus } from '../tunnel-manager';
import type { WebServer, WebServerOptions } from './WebServer';
import type { SettingsStoreInterface } from '../stores/types';
import {
	writeCliServerInfo,
	deleteCliServerInfo,
	readCliServerInfo,
} from '../../shared/cli-server-discovery';
import { getCliSecret } from './auth/cli-secret';
import type { LiveModeState } from '../../shared/liveMode';

export type { LiveModeState };

/** The tunnel manager surface this module uses (the singleton, or a test double). */
export type TunnelManagerLike = Pick<typeof defaultTunnelManager, 'start' | 'stop' | 'getStatus'>;

/** Dependencies for every Live Mode operation. */
export interface LiveModeDependencies {
	getWebServer: () => WebServer | null;
	setWebServer: (server: WebServer | null) => void;
	createWebServer: (options?: WebServerOptions) => WebServer;
	settingsStore: SettingsStoreInterface;
}

// ============================================================================
// Dependency registry (for callers with no deps of their own, i.e. WS handlers)
// ============================================================================

let registeredDeps: LiveModeDependencies | null = null;

/**
 * Register the deps the WebSocket handlers use. The WS handlers run inside a
 * WebServer instance and cannot reach main's `webServer` slot any other way.
 */
export function configureLiveMode(deps: LiveModeDependencies): void {
	registeredDeps = deps;
}

/** The registered deps, or null before startup wires them. */
export function getLiveModeDependencies(): LiveModeDependencies | null {
	return registeredDeps;
}

// ============================================================================
// CLI server (loopback) and its discovery file
// ============================================================================

/**
 * Write the CLI discovery file for the currently-running server so the CLI
 * can locate it. Centralized so `ensureCliServer` and `startLiveServer`
 * cannot drift on pid/startedAt semantics or future fields.
 */
function refreshCliDiscoveryFile(port: number, token: string): void {
	writeCliServerInfo({
		port,
		token,
		pid: process.pid,
		startedAt: Date.now(),
		// What lets the CLI through the Web Login gate. Per boot, so a stale
		// file from a previous run cannot open this one.
		cliSecret: getCliSecret(),
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
 * for CLI IPC connections. The server it creates binds 127.0.0.1 only: the URL
 * token is a capability anyone who sees it can use, so it must not be on the
 * network unless the user turned on Live Mode (`startLiveServer`). An
 * already-running Live Mode server is left as it is.
 *
 * Retries on any failure (port collision, transient fs error, etc.) and
 * verifies the discovery file is actually present on disk after each attempt.
 * Historically this could fail silently when a later `whenReady` step threw
 * before we got here, leaving the CLI unable to connect until the user
 * manually toggled Live Mode.
 */
export async function ensureCliServer(deps: LiveModeDependencies): Promise<boolean> {
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
	deps: LiveModeDependencies,
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

// ============================================================================
// State and the renderer push
// ============================================================================

/** True while the LAN web interface (not the loopback CLI server) is running. */
export function isLiveModeOn(webServer: WebServer | null): webServer is WebServer {
	return !!webServer && webServer.isActive() && webServer.isLanAccessible();
}

/**
 * Tunnel status with the web server's token path appended so the URL stays
 * usable. tunnelManager itself is token-agnostic; composition happens here.
 */
export function getTunnelState(
	webServer: WebServer | null,
	tunnel: TunnelManagerLike = defaultTunnelManager
): TunnelStatus {
	const status = tunnel.getStatus();
	if (!status.isRunning || !status.url) return status;

	const serverUrl = webServer?.getSecureUrl();
	if (!serverUrl) return status;

	try {
		const tokenPath = new URL(serverUrl).pathname;
		if (tokenPath && tokenPath !== '/' && !status.url.endsWith(tokenPath)) {
			return { ...status, url: status.url + tokenPath };
		}
	} catch {
		// Malformed server URL - fall back to bare tunnel URL
	}
	return status;
}

/** Snapshot of Live Mode: server, URL, tunnel. */
export function getLiveModeState(
	webServer: WebServer | null,
	tunnel: TunnelManagerLike = defaultTunnelManager
): LiveModeState {
	const live = isLiveModeOn(webServer);
	return {
		live,
		url: live ? webServer.getSecureUrl() : null,
		tunnel: getTunnelState(webServer, tunnel),
	};
}

/**
 * Tell every window the Live Mode state changed. The LIVE panel keeps its
 * state in React, so without this a toggle from `maestro-cli live` would leave
 * the panel showing the old state. Broadcast rather than main-window only:
 * each window draws its own Left Bar with its own LIVE panel.
 */
export function notifyLiveModeChanged(
	webServer: WebServer | null,
	tunnel: TunnelManagerLike = defaultTunnelManager
): void {
	const state = getLiveModeState(webServer, tunnel);
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			if (isWebContentsAvailable(win)) {
				win.webContents.send('live:stateChanged', state);
			}
		} catch (error) {
			// A window closing mid-broadcast is routine, not a fault.
			logger.debug('Failed to send live:stateChanged to a window', 'Live', {
				error: String(error),
			});
		}
	}
}

// ============================================================================
// Live Mode server
// ============================================================================

/** Start the LAN web interface (replacing the loopback CLI server). */
export async function startLiveServer(
	deps: LiveModeDependencies
): Promise<{ success: boolean; url?: string; error?: string }> {
	const { getWebServer, setWebServer, createWebServer, settingsStore } = deps;
	try {
		let webServer = getWebServer();

		// Rotate the security token on every Live toggle unless the user
		// opted into Persistent Web Link. After stopLiveServer the CLI-only
		// server (spun up by ensureCliServer) keeps the previous token -
		// reusing it on the next Live ON would silently leak the prior URL.
		// Tear it down so createWebServer() mints a fresh ephemeral token.
		// The CLI-only server is also bound to loopback, so it has to be
		// replaced by a LAN server either way; a persistent token survives
		// the swap because the factory reads it from settings.
		const persistentWebLink = settingsStore.get<boolean>('persistentWebLink', false);
		if (webServer && (!persistentWebLink || !webServer.isLanAccessible())) {
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
			logger.info('Creating LAN web server for Live Mode', 'WebServer');
			webServer = createWebServer({ lanAccess: true });
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
			notifyLiveModeChanged(webServer);
			return { success: true, url };
		}

		// Already running - refresh discovery file in case it's stale.
		// Same non-fatal treatment: server is up, CLI discovery is secondary.
		try {
			refreshCliDiscoveryFile(webServer.getPort(), webServer.getSecurityToken());
		} catch (err: any) {
			logger.error(`Failed to refresh CLI discovery file: ${err?.message ?? err}`, 'WebServer');
		}
		notifyLiveModeChanged(webServer);
		return { success: true, url: webServer.getSecureUrl() };
	} catch (error: any) {
		logger.error(`Failed to start web server: ${error.message}`, 'WebServer');
		return { success: false, error: error.message };
	}
}

/** Stop the web server and bring the loopback CLI server back. */
export async function stopLiveServer(
	deps: LiveModeDependencies
): Promise<{ success: boolean; error?: string }> {
	const { getWebServer, setWebServer } = deps;
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

	// Bring the CLI server back up on a fresh port + token, bound to
	// loopback. The user turned off Live Mode (closing the LAN URL) but
	// the CLI server must remain reachable for maestro-cli.
	await ensureCliServer(deps);
	notifyLiveModeChanged(getWebServer());
	return { success: true };
}

/** Mark every live session offline, stop the server, restore the CLI server. */
export async function disableAllLive(
	deps: LiveModeDependencies
): Promise<{ success: boolean; count: number; error?: string }> {
	const { getWebServer, setWebServer } = deps;
	const webServer = getWebServer();
	if (!webServer) {
		await ensureCliServer(deps);
		notifyLiveModeChanged(getWebServer());
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

	// Bring the CLI server back up on a fresh port + token, bound to
	// loopback, so maestro-cli keeps working after Live Mode is disabled.
	await ensureCliServer(deps);
	notifyLiveModeChanged(getWebServer());
	return { success: true, count };
}

/**
 * Turn Live Mode off the way the LIVE panel's toggle does: stop the tunnel
 * first (it points at the server about to go away), then disable everything.
 */
export async function turnLiveModeOff(
	deps: LiveModeDependencies,
	tunnel: TunnelManagerLike = defaultTunnelManager
): Promise<{ success: boolean; count: number; error?: string }> {
	try {
		await tunnel.stop();
	} catch (error) {
		// Continue anyway - the server still has to go down.
		logger.error(`Failed to stop tunnel while turning Live off: ${String(error)}`, 'Live');
	}
	return disableAllLive(deps);
}

// ============================================================================
// Cloudflare tunnel
// ============================================================================

/**
 * Start a Cloudflare quick tunnel to the Live Mode server. Refuses while Live
 * is off: the only server running then is the loopback CLI server, and
 * tunneling it would publish the CLI's control channel to the internet.
 */
export async function startTunnel(
	webServer: WebServer | null,
	tunnel: TunnelManagerLike = defaultTunnelManager
): Promise<TunnelResult> {
	if (!isLiveModeOn(webServer)) {
		return {
			success: false,
			error: 'Live mode is off. Turn on the web interface before starting the tunnel.',
		};
	}

	// Get web server URL (includes the security token)
	const parsedUrl = new URL(webServer.getSecureUrl());
	const port = parseInt(parsedUrl.port, 10);
	const tokenPath = parsedUrl.pathname; // e.g., "/7d7f7162-614c-43e2-bb8a-8a8123c2f56a"

	const result = await tunnel.start(port);
	notifyLiveModeChanged(webServer, tunnel);

	if (result.success && result.url) {
		// Append the token path to the tunnel URL for security
		// e.g., "https://xyz.trycloudflare.com" + "/TOKEN" = "https://xyz.trycloudflare.com/TOKEN"
		return { success: true, url: result.url + tokenPath };
	}
	return result;
}

/** Stop the Cloudflare tunnel. */
export async function stopTunnel(
	webServer: WebServer | null,
	tunnel: TunnelManagerLike = defaultTunnelManager
): Promise<{ success: true }> {
	await tunnel.stop();
	notifyLiveModeChanged(webServer, tunnel);
	return { success: true };
}
