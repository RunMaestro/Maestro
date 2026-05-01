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
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import type { GithubProjectMapping } from '../../delivery-planner/github-project-discovery';
import { discoverGithubProject } from '../../delivery-planner/github-project-discovery';

const LOG_CONTEXT = '[PmResolveGithubProject]';

// Legacy fallback — used only when projectPath is inside the HumpfTech/Maestro fork
// AND no mapping has been stored yet.
const LEGACY_FALLBACK: GithubProjectMapping = {
	owner: 'HumpfTech',
	repo: 'Maestro',
	projectNumber: 7,
	projectId: '',
	projectTitle: 'Humpf Tech Maestro Features',
	discoveredAt: '2024-01-01T00:00:00.000Z',
};

export interface ResolveGithubProjectInput {
	projectPath: string;
	/** When true, ignore any cached mapping and re-run discovery. */
	forceRefresh?: boolean;
}

export type ResolveGithubProjectResult =
	| { success: true; data: GithubProjectMapping; fromCache: boolean }
	| { success: false; error: string };

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
			if (gateError) return { success: false, error: 'Feature not enabled' };

			const { projectPath, forceRefresh = false } = input ?? {};
			if (!projectPath) {
				return { success: false, error: 'projectPath is required' };
			}

			// 1. Cache hit
			const map = deps.settingsStore.get<Record<string, GithubProjectMapping>>(
				'projectGithubMap',
				{}
			);
			if (!forceRefresh && map[projectPath]) {
				return { success: true, data: map[projectPath], fromCache: true };
			}

			// 2. Discover
			try {
				const discovered = await discoverGithubProject(projectPath);

				// 3. Persist
				const updatedMap = { ...map, [projectPath]: discovered };
				deps.settingsStore.set('projectGithubMap', updatedMap);

				return { success: true, data: discovered, fromCache: false };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`${LOG_CONTEXT} discovery failed for "${projectPath}":`, message);

				// Fallback: if projectGithubMap is completely empty and the path looks like
				// the HumpfTech/Maestro fork, return the legacy values rather than hard-failing.
				const isEmpty = Object.keys(map).length === 0;
				if (isEmpty && isLikelyLegacyRepo(projectPath)) {
					console.warn(
						`${LOG_CONTEXT} Using legacy fallback for "${projectPath}". Run /PM-init to persist proper mapping.`
					);
					return { success: true, data: LEGACY_FALLBACK, fromCache: false };
				}

				return {
					success: false,
					error: `GitHub project discovery failed: ${message}. Run /PM-init or reload the Dev Crew tab.`,
				};
			}
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
