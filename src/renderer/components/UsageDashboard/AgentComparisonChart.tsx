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

import { memo, useMemo, useCallback, useState, type MouseEvent } from 'react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { ChartTooltip } from './ChartTooltip';
import { buildAgentComparisonData, buildAgentSplitAggregation } from './agentComparisonUtils';

interface AgentComparisonChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/** Current sessions list. When provided, worktree agents are split into separate bars. */
	sessions?: Session[];
	/** Drill-down click handler, fires with the bar's `key`/`label` on click. */
	onAgentClick?: (key: string, displayName: string) => void;
	/**
	 * Active drill-down filter key. When set, the matching bar gets an accent
	 * outline; non-matching bars dim to 30% opacity. `null` (or undefined) means
	 * no filter is active and bars render normally.
	 */
	activeFilterKey?: string | null;
}

export const AgentComparisonChart = memo(function AgentComparisonChart({
	data,
	theme,
	colorBlindMode = false,
	sessions,
	onAgentClick,
	activeFilterKey = null,
}: AgentComparisonChartProps) {
	const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const splitAggregation = useMemo(() => {
		return buildAgentSplitAggregation(data, sessions);
	}, [data.bySessionByDay, data.byAgent, sessions]);

	// Process and sort agent data
	const agentData = useMemo(() => {
		return buildAgentComparisonData({
			data,
			splitAggregation,
			theme,
			colorBlindMode,
			sessions,
		});
	}, [data.byAgent, splitAggregation, theme, colorBlindMode, sessions]);

	const hasWorktreeBars = useMemo(() => agentData.some((d) => d.isWorktree), [agentData]);

	// Get max duration for bar width calculation
	const maxDuration = useMemo(() => {
		if (agentData.length === 0) return 0;
		return Math.max(...agentData.map((d) => d.duration));
	}, [agentData]);

	// Anchor the tooltip to the cursor (not the bar's bounding rect) so it
	// stays close to the user's pointer regardless of which bar they hover.
	const handleMouseEnter = useCallback((agent: string, event: MouseEvent<HTMLDivElement>) => {
		setHoveredAgent(agent);
		setTooltipPos({ x: event.clientX, y: event.clientY });
	}, []);
	const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
		setTooltipPos({ x: event.clientX, y: event.clientY });
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredAgent(null);
		setTooltipPos(null);
	}, []);

	// Forward bar clicks to the dashboard's drill-down handler. The dashboard
	// owns toggle behavior (clicking the active bar clears the filter); this
	// component just reports which row was clicked.
	const handleAgentClick = useCallback(
		(key: string, label: string) => {
			if (!onAgentClick) return;
			onAgentClick(key, label);
		},
		[onAgentClick]
	);

	// Get hovered agent data for tooltip (matched by row key, since the same
	// provider can appear twice, once as regular and once as worktree).
	const hoveredAgentData = useMemo(() => {
		if (!hoveredAgent) return null;
		return agentData.find((d) => d.key === hoveredAgent) || null;
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
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
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
							const isHovered = hoveredAgent === agent.key;
							const isClickable = !!onAgentClick;
							const isFiltered = activeFilterKey != null;
							const isSelected = isFiltered && activeFilterKey === agent.key;
							const isDimmed = isFiltered && !isSelected;

							return (
								<div
									key={agent.key}
									className="flex items-center gap-3"
									style={{
										height: barHeight,
										cursor: isClickable ? 'pointer' : undefined,
										opacity: isDimmed ? 0.3 : 1,
										transition: 'opacity 0.2s ease',
									}}
									onMouseEnter={(e) => handleMouseEnter(agent.key, e)}
									onMouseMove={handleMouseMove}
									onMouseLeave={handleMouseLeave}
									onClick={isClickable ? () => handleAgentClick(agent.key, agent.label) : undefined}
									onKeyDown={
										isClickable
											? (e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														handleAgentClick(agent.key, agent.label);
													}
												}
											: undefined
									}
									role="listitem"
									tabIndex={isClickable ? 0 : undefined}
									aria-pressed={isClickable ? isSelected : undefined}
									aria-label={`${agent.label}: ${agent.count} queries, ${formatDuration(agent.duration)}${isClickable ? '. Click to filter dashboard.' : ''}`}
								>
									{/* Agent name label */}
									<div
										className="w-28 text-sm truncate flex-shrink-0"
										style={{
											color: isHovered ? theme.colors.textMain : theme.colors.textDim,
										}}
										title={agent.label}
									>
										{agent.label}
									</div>

									{/* Bar container */}
									<div
										className="flex-1 h-full rounded overflow-hidden relative"
										style={{
											backgroundColor: `${theme.colors.border}30`,
											// Selected bar gets an accent outline (analogue of recharts
											// `<Cell>` stroke + strokeWidth). `boxShadow` is used over
											// `border` so the bar geometry doesn't shift on selection.
											boxShadow: isSelected ? `inset 0 0 0 2px ${theme.colors.accent}` : undefined,
											transition: 'box-shadow 0.2s ease',
										}}
										role="meter"
										aria-valuenow={agent.durationPercentage}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`${agent.label} usage percentage`}
									>
										{/* Bar fill */}
										<div
											className="h-full rounded flex items-center"
											style={{
												width: `${Math.max(barWidth, 2)}%`,
												backgroundColor: agent.color,
												// Worktree bars render at reduced opacity with a diagonal stripe
												// overlay so they're visually distinct from regular agent bars.
												opacity: isHovered
													? agent.isWorktree
														? 0.75
														: 1
													: agent.isWorktree
														? 0.55
														: 0.85,
												backgroundImage: agent.isWorktree
													? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)'
													: undefined,
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
											className="text-xs text-right font-medium whitespace-nowrap"
											title="Total duration"
											style={{ color: theme.colors.textMain, minWidth: 80 }}
										>
											{formatDuration(agent.duration)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{hoveredAgentData && (
					<ChartTooltip anchor={tooltipPos} theme={theme} width={200} height={64}>
						<div className="font-medium mb-1 flex items-center gap-2">
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: hoveredAgentData.color }}
							/>
							{hoveredAgentData.label}
						</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								{hoveredAgentData.count} {hoveredAgentData.count === 1 ? 'query' : 'queries'}
							</div>
							<div>{formatDuration(hoveredAgentData.duration)} total</div>
						</div>
					</ChartTooltip>
				)}
			</div>

			{/* Legend */}
			{agentData.length > 0 && (
				<div
					className="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					role="list"
					aria-label="Chart legend"
				>
					{agentData.slice(0, 6).map((agent) => (
						<div key={agent.key} className="flex items-center gap-1.5" role="listitem">
							<div
								className="w-2.5 h-2.5 rounded-sm"
								style={{
									backgroundColor: agent.color,
									opacity: agent.isWorktree ? 0.55 : 1,
									backgroundImage: agent.isWorktree
										? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 4px)'
										: undefined,
								}}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{agent.label}
							</span>
						</div>
					))}
					{agentData.length > 6 && (
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							+{agentData.length - 6} more
						</span>
					)}
					{hasWorktreeBars && (
						<div
							className="ml-auto flex items-center gap-3"
							role="listitem"
							aria-label="Worktree differentiation legend"
						>
							<div className="flex items-center gap-1.5">
								<div
									className="w-2.5 h-2.5 rounded-sm"
									style={{ backgroundColor: theme.colors.textDim, opacity: 0.85 }}
								/>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Agent
								</span>
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
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									Worktree Agent
								</span>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export default AgentComparisonChart;
