/**
 * Cue Stats IPC Handlers
 *
 * Exposes the Phase 03 aggregation query (`getCueStatsAggregation`) to the
 * renderer over a single IPC channel. Mirrors the structure of `stats.ts` —
 * thin transport that delegates to domain code.
 *
 * Gated at the handler on BOTH Encore flags (`encoreFeatures.usageStats` AND
 * `encoreFeatures.maestroCue`). The dashboard fuses Cue lineage with token
 * data, so disabling either feature must hide it. Failure mode is throwing
 * `'CueStatsDisabled'` rather than returning an empty payload — the renderer
 * needs to distinguish "feature off" from "no data in window".
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { getCueStatsAggregation } from '../../cue/stats/cue-stats-query';
import type { CueStatsAggregation, CueStatsTimeRange } from '../../../shared/cue-stats-types';
import type { CueEngine } from '../../cue/cue-engine';

const LOG_CONTEXT = '[CueStats]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies for cue-stats handlers
 */
export interface CueStatsHandlerDependencies {
	settingsStore: {
		get: (key: string) => unknown;
	};
	/**
	 * Optional accessor for the running Cue engine. When provided, the handler
	 * builds a `subscriptionName → pipelineName` map from the live config so
	 * legacy events with NULL `pipeline_id` still resolve to their actual
	 * pipeline instead of dumping into "Unattributed".
	 */
	getCueEngine?: () => CueEngine | null;
}

/**
 * Build a `subscriptionName → pipelineName` lookup from the engine's current
 * graph data. Subscriptions without a `pipeline_name` field are skipped — they
 * legitimately don't belong to a pipeline. When the engine isn't available
 * (or has no sessions registered yet), returns an empty map.
 */
function buildSubscriptionToPipelineMap(
	getCueEngine: (() => CueEngine | null) | undefined
): Map<string, string> {
	const result = new Map<string, string>();
	const engine = getCueEngine?.();
	if (!engine) return result;
	let graph: ReturnType<CueEngine['getGraphData']>;
	try {
		graph = engine.getGraphData();
	} catch {
		// Engine isn't started or threw while reading config. The query falls
		// back to the persisted `pipeline_id` column, so an empty map is fine.
		return result;
	}
	for (const session of graph) {
		for (const sub of session.subscriptions) {
			const pipeline =
				typeof sub.pipeline_name === 'string' && sub.pipeline_name.length > 0
					? sub.pipeline_name
					: null;
			if (pipeline) result.set(sub.name, pipeline);
		}
	}
	return result;
}

/**
 * Returns true only when BOTH `encoreFeatures.usageStats` and
 * `encoreFeatures.maestroCue` are explicitly enabled. Reads on every call so
 * the renderer sees toggle changes without an app restart.
 */
function isCueStatsEnabled(settingsStore: { get: (key: string) => unknown }): boolean {
	const ef = (settingsStore.get('encoreFeatures') ?? {}) as Record<string, unknown>;
	return ef.usageStats === true && ef.maestroCue === true;
}

/**
 * Register the Cue Stats IPC handler.
 */
export function registerCueStatsHandlers(deps: CueStatsHandlerDependencies): void {
	const { settingsStore, getCueEngine } = deps;

	// Run the disabled-flag gate OUTSIDE withIpcErrorLogging so the
	// `CueStatsDisabled` sentinel isn't treated as an unexpected IPC error and
	// doesn't pollute Sentry/log output for what is the renderer's expected
	// recovery path. Real errors from the aggregation query stay wrapped.
	const wrappedAggregation = withIpcErrorLogging(
		handlerOpts('getAggregation'),
		async (range: CueStatsTimeRange): Promise<CueStatsAggregation> => {
			const subscriptionToPipeline = buildSubscriptionToPipelineMap(getCueEngine);
			return getCueStatsAggregation(range, { subscriptionToPipeline });
		}
	);

	ipcMain.handle(
		'cue-stats:get-aggregation',
		async (
			event: Electron.IpcMainInvokeEvent,
			range: CueStatsTimeRange
		): Promise<CueStatsAggregation> => {
			if (!isCueStatsEnabled(settingsStore)) {
				throw new Error('CueStatsDisabled');
			}
			return wrappedAggregation(event, range);
		}
	);
}
