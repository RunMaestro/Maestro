/**
 * Preload API for Cue Stats operations.
 *
 * Exposes `window.maestro.cueStats` — the renderer-side bridge to the Phase 03
 * aggregation handler (`cue-stats:get-aggregation`). The handler throws
 * `'CueStatsDisabled'` when either `encoreFeatures.usageStats` or
 * `encoreFeatures.maestroCue` is off; consumers should catch that to render
 * the "feature off" state.
 */

import { ipcRenderer } from 'electron';
import type { CueStatsAggregation, CueStatsTimeRange } from '../../shared/cue-stats-types';

export type { CueStatsAggregation, CueStatsTimeRange } from '../../shared/cue-stats-types';

export function createCueStatsApi() {
	return {
		// Get the full Cue stats aggregation payload for the given time range.
		// Throws an Error with message exactly 'CueStatsDisabled' when either
		// Encore flag is off. Electron's IPC layer wraps thrown errors into
		// `Error invoking remote method '...': Error: <original>`, so we
		// detect that wrapper here and rethrow the bare sentinel — keeps the
		// preload contract stable for renderer consumers.
		getAggregation: async (range: CueStatsTimeRange): Promise<CueStatsAggregation> => {
			try {
				return await ipcRenderer.invoke('cue-stats:get-aggregation', range);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes('CueStatsDisabled')) {
					throw new Error('CueStatsDisabled');
				}
				throw error;
			}
		},
	};
}

export type CueStatsApi = ReturnType<typeof createCueStatsApi>;
