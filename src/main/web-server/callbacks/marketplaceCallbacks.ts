import { app as electronApp, BrowserWindow } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { createSafeSend } from '../../utils/safe-send';
import { PLAYBOOKS_CHANGED_CHANNEL } from '../../../shared/playbooksChanged';
import type { StoredSession } from '../../stores/types';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceHealth,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
	checkMarketplacePlaybookUpdates,
} from '../../services/marketplace-service';

// =====================================================================
// Marketplace (Playbook Exchange) callbacks - main-process pure ops,
// no renderer round-trip. Mirrors the desktop IPC handlers in
// src/main/ipc/handlers/marketplace.ts.
// =====================================================================

export function registerMarketplaceCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'settingsStore' | 'sessionsStore'>
): void {
	const { settingsStore, sessionsStore } = deps;
	const safeSend = createSafeSend(() => BrowserWindow.getAllWindows());

	/**
	 * Resolve a session's effective SSH remote config.
	 *
	 * Returns `undefined` only when the session has no SSH configured at
	 * all. When SSH IS configured but the remote can't be resolved (the
	 * remoteId is missing, points at no entry in `sshRemotes`, or the
	 * matching entry is disabled), this throws so callers fail loudly
	 * instead of silently downgrading to a local import - mirrors the
	 * desktop IPC marketplace handler and the SSH-spawn pattern in
	 * CLAUDE.md.
	 *
	 * `sessionSshRemoteConfig.enabled` is the source of truth for the
	 * newer config shape; the legacy top-level `sshRemoteId` field
	 * implies enabled when present.
	 */
	const resolveSessionSshConfig = (session: StoredSession): SshRemoteConfig | undefined => {
		const newConfig = session.sessionSshRemoteConfig;
		const newConfigEnabled = newConfig?.enabled === true;
		const legacyId: string | undefined = session.sshRemoteId;

		if (!newConfigEnabled && !legacyId) {
			return undefined;
		}

		const remoteId: string | null | undefined =
			legacyId ?? (newConfigEnabled ? newConfig?.remoteId : undefined);
		if (!remoteId) {
			throw new Error('SSH remote not found or disabled');
		}

		const sshRemotes = settingsStore.get<SshRemoteConfig[]>('sshRemotes', []);
		const found = sshRemotes.find((r) => r.id === remoteId && r.enabled);
		if (!found) {
			throw new Error('SSH remote not found or disabled');
		}
		return found;
	};

	// The health figures ride along for `maestro-cli marketplace list`, which
	// prints the badges and sorts by them. They never fail the manifest:
	// getMarketplaceHealth answers an empty map on any error.
	server.setGetMarketplaceManifestCallback(async (options) => {
		const refresh = options?.refresh === true;
		const [manifestResult, healthResult] = await Promise.all([
			refresh ? refreshMarketplaceManifest(electronApp) : getMarketplaceManifest(electronApp),
			getMarketplaceHealth(electronApp, { forceRefresh: refresh }),
		]);
		return { ...manifestResult, health: healthResult.health };
	});

	server.setGetMarketplaceDocumentCallback(async (playbookPath, filename) => {
		return getMarketplaceDocument(playbookPath, filename);
	});

	server.setGetMarketplaceReadmeCallback(async (playbookPath) => {
		return getMarketplaceReadme(playbookPath);
	});

	/**
	 * The session's Auto Run folder and SSH config, or a typed failure. SSH is
	 * resolved up front so an unresolvable remote on an SSH-enabled session
	 * fails instead of silently working locally. Errors here aren't
	 * exceptional bugs - they're user misconfiguration - so callers don't
	 * route them through captureException.
	 */
	const resolveSessionTarget = (
		sessionId: string
	):
		| { ok: true; autoRunFolderPath: string; sshConfig: SshRemoteConfig | undefined }
		| { ok: false; error: string } => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			return { ok: false, error: `Session not found: ${sessionId}` };
		}
		const autoRunFolderPath: string | undefined = session.autoRunFolderPath;
		if (!autoRunFolderPath) {
			return { ok: false, error: 'Session has no Auto Run folder configured' };
		}
		try {
			return { ok: true, autoRunFolderPath, sshConfig: resolveSessionSshConfig(session) };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : 'SSH remote not found or disabled',
			};
		}
	};

	server.setImportMarketplacePlaybookCallback(
		async (sessionId, playbookId, targetFolderName, options) => {
			const target = resolveSessionTarget(sessionId);
			if (!target.ok) return { success: false, error: target.error };
			const { autoRunFolderPath, sshConfig } = target;
			const update = options?.update === true;
			try {
				const result = await importMarketplacePlaybook({
					app: electronApp,
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshConfig,
					update,
				});
				// Same push the desktop IPC import sends, so an open Auto Run
				// panel lists the record a CLI or browser import just wrote.
				safeSend(PLAYBOOKS_CHANGED_CHANNEL, sessionId);
				return {
					success: true,
					playbook: result.playbook,
					importedDocs: result.importedDocs,
					importedAssets: result.importedAssets,
					failedDocs: result.failedDocs,
					failedAssets: result.failedAssets,
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				captureException(err instanceof Error ? err : new Error(errorMsg), {
					extra: {
						operation: 'webServerFactory:importMarketplacePlaybook',
						sessionId,
						playbookId,
						targetFolderName,
						update,
					},
				});
				logger.error(
					`Marketplace ${update ? 'update' : 'import'} failed for ${playbookId}: ${errorMsg}`,
					'WebServer'
				);
				return { success: false, error: errorMsg };
			}
		}
	);

	server.setCheckMarketplaceUpdatesCallback(async (sessionId) => {
		const target = resolveSessionTarget(sessionId);
		if (!target.ok) return { success: false, error: target.error };
		try {
			const updates = await checkMarketplacePlaybookUpdates({
				app: electronApp,
				sessionId,
				autoRunFolderPath: target.autoRunFolderPath,
				sshConfig: target.sshConfig,
			});
			return { success: true, updates };
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			captureException(err instanceof Error ? err : new Error(errorMsg), {
				extra: { operation: 'webServerFactory:checkMarketplaceUpdates', sessionId },
			});
			logger.error(`Marketplace update check failed for ${sessionId}: ${errorMsg}`, 'WebServer');
			return { success: false, error: errorMsg };
		}
	});
}
