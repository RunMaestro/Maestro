/**
 * useProviderHealth - Live provider health data with auto-refresh
 *
 * Combines agent detection, error stats, and session counts into
 * per-provider health data. Polls on an interval and refreshes
 * immediately on failover suggestions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session, AgentConfig } from '../types';
import type { ToolType } from '../../shared/types';
import type { ProviderErrorStats, ProviderSwitchConfig } from '../../shared/account-types';
import { DEFAULT_PROVIDER_SWITCH_CONFIG } from '../../shared/account-types';
import { getAgentDisplayName } from '../services/contextGroomer';
import type { HealthStatus } from '../components/ProviderHealthCard';

// ============================================================================
// Types
// ============================================================================

export interface ProviderHealth {
	toolType: ToolType;
	available: boolean;
	displayName: string;
	activeSessionCount: number;
	errorStats: ProviderErrorStats | null;
	healthPercent: number;
	status: HealthStatus;
}

export interface UseProviderHealthResult {
	providers: ProviderHealth[];
	isLoading: boolean;
	lastUpdated: number | null;
	refresh: () => void;
	failoverThreshold: number;
	hasDegradedProvider: boolean;
	hasFailingProvider: boolean;
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

export function useProviderHealth(
	sessions: Session[] | undefined,
	refreshIntervalMs: number = DEFAULT_REFRESH_INTERVAL,
): UseProviderHealthResult {
	const [providers, setProviders] = useState<ProviderHealth[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [lastUpdated, setLastUpdated] = useState<number | null>(null);
	const [failoverThreshold, setFailoverThreshold] = useState(
		DEFAULT_PROVIDER_SWITCH_CONFIG.errorThreshold,
	);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const refresh = useCallback(async () => {
		try {
			// Fetch availability, error stats, and failover config in parallel
			const [agents, errorStatsRecord, savedConfig] = await Promise.all([
				window.maestro.agents.detect() as Promise<AgentConfig[]>,
				window.maestro.providers.getAllErrorStats() as Promise<Record<string, ProviderErrorStats>>,
				window.maestro.settings.get('providerSwitchConfig') as Promise<Partial<ProviderSwitchConfig> | null>,
			]);

			const threshold = (savedConfig as Partial<ProviderSwitchConfig>)?.errorThreshold
				?? DEFAULT_PROVIDER_SWITCH_CONFIG.errorThreshold;
			setFailoverThreshold(threshold);

			const sessionList = sessions ?? [];

			const healthData: ProviderHealth[] = agents
				.filter((a) => a.id !== 'terminal' && !a.hidden)
				.map((agent) => {
					const toolType = agent.id as ToolType;
					const activeCount = sessionList.filter(
						(s) => s.toolType === toolType && !s.archivedByMigration,
					).length;
					const stats = errorStatsRecord[toolType] ?? null;
					const errorCount = stats?.totalErrorsInWindow ?? 0;

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
						errorStats: stats,
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

	// Subscribe to failover suggestions for immediate refresh (Task 4)
	useEffect(() => {
		const cleanup = window.maestro.providers?.onFailoverSuggest?.(() => {
			refresh();
		});
		return cleanup;
	}, [refresh]);

	const hasDegradedProvider = providers.some(
		(p) => p.status === 'degraded' || p.status === 'failing',
	);
	const hasFailingProvider = providers.some((p) => p.status === 'failing');

	return {
		providers,
		isLoading,
		lastUpdated,
		refresh,
		failoverThreshold,
		hasDegradedProvider,
		hasFailingProvider,
	};
}
