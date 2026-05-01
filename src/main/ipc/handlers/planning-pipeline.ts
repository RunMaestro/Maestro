/**
 * Planning Pipeline IPC Handlers
 *
 * Read-only query surface that aggregates Work Graph items by their
 * pipeline stage label and returns a dashboard snapshot.
 *
 * Channel:
 *   pipeline:getDashboard  →  PipelineDashboardResult
 *
 * The handler is stateless: it lists all Work Graph items on every call and
 * classifies each one via detectCurrentStage().  For a v1 read-only dashboard
 * this is sufficient; a caching layer can be added in a follow-up if needed.
 *
 * @see src/shared/planning-pipeline-types.ts   — stage vocabulary
 * @see src/shared/planning-pipeline-guards.ts  — detectCurrentStage()
 * @see src/main/work-graph/index.ts            — getWorkGraphItemStore()
 */

import { ipcMain } from 'electron';
import { createIpcDataHandler } from '../../utils/ipcHandler';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { getWorkGraphItemStore } from '../../work-graph';
import { detectCurrentStage } from '../../../shared/planning-pipeline-guards';
import {
	PIPELINE_STAGES,
	PIPELINE_FAILURE_STAGES,
	type AnyPipelineStage,
} from '../../../shared/planning-pipeline-types';
import type { WorkItem } from '../../../shared/work-graph-types';
import type { SettingsStoreInterface } from '../../stores/types';

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/** Ordered list of all pipeline stage keys for consumers to iterate. */
export const ALL_PIPELINE_STAGES: readonly AnyPipelineStage[] = [
	...PIPELINE_STAGES,
	...PIPELINE_FAILURE_STAGES,
];

/**
 * Dashboard snapshot returned by `pipeline:getDashboard`.
 *
 * - `stages`   — items grouped by their current pipeline stage label.
 * - `unstaged` — items that carry no pipeline label (not yet on-boarded).
 * - `total`    — total item count across all buckets (stages + unstaged).
 */
export interface PipelineDashboardResult {
	stages: Record<AnyPipelineStage, WorkItem[]>;
	unstaged: WorkItem[];
	total: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const LOG_CONTEXT = '[PlanningPipeline]';

export interface PlanningPipelineHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerPlanningPipelineHandlers(deps: PlanningPipelineHandlerDependencies): void {
	const workGraph = getWorkGraphItemStore();

	/** Check the planningPipeline encore feature flag. Returns structured error or null. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'planningPipeline');

	// -------------------------------------------------------------------------
	// pipeline:getDashboard
	//
	// Lists all Work Graph items and classifies each by pipeline stage.
	// Returns the full PipelineDashboardResult shape.
	// -------------------------------------------------------------------------
	ipcMain.handle('pipeline:getDashboard', async (_event) => {
		const gateError = gate();
		if (gateError) return gateError;
		return createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getDashboard', logSuccess: false },
			async (): Promise<PipelineDashboardResult> => {
				const { items } = await workGraph.listItems({});

				// Seed empty buckets for every stage so callers don't need to
				// guard against missing keys.
				const stages = Object.fromEntries(
					ALL_PIPELINE_STAGES.map((s) => [s, [] as WorkItem[]])
				) as Record<AnyPipelineStage, WorkItem[]>;

				const unstaged: WorkItem[] = [];

				for (const item of items) {
					const stage = detectCurrentStage(item.tags);
					if (stage === null) {
						unstaged.push(item);
					} else {
						stages[stage].push(item);
					}
				}

				return { stages, unstaged, total: items.length };
			}
		)(_event);
	});
}
