/**
 * pm:initRepo IPC Handler — #445
 *
 * Idempotently initializes the local Maestro Board / Work Graph PM surface
 * for the active project.
 *
 * Channel:
 *   pm:initRepo  ({ repo?: string })  → PmInitResult
 *
 * Behaviour:
 *   1. Ensure PM tags/metadata conventions exist in Work Graph.
 *   2. Return { created, existing, errors } — idempotent; calling twice is safe.
 *
 * Gated by the `deliveryPlanner` encore feature flag.
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';
import { initializeLocalPmProject } from '../../local-pm/pm-tools';
import { logger } from '../../utils/logger';

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

		try {
			const initResult = await initializeLocalPmProject({ projectPath: input.projectPath });
			result.created.push(...initResult.created);
			result.existing.push(...initResult.existing);
			result.errors.push(...initResult.errors);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`pm:initRepo failed: ${message}`, LOG_CONTEXT);
			result.errors.push(message);
		}

		return result;
	});
}
