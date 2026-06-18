import { useState, useEffect, useMemo } from 'react';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';
import type { AggregateStats } from '../types';

interface UseAgentSessionsAggregateStatsArgs {
	projectRoot: string | undefined;
	projectPathForSessions: string | undefined;
	agentId: string;
	sessions: AgentSession[];
	loading: boolean;
	hasMoreSessions: boolean;
}

const EMPTY_STATS: AggregateStats = {
	totalSessions: 0,
	totalMessages: 0,
	totalCostUsd: 0,
	totalSizeBytes: 0,
	totalTokens: 0,
	oldestTimestamp: null,
	isComplete: false,
};

export function useAgentSessionsAggregateStats({
	projectRoot,
	projectPathForSessions,
	agentId,
	sessions,
	loading,
	hasMoreSessions,
}: UseAgentSessionsAggregateStatsArgs): {
	aggregateStats: AggregateStats;
	stats: {
		totalSessions: number;
		totalMessages: number;
		totalSize: number;
		totalCost: number;
		totalTokens: number;
		oldestSession: Date | null;
		isComplete: boolean;
	};
} {
	const [aggregateStats, setAggregateStats] = useState<AggregateStats>(EMPTY_STATS);

	// Effect 1: reset state when project path or agentId changes
	useEffect(() => {
		setAggregateStats(EMPTY_STATS);
	}, [projectPathForSessions, agentId]);

	// Effect 2 (claude-code only): subscribe to progressive stats updates.
	// IMPORTANT: subscription is keyed on activeSession.projectRoot, NOT projectPathForSessions.
	// For SSH sessions, projectPathForSessions is the remote path, but the IPC backend stores
	// stats by projectRoot (the local path). Using the wrong key silently drops SSH stats.
	useEffect(() => {
		if (!projectRoot) return;
		if (agentId !== 'claude-code') return;

		const unsubscribe = window.maestro.claude.onProjectStatsUpdate((stats) => {
			if (stats.projectPath === projectRoot) {
				setAggregateStats({
					totalSessions: stats.totalSessions,
					totalMessages: stats.totalMessages,
					totalCostUsd: stats.totalCostUsd,
					totalSizeBytes: stats.totalSizeBytes,
					totalTokens: stats.totalTokens ?? 0,
					oldestTimestamp: stats.oldestTimestamp,
					isComplete: stats.isComplete,
				});
			}
		});

		return unsubscribe;
	}, [projectRoot, agentId]);

	// Effect 3 (non-claude only): compute totals from loaded sessions[]
	useEffect(() => {
		if (agentId === 'claude-code') return;
		if (loading) return;

		let totalMessages = 0;
		let totalCostUsd = 0;
		let totalSizeBytes = 0;
		let totalTokens = 0;
		let oldestTimestamp: string | null = null;

		for (const session of sessions) {
			totalMessages += session.messageCount || 0;
			totalCostUsd += session.costUsd || 0;
			totalSizeBytes += session.sizeBytes || 0;
			totalTokens += (session.inputTokens || 0) + (session.outputTokens || 0);
			if (session.timestamp) {
				if (!oldestTimestamp || session.timestamp < oldestTimestamp) {
					oldestTimestamp = session.timestamp;
				}
			}
		}

		setAggregateStats({
			totalSessions: sessions.length,
			totalMessages,
			totalCostUsd,
			totalSizeBytes,
			totalTokens,
			oldestTimestamp,
			isComplete: !hasMoreSessions,
		});
	}, [agentId, sessions, loading, hasMoreSessions]);

	const stats = useMemo(
		() => ({
			totalSessions: aggregateStats.totalSessions,
			totalMessages: aggregateStats.totalMessages,
			totalSize: aggregateStats.totalSizeBytes,
			totalCost: aggregateStats.totalCostUsd,
			totalTokens: aggregateStats.totalTokens,
			oldestSession: aggregateStats.oldestTimestamp
				? new Date(aggregateStats.oldestTimestamp)
				: null,
			isComplete: aggregateStats.isComplete,
		}),
		[aggregateStats]
	);

	return { aggregateStats, stats };
}
