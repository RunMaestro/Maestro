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
 * - Health figures (popularity, reliability) are cached with the same TTL on
 *   their own channel, so the manifest never waits on them
 */

import { ipcMain, App, BrowserWindow } from 'electron';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend, type SafeSendFn } from '../../utils/safe-send';
import { PLAYBOOKS_CHANGED_CHANNEL } from '../../../shared/playbooksChanged';
import { SshRemoteConfig } from '../../../shared/types';
import type { MaestroSettings } from './persistence';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceHealth,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
	checkMarketplacePlaybookUpdates,
	createLocalManifestWatcher,
} from '../../services/marketplace-service';

const LOG_CONTEXT = '[Marketplace]';

export interface MarketplaceHandlerDependencies {
	app: App;
	/** Settings store for SSH remote configuration lookup */
	settingsStore?: Store<MaestroSettings>;
	/** Main window getter, used to bridge manifest-change pushes to web clients */
	getMainWindow?: () => BrowserWindow | null;
	/**
	 * Broadcast to every renderer and web client. Carries the
	 * `playbooks:changed` push after an import; defaults to the main window.
	 */
	safeSend?: SafeSendFn;
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

/**
 * The SSH config for a request that named a remote. Fails loudly when the
 * remote cannot be resolved: silently working locally would land (or read)
 * the playbook on the wrong host (the SSH spawn pattern in CLAUDE.md: never
 * silently downgrade to local).
 */
function resolveSshConfig(sshRemoteId: string | undefined): SshRemoteConfig | undefined {
	if (!sshRemoteId) return undefined;
	const sshConfig = getSshRemoteById(sshRemoteId);
	if (!sshConfig) throw new Error(`SSH remote not found or disabled: ${sshRemoteId}`);
	return sshConfig;
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
	const { app, settingsStore, getMainWindow } = deps;
	const safeSend = createSafeSend(getMainWindow ?? (() => null));
	const broadcast = deps.safeSend ?? safeSend;

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

	// marketplace:getHealth - Popularity and reliability figures, fetched beside
	// the manifest. Never fails: an absent endpoint answers with no figures.
	ipcMain.handle(
		'marketplace:getHealth',
		createIpcHandler(handlerOpts('getHealth', false), async (forceRefresh?: boolean) => {
			return getMarketplaceHealth(app, { forceRefresh: forceRefresh === true });
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

	// marketplace:importPlaybook - Import a playbook (local or remote via SSH)
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
				options?: { update?: boolean }
			) => {
				const sshConfig = resolveSshConfig(sshRemoteId);
				const result = await importMarketplacePlaybook({
					app,
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshConfig,
					update: options?.update === true,
				});
				// The import appended (or, for an update, replaced) a record in
				// the agent's playbook list.
				broadcast(PLAYBOOKS_CHANGED_CHANNEL, sessionId);
				return { ...result };
			}
		)
	);

	// marketplace:checkUpdates - Classify every playbook the agent installed
	// from the Exchange: up-to-date, update-available, or locally-modified.
	ipcMain.handle(
		'marketplace:checkUpdates',
		createIpcHandler(
			handlerOpts('checkUpdates', false),
			async (sessionId: string, autoRunFolderPath: string, sshRemoteId?: string) => {
				const updates = await checkMarketplacePlaybookUpdates({
					app,
					sessionId,
					autoRunFolderPath,
					sshConfig: resolveSshConfig(sshRemoteId),
				});
				return { updates };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} Marketplace IPC handlers registered`);
}
