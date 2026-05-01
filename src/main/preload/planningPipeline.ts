/**
 * Preload API for the Planning Pipeline
 *
 * Provides the window.maestro.pipeline namespace for:
 * - Pipeline dashboard snapshot (getDashboard)
 *
 * The handler is stateless: it reads all Work Graph items and classifies
 * each by pipeline stage on every call.
 */

import { ipcRenderer } from 'electron';

export function createPlanningPipelineApi() {
	return {
		/**
		 * Return a dashboard snapshot of Work Graph items grouped by their
		 * current pipeline stage. Unstaged items (no pipeline label) are
		 * returned in the `unstaged` array.
		 */
		getDashboard: () => ipcRenderer.invoke('pipeline:getDashboard'),
	};
}

export type PlanningPipelineApi = ReturnType<typeof createPlanningPipelineApi>;
