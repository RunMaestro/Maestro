import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatsAggregation, StatsTimeRange } from '../../../../../shared/stats-types';
import { PERFORMANCE_THRESHOLDS } from '../../../../../shared/performance-metrics';
import type { CueSourceTotals } from '../../SourceDistributionChart';
import type { DelegationDay, DelegationTotals } from '../../../../../shared/delegation';
import { getRendererPerfMetrics, logger } from '../../../../utils/logger';
import { useCachedResource } from '../../../../hooks/utils/useCachedResource';

const perfMetrics = getRendererPerfMetrics('UsageDashboard');

interface UseUsageDashboardDataOptions {
	isOpen: boolean;
	timeRange: StatsTimeRange;
	cueTabEnabled: boolean;
}

/** Everything the modal reads for one range, fetched and cached as one unit. */
interface UsageDashboardPayload {
	data: StatsAggregation;
	databaseSize: number;
	cueSourceTotals: CueSourceTotals | null;
	// Interactive vs autonomous split. Two shapes, because the surfaces ask two
	// different questions: the Overview ratio card and the Activity chart follow
	// the selected time range, while the delegation score is a lifetime figure
	// and must NOT move when the range dropdown changes.
	delegationTotals: DelegationTotals | null;
	lifetimeDelegation: DelegationTotals | null;
	delegationByDay: DelegationDay[];
}

const EMPTY_DELEGATION_DAYS: DelegationDay[] = [];

async function fetchUsageDashboard(
	timeRange: StatsTimeRange,
	cueTabEnabled: boolean
): Promise<UsageDashboardPayload> {
	const fetchStart = perfMetrics.start();
	try {
		// The delegation calls each resolve to a fallback rather than
		// rejecting: they are additions to a dashboard that already works
		// without them, and one failing query must not blank every chart.
		const [stats, dbSize, cueAgg, delegation, lifetime, byDay] = await Promise.all([
			window.maestro.stats.getAggregation(timeRange),
			window.maestro.stats.getDatabaseSize(),
			// The namespace itself is optional: the web bridge doesn't expose
			// `cueStats`, and reaching through an undefined namespace would
			// throw past the per-call catch and error out the whole dashboard.
			cueTabEnabled && window.maestro.cueStats
				? window.maestro.cueStats.getAggregation(timeRange).catch((err) => {
						logger.warn('Failed to fetch Cue totals for source chart:', undefined, err);
						return null;
					})
				: Promise.resolve(null),
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
			cueSourceTotals: cueAgg
				? {
						occurrences: cueAgg.totals.occurrences,
						totalDurationMs: cueAgg.totals.totalDurationMs,
						tokens: (cueAgg.totals.totalInputTokens ?? 0) + (cueAgg.totals.totalOutputTokens ?? 0),
					}
				: null,
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
 */
export function useUsageDashboardData({
	isOpen,
	timeRange,
	cueTabEnabled,
}: UseUsageDashboardDataOptions) {
	const [showNewDataIndicator, setShowNewDataIndicator] = useState(false);
	const newDataIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const resource = useCachedResource(
		`usage-dashboard:${timeRange}:${cueTabEnabled ? 'cue' : 'no-cue'}`,
		() => fetchUsageDashboard(timeRange, cueTabEnabled),
		{
			enabled: isOpen,
			onError: (err) => logger.error('Failed to fetch usage stats:', undefined, err),
		}
	);
	const { refresh } = resource;

	const fetchStats = useCallback(
		async (isRealTimeUpdate = false) => {
			await refresh();
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
		[refresh]
	);

	useEffect(() => {
		if (!isOpen) return;

		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				void fetchStats(true);
			}, 1000);
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
		cueSourceTotals: payload?.cueSourceTotals ?? null,
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
