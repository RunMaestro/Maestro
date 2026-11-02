/**
 * Live mode controller: the ONE place that turns the web interface on and off.
 *
 * The Left Bar LIVE pill (through `live:set`), the raw `live:startServer` /
 * `live:stopServer` / `live:disableAll` channels, and `maestro-cli live on|off`
 * (the `live_command` WS message) all land here, so they reach the same code.
 *
 * - Live is "a LAN server is running": `isActive() && isLanAccessible()`. Main
 *   holds no separate flag, so the answer cannot drift from the socket.
 * - Switches are single-flight. Two concurrent starts (auto-start in two
 *   windows) used to each create a server, and the one `setWebServer()` dropped
 *   kept listening on 0.0.0.0 with a token nothing showed or stopped.
 * - `set()` is idempotent: `on` while on (or `off` while off) does nothing, so
 *   a repeated `live on` never rotates the token and kicks every phone.
 * - After every switch every window is told (`onStateChanged`), so each LIVE
 *   pill follows main instead of its own React state.
 * - Remote Control (the Cloudflare tunnel) rides the same queue. It forwards to
 *   the LAN server, so it starts only while Live is on: the only server running
 *   otherwise is the loopback CLI server, and tunneling that would publish the
 *   CLI's control channel to the internet.
 */

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { createKeyedWriteQueue } from '../utils/atomic-json-store';
import { deleteCliServerInfo } from '../../shared/cli-server-discovery';
import type { WebServer } from './WebServer';
import type { WebServerOptions } from './WebServer';
import type { SettingsStoreInterface } from '../stores/types';
import type {
	LiveModeSetResult,
	LiveModeStateEvent,
	LiveModeStatus,
	RemoteControlSetResult,
} from '../../shared/liveMode';
import type { TunnelResult, TunnelStatus } from '../tunnel-manager';

const LOG_CONTEXT = 'LiveMode';

/** One queue key: every switch runs strictly after the previous one. */
const SWITCH_KEY = 'live';

export interface LiveModeControllerDeps {
	getWebServer: () => WebServer | null;
	setWebServer: (server: WebServer | null) => void;
	createWebServer: (options?: WebServerOptions) => WebServer;
	settingsStore: SettingsStoreInterface;
	/** Bring the loopback CLI server back up once the LAN server is gone. */
	ensureCliServer: () => Promise<boolean>;
	/** Publish `cli-server.json` for the server now running. */
	publishCliDiscovery: (port: number, token: string) => void;
	/** The Cloudflare tunnel (Remote Control). Live off stops it; Live on never starts it. */
	tunnel: {
		start: (port: number) => Promise<TunnelResult>;
		stop: () => Promise<void>;
		getStatus: () => TunnelStatus;
	};
	/** Tell every window the new state. */
	onStateChanged: (state: LiveModeStateEvent) => void;
}

export interface LiveModeController {
	/** Current state, read from the running server. */
	getStatus(): LiveModeStatus;
	/** Turn Live on or off. A no-op when it is already in that state. */
	set(live: boolean): Promise<LiveModeSetResult>;
	/** Start (or keep) the LAN server. Rotates the token unless Persistent Web Link is on. */
	startServer(): Promise<{ success: boolean; url?: string; error?: string }>;
	/** Stop the server and bring the loopback CLI server back. */
	stopServer(): Promise<{ success: boolean; error?: string }>;
	/** Mark every live session offline, stop the server, bring the CLI server back. */
	disableAll(): Promise<{ success: boolean; count: number; error?: string }>;
	/** Start Remote Control (the Cloudflare tunnel). Refused while Live is off. */
	startRemoteControl(): Promise<RemoteControlSetResult>;
	/** Stop Remote Control. Live stays as it is. */
	stopRemoteControl(): Promise<RemoteControlSetResult>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createLiveModeController(deps: LiveModeControllerDeps): LiveModeController {
	const { getWebServer, setWebServer, createWebServer, settingsStore } = deps;
	const queue = createKeyedWriteQueue();
	let revision = 0;
	let lastError: string | undefined;

	function isLive(): boolean {
		const server = getWebServer();
		return !!server && server.isActive() && server.isLanAccessible();
	}

	/** The tunnel manager's view, with the server's token path on the public URL. */
	function readTunnel(): Pick<
		LiveModeStatus,
		'remoteControl' | 'remoteControlUrl' | 'remoteControlError'
	> {
		let tunnel: TunnelStatus;
		try {
			tunnel = deps.tunnel.getStatus();
		} catch {
			// A tunnel manager that cannot answer is not running a tunnel.
			return { remoteControl: false, remoteControlUrl: null };
		}
		const running = tunnel.isRunning && !!tunnel.url;
		return {
			remoteControl: running,
			remoteControlUrl: running ? withTokenPath(tunnel.url as string) : null,
			...(tunnel.error ? { remoteControlError: tunnel.error } : {}),
		};
	}

	/**
	 * The tunnel manager is token-agnostic: it forwards a bare hostname. The URL
	 * a phone can open needs the server's token path appended.
	 */
	function withTokenPath(tunnelUrl: string): string {
		const serverUrl = getWebServer()?.getSecureUrl();
		if (!serverUrl) return tunnelUrl;
		try {
			const tokenPath = new URL(serverUrl).pathname;
			if (tokenPath && tokenPath !== '/' && !tunnelUrl.endsWith(tokenPath)) {
				return tunnelUrl + tokenPath;
			}
		} catch {
			// Malformed server URL - fall back to the bare tunnel URL.
		}
		return tunnelUrl;
	}

	function getStatus(): LiveModeStatus {
		const live = isLive();
		return {
			live,
			url: live ? (getWebServer()?.getSecureUrl() ?? null) : null,
			...readTunnel(),
			revision,
			...(lastError ? { lastError } : {}),
		};
	}

	/** Run a switch body, then record its outcome and tell every window. Call only on the queue. */
	async function settle<T extends { success: boolean; error?: string }>(
		body: () => Promise<T>
	): Promise<T> {
		let result: T;
		try {
			result = await body();
		} catch (error) {
			// The bodies handle the failures they expect; anything else is a bug.
			void captureException(error);
			result = { success: false, error: errorMessage(error) } as T;
		}
		revision += 1;
		lastError = result.success ? undefined : (result.error ?? 'Live mode switch failed');
		const status = getStatus();
		try {
			deps.onStateChanged({
				live: status.live,
				url: status.url,
				remoteControl: status.remoteControl,
				remoteControlUrl: status.remoteControlUrl,
				...(status.remoteControlError ? { remoteControlError: status.remoteControlError } : {}),
			});
		} catch (error) {
			logger.warn(`Failed to broadcast Live state: ${errorMessage(error)}`, LOG_CONTEXT);
		}
		return result;
	}

	/** Queue one switch behind every earlier one. */
	function runSwitch<T extends { success: boolean; error?: string }>(
		body: () => Promise<T>
	): Promise<T> {
		return queue.enqueue(SWITCH_KEY, () => settle(body));
	}

	async function startServerBody(): Promise<{ success: boolean; url?: string; error?: string }> {
		let webServer = getWebServer();

		// Rotate the security token on every Live toggle unless the user
		// opted into Persistent Web Link. After a stop the CLI-only server
		// (spun up by ensureCliServer) keeps the previous token - reusing it on
		// the next Live ON would silently leak the prior URL. Tear it down so
		// createWebServer() mints a fresh ephemeral token. The CLI-only server
		// is also bound to loopback, so it has to be replaced by a LAN server
		// either way; a persistent token survives the swap because the factory
		// reads it from settings.
		const persistentWebLink = settingsStore.get<boolean>('persistentWebLink', false);
		if (webServer && (!persistentWebLink || !webServer.isLanAccessible())) {
			try {
				await webServer.stop();
			} catch (err) {
				// Don't drop the reference - the old server may still be bound
				// to its port. Nulling it would leak a live server and the next
				// start() would either collide on a custom port or run a second
				// server in parallel on a random one.
				logger.error(
					`Failed to stop existing server before token rotation: ${errorMessage(err)}`,
					'WebServer'
				);
				return { success: false, error: errorMessage(err) };
			}
			setWebServer(null);
			webServer = null;
		}

		try {
			if (!webServer) {
				logger.info('Creating LAN web server for Live Mode', 'WebServer');
				webServer = createWebServer({ lanAccess: true });
				setWebServer(webServer);
			}

			if (!webServer.isActive()) {
				logger.info('Starting web server', 'WebServer');
				const { port, token, url } = await webServer.start();
				logger.info(`Web server running at ${url} (port ${port})`, 'WebServer');

				// Refresh the CLI discovery file so the CLI can reconnect after a
				// stop/start cycle. Non-fatal: the server is genuinely up - a
				// failure here would only break CLI IPC, so don't let it mask
				// the UI's success path.
				try {
					deps.publishCliDiscovery(port, token);
				} catch (err) {
					logger.error(`Failed to write CLI discovery file: ${errorMessage(err)}`, 'WebServer');
				}
				return { success: true, url };
			}

			// Already running - refresh the discovery file in case it's stale.
			try {
				deps.publishCliDiscovery(webServer.getPort(), webServer.getSecurityToken());
			} catch (err) {
				logger.error(`Failed to refresh CLI discovery file: ${errorMessage(err)}`, 'WebServer');
			}
			return { success: true, url: webServer.getSecureUrl() };
		} catch (error) {
			logger.error(`Failed to start web server: ${errorMessage(error)}`, 'WebServer');
			return { success: false, error: errorMessage(error) };
		}
	}

	async function stopServerBody(): Promise<{ success: boolean; error?: string }> {
		const webServer = getWebServer();
		if (webServer) {
			try {
				logger.info('Stopping web server', 'WebServer');
				await webServer.stop();
				setWebServer(null); // Allow garbage collection, will recreate on next start
				deleteCliServerInfo();
				logger.info('Web server stopped and cleaned up', 'WebServer');
			} catch (error) {
				logger.error(`Failed to stop web server: ${errorMessage(error)}`, 'WebServer');
				return { success: false, error: errorMessage(error) };
			}
		}

		// Bring the CLI server back up on a fresh port + token, bound to
		// loopback. The LAN URL is closed but maestro-cli must stay reachable.
		await deps.ensureCliServer();
		return { success: true };
	}

	async function disableAllBody(): Promise<{ success: boolean; count: number; error?: string }> {
		const webServer = getWebServer();
		if (!webServer) {
			await deps.ensureCliServer();
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
		} catch (error) {
			logger.error(
				`Failed to stop web server during disableAll: ${errorMessage(error)}`,
				'WebServer'
			);
			return { success: false, count, error: errorMessage(error) };
		}

		// Bring the CLI server back up on a fresh port + token, bound to
		// loopback, so maestro-cli keeps working after Live Mode is disabled.
		await deps.ensureCliServer();
		return { success: true, count };
	}

	async function set(live: boolean): Promise<LiveModeSetResult> {
		// The check runs on the queue too, so a switch already in flight
		// finishes first and a second `on` sees it and does nothing.
		return queue.enqueue(SWITCH_KEY, async () => {
			if (isLive() === live) return { success: true, changed: false, status: getStatus() };
			const switched = await settle(async () => {
				if (live) return startServerBody();
				// The pill's off path: the tunnel first (it forwards to this
				// server), then every live session offline and the server down.
				try {
					await deps.tunnel.stop();
				} catch (error) {
					logger.error(
						`Failed to stop the tunnel before Live off: ${errorMessage(error)}`,
						LOG_CONTEXT
					);
				}
				return disableAllBody();
			});
			return {
				success: switched.success,
				changed: true,
				status: getStatus(),
				...(switched.error ? { error: switched.error } : {}),
			};
		});
	}

	async function startRemoteControlBody(): Promise<{
		success: boolean;
		url?: string;
		error?: string;
	}> {
		const server = getWebServer();
		if (!server || !isLive()) {
			return {
				success: false,
				error: 'Live mode is off. Turn it on before starting Remote Control.',
			};
		}
		const port = parseInt(new URL(server.getSecureUrl()).port, 10);
		const result = await deps.tunnel.start(port);
		if (!result.success || !result.url) {
			return { success: false, error: result.error || 'Remote Control failed to start' };
		}
		return { success: true, url: withTokenPath(result.url) };
	}

	async function stopRemoteControlBody(): Promise<{ success: boolean; error?: string }> {
		await deps.tunnel.stop();
		return { success: true };
	}

	/** Run a Remote Control switch and answer with the status after it. */
	async function remoteControlSwitch(
		body: () => Promise<{ success: boolean; url?: string; error?: string }>
	): Promise<RemoteControlSetResult> {
		const result = await runSwitch(body);
		return { ...result, status: getStatus() };
	}

	return {
		getStatus,
		set,
		startServer: () => runSwitch(startServerBody),
		stopServer: () => runSwitch(stopServerBody),
		disableAll: () => runSwitch(disableAllBody),
		startRemoteControl: () => remoteControlSwitch(startRemoteControlBody),
		stopRemoteControl: () => remoteControlSwitch(stopRemoteControlBody),
	};
}

let controller: LiveModeController | null = null;

/** Register the app's controller (called once from the IPC registration). */
export function setLiveModeController(next: LiveModeController | null): void {
	controller = next;
}

/** The app's controller, or `null` before the IPC handlers are registered. */
export function getLiveModeController(): LiveModeController | null {
	return controller;
}
