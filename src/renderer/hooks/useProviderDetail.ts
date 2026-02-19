/**
 * useProviderDetail - Detailed data for a single provider's detail view
 *
 * Fetches per-provider usage stats, error breakdown, daily trends, hourly patterns,
 * active sessions, and migration history for the ProviderDetailView component.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session } from '../types';
import type { ToolType, AgentErrorType } from '../../shared/types';
import type { ProviderErrorStats } from '../../shared/account-types';
import type { StatsTimeRange, StatsAggregation, QueryEvent } from '../../shared/stats-types';
import type { ProviderUsageStats } from './useProviderHealth';
import type { HealthStatus } from '../components/ProviderHealthCard';
import { getAgentDisplayName } from '../services/contextGroomer';

// ============================================================================
// Types
// ============================================================================

export interface ProviderDetail {
	toolType: ToolType;
	displayName: string;
	available: boolean;
	status: HealthStatus;

	// Usage stats (for selected time range)
	usage: ProviderUsageStats;

	// Token breakdown (for detail table)
	tokenBreakdown: {
		inputTokens: number;
		inputCostUsd: number;
		outputTokens: number;
		outputCostUsd: number;
		cacheReadTokens: number;
		cacheReadCostUsd: number;
		cacheCreationTokens: number;
		cacheCreationCostUsd: number;
	};

	// Quality / reliability
	reliability: {
		successRate: number;
		errorRate: number;
		totalErrors: number;
		errorsByType: Partial<Record<AgentErrorType, number>>;
		avgResponseTimeMs: number;
		p95ResponseTimeMs: number;
	};

	// Source split
	queriesBySource: { user: number; auto: number };

	// Location split
	queriesByLocation: { local: number; remote: number };

	// Trends (daily data points for charts)
	dailyTrend: Array<{
		date: string;
		queryCount: number;
		durationMs: number;
		avgDurationMs: number;
	}>;

	// Hourly activity pattern (0-23)
	hourlyPattern: Array<{
		hour: number;
		queryCount: number;
		avgDurationMs: number;
	}>;

	// Active sessions using this provider
	activeSessions: Array<{
		id: string;
		name: string;
		projectRoot: string;
		state: string;
	}>;

	// Migration history involving this provider
	migrations: Array<{
		timestamp: number;
		sessionName: string;
		direction: 'from' | 'to';
		otherProvider: ToolType;
		generation: number;
	}>;
}

export interface UseProviderDetailResult {
	detail: ProviderDetail | null;
	isLoading: boolean;
	refresh: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

const EMPTY_USAGE: ProviderUsageStats = {
	queryCount: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: 0,
	totalDurationMs: 0,
	avgDurationMs: 0,
};

function computeP95(durations: number[]): number {
	if (durations.length === 0) return 0;
	const sorted = [...durations].sort((a, b) => a - b);
	const index = Math.floor(sorted.length * 0.95);
	return sorted[Math.min(index, sorted.length - 1)];
}

// Rough cost estimation per token type (Claude Code default pricing)
// These are approximations — actual costs vary by model
const INPUT_COST_PER_TOKEN = 0.000003;
const OUTPUT_COST_PER_TOKEN = 0.000015;
const CACHE_READ_COST_PER_TOKEN = 0.0000003;
const CACHE_CREATION_COST_PER_TOKEN = 0.00000375;

function estimateTokenCosts(tokens: {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	totalCost: number;
}): { inputCost: number; outputCost: number; cacheReadCost: number; cacheCreationCost: number } {
	// If we have a total cost, distribute proportionally based on token counts
	const rawInput = tokens.input * INPUT_COST_PER_TOKEN;
	const rawOutput = tokens.output * OUTPUT_COST_PER_TOKEN;
	const rawCacheRead = tokens.cacheRead * CACHE_READ_COST_PER_TOKEN;
	const rawCacheCreation = tokens.cacheCreation * CACHE_CREATION_COST_PER_TOKEN;
	const rawTotal = rawInput + rawOutput + rawCacheRead + rawCacheCreation;

	if (rawTotal === 0 || tokens.totalCost === 0) {
		return { inputCost: rawInput, outputCost: rawOutput, cacheReadCost: rawCacheRead, cacheCreationCost: rawCacheCreation };
	}

	// Scale to match actual total cost
	const scale = tokens.totalCost / rawTotal;
	return {
		inputCost: rawInput * scale,
		outputCost: rawOutput * scale,
		cacheReadCost: rawCacheRead * scale,
		cacheCreationCost: rawCacheCreation * scale,
	};
}

// ============================================================================
// Hook
// ============================================================================

export function useProviderDetail(
	toolType: ToolType,
	sessions: Session[],
	timeRange: StatsTimeRange,
): UseProviderDetailResult {
	const [detail, setDetail] = useState<ProviderDetail | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const mountedRef = useRef(true);
	const timeRangeRef = useRef(timeRange);
	timeRangeRef.current = timeRange;

	const refresh = useCallback(async () => {
		try {
			// Fetch all data in parallel
			const [agents, errorStats, queryEvents, aggregation] = await Promise.all([
				window.maestro.agents.detect() as Promise<Array<{ id: string; available: boolean }>>,
				window.maestro.providers.getErrorStats(toolType) as Promise<ProviderErrorStats | null>,
				window.maestro.stats.getStats(timeRangeRef.current, { agentType: toolType }) as Promise<Array<{
					id: string;
					sessionId: string;
					agentType: string;
					source: 'user' | 'auto';
					startTime: number;
					duration: number;
					projectPath?: string;
					isRemote?: boolean;
					inputTokens?: number;
					outputTokens?: number;
					cacheReadTokens?: number;
					cacheCreationTokens?: number;
					costUsd?: number;
				}>>,
				window.maestro.stats.getAggregation(timeRangeRef.current) as Promise<StatsAggregation>,
			]);

			if (!mountedRef.current) return;

			const agent = agents.find((a) => a.id === toolType);
			const available = agent?.available ?? false;

			// Aggregate usage stats
			const usage: ProviderUsageStats = { ...EMPTY_USAGE };
			const durations: number[] = [];
			let userQueries = 0;
			let autoQueries = 0;
			let localQueries = 0;
			let remoteQueries = 0;

			for (const e of queryEvents) {
				usage.queryCount += 1;
				usage.totalInputTokens += (e as any).inputTokens ?? 0;
				usage.totalOutputTokens += (e as any).outputTokens ?? 0;
				usage.totalCacheReadTokens += (e as any).cacheReadTokens ?? 0;
				usage.totalCacheCreationTokens += (e as any).cacheCreationTokens ?? 0;
				usage.totalCostUsd += (e as any).costUsd ?? 0;
				usage.totalDurationMs += e.duration ?? 0;
				if (e.duration > 0) durations.push(e.duration);
				if (e.source === 'user') userQueries++;
				else autoQueries++;
				if ((e as any).isRemote) remoteQueries++;
				else localQueries++;
			}
			usage.avgDurationMs = usage.queryCount > 0
				? Math.round(usage.totalDurationMs / usage.queryCount)
				: 0;

			// Token cost breakdown
			const costs = estimateTokenCosts({
				input: usage.totalInputTokens,
				output: usage.totalOutputTokens,
				cacheRead: usage.totalCacheReadTokens,
				cacheCreation: usage.totalCacheCreationTokens,
				totalCost: usage.totalCostUsd,
			});

			// Error stats
			const errorCount = errorStats?.totalErrorsInWindow ?? 0;
			const totalQueries = usage.queryCount;
			const successRate = totalQueries > 0
				? ((totalQueries - errorCount) / totalQueries) * 100
				: 0;
			const errorRate = totalQueries > 0
				? (errorCount / totalQueries) * 100
				: 0;

			// Determine status
			let status: HealthStatus;
			const activeCount = sessions.filter(
				(s) => s.toolType === toolType && !s.archivedByMigration,
			).length;
			if (!available) {
				status = 'not_installed';
			} else if (activeCount === 0) {
				status = 'idle';
			} else if (errorCount === 0) {
				status = 'healthy';
			} else if (errorCount >= 3) { // Use default threshold
				status = 'failing';
			} else {
				status = 'degraded';
			}

			// Daily trend from aggregation
			const dailyData = aggregation.byAgentByDay?.[toolType] ?? [];
			const dailyTrend = dailyData.map((d) => ({
				date: d.date,
				queryCount: d.count,
				durationMs: d.duration,
				avgDurationMs: d.count > 0 ? Math.round(d.duration / d.count) : 0,
			}));

			// Hourly pattern — filter aggregation.byHour by this provider's events
			// Since byHour doesn't include per-agent breakdown, compute from raw events
			const hourlyMap = new Map<number, { count: number; totalDuration: number }>();
			for (let h = 0; h < 24; h++) {
				hourlyMap.set(h, { count: 0, totalDuration: 0 });
			}
			for (const e of queryEvents) {
				const hour = new Date(e.startTime).getHours();
				const entry = hourlyMap.get(hour)!;
				entry.count += 1;
				entry.totalDuration += e.duration ?? 0;
			}
			const hourlyPattern = Array.from(hourlyMap.entries()).map(([hour, data]) => ({
				hour,
				queryCount: data.count,
				avgDurationMs: data.count > 0 ? Math.round(data.totalDuration / data.count) : 0,
			}));

			// Active sessions
			const activeSessions = sessions
				.filter((s) => s.toolType === toolType && !s.archivedByMigration)
				.map((s) => ({
					id: s.id,
					name: s.name || 'Unnamed Agent',
					projectRoot: s.projectRoot,
					state: s.state,
				}));

			// Migration history involving this provider
			const migrations: ProviderDetail['migrations'] = [];
			for (const s of sessions) {
				if (s.migratedFromSessionId && s.migratedAt) {
					const source = sessions.find((src) => src.id === s.migratedFromSessionId);
					if (source) {
						const sourceType = source.toolType as ToolType;
						const targetType = s.toolType as ToolType;
						if (sourceType === toolType) {
							migrations.push({
								timestamp: s.migratedAt,
								sessionName: s.name || 'Unnamed Agent',
								direction: 'from',
								otherProvider: targetType,
								generation: s.migrationGeneration || 1,
							});
						} else if (targetType === toolType) {
							migrations.push({
								timestamp: s.migratedAt,
								sessionName: s.name || 'Unnamed Agent',
								direction: 'to',
								otherProvider: sourceType,
								generation: s.migrationGeneration || 1,
							});
						}
					}
				}
			}
			migrations.sort((a, b) => b.timestamp - a.timestamp);

			// P95 response time
			const p95 = durations.length >= 20
				? computeP95(durations)
				: usage.avgDurationMs;

			const result: ProviderDetail = {
				toolType,
				displayName: getAgentDisplayName(toolType),
				available,
				status,
				usage,
				tokenBreakdown: {
					inputTokens: usage.totalInputTokens,
					inputCostUsd: costs.inputCost,
					outputTokens: usage.totalOutputTokens,
					outputCostUsd: costs.outputCost,
					cacheReadTokens: usage.totalCacheReadTokens,
					cacheReadCostUsd: costs.cacheReadCost,
					cacheCreationTokens: usage.totalCacheCreationTokens,
					cacheCreationCostUsd: costs.cacheCreationCost,
				},
				reliability: {
					successRate,
					errorRate,
					totalErrors: errorCount,
					errorsByType: {},
					avgResponseTimeMs: usage.avgDurationMs,
					p95ResponseTimeMs: p95,
				},
				queriesBySource: { user: userQueries, auto: autoQueries },
				queriesByLocation: { local: localQueries, remote: remoteQueries },
				dailyTrend,
				hourlyPattern,
				activeSessions,
				migrations,
			};

			setDetail(result);
			setIsLoading(false);
		} catch (err) {
			console.warn('[useProviderDetail] Failed to refresh:', err);
			if (mountedRef.current) {
				setIsLoading(false);
			}
		}
	}, [toolType, sessions]);

	useEffect(() => {
		mountedRef.current = true;
		setIsLoading(true);
		refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);

	// Re-fetch when time range changes
	useEffect(() => {
		refresh();
	}, [timeRange]); // eslint-disable-line react-hooks/exhaustive-deps

	return { detail, isLoading, refresh };
}
