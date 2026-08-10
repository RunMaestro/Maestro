/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { WebServer } from './WebServer';
import { logger } from '../utils/logger';
import type { ProcessManager } from '../process-manager';
import type { SettingsStoreInterface as SettingsStore } from '../stores/types';
import type { CueGraphSession, CueRunResult } from '../../shared/cue/contracts';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import { registerSessionCallbacks } from './callbacks/sessionCallbacks';
import { registerThemeCallbacks } from './callbacks/themeCallbacks';
import { registerNotificationCallbacks } from './callbacks/notificationCallbacks';
import { registerTerminalCallbacks } from './callbacks/terminalCallbacks';
import { registerCommandCallbacks } from './callbacks/commandCallbacks';
import { registerTabCallbacks } from './callbacks/tabCallbacks';
import { registerBrowserTabCallbacks } from './callbacks/browserTabCallbacks';
import { registerQueueCallbacks } from './callbacks/queueCallbacks';
import { registerGistCallbacks } from './callbacks/gistCallbacks';
import { registerContextOpsCallbacks } from './callbacks/contextOpsCallbacks';
import { registerUsageAchievementsCallbacks } from './callbacks/usageAchievementsCallbacks';
import { registerAutoRunConfigCallbacks } from './callbacks/autoRunConfigCallbacks';
import { registerSessionCrudCallbacks } from './callbacks/sessionCrudCallbacks';
import { registerGroupCrudCallbacks } from './callbacks/groupCrudCallbacks';
import { registerGitCallbacks } from './callbacks/gitCallbacks';
import { registerGroupChatCallbacks } from './callbacks/groupChatCallbacks';
import { registerDirectorNotesCallbacks } from './callbacks/directorNotesCallbacks';
import { registerAutoRunControlCallbacks } from './callbacks/autoRunControlCallbacks';
import { registerPlaybookCallbacks } from './callbacks/playbookCallbacks';
import { registerCueCallbacks } from './callbacks/cueCallbacks';
import { registerSettingsCallbacks } from './callbacks/settingsCallbacks';
import { registerMarketplaceCallbacks } from './callbacks/marketplaceCallbacks';
import { registerCadenzaMovementCallbacks } from './callbacks/cadenzaMovementCallbacks';

/** UUID v4 format regex for validating stored security tokens.
 *  Enforces version nibble (4) and variant bits ([89ab]). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Store interface for sessions */
interface SessionsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Store interface for groups */
interface GroupsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Dependencies required for creating the web server */
export interface WebServerFactoryDependencies {
	/** Settings store for reading web interface configuration */
	settingsStore: SettingsStore;
	/** Sessions store for reading session data */
	sessionsStore: SessionsStore;
	/** Groups store for reading group data */
	groupsStore: GroupsStore;
	/** Function to get the main window reference */
	getMainWindow: () => BrowserWindow | null;
	/**
	 * Deliver a cadenza payload to the desktop HUD window - the transparent,
	 * always-on-top overlay that floats cadenza views over other apps (created
	 * lazily, buffered until its renderer subscribes). Returns true if the HUD
	 * handled it; false (or absent) means fall back to the in-app renderer.
	 */
	deliverCadenza?: (payload: CadenzaPayload) => boolean;
	/** Function to get the process manager reference */
	getProcessManager: () => ProcessManager | null;
	/** Direct CUE subscription trigger - bypasses renderer IPC round-trip */
	triggerCueSubscription?: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => boolean;
	/** Direct CUE graph-data snapshot - bypasses renderer IPC round-trip.
	 *  Required by `setGetCueSubscriptionsCallback` to answer the CLI's
	 *  `get_cue_subscriptions` message in-process instead of forwarding it
	 *  to the renderer (which never registered a listener, so every CLI
	 *  `cue list` call timed out). */
	getCueGraphData?: () => CueGraphSession[];
	/** Direct toggle for a single subscription's `enabled` flag in YAML.
	 *  `subscriptionId` follows the `${sessionId}::${pipeline}::${name}` shape
	 *  emitted by `getCueGraphData` flattening (via `composeCueSubscriptionId`)
	 *  - same dead-bridge fix as `getCueGraphData`. Returns `false` when the
	 *  id can't be resolved, the YAML can't be parsed, or the named
	 *  subscription isn't present. Async because the engine serialises
	 *  per-`projectRoot` writes via a promise chain to keep concurrent
	 *  toggles from clobbering each other. */
	setCueSubscriptionEnabled?: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
	/** Direct CUE activity-log snapshot - bypasses renderer IPC round-trip.
	 *  Used by `setGetCueActivityCallback` (web UI's activity dashboard).
	 *  Same dead-bridge fix as `getCueGraphData`. */
	getCueActivityLog?: () => CueRunResult[];
}

/**
 * Creates a factory function for creating web servers with the given dependencies.
 * This allows dependency injection and makes the code more testable.
 */
export function createWebServerFactory(deps: WebServerFactoryDependencies) {
	const { settingsStore } = deps;

	/**
	 * Create and configure the web server with all necessary callbacks.
	 * Called when user enables the web interface.
	 */
	return function createWebServer(): WebServer {
		// Use custom port if enabled, otherwise 0 for random port assignment
		const useCustomPort = settingsStore.get('webInterfaceUseCustomPort', false);
		const customPort = settingsStore.get('webInterfaceCustomPort', 8080);
		const port = useCustomPort ? customPort : 0;

		// Determine security token: persistent or ephemeral
		let securityToken: string | undefined;
		const persistentWebLink = settingsStore.get('persistentWebLink', false);
		if (persistentWebLink) {
			const storedToken = settingsStore.get<string | null>('webAuthToken', null);
			// Validate stored token is a proper UUID before trusting it
			if (storedToken && UUID_V4_REGEX.test(storedToken)) {
				securityToken = storedToken;
			} else {
				if (storedToken) {
					logger.warn(
						'Stored webAuthToken is not a valid UUID, generating new token',
						'WebServerFactory'
					);
				}
				securityToken = randomUUID();
				try {
					settingsStore.set('webAuthToken', securityToken);
				} catch {
					// Persist failure is non-fatal - server starts with an ephemeral token
					logger.warn(
						'Failed to persist new webAuthToken, URL will not survive restart',
						'WebServerFactory'
					);
				}
			}
		}

		const server = new WebServer(port, securityToken);

		registerSessionCallbacks(server, deps);
		registerThemeCallbacks(server, deps);

		registerTerminalCallbacks(server, deps);
		registerCommandCallbacks(server, deps);
		registerTabCallbacks(server, deps);
		registerNotificationCallbacks(server, deps);

		registerCadenzaMovementCallbacks(server, deps);

		registerBrowserTabCallbacks(server, deps);

		registerQueueCallbacks(server, deps);

		registerAutoRunConfigCallbacks(server, deps);

		registerSettingsCallbacks(server, deps);

		registerSessionCrudCallbacks(server, deps);
		registerGroupCrudCallbacks(server, deps);

		registerGitCallbacks(server, deps);

		registerAutoRunControlCallbacks(server, deps);
		registerPlaybookCallbacks(server, deps);

		registerGroupChatCallbacks(server, deps);

		registerContextOpsCallbacks(server, deps);
		registerGistCallbacks(server, deps);

		registerCueCallbacks(server, deps);

		registerUsageAchievementsCallbacks(server, deps);

		registerDirectorNotesCallbacks(server, deps);

		registerMarketplaceCallbacks(server, deps);

		return server;
	};
}
