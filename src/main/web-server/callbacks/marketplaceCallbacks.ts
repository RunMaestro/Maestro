import { app as electronApp } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import type { StoredSession } from '../../stores/types';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	MarketplaceImportError,
	MarketplaceLaunchValuesError,
} from '../../../shared/marketplace-types';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
	launchMarketplacePlaybook,
	completeMarketplaceLaunch,
	getMarketplaceLaunch,
	listMarketplaceLaunches,
} from '../../services/marketplace-service';

// =====================================================================
// Marketplace (Playbook Exchange) callbacks - main-process pure ops,
// no renderer round-trip. Mirrors the desktop IPC handlers in
// src/main/ipc/handlers/marketplace.ts.
// =====================================================================

/**
 * A failed launch call as the web client gets it. A `MarketplaceImportError` (and every launch
 * error subclasses it) is a refusal with a message written for the user: the caller's input, or the
 * agent's state, such as a launch already running. It is only returned. Anything else is a fault,
 * reported to Sentry and logged as well.
 */
function launchCallFailure(
	error: unknown,
	operation: string,
	extra: Record<string, unknown>
): { success: false; error: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof MarketplaceImportError)) {
		void captureException(error, { operation, ...extra });
		logger.error(`${operation} failed: ${message}`, 'WebServer');
	}
	return { success: false, error: message };
}

export function registerMarketplaceCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'settingsStore' | 'sessionsStore' | 'marketplaceLaunchHost'
	>
): void {
	const { settingsStore, sessionsStore, marketplaceLaunchHost } = deps;

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

	/**
	 * Where an import or a launch on an agent writes: the stored agent's own Auto Run folder and
	 * SSH remote, never paths from the client, so a client cannot pick the folder a launch writes
	 * into or the one its cleanup deletes. SSH is resolved up front, so an SSH-enabled agent whose
	 * remote cannot be resolved gets a typed failure instead of a silent write on this computer.
	 * These failures are user misconfiguration, not bugs, so callers return them without a Sentry
	 * report.
	 */
	const resolveAgentImportTarget = (
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

	server.setImportMarketplacePlaybookCallback(
		async (sessionId, playbookId, targetFolderName, launchValues) => {
			const target = resolveAgentImportTarget(sessionId);
			if (!target.ok) {
				return { success: false, error: target.error };
			}
			const { autoRunFolderPath, sshConfig } = target;
			try {
				const result = await importMarketplacePlaybook({
					app: electronApp,
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshConfig,
					launchValues,
				});
				return {
					success: true,
					playbook: result.playbook,
					importedDocs: result.importedDocs,
					importedAssets: result.importedAssets,
				};
			} catch (err) {
				// Answers that fail validation are the client's input, not a fault: no Sentry report.
				if (err instanceof MarketplaceLaunchValuesError) {
					return { success: false, error: err.message };
				}
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
		}
	);

	// Playbook Launch (`maestro-cli marketplace launch`), through the functions the IPC handlers
	// call, with the same launch host.
	if (marketplaceLaunchHost) {
		const launchHost = marketplaceLaunchHost;

		server.setLaunchMarketplacePlaybookCallback(async (request) => {
			const { sessionId, playbookId } = request;
			const target = resolveAgentImportTarget(sessionId);
			if (!target.ok) {
				return { success: false, error: target.error };
			}
			try {
				const result = await launchMarketplacePlaybook(
					{
						playbookId,
						values: request.values,
						sessionId,
						autoRunFolderPath: target.autoRunFolderPath,
						sshRemoteId: target.sshConfig?.id,
						keepSavedPlaybook: request.keepSavedPlaybook,
					},
					launchHost
				);
				return { success: true, ...result };
			} catch (err) {
				return launchCallFailure(err, 'webServerFactory:launchMarketplacePlaybook', {
					sessionId,
					playbookId,
				});
			}
		});

		server.setCompleteMarketplaceLaunchCallback(async (launchId, completion) => {
			try {
				const launch = await completeMarketplaceLaunch(launchId, completion, launchHost);
				return { success: true, launch };
			} catch (err) {
				return launchCallFailure(err, 'webServerFactory:completeMarketplaceLaunch', { launchId });
			}
		});
	}

	server.setGetMarketplaceLaunchCallback(async (launchId) => {
		try {
			const launch = await getMarketplaceLaunch(electronApp, launchId);
			return { success: true, launch };
		} catch (err) {
			return launchCallFailure(err, 'webServerFactory:getMarketplaceLaunch', { launchId });
		}
	});

	server.setListMarketplaceLaunchesCallback(async (options) => {
		try {
			const launches = await listMarketplaceLaunches(electronApp, options);
			return { success: true, launches };
		} catch (err) {
			return launchCallFailure(err, 'webServerFactory:listMarketplaceLaunches', {});
		}
	});
}
