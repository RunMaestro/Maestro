/**
 * pm:resolveGithubProject IPC Handler — #447
 *
 * Resolves (and caches) the GitHub Projects v2 mapping for a given project path.
 *
 * Channel:
 *   pm:resolveGithubProject  ({ projectPath: string })  →  ResolveGithubProjectResult
 *
 * Behaviour:
 *   1. Check settings store for an existing mapping (cache hit → return immediately).
 *   2. Run git-remote discovery + gh project list/create via discoverGithubProject().
 *   3. Persist the result in projectGithubMap and return it.
 *
 * Fallback:
 *   If projectGithubMap is empty AND discovery fails we fall back to the legacy
 *   HumpfTech/Maestro project #7 (defensive — only applies to that one repo).
 *
 * Gated by the `deliveryPlanner` encore feature flag.
 *
 * All known failure modes return a structured error code so the renderer can
 * surface a specific message + action instead of a generic string.
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import type {
	GithubProjectMapping,
	DiscoveryErrorCode,
	RawProject,
} from '../../delivery-planner/github-project-discovery';
import { discoverGithubProject } from '../../delivery-planner/github-project-discovery';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import {
	LEGACY_HUMPFTECH_OWNER,
	LEGACY_HUMPFTECH_REPO,
	LEGACY_HUMPFTECH_PROJECT_NUMBER,
	LEGACY_HUMPFTECH_PROJECT_TITLE,
} from '../../../shared/legacy-humpftech-fallback';

const LOG_CONTEXT = '[PmResolveGithubProject]';

/**
 * Legacy fallback mapping — used only when the projectGithubMap settings store is empty
 * AND discovery fails for a non-actionable reason.
 *
 * This is a defensive fallback for the HumpfTech/Maestro fork environment;
 * auto-discovery should normally provide values from `projectGithubMap`.
 * Run /PM-init to persist a proper mapping and suppress this fallback.
 *
 * TODO: remove once auto-discovery is universal (#447).
 */
const LEGACY_FALLBACK: GithubProjectMapping = {
	owner: LEGACY_HUMPFTECH_OWNER,
	repo: LEGACY_HUMPFTECH_REPO,
	projectNumber: LEGACY_HUMPFTECH_PROJECT_NUMBER,
	projectId: '',
	projectTitle: LEGACY_HUMPFTECH_PROJECT_TITLE,
	discoveredAt: '2024-01-01T00:00:00.000Z',
};

export interface ResolveGithubProjectInput {
	projectPath: string;
	/** When true, ignore any cached mapping and re-run discovery. */
	forceRefresh?: boolean;
	/**
	 * SSH remote ID for the active session.
	 * When provided and the remote is enabled, git commands run on that host
	 * instead of the local filesystem — required for projects on SSH remotes.
	 */
	sshRemoteId?: string | null;
}

export type ResolveGithubProjectResult =
	| { success: true; data: GithubProjectMapping; fromCache: boolean }
	| {
			success: false;
			/** Human-readable message suitable for display. */
			error: string;
			/** Structured code so the renderer can map to a specific action. */
			code: DiscoveryErrorCode | 'UNKNOWN' | 'FEATURE_DISABLED' | 'INVALID_INPUT';
			/** Extra detail (e.g. stdout snippet for GH_CLI_OUTPUT_UNRECOGNIZED). */
			detail?: string;
			/** Returned when code is MULTIPLE_MATCHES. */
			candidates?: RawProject[];
	  };

export interface PmResolveGithubProjectHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmResolveGithubProjectHandlers(
	deps: PmResolveGithubProjectHandlerDependencies
): void {
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	// ── pm:resolveGithubProject ───────────────────────────────────────────────
	ipcMain.handle(
		'pm:resolveGithubProject',
		async (_event, input: ResolveGithubProjectInput): Promise<ResolveGithubProjectResult> => {
			const gateError = gate();
			if (gateError)
				return { success: false, code: 'FEATURE_DISABLED', error: 'Feature not enabled' };

			const { projectPath, forceRefresh = false, sshRemoteId } = input ?? {};
			if (!projectPath) {
				return { success: false, code: 'INVALID_INPUT', error: 'projectPath is required' };
			}

			// 1. Cache hit
			const map = deps.settingsStore.get<Record<string, GithubProjectMapping>>(
				'projectGithubMap',
				{}
			);
			if (!forceRefresh && map[projectPath]) {
				return { success: true, data: map[projectPath], fromCache: true };
			}

			// 2. Build SSH config when the session uses an SSH remote.
			// git runs on the remote host; gh CLI stays local (it has the user's GitHub auth).
			const sshRemoteConfig = sshRemoteId ? { enabled: true, remoteId: sshRemoteId } : undefined;
			const sshStore = createSshRemoteStoreAdapter(deps.settingsStore);

			// 3. Discover
			const result = await discoverGithubProject({
				projectPath,
				sshRemoteConfig,
				sshStore,
			});

			if (!result.ok) {
				const { code, message, detail, candidates } = result.error;
				console.error(
					`${LOG_CONTEXT} discovery failed for "${projectPath}" [${code}]:`,
					message,
					detail ?? ''
				);

				// Fallback: if projectGithubMap is completely empty and the path looks like
				// the HumpfTech/Maestro fork, return the legacy values rather than hard-failing.
				// Only applies for non-actionable infrastructure errors (not auth/missing-cli).
				const isEmpty = Object.keys(map).length === 0;
				const isFallbackEligible =
					isEmpty &&
					isLikelyLegacyRepo(projectPath) &&
					code !== 'GH_CLI_MISSING' &&
					code !== 'GH_AUTH_REQUIRED' &&
					code !== 'MULTIPLE_MATCHES';

				if (isFallbackEligible) {
					console.warn(
						`${LOG_CONTEXT} Using legacy fallback for "${projectPath}". Run /PM-init to persist proper mapping.`
					);
					return { success: true, data: LEGACY_FALLBACK, fromCache: false };
				}

				return {
					success: false,
					code,
					error: message,
					...(detail !== undefined && { detail }),
					...(candidates !== undefined && { candidates }),
				};
			}

			// 3. Persist
			const { mapping } = result;
			const updatedMap = { ...map, [projectPath]: mapping };
			deps.settingsStore.set('projectGithubMap', updatedMap);

			return { success: true, data: mapping, fromCache: false };
		}
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: path is likely the HumpfTech/Maestro fork if it contains
 * common fork path segments. Not a hard guarantee — just a best-effort
 * fallback guard.
 */
function isLikelyLegacyRepo(projectPath: string): boolean {
	const lower = projectPath.toLowerCase();
	return lower.includes('maestro') || lower.includes('humpf');
}
