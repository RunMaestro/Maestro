import { app as electronApp } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import type { StoredSession } from '../../stores/types';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
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

	server.setGetMarketplaceManifestCallback(async (options) => {
		if (options?.refresh) {
			return refreshMarketplaceManifest(electronApp);
		}
		return getMarketplaceManifest(electronApp);
	});

	server.setGetMarketplaceDocumentCallback(async (playbookPath, filename) => {
		return getMarketplaceDocument(playbookPath, filename);
	});

	server.setGetMarketplaceReadmeCallback(async (playbookPath) => {
		return getMarketplaceReadme(playbookPath);
	});

	server.setImportMarketplacePlaybookCallback(async (sessionId, playbookId, targetFolderName) => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			return { success: false, error: `Session not found: ${sessionId}` };
		}
		const autoRunFolderPath: string | undefined = session.autoRunFolderPath;
		if (!autoRunFolderPath) {
			return {
				success: false,
				error: 'Session has no Auto Run folder configured',
			};
		}
		// Resolve SSH up front so an unresolvable remote on an SSH-enabled
		// session returns a typed failure instead of silently importing
		// locally. Errors here aren't exceptional bugs - they're user
		// misconfiguration - so we don't route them through the
		// captureException catch below.
		let sshConfig: SshRemoteConfig | undefined;
		try {
			sshConfig = resolveSessionSshConfig(session);
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : 'SSH remote not found or disabled',
			};
		}
		try {
			const result = await importMarketplacePlaybook({
				app: electronApp,
				playbookId,
				targetFolderName,
				autoRunFolderPath,
				sessionId,
				sshConfig,
			});
			return {
				success: true,
				playbook: result.playbook,
				importedDocs: result.importedDocs,
				importedAssets: result.importedAssets,
			};
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			captureException(err instanceof Error ? err : new Error(errorMsg), {
				extra: {
					operation: 'webServerFactory:importMarketplacePlaybook',
					sessionId,
					playbookId,
					targetFolderName,
				},
			});
			logger.error(`Marketplace import failed for ${playbookId}: ${errorMsg}`, 'WebServer');
			return { success: false, error: errorMsg };
		}
	});
}
