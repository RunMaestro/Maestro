import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatsAggregation, StatsTimeRange } from '../../../../../shared/stats-types';
import { PERFORMANCE_THRESHOLDS } from '../../../../../shared/performance-metrics';
import type { CueSourceTotals } from '../../SourceDistributionChart';
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
				const [stats, dbSize, cueAgg] = await Promise.all([
					window.maestro.stats.getAggregation(timeRange),
					window.maestro.stats.getDatabaseSize(),
					cueTabEnabled
						? window.maestro.cueStats.getAggregation(timeRange).catch((err) => {
								logger.warn('Failed to fetch Cue totals for source chart:', undefined, err);
								return null;
							})
						: Promise.resolve(null),
				]);
				setData(stats);
				setDatabaseSize(dbSize);
				setCueSourceTotals(
					cueAgg
						? {
								occurrences: cueAgg.totals.occurrences,
								totalDurationMs: cueAgg.totals.totalDurationMs,
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
		loading,
		error,
		showNewDataIndicator,
		databaseSize,
		fetchStats,
	};
}
