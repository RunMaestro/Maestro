/**
 * useProviderHealth - Live provider health data with auto-refresh
 *
 * Combines agent detection, error stats, usage stats, and session counts into
 * per-provider health data. Polls on an interval and refreshes
 * immediately on failover suggestions and new query events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session, AgentConfig } from '../types';
import type { ToolType } from '../../shared/types';
import type { ProviderErrorStats, ProviderSwitchConfig } from '../../shared/account-types';
import type { StatsTimeRange } from '../../shared/stats-types';
import { DEFAULT_PROVIDER_SWITCH_CONFIG } from '../../shared/account-types';
import { getAgentDisplayName } from '../services/contextGroomer';
import type { HealthStatus } from '../components/ProviderHealthCard';

// ============================================================================
// Types
// ============================================================================

export interface ProviderUsageStats {
	queryCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	totalDurationMs: number;
	avgDurationMs: number;
}

const EMPTY_USAGE_STATS: ProviderUsageStats = {
	queryCount: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: 0,
	totalDurationMs: 0,
	avgDurationMs: 0,
};

export interface ProviderHealth {
	toolType: ToolType;
	available: boolean;
	displayName: string;
	activeSessionCount: number;
	errorStats: ProviderErrorStats | null;
	usageStats: ProviderUsageStats;
	healthPercent: number;
	status: HealthStatus;
}

export interface UsageTotals {
	queryCount: number;
	totalTokens: number;
	totalCostUsd: number;
}

export interface UseProviderHealthResult {
	providers: ProviderHealth[];
	isLoading: boolean;
	lastUpdated: number | null;
	timeRange: StatsTimeRange;
	setTimeRange: (range: StatsTimeRange) => void;
	refresh: () => void;
	failoverThreshold: number;
	hasDegradedProvider: boolean;
	hasFailingProvider: boolean;
	totals: UsageTotals;
}

// ============================================================================
// Helpers
// ============================================================================

function computeHealthPercent(
	available: boolean,
	activeSessionCount: number,
	errorCount: number,
	threshold: number,
): number {
	if (!available) return 0;
	if (activeSessionCount === 0) return 100;
	if (errorCount === 0) return 100;
	return Math.max(0, Math.round(100 - (errorCount / threshold) * 100));
}

function computeStatus(
	available: boolean,
	activeSessionCount: number,
	errorCount: number,
	threshold: number,
): HealthStatus {
	if (!available) return 'not_installed';
	if (activeSessionCount === 0) return 'idle';
	if (errorCount === 0) return 'healthy';
	if (errorCount >= threshold) return 'failing';
	return 'degraded';
}

// ============================================================================
// Hook
// ============================================================================

const DEFAULT_REFRESH_INTERVAL = 10_000;

/** Aggregate raw query events into per-provider usage stats */
function aggregateUsageByProvider(
	events: Array<{ agentType: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; costUsd?: number; duration?: number }>,
): Record<string, ProviderUsageStats> {
	const byProvider: Record<string, ProviderUsageStats> = {};

	for (const e of events) {
		if (!byProvider[e.agentType]) {
			byProvider[e.agentType] = { ...EMPTY_USAGE_STATS };
		}
		const acc = byProvider[e.agentType];
		acc.queryCount += 1;
		acc.totalInputTokens += e.inputTokens ?? 0;
		acc.totalOutputTokens += e.outputTokens ?? 0;
		acc.totalCacheReadTokens += e.cacheReadTokens ?? 0;
		acc.totalCacheCreationTokens += e.cacheCreationTokens ?? 0;
		acc.totalCostUsd += e.costUsd ?? 0;
		acc.totalDurationMs += e.duration ?? 0;
	}

	// Compute averages
	for (const stats of Object.values(byProvider)) {
		stats.avgDurationMs = stats.queryCount > 0
			? Math.round(stats.totalDurationMs / stats.queryCount)
			: 0;
	}

	return byProvider;
}

export function useProviderHealth(
	sessions: Session[] | undefined,
	refreshIntervalMs: number = DEFAULT_REFRESH_INTERVAL,
): UseProviderHealthResult {
	const [providers, setProviders] = useState<ProviderHealth[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [lastUpdated, setLastUpdated] = useState<number | null>(null);
	const [timeRange, setTimeRange] = useState<StatsTimeRange>('day');
	const [totals, setTotals] = useState<UsageTotals>({ queryCount: 0, totalTokens: 0, totalCostUsd: 0 });
	const [failoverThreshold, setFailoverThreshold] = useState(
		DEFAULT_PROVIDER_SWITCH_CONFIG.errorThreshold,
	);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const timeRangeRef = useRef(timeRange);
	timeRangeRef.current = timeRange;

	const refresh = useCallback(async () => {
		try {
			// Fetch availability, error stats, failover config, and usage stats in parallel
			const [agents, errorStatsRecord, savedConfig, queryEvents] = await Promise.all([
				window.maestro.agents.detect() as Promise<AgentConfig[]>,
				window.maestro.providers.getAllErrorStats() as Promise<Record<string, ProviderErrorStats>>,
				window.maestro.settings.get('providerSwitchConfig') as Promise<Partial<ProviderSwitchConfig> | null>,
				window.maestro.stats.getStats(timeRangeRef.current) as Promise<Array<{
					agentType: string;
					inputTokens?: number;
					outputTokens?: number;
					cacheReadTokens?: number;
					cacheCreationTokens?: number;
					costUsd?: number;
					duration?: number;
				}>>,
			]);

			const threshold = (savedConfig as Partial<ProviderSwitchConfig>)?.errorThreshold
				?? DEFAULT_PROVIDER_SWITCH_CONFIG.errorThreshold;
			setFailoverThreshold(threshold);

			const usageByProvider = aggregateUsageByProvider(queryEvents);

			// Compute totals across all providers
			let totalQueries = 0;
			let totalTokens = 0;
			let totalCost = 0;
			for (const stats of Object.values(usageByProvider)) {
				totalQueries += stats.queryCount;
				totalTokens += stats.totalInputTokens + stats.totalOutputTokens;
				totalCost += stats.totalCostUsd;
			}
			setTotals({ queryCount: totalQueries, totalTokens, totalCostUsd: totalCost });

			const sessionList = sessions ?? [];

			const healthData: ProviderHealth[] = agents
				.filter((a) => a.id !== 'terminal' && !a.hidden)
				.map((agent) => {
					const toolType = agent.id as ToolType;
					const activeCount = sessionList.filter(
						(s) => s.toolType === toolType && !s.archivedByMigration,
					).length;
					const errorStats = errorStatsRecord[toolType] ?? null;
					const errorCount = errorStats?.totalErrorsInWindow ?? 0;

					const healthPercent = computeHealthPercent(
						agent.available,
						activeCount,
						errorCount,
						threshold,
					);
					const status = computeStatus(
						agent.available,
						activeCount,
						errorCount,
						threshold,
					);

					return {
						toolType,
						available: agent.available,
						displayName: getAgentDisplayName(toolType),
						activeSessionCount: activeCount,
						errorStats,
						usageStats: usageByProvider[toolType] ?? { ...EMPTY_USAGE_STATS },
						healthPercent,
						status,
					};
				});

			setProviders(healthData);
			setLastUpdated(Date.now());
			setIsLoading(false);
		} catch (err) {
			console.warn('[useProviderHealth] Failed to refresh:', err);
			setIsLoading(false);
		}
	}, [sessions]);

	// Initial fetch + polling interval
	useEffect(() => {
		refresh();

		intervalRef.current = setInterval(refresh, refreshIntervalMs);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [refresh, refreshIntervalMs]);

	// Re-fetch when time range changes
	useEffect(() => {
		refresh();
	}, [timeRange]); // eslint-disable-line react-hooks/exhaustive-deps

	// Subscribe to failover suggestions for immediate refresh (Task 4)
	useEffect(() => {
		const cleanups: (() => void)[] = [];

		const c1 = window.maestro.providers?.onFailoverSuggest?.(() => refresh());
		if (c1) cleanups.push(c1);

		const c2 = window.maestro.stats?.onStatsUpdate?.(() => refresh());
		if (c2) cleanups.push(c2);

		return () => cleanups.forEach((fn) => fn());
	}, [refresh]);

	const hasDegradedProvider = providers.some(
		(p) => p.status === 'degraded' || p.status === 'failing',
	);
	const hasFailingProvider = providers.some((p) => p.status === 'failing');

	return {
		providers,
		isLoading,
		lastUpdated,
		timeRange,
		setTimeRange,
		refresh,
		failoverThreshold,
		hasDegradedProvider,
		hasFailingProvider,
		totals,
	};
}
