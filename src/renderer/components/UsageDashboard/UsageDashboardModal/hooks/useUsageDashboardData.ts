import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	StatsAggregation,
	StatsTable,
	StatsTimeRange,
} from '../../../../../shared/stats-types';
import { PERFORMANCE_THRESHOLDS } from '../../../../../shared/performance-metrics';
import type { CueSourceTotals } from '../../SourceDistributionChart';
import type { DelegationDay, DelegationTotals } from '../../../../../shared/delegation';
import { getRendererPerfMetrics, logger } from '../../../../utils/logger';
import { useCachedResource } from '../../../../hooks/utils/useCachedResource';
import { statsUpdateConcerns } from '../../useDashboardResource';

const perfMetrics = getRendererPerfMetrics('UsageDashboard');

interface UseUsageDashboardDataOptions {
	isOpen: boolean;
	timeRange: StatsTimeRange;
	cueTabEnabled: boolean;
	/**
	 * Whether the visible tab draws the Cue slice of the source chart (the
	 * Overview). The Cue aggregate is a full Cue-DB aggregation fetched for three
	 * numbers, so it is read only while a tab shows them.
	 */
	needsCueTotals?: boolean;
}

/**
 * The stats tables this payload reads: the aggregation scans query_events,
 * session_lifecycle and auto_run tasks, and the delegation split reads
 * query_events (its Cue half comes from cue.db, which does not raise
 * `stats:updated`). A write to any other table (a shortcut press, a
 * resilience retry, a wizard run) leaves the payload alone.
 */
export const USAGE_DASHBOARD_TABLES: readonly StatsTable[] = [
	'query_events',
	'auto_run',
	'image_annotations',
];

/** Quiet period before a burst of `stats:updated` events refetches the payload. */
export const USAGE_DASHBOARD_REFRESH_DEBOUNCE_MS = 1000;

/** Everything the modal reads for one range, fetched and cached as one unit. */
interface UsageDashboardPayload {
	data: StatsAggregation;
	databaseSize: number;
	// Interactive vs autonomous split. Two shapes, because the surfaces ask two
	// different questions: the Overview ratio card and the Activity chart follow
	// the selected time range, while the delegation score is a lifetime figure
	// and must NOT move when the range dropdown changes.
	delegationTotals: DelegationTotals | null;
	lifetimeDelegation: DelegationTotals | null;
	delegationByDay: DelegationDay[];
}

const EMPTY_DELEGATION_DAYS: DelegationDay[] = [];

async function fetchCueSourceTotals(timeRange: StatsTimeRange): Promise<CueSourceTotals | null> {
	// The namespace itself is optional: the web bridge doesn't expose
	// `cueStats`. A failure resolves to null: the source chart draws without
	// its Cue slice rather than erroring the Overview.
	if (!window.maestro.cueStats) return null;
	try {
		// Totals-only read: the full Cue aggregate is far heavier than three numbers.
		return await window.maestro.cueStats.getSourceTotals(timeRange);
	} catch (err) {
		logger.warn('Failed to fetch Cue totals for source chart:', undefined, err);
		return null;
	}
}

async function fetchUsageDashboard(timeRange: StatsTimeRange): Promise<UsageDashboardPayload> {
	const fetchStart = perfMetrics.start();
	try {
		// The delegation calls each resolve to a fallback rather than
		// rejecting: they are additions to a dashboard that already works
		// without them, and one failing query must not blank every chart.
		const [stats, dbSize, delegation, lifetime, byDay] = await Promise.all([
			window.maestro.stats.getAggregation(timeRange),
			window.maestro.stats.getDatabaseSize(),
			window.maestro.stats.getDelegationTotals(timeRange).catch((err) => {
				logger.warn('Failed to fetch delegation totals:', undefined, err);
				return null;
			}),
			window.maestro.stats.getDelegationTotals('all').catch((err) => {
				logger.warn('Failed to fetch lifetime delegation totals:', undefined, err);
				return null;
			}),
			window.maestro.stats.getDelegationByDay(timeRange).catch((err) => {
				logger.warn('Failed to fetch delegation day series:', undefined, err);
				return [] as DelegationDay[];
			}),
		]);

		const fetchDuration = perfMetrics.end(fetchStart, 'fetchStats', {
			timeRange,
			totalQueries: stats?.totalQueries,
		});
		if (fetchDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
			logger.warn(
				`[UsageDashboard] fetchStats took ${fetchDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
				undefined,
				{ timeRange, totalQueries: stats?.totalQueries }
			);
		}

		return {
			data: stats,
			databaseSize: dbSize,
			delegationTotals: delegation,
			lifetimeDelegation: lifetime,
			delegationByDay: byDay,
		};
	} catch (err) {
		perfMetrics.end(fetchStart, 'fetchStats:error', { timeRange, error: String(err) });
		throw err;
	}
}

/**
 * The modal's stats payload, served stale-while-revalidate: reopening the
 * dashboard (which unmounts on close) renders the last result for the range on
 * the first frame and refreshes it in place, instead of starting from a
 * skeleton every time.
 *
 * Live updates: refetches on `stats:updated` only for the tables in
 * `USAGE_DASHBOARD_TABLES`, one trailing refetch per burst.
 */
export function useUsageDashboardData({
	isOpen,
	timeRange,
	cueTabEnabled,
	needsCueTotals = false,
}: UseUsageDashboardDataOptions) {
	const [showNewDataIndicator, setShowNewDataIndicator] = useState(false);
	const newDataIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const resource = useCachedResource(
		`usage-dashboard:${timeRange}`,
		() => fetchUsageDashboard(timeRange),
		{
			enabled: isOpen,
			onError: (err) => logger.error('Failed to fetch usage stats:', undefined, err),
		}
	);
	const { refresh } = resource;

	const cueTotalsEnabled = isOpen && cueTabEnabled && needsCueTotals;
	const cueResource = useCachedResource(
		cueTabEnabled ? `usage-dashboard-cue-totals:${timeRange}` : null,
		() => fetchCueSourceTotals(timeRange),
		{ enabled: cueTotalsEnabled }
	);
	const { refresh: refreshCue } = cueResource;
	const cueTotalsEnabledRef = useRef(cueTotalsEnabled);
	cueTotalsEnabledRef.current = cueTotalsEnabled;

	const fetchStats = useCallback(
		async (isRealTimeUpdate = false) => {
			await Promise.all([refresh(), cueTotalsEnabledRef.current ? refreshCue() : undefined]);
			if (!isRealTimeUpdate) return;
			setShowNewDataIndicator(true);
			if (newDataIndicatorTimerRef.current) {
				clearTimeout(newDataIndicatorTimerRef.current);
			}
			newDataIndicatorTimerRef.current = setTimeout(() => {
				setShowNewDataIndicator(false);
				newDataIndicatorTimerRef.current = null;
			}, 3000);
		},
		[refresh, refreshCue]
	);

	useEffect(() => {
		if (!isOpen) return;

		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = window.maestro.stats.onStatsUpdate((table) => {
			if (!statsUpdateConcerns(table, USAGE_DASHBOARD_TABLES)) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				void fetchStats(true);
			}, USAGE_DASHBOARD_REFRESH_DEBOUNCE_MS);
		});

		return () => {
			unsubscribe();
			if (debounceTimer) clearTimeout(debounceTimer);
			if (newDataIndicatorTimerRef.current) {
				clearTimeout(newDataIndicatorTimerRef.current);
				newDataIndicatorTimerRef.current = null;
			}
		};
	}, [isOpen, fetchStats]);

	const payload = resource.data;
	return {
		data: payload?.data ?? null,
		// Only meaningful with the Cue tab on; a cached value from before the
		// feature was switched off must not leak into the source chart.
		cueSourceTotals: cueTabEnabled ? (cueResource.data ?? null) : null,
		delegationTotals: payload?.delegationTotals ?? null,
		lifetimeDelegation: payload?.lifetimeDelegation ?? null,
		delegationByDay: payload?.delegationByDay ?? EMPTY_DELEGATION_DAYS,
		loading: resource.loading,
		// A failed refresh keeps the last good data on screen; the error screen
		// is only for a range that has never loaded.
		error: payload ? null : resource.error,
		showNewDataIndicator,
		databaseSize: payload?.databaseSize ?? null,
		fetchStats,
	};
}
