import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatsAggregation, StatsTimeRange } from '../../../../../shared/stats-types';
import { PERFORMANCE_THRESHOLDS } from '../../../../../shared/performance-metrics';
import type { CueSourceTotals } from '../../SourceDistributionChart';
import type { DelegationDay, DelegationTotals } from '../../../../../shared/delegation';
import { getRendererPerfMetrics, logger } from '../../../../utils/logger';

const perfMetrics = getRendererPerfMetrics('UsageDashboard');

interface UseUsageDashboardDataOptions {
	isOpen: boolean;
	timeRange: StatsTimeRange;
	cueTabEnabled: boolean;
}

export function useUsageDashboardData({
	isOpen,
	timeRange,
	cueTabEnabled,
}: UseUsageDashboardDataOptions) {
	const [data, setData] = useState<StatsAggregation | null>(null);
	const [cueSourceTotals, setCueSourceTotals] = useState<CueSourceTotals | null>(null);
	// Interactive vs autonomous split. Two shapes, because the surfaces ask two
	// different questions: the Overview ratio card and the Activity chart follow
	// the selected time range, while the delegation score is a lifetime figure
	// and must NOT move when the range dropdown changes.
	const [delegationTotals, setDelegationTotals] = useState<DelegationTotals | null>(null);
	const [lifetimeDelegation, setLifetimeDelegation] = useState<DelegationTotals | null>(null);
	const [delegationByDay, setDelegationByDay] = useState<DelegationDay[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showNewDataIndicator, setShowNewDataIndicator] = useState(false);
	const [databaseSize, setDatabaseSize] = useState<number | null>(null);
	const newDataIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fetchStats = useCallback(
		async (isRealTimeUpdate = false) => {
			const fetchStart = perfMetrics.start();

			if (!isRealTimeUpdate) {
				setLoading(true);
			}
			setError(null);

			try {
				// The delegation calls each resolve to a fallback rather than
				// rejecting: they are additions to a dashboard that already works
				// without them, and one failing query must not blank every chart.
				const [stats, dbSize, cueAgg, delegation, lifetime, byDay] = await Promise.all([
					window.maestro.stats.getAggregation(timeRange),
					window.maestro.stats.getDatabaseSize(),
					cueTabEnabled
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
				setData(stats);
				setDatabaseSize(dbSize);
				setDelegationTotals(delegation);
				setLifetimeDelegation(lifetime);
				setDelegationByDay(byDay);
				setCueSourceTotals(
					cueAgg
						? {
								occurrences: cueAgg.totals.occurrences,
								totalDurationMs: cueAgg.totals.totalDurationMs,
								tokens:
									(cueAgg.totals.totalInputTokens ?? 0) + (cueAgg.totals.totalOutputTokens ?? 0),
							}
						: null
				);

				const fetchDuration = perfMetrics.end(fetchStart, 'fetchStats', {
					timeRange,
					totalQueries: stats?.totalQueries,
					isRealTimeUpdate,
				});

				if (fetchDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
					logger.warn(
						`[UsageDashboard] fetchStats took ${fetchDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
						undefined,
						{ timeRange, totalQueries: stats?.totalQueries }
					);
				}

				if (isRealTimeUpdate) {
					setShowNewDataIndicator(true);
					if (newDataIndicatorTimerRef.current) {
						clearTimeout(newDataIndicatorTimerRef.current);
					}
					newDataIndicatorTimerRef.current = setTimeout(() => {
						setShowNewDataIndicator(false);
						newDataIndicatorTimerRef.current = null;
					}, 3000);
				}
			} catch (err) {
				logger.error('Failed to fetch usage stats:', undefined, err);
				setError(err instanceof Error ? err.message : 'Failed to load stats');
				perfMetrics.end(fetchStart, 'fetchStats:error', { timeRange, error: String(err) });
			} finally {
				setLoading(false);
			}
		},
		[timeRange, cueTabEnabled]
	);

	useEffect(() => {
		if (!isOpen) return;

		fetchStats();

		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				fetchStats(true);
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

	return {
		data,
		cueSourceTotals,
		delegationTotals,
		lifetimeDelegation,
		delegationByDay,
		loading,
		error,
		showNewDataIndicator,
		databaseSize,
		fetchStats,
	};
}
