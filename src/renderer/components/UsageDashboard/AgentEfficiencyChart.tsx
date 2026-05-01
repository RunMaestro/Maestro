/**
 * AgentEfficiencyChart
 *
 * Displays efficiency metrics for each agent type using data from stats.
 * Shows average duration per query for each agent, allowing comparison
 * of which agents respond faster on average.
 *
 * Features:
 * - Horizontal bar chart showing avg duration per query
 * - Color-coded by agent
 * - Sorted by efficiency (fastest first)
 * - Colorblind-friendly palette option
 */

import { memo, useMemo } from 'react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { formatDurationHuman as formatDuration } from '../../../shared/formatters';
import { findSessionByStatId, isWorktreeAgent, buildNameMap } from './chartUtils';

interface AgentEfficiencyChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/** Current sessions list — when provided, agents are labeled with their
	 * user-assigned session names and worktree agents render with a striped pattern. */
	sessions?: Session[];
	/** Active drill-down filter key — when set, non-matching entries dim to 0.3 opacity. */
	activeFilterKey?: string | null;
}

/**
 * Get color for an agent
 */
function getAgentColor(index: number, theme: Theme, colorBlindMode?: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	if (index === 0) {
		return theme.colors.accent;
	}
	const additionalColors = [
		'#10b981',
		'#8b5cf6',
		'#ef4444',
		'#06b6d4',
		'#ec4899',
		'#f59e0b',
		'#84cc16',
		'#6366f1',
	];
	return additionalColors[(index - 1) % additionalColors.length];
}

export const AgentEfficiencyChart = memo(function AgentEfficiencyChart({
	data,
	theme,
	colorBlindMode = false,
	sessions,
	activeFilterKey = null,
}: AgentEfficiencyChartProps) {
	// Compute per-(provider, worktree-status) aggregation when sessions are
	// available and at least one worktree session is found. Returns null
	// otherwise so the chart falls back to the legacy by-provider view.
	const splitAggregation = useMemo((): Record<
		string,
		{ regular: { count: number; duration: number }; worktree: { count: number; duration: number } }
	> | null => {
		const bySessionByDay = data.bySessionByDay;
		if (!sessions || sessions.length === 0) return null;
		if (!bySessionByDay || Object.keys(bySessionByDay).length === 0) return null;

		const result: Record<
			string,
			{
				regular: { count: number; duration: number };
				worktree: { count: number; duration: number };
			}
		> = {};
		let foundWorktree = false;

		for (const [statSessionId, days] of Object.entries(bySessionByDay)) {
			const session = findSessionByStatId(statSessionId, sessions);
			if (!session) continue;
			const provider = session.toolType;
			const isWt = isWorktreeAgent(session);
			if (isWt) foundWorktree = true;

			if (!result[provider]) {
				result[provider] = {
					regular: { count: 0, duration: 0 },
					worktree: { count: 0, duration: 0 },
				};
			}
			const bucket = isWt ? result[provider].worktree : result[provider].regular;
			for (const day of days) {
				bucket.count += day.count;
				bucket.duration += day.duration;
			}
		}

		if (!foundWorktree) return null;

		// Backfill historical totals for providers whose stat sessions no longer
		// resolve. Without this, deleted/closed agents drop out of the chart
		// entirely once worktree splitting kicks in. The remainder lands in the
		// regular bucket since we can't infer worktree status without the live
		// session.
		for (const [provider, agentTotals] of Object.entries(data.byAgent)) {
			if (!result[provider]) {
				result[provider] = {
					regular: { count: 0, duration: 0 },
					worktree: { count: 0, duration: 0 },
				};
			}
			const reconstructedCount = result[provider].regular.count + result[provider].worktree.count;
			const reconstructedDuration =
				result[provider].regular.duration + result[provider].worktree.duration;
			const missingCount = Math.max(0, agentTotals.count - reconstructedCount);
			const missingDuration = Math.max(0, agentTotals.duration - reconstructedDuration);
			if (missingCount > 0 || missingDuration > 0) {
				result[provider].regular.count += missingCount;
				result[provider].regular.duration += missingDuration;
			}
		}

		return result;
	}, [data.bySessionByDay, data.byAgent, sessions]);

	// Calculate efficiency data (avg duration per query) for each agent
	const efficiencyData = useMemo(() => {
		type Entry = {
			key: string;
			label: string;
			agent: string;
			avgDuration: number;
			totalQueries: number;
			totalDuration: number;
			isWorktree: boolean;
		};

		const entries: Entry[] = [];

		// Resolve raw provider keys (e.g. "claude-code") to user-facing names
		// (e.g. the user's "Backend API" session name, or the prettified
		// "Claude Code" fallback). Built from the union of byAgent and the split
		// aggregation so both rendering paths get coherent labels.
		const providerKeys = Array.from(
			new Set([
				...Object.keys(data.byAgent),
				...(splitAggregation ? Object.keys(splitAggregation) : []),
			])
		);
		const nameMap = buildNameMap(providerKeys, sessions);

		if (splitAggregation) {
			for (const [provider, buckets] of Object.entries(splitAggregation)) {
				const baseLabel = nameMap.get(provider)?.name ?? provider;
				if (buckets.regular.count > 0) {
					entries.push({
						key: provider,
						label: baseLabel,
						agent: provider,
						avgDuration: buckets.regular.duration / buckets.regular.count,
						totalQueries: buckets.regular.count,
						totalDuration: buckets.regular.duration,
						isWorktree: false,
					});
				}
				if (buckets.worktree.count > 0) {
					entries.push({
						key: `${provider}__worktree`,
						label: `${baseLabel} (Worktree)`,
						agent: provider,
						avgDuration: buckets.worktree.duration / buckets.worktree.count,
						totalQueries: buckets.worktree.count,
						totalDuration: buckets.worktree.duration,
						isWorktree: true,
					});
				}
			}
		} else {
			for (const [agent, stats] of Object.entries(data.byAgent)) {
				if (stats.count <= 0) continue;
				const resolved = nameMap.get(agent);
				entries.push({
					key: agent,
					label: resolved?.name ?? agent,
					agent,
					avgDuration: stats.duration / stats.count,
					totalQueries: stats.count,
					totalDuration: stats.duration,
					isWorktree: resolved?.isWorktree ?? false,
				});
			}
		}

		return entries.sort((a, b) => a.avgDuration - b.avgDuration); // Fastest first
	}, [data.byAgent, splitAggregation, sessions]);

	const hasWorktreeBars = useMemo(() => efficiencyData.some((e) => e.isWorktree), [efficiencyData]);

	// Get max duration for bar scaling
	const maxDuration = useMemo(() => {
		if (efficiencyData.length === 0) return 0;
		return Math.max(...efficiencyData.map((a) => a.avgDuration));
	}, [efficiencyData]);

	if (efficiencyData.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Agent Efficiency
				</h3>
				<div
					className="flex items-center justify-center h-24"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No agent query data available</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="agent-efficiency-chart"
		>
			<h3
				className="text-sm font-medium mb-4"
				style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
			>
				Agent Efficiency
				<span className="text-xs font-normal ml-2" style={{ color: theme.colors.textDim }}>
					(avg response time per query)
				</span>
			</h3>

			<div className="space-y-3">
				{(() => {
					// Assign colors per unique provider so the regular and worktree
					// variants of the same provider share a color.
					const providerColorIdx: Record<string, number> = {};
					for (const entry of efficiencyData) {
						if (!(entry.agent in providerColorIdx)) {
							providerColorIdx[entry.agent] = Object.keys(providerColorIdx).length;
						}
					}
					return efficiencyData.map((agent) => {
						const percentage = maxDuration > 0 ? (agent.avgDuration / maxDuration) * 100 : 0;
						const color = getAgentColor(providerColorIdx[agent.agent], theme, colorBlindMode);
						const isDimmed = activeFilterKey !== null && activeFilterKey !== agent.key;

						return (
							<div
								key={agent.key}
								className="flex items-center gap-3"
								style={{
									opacity: isDimmed ? 0.3 : 1,
									transition: 'opacity 0.15s ease',
								}}
							>
								{/* Agent name */}
								<div
									className="w-28 text-sm truncate flex-shrink-0 flex items-center gap-2"
									style={{ color: theme.colors.textDim }}
									title={agent.label}
								>
									<div
										className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
										style={{
											backgroundColor: color,
											opacity: agent.isWorktree ? 0.55 : 1,
											backgroundImage: agent.isWorktree
												? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 4px)'
												: undefined,
										}}
									/>
									{agent.label}
								</div>

								{/* Bar */}
								<div
									className="flex-1 h-6 rounded overflow-hidden"
									style={{ backgroundColor: `${theme.colors.border}30` }}
								>
									<div
										className="h-full rounded flex items-center justify-end"
										style={{
											width: `${Math.max(percentage, 8)}%`,
											backgroundColor: color,
											opacity: agent.isWorktree ? 0.55 : 0.85,
											backgroundImage: agent.isWorktree
												? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)'
												: undefined,
											transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
										}}
									>
										{percentage > 25 && (
											<span
												className="text-xs font-medium px-2 text-white whitespace-nowrap"
												style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
											>
												{formatDuration(agent.avgDuration)}
											</span>
										)}
									</div>
								</div>

								{/* Duration label */}
								<div
									className="w-20 text-xs text-right flex-shrink-0 flex flex-col"
									style={{ color: theme.colors.textDim }}
								>
									<span className="font-medium" style={{ color: theme.colors.textMain }}>
										{formatDuration(agent.avgDuration)}
									</span>
									<span className="text-[10px] opacity-70">{agent.totalQueries} queries</span>
								</div>
							</div>
						);
					});
				})()}
			</div>

			{/* Legend */}
			<div
				className="mt-4 pt-3 border-t text-xs flex items-center gap-4 flex-wrap"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<span>Sorted by efficiency (fastest first)</span>
				{hasWorktreeBars && (
					<>
						<div className="flex items-center gap-1.5">
							<div
								className="w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: theme.colors.textDim, opacity: 0.85 }}
							/>
							<span>Agent</span>
						</div>
						<div className="flex items-center gap-1.5">
							<div
								className="w-2.5 h-2.5 rounded-sm"
								style={{
									backgroundColor: theme.colors.textDim,
									opacity: 0.55,
									backgroundImage:
										'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 4px)',
								}}
							/>
							<span>Worktree Agent</span>
						</div>
					</>
				)}
			</div>
		</div>
	);
});

export default AgentEfficiencyChart;
