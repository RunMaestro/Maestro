/**
 * Usage Dashboard stats types, re-exported from their canonical home.
 *
 * This module used to hold a `useStats` fetching hook that nothing called (the
 * dashboard fetches through `useUsageDashboardData` and `useDashboardResource`).
 * The type re-exports stay because many dashboard components import them from
 * this path. New code should import from `src/shared/stats-types.ts` directly.
 */

export type { StatsTimeRange, StatsAggregation } from '../../../shared/stats-types';
