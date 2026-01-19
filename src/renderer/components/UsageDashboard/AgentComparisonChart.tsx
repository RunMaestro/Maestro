/**
 * AgentComparisonChart
 *
 * Horizontal bar chart comparing usage per agent type.
 * Displays both query count and duration for each agent.
 *
 * Features:
 * - Horizontal bar chart with sorted values (descending by duration)
 * - Shows both count and duration for each agent
 * - Distinct colors per agent (derived from theme accent)
 * - Theme-aware axis and label colors
 * - Tooltip on hover with exact values
 */

import React, { useMemo, useCallback, useState } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/useStats';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';

interface AgentData {
	agent: string;
	count: number;
	duration: number;
	durationPercentage: number;
	color: string;
}

interface AgentComparisonChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/**
 * Generate a color for an agent
 * Uses the theme's accent color as primary, with additional colors for multiple agents
 */
function getAgentColor(
	agentName: string,
	index: number,
	theme: Theme,
	colorBlindMode?: boolean
): string {
	// Use colorblind-safe palette when colorblind mode is enabled
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}

	// For the first (primary) agent, use the theme's accent color
	if (index === 0) {
		return theme.colors.accent;
	}

	// For additional agents, use a palette that complements the accent
	const additionalColors = [
		'#10b981', // emerald
		'#8b5cf6', // violet
		'#ef4444', // red
		'#06b6d4', // cyan
		'#ec4899', // pink
		'#f59e0b', // amber
		'#84cc16', // lime
		'#6366f1', // indigo
	];

	return additionalColors[(index - 1) % additionalColors.length];
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format large numbers with K/M suffixes
 */
function formatNumber(num: number): string {
	if (num >= 1000000) {
		return `${(num / 1000000).toFixed(1)}M`;
	}
	if (num >= 1000) {
		return `${(num / 1000).toFixed(1)}K`;
	}
	return num.toString();
}

export function AgentComparisonChart({
	data,
	theme,
	colorBlindMode = false,
}: AgentComparisonChartProps) {
	const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Process and sort agent data
	const agentData = useMemo((): AgentData[] => {
		const entries = Object.entries(data.byAgent);
		if (entries.length === 0) return [];

		// Calculate total duration for percentage
		const totalDuration = entries.reduce((sum, [, stats]) => sum + stats.duration, 0);

		// Map and sort by duration descending
		return entries
			.map(([agent, stats], index) => ({
				agent,
				count: stats.count,
				duration: stats.duration,
				durationPercentage: totalDuration > 0 ? (stats.duration / totalDuration) * 100 : 0,
				color: getAgentColor(agent, index, theme, colorBlindMode),
			}))
			.sort((a, b) => b.duration - a.duration);
	}, [data.byAgent, theme, colorBlindMode]);

	// Get max duration for bar width calculation
	const maxDuration = useMemo(() => {
		if (agentData.length === 0) return 0;
		return Math.max(...agentData.map((d) => d.duration));
	}, [agentData]);

	// Handle mouse events for tooltip
	const handleMouseEnter = useCallback((agent: string, event: React.MouseEvent<HTMLDivElement>) => {
		setHoveredAgent(agent);
		const rect = event.currentTarget.getBoundingClientRect();
		setTooltipPos({
			x: rect.right + 8,
			y: rect.top + rect.height / 2,
		});
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredAgent(null);
		setTooltipPos(null);
	}, []);

	// Get hovered agent data for tooltip
	const hoveredAgentData = useMemo(() => {
		if (!hoveredAgent) return null;
		return agentData.find((d) => d.agent === hoveredAgent) || null;
	}, [hoveredAgent, agentData]);

	// Bar height
	const barHeight = 28;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Provider comparison chart showing query counts and duration by provider type. ${agentData.length} providers displayed.`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Provider Comparison
				</h3>
			</div>

			{/* Chart container */}
			<div className="relative">
				{agentData.length === 0 ? (
					<div
						className="flex items-center justify-center h-32"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-sm">No agent data available</span>
					</div>
				) : (
					<div className="space-y-2" role="list" aria-label="Agent usage data">
						{agentData.map((agent) => {
							const barWidth = maxDuration > 0 ? (agent.duration / maxDuration) * 100 : 0;
							const isHovered = hoveredAgent === agent.agent;

							return (
								<div
									key={agent.agent}
									className="flex items-center gap-3"
									style={{ height: barHeight }}
									onMouseEnter={(e) => handleMouseEnter(agent.agent, e)}
									onMouseLeave={handleMouseLeave}
									role="listitem"
									aria-label={`${agent.agent}: ${agent.count} queries, ${formatDuration(agent.duration)}`}
								>
									{/* Agent name label */}
									<div
										className="w-28 text-sm truncate flex-shrink-0"
										style={{
											color: isHovered ? theme.colors.textMain : theme.colors.textDim,
										}}
										title={agent.agent}
									>
										{agent.agent}
									</div>

									{/* Bar container */}
									<div
										className="flex-1 h-full rounded overflow-hidden relative"
										style={{
											backgroundColor: `${theme.colors.border}30`,
										}}
										role="meter"
										aria-valuenow={agent.durationPercentage}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`${agent.agent} usage percentage`}
									>
										{/* Bar fill */}
										<div
											className="h-full rounded flex items-center"
											style={{
												width: `${Math.max(barWidth, 2)}%`,
												backgroundColor: agent.color,
												opacity: isHovered ? 1 : 0.85,
												transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
											}}
											aria-hidden="true"
										>
											{/* Percentage label inside bar (if bar is wide enough) */}
											{barWidth > 15 && (
												<span
													className="text-xs font-medium px-2 text-white"
													style={{
														textShadow: '0 1px 2px rgba(0,0,0,0.3)',
													}}
												>
													{agent.durationPercentage.toFixed(1)}%
												</span>
											)}
										</div>

										{/* Percentage label outside bar (if bar is too narrow) */}
										{barWidth <= 15 && (
											<span
												className="absolute text-xs font-medium"
												style={{
													left: `calc(${barWidth}% + 4px)`,
													top: '50%',
													transform: 'translateY(-50%)',
													color: theme.colors.textDim,
												}}
											>
												{agent.durationPercentage.toFixed(1)}%
											</span>
										)}
									</div>

									{/* Count and Duration labels */}
									<div
										className="flex items-center gap-3 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									>
										<div className="text-xs text-right whitespace-nowrap" title="Query count">
											{formatNumber(agent.count)} {agent.count === 1 ? 'query' : 'queries'}
										</div>
										<div
											className="w-14 text-xs text-right font-medium"
											title="Total duration"
											style={{ color: theme.colors.textMain }}
										>
											{formatDuration(agent.duration)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{/* Tooltip */}
				{hoveredAgentData && tooltipPos && (
					<div
						className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
						style={{
							left: tooltipPos.x,
							top: tooltipPos.y,
							transform: 'translateY(-50%)',
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="font-medium mb-1 flex items-center gap-2">
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: hoveredAgentData.color }}
							/>
							{hoveredAgentData.agent}
						</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								{hoveredAgentData.count} {hoveredAgentData.count === 1 ? 'query' : 'queries'}
							</div>
							<div>{formatDuration(hoveredAgentData.duration)} total</div>
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			{agentData.length > 0 && (
				<div
					className="flex flex-wrap gap-3 mt-4 pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					role="list"
					aria-label="Chart legend"
				>
					{agentData.slice(0, 6).map((agent) => (
						<div key={agent.agent} className="flex items-center gap-1.5" role="listitem">
							<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: agent.color }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{agent.agent}
							</span>
						</div>
					))}
					{agentData.length > 6 && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							+{agentData.length - 6} more
						</span>
					)}
				</div>
			)}
		</div>
	);
}

export default AgentComparisonChart;
