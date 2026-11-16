import type { AutoRunSession, StatsTimeRange } from '../../../shared/stats-types';
import { useDashboardResource } from './useDashboardResource';

/**
 * The Auto Run runs in a range. AutoRunStats and LongestAutoRunsTable read
 * through this one cache key, so the two panels cost one fetch.
 */
export function useAutoRunSessions(timeRange: StatsTimeRange) {
	return useDashboardResource<AutoRunSession[]>(
		`autorun-sessions:${timeRange}`,
		() => window.maestro.stats.getAutoRunSessions(timeRange),
		'fetchAutoRunSessions',
		{ tables: ['auto_run'] }
	);
}
