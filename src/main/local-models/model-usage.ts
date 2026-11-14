/**
 * Model usage, as the running app reads it.
 *
 * `getModelUsage()` in `src/main/stats/model-usage.ts` counts what is in the
 * stats database, where a source is an id and an agent is an id. This module
 * hands it the names only the app knows (the saved endpoints, the user's
 * OpenJev server, the agents) and is the one function the renderer's IPC
 * channel and the CLI's WS message both call, so the Usage Dashboard's Models
 * tab and `maestro-cli stats models` read one record.
 *
 * It reads settings and the stats database. It sends nothing.
 */

import type { ModelUsage, ModelUsageNames } from '../../shared/local-models/model-usage';
import { isStatsTimeRange, STATS_TIME_RANGES, type StatsTimeRange } from '../../shared/stats-types';
import { getStatsDB } from '../stats/singleton';
import { getConfiguredLocalModelEndpoints } from './endpoint-service';
import { storedAgentRecord } from './run-on';
import { readSystemOneSettings } from './system-one/config-store';
import { systemOneDataDir } from './system-one/service';

/** The range a read with none named covers. The dashboard's own default. */
export const MODEL_USAGE_DEFAULT_RANGE: StatsTimeRange = 'week';

function agentName(agentId: string): string | undefined {
	const name = storedAgentRecord(agentId)?.name;
	return typeof name === 'string' && name !== '' ? name : undefined;
}

/** What the app knows about the ids in the stats database. */
async function readModelUsageNames(): Promise<ModelUsageNames> {
	const systemOne = await readSystemOneSettings(systemOneDataDir());
	return {
		endpoints: getConfiguredLocalModelEndpoints(),
		openJevUrl: systemOne.openJevUrl,
		agentName,
	};
}

/**
 * What every model other than a provider's own did in a range, with names. A
 * range that is not one of `STATS_TIME_RANGES` rejects with the list; no range
 * reads the default.
 */
export async function readModelUsage(rawRange?: unknown): Promise<ModelUsage> {
	const range = rawRange === undefined || rawRange === null ? MODEL_USAGE_DEFAULT_RANGE : rawRange;
	if (!isStatsTimeRange(range)) {
		throw new Error(`Invalid range. Must be one of: ${STATS_TIME_RANGES.join(', ')}`);
	}
	return getStatsDB().getModelUsage(range, await readModelUsageNames());
}
