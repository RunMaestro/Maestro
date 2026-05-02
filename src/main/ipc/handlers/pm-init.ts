/**
 * pm:initRepo IPC Handler — #445
 *
 * Implements the /PM-init slash command: idempotently ensures all AI-prefixed
 * Projects v2 custom fields exist on the active GitHub project.
 *
 * Channel:
 *   pm:initRepo  ({ repo?: string })  → PmInitResult
 *
 * Behaviour:
 *   1. Verify `gh auth status` before attempting anything.
 *   2. Delegate field creation to DeliveryPlannerGithubSync.initProjectFields().
 *   3. Return { created, existing, errors } — idempotent; calling twice is safe.
 *
 * Gated by the `deliveryPlanner` encore feature flag.
 */

import { ipcMain } from 'electron';
import { execFileNoThrow } from '../../utils/execFile';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import { DeliveryPlannerGithubSync } from '../../delivery-planner/github-sync';
import type { GithubProjectMapping } from '../../delivery-planner/github-project-discovery';
import { discoverGithubProject } from '../../delivery-planner/github-project-discovery';

const LOG_CONTEXT = '[PmInit]';

export interface PmInitInput {
	/** Optional repo slug override (e.g. "owner/repo"). Not yet used — reserved for future. */
	repo?: string;
	/** Project path to auto-discover GitHub project from git remote (#447). */
	projectPath?: string;
}

export interface PmInitResult {
	created: string[];
	existing: string[];
	errors: string[];
}

export interface PmInitHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPmInitHandlers(deps: PmInitHandlerDependencies): void {
	const gate = () => requireEncoreFeature(deps.settingsStore, 'deliveryPlanner');

	// ── pm:initRepo ───────────────────────────────────────────────────────────
	ipcMain.handle('pm:initRepo', async (_event, input: PmInitInput = {}) => {
		const gateError = gate();
		if (gateError) return gateError;

		const result: PmInitResult = { created: [], existing: [], errors: [] };

		// Pre-flight: verify gh auth status before touching GitHub.
		try {
			const authCheck = await execFileNoThrow('gh', ['auth', 'status']);
			if (authCheck.exitCode !== 0) {
				const detail = (authCheck.stderr || authCheck.stdout).trim();
				result.errors.push(`gh-auth: Not authenticated — run "gh auth login". ${detail}`.trim());
				return result;
			}
		} catch (err) {
			result.errors.push(
				`gh-auth: Failed to run "gh auth status" — is the gh CLI installed? ${
					err instanceof Error ? err.message : String(err)
				}`
			);
			return result;
		}

		// Step 1 (#447): Discover + persist the GitHub project mapping for this project path.
		// This must run before initProjectFields() so the sync instance uses the right project.
		let projectMapping: GithubProjectMapping | undefined;
		if (input.projectPath) {
			try {
				const map = deps.settingsStore.get<Record<string, GithubProjectMapping>>(
					'projectGithubMap',
					{}
				);
				if (map[input.projectPath]) {
					projectMapping = map[input.projectPath];
				} else {
					const discoveryResult = await discoverGithubProject(input.projectPath);
					if (discoveryResult.ok) {
						projectMapping = discoveryResult.mapping;
						const updatedMap = { ...map, [input.projectPath]: projectMapping };
						deps.settingsStore.set('projectGithubMap', updatedMap);
					} else {
						console.warn(
							`${LOG_CONTEXT} GitHub project discovery failed [${discoveryResult.error.code}] — using defaults: ${discoveryResult.error.message}`
						);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`${LOG_CONTEXT} GitHub project discovery failed — using defaults: ${message}`);
				// Non-fatal: fall through to use default project coordinates.
			}
		}

		// Delegate field creation to the shared github-sync helper.
		try {
			const sync = new DeliveryPlannerGithubSync({
				projectOwner: projectMapping?.owner,
				projectNumber: projectMapping?.projectNumber,
				projectTitle: projectMapping?.projectTitle,
			});
			const fieldResult = await sync.initProjectFields();
			result.created.push(...fieldResult.created);
			result.existing.push(...fieldResult.existing);
			result.errors.push(...fieldResult.errors);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${LOG_CONTEXT} pm:initRepo failed:`, message);
			result.errors.push(message);
		}

		return result;
	});
}
