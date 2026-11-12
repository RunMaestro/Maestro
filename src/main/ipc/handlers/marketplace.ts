/**
 * Marketplace IPC Handlers
 *
 * Thin IPC wrappers around the marketplace service. The heavy lifting
 * (cache, fetch, merge, import) lives in
 * `src/main/services/marketplace-service.ts` so the web-server (mobile
 * clients) can reuse the exact same logic.
 *
 * Cache Strategy:
 * - Manifest is cached locally with 6-hour TTL
 * - Individual documents are fetched on-demand (not cached)
 * - Force refresh bypasses cache and fetches fresh data
 */

import { ipcMain, App, BrowserWindow } from 'electron';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend } from '../../utils/safe-send';
import { SshRemoteConfig } from '../../../shared/types';
import type {
	PlaybookLaunchCompletion,
	PlaybookLaunchListOptions,
	PlaybookLaunchRequest,
	PlaybookLaunchValues,
} from '../../../shared/marketplace-types';
import type { MaestroSettings } from './persistence';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
	createLocalManifestWatcher,
	launchMarketplacePlaybook,
	completeMarketplaceLaunch,
	getMarketplaceLaunch,
	listMarketplaceLaunches,
	type MarketplaceLaunchHost,
} from '../../services/marketplace-service';

const LOG_CONTEXT = '[Marketplace]';

export interface MarketplaceHandlerDependencies {
	app: App;
	/** Settings store for SSH remote configuration lookup */
	settingsStore?: Store<MaestroSettings>;
	/** Main window getter, used to bridge manifest-change pushes to web clients */
	getMainWindow?: () => BrowserWindow | null;
	/**
	 * What Playbook Launch runs with: the Auto Run starter, the maestro-cli check and the
	 * `marketplace:launchChanged` broadcast. The web bridge's launch callbacks get the same object.
	 */
	launchHost: MarketplaceLaunchHost;
}

let marketplaceSettingsStore: Store<MaestroSettings> | undefined;
let manifestWatcher: { stop: () => void } | undefined;

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 */
function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
	if (!marketplaceSettingsStore) {
		logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
		return undefined;
	}
	const sshRemotes = marketplaceSettingsStore.get('sshRemotes', []) as SshRemoteConfig[];
	return sshRemotes.find((r) => r.id === sshRemoteId && r.enabled);
}

const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Register all Marketplace-related IPC handlers.
 */
export function registerMarketplaceHandlers(deps: MarketplaceHandlerDependencies): void {
	const { app, settingsStore, getMainWindow, launchHost } = deps;
	const safeSend = createSafeSend(getMainWindow ?? (() => null));

	marketplaceSettingsStore = settingsStore;

	// Setup hot reload watcher for local manifest
	manifestWatcher?.stop();
	manifestWatcher = createLocalManifestWatcher(app, () => {
		logger.info('Local manifest changed, broadcasting refresh event', LOG_CONTEXT);
		// safeSend reaches the desktop renderer (when alive) and always fans out
		// to web-desktop bridge clients, so mobile/web users see the refresh too.
		safeSend('marketplace:manifestChanged');
	});

	app.on('will-quit', () => {
		manifestWatcher?.stop();
		manifestWatcher = undefined;
	});

	// marketplace:getManifest - Get manifest (from cache if valid, else fetch)
	ipcMain.handle(
		'marketplace:getManifest',
		createIpcHandler(handlerOpts('getManifest'), async () => {
			const result = await getMarketplaceManifest(app);
			return { ...result };
		})
	);

	// marketplace:refreshManifest - Force refresh (bypass cache)
	ipcMain.handle(
		'marketplace:refreshManifest',
		createIpcHandler(handlerOpts('refreshManifest'), async () => {
			logger.info('Force refreshing manifest (bypass cache)', LOG_CONTEXT);
			return refreshMarketplaceManifest(app);
		})
	);

	// marketplace:getDocument - Fetch a single document
	ipcMain.handle(
		'marketplace:getDocument',
		createIpcHandler(handlerOpts('getDocument'), async (playbookPath: string, filename: string) => {
			return getMarketplaceDocument(playbookPath, filename);
		})
	);

	// marketplace:getReadme - Fetch README for a playbook
	ipcMain.handle(
		'marketplace:getReadme',
		createIpcHandler(handlerOpts('getReadme'), async (playbookPath: string) => {
			return getMarketplaceReadme(playbookPath);
		})
	);

	// marketplace:importPlaybook - Import a playbook (local or remote via SSH). Launch passes
	// launchValues, which fill the saved prompt's configuration lines; Download omits them.
	ipcMain.handle(
		'marketplace:importPlaybook',
		createIpcHandler(
			handlerOpts('importPlaybook'),
			async (
				playbookId: string,
				targetFolderName: string,
				autoRunFolderPath: string,
				sessionId: string,
				sshRemoteId?: string,
				launchValues?: PlaybookLaunchValues
			) => {
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
				// Fail loudly when the user opted into SSH but the remote
				// can't be resolved - silently importing locally would land
				// the playbook on the wrong host (mirrors the SSH spawn
				// pattern in CLAUDE.md: never silently downgrade to local).
				if (sshRemoteId && !sshConfig) {
					throw new Error(`SSH remote not found or disabled: ${sshRemoteId}`);
				}
				const result = await importMarketplacePlaybook({
					app,
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshConfig,
					launchValues,
				});
				return { ...result };
			}
		)
	);

	// marketplace:launch - Launch a playbook: import it with the answers into a launch folder of
	// its own, record the launch and start its Auto Run. Resolves { launchId, folderRelativePath }.
	ipcMain.handle(
		'marketplace:launch',
		createIpcHandler(handlerOpts('launch'), async (request: PlaybookLaunchRequest) => {
			const result = await launchMarketplacePlaybook(request, launchHost);
			return { ...result };
		})
	);

	// marketplace:completeLaunch - The renderer that ran a launched Auto Run reports its end. Main
	// ends the record, cleans up and broadcasts marketplace:launchChanged. Resolves { launch }.
	ipcMain.handle(
		'marketplace:completeLaunch',
		createIpcHandler(
			handlerOpts('completeLaunch'),
			async (launchId: string, completion: PlaybookLaunchCompletion) => {
				const launch = await completeMarketplaceLaunch(launchId, completion, launchHost);
				return { launch };
			}
		)
	);

	// marketplace:getLaunch - One launch record. Resolves { launch }.
	ipcMain.handle(
		'marketplace:getLaunch',
		createIpcHandler(handlerOpts('getLaunch', false), async (launchId: string) => {
			const launch = await getMarketplaceLaunch(app, launchId);
			return { launch };
		})
	);

	// marketplace:listLaunches - Launch records, newest first, optionally of one agent and capped by
	// a limit. Resolves { launches }.
	ipcMain.handle(
		'marketplace:listLaunches',
		createIpcHandler(
			handlerOpts('listLaunches', false),
			async (options?: PlaybookLaunchListOptions) => {
				const launches = await listMarketplaceLaunches(app, options);
				return { launches };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} Marketplace IPC handlers registered`);
}
