/**
 * useStats Hook
 *
 * Custom hook for managing stats data for the Usage Dashboard.
 * Handles fetching aggregated stats via window.maestro.stats.getAggregation(),
 * real-time updates subscription via window.maestro.stats.onStatsUpdate(),
 * and 1-second debounce on updates to prevent excessive re-renders.
 *
 * Features:
 * - Loading and error states
 * - Automatic data fetching on range change
 * - Real-time subscription with cleanup
 * - Debounced updates to prevent UI thrashing
 * - Memoized return value for stable references
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

// Stats time range type matching the backend API
export type StatsTimeRange = 'day' | 'week' | 'month' | 'year' | 'all';

// Aggregation data shape from the stats API
export interface StatsAggregation {
	totalQueries: number;
	totalDuration: number;
	avgDuration: number;
	byAgent: Record<string, { count: number; duration: number }>;
	bySource: { user: number; auto: number };
	byLocation: { local: number; remote: number };
	byDay: Array<{ date: string; count: number; duration: number }>;
	byHour: Array<{ hour: number; count: number; duration: number }>;
	// Session lifecycle stats
	totalSessions: number;
	sessionsByAgent: Record<string, number>;
	sessionsByDay: Array<{ date: string; count: number }>;
	avgSessionDuration: number;
	// Per-agent per-day breakdown for provider usage chart
	byAgentByDay: Record<string, Array<{ date: string; count: number; duration: number }>>;
}

// Return type for the useStats hook
export interface UseStatsReturn {
	/** Aggregated stats data, null if not yet loaded */
	data: StatsAggregation | null;
	/** Loading state for initial fetch */
	loading: boolean;
	/** Error message if fetch failed */
	error: string | null;
	/** Manually trigger a data refresh */
	refresh: () => Promise<void>;
	/** Whether a manual refresh is in progress */
	refreshing: boolean;
}

/**
 * Simple debounce implementation for real-time updates
 */
function debounce<T extends (...args: unknown[]) => unknown>(
	fn: T,
	delay: number
): (...args: Parameters<T>) => void {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	return (...args: Parameters<T>) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			fn(...args);
			timeoutId = null;
		}, delay);
	};
}

/**
 * Hook for fetching and managing stats data for the Usage Dashboard.
 *
 * @param range - Time range for stats aggregation
 * @param enabled - Whether to fetch stats (useful for modal open state)
 * @returns Object containing data, loading, error states and refresh function
 *
 * @example
 * ```tsx
 * const { data, loading, error, refresh } = useStats('week');
 *
 * if (loading) return <Spinner />;
 * if (error) return <Error message={error} />;
 * if (!data) return <EmptyState />;
 *
 * return <Dashboard data={data} onRefresh={refresh} />;
 * ```
 */
export function useStats(range: StatsTimeRange, enabled: boolean = true): UseStatsReturn {
	const [data, setData] = useState<StatsAggregation | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	// Use ref to track mounted state
	const mountedRef = useRef(true);

	// Core fetch function
	const fetchStats = useCallback(
		async (isRefresh = false) => {
			if (!enabled) return;

			if (isRefresh) {
				setRefreshing(true);
			} else {
				setLoading(true);
			}
			setError(null);

			try {
				const stats = await window.maestro.stats.getAggregation(range);
				if (mountedRef.current) {
					setData(stats);
				}
			} catch (err) {
				console.error('Failed to fetch usage stats:', err);
				if (mountedRef.current) {
					setError(err instanceof Error ? err.message : 'Failed to load stats');
				}
			} finally {
				if (mountedRef.current) {
					setLoading(false);
					if (isRefresh) {
						// Keep refresh spinner visible briefly for visual feedback
						setTimeout(() => {
							if (mountedRef.current) {
								setRefreshing(false);
							}
						}, 300);
					}
				}
			}
		},
		[range, enabled]
	);

	// Manual refresh function
	const refresh = useCallback(async () => {
		await fetchStats(true);
	}, [fetchStats]);

	// Use refs to ensure debounce works correctly across re-renders
	const fetchStatsRef = useRef(fetchStats);
	fetchStatsRef.current = fetchStats;

	// Create stable debounced function once
	const debouncedFetchRef = useRef<(() => void) | null>(null);
	if (!debouncedFetchRef.current) {
		debouncedFetchRef.current = debounce(() => {
			fetchStatsRef.current(true);
		}, 1000);
	}

	// Initial fetch and real-time updates subscription
	useEffect(() => {
		mountedRef.current = true;

		if (!enabled) {
			return;
		}

		// Initial fetch
		fetchStats();

		// Subscribe to stats updates with stable debounced function
		const unsubscribe = window.maestro.stats.onStatsUpdate(debouncedFetchRef.current!);

		return () => {
			mountedRef.current = false;
			unsubscribe();
		};
	}, [enabled, fetchStats]);

	// Memoize return value for stable reference
	return useMemo(
		() => ({
			data,
			loading,
			error,
			refresh,
			refreshing,
		}),
		[data, loading, error, refresh, refreshing]
	);
}

/**
 * Derived computed values from stats data.
 * These are expensive calculations that benefit from memoization.
 */
export interface ComputedStats {
	/** Agent with highest query count, or null if no data */
	mostActiveAgent: [string, { count: number; duration: number }] | null;
	/** Percentage of interactive queries (vs auto), formatted as "XX%" */
	interactiveVsAutoRatio: string;
	/** Total query count across all sources */
	totalSources: number;
	/** Whether there's any data to display */
	hasData: boolean;
}

/**
 * Hook for computing derived stats values with memoization.
 *
 * @param data - Raw stats aggregation data
 * @returns Computed/derived values
 */
export function useComputedStats(data: StatsAggregation | null): ComputedStats {
	return useMemo(() => {
		if (!data) {
			return {
				mostActiveAgent: null,
				interactiveVsAutoRatio: 'N/A',
				totalSources: 0,
				hasData: false,
			};
		}

		// Most active agent by query count
		const mostActiveAgent = data.byAgent
			? Object.entries(data.byAgent).sort((a, b) => b[1].count - a[1].count)[0] || null
			: null;

		// Interactive vs Auto ratio
		const totalSources = data.bySource.user + data.bySource.auto;
		const interactiveVsAutoRatio =
			totalSources > 0 ? `${Math.round((data.bySource.user / totalSources) * 100)}%` : 'N/A';

		// Check if there's meaningful data
		const hasData = data.totalQueries > 0 || data.bySource.user > 0 || data.bySource.auto > 0;

		return {
			mostActiveAgent,
			interactiveVsAutoRatio,
			totalSources,
			hasData,
		};
	}, [data]);
}
